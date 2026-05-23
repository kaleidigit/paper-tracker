# REQ-007: LLM Provider 降级与容错

## 问题

DeepSeek 是唯一的 LLM 依赖，覆盖 filter（筛选）、translate（翻译）、classify（分类）三个环节。如果 DeepSeek API 不可用（欠费、限流、机房故障），整个 pipeline 中断，当天无日报推送。

26 个 OpenAlex 期刊的筛选依赖 LLM。虽然 LLM 预算耗尽后关键词通过的论文会直通（`modules.ts:77-82`），但 API 全挂意味着所有 LLM 调用都失败。

## 当前容错

- `filterPapers`：单篇 LLM 调用失败后 retry 1 次（10s 后退），retry 仍失败则跳过该论文不做处理（`modules.ts:96-103`）
- `enrichOne`：翻译 retry 3 次（指数退避），分类 retry 3 次。如果翻译失败且 `translation.required: true`，抛异常中断
- `filter.max_checks_per_run: 300`：LLM 预算耗尽后关键词通过的论文直通

## 问题

- API 全挂（非单次超时）时，`filterPapers` 把所有待审查论文都当做失败跳过 —— 结果可能是 0 篇通过，漏掉当天所有论文
- 没有备用的 LLM provider

## 方案方向

- **A**：配置多 provider fallback（如 DeepSeek 挂了切 OpenAI 兼容的其他 API）
- **B**：LLM 全挂时的降级策略——跳过 LLM 审查，关键词通过的论文全部收录（宁可多，不可漏）
- **C**：`filterPapers` 失败论文不丢弃，而是标记为"未经 LLM 审查"，让它们在 digest 中标注 `⚠ 未经 LLM 审查`
- **D**：加一个简单的本地关键词计分代替 LLM（不过滤，只算相关性分数）

## 推荐

短期 B + C（降级保底策略），长期 A（多 provider 配置支持）。

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/llm.ts` | LLM 客户端 |
| `src/modules.ts:62-118` | filterPapers |
| `src/modules.ts:130-203` | enrichOne |
| `config.json` | ai 配置 |

## 状态

待决策方案
