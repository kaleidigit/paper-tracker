# OPT-007: 管道文件 I/O 去重

## 问题

Pipeline 步骤对同一数据执行重复的文件写入。

### 步骤串联执行时

```
stepCollect  → 写入 1-raw-fetched.json
stepFilter   → 读取 1-raw-fetched.json → 写入 3-llm-filtered.json
stepEnrich   → 读取 3-llm-filtered.json → 写入 5-enriched.json
stepStore    → 读取 5-enriched.json → 写入 papers.db
stepDigest   → 读取 5-enriched.json → 写入 6-digest.md + 6-records.json
stepPush     → 读取 5-enriched.json + 6-digest.md + 6-records.json
             → publishDigest() 内部再次写入 6-digest.md + 6-records.json ← 重复！
```

### 重复写入点

`stepPush`（pipeline.ts:152-176）读取文件后调用 `publishDigest(config, { ... })`，后者内部**又写了一遍** `6-digest.md` 和 `6-records.json`，外加 `latest.json`。

这些文件与 `stepDigest` 写入的**路径相同、内容相同**。因为 `run.sh` 中步骤是串联的，`outputDir` 不变。

### 根因

`publishDigest` 最初设计为独立的 "write + push" 函数（旧 `runWorkflow` 用）。Pipeline 模式引入 `stepDigest` 后，写文件职责已前置到 digest 步骤，但 `publishDigest` 保留了写文件逻辑。

## 影响

- **性能浪费**：每次 push 重复写入 ~几 KB 到 ~2 MB 文件
- **非正确性 bug**：同一内容写入同一路径，幂等
- **语义混淆**：文件写入分散在两个步骤，修改一处容易忘记另一处

## 方案

**推荐：stepPush 直接调用 pushToFeishu**

`stepPush` 已经持有文件内容在手：

```typescript
// pipeline.ts stepPush 当前：
const markdown = await fs.readFile(mdFile, "utf-8");
const publishResult = await publishDigest(config, { title, markdown, records, papers });

// 改为：
const prefix = config.feishu?.doc_title_prefix || "[每日论文追踪]";
const docTitle = `${prefix} ${title}`;
const publishResult = await pushToFeishu(config, docTitle, markdown);
```

`publishDigest` 保留给 `runWorkflow` 兼容（它承担写文件 + 发布双重职责）。

`stepCombinedPush`（pipeline.ts:260-310）已经是这个模式——直接调 `pushToFeishu`，不走 `publishDigest`。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/pipeline.ts:stepPush` | `publishDigest` → `pushToFeishu` |
| `src/publish.ts` | `publishDigest` 保留不动（兼容 runWorkflow） |

## 状态

已实施（2026-05-23）

## 实现

- `pipeline.ts:stepPush` 移除 `publishDigest` 调用（含 `6-records.json` 读取和重复写入）
- 改为直接读取 `6-digest.md` 后调用 `pushToFeishu`
- 与 `stepCombinedPush` 保持一致的模式
- `publishDigest` 保留不动（供 `runWorkflow` 兼容）
