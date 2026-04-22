# Infra Debug Agent — 代码修改对比

针对"infra debug 只给建议不修改"问题所做的代码层面改动（不含 prompt 文本，prompt 单独见 `infra-debug-prompt-diff.md`）。

---

## 1. `src/stages/infra-debug.ts` — 结果解析增加守卫

### 修改前

```typescript
// Parse result from LLM's summary
const resolved = fullContent.includes('RESOLVED:') && !fullContent.includes('UNRESOLVED:');
const summaryMatch = fullContent.match(/(?:RESOLVED|UNRESOLVED):\s*([\s\S]*?)$/);
const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 500) : fullContent.slice(-300).trim();

yield { type: 'status', content: `Infrastructure Debug Agent finished: ${resolved ? 'RESOLVED' : 'UNRESOLVED'} (${toolRounds} total, ${actionRounds} action)` };

return {
  resolved,
  summary,
  modifiedFiles,
  toolRounds,
  actionRounds,
};
```

### 修改后

```typescript
// Parse result from LLM's summary
const claimedResolved = fullContent.includes('RESOLVED:') && !fullContent.includes('UNRESOLVED:');
const summaryMatch = fullContent.match(/(?:RESOLVED|UNRESOLVED):\s*([\s\S]*?)$/);
let summary = summaryMatch ? summaryMatch[1].trim().slice(0, 500) : fullContent.slice(-300).trim();

// Guardrail: claiming RESOLVED without ever calling write_file/run_command means
// the agent only described a fix instead of applying it. Downgrade to UNRESOLVED.
let resolved = claimedResolved;
if (claimedResolved && actionRounds === 0) {
  resolved = false;
  const note = 'Agent claimed RESOLVED but never called write_file/run_command — fix was only described, not applied. Downgraded to UNRESOLVED.';
  yield { type: 'error', content: note };
  summary = `${note}\nOriginal summary: ${summary}`.slice(0, 500);
}

yield { type: 'status', content: `Infrastructure Debug Agent finished: ${resolved ? 'RESOLVED' : 'UNRESOLVED'} (${toolRounds} total, ${actionRounds} action)` };

return {
  resolved,
  summary,
  modifiedFiles,
  toolRounds,
  actionRounds,
};
```

### 改动要点
- `resolved` 从 `const` 改为 `let`，以便守卫条件下可以降级。
- 新增条件：`claimedResolved && actionRounds === 0` 时强制降级为 `UNRESOLVED`，并在输出流中写一条 `error` 通知编排层。
- `summary` 也追加说明（被截断保持 ≤500 chars）。

---

## 2. `tests/infra-debug.test.ts` — 测试更新

### 新增辅助函数

```typescript
function runToolCall(id: string, command: string) {
  return [{ id, name: 'run_command', arguments: { command } }];
}
```

### 原测试 1（会被守卫破坏，修正以反映真实场景）

修改前：

```typescript
it('many pure reads do NOT trigger action cap, LLM can voluntarily stop', async () => {
  // 12 read rounds, then voluntarily stop → NOT forced, action cap never hit
  const script: Script = [
    ...Array.from({ length: 12 }, (_, i) => ({
      toolCalls: readToolCall(`r${i}`, `nonexistent-${i}.v`),
    })),
    { content: 'RESOLVED: investigated thoroughly, nothing broken.', toolCalls: [] },
  ];
  // ...
  assert.equal(result.resolved, true);
  assert.equal(result.actionRounds, 0, 'no writes/runs → actionRounds stays 0');
  assert.equal(result.toolRounds, 12, 'read-only turns counted in toolRounds');
});
```

修改后：

```typescript
it('many pure reads + final verify run: action cap not hit, RESOLVED honored', async () => {
  // 12 read rounds, then 1 run_command to verify, then voluntarily stop
  const script: Script = [
    ...Array.from({ length: 12 }, (_, i) => ({
      toolCalls: readToolCall(`r${i}`, `nonexistent-${i}.v`),
    })),
    { toolCalls: runToolCall('verify', 'echo ok') },
    { content: 'RESOLVED: investigated thoroughly, verified nothing broken.', toolCalls: [] },
  ];
  // ...
  assert.equal(result.resolved, true);
  assert.equal(result.actionRounds, 1, 'one run_command → actionRounds=1');
  assert.equal(result.toolRounds, 13, '12 reads + 1 run');
});
```

### 新增测试：守卫行为

```typescript
it('claims RESOLVED but never acted → guardrail downgrades to UNRESOLVED', async () => {
  const script: Script = [
    { toolCalls: readToolCall('r0', 'foo.v') },
    { toolCalls: readToolCall('r1', 'bar.v') },
    { content: 'RESOLVED: I see the issue, you should change line 42 to use blocking assignment.', toolCalls: [] },
  ];
  // ...
  assert.equal(result.actionRounds, 0);
  assert.equal(result.resolved, false, 'guardrail downgrades RESOLVED→UNRESOLVED when no action taken');
  assert.match(result.summary, /never called write_file\/run_command/);
});
```

### 改动要点
- 原测试 1 场景（纯 read 后 RESOLVED）已不符合新逻辑，调整为"多 read + 1 次 verify run"的合理场景。
- 新增测试显式覆盖守卫路径：只 read 不 act 却声称 RESOLVED → 必须降级。

---

## 测试结果

```
✔ many pure reads + final verify run: action cap not hit, RESOLVED honored
✔ claims RESOLVED but never acted → guardrail downgrades to UNRESOLVED
✔ 8 write rounds trigger action cap and forced summary IS traced
✔ 32 read rounds trigger total cap and forced summary IS traced
✔ mixed reads then writes: only writes count toward action budget
ℹ pass 5 / fail 0
```
