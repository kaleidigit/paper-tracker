# Paper-Tracker

自动化顶刊论文追踪系统。每日从 Nature、Science、PNAS 等顶刊采集论文，经 LLM 筛选、翻译、分类后生成中文日报，推送到飞书群和飞书文档。**DB 去重缓存**可自动跳过已知论文，节省 LLM token 消耗。

支持**多领域 profile 切换**：通过替换 `profiles/` 下的配置，即可追踪经济、法学等其他领域的文献。

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
# 编辑 .env，填入 OPENAI_COMPATIBLE_API_KEY、LARK_APP_ID、LARK_APP_SECRET

# 一键部署（安装依赖 + 构建 + lark-cli 授权）
./deploy.sh
```

### 3. 运行

```bash
# 完整管道（采集 → 筛选 → 翻译分类 → 入库 → 日报 → 推送飞书）
./run.sh --profile top

# Dry-run（仅生成本地文件，跳过飞书推送）
# 指定回溯天数
mo|./run.sh --profile top --days 2 --dry-run
./run.sh --profile top --dry-run

# 自动推送（cron 入口，周一 DAYS=3 覆盖周末积压）
./auto-push.sh
```

---

## 架构概览

```
profiles/{domain}/          领域配置（config.json, journals.json, classification.json）
src/
  llm.ts                    LLM 客户端（筛选、翻译、分类）
  publish.ts                飞书发布（lark-cli 直接调用）
  digest.ts                 Markdown / JSON 记录生成
  pipeline.ts               分步编排器（含 DB 查重跳过逻辑）
  modules.ts                采集与增强入口（fetchPapers, enrichPapers）
  db.ts                     SQLite 去重缓存（仅存原始字段，不含 LLM 派生数据）
  config.ts                 Profile 感知配置加载
  parsers/
    nature-parser.ts        Nature 系列 RSS + JSON-LD
    openalex-parser.ts      OpenAlex API（Science, PNAS, Joule, EES 等）
    article-parser.ts       通用文章页面解析
run.sh                      完整管道编排（日刊 + 合并推送）
auto-push.sh                cron 入口（每日合并推送）
deploy.sh                   一键部署
```

### 管道流程

```
collect   ──→  1-raw-fetched.json      RSS/OpenAlex 全量采集
filter    ──→  3-llm-filtered.json     DB查重(跳过已知论文) → LLM 合并筛选+翻译
enrich    ──→  5-enriched.json         LLM 分类（翻译已在筛选阶段完成）
store     ──→  papers.db               写入 SQLite（13 列精简模式，仅存原始字段）
digest    ──→  6-digest.md             生成日刊 Markdown
push      ──→  飞书文档 + 群消息通知

所有 profile 跑完后合并推送一份 combined 日报。
```

每步输出保存到 `data/{profile}/{date}/`，支持质检追溯。

---

## 推流逻辑

| 星期 | DAYS | 说明 |
|------|------|------|
| 周一 | 3 | 覆盖周末积压（周五~周日） |
| 周二至周五 | 1 | 仅昨天 |
| 周末 | — | 跳过 |

所有 profile 跑完后通过 `combined-push` 合并为一份日报推送。

---

## DB 去重缓存

`data/{profile}/papers.db` — SQLite（WAL 模式），仅存 13 列原始字段：

- **去重键**：`dedup_key` = DOI > URL > journal::title
- **PRIMARY KEY**：`(profile, dedup_key)`
- **首次采集日期**：`first_collected_date`（ON CONFLICT 不覆盖）
- **不含 LLM 派生数据**：title_zh, abstract_zh, classification 等不在 DB 中（在每日 JSON 文件中）

filter 步骤会先查 DB：已知 dedup_key 的论文直接跳过，不消耗 LLM token。随着 DB 积累，后续运行的 LLM 开销持续降低。

```bash
# 查看论文总数
sqlite3 data/top/papers.db "SELECT COUNT(*) FROM papers;"

# 按期刊统计
sqlite3 data/top/papers.db \
  "SELECT journal_name, COUNT(*) as cnt FROM papers GROUP BY journal_name ORDER BY cnt DESC;"
```

---

## 运行命令

### Shell 脚本

```bash
./run.sh --profile top                  # 完整管道
./run.sh --profile top --dry-run        # dry-run
gb|./run.sh --profile top --days 2 --dry-run  # 指定回溯天数
./auto-push.sh                          # cron 自动推送
```

### TypeScript CLI 单步

```bash
npx tsx src/cli.ts --step collect   --profile top
npx tsx src/cli.ts --step filter    --profile top
npx tsx src/cli.ts --step enrich    --profile top
npx tsx src/cli.ts --step store     --profile top
npx tsx src/cli.ts --step digest    --profile top
npx tsx src/cli.ts --step push      --profile top
npx tsx src/cli.ts --step combined-push --profile top
```

---

## 配置详解

### 时间窗口

```jsonc
"pipeline": {
  "paper_window": {
    "mode": "since_yesterday_time",
    "hour": 8,             // 每天 08:00 起算
    "minute": 0,
    "grace_days": 3,       // OpenAlex 索引延迟宽限
    "timezone": "Asia/Shanghai"
  }
}
```

- `strictWindowStartAt()`：RSS 使用严格窗口（1 天前 08:00）
- `graceWindowStartAt()`：OpenAlex 使用宽限窗口（+3 天），补偿索引延迟

### LLM 配置

```jsonc
"ai": {
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-v4-flash",
  "api_key_env": "OPENAI_COMPATIBLE_API_KEY",
  "filter": { "min_confidence": 0.5 },
  "translation": { "enabled": true },
  "enrich": { "concurrency": 5 }
}
```

### 飞书推送

```jsonc
"feishu": {
  "doc_title_prefix": "[每日论文追踪]",
  "notify_chat_id": "oc_xxx",
  "alert_chat_id": "oc_xxx"
}
```

---

## Profile 配置

| Profile | 用途 | 筛选模式 | 期刊数 |
|---------|------|---------|--------|
|| `top` | 环境能源期刊合集 | LLM 合并筛选+翻译 | 36 |
| `econ` | 环境经济学期刊 | 纯 LLM 直通 | 32 |
| `law` | 法学环境能源论文 | 纯 LLM 直通 | 8 |

新增 profile：创建 `profiles/{name}/` 目录，放入 `config.json`、`journals.json`、`classification.json`，无需改代码。

---

## 数据追溯

```bash
# 查看采集结果
cat data/top/2026-05-23/1-raw-fetched.json | jq 'length'
# 查看翻译+分类结果
cat data/top/2026-05-23/5-enriched.json | jq '.[0] | {title_zh, abstract_zh}'
# 查看最终 Markdown
cat data/top/2026-05-23/6-digest.md | head -30
# 查看合并日报
cat data/combined/2026-05-23/6-digest-combined.md | head -30
```

---

## 测试

```bash
npm test          # vitest (6 tests)
npm run build     # tsc 类型检查
```
