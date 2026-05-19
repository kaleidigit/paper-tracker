# CLAUDE.md

## 核心原则

1. **JSON 是核心产品**，Markdown/飞书文档只是展示层。所有数据处理以 `Paper[]` 为中心。
2. **`src/` 下所有函数不允许文件 IO** —— 不写文件、不读文件、不调 shell。文件读写统一在 `pipeline.ts` 中。
3. **`publish.ts` 直接调用 lark-cli**（`runCommand`），不走 shell 模板字符串。
4. **每增加一个领域，只需新增一个 profile 目录**，无需修改任何代码。
5. **不生成 `summary_zh` / `novelty_points` / `main_content`** —— 避免幻觉和高 token 消耗。
6. **Profile 隔离** —— 配置在 `profiles/{name}/` 下，通过 `--profile` 参数选择，fallback 到 `top-journal-env-energy`。
7. **测试必须通过** `npm test` 和 `npm run build`。

## 架构图

```
Shell Scripts (scripts/)
│
├─ run.sh ──→ 串行调用 pipeline steps（collect→filter→enrich→store→digest→push），支持 --dry-run
└─ auto-push.sh ──→ cron 入口（周一：顶刊日报 + 合并周刊；周二至五：仅顶刊日报）

src/cli.ts
  │
  └── pipeline.ts (IO 编排层，所有文件读写在此)
        │
        ├── modules.ts (纯能力：采集 + LLM 增强)
        │     │
        │     ├── fetchPapers() ─→ NatureParser + OpenAlexParser
        │     ├── enrichPapers() ─→ translatePaperFields + classifyPaper
        │     ├── loadTaxonomy()
        │     └── (旧) runWorkflow() ← 兼容 legacy run-once 模式
        │
        ├── llm.ts (LLM 客户端：chatJson / llmFilter / translatePaperFields / classifyPaper)
        │
        ├── parsers/
        │     ├── nature-parser.ts (RSS + JSON-LD)
        │     ├── openalex-parser.ts (OpenAlex API)
        │     └── article-parser.ts (通用文章页面)
        │
        ├── digest.ts (纯能力：buildMarkdown / buildWeeklyMarkdown / buildRecords)
        │
        ├── publish.ts (纯能力：publishDigest / pushToFeishu → lark-cli)
        │
        └── db.ts (纯能力：upsertPapers / getWeeklyPapers → SQLite)

data/{profile}/
  ├── papers.db              ← SQLite 数据库（所有论文汇总，dedup_key 去重）
  ├── {YYYY-MM-DD}/
  │     ├── 1-raw-fetched.json   ← collect 输出（采集 + 过滤 + 去重）
  │     ├── 3-llm-filtered.json  ← filter 输出（透传，当前 collect 已内置）
  │     ├── 5-enriched.json      ← enrich 输出（翻译 + 分类）
  │     ├── 6-digest.md          ← digest 输出（Markdown 日刊）
  │     ├── 6-records.json       ← digest 输出（扁平化记录）
  │     └── 6-papers.json        ← digest 输出（完整 Paper[]）
  └── weekly-{start}~{end}/
        ├── 6-digest.md          ← weekly 输出（按期刊分组的周刊）
        ├── 6-records.json
        └── 6-papers.json
```

## 模块职责表

| 文件 | 职责 | IO |
|------|------|-----|
| `src/cli.ts` | CLI 入口，解析 `--profile` / `--step` / `--dry-run`，编排日志和状态 | 无业务逻辑 |
| `src/pipeline.ts` | **唯一的 IO 编排层**：每个 step 读写编号文件 | **文件读写** |
| `src/modules.ts` | 采集（fetchPapers）、增强（enrichPapers） | **无文件 IO** |
| `src/llm.ts` | LLM 调用：chatJson / llmFilter / translatePaperFields / classifyPaper | 无 |
| `src/digest.ts` | buildMarkdown / buildWeeklyMarkdown / buildRecords | 无 |
| `src/publish.ts` | publishDigest / pushToFeishu：lark-cli docs +create / im +messages-send | 无（subprocess 调用） |
| `src/db.ts` | SQLite 操作：upsertPapers / getPapersByDateRange / getWeeklyPapers | 数据库读写 |
| `src/config.ts` | 根配置加载 + profile 感知配置加载（deepMerge 合并 AI 配置）+ `applyDefaults()` | 无 |
| `src/types.ts` | 所有 TypeScript 类型 | 无 |
| `src/parsers/nature-parser.ts` | Nature 系列 RSS + JSON-LD 采集 | HTTP + HTML |
| `src/parsers/openalex-parser.ts` | OpenAlex API 采集 | HTTP |
| `src/parsers/article-parser.ts` | 通用文章页面解析器 | HTTP + HTML |

## Shell 脚本（项目根目录）

```
run.sh              ← 手动执行入口（串行 collect→filter→enrich→store→digest→push，支持 --dry-run）
auto-push.sh        ← cron 定时任务入口（周一：顶刊日报+经济学期刊入库+合并周刊；周二至五：仅顶刊日报）
deploy.sh           ← 安装依赖 + lark-cli 授权
```

单步执行：`npx tsx src/cli.ts --step <name> --profile <name>`

## Pipeline Steps

| Step | 输入 | 输出 | 说明 |
|------|------|------|------|
| `collect` | — | `1-raw-fetched.json` | 采集 + 关键词过滤 + LLM 过滤 + 去重 |
| `filter` | `1-raw-fetched.json` | `3-llm-filtered.json` | 透传（collect 已内置过滤） |
| `enrich` | `3-llm-filtered.json` | `5-enriched.json` | 翻译 + 分类 |
| `store` | `5-enriched.json` | `papers.db` | 写入 SQLite，按 dedup_key 去重 |
| `digest` | `5-enriched.json` | `6-digest.md` 等 | 生成日刊 Markdown |
| `push` | `6-digest.md` | 飞书 | 创建文档 + 发送群通知 |
| `weekly` | `papers.db` | `weekly-*/` | 读取单 profile 上周论文，按期刊生成周刊 |
| `weekly-all` | 所有 profile 的 `papers.db` | `weekly-*/` | 跨 profile 读取上周论文，合并去重，生成一份周刊 |

## 推流逻辑

```
周一（DAY_OF_WEEK=1）：
  top-journal-env-energy:  collect → ... → digest → push  日刊（DAYS=3, 周末积压顶刊）
  env-economics-journal:   collect → filter → enrich → store  （DAYS=7, 仅入库，不发日刊）
  → weekly-all            合并两个 profile 的 DB → 一份周刊推送

周二至周五：
  top-journal-env-energy:  collect → filter → enrich → store → digest → push  日刊（DAYS=1）
  env-economics-journal:   （不运行）
```

## Profile 配置

### 现有 Profile

| Profile 名称 | 用途 | 期刊来源 |
|---|---|---|
| `top-journal-env-energy` | 顶刊环境能源论文日报 | Nature 系列、Science、PNAS、Joule、EES 等综合顶刊 |
| `env-economics-journal` | 环境经济学期刊周刊（仅周一采集入库，不发日刊） | AER、QJE、JPE、JEEM、JAERE、Ecological Economics 等经济学期刊 |

## 项目配置层级

```
config.json                ← 根配置：全局 AI 模型配置 + profiles 列表
.env                       ← 密钥（SILICONFLOW_API_KEY 等），不入 git
profiles/{name}/
  config.json              ← 领域配置（app, pipeline, sources, feishu, ai.prompts）
  journals.json            ← 期刊列表（每个期刊的 publisher_strategy 决定用哪个 parser）
  classification.json      ← 分类树（domains → subdomains → keywords）
```

**AI 配置合并规则**：根 `config.json` 提供全局默认值（model、base_url、temperature 等），profile 里的 `ai` 只保留各自独有的覆盖项（prompts、filter 差异等），加载时自动深度合并。

**Profile 列表**：SH 脚本（`run.sh`、`auto-push.sh`）从根 `config.json` 的 `profiles` 数组读取，新增 profile 只需编辑 `config.json`。

fallback 逻辑：如果 profile 目录下没有对应文件，回退到 `profiles/top-journal-env-energy/`。

## 扩展到新领域

只需三步：

1. **创建 profile 目录**：
   ```bash
   mkdir -p profiles/new-domain
   cp profiles/top-journal-env-energy/*.json profiles/new-domain/
   ```

2. **修改配置**：
   - `config.json`（根目录）→ 在 `profiles` 数组中添加新 profile 名
   - `profiles/new-domain/config.json` → 修改 `ai.prompts`（筛选/翻译/分类 prompt）
   - `profiles/new-domain/journals.json` → 修改期刊列表
   - `profiles/new-domain/classification.json` → 修改分类树
   - `profiles/new-domain/config.json` 中 `feishu.notify_chat_id` → 修改飞书群 ID

3. **运行**：
   ```bash
   ./run.sh --profile new-domain
   ```

## 关键配置字段

### 时间窗口（不随意修改，会导致重复推送）

```jsonc
"pipeline.paper_window": {
  "mode": "since_yesterday_time",
  "hour": 8,
  "minute": 0
}
```

### LLM（配置在根 `config.json`，profile 只覆盖差异项）

```jsonc
"ai.model": "deepseek-ai/DeepSeek-V4-Flash"  // 全局模型（根 config.json）
"ai.filter.max_checks_per_run": 300           // LLM 过滤预算上限（根 config.json）
"ai.filter.min_confidence": 0.5               // 过滤最低置信度（根 config.json）
"ai.enrich.concurrency": 3                    // 翻译分类并发数（根 config.json）
"ai.translation.enabled": true                // 是否翻译（根 config.json）
```

### 飞书（publish.ts 直接调用，不走 shell 命令模板）

```jsonc
"feishu.doc_enabled": true           // 创建飞书文档
"feishu.notify_chat_id": "oc_xxx"    // 群通知 chat_id
"feishu.alert_chat_id": "oc_xxx"     // 告警 chat_id
```

## 命令速查

```bash
# 完整管道（串行 6 步，运行 config.json 中所有 profile）
./run.sh
./run.sh --dry-run
./run.sh --profile env-economics-journal
./run.sh --profile env-economics-journal --dry-run

# 自动推送（cron 入口）
./auto-push.sh
./auto-push.sh --dry-run

# 单步（每步可独立运行，从上一步读取文件）
npx tsx src/cli.ts --step collect --profile top-journal-env-energy
npx tsx src/cli.ts --step filter  --profile top-journal-env-energy
npx tsx src/cli.ts --step enrich  --profile top-journal-env-energy
npx tsx src/cli.ts --step store   --profile top-journal-env-energy
npx tsx src/cli.ts --step digest  --profile top-journal-env-energy
npx tsx src/cli.ts --step push    --profile top-journal-env-energy
npx tsx src/cli.ts --step weekly  --profile top-journal-env-energy
npx tsx src/cli.ts --step weekly-all --profile top-journal-env-energy

npx tsx src/cli.ts --step collect --profile env-economics-journal
npx tsx src/cli.ts --step enrich  --profile env-economics-journal
npx tsx src/cli.ts --step store   --profile env-economics-journal

# 测试
npm test
npm run build
```

## lark-cli 使用方式

`publish.ts` 中直接调用 subprocess：

```typescript
// pushToFeishu() 创建飞书文档
await runCommand("lark-cli", [
  "docs", "+create",
  "--as", "bot",
  "--title", docTitle,
  "--markdown", markdownContent
], config.runtime.command_timeout_ms);

// pushToFeishu() 发送群通知
await runCommand("lark-cli", [
  "im", "+messages-send",
  "--as", "bot",
  "--chat-id", chatId,
  "--text", notifyText
], config.runtime.command_timeout_ms);
```

配置文件（根 `config.json` + `profiles/{name}/config.json`）中**不需要**存储 shell 命令模板（如 `doc_publish_cmd` / `notify_cmd`），直接用 `--profile` 指定 profile 目录即可。

## 数据库

`data/{profile}/papers.db` — SQLite（WAL 模式）：

- **去重键**：`dedup_key` = DOI > URL > journal::title，与 `itemKey()` 逻辑一致
- **唯一索引**：`UNIQUE(profile, dedup_key)`
- **查询索引**：`(profile, published_date)`、`(profile, journal_name)`
- **入库时机**：每天 enrich 后自动写入（stepStore）
- **周刊读取**：`stepWeekly` 调用 `getWeeklyPapers()` 查询上周一至周日；`stepWeeklyAll` 跨所有 profile 聚合后合并去重

```bash
# 直接查询数据库
sqlite3 data/top-journal-env-energy/papers.db "SELECT COUNT(*) FROM papers;"
sqlite3 data/top-journal-env-energy/papers.db "SELECT journal_name, COUNT(*) FROM papers GROUP BY journal_name ORDER BY 2 DESC;"
```

## 数据追溯（质检）

每个 step 的输入输出文件都有编号，可随时查看：

```bash
# 查看采集结果
cat data/top-journal-env-energy/2026-05-09/1-raw-fetched.json | jq 'length'

# 查看翻译+分类结果
cat data/top-journal-env-energy/2026-05-09/5-enriched.json | jq '.[0] | {title_zh, abstract_zh, classification}'

# 查看最终 Markdown
cat data/top-journal-env-energy/2026-05-09/6-digest.md | head -30

# 查看周刊
cat data/top-journal-env-energy/weekly-2026-05-11~2026-05-17/6-digest.md | head -30

# 查看数据库统计
sqlite3 data/top-journal-env-energy/papers.db "SELECT COUNT(*) FROM papers;"
sqlite3 data/top-journal-env-energy/papers.db "SELECT journal_name, COUNT(*) as cnt FROM papers GROUP BY journal_name ORDER BY cnt DESC;"

# 质检：对比输入输出数量
wc -l data/top-journal-env-energy/2026-05-09/*.json
```
