/**
 * Project management: create, open, maintain RTL-Claw projects.
 *
 * Project metadata stored under <projectRoot>/.rtl-claw/:
 *   project.json  - basic info + file manifest
 *   index.json    - design index (module hierarchy, interfaces)
 *   history.json  - conversation history
 *   state.json    - workflow state (crash recovery)
 *   logs/         - session logs
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { DesignIndex, WorkflowState } from '../agents/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  relativePath: string;
  fileType: 'rtl' | 'testbench' | 'constraint' | 'script' | 'doc' | 'macro' | 'filelist' | 'other';
  lastModified: string;
}

export interface ProjectInfo {
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt: string;
  description?: string;
  hdlStandard?: string;
  targetDevice?: string;
  /** Filelist path(s) relative to project root. Default: 'hw/src/filelist/design.f' */
  filelistPath?: string;
  files: FileEntry[];
}

/** Default filelist path when not specified in project config */
export const DEFAULT_FILELIST = 'hw/src/filelist/design.f';

/** Get the filelist path for a project, falling back to default */
export function getFilelistPath(info?: { filelistPath?: string }): string {
  return info?.filelistPath ?? DEFAULT_FILELIST;
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_DIR = '.rtl-claw';
const PROJECT_FILE = 'project.json';
const INDEX_FILE = 'index.json';
const HISTORY_FILE = 'history.json';
const STATE_FILE = 'state.json';
const LOGS_DIR = 'logs';

/** Standard project directory structure */
const PROJECT_DIRS = [
  'hw/src/hdl',
  'hw/src/macro',
  'hw/src/filelist',
  'hw/dv/st/sim/tb',
  'hw/dv/ut/sim/tb',
  'hw/dv/tc',
  'hw/syn',
  'doc',
];

/** setenv template content */
const SETENV_TEMPLATE = `#!/bin/bash
# RTL-Claw project environment setup
# Edit paths below to match your EDA tool installation

# Open source tools
# export IVERILOG_HOME=/usr/bin
# export VERILATOR_HOME=/usr/local/share/verilator

# Commercial tools (uncomment and set paths as needed)
# export VCS_HOME=/opt/synopsys/vcs
# export VIVADO_HOME=/opt/Xilinx/Vivado/2024.1
# export DC_HOME=/opt/synopsys/dc

# License servers (if applicable)
# export LM_LICENSE_FILE=27000@license-server
`;

// ---------------------------------------------------------------------------
// Project registry (persisted in ~/.rtl-claw/projects.json)
// ---------------------------------------------------------------------------

function getRegistryPath(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  const dir = path.join(home, '.rtl-claw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'projects.json');
}

async function loadRegistry(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(getRegistryPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveRegistry(registry: Record<string, string>): Promise<void> {
  await fs.writeFile(getRegistryPath(), JSON.stringify(registry, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

export class ProjectManager {

  // -----------------------------------------------------------------------
  // Creation
  // -----------------------------------------------------------------------

  async createProject(rootPath: string, name: string, description?: string): Promise<ProjectInfo> {
    const absRoot = path.resolve(rootPath);

    // Create project directories
    for (const dir of PROJECT_DIRS) {
      await fs.mkdir(path.join(absRoot, dir), { recursive: true });
    }

    // Create .rtl-claw metadata directory
    const metaDir = path.join(absRoot, META_DIR);
    await fs.mkdir(metaDir, { recursive: true });
    await fs.mkdir(path.join(metaDir, LOGS_DIR), { recursive: true });

    // Create setenv template
    const setenvPath = path.join(absRoot, 'hw', 'setenv');
    if (!existsSync(setenvPath)) {
      await fs.writeFile(setenvPath, SETENV_TEMPLATE, 'utf-8');
    }

    // Create empty filelist
    const defaultFL = path.join(absRoot, DEFAULT_FILELIST);
    if (!existsSync(defaultFL)) {
      await fs.writeFile(defaultFL, '// RTL-Claw design filelist\n+incdir+../macro\n', 'utf-8');
    }

    const now = new Date().toISOString();
    const info: ProjectInfo = {
      name,
      rootPath: absRoot,
      createdAt: now,
      lastOpenedAt: now,
      description,
      files: [],
    };

    await this.saveProjectInfo(absRoot, info);
    await this.saveDesignIndex(absRoot, { modules: [], hierarchy: [], topModules: [], timestamp: now });
    await this.saveHistory(absRoot, []);

    // Register project
    const registry = await loadRegistry();
    registry[absRoot] = name;
    await saveRegistry(registry);

    return info;
  }

  // -----------------------------------------------------------------------
  // Opening / detecting
  // -----------------------------------------------------------------------

  async openProject(rootPath: string): Promise<ProjectInfo> {
    const absRoot = path.resolve(rootPath);
    const metaDir = path.join(absRoot, META_DIR);

    try {
      await fs.access(metaDir);
    } catch {
      throw new Error(`Not an RTL-Claw project: ${absRoot} (missing ${META_DIR}/ directory)`);
    }

    const info = await this.loadProjectInfo(absRoot);
    info.lastOpenedAt = new Date().toISOString();
    await this.saveProjectInfo(absRoot, info);

    // Update registry
    const registry = await loadRegistry();
    registry[absRoot] = info.name;
    await saveRegistry(registry);

    return info;
  }

  async isProject(rootPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(path.resolve(rootPath), META_DIR, PROJECT_FILE));
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Project metadata
  // -----------------------------------------------------------------------

  async loadProjectInfo(rootPath: string): Promise<ProjectInfo> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, PROJECT_FILE);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ProjectInfo;
  }

  async saveProjectInfo(rootPath: string, info: ProjectInfo): Promise<void> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, PROJECT_FILE);
    await fs.writeFile(filePath, JSON.stringify(info, null, 2), 'utf-8');
  }

  // -----------------------------------------------------------------------
  // File manifest
  // -----------------------------------------------------------------------

  async refreshFileManifest(rootPath: string): Promise<FileEntry[]> {
    const absRoot = path.resolve(rootPath);
    const entries: FileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      let items: import('node:fs').Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const item of items) {
        if (item.name === META_DIR || item.name === 'node_modules' || item.name.startsWith('.')) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else {
          const stat = await fs.stat(full);
          entries.push({
            relativePath: path.relative(absRoot, full),
            fileType: classifyFile(item.name, path.relative(absRoot, full)),
            lastModified: stat.mtime.toISOString(),
          });
        }
      }
    };

    await walk(absRoot);

    const info = await this.loadProjectInfo(absRoot);
    info.files = entries;
    await this.saveProjectInfo(absRoot, info);

    return entries;
  }

  // -----------------------------------------------------------------------
  // Design index
  // -----------------------------------------------------------------------

  async loadDesignIndex(rootPath: string): Promise<DesignIndex> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, INDEX_FILE);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as DesignIndex;
    } catch {
      return { modules: [], hierarchy: [], topModules: [], timestamp: '' };
    }
  }

  async saveDesignIndex(rootPath: string, index: DesignIndex): Promise<void> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, INDEX_FILE);
    await fs.writeFile(filePath, JSON.stringify(index, null, 2), 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Conversation history
  // -----------------------------------------------------------------------

  async loadHistory(rootPath: string): Promise<ConversationEntry[]> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, HISTORY_FILE);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as ConversationEntry[];
    } catch {
      return [];
    }
  }

  async saveHistory(rootPath: string, history: ConversationEntry[]): Promise<void> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, HISTORY_FILE);
    await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
  }

  async appendHistory(rootPath: string, entry: ConversationEntry): Promise<void> {
    const history = await this.loadHistory(rootPath);
    history.push(entry);
    await this.saveHistory(rootPath, history);
  }

  // -----------------------------------------------------------------------
  // Workflow state (crash recovery)
  // -----------------------------------------------------------------------

  async loadWorkflowState(rootPath: string): Promise<WorkflowState | null> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, STATE_FILE);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as WorkflowState;
    } catch {
      return null;
    }
  }

  async saveWorkflowState(rootPath: string, state: WorkflowState): Promise<void> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, STATE_FILE);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  async clearWorkflowState(rootPath: string): Promise<void> {
    const filePath = path.join(path.resolve(rootPath), META_DIR, STATE_FILE);
    try { await fs.unlink(filePath); } catch { /* ignore */ }
  }

  // -----------------------------------------------------------------------
  // Filelist management
  // -----------------------------------------------------------------------

  async appendToFilelist(rootPath: string, hdlFile: string, customFilelistPath?: string): Promise<void> {
    const absRoot = path.resolve(rootPath);
    const flPath = customFilelistPath ?? DEFAULT_FILELIST;
    const filelistPath = path.join(absRoot, flPath);
    const filelistDir = path.dirname(filelistPath);
    const relativePath = path.relative(filelistDir, path.join(absRoot, hdlFile));

    try {
      const content = await fs.readFile(filelistPath, 'utf-8');
      if (!content.includes(relativePath)) {
        await fs.appendFile(filelistPath, `${relativePath}\n`, 'utf-8');
      }
    } catch {
      await fs.writeFile(filelistPath, `// RTL-Claw design filelist\n+incdir+../macro\n${relativePath}\n`, 'utf-8');
    }
  }

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------

  async writeLog(rootPath: string, sessionId: string, content: string): Promise<void> {
    const logDir = path.join(path.resolve(rootPath), META_DIR, LOGS_DIR);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `session-${sessionId}.log`);
    await fs.appendFile(logPath, `[${new Date().toISOString()}] ${content}\n`, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Registry (all known projects)
  // -----------------------------------------------------------------------

  async listProjects(): Promise<Array<{ rootPath: string; name: string }>> {
    const registry = await loadRegistry();
    return Object.entries(registry).map(([rootPath, name]) => ({ rootPath, name }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyFile(filename: string, relativePath: string): FileEntry['fileType'] {
  const ext = path.extname(filename).toLowerCase();

  // Path-based classification
  if (relativePath.includes('hw/dv/') || relativePath.includes('/tb/') || /^tb[_/]|_tb\./i.test(filename)) {
    return 'testbench';
  }
  if (relativePath.includes('hw/src/macro/') || ext === '.vh' || ext === '.svh') {
    return 'macro';
  }
  if (relativePath.includes('hw/src/filelist/') || ext === '.f') {
    return 'filelist';
  }

  switch (ext) {
    case '.v':
    case '.sv':
    case '.vhd':
    case '.vhdl':
      return 'rtl';
    case '.sdc':
    case '.xdc':
      return 'constraint';
    case '.sh':
    case '.tcl':
    case '.ys':
    case '.mk':
      return 'script';
    case '.md':
    case '.txt':
    case '.pdf':
    case '.rst':
      return 'doc';
    default:
      return 'other';
  }
}
