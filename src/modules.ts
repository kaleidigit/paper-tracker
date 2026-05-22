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
import { resolvePath, applyDefaults } from "./config.js";
import type { AppConfig, Paper } from "./types.js";
import { NatureParser } from "./parsers/nature-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import type { FilterBudget } from "./parsers/types.js";
import { llmFilter, translatePaperFields, classifyPaper } from "./llm.js";
import { buildDigestTitle, buildMarkdown, buildRecords } from "./digest.js";
import { publishDigest, sendAlert } from "./publish.js";
import {
  normalizeText, itemKey, matchesKeywords, normalizePublicationType, shouldSkipLlmRescueByTitle, isPrimarilyChinese
} from "./utils.js";

// ─── Taxonomy ──────────────────────────────────────────────

export async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "profiles/top/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { groups?: Array<Record<string, unknown>>; domains?: Array<Record<string, unknown>> };
  if (Array.isArray(parsed.groups) && parsed.groups.length > 0) return parsed.groups;
  if (Array.isArray(parsed.domains)) return parsed.domains;
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

/** 阶段2：关键词预筛 + LLM 精筛，返回通过筛选的 Paper[] 子集 */
export async function filterPapers(
  config: AppConfig,
  taxonomy: Array<Record<string, unknown>>,
  papers: Paper[],
  filterBudget: FilterBudget
): Promise<Paper[]> {
  const filtered: Paper[] = [];

  for (const paper of papers) {
    // 关键词匹配检查（排除词优先，包含词至少命中一个）
    if (!matchesKeywords(config, paper.title_en || "", paper.abstract_original || "", paper.journal?.name || "")) {
      process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.filter.keyword_reject", title: paper.title_en })}\n`);
      continue;
    }

    // LLM 筛选（失败重试一次）
    if (filterBudget.remaining > 0) {
      filterBudget.remaining -= 1;
      let filterResult: import("./types.js").JsonRecord | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          filterResult = await llmFilter(config, taxonomy, paper);
          break;
        } catch (error) {
          if (attempt === 0) {
            process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.filter.llm_retry", title: paper.title_en, error: String(error) })}\n`);
            await new Promise((r) => setTimeout(r, 10_000));
          } else {
            process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.filter.llm_error", title: paper.title_en, error: String(error) })}\n`);
          }
        }
      }
      if (filterResult && !Boolean(filterResult.keep)) {
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.filter.llm_reject", title: paper.title_en })}\n`);
        continue;
      }
    }

    filtered.push(paper);
  }

  return filtered;
}

/** 完整采集流程：全量采集 + 筛选（兼容 run-once 模式） */
export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const budget: FilterBudget = { remaining: Math.max(0, Number(config.ai?.filter?.max_checks_per_run ?? 20)) };
  const raw = await collectRawPapers(config, taxonomy);
  return filterPapers(config, taxonomy, raw, budget);
}

// ─── Enrich ────────────────────────────────────────────────

async function enrichOne(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper> {
  if (shouldSkipLlmRescueByTitle(paper.title_en)) {
    return { ...paper, title_zh: "", abstract_zh: "", summary_zh: "", novelty_points: [], main_content: [] };
  }
  if (config.ai?.enrich?.enabled === false) {
    return {
      ...paper,
      title_zh: normalizeText(paper.title_zh || paper.title_en || ""),
      abstract_zh: normalizeText(paper.abstract_zh || paper.abstract_original || ""),
      summary_zh: "", novelty_points: [], main_content: [],
      publication_type: normalizePublicationType(paper.publication_type),
      classification: paper.classification || { groups: [{ group: "未分类", subtopics: [] }], tags: [] }
    };
  }
  // 中文期刊无需翻译，直接复用原文
  if (isPrimarilyChinese(paper.title_en || "") || isPrimarilyChinese(paper.abstract_original || "")) {
    const merged = {
      ...paper,
      title_zh: normalizeText(paper.title_en || ""),
      abstract_zh: normalizeText(paper.abstract_original || "")
    };
    let classification = merged.classification || { groups: [{ group: "未分类", subtopics: [] }], tags: [] };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        classification = { ...(await classifyPaper(config, merged, taxonomy)) };
        break;
      } catch (error) {
        if (attempt < 2) {
          const delay = 5_000 * (2 ** attempt) * (0.75 + Math.random() * 0.5);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    return { ...merged, publication_type: normalizePublicationType(paper.publication_type), summary_zh: "", novelty_points: [], main_content: [], classification };
  }

  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  let translationError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      translated = await translatePaperFields(config, paper);
      if ((Boolean(paper.title_en) && !translated.title_zh) || (Boolean(paper.abstract_original) && !translated.abstract_zh)) {
        throw new Error("translation_partial_output");
      }
      translationError = "";
      break;
    } catch (error) {
      translationError = String(error);
      if (attempt < 2) {
        const delay = 5_000 * (2 ** attempt) * (0.75 + Math.random() * 0.5);
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.enrich.retry", title: paper.title_en, phase: "translation", error: translationError, attempt: attempt + 1 })}\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  if (config.ai?.translation?.required && !translated.title_zh && Boolean(paper.title_en)) {
    throw new Error(`translation_required_failed: ${translationError}`);
  }
  const merged = { ...paper, title_zh: translated.title_zh || paper.title_zh || "", abstract_zh: translated.abstract_zh || paper.abstract_zh || "" };
  let classification = merged.classification || { groups: [{ group: "未分类", subtopics: [] }], tags: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      classification = { ...(await classifyPaper(config, merged, taxonomy)) };
      break;
    } catch (error) {
      if (attempt < 2) {
        const delay = 5_000 * (2 ** attempt) * (0.75 + Math.random() * 0.5);
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.enrich.retry", title: paper.title_en, phase: "classification", error: String(error), attempt: attempt + 1 })}\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return { ...merged, publication_type: normalizePublicationType(paper.publication_type), translation_error: translationError || undefined, summary_zh: "", novelty_points: [], main_content: [], classification };
}

export async function enrichPapers(config: AppConfig, papers: Paper[]): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const concurrency = Math.max(1, config.ai?.enrich?.concurrency ?? 3);
  const limit = pLimit(concurrency);
  const output: Paper[] = [];
  for (let i = 0; i < papers.length; i++) {
    const paper = papers[i];
    if (shouldSkipLlmRescueByTitle(paper.title_en)) {
      output.push({ ...paper, title_zh: "", abstract_zh: "", summary_zh: "", novelty_points: [], main_content: [] });
      continue;
    }
    try {
      output.push(await limit(() => enrichOne(config, paper, taxonomy)));
    } catch (error) {
      output.push({ ...paper, enrich_error: String(error) });
    }
  }
  return output;
}

// ─── Workflow（兼容 cli.ts run-once 模式） ──────────────────

export class EmptyPapersError extends Error {
  constructor(message = "未获取到任何论文数据") {
    super(message);
    this.name = "EmptyPapersError";
  }
}

async function withRetry<T>(max: number, backoffMs: number, job: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= max; i++) {
    try { return await job(); } catch (e) { last = e; if (i === max) break; await new Promise((r) => setTimeout(r, backoffMs)); }
  }
  throw last;
}

export async function runWorkflow(config: AppConfig) {
  applyDefaults(config);
  const attempts = Math.max(1, config.runtime.retry.max_attempts);
  const backoff = Math.max(0, config.runtime.retry.backoff_ms);
  const title = buildDigestTitle(config);

  const papers = await withRetry(attempts, backoff, () => fetchPapers(config));
  if (papers.length === 0) throw new EmptyPapersError();

  const enriched = await withRetry(attempts, backoff, () => enrichPapers(config, papers));
  const payload = { title, markdown: buildMarkdown(title, enriched), records: buildRecords(enriched), papers: enriched };
  const publishResult = await withRetry(attempts, backoff, () => publishDigest(config, payload));
  return { payload, publishResult };
}

export async function sendEmptyPapersAlert(config: AppConfig): Promise<void> {
  await sendAlert(config, "未获取到任何论文数据，已终止日报推送，请排查抓取源、时间窗口与过滤配置。");
}
