# REQ-003: 独立健康监控通道

## 问题

系统的"心跳"完全依赖飞书推送。如果某天没收到日报，不知道原因是什么：
- Pipeline 正常但飞书挂了
- 飞书正常但 pipeline 挂了
- 树莓派断网了
- SD 卡满了
- DeepSeek 欠费了

没有独立于飞书的监控机制。`state.json` 和 `metrics.json` 存在本地，无人查看。

## 当前已有的监控基础设施

- `src/storage.ts` → `readState()` / `readMetrics()` 提供运行统计
- `src/logger.ts` → 结构化日志写入
- `src/publish.ts:351-359` → `sendAlert()` 告警（但走飞书，token 过期就废了）

## 需求

需要一个**独立于飞书的健康检查机制**：

1. **心跳信号**：每次成功运行后向外部服务发送 ping
2. **死信告警**：如果超过预期间隔未收到 ping，通过独立通道通知
3. **低成本**：不需要自建服务

## 方案方向

- **Healthchecks.io**（免费 tier 足够）：pipeline 成功后 `curl https://hc-ping.com/{uuid}`。如果超过预定间隔没收到 ping，Healthchecks 发邮件/Telegram/ntfy 告警
- **Telegram Bot**：发一条消息到自己 bot，免费、无需第三方服务
- **ntfy.sh**：自建或使用公共服务，推送通知到手机
- **Cron 包装器**：在 `run.sh` 开头 curl 一个"开始"信号，结尾 curl 一个"成功"信号。外部监控两个信号的时间差

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/cli.ts:40-106` | runOnceWithProfile（pipe 入口） |
| `auto-push.sh` | cron 入口 |
| `run.sh` | 手动执行入口 |
| `src/logger.ts` | 结构化日志 |

## 状态

待决策方案
