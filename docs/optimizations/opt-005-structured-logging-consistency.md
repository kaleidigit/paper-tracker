# OPT-005: 统一结构化日志模式

## 问题

项目有两条日志路径：

### 路径 1：`Logger` 类（`src/logger.ts`）

```typescript
const logger = new Logger(logsDir);
await logger.info("run.start", { runKey, mode: "run-once" });
await logger.error("run.failed", { runKey, error: String(error) });
```

特点：
- 同时写入文件（按日期分文件）和 stdout/stderr
- 统一 JSON 格式
- 只在 `cli.ts` 中使用

### 路径 2：原始 `process.stdout.write`（遍布其余代码）

```typescript
process.stdout.write(`${JSON.stringify({
  timestamp: new Date().toISOString(), level: "INFO",
  event: "workflow.filter.done", input: rawPapers.length, ...
})}\n`);
```

特点：
- 只写 stdout，不落盘
- JSON 格式手动拼接（容易出错）
- 在 `pipeline.ts`、`modules.ts`、`parsers/*.ts`、`db.ts` 中广泛使用

### 差异

| 维度 | Logger 类 | 原始 stdout |
|------|----------|------------|
| 落盘 | ✅ 按日期分文件 | ❌ |
| 格式一致性 | ✅ 强制 JSON | ⚠️ 手动拼接 |
| 时间戳 | ✅ 自动添加 | ⚠️ 每处手动添加 |
| 使用范围 | `cli.ts` 仅 | 其余所有模块 |

## 影响

- **日志丢失**：stdout 日志不落盘，cron 运行时无法回溯
- **格式漂移**：各模块的 JSON 日志格式可能不一致（字段名、嵌套层级）
- **测试困难**：无法 mock 日志输出来验证操作路径

## 方案

1. 将 `Logger` 类改造为单例模式或模块级导出，使其可以在不传递实例的情况下使用
2. 在 `modules.ts`、`pipeline.ts`、`parsers/*`、`db.ts` 中统一使用 `Logger`
3. 或者更务实地：保留 `process.stdout.write` 模式但统一通过一个 helper 函数输出，避免手动拼接 `JSON.stringify`：

```typescript
// src/logger.ts
export function logEvent(level: "INFO" | "WARN" | "ERROR", event: string, data?: Record<string, unknown>): void {
  const payload = { timestamp: new Date().toISOString(), level, event, ...data };
  const line = `${JSON.stringify(payload)}\n`;
  process.stdout.write(line);
}
```

这个方案改动最小，所有模块替换为 `logEvent("INFO", "workflow.filter.done", { ... })`。

## 权衡

- 方案 2（helper 函数）改动最小，但不解决落盘问题
- 方案 1（单例 Logger）改动较大，需要处理 profile 上下文（日志目录因 profile 而异）
- 目前 cron 模式依赖 stdout 重定向到文件（`>> cron.log`），如果改为 Logger 落盘则不需要 shell 重定向

## 推荐

短期：方案 2（统一的 `logEvent` helper），替换所有 `process.stdout.write(JSON.stringify(...))` 调用，降低格式错误风险。

长期：方案 1，Logger 支持 profile-aware 日志目录，自动落盘。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/logger.ts` | 新增 `logEvent` helper 或改造为单例 |
| `src/pipeline.ts` | ~6 处 `process.stdout.write` → `logEvent` |
| `src/modules.ts` | ~6 处 → `logEvent` |
| `src/parsers/openalex-parser.ts` | ~4 处 → `logEvent` |
| `src/parsers/nature-parser.ts` | ~4 处 → `logEvent` |
| `src/db.ts` | 2 处 → `logEvent` |

## 状态

已实施（2026-05-24）

## 实现

- `logger.ts` 新增 `logEvent()` 无状态 helper，自动注入时间戳、统一输出到 stdout（ERROR→stderr）
- 6 个文件共 ~27 处 `process.stdout.write(JSON.stringify({...}))` 替换为 `logEvent(level, event, data)`
- 涉及文件：`pipeline.ts`(4), `modules.ts`(6), `db.ts`(1), `llm.ts`(6), `nature-parser.ts`(5), `openalex-parser.ts`(5)
