# Workflow Design Improvements

Date: 2026-04-01
Reference: `docs/workflow-design-v3.md` + implementation analysis

## 1. [MED] tb_suspect Review Missing functionalSpec

- **Problem**: `reviewTB()` received `verifReqs` (coarse scenario list) but not `functionalSpec` (detailed behavior). VE couldn't judge checker correctness accurately.
- **Fix**: Added `functionalSpec` parameter to `reviewTB()` and `buildVETBReviewMessages()`. Both call sites (tb_suspect path + spec audit path) now pass it.
- **Status**: DONE

## 2. [MED] Lint Error Handling Lacks Infrastructure Fallback

- **Problem**: Lint errors from non-RTL sources (design_params.vh, filelist, dependency ports) couldn't be fixed by editing the current module. Designer got hammered 8 times for nothing.
- **Fix**: Added same-error tracking to `runLint()`. Same lint error 2 rounds → escalate to Infrastructure Debug Agent (reuses `runInfraDebug` with 'compile' mode). Infrastructure resolved → reset counters and re-lint.
- **Status**: DONE

### 2a. [MED] Debug Fix Skips Re-Lint

- **Problem**: After Designer debug fix, went directly to re-sim without lint. Syntax errors became compile errors at sim time.
- **Fix**: Added lint check after RTL debug fix, before re-sim. If lint fails, `fixLintErrors` is called once to fix it.
- **Status**: DONE

### 2b. [LOW] Fresh Rewrite After Lint Exhaustion Is Blind

- **Problem**: Fresh rewrite after 4 lint failures used same inputs as first write, with no knowledge of what went wrong.
- **Fix**: Added `previousLintError` parameter to `writeModule()` and `buildRTLWriteMessages()`. Last lint error is passed as negative context.
- **Status**: DONE

## 3. [MED] VE TB Generation Missing globalParameters

- **Problem**: VE generated TB without knowing global parameter values. Led to hardcoded widths instead of parameter names.
- **Fix**: Added `globalParameters` parameter to `buildVEUnitTBMessages()`, `buildVESystemTBMessages()`, `generateUTTestbench()`, and `generateSTTestbench()`. Orchestrator passes `phase1Output.globalParameters` to both UT and ST generation.
- **Status**: DONE

## 4. [LOW] Spec-Checker Audit Only Runs Once

- **Problem**: After VE fixed TB and re-sim still failed, entered debug loop without verifying the fix didn't break other checkers.
- **Fix**: Wrapped audit in a loop (max 2 rounds). If audit finds checker bug → VE fixes → re-sim fails → re-audit with updated TB. Checker confirmed correct or max rounds → proceed to debug loop.
- **Status**: DONE

## 5. [LOW] ST Triage Diagnosis Not Passed to Designer Debug

- **Problem**: Designer received raw ST top-level checker output but not triage's localized diagnosis. Hard to map top-level errors to sub-module internals.
- **Fix**: Prepend `[ST Triage] diagnosis` to error string before passing to `debugLoop()`.
- **Status**: DONE

## 6. [LOW] tb_suspect Has No Cap

- **Problem**: Unlimited tb_suspect requests caused ping-pong between Designer and VE.
- **Fix**: Added `TB_SUSPECT_CAP = 3`. After cap, tb_suspect is logged but VE review is skipped. Status message tells Designer TB has been reviewed and to focus on RTL.
- **Status**: DONE
