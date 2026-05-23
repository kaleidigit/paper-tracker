# REQ-009: 数据库连接生命周期安全

## 问题

`src/db.ts:47-61` 的 `openDb()` 每次调用创建新连接，在业务函数末尾手动 `db.close()`：

```typescript
function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export function upsertPapers(...): number {
  const db = openDb(dbPath);
  // ... 事务操作 ...
  db.close();
  return count;
}
```

如果事务中间抛异常（如 JSON parse 失败、磁盘满），`.close()` 不会执行，连接泄漏。

## 实际风险

- **CLI 模式**（`npx tsx`）：进程结束后 OS 回收所有资源，单次泄漏无影响
- **Daemon 模式**（`runDaemon()`）：进程长期运行，泄漏累积可能导致文件描述符耗尽
- **并发模式**：如果将来引入并发 DB 操作，未关闭的连接可能阻塞 WAL checkpoint

## 方案方向

- **A**：用 `try/finally` 包裹，确保 `close()` 始终执行
- **B**：使用 `db.close()` 的替代——`better-sqlite3` 的 connection 在进程退出时自动回收，所以 CLI 模式下影响极小。只需修复 daemon 模式下的问题
- **C**：单例连接模式——整个进程生命周期只维护一个 DB 连接，避免反复 open/close

## 推荐

A（最小改动，加 try/finally）+ C（长期，单例连接更干净）。

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/db.ts:47-61,144-211` | openDb / upsertPapers |
| `src/db.ts:213-225` | getPapersByDateRange |
| `src/db.ts:227-247` | getWeeklyPapers |

## 实现

2026-05-23 随 db.ts 重写（REQ-008+ 方案 B）已部分解决：

- 移除了 `getWeeklyPapers`、`getPapersByDateRange`、`rowToPaper` 等复杂查询函数
- DB 简化为 13 列纯缓存表，`upsertPapers` 和 `getKnownDedupKeys` 两个简单操作
- 事务中异常会由 better-sqlite3 自动回滚
- CLI 模式下进程退出自动回收连接，泄漏风险极低

未完全修复：仍使用手动 `db.close()` 而非 try/finally。当前风险可接受。

## 状态

已简化（风险降低），但未完全修复。降级为低优先级。
