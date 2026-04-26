# RTL-Claw Architecture

> Last updated: 2026-04-26

AI-powered RTL development assistant. TypeScript/Node.js, ESM modules.
Total: ~11,300 lines across 38 source files.

## Source Tree

```
src/
  cli.ts                          # Entry point (bin/rtl-claw)
  ui/
    app.ts (1060)                 # CLI readline loop, spinner, action executor
                                  #   - executeAction: writeFile, lintCode, runSimulation,
                                  #     updateIndex, synthesize
                                  #   - LLM trace logger (JSONL + human-readable + detail files)
  agents/
    orchestrator.ts (1311)        # Workflow state machine
                                  #   - Intent classification → Architect P1 → P2 → RTL → Lint →
                                  #     VE-UT → Debug Loop → VE-ST → optional BE
                                  #   - buildStageContext: bridges OrchestratorContext → StageContext
                                  #   - Debug loop: 8 same-error / 32 total cap, VCD fallback
                                  #   - tb_suspect mechanism (Designer questions TB → VE reviews)
                                  #   - State save/restore for crash recovery
    context-builder.ts (573)      # Builds minimal Message[] per LLM call (context minimization)
                                  #   - buildRTLWriteMessages, buildRTLDebugFixMessages,
                                  #     buildVEUnitTBMessages, buildVETBReviewMessages, etc.
    prompts.ts (619)              # System prompts per role
                                  #   - ARCHITECT_P1_PROMPT, RTL_DESIGNER_PROMPT,
                                  #     RTL_DESIGNER_DEBUG_PROMPT, VE_UT_PROMPT, VE_ST_PROMPT, etc.
    types.ts                      # Shared types: ArchitectPhase1Output, Phase2Output,
                                  #   DesignIndex, InterfaceContract, PortDef, ModuleBrief, etc.
  stages/                         # Each stage = one LLM call, minimal context
    types.ts (75)                 # StageContext, OutputChunk, LLMTraceEntry
    intent.ts (114)               # Intent classification (quick question vs design request)
    architect-p1.ts (841)         # Requirements analysis → P1 architecture (modules, ports,
                                  #   deps, interface contracts, global params, top ports)
                                  #   - Tool calling with JSON fallback
                                  #   - P1 revision loop (user feedback)
    architect-p2.ts (237)         # Per-module detailed design (functionalSpec, FSM, timing,
                                  #   boundary conditions, utVerification)
    rtl-writer.ts (392)           # writeModule: P2 → RTL code generation
                                  #   fixLintErrors: lint output → fixed RTL
                                  #   debugFix: checker output → diagnosis (fix/tb_suspect)
                                  #   - Passes debugHistory to LLM for iterative fixes
    ve-ut.ts (452)                # generateUTTestbench: black-box TB from ports + verifReqs
                                  #   reviewTB: VE reviews TB when Designer flags tb_suspect
                                  #     (returns reason for both correct/fixed outcomes)
                                  #   addVCDToTB: VCD fallback after 4 similar errors
                                  #   fixCompileErrors: TB compile error fix
    ve-st.ts (137)                # System-level testbench generation
    structural-validation.ts(176) # P1 output validation (acyclic deps, port consistency, etc.)
    design-params-gen.ts (129)    # Generate design_params.vh from global parameters
    top-gen.ts (209)              # Auto-generate top module from interface contracts
    be.ts (112)                   # Backend Engineer stage (timing, synthesis)
    summary.ts (173)              # Workflow summary generation
  llm/                            # LLM backend abstraction
    types.ts (61)                 # Message, LLMResponse (with retryCount), ToolCall, etc.
    base.ts (38)                  # Abstract LLMBackend class
    factory.ts (99)               # createBackend: config → backend instance
    openai.ts (243)               # OpenAI-compatible backend (Gemini, DeepSeek, Kimi, Qwen)
                                  #   - Internal streaming for all calls (keep-alive)
                                  #   - Tool call delta accumulation
                                  #   - 3 attempts with 5/10s delays
                                  #   - HTTP/2 fetch with PING keep-alive
    h2-fetch.ts (247)             # HTTP/2 fetch wrapper
                                  #   - PING every 10s (prevents proxy idle disconnect)
                                  #   - 'close' event handling (prevents silent hang)
                                  #   - 5-min idle watchdog on response body
                                  #   - Session caching per origin, GOAWAY handling
    anthropic.ts (171)            # Anthropic backend
    ollama.ts (138)               # Ollama (local models) backend
  config/
    schema.ts                     # Config schema, DEFAULT_CONFIG
    manager.ts                    # ConfigManager (conf-based persistence)
    setup.ts                      # Interactive setup wizard
  project/
    manager.ts                    # Project file structure, design index, filelist management
  parser/
    hdl-parser.ts                 # Verilog/SV/VHDL parser (modules, ports, instances)
    vcd-parser.ts                 # VCD waveform parser (fallback debug)
    checker-parser.ts             # Checker output parser
  tools/
    registry.ts                   # EDA tool registry (YAML-based)
    runner.ts                     # EDA tool runner
```

## Key Data Flow

```
User input
  → Intent classification (LLM)
  → Orchestrator dispatches:

  [Design Request]
    1. Requirements analysis (LLM) → assumptions + questions → user confirms
    2. Architect P1 (LLM, tool calling) → modules, ports, deps, interface contracts,
       global params, top ports, ST verification reqs
       → Structural validation (static, no LLM)
       → User review/revision loop
    3. For each module (dependency order, leaves first):
       a. Architect P2 (LLM) → functionalSpec, FSM, timing, utVerification
       b. RTL Writer (LLM) → .sv file → write to hw/src/hdl/
       c. Lint (iverilog/verilator) → fix loop (up to 4+4 attempts)
       d. VE-UT (LLM) → TB file + TC files → write to hw/dv/ut/sim/
       e. Simulate (iverilog) → per-TC: substitute PLACEHOLDER_TC in TB, compile, run
       f. Debug loop (if fail):
          - Designer LLM diagnoses (with debugHistory + checkerOutput + RTL)
          - fix → rewrite RTL → re-simulate ALL TCs
          - tb_suspect → VE reviews TB (returns reason) → continue
          - VCD fallback after 4 similar errors
          - 8 same-error / 32 total cap
    4. Auto-generate top module (script, no LLM)
    5. Generate design_params.vh
    6. VE-ST → system test
    7. Optional BE stage

  [Quick Question]
    → Single LLM response, no workflow
```

## TB/TC Architecture

```
hw/dv/ut/sim/
  tb/tb_counter.sv     # Test environment: DUT, clock, reset, checkers, error_count
                       #   Ends with: `include "PLACEHOLDER_TC"
                       #   Calls run_test() defined in TC
  tc/tc_counter_basic.sv    # Defines task run_test(): stimulus + checker calls
  tc/tc_counter_overflow.sv # Another scenario
```

Simulation: for each TC, tool substitutes `PLACEHOLDER_TC` with TC path,
compiles (TB + RTL via design.f), runs independently. PASSED only if all TCs pass.

## Verification Independence (VE Black-Box Boundary)

Designer (RTL) and VE roles are kept independent: **Designer never reads TB/TC
source during debug.** This mirrors industrial DV practice but is *more*
necessary in LLM contexts than in human ones.

### The rule

Designer's debug context contains: spec (P2), RTL source, checker output,
attemptHistory, and optional VCD signals.
Designer's debug context does **not** contain TB or TC source.

The only path to question the TB is `diagnosis: tb_suspect`: Designer returns
the suspicion plus reasoning → VE re-reads TB against spec independently →
returns `correct` (with reason) or `fixed` (with reason). Both reasons land in
attemptHistory so Designer cannot repeat the same suspicion.

### Why structural enforcement (LLM-specific reasoning)

Human DV engineers carry professional ethics — they will not bend a TB to make
a failing test pass. LLMs have no such constraint. Given visibility into both
TB and RTL, the cheapest path for a model is often "blame the TB" rather than
diagnose the actual RTL bug. Process discipline has to be enforced structurally
because there is no internalized discipline to fall back on. Tightening
information access is the only reliable lever.

### Known crack: VE compile fix reads RTL ports

`fixCompileErrors` in `src/stages/ve-ut.ts` reads the module's RTL signature
(ports) when the compile error references undeclared module names — VE needs
the port list to repair an instantiation. **Reading RTL ports/signature is
allowed; reading the implementation body is not.** This narrow exception is
the cost of letting VE fix port-spelling bugs without forcing an `ask_user`
detour. The Infrastructure Debug Agent owns any case that needs broader RTL
visibility (it's user-authorized and explicitly breaks the boundary).

### The independence chain

1. Architect writes spec (P1 + P2) — the ground truth.
2. VE writes TB from spec + ports — never reads RTL bodies.
3. Designer writes RTL from spec + ports — never reads TB.
4. `tb_suspect` → VE re-reads TB against spec (cross-check).
5. Spec-checker audit (after debug exhaustion) → independent third party reads
   spec + RTL + TB and names which side is wrong.

No single role can adjust both sides of the contract on its own.

### Costs

- **Trivial modules** pay an extra round-trip on TB issues. Acceptable: tokens
  are cheap, silent regressions are not.
- **Obvious TB bugs** can't be fixed directly by Designer. Mitigated by
  `tb_suspect` with detailed reasoning, which routes to VE in one step.
- **Designer mis-describes the bug** in `tb_suspect`, so VE review misses the
  real issue. Mitigated by VE re-reading TB independently against the spec
  rather than treating Designer's framing as authoritative.

### Safety nets when the basic loop stalls

- **attemptHistory** — prior fixes, tb_suspect events, VE review reasons,
  oscillation hints; blocks dead-end repetition (negative-example framing).
- **VCD fallback** — after 4 similar errors, Designer gets waveform signals so
  diagnosis isn't pure guessing from checker text.
- **Spec-checker audit** — runs *before* the debug loop and after exhaustion;
  an independent agent reads spec + RTL + TB and identifies the wrong side.
- **Infrastructure Debug Agent** — when the problem is outside any role's scope
  (build env, tool config), a user-authorized agent breaks independence
  explicitly.

### Future relaxation (not v1)

A trust-score mechanism could let Designer see a *summary* of the TB (not
source) once both sides have demonstrated stability across many modules. Out of
scope for v1: the rigid boundary is appropriate while LLM behavior on this
workflow is still being characterized.

## LLM Call Strategy

- All calls use **internal streaming** (even non-streaming `complete()`)
- **HTTP/2 + PING keep-alive** via h2-fetch.ts (critical for China proxy environments)
- **Context minimization**: each LLM call gets only the data it needs, no chat history
- **3 attempts** with 5/10s retry delays for transient errors
- **5-min timeout** per request (streaming keeps connection alive; 5 min silence = dead)
- **Fallback backend** with sticky switching (once primary fails, stays on fallback)
- Transient error detection: timeout, ECONNRESET, 499, 5xx, fetch failed, stream closed

## Logging

```
<project>/.rtl-claw/logs/llm-trace/
  trace-YYYY-MM-DD.jsonl    # Machine-readable: every LLM call + simulation
  trace-YYYY-MM-DD.log      # Human-readable one-liner per event
  detail/                   # Full prompt + response content per LLM call
    <timestamp>_<context>.md
```

Each trace entry includes: role, tokens, duration, promptChars, responseChars,
hasCodeBlock, retryCount, summary, and optionally full prompt/response content.

## Project Directory Convention

```
<project>/
  hw/src/hdl/           # RTL source files (one module per file)
  hw/src/macro/         # Macro/include files
  hw/src/filelist/design.f  # Single filelist for all RTL
  hw/dv/ut/sim/tb/      # Unit test testbenches
  hw/dv/ut/sim/tc/      # Unit test cases
  hw/dv/st/sim/tb/      # System test testbenches
  hw/dv/st/sim/tc/      # System test cases
  hw/syn/               # Synthesis scripts + output
  .rtl-claw/
    state.json          # Workflow state (crash recovery)
    logs/llm-trace/     # LLM trace logs
```

## Config

Persisted via `conf` library at `~/.config/rtl-claw-nodejs/config.json`.

Key settings:
- `llm.provider`: openai | anthropic | gemini | deepseek | kimi | qwen | ollama
- `llm.model`: model name
- `llm.apiKey`: API key
- `llm.baseUrl`: custom endpoint
- `llm.timeoutMs`: 600000 (10 min default)
- `autoMode`: skip confirmations

## Known Limitations

- Cross-module interface change protocol not yet implemented (port changes don't cascade)
- Per-role model configuration not yet supported (all roles share one model)
