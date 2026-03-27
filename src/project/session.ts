/**
 * Session / conversation state management.
 *
 * A Session tracks the active conversation, its history, the current project
 * reference, and any ongoing task plan.  Sessions are persisted to disk so
 * the user can resume where they left off.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TaskPlan } from '../agents/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

interface SerializedSession {
  id: string;
  projectPath: string | null;
  projectName: string | null;
  messages: SessionMessage[];
  taskPlan: TaskPlan | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(os.homedir(), '.rtl-claw', 'sessions');
const LAST_SESSION_FILE = path.join(os.homedir(), '.rtl-claw', 'last-session');

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  /** Unique session identifier. */
  readonly id: string;

  /** Path to the currently-open project (if any). */
  projectPath: string | null = null;

  /** Name of the currently-open project (if any). */
  projectName: string | null = null;

  /** Conversation messages. */
  messages: SessionMessage[] = [];

  /** Active task plan (may be null). */
  taskPlan: TaskPlan | null = null;

  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;

  /** ISO-8601 last-update timestamp. */
  updatedAt: string;

  constructor(id?: string) {
    const now = new Date().toISOString();
    this.id = id ?? generateId();
    this.createdAt = now;
    this.updatedAt = now;
  }

  // -----------------------------------------------------------------------
  // Message helpers
  // -----------------------------------------------------------------------

  addMessage(role: SessionMessage['role'], content: string): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });
    this.updatedAt = new Date().toISOString();
  }

  getHistory(): SessionMessage[] {
    return [...this.messages];
  }

  clearHistory(): void {
    this.messages = [];
    this.updatedAt = new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Project binding
  // -----------------------------------------------------------------------

  setProject(projectPath: string, projectName: string): void {
    this.projectPath = projectPath;
    this.projectName = projectName;
    this.updatedAt = new Date().toISOString();
  }

  clearProject(): void {
    this.projectPath = null;
    this.projectName = null;
    this.updatedAt = new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Task plan
  // -----------------------------------------------------------------------

  setTaskPlan(plan: TaskPlan): void {
    this.taskPlan = plan;
    this.updatedAt = new Date().toISOString();
  }

  clearTaskPlan(): void {
    this.taskPlan = null;
    this.updatedAt = new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Save the session to disk.
   */
  async save(): Promise<void> {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });

    const data: SerializedSession = {
      id: this.id,
      projectPath: this.projectPath,
      projectName: this.projectName,
      messages: this.messages,
      taskPlan: this.taskPlan,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };

    const filePath = path.join(SESSIONS_DIR, `${this.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');

    // Mark as the last active session
    await fs.mkdir(path.dirname(LAST_SESSION_FILE), { recursive: true });
    await fs.writeFile(LAST_SESSION_FILE, this.id, 'utf-8');
  }

  /**
   * Load a session from disk by id.
   */
  static async load(id: string): Promise<Session> {
    const filePath = path.join(SESSIONS_DIR, `${id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as SerializedSession;
    return Session.fromSerialized(data);
  }

  /**
   * Load the most recently active session, or return null if none exists.
   */
  static async loadLast(): Promise<Session | null> {
    try {
      const lastId = (await fs.readFile(LAST_SESSION_FILE, 'utf-8')).trim();
      if (!lastId) return null;
      return await Session.load(lastId);
    } catch {
      return null;
    }
  }

  /**
   * List all persisted sessions (id + updatedAt + projectName).
   */
  static async listSessions(): Promise<Array<{ id: string; updatedAt: string; projectName: string | null }>> {
    try {
      const files = await fs.readdir(SESSIONS_DIR);
      const sessions: Array<{ id: string; updatedAt: string; projectName: string | null }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf-8');
          const data = JSON.parse(raw) as SerializedSession;
          sessions.push({
            id: data.id,
            updatedAt: data.updatedAt,
            projectName: data.projectName,
          });
        } catch {
          // Skip corrupted session files
        }
      }

      // Sort by most recently updated first
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sessions;
    } catch {
      return [];
    }
  }

  /**
   * Determine whether to resume the last session or start a new one.
   * Returns the session to use.
   *
   * In a real CLI this would prompt the user; here we expose the logic
   * so callers can decide.
   */
  static async resolveStartupSession(forceNew: boolean): Promise<{ session: Session; resumed: boolean }> {
    if (forceNew) {
      return { session: new Session(), resumed: false };
    }

    const last = await Session.loadLast();
    if (last !== null) {
      return { session: last, resumed: true };
    }

    return { session: new Session(), resumed: false };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private static fromSerialized(data: SerializedSession): Session {
    const session = new Session(data.id);
    session.projectPath = data.projectPath;
    session.projectName = data.projectName;
    session.messages = data.messages;
    session.taskPlan = data.taskPlan;
    // createdAt is readonly, set via Object.defineProperty
    Object.defineProperty(session, 'createdAt', { value: data.createdAt });
    session.updatedAt = data.updatedAt;
    return session;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}
