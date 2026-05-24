# OPT-001: 消除重复的工具函数定义

## 问题

以下工具函数在多个文件中各自定义，代码逐字重复或只有微小差异：

| 函数 | 定义位置 | 出现次数 |
|------|---------|:---:|
| `normalizeText` | `src/utils.ts`, `src/config.ts`, `src/db.ts`, `src/parsers/article-parser.ts` | 4 |
| `dedupeStrings` | `src/utils.ts`, `src/parsers/article-parser.ts` | 2 |
| `normalizePublicationType` | `src/utils.ts`, `src/parsers/article-parser.ts` | 2 |
| `resolvePath` | `src/utils.ts`, `src/config.ts` | 2 |

## 根因

1. **循环依赖规避**：`utils.ts` 导出 `resolvePath` 但不含 `ROOT_DIR` 默认值；`config.ts` 自己定义了一个 `resolvePath` 用 `ROOT_DIR` 做默认值
2. **模块职责不清**：`article-parser.ts` 定位为"独立可复用的解析器"，因此重新实现了全套工具函数而非从 `utils.ts` 导入
3. **历史遗留**：`db.ts` 和 `config.ts` 的 `normalizeText` 在 `utils.ts` 集中引入之前就已经存在

## 具体差异

### `normalizeText`

`article-parser.ts` 版本相比 `utils.ts` 少了解码 `\u00A0`（non-breaking space）：

```typescript
// utils.ts: decodeHtmlEntities → replace(/\s+/g, ' ').trim()
// article-parser.ts: decodeHtmlEntities → replace(/\s+/g, ' ').trim()
```
两者功能一致，但 `db.ts` 和 `config.ts` 版本**没有** `decodeHtmlEntities` 步骤。

### `normalizePublicationType`

`article-parser.ts` 版本比 `utils.ts` 多了一个 case：

```typescript
// utils.ts: text.includes("news & views") → "editorial"
// article-parser.ts: text.includes("news & view") || text.includes("research briefing") → "editorial"
//                    text.includes("news & views") → "comment"  ← 多出的分支
```

`article-parser.ts` 将 `"news & views"` 分类为 `"comment"`，而 `utils.ts` 将它归入 `"editorial"`。这个不一致在生产环境中已通过 `openalex-parser.ts` 和 `nature-parser.ts` 引用 `utils.ts` 的版本来规避——只有 `article-parser.ts` 内部使用自己的版本。

### `resolvePath`

```typescript
// utils.ts: 接受可选的 rootDir 参数，默认 process.cwd()
export function resolvePath(p: string, rootDir?: string): string {
  return path.isAbsolute(p) ? p : path.join(rootDir || process.cwd(), p);
}

// config.ts: 直接使用模块顶层的 ROOT_DIR
export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}
```

两处都有各自的调用者。`config.ts` 版本被 `modules.ts` 的 `loadTaxonomy` 引用，`utils.ts` 版本被 parser 引用。

## 影响

- **维护风险**：修改一个工具函数需要记住所有副本
- **行为不一致**：`normalizePublicationType` 的差异是真实 bug 来源
- **包体积**：`article-parser.ts` 多出 ~30 行重复代码

## 方案

1. **统一 `normalizePublicationType`**：将 `article-parser.ts` 中的版本移除，导入 `utils.ts` 版本。审查 `"news & views"` 的正确分类（应归为 `"editorial"` 以匹配 Nature 出版惯例），必要时修正 `utils.ts`
2. **`article-parser.ts` 统一导入**：移除本地的 `normalizeText`、`dedupeStrings`，从 `utils.ts` 导入
3. **`db.ts` 统一导入**：移除本地的 `normalizeText`，从 `utils.ts` 导入
4. **`config.ts` 统一 `resolvePath`**：将 `config.ts` 的 `resolvePath` 改为调用 `utils.ts` 版本并传入 `ROOT_DIR`：

```typescript
import { resolvePath as resolvePathRaw } from "./utils.js";
const ROOT_DIR = process.cwd();
export const resolvePath = (p: string) => resolvePathRaw(p, ROOT_DIR);
```

    或反过来：让 `utils.ts` 的 `resolvePath` 移除 `rootDir` 参数，`config.ts` 不重新定义，parser 中按需传入绝对路径。

## 估计工作量

小型重构，约 30-50 行变更，无行为变化。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/parsers/article-parser.ts` | 移除本地 `normalizeText`/`dedupeStrings`/`normalizePublicationType`，从 `utils.ts` 导入 |
| `src/db.ts` | 移除本地 `normalizeText`，从 `utils.ts` 导入 |
| `src/config.ts` | 可能的 `resolvePath` 统一 |
| `src/utils.ts` | 审查 `normalizePublicationType` 的 `"news & views"` 分类 |

## 状态

已实施（2026-05-23）

## 实现

- `normalizePublicationType`：`utils.ts` 增加 `"news & view"` 匹配，`article-parser.ts` 移除本地版本
- `normalizeText`/`dedupeStrings`：`article-parser.ts` 移除本地定义，统一从 `utils.ts` 导入
- `normalizeText`：`db.ts` 移除本地定义，从 `utils.ts` 导入
- `resolvePath`：`config.ts` 移除本地定义，改为调用 `utils.ts` 版本并传入 `ROOT_DIR`
- `config.ts` 本地 `normalizeText`（非导出）替换为 `utils.ts` 导入
