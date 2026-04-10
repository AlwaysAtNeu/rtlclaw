# RTL-Claw 改进建议

> 基于对 `src/` 目录 38 个 TypeScript 文件（~11,300 行）的深度代码审查

## 总体评价

RTL-Claw 是一个**架构清晰、实用性强**的 LLM 驱动 RTL 设计助手。上下文最小化、黑盒验证、HTTP/2 PING 保活、Sticky Fallback 等设计都很出色。以下改进建议按优先级排列。

---

## 一、安全问题（P0 - 高优先级）

### 1.1 ClawMode `execSync` 阻塞事件循环 + 路径遍历

**位置：** `src/agents/orchestrator.ts:319-364` (`executeClawTool`)

**问题：**
- `execSync` 阻塞整个 Node.js 事件循环（Ctrl+C 无法响应）
- `read_file`/`write_file` 无路径校验 → `../../etc/passwd` 可读取任意文件
- `delete_files` 接受 glob 但无沙箱限制

**当前代码：**
```typescript
case 'run_command': {
  const { execSync } = await import('node:child_process');
  const cmd = args.command as string;
  const output = execSync(cmd, {
    cwd: baseDir,
    encoding: 'utf-8',
    timeout: 120_000,
    shell: '/bin/bash',
  });
  return output || '(no output)';
}
```

**建议修改：**

1) 将 `execSync` 替换为 `app.ts` 中已有的 `execAsync`，传入 `context.signal` 支持取消：

```typescript
case 'run_command': {
  const cmd = args.command as string;
  const output = await execAsync(cmd, {
    cwd: baseDir,
    timeout: 120_000,
    signal: context.signal,
  });
  return output || '(no output)';
}
```

2) 对文件操作添加路径越界检查：

```typescript
function assertSafePath(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal not allowed: ${relativePath}`);
  }
  return resolved;
}

// 使用
case 'read_file': {
  const filePath = assertSafePath(baseDir, args.path as string);
  return await fs.readFile(filePath, 'utf-8');
}
```

### 1.2 Anthropic Backend 未使用内部流式（连接断开风险）

**位置：** `src/llm/anthropic.ts:73-131` (`complete()`)

**问题：** `complete()` 使用 `client.messages.create()` 非流式调用。对于使用 extended thinking 的模型（如 Claude 开启 thinking），服务器长时间无数据发送，网络中间设备可能断开连接。`openai.ts` 已经解决了此问题（内部用流式收集）。

**当前代码：**
```typescript
const response = await this.client.messages.create(params, reqOptions);
```

**建议修改：** 与 OpenAI 后端保持一致，使用 `client.messages.stream()` 内部收集：

```typescript
async complete(messages: Message[], options?: LLMCompleteOptions): Promise<LLMResponse> {
  const { system, msgs } = this.convertMessages(messages);
  const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model) ?? 4096;

  const params = {
    model: this.model,
    messages: msgs,
    max_tokens: maxTokens,
    temperature: options?.temperature ?? 0.2,
    ...(system ? { system } : {}),
    ...(options?.tools?.length ? { tools: this.convertTools(options.tools) } : {}),
  };

  // 使用流式内部收集，防止长时间空闲断连
  const stream = this.client.messages.stream(params);
  let content = '';
  const toolCalls: ToolCall[] = [];

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') content += event.delta.text;
    } else if (event.type === 'content_block_stop') {
      // 处理 tool_use 块
    }
  }

  const finalMessage = await stream.finalMessage();
  // 从 finalMessage 提取 usage 和 tool_use 块
  // ...
}
```

---

## 二、架构改进（P1 - 中优先级）

### 2.1 Orchestrator 过大（1311 行），建议拆分

**位置：** `src/agents/orchestrator.ts`

**问题：** 单文件承担了太多职责：ClawMode 工具循环、工作流调度、P1/P2 执行、RTL 流水线、调试循环、ST 测试、BE、Summary。

**建议拆分为：**

```
src/agents/
├── orchestrator.ts          # 保留：入口 handleMessage + 状态管理（~300 行）
├── claw-mode.ts             # 新：ClawMode 工具调用循环 + 文本命令提取
├── workflow-runner.ts       # 新：工作流步骤调度 + 网络重试
├── rtl-pipeline.ts          # 新：P2 → RTL → Lint → UT 完整流水线
├── debug-loop.ts            # 新：调试循环 + VCD 回退逻辑
└── system-test.ts           # 新：ST 生成 + ST Triage
```

每个文件导出 async generator 函数，orchestrator 只负责分发。

### 2.2 重试逻辑重复

**位置：** `anthropic.ts:89-131`, `openai.ts:106-211`

**问题：** 两个后端的重试逻辑几乎相同（transient 检测正则、指数退避、错误日志），违反 DRY。

**建议：** 提取到 `base.ts` 基类：

```typescript
// src/llm/base.ts
export abstract class LLMBackend {
  /** 公共 transient 错误检测正则 */
  static readonly TRANSIENT_PATTERN =
    /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i;

  protected isTransientError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return LLMBackend.TRANSIENT_PATTERN.test(msg);
  }

  protected async withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    opts?: { maxRetries?: number; baseDelayMs?: number; label?: string },
  ): Promise<T> {
    const maxRetries = opts?.maxRetries ?? 2;
    const baseDelay = opts?.baseDelayMs ?? 2000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startMs = Date.now();
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        // AbortError 永不重试
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
          throw err;
        }
        if (!this.isTransientError(err) || attempt >= maxRetries) {
          const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
          process.stderr.write(
            `\n  [LLM] ${opts?.label ?? 'Request'} failed after ${elapsed}s ` +
            `(attempt ${attempt + 1}/${maxRetries + 1}): ${err instanceof Error ? err.message : err}\n`,
          );
          throw err;
        }
        const delay = (attempt + 1) * baseDelay;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}
```

然后各后端简化为：

```typescript
// anthropic.ts
async complete(messages, options) {
  return this.withRetry(async () => {
    const stream = this.client.messages.stream(params);
    // ... 收集结果
  }, { label: 'Anthropic complete' });
}
```

### 2.3 动态 import 不必要

**位置：** `orchestrator.ts:319-364`

**问题：** 多处使用 `await import('node:fs/promises')` 和 `await import('node:path')` 导入 Node.js 内置模块，这些应该在文件顶部静态导入。

**建议：** 在 `orchestrator.ts` 顶部添加：

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
```

移除 `executeClawTool` 中的所有动态 import。

---

## 三、健壮性改进（P1）

### 3.1 LLM 输出缺少运行时类型校验

**位置：** `src/stages/architect-p1.ts:46-69` (`extractJsonFromText`)

**问题：** 直接 `JSON.parse` + `as` 类型断言，LLM 输出缺字段时会导致后续步骤的 `undefined` 运行时崩溃，且错误信息不明确，难以让 LLM 修正。

**建议：** 添加 `zod` 依赖进行运行时 schema 校验：

```bash
npm install zod
```

```typescript
// src/stages/schemas.ts（新文件）
import { z } from 'zod';

export const PortDefSchema = z.object({
  name: z.string(),
  direction: z.enum(['input', 'output', 'inout']),
  width: z.number().int().positive().default(1),
  widthExpr: z.string().optional(),
  description: z.string().optional(),
});

export const ModuleBriefSchema = z.object({
  name: z.string(),
  description: z.string(),
  ports: z.array(PortDefSchema),
  instances: z.array(z.object({
    moduleName: z.string(),
    instanceName: z.string(),
  })).default([]),
});

export const Phase1OutputSchema = z.object({
  modules: z.array(ModuleBriefSchema),
  dependencyOrder: z.array(z.string()),
  topModules: z.array(z.string()),
  topPorts: z.array(PortDefSchema).optional(),
  interfaceContracts: z.array(z.object({
    name: z.string(),
    protocol: z.string(),
    producer: z.string(),
    consumers: z.array(z.string()),
    signals: z.array(z.any()),
    timing: z.string(),
  })).optional(),
  globalParameters: z.any().optional(),
});
```

使用方式：

```typescript
const raw = extractJsonFromText(text);
const result = Phase1OutputSchema.safeParse(raw);
if (!result.success) {
  // 给 LLM 精确的字段级错误信息用于修正
  const errorDetail = result.error.issues
    .map(i => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  yield { type: 'error', content: `JSON validation failed:\n${errorDetail}` };
  // 触发重试...
}
```

### 3.2 魔法数字应从配置读取

**位置：** `orchestrator.ts:101-112`

**问题：** `SAME_ERROR_MAX_RETRIES` 和 `TOTAL_ITERATION_CAP` 已在 config schema 中定义了（`debug.sameErrorMaxRetries` 等），但 orchestrator 使用硬编码值。

**建议：** 从 StageContext 传入配置值：

```typescript
// orchestrator.ts 中
const sameErrorMax = context.config?.debug?.sameErrorMaxRetries ?? 8;
const totalCap = context.config?.debug?.totalIterationCap ?? 32;
```

需要在 `OrchestratorContext` 中添加 config 字段，或将相关值注入 `StageContext`。

### 3.3 `stream_options` 兼容性

**位置：** `openai.ts:97`

**问题：** `stream_options: { include_usage: true }` 不被所有 OpenAI 兼容 API 支持（如某些 Ollama、vLLM 部署会返回 400）。

**建议：** 添加 try-catch 降级，或根据 provider 判断是否启用：

```typescript
const supportsStreamOptions = ['openai', 'deepseek'].includes(this.providerName);
const params = {
  // ...
  stream: true,
  ...(supportsStreamOptions ? { stream_options: { include_usage: true } } : {}),
};
```

---

## 四、功能增强（P2）

### 4.1 Per-Role 模型配置

**问题：** 当前所有 Agent 共享一个 LLM 模型，但实际上不同角色对模型能力的需求差异很大。

| 角色 | 需求 | 推荐模型 |
|------|------|---------|
| Architect | 强推理 + 结构化输出 | o3 / Opus |
| RTL Designer | 大输出窗口 + 代码生成 | Sonnet / Gemini Pro |
| VE | 代码生成（较简单） | Flash / Haiku |
| Debug | 推理 + 代码理解 | Sonnet |

**建议配置结构：**

```typescript
// config/schema.ts
interface AppConfig {
  llm: LLMConfig;           // 默认后端
  fallbackLlm?: LLMConfig;  // 已有
  roleLlm?: {               // 新增：按角色覆盖
    architect?: LLMConfig;
    designer?: LLMConfig;
    ve?: LLMConfig;
    be?: LLMConfig;
  };
}
```

Orchestrator 在创建 StageContext 时按角色选择后端：

```typescript
private getBackendForRole(role: AgentRole): LLMBackend {
  const roleConfig = this.config.roleLlm?.[role];
  if (roleConfig) return createBackend(roleConfig);
  return this.defaultBackend;
}
```

### 4.2 FallbackBackend Sticky 策略过于激进

**位置：** `src/llm/fallback.ts`

**问题：** 一旦主后端失败就永久切到备用，整个会话期间不再尝试主后端。对于临时网络抖动，这会导致不必要地使用备用模型（可能更贵或更弱）。

**建议：** 添加冷却后重试主后端：

```typescript
export class FallbackBackend extends LLMBackend {
  private useFallback = false;
  private switchedAt = 0;
  private readonly cooldownMs = 5 * 60_000; // 5 分钟后重试主后端

  async complete(messages: Message[], options?: LLMCompleteOptions): Promise<LLMResponse> {
    // 冷却期过后，尝试恢复主后端
    if (this.useFallback && Date.now() - this.switchedAt > this.cooldownMs) {
      this.useFallback = false;
    }

    if (this.useFallback) {
      return this.fallback.complete(messages, options);
    }
    // ... 原有逻辑
  }

  private switchToFallback(errMsg: string): void {
    if (!this.useFallback) {
      this.useFallback = true;
      this.switchedAt = Date.now();
      this.onSwitch?.(this.primary.providerName, this.fallback.providerName, errMsg);
    }
  }
}
```

### 4.3 H2 Session 进程退出清理

**位置：** `src/llm/h2-fetch.ts`

**问题：** HTTP/2 session 缓存在 Map 中，进程退出时未清理，可能导致进程挂住。

**建议：** 在 `createH2Fetch()` 中添加：

```typescript
export function createH2Fetch(): typeof globalThis.fetch {
  const sessions = new Map<string, { session: http2.ClientHttp2Session; timer: ReturnType<typeof setInterval> }>();

  // 进程退出时清理所有 HTTP/2 会话
  const cleanup = () => {
    for (const { session, timer } of sessions.values()) {
      clearInterval(timer);
      if (!session.destroyed) session.destroy();
    }
    sessions.clear();
  };
  process.once('beforeExit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  // ... 原有逻辑
}
```

### 4.4 History 压缩可用 LLM 摘要

**位置：** `orchestrator.ts:104-105`

**当前策略：** `HISTORY_MAX_MESSAGES=60, HISTORY_TRIM_TO=20` 简单截断丢弃旧消息。

**建议：** 参考 Claude Code 的 compact 机制，在截断前用一次轻量级 LLM 调用生成摘要，保留关键上下文：

```typescript
private async compressHistory(context: OrchestratorContext): void {
  if (context.history.length <= HISTORY_MAX_MESSAGES) return;

  // 提取要压缩的旧消息
  const toCompress = context.history.slice(0, context.history.length - HISTORY_TRIM_TO);
  const kept = context.history.slice(context.history.length - HISTORY_TRIM_TO);

  // 用轻量模型生成摘要
  const summaryResp = await this.backend.complete([
    { role: 'system', content: 'Summarize this conversation in 3-5 bullet points. Focus on decisions made and current state.' },
    { role: 'user', content: toCompress.map(m => `${m.role}: ${m.content}`).join('\n') },
  ], { maxTokens: 500, temperature: 0 });

  context.history = [
    { role: 'system', content: `[Previous conversation summary]\n${summaryResp.content}` },
    ...kept,
  ];
}
```

---

## 五、代码质量（P2）

### 5.1 添加核心模块单元测试

**现状：** `package.json` 有 `test` 脚本，但无测试文件。

**优先建议（按投入产出排序）：**

| 测试文件 | 测试目标 | 原因 |
|---------|---------|------|
| `stages/structural-validation.test.ts` | 结构验证（环检测、端口一致性） | 纯逻辑，无 LLM 依赖，最易测 |
| `parser/hdl-parser.test.ts` | HDL 解析（端口提取、模块识别） | 用固定 Verilog 片段验证 |
| `llm/factory.test.ts` | 后端创建、provider 路由 | 确保配置正确映射 |
| `agents/context-builder.test.ts` | 上下文最小化验证 | 确保各角色只收到需要的信息 |
| `stages/architect-p1.test.ts` | JSON 提取、HDL 代码剥离 | `extractJsonFromText`, `stripHdlCodeBlocks` |

示例（Node.js 内置 test runner）：

```typescript
// tests/structural-validation.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePhase1Structure } from '../src/stages/structural-validation.js';

describe('validatePhase1Structure', () => {
  it('should detect cyclic dependencies', () => {
    const output = {
      modules: [
        { name: 'a', instances: [{ moduleName: 'b', instanceName: 'b0' }] },
        { name: 'b', instances: [{ moduleName: 'a', instanceName: 'a0' }] },
      ],
      dependencyOrder: ['a', 'b'],
      // ...
    };
    const result = validatePhase1Structure(output);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /cycl/i.test(e)));
  });
});
```

### 5.2 LLM Trace 可视化

**当前：** JSONL 日志很好，但缺乏快速查看手段。

**建议：** 添加 `/trace` 命令或 `--trace-report` CLI 选项，生成统计摘要：

```
Token Usage Summary:
  Architect P1:   12,340 in / 3,210 out  ($0.05)   45.2s
  Architect P2:    8,100 in / 2,800 out  ($0.03)   32.1s  ×3 modules
  RTL Writer:     15,600 in / 8,900 out  ($0.08)   55.3s  ×3 modules
  VE (UT):         9,200 in / 6,100 out  ($0.05)   41.0s  ×3 modules
  Debug:           4,500 in / 1,200 out  ($0.02)   18.5s  ×2 rounds
  ─────────────────────────────────────────────────
  Total:          49,740 in / 22,210 out  ($0.23)  192.1s
```

---

## 六、改进优先级总览

| 优先级 | 类别 | 改进项 | 工作量 |
|--------|------|--------|--------|
| **P0** | 安全 | 路径遍历防护 (`assertSafePath`) | 小 |
| **P0** | 安全 | `execSync` → `execAsync` | 小 |
| **P0** | 健壮 | Anthropic 内部流式（防断连） | 中 |
| **P1** | 架构 | Orchestrator 拆分（5 个文件） | 大 |
| **P1** | 架构 | 重试逻辑提取到基类 | 中 |
| **P1** | 健壮 | LLM 输出 Zod schema 校验 | 中 |
| **P1** | 健壮 | 魔法数字从 config 读取 | 小 |
| **P1** | 质量 | 添加核心模块单元测试 | 中 |
| **P1** | 质量 | 顶部静态 import 替代动态 import | 小 |
| **P2** | 功能 | Per-Role 模型配置 | 中 |
| **P2** | 功能 | Fallback 冷却恢复机制 | 小 |
| **P2** | 功能 | H2 Session 进程退出清理 | 小 |
| **P2** | 功能 | History LLM 摘要压缩 | 中 |
| **P2** | 功能 | `stream_options` 兼容性处理 | 小 |
| **P2** | 功能 | LLM Trace 可视化 `/trace` 命令 | 中 |
