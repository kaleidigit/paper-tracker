# Paper-Tracker

自动化顶刊论文追踪系统。每日从 Nature、Science、PNAS 等顶刊采集论文，经 LLM 筛选、翻译、分类后生成中文日报，推送到飞书群和飞书文档。**所有论文自动汇入 SQLite 数据库**，每周一按期刊分组推送周刊。

支持**多领域 profile 切换**：通过替换 `profiles/` 下的配置，即可追踪经济、医学等其他领域的文献。

---

## 快速开始

### 1. 环境要求

- Node.js 20+
- npm 9+
- `lark-cli`（部署脚本会自动安装）

### 2. 安装与部署

```bash
git clone <repo-url> && cd paper-tracker

# 配置环境变量
cp config/.env.cn.example .env
# 编辑 .env，填入 SILICONFLOW_API_KEY、LARK_APP_ID、LARK_APP_SECRET

# 一键部署（安装依赖 + 构建 + lark-cli 授权）
./deploy.sh
```

### 3. 运行

```bash
# 完整管道（采集 → 过滤 → 翻译分类 → 入库 → 生成日报 → 推送飞书）
./run.sh --profile top-journal-env-energy

# Dry-run（仅生成本地文件，跳过飞书推送）
./run.sh --profile top-journal-env-energy --dry-run

# 手动触发周刊（读取上周数据库，按期刊推送）
npx tsx src/cli.ts --step weekly --profile top-journal-env-energy
```

---

## 架构概览

```
profiles/{domain}/          领域配置（config.json, journals.json, classification.json）
src/
  llm.ts                    LLM 客户端（筛选、翻译、分类）
  publish.ts                飞书发布（lark-cli 直接调用）
  digest.ts                 Markdown / JSON 记录生成（日刊 + 周刊）
  pipeline.ts               分步编排器
  modules.ts                采集与增强入口（fetchPapers, enrichPapers）
  db.ts                     SQLite 数据库（入库、去重、查询）
  config.ts                 Profile 感知配置加载
  parsers/
    nature-parser.ts        Nature 系列 RSS + JSON-LD
    openalex-parser.ts      OpenAlex API（Science, PNAS, Joule, EES）
    article-parser.ts       通用文章页面解析
run.sh                      完整管道编排（日刊）
auto-push.sh                cron 入口（周一周刊、其余日刊）
deploy.sh                   一键部署
```

### 管道流程

```
collect   ──→  1-raw-fetched.json         RSS/OpenAlex 全量采集
filter    ──→  3-llm-filtered.json         关键词 + LLM 过滤
enrich    ──→  5-enriched.json             翻译（英→中）+ 分类
store     ──→  papers.db                   写入 SQLite（按 dedup_key 去重）
digest    ──→  6-digest.md / records.json  生成日刊 Markdown
push      ──→  飞书文档 + 群消息通知

周一额外执行：
weekly    ──→  weekly-{start}~{end}/       从 DB 读取上周论文，按期刊分组推送周刊
```

每步输出保存到 `data/{profile}/{date}/`，支持质检追溯。论文数据在 `data/{profile}/papers.db`。

---

## 推流逻辑

| 星期 | 操作 | 采集范围 |
|------|------|----------|
| 周一 | collect→filter→enrich→store，然后 weekly 周刊推送 | 上周五/六/日 |
| 周二至周五 | collect→filter→enrich→store→digest→push 日刊 | 昨天 |
| 周末 | 不推送 | — |

---

## 运行命令

### Shell 脚本

```bash
./run.sh --profile top-journal-env-energy              # 完整日刊管道
./run.sh --profile top-journal-env-energy --dry-run    # dry-run
./auto-push.sh                                          # cron 自动推送
./auto-push.sh --dry-run
```

### TypeScript CLI 单步

```bash
npx tsx src/cli.ts --step collect --profile top-journal-env-energy
npx tsx src/cli.ts --step filter  --profile top-journal-env-energy
npx tsx src/cli.ts --step enrich  --profile top-journal-env-energy
npx tsx src/cli.ts --step store   --profile top-journal-env-energy
npx tsx src/cli.ts --step digest  --profile top-journal-env-energy
npx tsx src/cli.ts --step push    --profile top-journal-env-energy
npx tsx src/cli.ts --step weekly  --profile top-journal-env-energy
```

### npm scripts

```bash
npm run runner:llm-check         # LLM 连通性检查
npm test                         # 运行测试
npm run build                    # 编译 TypeScript
```

---

## 数据库

`data/{profile}/papers.db` — SQLite（WAL 模式），所有论文的持久化存储：

- **去重键**：`dedup_key` = DOI > URL > journal::title
- **唯一索引**：`UNIQUE(profile, dedup_key)`
- **查询索引**：`(profile, published_date)`、`(profile, journal_name)`
- **入库时机**：每天 enrich 后由 `stepStore` 自动写入

```bash
# 查看论文总数
sqlite3 data/top-journal-env-energy/papers.db "SELECT COUNT(*) FROM papers;"

# 按期刊统计
sqlite3 data/top-journal-env-energy/papers.db \
  "SELECT journal_name, COUNT(*) as cnt FROM papers GROUP BY journal_name ORDER BY cnt DESC;"

# 按日期统计
sqlite3 data/top-journal-env-energy/papers.db \
  "SELECT published_date, COUNT(*) FROM papers GROUP BY published_date ORDER BY published_date DESC LIMIT 10;"
```

---

## 配置详解

### 关键配置字段

#### 时间窗口（不随意修改，会导致重复推送）

```jsonc
{
  "pipeline": {
    "paper_window": {
      "mode": "since_yesterday_time",
      "hour": 8,
      "minute": 0,
      "timezone": "Asia/Shanghai"
    }
  }
}
```

#### LLM 配置（根 `config.json`，profile 只覆盖差异项）

```jsonc
{
  "ai": {
    "base_url": "https://api.siliconflow.cn/v1",
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "api_key_env": "SILICONFLOW_API_KEY",
    "filter": {
      "enabled": true,
      "max_checks_per_run": 300,
      "min_confidence": 0.5
    },
    "translation": { "enabled": true },
    "enrich": { "enabled": true, "concurrency": 3 }
  }
}
```

#### 飞书推送

```jsonc
{
  "feishu": {
    "doc_enabled": true,
    "doc_title_prefix": "[每日论文追踪]",
    "notify_enabled": true,
    "notify_chat_id": "oc_xxx",
    "alert_enabled": true,
    "alert_chat_id": "oc_xxx"
  }
}
```

### journals.json

每个期刊定义采集策略：

```jsonc
// Nature 系列 — RSS + 页面爬取
{ "name": "Nature Energy", "source_group": "Nature", "issn": "2058-7546",
  "publisher_strategy": "nature-rss", "rss_feeds": ["https://www.nature.com/nenergy.rss"] }

// Science / PNAS 等 — OpenAlex API
{ "name": "PNAS", "source_group": "PNAS", "issn": "0027-8424",
  "publisher_strategy": "openalex" }
```

### classification.json

三级分类体系：`domain → subdomain → keywords`

```jsonc
{ "domains": [{
    "name": "能源",
    "subdomains": [{
      "name": "储能与电池",
      "keywords": ["battery", "energy storage", "lithium-ion"]
    }]
}]}
```

---

## 中间产物与质检

每步输出保存在 `data/{profile}/{date}/` 下：

| 文件 | 内容 | 质检命令 |
|------|------|----------|
| `1-raw-fetched.json` | 全量采集论文 | `jq length data/.../1-raw-fetched.json` |
| `3-llm-filtered.json` | 过滤后论文 | `jq '.[].title_en' data/.../3-llm-filtered.json` |
| `5-enriched.json` | 翻译+分类后 | `jq '.[].title_zh' data/.../5-enriched.json` |
| `6-digest.md` | 日刊 Markdown | 直接查看 |
| `6-records.json` | 扁平记录 | 可导入表格工具 |
| `papers.db` | SQLite 论文库 | `sqlite3 data/.../papers.db "SELECT COUNT(*) FROM papers;"` |

周刊产物在 `data/{profile}/weekly-{start}~{end}/`。

---

## 多领域切换

```bash
mkdir -p profiles/new-domain
cp profiles/top-journal-env-energy/*.json profiles/new-domain/
# 修改 config.json、journals.json、classification.json
./run.sh --profile new-domain --dry-run
```

---

## 环境变量

```bash
TZ=Asia/Shanghai
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_BRAND=feishu
SILICONFLOW_API_KEY=xxx
```

---

## 测试

```bash
npm test          # vitest
npm run build     # tsc 类型检查
```
