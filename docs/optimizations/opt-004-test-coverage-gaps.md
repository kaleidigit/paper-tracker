# OPT-004: 测试覆盖缺口

## 当前状态

```
tests/
  workflow.integration.test.ts   — 2 tests (happy path + empty source)
  command.test.ts                — 1 test (basic spawn)
  scheduler.test.ts              — 2 tests (shouldRunNow clock logic)
```

3 个测试文件，5 个测试用例，覆盖约 100 行逻辑。项目总源码约 2,000+ 行（不含注释）。

| 模块 | 行数 | 测试 | 风险 |
|------|:---:|:---:|------|
| `src/parsers/openalex-parser.ts` | ~170 | 0 | OpenAlex API 分页、ISSN 映射、日期过滤 |
| `src/parsers/nature-parser.ts` | ~155 | 0 | RSS 解析、XML 命名空间、文章页面 HTML 解析 |
| `src/parsers/article-parser.ts` | ~210 | 0 | JSON-LD 提取、HTML meta 标签回退 |
| `src/llm.ts` | ~350 | 0 | 模板渲染、JSON 解析、批处理、翻译、分类 |
| `src/db.ts` | ~130 | 0 | SQLite 写入、ON CONFLICT、批量去重 |
| `src/digest.ts` | ~175 | 0 | Markdown 渲染、作者角标、合并摘要 |
| `src/config.ts` | ~210 | 0 | Profile 加载、deepMerge、applyDefaults |
| `src/utils.ts` | ~280 | 0 | HTML 实体解码、日期窗口、affiliation 提取 |
| `src/modules.ts` | ~285 | 0 | Filter 批处理/fallback、enrichOne 三大分支 |
| `src/publish.ts` | ~360 | 0 | lark-cli 调用、Markdown 分块、通知发送 |
| `src/pipeline.ts` | ~275 | 0 | 步骤编排、文件 IO、combined-push |
| `src/cli.ts` | ~180 | 0 | CLI 参数解析、daemon 模式、schedule 安装 |

## 缺口分析

### 高优先级（核心逻辑 + 高度可测）

1. **`src/utils.ts` — `parseDate`、`strictWindowStartAt`、`graceWindowStartAt`**
   - 纯计算，不涉网络/IO
   - 时区边界的 `strictWindowStartAt` 逻辑（周一 3 天 vs 正常 1 天）
   - `parseDate` 的 fallback 行为（无效日期 → 今天）

2. **`src/digest.ts`**
   - 纯函数：输入 Paper[] → Markdown 字符串
   - 可测：排序（sort_order → published_date）、角标渲染、分类显示

3. **`src/llm.ts` — `renderTemplate`、`parseJsonLenient`**
   - 纯函数，无网络依赖
   - `parseJsonLenient` 有多个解析路径（裸 JSON → code block → 正则提取）

4. **`src/config.ts` — `deepMerge`、`applyDefaults`、`loadProfileContext`**
   - `deepMerge` 是纯函数
   - `applyDefaults` 有大量边界行为（可选字段的默认值覆盖）

### 中优先级（有外部依赖但可 mock）

5. **`src/db.ts`**
   - SQLite 可以指向临时文件测试
   - 可测：`getKnownDedupKeys`、`upsertPapers`（INSERT vs ON CONFLICT UPDATE）

6. **`src/parsers/article-parser.ts` — `parseHtml`、`extractFromJsonLd`**
   - HTML 输入是字符串，可以存为 fixture 文件
   - 可测：JSON-LD 提取逻辑、HTML meta 回退

7. **`src/publish.ts` — `splitMarkdown`、`docTitleToXml`**
   - 纯函数，可直接测
   - `resolveChatIds` 去重逻辑

### 低优先级（重度 IO 依赖）

8. **`src/llm.ts` — `chatJson`、`llmFilterAndTranslate`**
   - 需要 mock HTTP，但可以 mock `fetch` 来测错误处理路径

9. **`src/pipeline.ts` — 各 step 函数**
   - 需要文件系统 setup，但可以指向临时目录

## 推荐顺序

1. 先补 `utils.ts` 和 `digest.ts`（纯函数，无依赖，2-3 小时工作量）
2. 再补 `config.ts`（deepMerge + applyDefaults，1-2 小时）
3. 再补 `db.ts`（临时 SQLite，1-2 小时）
4. 最后补 parser 和 LLM（需要 fixture 数据，2-4 小时）

## 相关文件

| 文件 | 优先级 |
|------|:---:|
| `src/utils.ts` — 日期/时间工具函数 | 高 |
| `src/digest.ts` — Markdown 渲染 | 高 |
| `src/llm.ts` — 模板/JSON 解析 | 高 |
| `src/config.ts` — deepMerge/defaults | 高 |
| `src/db.ts` — upsert/dedup | 中 |
| `src/parsers/article-parser.ts` — HTML 解析 | 中 |
| `src/publish.ts` — 工具函数 | 中 |
| `src/modules.ts` — filter/enrich 逻辑 | 低 |

## 状态

已实施（2026-05-24）

## 实现

- `tests/utils.test.ts`：20 个测试，覆盖 normalizeText/dedupeStrings/toArray/parseDate/parseDateTime/normalizePublicationType/shouldSkipLlmRescueByTitle/isPrimarilyChinese/decodeHtmlEntities/itemKey/formatDateInTz
- `tests/digest.test.ts`：9 个测试，覆盖 buildMarkdown/buildCombinedMarkdown/buildRecords/buildDigestTitle，含排序/角标渲染/分类显示/无 affil_map 回退
- `tests/db.test.ts`：7 个测试，覆盖 getKnownDedupKeys/upsertPapers，含空输入/去重/ON CONFLICT UPDATE
- 总测试：5 → 6 文件，5 → 56 个用例
