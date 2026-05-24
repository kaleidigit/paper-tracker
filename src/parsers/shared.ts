/**
 * shared.ts — 采集器共享基础设施
 *
 * 供 openalex-parser / nature-parser 共享：
 *   - loadJournals(): 加载期刊配置
 *   - buildPaper():   ParsedPaper → Paper 工厂函数
 */

import fs from "node:fs/promises";
import { z } from "zod";
import type { AppConfig, Paper } from "../types.js";
import type { JournalEntry, ParsedPaper } from "./types.js";
import { normalizeText, dedupeStrings, resolvePath, normalizePublicationType } from "../utils.js";

const JournalEntrySchema = z.object({
  name: z.string(),
  source_group: z.string(),
  issn: z.string().optional(),
  publisher_strategy: z.string().optional(),
  rss_feeds: z.array(z.string()).optional(),
  sort_order: z.number().optional(),
});

/** 从 config.sources.journals_file 加载期刊列表 */
export async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "profiles/top/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`journals file is not an array: ${file}`);
  return z.array(JournalEntrySchema).parse(parsed);
}

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
