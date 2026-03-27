/**
 * VCD (Value Change Dump) waveform parser.
 * Parses VCD files, extracts signals and transitions,
 * and formats waveform data as text tables for LLM consumption.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Signal {
  /** VCD identifier character(s) */
  id: string;
  /** Hierarchical signal name (e.g. "tb.dut.clk") */
  name: string;
  /** Bit width */
  width: number;
  /** Scope path components */
  scope: string[];
}

export interface SignalTransition {
  /** Simulation time */
  time: number;
  /** Signal identifier */
  signalId: string;
  /** New value (binary string, or 'x'/'z') */
  value: string;
}

export interface VCDData {
  /** Timescale string, e.g. "1ns" */
  timescale: string;
  /** All signals defined in the VCD */
  signals: Signal[];
  /** All value transitions */
  transitions: SignalTransition[];
  /** Date string from VCD header */
  date: string;
  /** Version string from VCD header */
  version: string;
  /** End time (maximum timestamp seen) */
  endTime: number;
}

export interface ExtractedWindow {
  signals: Signal[];
  transitions: SignalTransition[];
  timeStart: number;
  timeEnd: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class VCDParser {
  /**
   * Parse a VCD file and return structured data.
   */
  async parse(filePath: string): Promise<VCDData> {
    const absPath = resolve(filePath);
    const content = await readFile(absPath, 'utf-8');
    return this.parseContent(content);
  }

  /**
   * Parse VCD content string (useful for testing or in-memory data).
   */
  parseContent(content: string): VCDData {
    const data: VCDData = {
      timescale: '1ns',
      signals: [],
      transitions: [],
      date: '',
      version: '',
      endTime: 0,
    };

    const signalById = new Map<string, Signal>();
    const scopeStack: string[] = [];
    let inHeader = true;
    let currentTime = 0;

    const lines = content.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      i++;

      if (!line) continue;

      // ---- Header section ----
      if (line.startsWith('$date')) {
        const dateLines: string[] = [];
        while (i < lines.length && !lines[i].trim().startsWith('$end')) {
          const dl = lines[i].trim();
          if (dl) dateLines.push(dl);
          i++;
        }
        i++; // skip $end
        data.date = dateLines.join(' ');
        continue;
      }

      if (line.startsWith('$version')) {
        const verLines: string[] = [];
        while (i < lines.length && !lines[i].trim().startsWith('$end')) {
          const vl = lines[i].trim();
          if (vl) verLines.push(vl);
          i++;
        }
        i++;
        data.version = verLines.join(' ');
        continue;
      }

      if (line.startsWith('$timescale')) {
        // Can be on same line: $timescale 1ns $end
        const inlineMatch = line.match(/\$timescale\s+(.+?)\s+\$end/);
        if (inlineMatch) {
          data.timescale = inlineMatch[1].trim();
        } else {
          const tsLines: string[] = [];
          while (i < lines.length && !lines[i].trim().startsWith('$end')) {
            const tl = lines[i].trim();
            if (tl) tsLines.push(tl);
            i++;
          }
          i++;
          data.timescale = tsLines.join('').trim();
        }
        continue;
      }

      if (line.startsWith('$scope')) {
        const m = line.match(/\$scope\s+\w+\s+(\S+)/);
        if (m) scopeStack.push(m[1]);
        continue;
      }

      if (line.startsWith('$upscope')) {
        scopeStack.pop();
        continue;
      }

      if (line.startsWith('$var')) {
        // $var wire 8 # data [7:0] $end
        const m = line.match(/\$var\s+\w+\s+(\d+)\s+(\S+)\s+(\S+)/);
        if (m) {
          const width = parseInt(m[1], 10);
          const id = m[2];
          const name = m[3];
          const fullName = [...scopeStack, name].join('.');
          const signal: Signal = { id, name: fullName, width, scope: [...scopeStack] };
          data.signals.push(signal);
          signalById.set(id, signal);
        }
        continue;
      }

      if (line.startsWith('$enddefinitions')) {
        inHeader = false;
        continue;
      }

      if (line.startsWith('$dumpvars') || line.startsWith('$end') || line.startsWith('$comment')) {
        // Skip through to $end if block
        if (line.startsWith('$dumpvars') || line.startsWith('$comment')) {
          while (i < lines.length && !lines[i].trim().startsWith('$end')) {
            // Parse initial values inside $dumpvars
            if (line.startsWith('$dumpvars')) {
              const valLine = lines[i].trim();
              if (valLine && !valLine.startsWith('$')) {
                const tr = this.parseValueChange(valLine, currentTime);
                if (tr) data.transitions.push(tr);
              }
            }
            i++;
          }
          i++; // skip $end
        }
        continue;
      }

      // ---- Value changes section ----
      if (line.startsWith('#')) {
        currentTime = parseInt(line.substring(1), 10);
        if (currentTime > data.endTime) {
          data.endTime = currentTime;
        }
        continue;
      }

      // Value change: scalar (0/1/x/z followed by id) or vector (b... id)
      if (!inHeader && line.length > 0) {
        const tr = this.parseValueChange(line, currentTime);
        if (tr) {
          data.transitions.push(tr);
        }
      }
    }

    return data;
  }

  /**
   * Extract signals and transitions within a time window.
   */
  extractWindow(
    data: VCDData,
    signals: string[],
    timeStart: number,
    timeEnd: number,
  ): ExtractedWindow {
    // Resolve signal names to ids
    const signalSet = new Set(signals.map(s => s.toLowerCase()));
    const matchedSignals = signals.length === 0
      ? data.signals
      : data.signals.filter(s =>
          signalSet.has(s.name.toLowerCase()) ||
          signalSet.has(s.name.split('.').pop()!.toLowerCase()),
        );

    const matchedIds = new Set(matchedSignals.map(s => s.id));

    // For each matched signal, find the last transition before timeStart
    // (so we know the initial value at timeStart)
    const initialTransitions: SignalTransition[] = [];
    const lastBefore = new Map<string, SignalTransition>();
    const windowTransitions: SignalTransition[] = [];

    for (const tr of data.transitions) {
      if (!matchedIds.has(tr.signalId)) continue;

      if (tr.time < timeStart) {
        lastBefore.set(tr.signalId, tr);
      } else if (tr.time >= timeStart && tr.time <= timeEnd) {
        windowTransitions.push(tr);
      }
    }

    // Prepend initial values
    for (const [, tr] of lastBefore) {
      initialTransitions.push({ ...tr, time: timeStart });
    }

    return {
      signals: matchedSignals,
      transitions: [...initialTransitions, ...windowTransitions],
      timeStart,
      timeEnd,
    };
  }

  /**
   * Format extracted waveform data as an ASCII text table suitable for LLM consumption.
   * Optionally append error messages below the table.
   */
  formatAsTable(extracted: ExtractedWindow, errors?: string[]): string {
    const { signals, transitions, timeStart, timeEnd } = extracted;

    if (signals.length === 0) {
      return 'No matching signals found.';
    }

    // Collect unique time points
    const timePoints = [...new Set(transitions.map(t => t.time))].sort((a, b) => a - b);

    if (timePoints.length === 0) {
      return 'No transitions in the specified time window.';
    }

    // Build value map: signalId -> time -> value
    const valueMap = new Map<string, Map<number, string>>();
    for (const sig of signals) {
      valueMap.set(sig.id, new Map());
    }
    for (const tr of transitions) {
      const sigMap = valueMap.get(tr.signalId);
      if (sigMap) sigMap.set(tr.time, tr.value);
    }

    // Determine column widths
    const nameColWidth = Math.max(6, ...signals.map(s => s.name.length));
    const timeStrs = timePoints.map(t => String(t));
    const colWidths = timeStrs.map(ts => Math.max(ts.length, 4));

    // Header row
    const header =
      'Signal'.padEnd(nameColWidth) +
      ' | ' +
      timeStrs.map((ts, i) => ts.padStart(colWidths[i])).join(' | ');

    const separator =
      '-'.repeat(nameColWidth) +
      '-+-' +
      colWidths.map(w => '-'.repeat(w)).join('-+-');

    // Data rows
    const rows: string[] = [];
    for (const sig of signals) {
      const sigMap = valueMap.get(sig.id)!;
      let lastVal = 'x';
      const cells = timePoints.map((t, i) => {
        if (sigMap.has(t)) {
          lastVal = sigMap.get(t)!;
        }
        return lastVal.padStart(colWidths[i]);
      });
      rows.push(sig.name.padEnd(nameColWidth) + ' | ' + cells.join(' | '));
    }

    const lines = [
      `Time window: ${timeStart} - ${timeEnd}`,
      '',
      header,
      separator,
      ...rows,
    ];

    if (errors && errors.length > 0) {
      lines.push('', '--- Errors ---', ...errors);
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private parseValueChange(line: string, time: number): SignalTransition | null {
    // Vector: b01010 ID  or  B01010 ID
    const vecMatch = line.match(/^[bB]([01xXzZ]+)\s+(\S+)$/);
    if (vecMatch) {
      return { time, signalId: vecMatch[2], value: vecMatch[1].toLowerCase() };
    }

    // Real: r<float> ID  or  R<float> ID
    const realMatch = line.match(/^[rR]([^\s]+)\s+(\S+)$/);
    if (realMatch) {
      return { time, signalId: realMatch[2], value: realMatch[1] };
    }

    // Scalar: 0ID, 1ID, xID, zID
    const scalarMatch = line.match(/^([01xXzZ])(\S+)$/);
    if (scalarMatch) {
      return { time, signalId: scalarMatch[2], value: scalarMatch[1].toLowerCase() };
    }

    return null;
  }
}
