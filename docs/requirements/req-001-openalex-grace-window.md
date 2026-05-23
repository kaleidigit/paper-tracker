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
- **有风险**：其余中小期刊（索引延迟可能 24-72h，grace_days=3 全覆盖）

## 方案方向

- **A**：本地过滤窗口加 n 天缓冲区（如 `windowCutoff - 2天`），靠 DB 去重兜底，代价是每天多处理少量已入库论文的 LLM 调用
- **B**：collect 阶段查询 DB 已有 dedup_key，跳过已入库论文的 enrich
- **C**：增加周期性回溯（每周/每月用 14 天窗口跑一次全量回溯）

## 实现（方案 A）

2026-05-23 实施方案 A，`grace_days` 默认 3 天。

变更文件：

| 文件 | 变更 |
|------|------|
| `src/types.ts:68` | `AppConfig.pipeline.paper_window` 新增 `grace_days?: number` |
| `src/utils.ts:159-173` | 新增 `graceWindowStartAt()`：`strictWindowStartAt() - graceDays` |
| `src/config.ts:154` | `applyDefaults()` 中设置 `grace_days` 默认值为 3 |
| `src/parsers/openalex-parser.ts:12,78-80` | 导入 `graceWindowStartAt`，本地过滤改用 grace 窗口 |

### 推演验证

以 2026-05-23（周六）dry-run 结果为例：

```
strictWindowStart = 2026-05-22 08:00 Asia/Shanghai（回退1天）
graceWindowStart  = 2026-05-19 08:00 Asia/Shanghai（再退3天）
```

| 发表日 | 旧严格窗口 | 新 grace 窗口 | 论文数 |
|:---:|:---:|:---:|:---:|
| 2026-05-23 | ✅ | ✅ | 8 |
| 2026-05-22 | ✅ | ✅ | 25 |
| 2026-05-21 | ❌ | ✅ | 53 |
| 2026-05-20 | ❌ | ✅ | 63 |
| 2026-05-19 | ❌ | ✅ | 39 |

新增保留 155 篇。DB dedup 确保重复论文被覆盖而非重复入库。

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/parsers/openalex-parser.ts:172-174` | 双层日期过滤（API 30天宽窗口 + 本地 grace 窗口） |
| `src/utils.ts:118-173` | `strictWindowStartAt()` + `graceWindowStartAt()` |
| `src/config.ts:154` | `grace_days` 默认值 |
| `src/db.ts` | `upsertPapers` dedup 兜底 |

## 状态

已实现（方案 A，默认 3 天缓冲）
