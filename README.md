# Paper-Tracker

自动化顶刊论文追踪系统。每日从 Nature、Science、PNAS 等顶刊采集论文，经 LLM 筛选、翻译、分类后生成中文日报，推送到飞书群和飞书文档。

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
# 完整管道（采集 → 过滤 → 翻译分类 → 生成日报 → 推送飞书）
./scripts/run.sh --profile environment-energy

# Dry-run（仅生成本地文件，跳过飞书推送）
./scripts/run.sh --profile environment-energy --dry-run
```

---

## 架构概览

```
profiles/{domain}/          领域配置（config.json, journals.json, classification.json）
src/
  llm.ts                    LLM 客户端（筛选、翻译、分类）
  publish.ts                飞书发布（lark-cli 直接调用）
  digest.ts                 Markdown / JSON 记录生成
  pipeline.ts               分步编排器
  modules.ts                采集与增强入口（fetchPapers, enrichPapers）
  config.ts                 Profile 感知配置加载
  parsers/
    nature-parser.ts        Nature 系列 RSS + JSON-LD
    openalex-parser.ts      OpenAlex API（Science, PNAS, Joule, EES）
    article-parser.ts       通用文章页面解析
scripts/
  run.sh                    完整管道编排
  _lib.sh                   共享函数（供 run.sh 使用）
```

### 管道流程

```
collect   ──→  1-raw-fetched.json        RSS/OpenAlex 全量采集
filter    ──→  3-llm-filtered.json       关键词 + LLM 过滤
enrich    ──→  5-enriched.json           翻译（英→中）+ 分类
digest    ──→  6-digest.md / records.json  生成日报 Markdown
push      ──→  飞书文档 + 群消息通知
```

每步输出保存到 `data/{profile}/{date}/`，支持质检追溯。

---

## 运行命令

### Shell 脚本

```bash
./scripts/run.sh --profile environment-energy              # 完整管道
./scripts/run.sh --profile environment-energy --dry-run    # dry-run
```

### TypeScript CLI

```bash
npx tsx src/cli.ts run-once --profile environment-energy   # 完整运行（单进程）
npx tsx src/cli.ts --step collect --profile environment-energy  # 单步
npx tsx src/cli.ts --step push --profile environment-energy     # 单步推送
```

### npm scripts

```bash
npm run runner:once              # 单次运行（兼容旧方式）
npm run runner:llm-check         # LLM 连通性检查
npm run test                     # 运行测试
npm run build                    # 编译 TypeScript
```

---

## 配置详解

所有领域配置位于 `profiles/{domain}/` 目录。以 `profiles/environment-energy/` 为例：

### config.json 关键字段

#### 时间窗口

控制采集论文的时间范围：

```jsonc
{
  "pipeline": {
    "default_days": 2,
    "paper_window": {
      "mode": "since_yesterday_time",  // 时间窗口模式
      "hour": 8,                       // 起始小时（本地时间）
      "minute": 0,
      "timezone": "Asia/Shanghai"
    },
    "schedule": {
      "hour": 8,          // 定时运行的小时
      "minute": 30,       // 定时运行的分钟
      "check_every_hours": 1  // daemon 模式轮询间隔
    }
  }
}
```

| 场景 | 修改方式 |
|------|----------|
| 改为采集最近 3 天的论文 | `"default_days": 3` |
| 改为每天 10:00 之后的论文 | `"paper_window.hour": 10` |
| 改为按自然日计算（周一拉 3 天） | `"paper_window.mode": "since_yesterday_midnight"` |
| 切换到 UTC 时区 | `"timezone": "UTC"` |

#### LLM 配置

```jsonc
{
  "ai": {
    "base_url": "https://api.siliconflow.cn/v1",  // OpenAI-compatible API
    "model": "deepseek-ai/DeepSeek-V3.2",         // 默认模型
    "api_key_env": "SILICONFLOW_API_KEY",          // .env 中的 key 名
    "filter": {
      "enabled": true,            // 是否启用 LLM 过滤
      "max_checks_per_run": 40,   // 单次运行 LLM 过滤预算上限
      "min_confidence": 0.5       // 过滤最低置信度
    },
    "translation": {
      "enabled": true,            // 是否启用翻译
      "model": "deepseek-ai/DeepSeek-V3.2"  // 可单独指定翻译模型
    },
    "enrich": {
      "enabled": true,
      "concurrency": 3            // 翻译分类并发数
    }
  }
}
```

| 场景 | 修改方式 |
|------|----------|
| 切换到其他 AI 供应商 | 修改 `base_url` 和 `api_key_env` |
| 关闭 LLM 过滤（仅用关键词） | `"filter.enabled": false` |
| 增加翻译并发 | `"enrich.concurrency": 5` |
| 降低 LLM 成本 | 减小 `max_checks_per_run` 或关闭 `translation` |

#### 关键词过滤

```jsonc
{
  "sources": {
    "keywords": ["environment", "climate", "energy", "carbon", ...],  // 标题/摘要关键词
    "openalex_queries": ["energy", "climate", "carbon", ...]          // OpenAlex 搜索词
  }
}
```

- `keywords`：论文标题、摘要、期刊名中出现任一即通过关键词过滤
- `openalex_queries`：OpenAlex API 的搜索关键词，用于检索 Science/PNAS 等

#### 飞书推送

```jsonc
{
  "feishu": {
    "doc_enabled": true,     // 是否创建飞书文档
    "doc_title_prefix": "[每日论文追踪]",
    "notify_enabled": true,  // 是否发送群消息通知
    "notify_chat_id": "oc_xxx",
    "alert_enabled": true,   // 论文为空时是否告警
    "alert_chat_id": "oc_xxx"
  }
}
```

#### 重试与超时

```jsonc
{
  "runtime": {
    "command_timeout_ms": 600000,  // 单次命令超时（10 分钟）
    "retry": {
      "max_attempts": 2,   // 每步最大重试次数
      "backoff_ms": 2000   // 重试间隔
    }
  }
}
```

### journals.json

期刊配置，每个期刊定义采集策略：

```jsonc
// Nature 系列 — 使用 RSS + 页面爬取
{
  "name": "Nature Energy",
  "source_group": "Nature",
  "issn": "2058-7546",
  "publisher_strategy": "nature-rss",
  "rss_feeds": ["https://www.nature.com/nenergy.rss"]
}

// Science / PNAS 等 — 使用 OpenAlex API
{
  "name": "PNAS",
  "source_group": "PNAS",
  "issn": "0027-8424",
  "publisher_strategy": "openalex"
}
```

**添加新期刊**：在 `profiles/environment-energy/journals.json` 中添加条目。

Nature 系列需要 `rss_feeds` 数组；OpenAlex 期刊只需 `issn`。

### classification.json

三级分类体系：`domain → subdomain → keywords`

```jsonc
{
  "domains": [{
    "name": "能源",
    "subdomains": [{
      "name": "储能与电池",
      "keywords": ["battery", "energy storage", "lithium-ion"]
    }]
  }]
}
```

`keywords` 用于规则分类（heuristic），作为 LLM 分类的补充。

---

## 环境变量

`.env` 文件配置：

```bash
# 时区
TZ=Asia/Shanghai

# 飞书凭据
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_BRAND=feishu

# AI API 密钥
SILICONFLOW_API_KEY=xxx
```

---

## 中间产物与质检

每步输出保存在 `data/{profile}/{date}/` 下：

| 文件 | 内容 | 质检命令 |
|------|------|----------|
| `1-raw-fetched.json` | 全量采集论文 | `jq length data/environment-energy/2026-05-08/1-raw-fetched.json` |
| `3-llm-filtered.json` | 过滤后论文 | `jq '.[].title_en' data/.../3-llm-filtered.json` |
| `5-enriched.json` | 翻译+分类后 | `jq '.[].title_zh' data/.../5-enriched.json` |
| `6-digest.md` | 最终 Markdown | 直接查看或预览 |
| `6-records.json` | 扁平记录 | 可导入表格工具 |

```bash
# 对比过滤前后差异
diff <(jq -r '.[].title_en' data/.../1-raw-fetched.json) \
     <(jq -r '.[].title_en' data/.../3-llm-filtered.json)

# 检查翻译质量
jq '.[] | {title_en, title_zh}' data/.../5-enriched.json | head -20
```

---

## 多领域切换

要追踪其他领域（如经济学），只需创建新的 profile：

```bash
mkdir -p profiles/economics-finance
cp profiles/environment-energy/config.json profiles/economics-finance/
```

然后修改 `profiles/economics-finance/` 下的三个文件：

1. **config.json** — 修改关键词、AI 提示词、期刊来源
2. **journals.json** — 替换为期刊（如 AER, Econometrica, QJE）
3. **classification.json** — 替换为领域分类树

运行：

```bash
./scripts/run.sh --profile economics-finance --dry-run
```

---

## 添加新出版商采集器

如果要添加新的数据源（如 IEEE, ACM），需要：

1. 在 `profiles/{domain}/journals.json` 中添加期刊，设置新的 `publisher_strategy`（如 `"ieee"`）
2. 在 `src/parsers/` 下新建 `ieee-parser.ts`，实现 `collect(config, taxonomy, filterBudget)` 方法，返回 `Paper[]`
3. 在 `src/pipeline.ts` 的 collect step 中注册新 parser

---

## 故障排查

| 问题 | 排查步骤 |
|------|----------|
| LLM 翻译失败 | `npm run runner:llm-check` 检查 API 连通性 |
| 飞书文档创建失败 | `lark-cli auth status` 检查登录态；重新 `./deploy.sh` |
| Science/PNAS 论文未抓到 | 检查 `openalex_queries` 是否包含相关词；确认 OpenAlex API 可访问 |
| 日报为空 | 查看 `data/ts-runner/logs/*.log` 中的 `workflow.fetch.done`；检查时间窗口 |
| Author Correction 出现在日报 | 预期行为：`shouldSkipLlmRescueByTitle()` 自动排除，可调整该函数 |
| lark-cli keychain 报错 | `./deploy.sh` 会自动处理；手动执行 `lark-cli config init && lark-cli auth login` |

---

## 测试

```bash
npm test          # vitest
npm run build     # tsc 类型检查
```

---

## 目录结构

```
paper-tracker/
  profiles/
    environment-energy/
      config.json           # 领域配置
      journals.json         # 期刊列表
      classification.json   # 分类树
  src/
    llm.ts                  # LLM 客户端
    publish.ts              # 飞书发布
    digest.ts               # Markdown 生成
    pipeline.ts             # 分步编排器
    modules.ts              # 采集增强入口
    config.ts               # 配置加载
    types.ts                # 类型定义
    utils.ts                # 工具函数
    command.ts              # Shell 命令执行
    storage.ts              # 状态持久化
    scheduler.ts            # 调度逻辑
    parsers/
      nature-parser.ts      # Nature 系列采集
      openalex-parser.ts    # OpenAlex 采集
      article-parser.ts     # 文章页面解析
  scripts/
    _lib.sh                 # 共享函数
    run.sh                  # 完整管道
  deploy.sh                 # 一键部署
  data/
    {profile}/{date}/       # 每次运行的产出物
  .env                      # 环境变量（不提交 git）
```
