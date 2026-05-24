/**
 * modules.ts — 采集与增强的原子能力
 *
 * 采集：collectRawPapers()  调用采集器，返回去重后的全量 Paper[]
 * 筛选：filterPapers()      关键词 + LLM 筛选，返回子集
 * 采集+筛选：fetchPapers()  collectRawPapers + filterPapers（兼容 run-once 模式）
 * 增强：enrichPapers()      翻译 + 分类，返回 Paper[]
 *
 * 文件输出、流程编排由 pipeline.ts / cli.ts 负责。
 * 飞书发布由 publish.ts 负责。
 * LLM 调用由 llm.ts 负责。
 * Markdown 生成由 digest.ts 负责。
 */

import fs from "node:fs/promises";
import pLimit from "p-limit";
import { z } from "zod";
import { logEvent } from "./logger.js";
import { resolvePath, applyDefaults } from "./config.js";
import type { AppConfig, JsonRecord, Paper } from "./types.js";


import { NatureParser } from "./parsers/nature-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import { llmFilterAndTranslate, llmFilterAndTranslateBatch, translatePaperFields, classifyPaper, classifyPapersBatch } from "./llm.js";
import { buildDigestTitle, buildMarkdown, buildRecords } from "./digest.js";

import { publishDigest, sendAlert } from "./publish.js";
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

export async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "profiles/top/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = ClassificationSchema.parse(JSON.parse(raw));
  if (Array.isArray(parsed.groups) && parsed.groups.length > 0) return parsed.groups as Array<Record<string, unknown>>;
  if (Array.isArray(parsed.domains)) return parsed.domains as Array<Record<string, unknown>>;
  return [];
}

// ─── Collect ───────────────────────────────────────────────

/** 阶段1：全量采集（不做筛选），返回去重+排序后的 Paper[] */
export async function collectRawPapers(config: AppConfig, taxonomy?: Array<Record<string, unknown>>): Promise<Paper[]> {
  const tax = taxonomy || await loadTaxonomy(config);
  const [naturePapers, openalexPapers] = await Promise.all([
    new NatureParser().collect(config, tax),
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

/** 阶段2：LLM 筛选，返回通过筛选的 Paper[] 子集 */
export async function filterPapers(
  config: AppConfig,
  taxonomy: Array<Record<string, unknown>>,
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

  const limit = pLimit(3);

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
      llmPassed.push({
        ...paper,
        title_zh: filterResult?.title_zh || "",
        abstract_zh: filterResult?.abstract_zh || ""
      });
    }
  }

  return llmPassed;
}

/** 完整采集流程：全量采集 + 筛选（兼容 run-once 模式） */
export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const raw = await collectRawPapers(config, taxonomy);
  return filterPapers(config, taxonomy, raw);
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
  // 中文期刊无需翻译，直接复用原文
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
  // 如果筛选阶段已合并完成翻译，跳过翻译
  const hasTranslation = Boolean(paper.title_zh) && Boolean(paper.abstract_zh);
  if (hasTranslation) {
    return { ...paper, publication_type: normalizePublicationType(paper.publication_type), summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
  }

  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
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
    if ((Boolean(paper.title_en) && !translated.title_zh) || (Boolean(paper.abstract_original) && !translated.abstract_zh)) {
      throw new Error("translation_partial_output");
    }
  } catch (error) {
    translationError = String(error);
  }
  if (config.ai?.translation?.required && !translated.title_zh && Boolean(paper.title_en)) {
    throw new Error(`translation_required_failed: ${translationError}`);
  }
  const merged = { ...paper, title_zh: translated.title_zh || paper.title_zh || "", abstract_zh: translated.abstract_zh || paper.abstract_zh || "" };
  return { ...merged, publication_type: normalizePublicationType(paper.publication_type), translation_error: translationError || undefined, summary_zh: "", novelty_points: [], main_content: [], classification: undefined };
}

export async function enrichPapers(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const concurrency = Math.max(1, config.ai?.enrich?.concurrency ?? 3);
  const limit = pLimit(concurrency);

  // Phase 1: preprocess (translate/normalize) — concurrent
  const preprocessed: Paper[] = new Array(papers.length);
  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
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
    const batchSize = Math.max(1, (config.ai?.filter?.batch_size as number) ?? 3);
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

// ─── Workflow（兼容 cli.ts run-once 模式） ──────────────────

export class EmptyPapersError extends Error {
  constructor(message = "未获取到任何论文数据") {
    super(message);
    this.name = "EmptyPapersError";
  }

}
export async function runWorkflow(config: AppConfig) {
  applyDefaults(config);
  const maxAttempts = Math.max(1, config.runtime.retry.max_attempts);
  const backoffMs = Math.max(0, config.runtime.retry.backoff_ms);
  const title = buildDigestTitle(config);

  const papers = await retry(() => fetchPapers(config), { maxAttempts, baseDelayMs: backoffMs });
  if (papers.length === 0) throw new EmptyPapersError();

  const enriched = await retry(() => enrichPapers(config, papers), { maxAttempts, baseDelayMs: backoffMs });
  const payload = { title, markdown: buildMarkdown(title, enriched), records: buildRecords(enriched), papers: enriched };
  const publishResult = await retry(() => publishDigest(config, payload), { maxAttempts, baseDelayMs: backoffMs });
  return { payload, publishResult };
}
export async function sendEmptyPapersAlert(config: AppConfig): Promise<void> {
  await sendAlert(config, "未获取到任何论文数据，已终止日报推送，请排查抓取源、时间窗口与过滤配置。");
}
