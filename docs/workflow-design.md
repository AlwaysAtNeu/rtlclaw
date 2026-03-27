# RTL-Claw Workflow Design (Final)

## Design Principles
- All source code, comments, prompts, and generated RTL in English
- LLM conversational replies match user's input language
- Tool/project files always English
- Single chat UI (user never sees agent switching)
- Token-efficient: static tools first, LLM only when needed

## Dynamic Task Planning

### Plan Tiers (determined by LLM intent classification)
- **Small**: RTL Designer -> Lint -> VE (e.g. "write a mux", "write a counter")
- **Medium**: Architect -> RTL Designer -> Lint -> VE (e.g. "design a UART controller")
- **Large**: PM -> Architect -> RTL Designer -> Lint -> VE -> BE (e.g. "design an SoC")

Intent classification: first LLM call (complete, not stream), returns structured JSON:
```json
{"intent": "new_project", "scope": "medium", "stages": ["architect","rtl","ve"]}
```

Minimum plan always includes VE (hardware without verification is meaningless).

### Confirmation Gates (non-auto mode)
1. After PM requirements analysis -> user confirms
2. After Architect module design -> user confirms
3. After VE simulation completes, before BE -> user confirms
4. Destructive commands (rm, git push, vivado, dc_shell) -> user confirms

Auto mode skips all confirmations.

## Step Details

### Step 1: PM (Project Manager) - Requirements
- Analyze user request, ask clarifying questions
- Ask user for HDL standard preference (Verilog-2005 / SV-2012 / SV-2017 / VHDL-2008)
- Ask user for target (ASIC / FPGA + specific device if applicable)
- Output: requirements spec (features, interfaces, constraints, HDL standard, target)
- Auto-create project directory if none exists
- Gate: user confirms requirements

### Step 2: Architect - Module Design
- Design module tree, interfaces, dependencies
- Output: **structured JSON** design index (enforced by prompt)
  - Precise port definitions per module (name, direction, width) — locked before RTL step
  - Module dependency order
  - Inter-module connections
- Initialize structural index, save to .rtl-claw/index.json
- Gate: user confirms architecture
- Port definitions can be revised later if VE/UT discovers interface issues

### Step 3: RTL Designer - Code Generation
- Write modules **serially** in dependency order (leaves first)
- Per-module sub-flow:
  1. LLM generates RTL code (complete, not stream)
  2. Write file to hw/src/hdl/
  3. Update filelist (hw/src/filelist/design.f) — append immediately so dependent modules can compile
  4. Generate/update macro files if needed (hw/src/macro/)
  5. hdl-parser updates structural index (0 tokens)
  6. Lint check (verilator --lint-only / yosys read_verilog)
  7. Simple lint errors: auto-fix; complex: LLM fix
  8. Repeat until lint passes
  9. **Run unit test immediately** (VE generates ut for this module, simulate, debug loop if fail)
- Display to user: progress status only ("Writing uart_tx.v...", "Lint passed", "UT passed")
- No user confirmation needed; auto-proceeds
- After all modules done: run system test (st)

### Step 4: VE (Verification Engineer) - Verification
- Generate testbench per module (unit test) -> hw/dv/ut/sim/tb/
- Generate system test if needed -> hw/dv/st/sim/tb/
- Generate test cases -> hw/dv/tc/
- Run simulation (iverilog/VCS)
- On failure: enter Debug Loop
- Display: pass/fail status, error summary

### Step 5: BE (Backend Engineer) - Synthesis + Constraints
- Gate: user confirms before starting
- Generate constraint files (SDC for ASIC, XDC for FPGA) based on design spec
- Run synthesis (Yosys/DC/Vivado)
- Analyze reports (area, timing, power)
- If timing violation: suggest optimizations
- Display: synthesis report summary
- Scope: synthesis + constraints only; PnR/implementation deferred to future

### Step 6: PM - Summary Report
- Generate project summary (module list, resource usage, verification results)

## Debug Loop

### Iteration Strategy
- Same error: max **8** retries
- Different error: reset that error's counter
- Total iteration cap: **32**
- On exceeding limit: show brief fix history (what was fixed, what wasn't), ask user whether to continue

### Debug Flow
1. Parse simulation errors + VCD waveform
2. Extract signals in time window, format as text table
3. LLM analyzes (complete, low temperature=0.1)
4. Extract patch, apply via line-level matching (not exact string)
5. Re-simulate
6. Repeat until pass or limit reached

### Patch Application
- Use line-level matching (split by lines, trim, compare) instead of exact string match
- Fallback: if line match fails, try fuzzy match with context lines

## Two-Layer Design Index

### Layer 1: Structural (0 tokens)
- hdl-parser (regex) extracts: module names, ports, instances, parameters
- Saved as .rtl-claw/index.json
- Injected into agent system prompts
- Auto-updated after every file write

### Layer 2: Semantic (on-demand, costs tokens)
- Triggered when user asks about specific module functionality
- LLM reads code, generates functional summary
- Cached in index

### Unified DesignIndex Type
Single type definition shared by hdl-parser and project manager:
```typescript
interface DesignIndex {
  modules: ModuleInfo[];
  hierarchy: HierarchyNode[];
  topModules: string[];
  timestamp: string;
}
```

## Import Project Flow
1. `/project open <path>` -> hdl-parser scans all HDL files
2. Build structural index, display summary (module count, top modules)
3. Semantic index built on-demand when user asks questions

## Output Strategy

| Scenario | LLM Method | Show to User |
|----------|-----------|--------------|
| Intent classification | complete | No |
| PM conversation | stream | Yes (streaming) |
| Architect design | complete | Summary only (module tree) |
| RTL code generation | complete | Status only ("Wrote xxx.v") |
| Lint results | N/A | Errors or "passed" |
| VE testbench gen | complete | Status only |
| Simulation results | N/A | Pass/fail + errors |
| Debug analysis | complete | Analysis conclusion |
| User Q&A / chat | stream | Yes (streaming) |
| BE synthesis | complete | Report summary |

## Action Types (semantic, not just raw commands)
- writeFile: write file to project
- runCommand: generic shell command
- askUser: ask user a question
- switchRole: hand off to another agent
- lintCode: trigger lint check on file
- runSimulation: trigger simulation flow
- updateIndex: update design index
- synthesize: trigger synthesis flow

## Project Directory Structure
```
project_name/
  hw/
    src/
      hdl/           # RTL source files
      macro/          # Macro defines, header files (.vh, .svh)
      filelist/       # .f files for EDA tools
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
  .rtl-claw/          # Index, history, config
    index.json
    history.json
    config.json
```

## Agent Prompts
- All prompts in English (no Chinese)
- Each prompt includes structured output format requirements
- Architect prompt enforces JSON design index output
- VE prompt requires standardized pass/fail output in testbench
- All prompts require English code and comments

## Simulation Pass/Fail Detection
- Configurable regex patterns (not just PASS/FAIL)
- VE prompt instructs: use `$display("TEST PASSED")` / `$display("TEST FAILED")`
- Check both exit code + output keywords
- Support user-defined pass criteria in project config

## Session Persistence
- Conversation history saved per project in .rtl-claw/history.json
- Design index persisted in .rtl-claw/index.json
- Sliding window: keep last N turns, compress older to summary
- Load on `/project open`, save after each exchange

## VE and Test Case Relationship
- tc/ defines test parameters and scenarios (stimulus data, config)
- ut/sim/tb/ references tc/ for unit-level verification
- st/sim/tb/ references tc/ for system-level verification
- VE agent generates all three: tc, ut testbench, st testbench

## Feedback Loops
- VE failure -> auto route back to RTL Designer with error context
- RTL Designer fixes -> re-lint -> VE re-runs
- Governed by debug loop iteration limits (8 same error / 32 total)
- On limit exceeded: pause, show history, ask user

## Module Writing Order
- Serial (not parallel): dependency order, leaves first
- Later modules can reference earlier modules' style and interfaces
- Each module: generate -> write -> filelist -> index -> lint -> fix -> ut -> next module
- After all modules: system test (st)

## Filelist Strategy
- Single master filelist: hw/src/filelist/design.f
- Updated incrementally: append each new file immediately after writing
- Includes +incdir+ for macro/ directory
- Enables dependent modules to compile with predecessors
- VE uses this filelist for simulation commands

## setenv Strategy
- Auto-generated template on project creation
- Contains placeholder paths for EDA tools (IVERILOG_HOME, VCS_HOME, etc.)
- User edits to match their environment
- Orchestrator checks and sources setenv before any EDA command
- If setenv missing or tool path invalid: warn user, suggest fix

## Unit Test Timing
- UT runs immediately after each module passes lint (not after all modules)
- Catches interface/logic bugs early, before dependent modules are written
- If UT fails: debug loop runs, RTL Designer fixes, re-lint, re-UT
- If UT fix changes port interface: update design index, may need to revise Architect output

## State Recovery (Crash/Interrupt Resume)
- Record workflow state in .rtl-claw/state.json:
  - Current plan tier and stages
  - Current stage and step within stage
  - Completed modules list
  - Pending modules list
  - Last action timestamp
- On project reopen: detect incomplete state, prompt user:
  "Previous session interrupted at: RTL Designer (3/5 modules done). Continue?"
- User can continue from checkpoint or restart the current stage

## Cross-Module Dependency Fix (Cascading Changes)

### Internal logic change (ports unchanged)
- Fix module A code -> re-lint A -> re-UT A -> re-UT B
- Automatic, no user intervention

### Interface change (ports modified)
- Pause workflow, show impact analysis:
  "Module uart_rx port change: added 'parity_err' output.
   Affected modules: uart_top (instantiates uart_rx)"
- User confirms -> update design index -> cascade fix all dependent modules
- Re-lint and re-UT all affected modules

## UT Retry Limit Exceeded Handling
When a module exceeds retry limits:
```
Module uart_rx: UT FAILED (8/8 same-error retries exhausted)
  Downstream dependencies: uart_rx -> [uart_top, uart_controller]
  Options:
    1) Continue trying to fix uart_rx
    2) Skip uart_rx, proceed to next module (uart_baud_gen)
    3) Pause for manual code/test intervention
```
- Option 3: user edits code or test requirements manually, then `/continue`
- If skipped: st (system test) will warn about incomplete modules

## Mid-Flow Requirement Changes

### Additive change ("add a DMA module")
- Route to **Architect**: update module tree incrementally
- Only design + implement the new module and affected connections
- Existing passing modules untouched

### Spec change ("change data width from 8 to 16")
- Route to **PM**: re-evaluate requirements impact
- Then **Architect**: update design with new spec
- Then cascade: re-generate affected modules, re-lint, re-UT
- Show user impact summary before proceeding

### Detection
- LLM classifies mid-flow user input as: continuation / additive change / spec change / question
- Orchestrator routes accordingly

## RTL Coding Style
- Prompt-based rules (not code injection), kept reasonable:
  - snake_case for signals and modules
  - Non-blocking (<=) for sequential, blocking (=) for combinational
  - One module per file
  - Consistent reset style (sync/async per project config)
  - English comments
- No mandatory pipeline registers in RTL stage
  - RTL Designer writes functionally correct code
  - Pipeline stages only if Architect explicitly specifies them
  - BE identifies timing violations -> suggests register insertion points -> RTL Designer adds
- Style rules defined once in prompt, not injected from prior code

## Timing Register Strategy
- RTL Designer: write clean functional logic, follow Architect's pipeline spec
- If Architect says "3-stage pipeline": RTL Designer implements pipeline registers
- If Architect says nothing about pipeline: write combinational/simple sequential
- BE stage: synthesize -> check timing -> if violation, suggest where to add registers
- Route back to RTL Designer to insert registers at specific paths
- This avoids premature optimization and keeps RTL functionally clean

## Two Modes: Claw Mode vs Project Mode

### Claw Mode (default on startup)
- Standard AI assistant: chat, Q&A, write/read files, run commands
- No project intent detection (won't auto-trigger design workflow)
- Can write code snippets to any path user specifies
- No design index, no workflow state

### Project Mode (activated via /project)
- Entered by `/project open <path>` or `/project init <name>`
- All design workflow features enabled
- Intent detection active (new project / additive / spec change / question)
- Intent detected -> **ask user to confirm** before starting workflow
- User questions answered via stream without affecting workflow state
- `/project close` returns to Claw Mode

### Switching
- No startup mode selection screen (unlike Ink-style menu)
- Previous project auto-detected: "Last project: uart_design. Open? (y/n)"
- One project at a time

## Module Size Control
- Architect prompt constraint: target max 1024 lines per module
- If a functional block is expected to exceed 1024 lines, Architect should split into sub-modules
- If RTL Designer actually generates >1024 lines, flag for review:
  - LLM evaluates if module should be split
  - If yes: route back to Architect to design sub-module decomposition
- LLM generates all code (signals, connections, logic) in v1
  - No script-based template generation for now
  - Optimize later if needed based on real usage patterns

## Import Existing Project Flow (detailed)
1. `/project open <path>` -> enter Project Mode
2. Check for `.rtl-claw/` directory:
   - Exists: restore previous state (index, history, workflow state)
   - Not exists: create `.rtl-claw/`, fresh scan
3. hdl-parser scans all HDL files -> build/update structural index
4. Check existing filelist -> keep, add new files, remove deleted files
5. Display summary: "Found 12 modules, 3 top modules: soc_top, cpu_core, bus_fabric"
6. If incomplete workflow state detected:
   "Previous session interrupted at: RTL Designer (3/5 modules). Continue?"
7. Semantic index built on-demand when user asks about specific modules

## EDA Tool Availability
- Check tool availability before starting any flow that requires EDA
- If tool not found:
  - Show which tools are missing and which are available
  - Suggest installation commands (apt install iverilog, etc.)
  - If user says "help me install": execute installation commands
  - Commercial tools (VCS, Vivado, DC): only provide guidance, cannot auto-install
- Do not allow flow to start if required EDA tool is unavailable

## Logging System
- Project logs: `.rtl-claw/logs/session-{timestamp}.log`
- Content: LLM call summaries (token count, role, key params), EDA tool output, state changes
- Full LLM traces: `.rtl-claw/logs/llm-trace/` (separate files, for debug only)
- Log level follows config `logLevel` setting
- Concise user display; full details in log files

## Error Display
- User sees concise messages: "Lint: 3 errors in uart_tx.v, auto-fixing..."
- Full error details written to log file
- User can view details with `/log` command
