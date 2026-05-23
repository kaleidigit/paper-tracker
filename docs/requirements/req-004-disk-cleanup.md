# REQ-004: 磁盘空间自动清理

## 问题

Pipeline 每次运行生成新的日期目录，包含多份 JSON 和 Markdown 文件：

```
data/top/
  2026-05-21/    1-raw-fetched.json  3-llm-filtered.json  5-enriched.json  6-digest.md  6-records.json
  2026-05-22/    ...
  2026-05-23/    ...
  papers.db      ← 持续增长
  weekly-*/      ← 周刊目录
```

没有任何清理逻辑。加上 `papers.db` 增长、npm 缓存、日志文件，长时间运行会耗尽磁盘。

## 估算

- 日录：~200KB-2MB（取决于当天采集量）
- papers.db：月均 ~5-20MB（取决于论文数量）
- 日志：不定
- 年增长：~500MB-1GB

32GB SD 卡可以撑几年，但长期来看必须清理。

## 需求

1. **日录保留策略**：保留最近 N 天的中间产物（如 30 天），定期删除更早的
2. **DB 不清理**：papers.db 是长期资产，只增不删
3. **周刊目录**：保留所有周刊（体积小，有意义）
4. **清理时机**：作为 pipeline 的最后一步或 cron 独立任务，不影响正常流程
5. **干运行模式**：可查看哪些文件将被删除

## 方案方向

- **A**：在 `run.sh` / `auto-push.sh` 末尾加清理逻辑，`find data/ -type d -name "202*" -mtime +30 -exec rm -rf {} \;`
- **B**：新增 `src/cli.ts --step cleanup` 步骤，可配置保留天数
- **C**：独立 cron 任务（如每周日凌晨清理）

推荐 B + C 组合：pipeline 内置 cleanup step + 独立的周清理 cron。

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/pipeline.ts` | 新增 stepCleanup |
| `src/cli.ts` | 注册新 step |
| `auto-push.sh` / `run.sh` | 可选：末端调用 cleanup |

## 状态

待决策方案
