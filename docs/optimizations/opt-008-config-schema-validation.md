# OPT-008: 配置文件 Schema 验证

## 问题

所有 JSON 配置文件在加载时没有 schema 验证：

```
config.json              — 根配置（profiles 列表 + 全局 ai 默认值）
profiles/*/config.json   — Profile 配置
profiles/*/classification.json — 分类体系（深度嵌套）
profiles/*/journals.json — 期刊列表
```

任何字段缺失、类型错误或拼写错误都会在运行时以难以诊断的方式失败：

| 配置错误 | 运行时表现 |
|---------|----------|
| `classification.json` 中 group 缺少 `subtopics` | `groups.map(g => g.subtopics)` → `undefined` 导致渲染异常 |
| `journals.json` 中 `issn` 是数字而非字符串 | `normalizeText(280836)` → `"280836"`，侥幸匹配 |
| `rss_feeds` 写成字符串而非数组 | `toArray` 会兜底处理，侥幸正确 |
| `feishu.notify_chat_ids` 拼写为 `notify_chatid` | `undefined`，静默跳过通知 |

## 影响

- **错误发现延迟**：配置问题在运行时暴露，不在部署/测试阶段
- **错误信息不友好**：`TypeError: Cannot read properties of undefined` 而非 "journal[3].issn is required"
- **分类配置尤其脆弱**：`classification.json` 深度嵌套（groups[].subtopics[].keywords），手动编辑易出错

## 方案

### 推荐：Zod schema 验证

```typescript
import { z } from "zod";

const JournalEntrySchema = z.object({
  name: z.string(),
  source_group: z.string(),
  issn: z.string().optional(),
  publisher_strategy: z.string().optional(),
  rss_feeds: z.array(z.string()).optional(),
  sort_order: z.number().optional(),
});

export async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const raw = JSON.parse(await fs.readFile(file, "utf-8"));
  return z.array(JournalEntrySchema).parse(raw);
}
```

优点：运行时验证、友好错误信息、可推导 TypeScript 类型
成本：zod ≈ 15KB min+gzip，项目已有类似体积的依赖

### 替代方案

- **手写 assert**：零依赖但手动维护，易遗漏
- **JSON Schema + ajv**：配置可独立发布但过重

## 实施优先级

1. **classification.json**（最高 — 深度嵌套，最易出错）
2. **journals.json**（中 — 条目多）
3. **config.json** / profile configs（低 — 有 `applyDefaults` 兜底）

## 相关文件

| 文件 | 变更 |
|------|------|
| `package.json` | 新增 `zod` 依赖 |
| `src/modules.ts:loadTaxonomy` | 加 Zod 验证 |
| `src/parsers/openalex-parser.ts:loadJournals` | 加 Zod 验证（或 shared.ts，若 OPT-002 实施） |
| `src/config.ts:loadRootConfig` / `loadProfileContext` | 加 Zod 验证 |

## 状态

已实施（2026-05-24）

## 实现

- 新增 `zod` 依赖（package.json）
- `config.ts`：`loadRootConfig` 用 `RootConfigSchema` 校验 `config.json`（profiles + ai）
- `modules.ts`：`loadTaxonomy` 用 `ClassificationSchema` 校验 `classification.json`（groups/domains 结构 + 每个 subtopic 的 keywords）
- `parsers/shared.ts`：`loadJournals` 用 `JournalEntrySchema` 校验 `journals.json`（name, source_group 必填，issn/rss_feeds/sort_order 可选）

额外修复：`tests/workflow.integration.test.ts` 修复了预存的 import 路径错误（`workflow.js` → `modules.js`）和废弃字段（`keywords`/`openalex_queries`）
