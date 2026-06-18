/**
 * shared.ts — 采集器共享基础设施（纯函数，无 IO）
 *
 * 供 openalex-parser / rss-parser 共享：
 *   - buildPaper():   ParsedPaper → Paper 工厂函数
 *
 * 期刊配置加载（loadJournals）已移至 config.ts。
 */

import type { Paper } from "../types.js";
import type { ParsedPaper } from "./types.js";
import { normalizeText, dedupeStrings, normalizePublicationType } from "../utils.js";

/** 将采集器标准输出 ParsedPaper 转为内部 Paper 对象 */
export function buildPaper(input: ParsedPaper): Paper {
  const titleEn = normalizeText(input.title);
  const abs = normalizeText(input.abstractOriginal);
  const cls = { groups: [] as { group: string; subtopics: string[] }[], tags: [] as string[] };
  return {
    id: normalizeText(input.doi) || normalizeText(input.url) || `${normalizeText(input.journal)}::${titleEn}`,
    title_en: titleEn,
    title_zh: "",
    authors: dedupeStrings(input.authors),
    author_affiliations: dedupeStrings(input.authorAffiliations),
    author_affil_map: input.authorAffilMap,
    journal: { name: normalizeText(input.journal), source_group: normalizeText(input.sourceGroup || input.journal), sort_order: input.sortOrder },
    published_date: input.publishedDate,
    doi: normalizeText(input.doi),
    url: normalizeText(input.url),
    image_url: normalizeText(input.imageUrl),
    abstract_original: abs,
    abstract_zh: "",
    publication_type: normalizePublicationType(input.publicationType),
    summary_zh: "",
    novelty_points: [],
    main_content: [],
    classification: cls,
    source: { provider: input.sourceProvider, raw_feed: input.rawFeed, raw_record_id: input.rawRecordId }
  };
}
