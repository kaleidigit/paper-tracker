# Paper-Tracker

自动化顶刊论文追踪系统。每日从 Nature、Science、PNAS 等顶刊采集论文，经 LLM 筛选、翻译、分类后生成中文日报，
通过 **RSS Feed（含 HTML 全文）** 和 **邮件** 分发。

支持**多领域 profile 切换**：通过替换 `profiles/` 下的配置，即可追踪经济、法学等其他领域的文献。

---

## 快速开始

### 1. 环境要求

- Node.js 20+
- npm 9+

### 2. 安装

```bash
git clone <repo-url> && cd paper-tracker

# 配置环境变量
cp config/.env.cn.example .env
# 编辑 .env，填入 OPENAI_COMPATIBLE_API_KEY（DeepSeek API key）

npm install
```

### 3. 运行

```bash
# 完整管道（采集 → 筛选 → 翻译分类 → 入库 → 日报 → RSS + 邮件）
./run.sh --profile top

# Dry-run（仅生成本地文件，跳过邮件发送）
./run.sh --profile top --dry-run

# 指定回溯天数
./run.sh --profile top --days 2 --dry-run

# 自动推送（cron 入口，周一 DAYS=3 覆盖周末积压）
./auto-push.sh
```

---

## 架构概览

```
profiles/{domain}/          领域配置（config.json, journals.json, classification.json）
src/
  llm.ts                    LLM 客户端（筛选、翻译、分类）
  digest.ts                 Markdown / JSON 记录生成
  rss.ts                    RSS 2.0 XML 生成（content:encoded 内嵌 HTML）
  publishers/
    render-html.ts          Markdown → HTML 渲染（marked）
    resend.ts               SMTP 邮件发送
  pipeline.ts               分步编排器（含 DB 查重跳过逻辑）
  modules.ts                采集与增强入口（collectRawPapers, filterPapers, enrichPapers）
  db.ts                     SQLite 去重缓存（仅存原始字段，不含 LLM 派生数据）
  config.ts                 Profile 感知配置加载
  parsers/
    nature-parser.ts        Nature 系列 RSS + JSON-LD
    openalex-parser.ts      OpenAlex API（Science, PNAS, Joule, EES 等）
    article-parser.ts       通用文章页面解析
run.sh                      完整管道编排（逐 profile 串行 + combined-rss）
auto-push.sh                cron 入口（计算 DAYS，委托 run.sh）
```

### 管道流程

```
collect   ──→  1-raw-fetched.json      RSS/OpenAlex 全量采集（不抓文章页）
filter    ──→  3-llm-filtered.json     DB查重(跳过已知论文) → LLM 合并筛选+翻译
enrich    ──→  5-enriched.json         RSS文章页抓取(延迟) → LLM 翻译 → 批量分类
store     ──→  papers.db               写入 SQLite（13 列精简模式，仅存原始字段）
digest    ──→  6-digest.md             生成日刊 Markdown
rss       ──→  public/feeds/*.xml      生成 RSS 2.0 XML + HTML 浏览页（含侧边目录）

每个 profile 跑完后，合并步骤：
combined-rss      ──→  public/feeds/combined.xml   跨领域合并 RSS
combined-notify   ──→  邮件（SMTP）                 发送一封 HTML 日报
```

每步输出保存到 `data/{profile}/{date}/`，RSS/HTML 输出到 `public/`。

HTML 浏览页左侧有**固定侧边目录**，可点击跳转到任意论文；邮件客户端中目录显示为顶部列表。移动端侧边栏自动隐藏。

### 推送方式

| 方式 | 说明 |
|------|------|
| **RSS Feed** | 托管 GitHub Pages，RSS 阅读器自动订阅 |
| **邮件** | SMTP 发送 HTML 日报，QQ 邮箱绑定微信后有新邮件提醒 |
| **Web 浏览** | GitHub Pages 托管 `public/index.html` 可在浏览器直接查看 |

---

## GitHub Actions 部署

### 1. 添加 Secrets

打开仓库 Settings → Secrets and variables → Actions → New repository secret：

| Name | 内容 |
|------|------|
| `OPENAI_COMPATIBLE_API_KEY` | DeepSeek API key |
| `EMAIL_USER` | SMTP 发件邮箱地址（如 `paper_tracker@126.com`） |
| `EMAIL_PASS` | SMTP 授权码（非登录密码） |
| `EMAIL_RECIPIENTS` | 收件人列表，逗号分隔（如 `a@qq.com,b@163.com`） |

### 2. 启用 GitHub Pages

Settings → Pages:
- Source: **Deploy from a branch**
- Branch: **gh-pages**，目录 `/ (root)`
- Save

### 3. 触发运行

Actions → Daily Paper Digest → Run workflow。部署成功后访问 `https://<user>.github.io/paper-tracker/` 即可看到 HTML 日报，RSS 地址为 `https://<user>.github.io/paper-tracker/feeds/combined.xml`。之后每天工作日 08:37 CST 自动运行。

---

## RSS 订阅指南

### 订阅地址

推送代码并完成 GitHub Pages 部署后，RSS 地址为：

```
https://kaleidigit.github.io/paper-tracker/feeds/combined.xml
```

### 各平台 RSS 阅读器

| 平台 | 推荐阅读器 | 添加方式 |
|------|-----------|---------|
| **iOS / macOS** | Reeder、NetNewsWire | App 内 → Add Feed → 粘贴 URL |
| **Android** | Feedly、Inoreader | App 内 → 搜索/添加 URL |
| **Windows** | Fluent Reader | Settings → Add Source → 粘贴 URL |
| **浏览器** | 直接访问 `public/index.html` | 无需额外软件 |

### 工作原理

1. GitHub Actions 每天自动运行管道，生成 `public/feeds/combined.xml`
2. 自动部署到 GitHub Pages
3. RSS 阅读器定期检查 feed URL，发现新内容后显示未读标记
4. 点击即可阅读 HTML 全文（支持图片、表格、链接）
5. 同时邮件用户会收到完整 HTML 日报

RSS 不需要注册任何账号，不需要安装推送 APP，阅读器本身就会通知你。

---

## 推流逻辑

| 星期 | DAYS | 说明 |
|------|------|------|
| 周一 | 3 | 覆盖周末积压（周五~周日） |
| 周二至周五 | 1 | 仅昨天 |
| 周末 | — | 跳过 |

各 profile 串行执行，最后合并生成 combined RSS。

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
./run.sh                                # 所有 profile（默认）
./run.sh --profile top                  # 指定单个 profile
./run.sh --dry-run                      # dry-run（不发送邮件）
./run.sh --profile top --days 2 --dry-run  # 指定回溯天数
./auto-push.sh                          # cron 自动推送
```

### TypeScript CLI 单步

```bash
# 所有 profile（默认）
npx tsx src/cli.ts --step collect
npx tsx src/cli.ts --step rss
npx tsx src/cli.ts --step combined-notify

# 指定单个 profile
npx tsx src/cli.ts --step digest --profile top
npx tsx src/cli.ts --step combined-rss
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

### RSS & Email

```jsonc
"rss": {
  "enabled": true,
  "site_url": "https://<user>.github.io/paper-tracker",
  "language": "zh-CN"
},
"email": {
  "enabled": true,
  "provider": "smtp",
  "smtp_host": "smtp.126.com",
  "smtp_port": 465,
  "user_env": "EMAIL_USER",
  "pass_env": "EMAIL_PASS",
  "to_env": "EMAIL_RECIPIENTS",
  "from": "Paper Tracker <paper_tracker@126.com>"
}
```

SMTP 邮箱支持 126/163/QQ 等，需在邮箱设置中开启 SMTP 服务并获取授权码。

---

## Profile 配置

| Profile | 用途 | 筛选模式 | 期刊数 |
|---------|------|---------|:---:|
| `top` | 环境能源期刊合集 | LLM 合并筛选+翻译 | 36 |
| `econ` | 环境经济学期刊 | 纯 LLM 直通 | 35 |
| `law` | 法学环境能源论文 | 纯 LLM 直通 | 8 |

新增 profile：创建 `profiles/{name}/` 目录，放入 `config.json`、`journals.json`、`classification.json`，无需改代码。

---

## 安全设计

所有密钥通过 GitHub Secrets → `.env`（gitignored）→ `process.env` 链路注入，从未进入仓库。

| 数据 | 存储 | 措施 |
|------|------|------|
| LLM API key | GitHub Secret | 从未进入仓库 |
| SMTP 授权码 | GitHub Secret | 从未进入仓库 |
| 邮件收件人 | GitHub Secret `EMAIL_RECIPIENTS` | env var 注入 |
| public/ 输出 | GitHub Pages（公开） | 仅论文元数据（公开学术信息） |

---

## 数据追溯

```bash
# 查看采集结果
cat data/top/2026-05-23/1-raw-fetched.json | jq 'length'
# 查看翻译+分类结果
cat data/top/2026-05-23/5-enriched.json | jq '.[0] | {title_zh, abstract_zh}'
# 查看最终 Markdown
cat data/top/2026-05-23/6-digest.md | head -30
# 查看 RSS Feed
cat public/feeds/combined.xml | head -30
```

---

## 测试

```bash
npm test          # vitest (6 文件 56 用例)
npm run build     # tsc 类型检查
```
