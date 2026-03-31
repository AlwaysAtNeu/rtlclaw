# RTL-Claw Workflow Design v3

Based on v2. Additions/changes marked with **[v3]**.

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
Intent classification (LLM complete, low overhead) determines: new_project / additive_change / spec_change / question.

## Two-Phase Architect

### **[v3]** Requirements Gathering (before Phase 1)
- Input: user's raw requirement
- LLM analyzes requirement, outputs:
  - What it understood
  - Design assumptions it would make (data width, architecture style, interface protocol, etc.)
  - Clarifying questions (if any)
- Shown to user for confirmation/clarification
- If user answers questions → merge answers into confirmed requirements
- If LLM has no questions → show understanding + assumptions → user confirms to proceed
- **[v3]** This is the ONLY confirmation that is NOT skippable in auto mode (wrong assumptions derail the entire design)
- This phase and Phase 1 confirmation together form two user checkpoints:
  1. **Requirements confirmed** (assumptions + answers aligned)
  2. **Architecture confirmed** (P1 output reviewed and approved)
- **[v3]** If user completely rejects P1 architecture (not just modification), flow returns to Requirements Gathering (user's design intent may have changed)

### Phase 1 — Global Architecture (one LLM call)
- Input: confirmed requirements (original requirement + confirmed assumptions + user's answers)
- Output (structured JSON):
  - Module tree (names, ports, parameters, hierarchy/dependencies)
  - Module dependency order (leaves first)
  - Brief functional description per module (1-2 sentences)
  - Top module(s)
  - **[v3]** Top-level ports (topPorts — which signals the top module exposes externally)
  - **[v3]** Global parameters (project-wide constants: data widths, depths, counts, etc.)
  - **[v3]** Interface contracts (see below)
  - **ST verification requirements** (system-level test scenarios, key integration paths)
- **[v3]** Structural validation (static, no LLM):
  - Dependency graph is acyclic (topological sort)
  - All instantiated modules exist in the module list
  - Module names are unique
  - topModule(s) exist in module list
  - **[v3]** Interface contract validation: signals referenced in contracts exist in the corresponding module's port list
  - **[v3]** Interface contract modules: producer/consumer module names exist in module list
  - NOTE: skip parameterized width checking (expressions like `[DATA_WIDTH-1:0]` are too complex for static comparison; width mismatches are caught by lint)
  - If validation fails → feed errors back to LLM for correction
- User confirms architecture (can request modifications → re-generate)

### **[v3]** Interface Contracts (part of P1 output)

P1 defines explicit contracts for data/control interfaces between modules.
**Infrastructure signals (clk, rst_n) do NOT need contracts** — auto-wiring script connects them by port name matching.

```json
{
  "interfaceContracts": [
    {
      "name": "fft_data_stream",
      "protocol": "valid/ready handshake",
      "producer": "fft_stage",
      "consumers": ["butterfly"],
      "signals": ["data_re", "data_im", "valid", "ready"],
      "timing": "Producer holds data stable while valid=1 until ready=1",
      "dataFormat": "Q1.15 signed fixed-point, 16-bit"
    },
    {
      "name": "twiddle_lookup",
      "protocol": "synchronous ROM read",
      "producer": "twiddle_rom",
      "consumers": ["butterfly"],
      "signals": ["addr", "cos_out", "sin_out"],
      "timing": "Output valid 1 cycle after addr change",
      "dataFormat": "Q1.15 signed fixed-point, 16-bit"
    }
  ]
}
```

- `consumers` is an array — supports one-to-many (broadcast) scenarios
- Contracts only cover interfaces with protocol/timing significance
- **[v3]** Signal naming convention: producer and consumer port names MUST match the contract's `signals` names (enforced by Architect prompt). This enables auto-wiring by name. If a rare case needs different names on each side, use optional `signalMapping` override:
  ```json
  "signalMapping": [{"wire": "data", "producerPort": "tx_data", "consumerPort": "rx_data"}]
  ```
- **[v3]** Structural validation also checks: signals in contracts exist in corresponding module port definitions

Purpose:
- P2 designs each module's interface behavior to match the contract
- RTL Designer implements to the contract specification
- VE can add interface protocol checkers in TB (e.g., valid/ready handshake compliance)
- Auto-wiring script uses contracts to derive inter-module wire connections
- Eliminates inconsistency between independently-designed modules

### **[v3]** Top-Level Ports (part of P1 output)

P1 specifies which ports the top module exposes to the outside world. This is a design decision (which signals are external) — kept minimal:
```json
{
  "topPorts": [
    {"name": "clk", "direction": "input", "width": 1},
    {"name": "rst_n", "direction": "input", "width": 1},
    {"name": "data_in_re", "direction": "input", "widthExpr": "DATA_WIDTH"},
    {"name": "data_out_re", "direction": "output", "widthExpr": "DATA_WIDTH"},
    {"name": "output_valid", "direction": "output", "width": 1}
  ]
}
```

All other top-level wiring (inter-module connections, infrastructure signals) is derived by the auto-wiring script from interface contracts + module port definitions. P1 does NOT output detailed connection tables — that would waste tokens on mechanical information.

### **[v3]** Global Parameters and Header File

P1 output includes a `globalParameters` section:
```json
{
  "globalParameters": {
    "DATA_WIDTH": 16,
    "FFT_POINTS": 128,
    "STAGE_NUM": 7
  }
}
```

Auto-generated into `hw/src/macro/design_params.vh` (format depends on HDL standard):

Verilog:
```verilog
`ifndef DESIGN_PARAMS_VH
`define DESIGN_PARAMS_VH
`define DATA_WIDTH 16
`define FFT_POINTS 128
`define STAGE_NUM  7
`endif
```

SystemVerilog:
```systemverilog
package design_params;
  parameter DATA_WIDTH  = 16;
  parameter FFT_POINTS  = 128;
  parameter STAGE_NUM   = 7;
endpackage
```

Modules use `` `include "design_params.vh" `` (Verilog) or `import design_params::*;` (SV).
Eliminates parameter passing through instantiation hierarchy.

### **[v3]** Top Module Auto-Generation

Top module is **purely structural** (instantiation + wiring only). Architect prompt enforces:
- "Any logic belongs in a named sub-module."
- **[v3]** "Each child module appears as exactly ONE instance at the top level. If multiple instances of the same module are needed (e.g., 7 fft_stage), create a wrapper sub-module (e.g., fft_pipeline) to contain them."

Top module is **auto-generated** by script from P1 JSON (no LLM, no P2, no Designer):
- **Top-level ports**: from P1's `topPorts`
- **Instance declarations**: from P1's module hierarchy (instance names auto-generated as `u_` + module_name)
- **Inter-module wires**: derived from interface contracts (contract signals → wire declarations + port connections)
- **Infrastructure signals** (clk, rst_n): auto-connected by port name matching across all instances
- `include "design_params.vh"` or `import design_params::*`

Benefits: zero token cost, zero hallucination risk, deterministic from P1 definition.
P1 does NOT need detailed connection tables — the script derives all wiring from interface contracts + module port definitions.

Top module has **no UT** — its correctness is guaranteed by P1 definition and validated by ST.

**[v3]** Future optimization: Architect can mark intermediate modules as `structural_only` for auto-generation too. For now, only top module is auto-generated.

### Phase 2 — Per-Module Detailed Design (one LLM call per module, serial, before RTL coding)
- Input: Phase 1 global architecture + current module's entry + **[v3]** relevant interface contracts
- Output:
  - Detailed functional specification (FSM, algorithms, timing, boundary conditions)
  - **UT verification requirements** (functional scenarios, edge cases, expected behavior)
- Not shown to user, passed directly to RTL Designer and VE
- **[v3]** Only for non-top modules (top module is auto-generated)

## Complete Flow

```
User requirement
  ↓
Intent classification (LLM complete, ~200 tokens)
  ↓
[v3] Requirements Gathering: analyze → show assumptions/questions → user confirms
  ↓
Architect Phase 1: Global architecture (with confirmed requirements)
  ↓
[v3] Structural validation (static, includes interface contract checks) → fix if errors
  ↓
User confirms architecture
  ↓
[v3] Auto-generate: design_params.vh (from global parameters)
  ↓
For each non-top module (dependency order, leaves first):
  ├─ Architect Phase 2: Detailed design + UT verification requirements
  ├─ RTL Designer: Write RTL code
  ├─ Lint (static tool, max 4 fix attempts) → if errors, Designer fixes
  │   └─ [v3] If 4 attempts fail → fresh Designer rewrite; if still fails → user intervention
  ├─ VE: Generate UT TB + TC (black-box, based on ports + verification requirements)
  ├─ For each TC: compile + simulate (static tool)
  │   └─ [v3] If compile error → route to VE to fix TB/TC (max 4 attempts, not Designer)
  └─ If runtime fail: Debug Loop
       ├─ Static tools: parse checker output
       ├─ RTL Designer: analyze + fix RTL (or flag tb_suspect)
       ├─ If tb_suspect → VE reviews/fixes TB
       ├─ Re-lint → re-sim ALL TCs (regression) → loop
       └─ 8 same-error / 32 total cap → user intervention
  ↓
[v3] Auto-generate: top module (script derives wiring from interface contracts + port defs)
  ↓
VE: Generate ST TB + TC (based on Phase 1 ST verification requirements)
  ↓
ST simulation (per TC, single compile each)
  ↓ If fail: Designer ST triage → route to module debug / P1 revision / VCD fallback
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
| **[v3]** Requirements gathering | User's raw requirement |
| Architect Phase 1 | **[v3]** Confirmed requirements (original + assumptions + user answers) |
| Architect Phase 1 (revision) | Previous architecture JSON + user's modification request |
| Architect Phase 2 (module X) | Phase 1 global architecture + module X's entry + **[v3]** interface contracts involving module X |
| RTL Designer (write module X) | Phase 2 detailed design for X + dependent module port definitions from design index + **[v3]** relevant interface contracts |
| RTL Designer (lint fix) | Lint error output + current RTL code |
| RTL Designer (debug fix) | Checker error output + current RTL code + module functional description + **[v3]** debug history summary |
| RTL Designer (tb_suspect) | Above + Architect's verification requirements (only when questioning TB) |
| VE (generate UT TB+TC) | Module port definitions + Phase 2 functional spec (functionalSpec, FSM, timing, boundary conditions) + UT verification requirements + **[v3]** relevant interface contracts (NO RTL code — black-box) |
| **[v3]** VE (fix compile error) | Compile error output + TB/TC code |
| **[v3.1]** Spec-Checker Audit | Phase 2 functional spec + TB checker code + checker failure output → conclusive judgment (checker correct or mismatch) |
| VE (review TB after tb_suspect) | Designer's reason + TB code + verification requirements |
| VE (generate ST TB+TC) | Phase 1 ST verification requirements + all module ports + top module structure + **[v3]** all interface contracts |
| **[v3]** Designer (ST triage) | ST checker error + auto-generated top module code + relevant sub-module port definitions |
| BE (constraints + synthesis) | Design index (all modules) + target device (ask user) |
| BE (timing analysis) | Synthesis report + design index |

NO full conversation history passed to any agent except during user-facing chat (Claw Mode).

### **[v3]** Debug History Summary

Appended to Designer context after each debug round to prevent repeated mistakes:
```
Round 1: Fixed off-by-one in counter reset (line 45)
Round 2: Fixed missing clock enable on data_valid (line 78)
Round 3: flagged tb_suspect — VE fixed checker timing expectation
Round 4: [current]
```

- Generated from Designer's `fix_summary` field (required in Designer output format)
- tb_suspect events also recorded (so Designer knows TB was already modified)
- Orchestrator collects and concatenates — zero extra LLM cost
- Persisted in state.json per module for state recovery

## TB and TC Design

### TB (Test Bench) = Test Environment
- Instantiates DUT
- Clock generation, reset logic
- **Built-in checkers/assertions at key output ports**
- **[v3]** Interface protocol checkers where applicable (e.g., valid/ready handshake compliance)
- Pass/fail determination via checker output
- Failure output format: `ERROR: signal=xxx, expected=xxx, got=xxx, time=xxxns`
- Pass output: `TEST PASSED`

### TC (Test Case) = Scenarios and Workload
- Different input stimuli, configurations, working modes
- One TB can work with multiple TCs
- Each TC compiled and simulated separately
- **[v3]** After any debug fix, re-run ALL TCs for that module (regression), not just the failing one

### TB Language
- Not limited to Verilog — SV or any simulator-supported language allowed
- If user explicitly requests .v only, TC can be embedded in TB
- VE decides language and TC loading mechanism based on context

### VCD: Fallback Only
- Default: no VCD generation, rely on checker text output for debug
- **[v3]** Trigger condition: same error persists for **4 consecutive rounds** with similar checker output (Designer's fixes aren't resolving it)
- VE adds $dumpvars → re-simulate → extract VCD signals in time window → format as text table → give to Designer

## Debug Loop

### **[v3.1]** Per-TC Execution
- TCs run serially; on first failure, stop immediately and enter debug
- Debug targets the specific failing TC (faster feedback, VCD matches the TC)
- After fix, re-run that TC; if it passes, run full regression (all TCs)
- Regression failure on a different TC → switch to debugging that TC

### Primary: Checker-Based (functional errors)
1. Simulation fails → checker output identifies signal, expected/actual values, timestamp
2. RTL Designer receives: checker output + RTL code + module functional description + **[v3]** debug history summary
3. Designer fixes RTL and returns `fix_summary` (one-line description), OR returns `{"diagnosis": "tb_suspect", "reason": "..."}`
4. If tb_suspect → VE reviews TB with Designer's reason
5. Re-sim failing TC → pass → regression

### **[v3.1]** Compile Error Escalation
Compile errors use a **two-tier** strategy: specific-role fix first, then infrastructure agent.

**Tier 1 — Specific-role fix:**
- Error points to RTL file → Designer fixes
- Error points to TB/TC file → VE fixes
- Error type unclear → skip to Tier 2
- **Same-error cap: 2 rounds.** If same compile error persists after 2 rounds → Tier 2
- Different error → reset same-error counter (making progress)
- **Total cap: 5 rounds** across all compile errors → Tier 2

**Tier 2 — Infrastructure Debug Agent** (see below):
- Tool-calling agent with `list_files`, `read_file`, `write_file`, `run_command`
- Can investigate and fix any project file (filelist, paths, include dirs, scripts, etc.)
- No verification independence concern (compile errors are pre-simulation)

### Fallback: VCD-Based (when checker output insufficient)
1. **[v3]** Triggered after 4 rounds of similar checker output with no progress
2. Deterministic insertion: add `$dumpfile`/`$dumpvars` to TB (no LLM needed)
3. Immediate re-sim (failing TC only) to generate VCD
4. **[v3.1]** Signal selection: if >25 signals, Designer LLM selects 10-25 relevant signals
5. Timescale-aware extraction: convert checker error time (ns) to VCD time units
6. Format as text table with checker errors → give to Designer

### **[v3.1]** Functional Error Escalation
When the normal debug loop is exhausted, escalate before giving up:

```
Designer debug loop (RTL only, independent)
  → tb_suspect → VE independent review
  → VCD fallback → Designer with waveform
  → 8 same-error / 32 total → exhausted
  → Spec-Checker Audit (VE compares spec vs TB checker logic independently)
    → TB mismatch found → fix TB → re-enter debug loop
    → TB confirmed correct → RTL bug confirmed
  → Still stuck → **ask user**:
    (1) Enable Infrastructure Debug (LLM sees both RTL and TB)
    (2) Manual intervention
  → User chooses (1) → Infrastructure Debug Agent
    → spec is immutable ground truth in prompt
    → can read/write all files + run simulation
    → max 8 rounds
    → still fails → user manual intervention
```

### **[v3.1]** Infrastructure Debug Agent
A tool-calling agent for problems beyond the scope of specific-role fix.

**Tools:**
- `list_files(dir)` — list directory contents
- `read_file(path)` — read any project file
- `write_file(path, content)` — write any project file
- `run_command(cmd)` — run lint/simulation commands

**Prompt context (not via tools):**
- The error output that triggered escalation
- P2 spec (functionalSpec, utVerification) as **immutable ground truth**
- Project file structure overview

**Constraints:**
- Max tool rounds: 8 (compile) / 8 (functional)
- For functional debug: user must explicitly authorize (independence is broken)
- Spec is anchor: "Fix code to match spec. Never modify spec or adjust expectations to match buggy behavior."
- All operations logged for audit

**Trigger conditions:**
- Compile: specific-role fix failed (2 same-error or 5 total), or error type unclear
- Functional: user authorizes after normal debug loop exhausted

### Iteration Limits
- **[v3]** Lint fix: max **4** attempts per Designer invocation. Exceeding → discard and re-invoke Designer for a fresh rewrite. If fresh rewrite also fails 4 lint attempts → user intervention
- **[v3.1]** Compile error: same-error **2** rounds → infrastructure. Total **5** rounds → infrastructure
- Same error (debug): max **8** retries
- Different error: reset that error's counter
- Total debug cap: **32**
- **[v3.1]** Infrastructure debug: max **8** tool rounds
- **[v3]** Lint, compile, and debug counters are all independent
- On exceeding all limits: show fix history, show downstream dependencies, user manual intervention

## ST (System Test) Debug

- ST TB has per-module checkers at key output points
- When ST fails, checker output identifies which module has the issue
- Most wiring errors are caught at compile time (auto-generated top + structural validation). Remaining ST failures are subtler integration issues.
- **[v3]** ST debug uses a **triage step** — Designer LLM call determines failure layer:

### ST Triage (one LLM call)
Designer receives: ST checker error + auto-generated top module code + relevant sub-module port definitions.
Returns one of:
```json
// Case A: sub-module logic issue
{"fix_location": "module", "module_name": "butterfly", "diagnosis": "output not bit-reversed"}

// Case B: connection/contract issue
{"fix_location": "connection", "diagnosis": "twiddle_rom output should connect to stage1 not stage0"}

// Case C: insufficient info
{"fix_location": "unknown", "diagnosis": "need VCD to trace signal propagation"}
```

### Routing based on triage
- **module** → enter that module's debug loop (same as UT debug)
- **connection** → Architect P1 revision to fix interface contract → re-generate top module → re-run ST
- **unknown** → VCD fallback (VE adds $dumpvars to ST TB) → Designer re-analyzes with waveform data

Same debug loop iteration limits apply.

### **[v3]** Incremental Rebuild after P1 Revision

When P1 is revised (due to ST integration fix, additive change, or spec change):
1. Diff old P1 output vs new P1 output
2. For each module:
   - **Unchanged** (same ports, same connections): keep RTL, keep UT results
   - **Ports changed**: re-run P2 → RTL Designer → Lint → VE UT
   - **New module**: full P2 → RTL → Lint → VE UT flow
   - **Removed module**: delete files, remove from filelist
3. Re-generate top module (always, since connections may have changed)
4. Re-generate design_params.vh if global parameters changed
5. Re-run ST (always, since architecture changed)

## Module Size Control
- Architect Phase 1: target max 1024 lines per module, split if expected larger
- If RTL Designer generates >1024 lines: route back to Architect to split
- One level of splitting only

## **[v3]** Cross-Module Interface Change Protocol

During debug, a fix may require changing a module's port interface. Two cases:

### Internal logic change (ports unchanged)
- Fix module A → re-lint A → re-UT A (all TCs) → re-UT modules that depend on A
- Automatic, no user intervention

### Interface change (ports modified)
1. Designer proposes interface change (new/removed/modified ports)
2. System performs structural impact analysis (static, no LLM):
   - Which modules instantiate the changed module?
   - Which connections are affected?
3. Show impact summary to user:
   ```
   Module uart_rx: port change — added 'parity_err' output.
   Affected modules: uart_top (instantiates uart_rx)
   ```
4. User confirms → update design index → cascade:
   - Re-run P2 for affected modules (updated interface context)
   - Re-generate RTL for affected modules
   - Re-lint, re-UT affected modules
5. If change propagates further (affected module's ports also change), repeat

### Mid-Flow Requirement Changes (from user)
- **Additive change** ("add a DMA module"): route to Architect P1 → update architecture → new module gets full P2→RTL→VE flow + **[v3]** affected parent modules re-generate RTL (add instance) + re-UT + re-ST
- **Spec change affecting multiple modules** ("change data width 8→16"): route to Architect P1 → re-evaluate → incremental rebuild (see above)
- **Spec change affecting single module** ("change FIFO depth"): re-run P2 for that module → RTL → VE → re-test dependents
- **Module redo** ("rewrite uart_tx"): Architect Phase 2 with updated requirements → RTL → VE from that module + re-test dependents
- **Question**: answer via stream, no workflow impact

## **[v3]** Timing Register Strategy
- RTL Designer writes functionally correct, clean code
- Pipeline registers ONLY when Architect explicitly specifies pipeline stages
  - If Architect says "3-stage pipeline": Designer implements pipeline registers
  - If Architect says nothing about pipeline: write combinational / simple sequential
- After BE synthesis:
  - If timing violation detected → BE suggests specific register insertion points (which paths, which module boundaries)
  - Route back to RTL Designer to insert registers at suggested locations
  - Re-lint → re-UT after insertion → **re-ST** (register insertion changes latency, may affect integration timing)
- This avoids premature optimization and keeps RTL functionally clean
- NOTE: detailed BE→Designer→re-ST loop is a future optimization; basic BE flow (report only) comes first

## **[v3]** RTL Coding Style (prompt-based rules)
- `snake_case` for signals and module names
- Non-blocking (`<=`) for sequential logic, blocking (`=`) for combinational logic
- One module per file
- Consistent reset style (sync/async per project config or Architect's choice)
- English comments
- No "magic numbers" — use parameters/localparams (from design_params.vh)
- These rules are embedded in Designer's system prompt, not injected from prior code

## **[v3.1]** Filelist Management
- Filelist(s) generated by Architect at P1 phase — LLM decides filelist names, structure, and initial content
- There may be multiple filelists (e.g. RTL compilation, simulation, synthesis), Architect specifies purpose of each
- Filelist name(s) stored in P1 output and project config — NOT hardcoded
- Updated incrementally: append each new module file immediately after writing
- Includes `+incdir+` for macro/include directories
- VE and BE reference filelists by name from project config
- On module rewrite: filelist entry stays (same filename), file content replaced

## **[v3]** setenv Strategy
- Auto-generated template on project creation: `hw/setenv`
- Contains placeholder paths for EDA tools:
  ```bash
  export IVERILOG_HOME=/usr/bin
  export VCS_HOME=          # Fill if available
  export VIVADO_HOME=       # Fill if available
  ```
- User edits to match their environment
- Orchestrator sources `hw/setenv` before any EDA command
- Also auto-detect common installation paths (`which iverilog`, etc.)
- If setenv missing or tool path invalid: warn user, suggest fix
- If tool completely unavailable: block flow, suggest installation

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
- **[v3]** Auto mode: toggleable, skips all confirmations **EXCEPT** requirements gathering confirmation (wrong assumptions derail the entire design)

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

## **[v3]** State Recovery (detailed)

Workflow state persisted in `.rtl-claw/state.json`:
```json
{
  "plan": "standard",
  "phase": "rtl_write",
  "confirmedRequirements": "...",
  "p1Output": {
    "modules": [...],
    "topModules": [...],
    "dependencyOrder": [...],
    "interfaceContracts": [...],
    "globalParameters": {...},
    "topPorts": [...],
    "stVerificationReqs": "..."
  },
  "p2Outputs": {
    "butterfly": { "functionalSpec": "...", "utVerificationReqs": "..." },
    "fft_stage": { "functionalSpec": "...", "utVerificationReqs": "..." }
  },
  "completedModules": ["butterfly"],
  "currentModule": "fft_stage",
  "moduleStatuses": {
    "butterfly": "ut_passed",
    "fft_stage": "rtl_writing"
  },
  "lintAttempts": { "butterfly": 0, "fft_stage": 2 },
  "veCompileAttempts": { "butterfly": 0 },
  "debugAttempts": { "butterfly": { "sameError": 0, "total": 3 } },
  "debugHistory": {
    "butterfly": [
      "Round 1: Fixed off-by-one in counter reset (line 45)",
      "Round 2: Fixed missing clock enable on data_valid (line 78)"
    ]
  },
  "lastTimestamp": "2026-03-17T10:30:00Z"
}
```

On project reopen:
- Detect incomplete state → prompt user:
  `"Previous session interrupted at: RTL Designer (3/5 modules done). Continue from fft_stage?"`
- User can: continue from checkpoint / restart current module / restart entire flow
- All completed phase outputs are preserved — no need to re-run LLM for finished stages

## Output Strategy
| Scenario | LLM Method | Show to User |
|----------|-----------|--------------|
| Intent classification | complete | No |
| **[v3]** Requirements gathering | complete | Yes (assumptions + questions) |
| **[v3]** Requirements confirm | — | Ask user (NOT skippable in auto mode) |
| Architect Phase 1 | complete | Architecture summary (module tree) |
| Architect Phase 1 confirm | — | Ask user |
| **[v3]** Structural validation | N/A (tool) | Errors if any (auto-fix via LLM) |
| Architect Phase 2 | complete | No (internal) |
| RTL code generation | complete | Status only ("Wrote xxx.v") |
| Lint results | N/A (tool) | Errors or "passed" |
| **[v3]** TB/TC compile error | N/A (tool) | Brief error + "VE fixing..." |
| VE TB/TC generation | complete | Status only |
| Simulation | N/A (tool) | Pass/fail + errors |
| Debug analysis | complete | Brief status ("Fixing RTL..." / "Questioning TB...") |
| ST results | N/A (tool) | Pass/fail per module |
| **[v3]** ST triage | complete | Brief diagnosis ("Module X logic issue" / "Connection fix needed") |
| BE ask | — | "Proceed with synthesis? (y/n)" |
| BE synthesis | complete | Report summary |
| User Q&A / chat | stream | Yes (streaming) |
| Summary report | template | Yes |

## Project Directory Structure
```
project_name/
  hw/
    src/
      hdl/           # RTL source files (including auto-generated top module)
      macro/          # design_params.vh (auto-generated), other headers
      filelist/       # design.f (incremental append)
    dv/
      st/             # System tests
        sim/
          tb/          # System testbenches
      ut/             # Unit tests
        sim/
          tb/          # Unit testbenches
      tc/             # Test cases (scenarios/parameters)
    syn/              # Synthesis scripts & reports
    setenv            # Shell script: EDA tool paths & licenses
  doc/                # Specs, reports (auto-generated)
  .rtl-claw/          # Index, history, config, state
    index.json
    state.json
    config.json
    logs/
      session-*.log
      llm-trace/
```

## Future Optimizations (deferred)
- **Intermediate structural modules**: Architect marks `structural_only` modules for auto-generation (currently only top module)
- **P1 incremental revision**: LLM outputs diff instead of full regeneration (saves tokens for large designs)
- **Lint fix with cheaper model**: Use smaller model for mechanical fixes, escalate to full model if needed
- **VE feedback on vague requirements**: VE can request clarification if UT verification requirements are insufficient
- **BE→Designer timing loop**: Full automated loop for register insertion based on timing analysis
