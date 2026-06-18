/**
 * modules.ts — 采集与增强的原子能力（纯函数，无 IO）
 *
 * 采集：collectRawPapers()  调用采集器，返回去重后的全量 Paper[]
 * 筛选：filterPapers()      LLM 筛选+翻译，返回子集
 * 增强：enrichPapers()      文章页面抓取 + 翻译 + 分类，返回 Paper[]
 *
 * 所有文件 IO、分类/期刊配置加载统一由 pipeline.ts / config.ts 负责。
 * LLM 调用由 llm.ts 负责。
 */

import pLimit from "p-limit";
import { logEvent } from "./logger.js";
import { MIN_ABSTRACT_LENGTH, CROSSREF_FALLBACK_THRESHOLD } from "./constants.js";
import type { AppConfig, JsonRecord, Paper, TaxonomyGroup } from "./types.js";

import { RssParser } from "./parsers/rss-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import { enrichRssPaper, fetchCrossrefAbstract } from "./parsers/rss-parser.js";
import { llmFilterAndTranslate, llmFilterAndTranslateBatch, translatePaperFields, classifyPaper, classifyPapersBatch } from "./llm.js";
import {
  normalizeText, itemKey, normalizePublicationType, shouldSkipLlmRescueByTitle, isPrimarilyChinese,
  retry
} from "./utils.js";


const FALLBACK_CLASSIFICATION = { groups: [{ group: "未分类", subtopics: [] as string[] }], tags: [] as string[] } as Paper["classification"];

// ─── Collect ───────────────────────────────────────────────

export async function collectRawPapers(config: AppConfig, taxonomy: TaxonomyGroup[]): Promise<Paper[]> {
  const [naturePapers, openalexPapers] = await Promise.all([
    new RssParser().collect(config, taxonomy),
    new OpenAlexParser().collect(config, taxonomy)
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
      const hasAbstract = (paper.abstract_original || "").trim().length >= MIN_ABSTRACT_LENGTH;
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

/** Phase 1: Attempt Crossref API fallback when the abstract is too short. */
async function resolveAbstract(paper: Paper): Promise<Paper> {
  const abstractLen = (paper.abstract_original || "").trim().length;
  if (abstractLen >= CROSSREF_FALLBACK_THRESHOLD || !paper.doi) return paper;

  const crossrefAbstract = await fetchCrossrefAbstract(paper.doi);
  if (crossrefAbstract.length <= abstractLen) return paper;

  logEvent("INFO", "workflow.enrich.crossref_abstract", {
    title: paper.title_en,
    old_len: abstractLen,
    new_len: crossrefAbstract.length
  });
  return { ...paper, abstract_original: crossrefAbstract, abstract_zh: "", title_zh: "" };
}

/** Phase 2: Translate title/abstract via LLM, with retry and no-abstract guard. */
async function resolveTranslation(config: AppConfig, paper: Paper): Promise<Paper> {
  const hasEffectiveAbstract = (paper.abstract_original || "").trim().length >= MIN_ABSTRACT_LENGTH;

  // Already translated → normalize and return
  if (Boolean(paper.title_zh) && Boolean(paper.abstract_zh)) {
    return {
      ...paper,
      publication_type: normalizePublicationType(paper.publication_type),
      summary_zh: "", novelty_points: [], main_content: [],
      classification: undefined
    };
  }

  // No effective abstract + title already translated → skip LLM, discard fake abstract_zh
  if (!hasEffectiveAbstract && paper.title_zh) {
    return {
      ...paper, abstract_zh: "",
      publication_type: normalizePublicationType(paper.publication_type),
      summary_zh: "", novelty_points: [], main_content: [],
      classification: undefined
    };
  }

  // Call LLM for translation
  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: paper.title_zh || "", abstract_zh: "" };
  let translationError = "";
  try {
    translated = await retry(
      () => translatePaperFields(config, paper),
      {
        maxAttempts: 3, baseDelayMs: 5000,
        onRetry: (_attempt, _delay, error) => {
          logEvent("WARN", "workflow.enrich.retry", { title: paper.title_en, phase: "translation", error: String(error), attempt: _attempt });
        }
      }
    );
    if (Boolean(paper.title_en) && !translated.title_zh) {
      throw new Error("translation_title_missing");
    }
  } catch (error) {
    translationError = String(error);
  }
  if (config.ai?.translation?.required && !translated.title_zh && Boolean(paper.title_en)) {
    throw new Error(`translation_required_failed: ${translationError}`);
  }

  // Discard LLM-generated abstract_zh when there's no effective abstract
  const finalAbstractZh = hasEffectiveAbstract
    ? (translated.abstract_zh || paper.abstract_zh || "")
    : "";

  return {
    ...paper,
    title_zh: translated.title_zh || paper.title_zh || "",
    abstract_zh: finalAbstractZh,
    publication_type: normalizePublicationType(paper.publication_type),
    translation_error: translationError || undefined,
    summary_zh: "", novelty_points: [], main_content: [],
    classification: undefined
  };
}

async function enrichOne(config: AppConfig, paper: Paper): Promise<Paper> {
  // Early exits: papers that don't need LLM processing
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

  const withAbstract = await resolveAbstract(paper);
  return await resolveTranslation(config, withAbstract);
}

export async function enrichPapers(config: AppConfig, papers: Paper[], taxonomy: TaxonomyGroup[]): Promise<Paper[]> {
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
