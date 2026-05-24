# OPT-006: 数据库连接生命周期优化

## 问题

`stepFilter`（pipeline.ts:56-94）对同一个 SQLite 文件打开和关闭了**两次连接**：

```typescript
// pipeline.ts:stepFilter
async function stepFilter(ctx: ProfileContext): Promise<StepResult> {
  // ...
  const dbPath = path.join(path.dirname(ctx.outputDir), "papers.db");

  // 调用 1：getKnownDedupKeys → openDb(dbPath) → query → db.close()
  knownKeys = getKnownDedupKeys(dbPath, ctx.profile, allKeys);

  // ...

  // stepStore 中再次 → openDb(dbPath) → upsert → db.close()
  // （在 pipeline 步骤串联执行时）
}
```

每一次 `getKnownDedupKeys` 和 `upsertPapers` 都独立打开和关闭数据库：

```typescript
// db.ts
export function getKnownDedupKeys(dbPath, profile, keys): Set<string> {
  const db = openDb(dbPath);      // ← open #1: schema exec + WAL pragma
  const rows = db.prepare(...).all(...);
  db.close();                     // ← close #1
  return new Set(rows.map(r => r.dedup_key));
}

export function upsertPapers(dbPath, profile, papers): number {
  const db = openDb(dbPath);      // ← open #2: schema exec + WAL pragma
  // ... upsert ...
  db.close();                     // ← close #2
  return count;
}
```

每次 `openDb` 都会执行：
- `new Database(dbPath)` — 文件系统操作
- `PRAGMA journal_mode = WAL` — 状态修改
- `PRAGMA busy_timeout = 5000` — 状态修改
- `CREATE TABLE IF NOT EXISTS ...` — schema 检查

## 影响

- **性能**：两次连接打开/关闭增加 ~5-10ms 开销（对微秒级查询来说不低）
- **WAL 文件碎片**：每次连接关闭触发 WAL checkpoint；频繁开关可能产生多余的 WAL 文件
- **可维护性**：`catch { }` 绕过了 DB 错误（pipe.ts:71），如果第一次连接成功但第二次失败，状态不一致

## 方案

### A：单连接贯穿 stepFilter + stepStore

```typescript
// 在 pipeline 层打开一次，传入已打开的 db 实例
async function stepFilter(ctx, db) { ... }
async function stepStore(ctx, db) { ... }
```

### B：调用者传入已打开的连接

```typescript
export function getKnownDedupKeys(
  db: Database.Database, profile: string, keys: string[]
): Set<string> { ... }
```

### C：模块级连接管理

```typescript
// db.ts
let _db: Database.Database | null = null;
export function getDb(dbPath: string): Database.Database {
  if (!_db) _db = openDb(dbPath);
  return _db;
}
export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
```

## 推荐

方案 B：将 `db` 作为参数传入，由调用者管理连接生命周期。配合 try/finally 确保 close（见 REQ-009）。

对于 CLI 模式（进程短暂），单次连接的额外开销可忽略。但对于 profile 串联执行（3 个 profile × 2 次连接 = 6 次 open/close），累积影响值得优化。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/db.ts` | `getKnownDedupKeys` 和 `upsertPapers` 接受 `Database.Database` 参数而非 `dbPath` |
| `src/pipeline.ts` | `stepFilter` 和 `stepStore` 打开一次连接，传递给两个函数 |

## 状态

已实施（2026-05-23）

## 实现

- `db.ts`：`getKnownDedupKeys` 和 `upsertPapers` 改为接受 `Database.Database` 参数，由调用者管理连接
- `db.ts`：`openDb` 改为 `export`
- `pipeline.ts`：`stepFilter` 和 `stepStore` 各用 `try/finally` 包裹连接生命周期，确保异常安全
