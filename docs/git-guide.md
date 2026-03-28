# RTL-Claw Git & Project Guide

## Project Overview

RTL-Claw is an AI-powered RTL development assistant for chip/FPGA design. Built with TypeScript/Node.js (ESM modules), ~15,000 lines across 48 files.

### Key Features
- Multi-provider LLM support (OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, Zhipu, Ollama)
- Two-phase architecture design (P1 global + P2 per-module)
- Automated RTL code generation with lint checking
- Verification environment generation (unit test + system test)
- Automated debug loop (Designer-led, checker-based)
- Interactive CLI with ClawMode (agent mode) and ProjectMode (workflow mode)
- HTTP/2 with PING keep-alive for LLM connections
- Context minimization — each LLM call gets only what it needs

### Tech Stack
- Runtime: Node.js (ESM)
- Language: TypeScript
- LLM SDK: OpenAI SDK (also used for OpenAI-compatible providers)
- EDA: iverilog + vvp (simulation), yosys (lint)

---

## Git Repository Setup

### Repository Info
- **GitHub**: https://github.com/AlwaysAtNeu/rtlclaw
- **Branch**: `main`
- **Visibility**: Public
- **Git identity**: AlwaysAtNeu / 627923266@qq.com

### Initial Setup Commands (already done)

```bash
# Initialize
cd /home/zhaoguo/claude_project/rtl_claw_ts
git init
git branch -m main

# Add remote
git remote add origin https://github.com/AlwaysAtNeu/rtlclaw.git

# First commit
git add .
git commit -m "Initial commit: RTL-Claw v3"

# Push (requires Personal Access Token as password)
git push -u origin main
```

### .gitignore

```
node_modules/    # Dependencies — npm install to restore
dist/            # TypeScript compiled output — npm run build
*.vcd            # Simulation waveform files (large)
test*/           # Local test project directories
untitled/        # Local test directory
.claude/         # Claude Code local settings (contains API keys)
```

### Daily Workflow

```bash
# Check status
git status

# Stage specific files
git add src/llm/openai.ts src/agents/orchestrator.ts

# Commit
git commit -m "Fix: description of change"

# Push
git push
```

### Authentication

GitHub requires a **Personal Access Token** (not password) for HTTPS push:

1. Go to https://github.com/settings/tokens
2. "Generate new token (classic)"
3. Select `repo` scope
4. Copy the token (starts with `ghp_`)
5. Use as password when `git push` prompts

To avoid re-entering every time:
```bash
git config --global credential.helper store
# Next push will save credentials permanently
```

---

## Project Structure

```
rtl_claw_ts/
├── src/
│   ├── cli.ts                  # Entry point
│   ├── ui/app.ts               # Interactive CLI (readline-based)
│   ├── agents/
│   │   ├── orchestrator.ts     # Main orchestrator (workflow + ClawMode)
│   │   ├── prompts.ts          # All LLM prompts
│   │   ├── context-builder.ts  # Builds minimal context for each LLM call
│   │   └── types.ts            # Core type definitions
│   ├── llm/
│   │   ├── base.ts             # Abstract LLM backend
│   │   ├── openai.ts           # OpenAI / OpenAI-compatible backend
│   │   ├── anthropic.ts        # Anthropic Claude backend
│   │   ├── ollama.ts           # Local Ollama backend
│   │   ├── fallback.ts         # Fallback wrapper (primary → fallback, sticky switch)
│   │   ├── factory.ts          # Backend factory
│   │   ├── h2-fetch.ts         # HTTP/2 fetch with PING keep-alive
│   │   └── types.ts            # LLM message/response types
│   ├── stages/
│   │   ├── architect-p1.ts     # Phase 1: global architecture
│   │   ├── architect-p2.ts     # Phase 2: per-module detailed design
│   │   ├── rtl-writer.ts       # RTL code generation + debug fix
│   │   ├── ve-ut.ts            # Verification: unit test TB/TC generation
│   │   ├── ve-st.ts            # Verification: system test
│   │   ├── structural-validation.ts  # Phase 1 structure validation
│   │   ├── design-params-gen.ts      # Auto-generate design_params.vh
│   │   ├── top-gen.ts          # Auto-generate top module
│   │   ├── be.ts               # Backend (synthesis)
│   │   ├── intent.ts           # User intent classification
│   │   ├── summary.ts          # Workflow summary
│   │   └── types.ts            # Stage output types
│   ├── config/
│   │   ├── manager.ts          # Configuration manager (conf-based)
│   │   ├── schema.ts           # Config schema definition
│   │   └── setup.ts            # Interactive setup wizard
│   ├── parser/
│   │   ├── hdl-parser.ts       # Verilog/SV module parser
│   │   ├── checker-parser.ts   # Simulation checker output parser
│   │   └── vcd-parser.ts       # VCD waveform parser
│   ├── tools/
│   │   ├── registry.ts         # EDA tool registry
│   │   ├── runner.ts           # Tool execution
│   │   └── builtin-tools.yaml  # Built-in EDA tool definitions
│   ├── project/
│   │   ├── manager.ts          # Project file management
│   │   └── session.ts          # Session management (unused)
│   ├── flows/
│   │   ├── debug-loop.ts       # (unused — debug loop is in orchestrator)
│   │   └── simulation.ts       # (unused — simulation is in app.ts)
│   └── orchestrator/
│       └── workflow.ts         # Workflow state types
├── tests/
│   └── test-claw-tools.ts     # ClawMode tool calling tests
├── docs/
│   ├── architecture.md         # Current architecture documentation
│   ├── workflow-design-v3.md   # v3 design document (source of truth)
│   ├── workflow-design-v2.md   # v2 design (historical)
│   └── workflow-design.md      # v1 design (historical)
├── package.json
├── tsconfig.json
└── .gitignore
```

### Build & Run

```bash
# Install dependencies
npm install

# Build (TypeScript → JavaScript)
npx tsc

# Run
node dist/cli.js

# Run tests
npx tsx tests/test-claw-tools.ts

# Type check only (no emit)
npx tsc --noEmit
```

### Configuration

On first run, the CLI prompts for LLM provider and API key. Config is stored in the system config directory (managed by the `conf` library). Alternatively, set environment variable:

```bash
export RTL_CLAW_LLM_API_KEY=your_key_here
```
