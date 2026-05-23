# REQ-001: OpenAlex 索引延迟补偿窗口

## 问题

OpenAlex 从论文发表到 API 可查之间存在索引延迟（数小时到数天）。当前 pipeline 的本地日期过滤使用精确的 `windowStart`，导致延迟索引的论文被永久遗漏。

**具体推演**（论文周三发表，周五才被 OpenAlex 索引）：

| 运行日 | DAYS | API 里有吗 | 本地过滤结果 |
|--------|------|:---:|------|
| 周四 | 1 | ❌ | 未取到 |
| 周五 | 1 | ✅ | `pub_date < windowStart` → 丢弃 |
| 周一 | 3 | ✅ | `pub_date < windowStart` → 丢弃 |

## 根因

`src/parsers/openalex-parser.ts:172-174`
```typescript
const filtered = papers.filter(
  (p) => !p.published_date || p.published_date >= windowCutoff
);
```

API 层用了 30 天宽窗口（line 86），但本地过滤又把延迟索引的论文扔掉了。

## 影响范围

- **不受影响**：Nature RSS 采集的 20 个期刊（实时推送，零延迟）
- **低风险**：Science/PNAS/Joule 等顶刊（OpenAlex 通常数小时内索引）
- **有风险**：其余中小期刊（索引延迟可能 24-72h）

## 方案方向

- **A**：本地过滤窗口加 n 天缓冲区（如 `windowCutoff - 2天`），靠 DB 去重兜底，代价是每天多处理少量已入库论文的 LLM 调用
- **B**：collect 阶段查询 DB 已有 dedup_key，跳过已入库论文的 enrich
- **C**：增加周期性回溯（每周/每月用 14 天窗口跑一次全量回溯）

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/parsers/openalex-parser.ts:86-91,172-174` | 双层日期过滤 |
| `src/utils.ts:118-157` | strictWindowStartAt() |
| `src/db.ts` | upsertPapers dedup 可查重 |

## 状态

待决策方案
