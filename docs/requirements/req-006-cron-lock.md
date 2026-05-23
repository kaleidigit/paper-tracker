# REQ-006: Cron 并发防护（进程锁）

## 问题

cron 按时间表触发，不检查上一次是否跑完。正常情况下 pipeline 在 3-10 分钟内完成，不会重叠。但异常情况下（网络慢、API 限流、LLM 响应慢），一次 run 可能超过 cron 间隔，导致两个进程同时操作：

- 同一个 `papers.db`（SQLite WAL 允许并发读但写会冲突）
- 同一个日期目录的中间文件（`1-raw-fetched.json` 等被两个进程交叉读写）

## 当前保护

- `auto-push.sh` 每天只跑一次（cron 每天触发一次），重叠概率低
- SQLite `busy_timeout = 5000`（5 秒等待），但这只缓解不解决
- `set -euo pipefail` 让单次运行失败即停，不会无限堆积

## 实际触发场景

- 周一 `DAYS=3` + 三个 profile 串行跑，可能超过 30 分钟
- 如果手动同时在另一个终端跑 `./run.sh`，会和 cron 冲突
- DeepSeek API 限流/变慢导致 enrich 阶段耗时数倍

## 方案方向

- **A**：flock 文件锁（最简，bash 原生）：
  ```bash
  exec 200>/tmp/paper-tracker.lock
  flock -n 200 || { echo "Another instance is running, exiting."; exit 0; }
  ```
- **B**：pidfile 模式，记录 PID + 检查进程是否存活
- **C**：用 `timeout` 限制单次运行最长时长，超过则 kill

## 推荐

A：flock 简单可靠，不需要额外依赖。

## 相关文件

| 文件 | 位置 |
|------|------|
| `auto-push.sh` | cron 入口 |
| `run.sh` | 手动入口（也需要锁） |
| `src/db.ts:48-50` | SQLite WAL + busy_timeout |

## 状态

待决策方案
