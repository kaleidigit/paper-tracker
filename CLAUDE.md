# CLAUDE.md
> 最后更新：2026-06-07，移除 lark-cli 依赖，新增 RSS Feed + Resend 邮件推送

## 核心原则

1. **JSON 是核心产品**，RSS/HTML/邮件只是展示层。所有数据处理以 `Paper[]` 为中心。
2. **`src/` 下所有函数不允许文件 IO** —— 不写文件、不读文件、不调 shell。文件读写统一在 `pipeline.ts` 中。
3. **每增加一个领域，只需新增一个 profile 目录**，无需修改任何代码。
4. **不生成 `summary_zh` / `novelty_points` / `main_content`** —— 避免幻觉和高 token 消耗。
5. **Profile 隔离** —— 配置在 `profiles/{name}/` 下，通过 `--profile` 参数选择，fallback 到 `top`。
6. **测试必须通过** `npm test` 和 `npm run build`。
7. **结构化日志统一使用 `logEvent()`**（`src/logger.ts`），不直接写 `process.stdout.write(JSON.stringify(...))`。
8. **重试统一使用 `retry()`**（`src/utils.ts`），指数退避 + 25% 抖动。
9. **配置文件有 Zod schema 验证**，加载时即失败，友好错误信息。
10. **昂贵操作延迟到筛选后** —— 文章页抓取、LLM 翻译等高开销操作在 filter 之后执行，只处理通过筛选的论文。
11. **采集策略由配置驱动** —— `journals.json` 的 `publisher_strategy` 字段决定采集方式（`nature-rss` / `openalex`），代码不硬编码策略映射。
12. **管道执行单一入口** —— `auto-push.sh` 委托 `run.sh`，不重复实现管道逻辑；所有 profile 串行执行后统一合并 RSS。

## 架构图

```
Shell Scripts:
  run.sh ──→ 串行 pipeline steps（collect→filter→enrich→store→digest→rss→notify），--dry-run
  auto-push.sh ──→ cron 入口（周一 DAYS=3，委托 run.sh 执行）

src/cli.ts
  │
  └── pipeline.ts (IO 编排层，所有文件读写在此)
        │
        ├── modules.ts (纯能力：采集 + LLM 增强)
        │     │
        │     ├── collectRawPapers() ─→ NatureParser + OpenAlexParser
        │     ├── filterPapers() ─→ llmFilterAndTranslateBatch
        │     ├── enrichPapers() ─→ scrapeRSS + translate + classifyBatch
        │     └── loadTaxonomy() ─→ Zod 校验 classification.json
        │
        ├── llm.ts (LLM 客户端)
        │
        ├── parsers/
        │     ├── shared.ts ─── 共享：buildPaper + loadJournals（Zod 校验）
        │     ├── nature-parser.ts (RSS + JSON-LD)
        │     ├── openalex-parser.ts (OpenAlex API)
        │     └── article-parser.ts (通用文章页面)
        │
        ├── digest.ts (纯能力：buildMarkdown / buildCombinedMarkdown / buildRecords / renderPaperCard)
        │
        ├── rss.ts (纯能力：buildRssXml → RSS 2.0 XML，content:encoded 内嵌 HTML)
        │
        ├── publishers/
        │     ├── render-html.ts (纯能力：paperToHtml / digestToHtmlPage，marked 转换)
        │     └── resend.ts (HTTP client：sendResendEmail → Resend API)
        │
        ├── db.ts (openDb / getKnownDedupKeys / upsertPapers → 调用者管理连接)
        │
        ├── config.ts (根配置加载 + profile deepMerge + applyDefaults；Zod 校验 config.json)
        │
        ├── logger.ts (logEvent / Logger 类)
        │
        └── utils.ts (retry / normalizeText / dedupeStrings / itemKey / 等)

data/{profile}/
  ├── papers.db              ← SQLite（WAL 模式，dedup_key 去重）
  ├── {YYYY-MM-DD}/
  │     ├── 1-raw-fetched.json
  │     ├── 3-llm-filtered.json
  │     ├── 5-enriched.json
  │     ├── 6-digest.md
  │     ├── 6-records.json

public/                       ← GitHub Pages 部署（gitignored）
  ├── feeds/combined.xml      ← 合并 RSS Feed
  ├── feeds/{profile}.xml     ← 单领域 RSS Feed
  └── index.html              ← HTML 日报浏览页
```

## 模块职责表

| 文件 | 职责 | IO |
|------|------|-----|
| `src/cli.ts` | CLI 入口，`--profile`/`--step`/`--dry-run` | 无 |
| `src/pipeline.ts` | **唯一 IO 编排层**：stepFilter/stepStore 管理 DB 连接生命周期（try/finally） | 文件 + DB |
| `src/modules.ts` | 采集、筛选、增强（含延迟抓取）；重试统一用 `utils.retry()` | 无 |
| `src/llm.ts` | LLM 调用；日志用 `logEvent()` | 无 |
| `src/digest.ts` | buildMarkdown / buildCombinedMarkdown / buildRecords / renderPaperCard | 无 |
| `src/rss.ts` | buildRssXml → RSS 2.0 XML，内嵌 HTML | 无 |
| `src/publishers/render-html.ts` | paperToHtml / digestToHtmlPage（marked 转换） | 无 |
| `src/publishers/resend.ts` | sendResendEmail → Resend API（fetch） | HTTP |
| `src/db.ts` | openDb(exported) / getKnownDedupKeys / upsertPapers；调用者管理关闭 | DB |
| `src/config.ts` | 根配置 + profile deepMerge + applyDefaults；Zod 校验 config.json | 无 |
| `src/types.ts` | 所有 TypeScript 类型 | 无 |
| `src/utils.ts` | retry / normalizeText / dedupeStrings / normalizePublicationType / itemKey | 无 |
| `src/logger.ts` | logEvent() 无状态 helper + Logger 类（按日分文件） | 文件追加 |
| `src/parsers/shared.ts` | buildPaper + loadJournals（Zod 校验 journals.json） | 无 |
| `src/parsers/nature-parser.ts` | Nature RSS + JSON-LD 采集 | HTTP + HTML |
| `src/parsers/openalex-parser.ts` | OpenAlex API 采集 | HTTP |
| `src/parsers/article-parser.ts` | 通用文章页面解析器 | HTTP + HTML |

## Shell 脚本

```
run.sh              ← 手动入口（串行 8 步 + combined-rss，--dry-run）
auto-push.sh        ← cron 入口（周一 DAYS=3，委托 run.sh）
```

单步执行：`npx tsx src/cli.ts --step <name> --profile <name>`

## Pipeline Steps

| Step | 输入 | 输出 | 说明 |
|------|------|------|------|
| `collect` | — | `1-raw-fetched.json` | 全量采集 + 去重 |
| `filter` | `1-raw-fetched.json` | `3-llm-filtered.json` | LLM 批量筛选+翻译（`batch_size` 篇/批，并发 3 批）；DB 查重跳过已知论文 |
| `enrich` | `3-llm-filtered.json` | `5-enriched.json` | Phase 0: RSS 文章页抓取（延迟到筛选后）→ Phase 1: 翻译/归一化（并发 5）→ Phase 2: 批量分类 |
| `store` | `5-enriched.json` | `papers.db` | SQLite 写入（try/finally 确保连接关闭） |
| `digest` | `5-enriched.json` | `6-digest.md` + `6-records.json` | 日刊 Markdown + 扁平记录 |
| `rss` | `5-enriched.json` | `public/feeds/{profile}.xml` + `public/index.html` | RSS 2.0 XML + HTML 页面（含侧边目录 TOC） |
| `combined-rss` | 全 profile 的 `5-enriched.json` | `public/feeds/combined.xml` + `public/index.html` | 跨 profile 合并 RSS |
| `combined-notify` | 全 profile 的 `5-enriched.json` | — | SMTP 发送合并 HTML 日报（一封邮件） |

## 推送方案

**RSS Feed（主力）+ SMTP 邮件（辅助）**

- RSS 2.0 + `<content:encoded>` HTML，托管 GitHub Pages
- HTML 浏览页左侧固定侧边目录，点击跳转到论文，移动端自动隐藏
- 邮件发送合并 HTML 日报（所有 profile 一封邮件）
- QQ 邮箱绑定微信后有新邮件提醒，间接实现微信通知
- GitHub Actions 定时运行（工作日 08:37 CST），支持手动清缓存重跑

```bash
# 本地生成 RSS
npx tsx src/cli.ts --step rss --profile top

# 本地发送邮件
npx tsx src/cli.ts --step notify --profile top
```

## 采集策略

**collect 步骤全量拉回，不做筛选。**

| 来源 | 策略 | 覆盖 |
|------|------|------|
| Nature RSS | `publisher_strategy: "nature-rss"` 的期刊，RSS feed 全量拉取 + 时间窗口过滤 | Nature 及其子刊 + Science/SciAdv |
| OpenAlex ISSN | `publisher_strategy: "openalex"` 的期刊，ISSN 过滤 + 30 天宽窗口 + 分页 | PNAS/Joule/EES 等 |
| 合并去重 | Nature RSS + OpenAlex 合并，`itemKey()` 去重 | 最终写入 `1-raw-fetched.json` |

新增期刊只需在 `journals.json` 添加一条记录（含 `publisher_strategy` 字段指定采集策略），无需改代码。

## 筛选策略

全量送 LLM 筛选，不做关键词预筛。`llmFilterAndTranslateBatch()` 批量处理（默认 `batch_size: 3`）：
- 批处理失败 → 逐篇 `retry()` 回退（2 次，10s 间隔）
- LLM 遗漏 → 回退到逐篇处理
- `filter.enabled: false` → 全部直通

## 推送逻辑

```
周一：DAYS=3（覆盖周末积压）
周二至五：DAYS=1
周末：跳过
各 profile 串行执行（collect→filter→enrich→store→digest→rss），最后 combined-rss + combined-notify 合并发送。
```

## Profile 配置

| Profile | 用途 | 期刊数 | 来源 |
|---------|------|:---:|------|
| `top` | 环境能源期刊 | 36 | Nature 系列 + Science/SciAdv/PNAS/Joule 等 |
| `econ` | 环境经济学 | 35 | SUFE Tier 1-2 + 环境经济专刊 |
| `law` | 法学 | 8 | T14 flagship 法律评论 |

### 配置层级

```
config.json                ← 根配置：profiles 列表 + 全局 AI 默认值 + RSS/Email 配置
.env                       ← 密钥（OPENAI_COMPATIBLE_API_KEY, RESEND_API_KEY, EMAIL_RECIPIENTS）
profiles/{name}/
  config.json              ← 领域配置
  journals.json            ← 期刊列表
  classification.json      ← 分类树
```

AI 配置合并：根 `config.json` 提供默认值，profile 只覆盖差异项，加载时 `deepMerge`。

## 关键配置字段

### 时间窗口

`strictWindowStartAt()` 计算严格窗口起点。`graceWindowStartAt()` 往前推 `grace_days` 天（默认 3），补偿 OpenAlex 索引延迟。

### LLM

```jsonc
"ai.base_url": "https://api.deepseek.com"
"ai.model": "deepseek-v4-flash"
"ai.api_key_env": "OPENAI_COMPATIBLE_API_KEY"
"ai.filter.min_confidence": 0.5
"ai.filter.batch_size": 3
"ai.enrich.concurrency": 5
```

### RSS & Email

```jsonc
"rss.site_url": "https://<user>.github.io/paper-tracker"
"rss.language": "zh-CN"
"email.provider": "resend"
"email.api_key_env": "RESEND_API_KEY"
"email.to_env": "EMAIL_RECIPIENTS"
```

### GitHub Actions

```jsonc
// .github/workflows/daily.yml
// cron: '37 0 * * 1-5'  → 工作日 08:37 CST
// deploys public/ to gh-pages branch via peaceiris/actions-gh-pages@v4
```

## 重试机制

所有重试统一使用 `src/utils.ts` 的 `retry()`：

```typescript
retry(fn, { maxAttempts: 3, baseDelayMs: 5000, onRetry: (attempt, delay, err) => logEvent(...) })
```

- 退避：指数 + 25% 抖动
- filter 逐篇：2 次，10s 间隔
- enrich 翻译/分类：3 次，5s 指数退避，失败用 FALLBACK_CLASSIFICATION
- SMTP 邮件（combined-notify）：3 次，5s 指数退避

## 配置校验

所有 JSON 配置文件加载时通过 Zod schema 验证：
- `config.json` → `RootConfigSchema`
- `journals.json` → `JournalEntrySchema`（name/源群必填，issn/rss_feeds/sort_order 可选）
- `classification.json` → `ClassificationSchema`（groups/domains，含 subtopics.keywords）

## 日志

`src/logger.ts` 两条路径：
- `logEvent(level, event, data?)` — 无状态，输出 stdout（ERROR→stderr），所有模块通用
- `Logger` 类 — 按日分文件 + stdout，仅在 `cli.ts` 用于 run 级别事件

## 数据库

`data/{profile}/papers.db` — SQLite（WAL 模式）：
- 去重键：`dedup_key` = DOI > URL > journal::title
- 唯一索引：`UNIQUE(profile, dedup_key)`
- `openDb()` 已 exported，调用者用 try/finally 管理关闭

```bash
sqlite3 data/top/papers.db "SELECT COUNT(*) FROM papers;"
```

## 命令速查

```bash
# 完整管道（默认所有 profile）
./run.sh
./run.sh --dry-run
./run.sh --profile econ
./run.sh --profile top --days 2 --dry-run

# 自动推送
./auto-push.sh
./auto-push.sh --dry-run

# 单步（省略 --profile 则跑所有 profile）
npx tsx src/cli.ts --step collect
npx tsx src/cli.ts --step rss
npx tsx src/cli.ts --step combined-notify
npx tsx src/cli.ts --step digest --profile top   # 指定单个

# 测试
npm test        # vitest run（6 文件 56 用例）
npm run build   # tsc --noEmit（零错误）
```

## 安全设计

密钥通过 GitHub Secrets → `.env`（gitignored）→ `process.env` 链路注入，从未进入仓库。

| 数据 | 存储位置 | 措施 |
|------|------|------|
| LLM API key | GitHub Secret → .env | 从未进入仓库 |
| Resend API key | GitHub Secret → .env | 从未进入仓库 |
| 邮件收件人 | GitHub Secret `EMAIL_RECIPIENTS` | env var 注入，不写死地址 |
| public/ 输出 | GitHub Pages（公开） | 仅论文元数据（公开学术信息） |

## 优化历史

| 批次 | 日期 | 内容 |
|------|------|------|
| opt-001~003 | 2026-05-23 | 消除重复函数（normalizeText 4→1 等），提取 shared.ts，统一 retry() |
| opt-006~007 | 2026-05-23 | DB 连接 try/finally，stepPush 消除重复文件 IO |
| opt-008 | 2026-05-24 | Zod 配置校验（3 种配置文件） |
| opt-005 | 2026-05-24 | 结构化日志统一为 logEvent()（27 处替换） |
| opt-004 | 2026-05-24 | 测试 5→56 用例（utils 20 + digest 9 + db 7，零错误） |
| enrich-batch | 2026-05-24 | 分类逐篇→批量+并发，enrich 214s→107s（2x 加速） |
| defer-scrape | 2026-05-28 | 文章页抓取从 collect 延迟到 enrich（141→~28 页，省 ~5min） |
| pipeline-simplify | 2026-05-28 | 删除 workflow.ts/fetchPapers/publishDigest（-270 行），auto-push 委托 run.sh |
| feishu-perm | 2026-05-28 | 文档创建后自动设置 tenant_editable 权限 |
| feishu-perm-fix | 2026-05-29 | 修复权限命令缺少 `--as bot` 导致 scope 错误 |
| remove-lark | 2026-06-07 | 移除 lark-cli 全部依赖（publish.ts / deploy.sh / feishu 配置），新增 RSS + Resend 邮件 |

## 数据追溯

```bash
# 采集结果
cat data/top/YYYY-MM-DD/1-raw-fetched.json | jq 'length'

# 翻译+分类
cat data/top/YYYY-MM-DD/5-enriched.json | jq '.[0] | {title_zh, abstract_zh, classification}'

# Markdown
cat data/top/YYYY-MM-DD/6-digest.md | head -30

# RSS Feed
cat public/feeds/combined.xml | head -30

# 数据库
sqlite3 data/top/papers.db "SELECT journal_name, COUNT(*) as cnt FROM papers GROUP BY journal_name ORDER BY cnt DESC;"
```
