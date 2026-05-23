# REQ-005: 系统时间校验（断电恢复安全）

## 问题

树莓派没有 RTC（实时时钟），断电后系统时间会重置到出厂默认值（通常是 1970-01-01 或固件编译时间）。如果 cron 在 NTP 同步完成之前触发了 pipeline：

```typescript
// src/utils.ts:126
const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
```

时间戳完全错乱，`windowStart` 会计算出一个无意义的日期。OpenAlex API 可能返回错误或拉回全量几十年的数据。

## 实际风险

- **断电后立即启动**：Raspberry Pi 从冷启动到 cron 触发可能只有 30 秒——NTP 通常需要 30 秒到几分钟才能完成同步
- **WiFi 断连**：如果 WiFi 没连上，NTP 永远无法同步，每次 cron 触发都用错误时间
- **NTP 服务挂了**：`systemd-timesyncd` 偶尔会卡住

## 方案方向

- **A（最小改动）**：在 `run.sh` / `auto-push.sh` 开头检查时间：
  ```bash
  # 如果年份 < 2025，等待 NTP 同步
  if [ "$(date +%Y)" -lt 2025 ]; then
    echo "System time is wrong, waiting for NTP sync..."
    sleep 120
  fi
  ```
- **B**：cron 使用 `@reboot sleep 300 && ...` 延迟启动，给 NTP 足够时间
- **C**：代码层防御——`strictWindowStartAt()` 中检查年份，若异常则退出并记录错误日志
- **D**：硬件方案——加装 RTC 模块（DS3231），彻底解决

## 推荐

A + B 组合：shell 层检查 + cron 延迟启动。D 可选长期方案。

## 相关文件

| 文件 | 位置 |
|------|------|
| `auto-push.sh:1-12` | cron 入口 |
| `run.sh:1-12` | 手动执行入口 |
| `src/utils.ts:118-157` | strictWindowStartAt() |

## 状态

待决策方案
