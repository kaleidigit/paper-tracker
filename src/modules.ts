/**
 * modules.ts — 采集与增强的原子能力
 *
 * 采集：collectRawPapers()  调用采集器，返回去重后的全量 Paper[]
 * 筛选：filterPapers()      LLM 筛选+翻译，返回子集
 * 增强：enrichPapers()      文章页面抓取 + 翻译 + 分类，返回 Paper[]
 *
 * 文件输出、流程编排由 pipeline.ts / cli.ts 负责。
 * LLM 调用由 llm.ts 负责。
 */

import fs from "node:fs/promises";
import pLimit from "p-limit";
import { z } from "zod";
import { logEvent } from "./logger.js";
import { resolvePath } from "./config.js";
import type { AppConfig, JsonRecord, Paper, TaxonomyGroup } from "./types.js";

import { RssParser } from "./parsers/nature-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import { enrichRssPaper, fetchCrossrefAbstract } from "./parsers/nature-parser.js";
import { llmFilterAndTranslate, llmFilterAndTranslateBatch, translatePaperFields, classifyPaper, classifyPapersBatch } from "./llm.js";
import {
  normalizeText, itemKey, normalizePublicationType, shouldSkipLlmRescueByTitle, isPrimarilyChinese,
  retry
} from "./utils.js";


const ClassificationSchema = z.object({
  groups: z.array(z.object({
    name: z.string(),
    subtopics: z.array(z.object({
      name: z.string(),
      keywords: z.array(z.string()).optional().default([])
    })).optional().default([])
  })).optional(),
  domains: z.array(z.object({
    name: z.string(),
    subtopics: z.array(z.object({
      name: z.string(),
      keywords: z.array(z.string()).optional().default([])
    })).optional().default([])
  })).optional(),
});

const FALLBACK_CLASSIFICATION = { groups: [{ group: "未分类", subtopics: [] as string[] }], tags: [] as string[] } as Paper["classification"];

// ─── Taxonomy ──────────────────────────────────────────────

export async function loadTaxonomy(config: AppConfig): Promise<TaxonomyGroup[]> {
  const file = resolvePath(config.classification?.file || "profiles/top/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = ClassificationSchema.parse(JSON.parse(raw));
  if (Array.isArray(parsed.groups) && parsed.groups.length > 0) return parsed.groups as TaxonomyGroup[];
  if (Array.isArray(parsed.domains)) return parsed.domains as TaxonomyGroup[];
  return [];
}

// ─── Collect ───────────────────────────────────────────────

export async function collectRawPapers(config: AppConfig, taxonomy?: TaxonomyGroup[]): Promise<Paper[]> {
  const tax = taxonomy || await loadTaxonomy(config);
  const [naturePapers, openalexPapers] = await Promise.all([
    new RssParser().collect(config, tax),
    new OpenAlexParser().collect(config, tax)
  ]);

  const seen = new Set<string>();
  return [...naturePapers, ...openalexPapers]
    .filter((p) => {
      const key = itemKey(p);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${b.published_date}`.localeCompare(`${a.published_date}`));
}

// ─── Filter ────────────────────────────────────────────────

export async function filterPapers(
  config: AppConfig,
  taxonomy: TaxonomyGroup[],
  papers: Paper[]
): Promise<Paper[]> {
  const llmQueue: Paper[] = [...papers];

  const llmPassed: Paper[] = [];
  if (llmQueue.length === 0) return llmPassed;

  const batchSize = Math.max(1, (config.ai?.filter?.batch_size as number) ?? 3);
  const batches: Paper[][] = [];
  for (let i = 0; i < llmQueue.length; i += batchSize) {
    batches.push(llmQueue.slice(i, i + batchSize));
  }

  const filterConcurrency = Math.max(1, (config.ai?.filter?.concurrency as number) ?? 3);
  const limit = pLimit(filterConcurrency);

  const processBatch = async (batch: Paper[]): Promise<Array<JsonRecord & { title_zh?: string; abstract_zh?: string }>> => {
    try {
      return await llmFilterAndTranslateBatch(config, batch);
    } catch {
      logEvent("WARN", "workflow.filter.batch_fallback", { size: batch.length });
      const fallbackResults: Array<JsonRecord & { title_zh?: string; abstract_zh?: string }> = [];
      for (const p of batch) {
        let result: JsonRecord & { title_zh?: string; abstract_zh?: string } | undefined;
        try {
          result = await retry(() => llmFilterAndTranslate(config, p), {
            maxAttempts: 2,
            baseDelayMs: 10000,
            onRetry: (_attempt, _delay, err) => {
              logEvent("WARN", "workflow.filter.llm_retry", { title: p.title_en, error: String(err) });
            }
          });
        } catch (err) {
          logEvent("WARN", "workflow.filter.llm_error", { title: p.title_en, error: String(err) });
        }
        if (result && !Boolean(result.keep)) {
          logEvent("INFO", "workflow.filter.llm_reject", { title: p.title_en });
        }
        fallbackResults.push(result || { used: true, keep: false, confidence: 0 });
      }
      return fallbackResults;
    }
  };

  const batchResults = await Promise.all(batches.map((batch) => limit(() => processBatch(batch))));

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchRes = batchResults[bi];
    for (let pi = 0; pi < batchRes.length; pi++) {
      const filterResult = batchRes[pi];
      if (filterResult && !Boolean(filterResult.keep)) continue;
      const paper = batch[pi];
      // 无有效摘要时不采用 LLM 生成的 abstract_zh（避免模型根据标题编造）
      const hasAbstract = (paper.abstract_original || "").trim().length >= 60;
      llmPassed.push({
        ...paper,
        title_zh: filterResult?.title_zh || "",
        abstract_zh: hasAbstract ? (filterResult?.abstract_zh || "") : ""
      });
    }
  }

  return llmPassed;
}

// ─── Enrich ────────────────────────────────────────────────

async function enrichOne(config: AppConfig, paper: Paper): Promise<Paper> {
  if (shouldSkipLlmRescueByTitle(paper.title_en)) {
    return { ...paper, title_zh: "", abstract_zh: "", summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
  }
  if (config.ai?.enrich?.enabled === false) {
    return {
      ...paper,
      title_zh: normalizeText(paper.title_zh || paper.title_en || ""),
      abstract_zh: normalizeText(paper.abstract_zh || paper.abstract_original || ""),
      summary_zh: "", novelty_points: [], main_content: [],
      publication_type: normalizePublicationType(paper.publication_type),
      classification: FALLBACK_CLASSIFICATION
    };
  }
  if (isPrimarilyChinese(paper.title_en || "") || isPrimarilyChinese(paper.abstract_original || "")) {
    return {
      ...paper,
      title_zh: normalizeText(paper.title_en || ""),
      abstract_zh: normalizeText(paper.abstract_original || ""),
      publication_type: normalizePublicationType(paper.publication_type),
      summary_zh: "", novelty_points: [], main_content: [],
      classification: undefined
    };
  }

  // 摘要过短时尝试外部数据源补全（Crossref API）
  let enriched = paper;
  const abstractLen = (paper.abstract_original || "").trim().length;
  if (abstractLen < 200 && paper.doi) {
    const crossrefAbstract = await fetchCrossrefAbstract(paper.doi);
    if (crossrefAbstract.length > abstractLen) {
      enriched = { ...paper, abstract_original: crossrefAbstract, abstract_zh: "", title_zh: "" };
      logEvent("INFO", "workflow.enrich.crossref_abstract", { title: paper.title_en, old_len: abstractLen, new_len: crossrefAbstract.length });
    }
  }

  // 无有效摘要（< 60 字符，如 editorial/comment 或仅有书目信息）→ 不做摘要翻译，避免 LLM 根据标题编造
  const effectiveAbsLen = (enriched.abstract_original || "").trim().length;
  const hasEffectiveAbstract = effectiveAbsLen >= 60;

  const hasTranslation = Boolean(enriched.title_zh) && Boolean(enriched.abstract_zh);
  if (hasTranslation) {
    return { ...enriched, publication_type: normalizePublicationType(enriched.publication_type), summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
  }

  // 无有效摘要 + 标题已有翻译 → 直接返回，不调 LLM
  if (!hasEffectiveAbstract && enriched.title_zh) {
    return { ...enriched, abstract_zh: "", publication_type: normalizePublicationType(enriched.publication_type), summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
  }

  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: enriched.title_zh || "", abstract_zh: "" };
  let translationError = "";
  try {
    translated = await retry(
      () => translatePaperFields(config, enriched),
      {
        maxAttempts: 3, baseDelayMs: 5000,
        onRetry: (_attempt, _delay, error) => {
          logEvent("WARN", "workflow.enrich.retry", { title: enriched.title_en, phase: "translation", error: String(error), attempt: _attempt });
        }
      }
    );
    if (Boolean(enriched.title_en) && !translated.title_zh) {
      throw new Error("translation_title_missing");
    }
  } catch (error) {
    translationError = String(error);
  }
  if (config.ai?.translation?.required && !translated.title_zh && Boolean(enriched.title_en)) {
    throw new Error(`translation_required_failed: ${translationError}`);
  }
  // 无有效摘要时丢弃 LLM 可能返回的虚假 abstract_zh
  const finalAbstractZh = hasEffectiveAbstract ? (translated.abstract_zh || enriched.abstract_zh || "") : "";
  const merged = { ...enriched, title_zh: translated.title_zh || enriched.title_zh || "", abstract_zh: finalAbstractZh };
  return { ...merged, publication_type: normalizePublicationType(enriched.publication_type), translation_error: translationError || undefined, summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
}

export async function enrichPapers(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const concurrency = Math.max(1, config.ai?.enrich?.concurrency ?? 5);
  const limit = pLimit(concurrency);

  // Phase 0: Scrape article pages for RSS papers (deferred from collect to after filter)
  const scraped: Paper[] = new Array(papers.length);
  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    if (paper.source?.provider === "rss") {
      scraped[i] = await limit(() => enrichRssPaper(paper));
    } else {
      scraped[i] = paper;
    }
  }

  // Phase 1: preprocess (translate/normalize) — concurrent
  const preprocessed: Paper[] = new Array(scraped.length);
  for (let i = 0; i < scraped.length; i++) {
    const paper = scraped[i];
    if (shouldSkipLlmRescueByTitle(paper.title_en)) {
      preprocessed[i] = { ...paper, title_zh: "", abstract_zh: "", summary_zh: "", novelty_points: [], main_content: [] };
      continue;
    }
    try {
      preprocessed[i] = await limit(() => enrichOne(config, paper));
    } catch (error) {
      preprocessed[i] = { ...paper, enrich_error: String(error) };
    }
  }

  // Phase 2: batch classify
  const toClassify: number[] = [];
  for (let i = 0; i < preprocessed.length; i++) {
    if (!preprocessed[i].classification) toClassify.push(i);
  }
  if (toClassify.length > 0) {
    const batchSize = Math.max(1, (config.ai?.enrich?.classify_batch_size as number) ?? (config.ai?.filter?.batch_size as number) ?? 3);
    const classifyConcurrency = Math.max(1, Math.floor(concurrency / 2)) || 1;
    const classifyLimit = pLimit(classifyConcurrency);
    const batches: Array<{ indices: number[]; papers: Paper[] }> = [];
    for (let bi = 0; bi < toClassify.length; bi += batchSize) {
      const indices = toClassify.slice(bi, bi + batchSize);
      batches.push({ indices, papers: indices.map((idx) => preprocessed[idx]) });
    }
    const batchResults = await Promise.all(batches.map((b) =>
      classifyLimit(async () => {
        try {
          const classifications = await classifyPapersBatch(config, b.papers, taxonomy);
          return { classifications, indices: b.indices } as const;
        } catch {
          logEvent("WARN", "workflow.enrich.batch_classify_fallback", { batch_size: b.papers.length });
          const fallback: Paper["classification"][] = [];
          for (const idx of b.indices) {
            try {
              fallback.push({ ...(await retry(
                () => classifyPaper(config, preprocessed[idx], taxonomy),
                { maxAttempts: 3, baseDelayMs: 5000,
                  onRetry: (_a, _d, e) => logEvent("WARN", "workflow.enrich.retry", { title: preprocessed[idx].title_en, phase: "classification", error: String(e), attempt: _a }) }
              )) });
            } catch { fallback.push(FALLBACK_CLASSIFICATION); }
          }
          return { classifications: fallback, indices: b.indices } as const;
        }
      })
    ));
    for (const { classifications, indices } of batchResults) {
      for (let pi = 0; pi < classifications.length; pi++) {
        preprocessed[indices[pi]].classification = classifications[pi] || FALLBACK_CLASSIFICATION;
      }
    }
  }

  return preprocessed;
}
