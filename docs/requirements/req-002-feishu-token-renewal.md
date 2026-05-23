# REQ-002: 飞书 Token 自动续期与过期检测

## 问题

lark-cli 的 OAuth refresh token 有有效期（通常 30-90 天），过期后所有飞书操作（创建文档、发送消息、告警）全部失败。唯一的恢复方式是手动扫码授权，树莓派无人值守场景下这意味着系统会一直静默失效，直到人工发现。

`deploy.sh` 的 `bootstrap_lark_auth()` 只在部署时运行一次，没有运行时的 token 有效性检测或自动续期。

## 影响

- push 步骤失败（创建飞书文档 → 401）
- 群通知发送失败
- 告警消息也无法发出（sendAlert 同样走飞书）
- 没有任何外部信号提醒用户"token 过期了"

## 当前 token 状态检查

`deploy.sh:116-131` 的 `is_lark_authenticated()` 检查方式：
- `lark auth status` 输出中匹配 `"ok": true` 或 `"tokenStatus": "valid"`
- 或 keychain 文件包含 `access_token` 或 `refresh_token`

这些检查只在部署时执行，运行时没有。

## 方案方向

- **A（治标）**：pipeline 运行前检查 token 状态，过期则发送最后一次告警（如果还能发的话），然后退出
- **B（治本）**：用 cron 定期跑 `lark auth login` 续期，或利用 lark-cli 的 `--no-wait` 模式 + 环境变量自动续
- **C（兜底）**：增加独立于飞书的告警通道（如 Healthchecks.io ping、Telegram bot、ntfy），token 过期时通过备用通道通知

## 相关文件

| 文件 | 位置 |
|------|------|
| `deploy.sh:116-131,332-361` | is_lark_authenticated / bootstrap_lark_auth |
| `src/publish.ts:192-261` | pushToFeishu（doc 创建 + 消息发送） |
| `src/publish.ts:351-359` | sendAlert（也走飞书） |

## 状态

待决策方案
