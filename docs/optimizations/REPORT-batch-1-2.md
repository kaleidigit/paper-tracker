# 优化实施报告

**日期**: 2026-05-23
**执行批次**: 第一批（共享基础设施收敛）+ 第二批（管道健壮性）

---

## 第一批：共享基础设施收敛（opt-001 ~ opt-003）

### 变更摘要

| 变更 | 文件 | 内容 |
|------|------|------|
| **opt-001a** | `src/utils.ts` | `normalizePublicationType` 增加 `"news & view"`（单数）→ `"editorial"` 的匹配，与 article-parser 旧版行为对齐 |
| **opt-001a** | `src/parsers/article-parser.ts` | 移除本地 `normalizePublicationType` 方法，统一从 `utils.ts` 导入 |
| **opt-001b** | `src/parsers/article-parser.ts` | 移除本地 `normalizeText`（15 行）和 `dedupeStrings`（11 行），从 `utils.ts` 导入 |
| **opt-001c** | `src/db.ts` | 移除本地 `normalizeText`（3 行），从 `utils.ts` 导入 |
| **opt-001d** | `src/config.ts` | 移除本地 `normalizeText`（3 行）和 `resolvePath`（3 行），从 `utils.ts` 导入再导出 |
| **opt-002a** | `src/parsers/shared.ts` | **新建**：提取 `buildPaper`（25 行）和 `loadJournals`（7 行）为共享模块 |
| **opt-002b** | `src/parsers/openalex-parser.ts` | 删除本地 `buildPaper`（26 行）和 `loadJournals`（6 行），从 `shared.ts` 导入；移除不再需要的 `resolvePath`、`normalizePublicationType`、`strictWindowStartAt` 导入 |
| **opt-002c** | `src/parsers/nature-parser.ts` | 删除本地 `buildPaper`（27 行）和 `loadJournals`（6 行），从 `shared.ts` 导入；移除不再需要的 `resolvePath` 导入 |
| **opt-003a** | `src/utils.ts` | 新增 `retry()` 通用重试函数（指数退避 + 25% 抖动，可配置次数/延迟/回调） |
| **opt-003b** | `src/modules.ts` | 移除 `withRetry` 函数（7 行）；替换 4 处内联重试循环（~50 行）为 `retry()` 调用 |

### 效果

- **消除重复代码**: 净删除 ~120 行重复代码
- **单一切入点**: `normalizeText`/`dedupeStrings`/`normalizePublicationType` 各只有一处实现
- **BuildPaper 统一**: 修改 `Paper` 类型只改 `shared.ts` 一处
- **重试策略一致**: 所有重试统一使用指数退避 + 抖动

---

## 第二批：管道健壮性（opt-006 ~ opt-007）

### 变更摘要

| 变更 | 文件 | 内容 |
|------|------|------|
| **opt-006a** | `src/db.ts` | `getKnownDedupKeys` 和 `upsertPapers` 改为接受 `Database.Database` 参数（而非 `dbPath`），由调用者管理连接生命周期；`openDb` 改为 `export` |
| **opt-006b** | `src/pipeline.ts` | `stepFilter` 和 `stepStore` 各自用 `try/finally` 包裹 `openDb`→操作→`close`，确保异常时连接不泄漏 |
| **opt-007** | `src/pipeline.ts` | `stepPush` 移除 `publishDigest` 调用，改为直接调用 `pushToFeishu`（避免重复写入 `6-digest.md` 和 `6-records.json`） |

### 效果

- **DB 连接安全**: try/finally 确保连接在任何异常路径下被关闭
- **消除重复 IO**: stepPush 不再写文件（文件已由 stepDigest 写入）
- **代码一致**: stepPush 和 stepCombinedPush 现在都直接调用 `pushToFeishu`

---

## 验证结果

| 验证项 | 结果 |
|--------|:---:|
| TypeScript 编译（源码） | ✅ 0 错误 |
| TypeScript 编译（整体） | ⚠️ 2 错误在 `tests/workflow.integration.test.ts`（**预存问题**：`keywords`/`openalex_queries` 字段不存在于当前类型） |
| 现有单元测试（4 个） | ✅ 全部通过 |
| Dry-run collect 步骤 | ✅ 167 篇论文采集成功（Nature RSS: 8 + OpenAlex: 159） |
| Dry-run filter 步骤 | ✅ DB 查重正常（跳过 33 篇已知），LLM 批量筛选正常执行 |

---

## 未涉及的文件

以下文件未经修改，保持原样：

- `src/llm.ts` — 无变更
- `src/digest.ts` — 无变更
- `src/publish.ts` — 无变更（`publishDigest` 保留供 `runWorkflow` 兼容）
- `src/cli.ts` — 无变更
- `src/scheduler.ts` / `src/command.ts` / `src/logger.ts` — 无变更
