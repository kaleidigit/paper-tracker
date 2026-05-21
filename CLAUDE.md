# CLAUDE.md

## 核心原则

1. **JSON 是核心产品**，Markdown/飞书文档只是展示层。所有数据处理以 `Paper[]` 为中心。
2. **`src/` 下所有函数不允许文件 IO** —— 不写文件、不读文件、不调 shell。文件读写统一在 `pipeline.ts` 中。
3. **`publish.ts` 直接调用 lark-cli**（`runCommand`），不走 shell 模板字符串。
4. **每增加一个领域，只需新增一个 profile 目录**，无需修改任何代码。
5. **不生成 `summary_zh` / `novelty_points` / `main_content`** —— 避免幻觉和高 token 消耗。
6. **Profile 隔离** —— 配置在 `profiles/{name}/` 下，通过 `--profile` 参数选择，fallback 到 `top`。
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
        │     ├── collectRawPapers() ─→ NatureParser + OpenAlexParser（全量采集）
        │     ├── filterPapers() ─→ matchesKeywords + llmFilter（筛选）
        │     ├── fetchPapers() ─→ collectRawPapers + filterPapers（兼容 run-once）
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
  │     ├── 1-raw-fetched.json   ← collect 输出（全量采集 + 去重）
  │     ├── 3-llm-filtered.json  ← filter 输出（关键词 + LLM 筛选）
  │     ├── 5-enriched.json      ← enrich 输出（翻译 + 分类）
  │     ├── 6-digest.md          ← digest 输出（Markdown 日刊）
  │     ├── 6-records.json       ← digest 输出（扁平化记录）
  │     └── latest.json          ← push 输出（指向最新产物的指针）
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
auto-push.sh        ← cron 定时任务入口（周一：顶刊日报+经济+法学入库+周刊(仅经济+法学)；周二至五：仅顶刊日报）
deploy.sh           ← 安装依赖 + lark-cli 授权
```

单步执行：`npx tsx src/cli.ts --step <name> --profile <name>`

## Pipeline Steps

| Step | 输入 | 输出 | 说明 |
|------|------|------|------|
| `collect` | — | `1-raw-fetched.json` | 全量采集 + 去重 |
| `filter` | `1-raw-fetched.json` | `3-llm-filtered.json` | 关键词预筛 + LLM 精筛 |
| `enrich` | `3-llm-filtered.json` | `5-enriched.json` | 翻译 + 分类 |
| `store` | `5-enriched.json` | `papers.db` | 写入 SQLite，按 dedup_key 去重 |
| `digest` | `5-enriched.json` | `6-digest.md` + `6-records.json` | 生成日刊 Markdown + 扁平记录 |
| `push` | `6-digest.md` + `5-enriched.json` | 飞书 | 创建文档 + 发送群通知 |
| `weekly` | `papers.db` | `weekly-*/` | 读取单 profile 上周论文，按期刊生成周刊 |
| `weekly-all` | 所有 profile 的 `papers.db` | `weekly-*/` | 跨 profile 读取上周论文，合并去重，生成一份周刊 |

## 采集策略（全量采集，不做筛选）

**collect 步骤只做一件事：把目标期刊在时间窗口内的所有论文全部拉回来。不做任何筛选。**

三种采集源：

| 来源 | 策略 | 覆盖范围 |
|------|------|----------|
| Nature RSS | 逐个 RSS feed 全量拉取，按 `published_date` 过滤时间窗口 | Nature 及其 19 种子刊（含 Nature Reviews 系列、Nature Human Behaviour、Nature Plants 等） |
| OpenAlex ISSN | 按 ISSN 过滤 + 时间窗口，per-page=200 分页拉取全量，**不使用 `search` 参数** | Science、Science Advances、PNAS、Joule、One Earth、EES、National Science Review、中国社会科学；及 32 种经济学期刊、8 种法学期刊 |
| 合并去重 | Nature RSS + OpenAlex 合并，`itemKey()` 去重，`published_date` 倒序 | 最终写入 `1-raw-fetched.json` |

**关键约束：**
- `openalex_queries` 配置项**不再使用**。OpenAlex 采集改为纯 ISSN 过滤，保证不漏论文。空数组 `[]` 即可。
- 新增期刊只需在 `journals.json` 添加一条记录，无需改代码。
- Nature 期刊使用 `publisher_strategy: "nature-rss"`，非 Nature 期刊使用 `"openalex"`。

## 筛选策略（宽进严出，两阶段）

```
论文（来自 1-raw-fetched.json）
  │
  ├─→ 黑名单排除词命中？ ──→ 拒绝（词组精确命中，如 catalyst synthesis）
  │
  ├─→ 白名单包含词未命中？ ──→ 拒绝（单词/短词组，如 climate, energy）
  │
  └─→ 白名单命中 ──→ LLM 审查 ──→ keep? ──→ 通过 → 写入 3-llm-filtered.json
                                         └─→ 拒绝
```

**关键词设计原则：白名单用短词广撒网，黑名单用词组精准排除。**

| 名单 | 配置键 | 粒度 | 示例 | 目的 |
|------|--------|------|------|------|
| 白名单 | `sources.keywords` | 单词/短词组 | `climate`, `energy`, `carbon`, `biodiversity`, `solar`, `sea level`, `land use` | 尽可能网住相关论文，不遗漏。宁可多放，不可漏网 |
| 黑名单 | `sources.exclude_keywords` | 多词短语 | `battery cycling performance`, `catalyst synthesis`, `clinical trial`, `molecular dynamics simulation`, `DFT calculation` | 精准排除纯材料科学/临床医学/计算化学论文。只用长词组，避免误伤 |

**筛选策略分两种模式，按 profile 特性选择：**

| 模式 | 适用 Profile | 机制 | 配置 |
|------|-------------|------|------|
| **关键词 + LLM 双阶段** | `top`（发文量大，~28 刊） | 白名单关键词预筛 → 黑名单排除 → LLM 精筛 | `keywords: [...]`, `exclude_keywords: [...]` |
| **纯 LLM 直通** | `econ`、`law`（发文量小，合计 ~40 刊） | 采集全量直接送 LLM，由 LLM 独立判断相关性 | `keywords: []`, `exclude_keywords: []` |

**纯 LLM 直通原理**：`matchesKeywords()` 在 `utils.ts:218` 检查白名单，若白名单为空则直接返回 `true`，所有论文跳过关键词关直通 LLM。这是有意设计，不是遗漏。

**LLM 筛选是真正的质量关。** 关键词放行后，由 `filterPapers()` (in `modules.ts`) 调用 LLM 根据核心研究问题判断是否保留（`llmFilter` in `llm.ts`）。LLM 预算由 `ai.filter.max_checks_per_run` 控制（默认 300），预算耗尽后白名单通过的论文不经 LLM 直接放行。

**LLM 筛选原则**（prompt 配置在 `ai.prompts.filter_system`）：
- 接受：能源/气候/环境/可持续发展/生物多样性/生态/海平面/土地利用/农业/贫困环境关联
- 拒绝：纯材料器件（电极合成、钙钛矿制备）、纯化学计算（DFT、分子动力学）、临床生物医学（临床试验、药物递送）、纯工程性能优化（无系统视角）
- 按核心研究问题判断，不按表面术语判断
- 对于 econ/law profile：只要与环境、能源、可持续发展弱相关即放行

## 推流逻辑

```
周一（DAY_OF_WEEK=1）：
  top:    collect → filter → enrich → store → digest → push  日刊（DAYS=3, 周末积压顶刊）
  econ:   collect → filter → enrich → store  （DAYS=7, 仅入库，不发日刊）
  law:    collect → filter → enrich → store  （DAYS=7, 仅入库，不发日刊）
  → weekly-all  排除 top（exclude_from_weekly），仅合并 econ + law → 一份周刊推送

周二至周五：
  top:    collect → filter → enrich → store → digest → push  日刊（DAYS=1）
  econ:   （不运行）
  law:    （不运行）
```

**周刊排除设计**：`top` profile 的 `feishu.exclude_from_weekly: true` 使 `stepWeeklyAll` 自动跳过。经济和法学推送上周精选，避免顶刊信息重复轰炸。

## Profile 配置

### 现有 Profile

| Profile | 用途 | 推送频率 | 筛选模式 | 期刊数 | 来源 |
|---------|------|---------|---------|--------|------|
| `top` | 顶刊环境能源论文日报 | 每日推送 | 关键词+LLM 双阶段 | 28 | Nature 系列 20 种 + Science/PNAS/Joule/One Earth/EES/NSR/中国社会科学 |
| `econ` | 环境经济学期刊追踪 | 仅周一入库，周刊合并推送 | 纯 LLM 直通 | 32 | SUFE 经济学 Top Tier (5) + First Tier (20) + 环境经济专刊 (7) |
| `law` | 法学环境能源论文追踪 | 仅周一入库，周刊合并推送 | 纯 LLM 直通 | 8 | 美国 T14  flagship 法律评论 + 国际法/法经济学期刊 |

**econ 期刊来源**：以上海财经大学国际期刊分类目录（2024年修订）经济学 Top Tier + First Tier 为基础，补充环境经济学专刊（JEEM、JAERE、Ecological Economics、Environmental and Resource Economics、Resource and Energy Economics、The Energy Journal、AJAE）。

## 项目配置层级

```
config.json                ← 根配置：全局 AI 模型配置 + profiles 列表
.env                       ← 密钥（OPENAI_COMPATIBLE_API_KEY 等），不入 git
profiles/{name}/
  config.json              ← 领域配置（app, pipeline, sources, feishu, ai.prompts）
  journals.json            ← 期刊列表（每个期刊的 publisher_strategy 决定用哪个 parser）
  classification.json      ← 分类树（domains → subdomains → keywords）
```

**AI 配置合并规则**：根 `config.json` 提供全局默认值（model、base_url、temperature 等），profile 里的 `ai` 只保留各自独有的覆盖项（prompts、filter 差异等），加载时自动深度合并。

**Profile 列表**：SH 脚本（`run.sh`、`auto-push.sh`）从根 `config.json` 的 `profiles` 数组读取，新增 profile 只需编辑 `config.json`。

fallback 逻辑：如果 profile 目录下没有对应文件，回退到 `profiles/top/`。

## 扩展到新领域

只需三步：

1. **创建 profile 目录**：
   ```bash
   mkdir -p profiles/new-domain
   cp profiles/top/*.json profiles/new-domain/
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

DeepSeek 官方 API（`api.deepseek.com`），`OPENAI_COMPATIBLE_API_KEY` 统一密钥。

```jsonc
"ai.base_url": "https://api.deepseek.com"      // DeepSeek 官方 API
"ai.model": "deepseek-v4-flash"                // 全局模型（根 config.json）
"ai.api_key_env": "OPENAI_COMPATIBLE_API_KEY"  // 统一 API key 环境变量名
"ai.filter.max_checks_per_run": 300            // LLM 过滤预算上限（根 config.json）
"ai.filter.min_confidence": 0.5                // 过滤最低置信度（根 config.json）
"ai.enrich.concurrency": 3                     // 翻译分类并发数（根 config.json）
"ai.translation.enabled": true                 // 是否翻译（根 config.json）
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
./run.sh --profile econ
./run.sh --profile econ --dry-run

# 自动推送（cron 入口）
./auto-push.sh
./auto-push.sh --dry-run

# 单步（每步可独立运行，从上一步读取文件）
npx tsx src/cli.ts --step collect --profile top
npx tsx src/cli.ts --step filter  --profile top
npx tsx src/cli.ts --step enrich  --profile top
npx tsx src/cli.ts --step store   --profile top
npx tsx src/cli.ts --step digest  --profile top
npx tsx src/cli.ts --step push    --profile top
npx tsx src/cli.ts --step weekly  --profile top
npx tsx src/cli.ts --step weekly-all --profile top

npx tsx src/cli.ts --step collect --profile econ
npx tsx src/cli.ts --step enrich  --profile econ
npx tsx src/cli.ts --step store   --profile econ

# 测试
npm test
npm run build
```

## lark-cli 使用方式

`publish.ts` 中直接调用 subprocess：

```typescript
// pushToFeishu() 创建飞书文档（v2 API，Markdown 格式，stdin 传入内容）
await runCommand("lark-cli", [
  "docs", "+create",
  "--api-version", "v2",
  "--doc-format", "markdown",
  "--as", "bot",
  "--title", docTitle,
  "--content", "-"
], config.runtime.command_timeout_ms, markdownContent);

// pushToFeishu() 发送群通知
await runCommand("lark-cli", [
  "im", "+messages-send",
  "--as", "bot",
  "--chat-id", chatId,
  "--text", notifyText
], config.runtime.command_timeout_ms);
```

## 推送容错

- **doc 创建重试**：最多 3 次，指数退避（首次退避 ~5s，第二次 ~10s，第三次 ~20s，均带随机抖动）
- **发通知的前提**：doc 创建成功并拿到 URL 后才发群通知。拿不到 URL 则不发票通知
- **全部失败时抛错**：错误信息包含手动重试命令 `npx tsx src/cli.ts --step push --profile <name>`
- **手动重试**：push step 可独立重跑，不从零开始

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
sqlite3 data/top/papers.db "SELECT COUNT(*) FROM papers;"
sqlite3 data/top/papers.db "SELECT journal_name, COUNT(*) FROM papers GROUP BY journal_name ORDER BY 2 DESC;"
```

## 数据追溯（质检）

每个 step 的输入输出文件都有编号，可随时查看：

```bash
# 查看采集结果
cat data/top/2026-05-09/1-raw-fetched.json | jq 'length'

# 查看翻译+分类结果
cat data/top/2026-05-09/5-enriched.json | jq '.[0] | {title_zh, abstract_zh, classification}'

# 查看最终 Markdown
cat data/top/2026-05-09/6-digest.md | head -30

# 查看周刊
cat data/top/weekly-2026-05-11~2026-05-17/6-digest.md | head -30

# 查看数据库统计
sqlite3 data/top/papers.db "SELECT COUNT(*) FROM papers;"
sqlite3 data/top/papers.db "SELECT journal_name, COUNT(*) as cnt FROM papers GROUP BY journal_name ORDER BY cnt DESC;"

# 质检：对比输入输出数量
wc -l data/top/2026-05-09/*.json
```
