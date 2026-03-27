# RTL-Claw Workflow Design v2 (Revised)

## Design Principles
- All source code, comments, prompts, and generated RTL in English
- LLM conversational replies match user's input language
- Tool/project files always English
- Single chat UI (user never sees agent switching)
- Token-efficient: static tools first, LLM only when needed
- **Context minimization: each agent call receives only the information it needs, NOT full conversation history**

## Roles (4 agents, PM removed)
- **Architect**: Module design, interface definition, verification requirements
- **RTL Designer**: RTL code generation, lint fix, RTL bug fix during debug
- **VE (Verification Engineer)**: TB/TC generation (black-box), TB fix when questioned
- **BE (Backend Engineer)**: Constraint generation, synthesis, timing analysis

User is their own PM. No PM agent.

## Plan Types
- **Standard**: Architect → RTL → VE
- **With BE**: Architect → RTL → VE → BE (user asked after VE completes)

All tasks go through Architect first. No "small plan" that skips Architect.
Intent classification (LLM complete, low overhead) determines: new_project / modify_module / additive_change / spec_change / question.

## Two-Phase Architect

### Phase 1 — Global Architecture (one LLM call)
- Input: user's requirement description
- Output (structured JSON):
  - Module tree (names, ports, parameters, dependencies)
  - Module dependency order (leaves first)
  - Brief functional description per module (1-2 sentences)
  - Inter-module connections (who instantiates whom)
  - Top module(s)
  - **ST verification requirements** (system-level test scenarios, key integration paths)
- User confirms architecture (can request modifications → re-generate)

### Phase 2 — Per-Module Detailed Design (one LLM call per module, before RTL coding)
- Input: Phase 1 global architecture + current module's entry from design index
- Output:
  - Detailed functional specification (FSM, algorithms, timing, boundary conditions)
  - **UT verification requirements** (functional scenarios, edge cases, expected behavior)
- Not shown to user, passed directly to RTL Designer and VE

## Complete Flow

```
User requirement
  ↓
Intent classification (LLM complete, ~200 tokens)
  ↓
Architect Phase 1: Global architecture → user confirms
  ↓
For each module (dependency order, leaves first):
  ├─ Architect Phase 2: Detailed design + UT verification requirements
  ├─ RTL Designer: Write RTL code
  ├─ Lint (static tool) → if errors, Designer fixes
  ├─ VE: Generate UT TB + TC (black-box, based on ports + verification requirements)
  ├─ For each TC: compile + simulate (static tool)
  └─ If fail: Debug Loop
       ├─ Static tools: parse checker output
       ├─ RTL Designer: analyze + fix RTL (or flag tb_suspect)
       ├─ If tb_suspect → VE reviews/fixes TB
       ├─ Re-lint → re-sim → loop
       └─ 8 same-error / 32 total cap → user intervention
  ↓
VE: Generate ST TB + TC (based on Phase 1 ST verification requirements)
  ↓
ST simulation (per TC, single compile each)
  ↓ If fail: checker identifies module → route to that Designer → debug loop
"Verification complete. Proceed with synthesis? (y/n)"
  ↓ (if yes)
BE: Constraint generation + synthesis + timing analysis
  ↓
Summary report (template-based)
```

## Context Management (CRITICAL)

Each agent call receives ONLY the context it needs:

| Call | Context |
|------|---------|
| Intent classification | Short system prompt + user message |
| Architect Phase 1 | User's requirement description |
| Architect Phase 1 (revision) | Previous architecture JSON + user's modification request |
| Architect Phase 2 (module X) | Phase 1 global architecture + module X's entry |
| RTL Designer (write module X) | Phase 2 detailed design for X + dependent module port definitions from design index |
| RTL Designer (lint fix) | Lint error output + current RTL code |
| RTL Designer (debug fix) | Checker error output + current RTL code + module functional description |
| RTL Designer (tb_suspect) | Above + Architect's verification requirements (only when questioning TB) |
| VE (generate UT TB+TC) | Module port definitions from design index + Phase 2 UT verification requirements (NO RTL code — black-box) |
| VE (review TB after tb_suspect) | Designer's reason + TB code + verification requirements |
| VE (generate ST TB+TC) | Phase 1 ST verification requirements + all module ports + top module structure |
| BE (constraints + synthesis) | Design index (all modules) + target device (ask user) |
| BE (timing analysis) | Synthesis report + design index |

NO full conversation history passed to any agent except during user-facing chat (Claw Mode).

## TB and TC Design

### TB (Test Bench) = Test Environment
- Instantiates DUT
- Clock generation, reset logic
- **Built-in checkers/assertions at key output ports**
- Pass/fail determination via checker output
- Failure output format: `ERROR: signal=xxx, expected=xxx, got=xxx, time=xxxns`
- Pass output: `TEST PASSED`

### TC (Test Case) = Scenarios and Workload
- Different input stimuli, configurations, working modes
- One TB can work with multiple TCs
- Each TC compiled and simulated separately

### TB Language
- Not limited to Verilog — SV or any simulator-supported language allowed
- If user explicitly requests .v only, TC can be embedded in TB
- VE decides language and TC loading mechanism based on context

### VCD: Fallback Only
- Default: no VCD generation, rely on checker text output for debug
- If checker info insufficient after several debug rounds → VE adds $dumpvars → re-simulate → extract VCD signals in time window → format as text table → give to Designer

## Debug Loop

### Primary: Checker-Based
1. Simulation fails → checker output identifies signal, expected/actual values, timestamp
2. RTL Designer receives: checker output + RTL code + module functional description
3. Designer fixes RTL, OR returns `{"diagnosis": "tb_suspect", "reason": "..."}`
4. If tb_suspect → VE reviews TB with Designer's reason
5. Re-lint → re-sim

### Fallback: VCD-Based (when checker output insufficient)
1. VE modifies TB to add $dumpvars
2. Re-simulate to generate VCD
3. Static tool: extract relevant signals in time window
4. Format as text table → give to Designer

### Iteration Limits
- Same error: max 8 retries
- Different error: reset that error's counter
- Total cap: 32
- On exceeding: show fix history, show downstream dependencies, ask user:
  1) Continue fixing  2) Skip module  3) Pause for manual intervention

## ST (System Test) Debug
- ST TB has per-module checkers at key output points
- When ST fails, checker output identifies which module has the issue
- Route to that module's Designer for fix → re-sim
- Same debug loop applies

## Module Size Control
- Architect Phase 1: target max 1024 lines per module, split if expected larger
- If RTL Designer generates >1024 lines: route back to Architect to split
- One level of splitting only (v1)

## Mid-Flow Changes
- **Additive change** ("add a DMA module"): route to Architect → update architecture → implement new module(s)
- **Spec change** ("change data width 8→16"): route to Architect → re-evaluate → cascade affected modules
- **Module redo** ("rewrite uart_tx"): Architect Phase 2 with updated requirements → RTL → VE from that module + re-test dependents
- **Question**: answer via stream, no workflow impact

## Two Modes
### Claw Mode (default)
- General AI assistant, no project workflow
- No intent detection

### Project Mode (via /project)
- `/project init <name>` or `/project open <path>` (RTL-Claw projects only in v1)
- Intent detection active → ask user before starting workflow
- `/project close` returns to Claw Mode

### Import Project
- **v1**: Only RTL-Claw projects (with .rtl-claw/ directory) → restore state
- **v2 (future)**: External projects without .rtl-claw/ → scan + build index

## Configuration
- HDL standard: NOT a mandatory config. Architect decides or user specifies in requirements.
- Target device: NOT a mandatory config. Asked by BE when needed.
- LLM provider/model: configured at setup or via /config
- Auto mode: toggleable, skips confirmations

## EDA Tool Strategy
- Check availability before flow starts
- If missing: suggest installation (open-source) or guidance (commercial)
- If user asks RTL-Claw to install: execute installation
- SV support limited in open-source tools → prompt user to install commercial or switch language

## Logging
- Project logs: `.rtl-claw/logs/session-{timestamp}.log`
- LLM traces: `.rtl-claw/logs/llm-trace/` (token counts, durations, roles)
- Concise user display; full details in log files
- `/log` command to view recent entries

## State Recovery
- Workflow state in `.rtl-claw/state.json`
- On project reopen: detect incomplete state → prompt user to continue or restart
- State includes: current plan, current stage, completed/pending modules, module statuses

## Output Strategy
| Scenario | LLM Method | Show to User |
|----------|-----------|--------------|
| Intent classification | complete | No |
| Architect Phase 1 | complete | Architecture summary (module tree) |
| Architect Phase 1 confirm | — | Ask user |
| Architect Phase 2 | complete | No (internal) |
| RTL code generation | complete | Status only ("Wrote xxx.v") |
| Lint results | N/A (tool) | Errors or "passed" |
| VE TB/TC generation | complete | Status only |
| Simulation | N/A (tool) | Pass/fail + errors |
| Debug analysis | complete | Brief status ("Fixing RTL..." / "Questioning TB...") |
| ST results | N/A (tool) | Pass/fail per module |
| BE ask | — | "Proceed with synthesis? (y/n)" |
| BE synthesis | complete | Report summary |
| User Q&A / chat | stream | Yes (streaming) |
| Summary report | template | Yes |
