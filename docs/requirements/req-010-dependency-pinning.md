# REQ-010: 依赖版本锁定

## 问题

`deploy.sh:434` 每次部署安装 lark-cli 的最新版本：

```bash
npm install -g @larksuite/cli@latest --registry "$NPM_REGISTRY"
```

这意味着：
- lark-cli 的 breaking change 会直接破坏 push 功能
- 无法复现历史部署环境
- 没有回滚到已知可用版本的能力

## 影响

- lark-cli CLI 参数变更 → `publish.ts` 中的命令格式可能失效
- lark-cli 认证方式变更 → `deploy.sh` 的 token 续期逻辑可能需要调整
- 无法"冻结"一个稳定版本在树莓派上

## 当前状态

- `package.json` 中的 npm 依赖是锁版本的（`npm install` 配合 `package-lock.json`）
- lark-cli 是全局安装，不受 `package-lock.json` 控制
- 项目依赖的 `@larksuite/cli` 可能在 `package.json` 中也声明了，需要确认

## 方案方向

- **A**：锁死 lark-cli 版本（如 `@larksuite/cli@3.2.1`），手动升级
- **B**：将 lark-cli 作为项目 devDependency，用 `npx lark-cli` 调用而非全局安装
- **C**：在 deploy 时记录当前版本号，出问题时可以快速回滚

## 推荐

A + B：锁版本 + 移入项目依赖，不再全局安装。

## 相关文件

| 文件 | 位置 |
|------|------|
| `deploy.sh:434` | npm install -g lark-cli |
| `src/publish.ts:86-183` | lark-cli 调用点 |
| `package.json` | 项目依赖声明 |

## 状态

待决策方案
