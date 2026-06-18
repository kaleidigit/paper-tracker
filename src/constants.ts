/**
 * constants.ts — 全局常量（消除魔法数字）
 *
 * 所有阈值集中定义，调整时只需改一处。
 */

/** 有效摘要最低字符数。低于此值视为 editorial/comment/letter 等无摘要文章，
 *  代码层面丢弃 LLM 生成的 abstract_zh，不调翻译。
 *  60 字符可过滤纯书目信息（"Journal, Volume X, Issue Y, June 2026." ~55 chars）
 *  而不误伤任何真实摘要（最短 Significance 声明 ~250 chars）。 */
export const MIN_ABSTRACT_LENGTH = 60;

/** 摘要长度低于此值时尝试 Crossref API 回退补全（OpenAlex 期刊）。 */
export const CROSSREF_FALLBACK_THRESHOLD = 200;

/** RSS 滚动窗口天数，超过此天数的数据目录自动清理。 */
export const RSS_ROLLING_WINDOW_DAYS = 7;

/** HTTP 请求默认超时（毫秒）。RSS feed 抓取、OpenAlex API、文章页面均使用。 */
export const FETCH_TIMEOUT_MS = 30_000;

/** RSS feed 抓取并发数上限。 */
export const RSS_CONCURRENCY = 8;

/** OpenAlex API 宽窗口天数（补偿周刊期刊和索引延迟）。 */
export const OPENALEX_WIDE_WINDOW_DAYS = 30;

/** OpenAlex API 每页返回条数。 */
export const OPENALEX_PAGE_SIZE = 200;
