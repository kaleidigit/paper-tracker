# REQ-008: 采集层 HTTP 请求重试

## 问题

LLM 调用有重试机制（filter 1 次 retry，enrich 3 次 retry），但采集层的 HTTP 请求没有。

### OpenAlex API（`openalex-parser.ts:106-112`）

```typescript
try {
  payload = await fetchJson(url, timeoutMs);
} catch {
  // 分页失败直接 break，不重试
  break;
}
```

一页分页请求失败就停止采集。如果第 3 页超时，第 4 页及之后的论文全部丢失。

### Nature RSS（`nature-parser.ts:102-107`）

```typescript
try {
  xml = await natureLimit(() => fetchText(feedUrl, timeoutMs));
} catch {
  // 单个 feed 失败返回空数组，不重试
  return [];
}
```

一个 feed 失败不影响其他 feed，但失败了就是 0 篇，等价于该期刊当天漏采。

### Article 页面抓取（Nature JSON-LD 补全）

`ArticlePageParser.parse(paperUrl)` 失败无重试（`nature-parser.ts:132-135`），失败时退回到 RSS 中的摘要信息。这算部分容错。

## 影响

- 网络抖动（树莓派 WiFi 不稳定）可能导致随机丢失数据
- 不是"全有或全无"——损坏取决于哪个请求失败了

## 方案方向

- **A**：对 OpenAlex 分页请求加重试（3 次，指数退避），重试仍失败再 break
- **B**：Nature RSS feed 请求加重试（2 次，间隔 5s）
- **C**：采集失败时记录日志，以便后续手动回溯

## 推荐

A + B：最小改动，两个 parser 中的关键 HTTP 调用加 2-3 次 retry。

## 相关文件

| 文件 | 位置 |
|------|------|
| `src/parsers/openalex-parser.ts:106-112` | OpenAlex 分页 fetch |
| `src/parsers/nature-parser.ts:102-107` | Nature RSS fetch |
| `src/parsers/article-parser.ts` | Article page parser |

## 状态

待决策方案
