# OPT-003: 统一重试与容错模式

## 问题

重试逻辑以三种不同模式散布在代码库中，缺乏统一性：

### 模式 A：`modules.ts:withRetry`（用于 runWorkflow 顶层）

```typescript
async function withRetry<T>(max: number, backoffMs: number, job: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= max; i++) {
    try { return await job(); } catch (e) { last = e; if (i === max) break; await new Promise((r) => setTimeout(r, backoffMs)); }
  }
  throw last;
}
```

特点：固定退避时间，3 次，抛最终错误。

### 模式 B：`modules.ts:enrichOne` 内联（翻译 + 分类各 3 次）

```typescript
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    translated = await translatePaperFields(config, paper);
    // ...
    break;
  } catch (error) {
    if (attempt < 2) {
      const delay = 5_000 * (2 ** attempt) * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

特点：指数退避 + 25% 抖动，3 次，吞错误（不抛）。**这段代码在 `enrichOne` 中出现了 3 次**（翻译 retry、中文分类 retry、英文分类 retry）。

### 模式 C：`modules.ts:filterPapers` 内联（LLM batch fallback + 单篇 retry）

```typescript
// 批处理失败 → 逐篇 fallback
try { return await llmFilterAndTranslateBatch(config, batch); }
catch { /* fallback to per-paper */ }

// 逐篇 fallback 内部：2 次尝试，10s 固定间隔
for (let attempt = 0; attempt < 2; attempt++) {
  try { result = await llmFilterAndTranslate(config, p); break; }
  catch (err) { /* 10s wait */ }
}
```

特点：固定退避，2 次，吞错误。

### 模式 D：`utils.ts:backoffDelay`（用于 fetchText/fetchJson）

```typescript
function backoffDelay(attempt: number, baseMs = 1000): number {
  const exp = baseMs * Math.pow(2, attempt - 1);
  const jitter = exp * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}
```

特点：指数退避 + 25% 抖动，3 次，抛最终错误。这是最接近"标准实现"的版本——但它内嵌在 `utils.ts` 的 fetch 函数内部，不可复用。

## 影响

- **行为不一致**：退避策略各不相同（固定 vs 指数，抖动 vs 无抖动）
- **维护负担**：修改重试策略需要在 5+ 个位置同步
- **缺少可观测性**：没有统一的重试次数/延迟日志

## 方案

在 `src/utils.ts` 中暴露一个通用的 `retry` 函数：

```typescript
export interface RetryOptions {
  maxAttempts: number;        // 默认 3
  baseDelayMs: number;        // 默认 1000
  backoff: "fixed" | "exponential";  // 默认 "exponential"
  jitter: boolean;            // 默认 true
  onRetry?: (attempt: number, delay: number, error: unknown) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>
): Promise<T> {
  const o: RetryOptions = {
    maxAttempts: 3, baseDelayMs: 1000,
    backoff: "exponential", jitter: true, ...opts
  };
  let last: unknown;
  for (let i = 0; i < o.maxAttempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < o.maxAttempts - 1) {
        const rawDelay = o.backoff === "exponential"
          ? o.baseDelayMs * Math.pow(2, i)
          : o.baseDelayMs;
        const delay = o.jitter
          ? Math.round(rawDelay * (0.5 + Math.random() * 0.5))
          : rawDelay;
        o.onRetry?.(i + 1, delay, e);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw last;
}
```

然后将所有手动重试循环替换为此函数。

## 估计工作量

小型重构，约 60 行新增 + 各调用点替换 ~10 行/处。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/utils.ts` | 新增 `retry()` |
| `src/modules.ts` | `withRetry` → `retry`；`enrichOne` 三处循环 → `retry`；`filterPapers` 内联 → `retry` |
| `src/parsers/openalex-parser.ts` | 分页 fetch 可考虑加重试（见 REQ-008） |
| `src/parsers/nature-parser.ts` | 同上 |

## 状态

已实施（2026-05-23）

## 实现

- `utils.ts` 新增 `retry()` 函数（指数退避 + 25% 抖动，可选 `onRetry` 回调用于日志）
- `modules.ts`：
  - 移除 `withRetry` 函数
  - `runWorkflow` 中 3 处 `withRetry` → `retry`（保留 `maxAttempts`/`baseDelayMs` 配置接口）
  - `enrichOne` 中 3 处分类重试循环 + 1 处翻译重试循环 → `retry`（带 `onRetry` 日志回调）
  - `filterPapers` 中逐篇回退重试 → `retry`
