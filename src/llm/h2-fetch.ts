/**
 * HTTP/2 fetch wrapper for LLM API calls.
 *
 * Why: Gemini thinking models have a 30–60 s "thinking" phase where no data
 * flows on the HTTP connection.  Network middleboxes (proxy, NAT, firewall)
 * often drop idle HTTP/1.1 connections, causing "fetch failed / socket closed"
 * errors.  HTTP/2 supports PING frames that keep the connection alive at the
 * protocol level, preventing these drops.
 *
 * This module provides a fetch-compatible function backed by Node's built-in
 * `http2` module with periodic PING frames.
 */

import http2 from 'node:http2';

/** Interval between HTTP/2 PING frames (ms). */
const PING_INTERVAL_MS = 10_000;

/** If no data received for this long during body streaming, treat as dead (ms). */
const STREAM_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * A minimal fetch()-compatible function that uses HTTP/2 with PING keep-alive.
 *
 * Only supports the subset used by the OpenAI SDK:
 *  - POST with JSON body
 *  - Streaming responses (readable body)
 *  - Headers, status
 */
export function createH2Fetch(): typeof globalThis.fetch {
  // Cache one HTTP/2 session per origin for connection reuse
  const sessions = new Map<string, { session: http2.ClientHttp2Session; timer: ReturnType<typeof setInterval> }>();

  function getSession(origin: string): http2.ClientHttp2Session {
    const existing = sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) {
      return existing.session;
    }
    // Clean up old session
    if (existing) {
      clearInterval(existing.timer);
      if (!existing.session.destroyed) existing.session.destroy();
      sessions.delete(origin);
    }

    const session = http2.connect(origin);

    // Send PING frames periodically to keep connection alive.
    // If PING fails, the session is dead — destroy it so pending
    // requests get an error instead of hanging forever.
    let consecutivePingFailures = 0;
    const timer = setInterval(() => {
      if (!session.closed && !session.destroyed) {
        session.ping((err) => {
          if (err) {
            consecutivePingFailures++;
            if (consecutivePingFailures >= 3) {
              session.destroy(new Error('HTTP/2 session unresponsive (3 PING failures)'));
            }
          } else {
            consecutivePingFailures = 0;
          }
        });
      } else {
        clearInterval(timer);
      }
    }, PING_INTERVAL_MS);
    timer.unref(); // Don't prevent process exit

    session.on('error', () => {
      clearInterval(timer);
      sessions.delete(origin);
    });
    session.on('close', () => {
      clearInterval(timer);
      sessions.delete(origin);
    });
    // Handle GOAWAY from server — mark session for removal so next
    // request creates a fresh connection.
    session.on('goaway', () => {
      sessions.delete(origin);
    });

    sessions.set(origin, { session, timer });
    return session;
  }

  const h2Fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const origin = url.origin;
    const session = getSession(origin);

    const method = init?.method?.toUpperCase() ?? 'GET';
    const body = init?.body as string | Buffer | undefined;
    const inHeaders = init?.headers;

    // Build HTTP/2 headers
    const h2Headers: http2.OutgoingHttpHeaders = {
      ':method': method,
      ':path': url.pathname + url.search,
    };

    // Copy incoming headers
    if (inHeaders) {
      if (inHeaders instanceof Headers) {
        inHeaders.forEach((v, k) => { h2Headers[k] = v; });
      } else if (Array.isArray(inHeaders)) {
        for (const [k, v] of inHeaders) h2Headers[k] = v;
      } else {
        for (const [k, v] of Object.entries(inHeaders)) {
          if (v !== undefined) h2Headers[k.toLowerCase()] = v;
        }
      }
    }

    // Handle abort signal
    const signal = init?.signal;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      const req = session.request(h2Headers);

      const onAbort = () => {
        req.destroy();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let responded = false;

      req.on('error', (err) => {
        if (!responded) {
          responded = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new TypeError(`fetch failed`, { cause: err }));
        }
      });

      // Handle stream close before response headers arrive
      // (e.g., session destroyed by PING failure before server responds)
      req.on('close', () => {
        if (!responded) {
          responded = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new TypeError(`fetch failed`, { cause: new Error('HTTP/2 stream closed before response') }));
        }
      });

      let statusCode = 200;
      let responseHeaders: Record<string, string> = {};

      req.on('response', (headers) => {
        responded = true;
        statusCode = headers[':status'] as number ?? 200;
        for (const [k, v] of Object.entries(headers)) {
          if (!k.startsWith(':') && v !== undefined) {
            responseHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
        }

        // Build a ReadableStream from the HTTP/2 stream.
        // Key: handle 'close' event to detect premature stream death
        // (e.g., session destroyed by PING failure, server RST_STREAM).
        const readable = new ReadableStream({
          start(controller) {
            let ended = false;
            let idleTimer: ReturnType<typeof setTimeout> | undefined;

            const resetIdleTimer = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                if (!ended) {
                  ended = true;
                  signal?.removeEventListener('abort', onAbort);
                  const err = new Error('HTTP/2 stream idle timeout — no data received for 5 minutes');
                  try { controller.error(err); } catch { /* already closed */ }
                  req.destroy();
                }
              }, STREAM_IDLE_TIMEOUT_MS);
              idleTimer.unref();
            };

            // Start idle watchdog
            resetIdleTimer();

            req.on('data', (chunk: Buffer) => {
              if (!ended) {
                controller.enqueue(new Uint8Array(chunk));
                resetIdleTimer();
              }
            });
            req.on('end', () => {
              if (!ended) {
                ended = true;
                if (idleTimer) clearTimeout(idleTimer);
                signal?.removeEventListener('abort', onAbort);
                try { controller.close(); } catch { /* already closed */ }
              }
            });
            req.on('error', (err) => {
              if (!ended) {
                ended = true;
                if (idleTimer) clearTimeout(idleTimer);
                signal?.removeEventListener('abort', onAbort);
                try { controller.error(err); } catch { /* already closed */ }
              }
            });
            // Handle premature stream closure: 'close' fires when the
            // HTTP/2 stream is destroyed without 'end' or 'error'.
            // This happens when session.destroy() is called (PING failure)
            // or the server sends RST_STREAM.
            req.on('close', () => {
              if (!ended) {
                ended = true;
                if (idleTimer) clearTimeout(idleTimer);
                signal?.removeEventListener('abort', onAbort);
                const err = new Error('HTTP/2 stream closed prematurely');
                try { controller.error(err); } catch { /* already closed */ }
              }
            });
          },
          cancel() {
            req.destroy();
          },
        });

        const resp = new Response(readable, {
          status: statusCode,
          headers: responseHeaders,
        });

        resolve(resp);
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  };

  return h2Fetch;
}
