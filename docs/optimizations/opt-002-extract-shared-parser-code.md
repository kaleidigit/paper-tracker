# OPT-002: 提取采集器共享基础设施

## 问题

`buildPaper()` 和 `loadJournals()` 在两个采集器中逐字节重复：

### `buildPaper`（openalex-parser.ts:44-62 ≈ nature-parser.ts:44-62）

将 `ParsedPaper` 转为 `Paper` 对象的工厂函数，逻辑完全一致：
- 归一化 `title`/`abstract`
- 调用 `dedupeStrings` 去重作者和单位列表
- 构建 `journal` 对象（含 `sort_order`）
- 填充所有 `Paper` 字段
- 初始化空白 `classification`

### `loadJournals`（openalex-parser.ts:29-33 ≈ nature-parser.ts:29-33）

从 `config.sources.journals_file` 读取期刊配置，解析为 `JournalEntry[]`。

### 差异

唯一差异是 `loadJournals` 在两个文件中完全相同，代码是逐行复制的。

`buildPaper` 同样是逐行重复，两处的代码完全一致。

## 根因

每个 Parser 被设计为自包含类，减少了导入耦合但造成了代码重复。

## 方案

在 `src/parsers/` 下新增一个共享模块：

```typescript
// src/parsers/shared.ts

import fs from "node:fs/promises";
import type { AppConfig } from "../types.js";
import type { JournalEntry, ParsedPaper } from "./types.js";
import {
  normalizeText, dedupeStrings, resolvePath, normalizePublicationType
} from "../utils.js";

export async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "profiles/top/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export function buildPaper(input: ParsedPaper): Paper {
  // ... 统一的实现
}
```

然后两个 Parser 从 `shared.js` 导入这两个函数。

## 额外收益

- 如果将来 `Paper` 类型新增字段，只需改一处 `buildPaper`
- 新增采集器（如 Semantic Scholar）不会重复造轮子

## 估计工作量

小型重构，约 40 行代码移入新文件，两个 Parser 各删 ~40 行。

## 相关文件

| 文件 | 变更 |
|------|------|
| `src/parsers/openalex-parser.ts` | 删除本地 `buildPaper`/`loadJournals`，导入 shared |
| `src/parsers/nature-parser.ts` | 删除本地 `buildPaper`/`loadJournals`，导入 shared |
| `src/parsers/shared.ts` | **新建**，集中 `buildPaper` 和 `loadJournals` |

## 状态

已实施（2026-05-23）

## 实现

- 新建 `src/parsers/shared.ts`，包含 `buildPaper` 和 `loadJournals`
- `openalex-parser.ts` 和 `nature-parser.ts` 均从 `shared.ts` 导入，删除本地副本
- 两个 Parser 移除了不再需要的 `resolvePath`、`normalizePublicationType`、`strictWindowStartAt` 等导入
