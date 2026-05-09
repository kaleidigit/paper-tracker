/**
 * modules.ts — 采集与增强的原子能力
 *
 * 采集：fetchPapers()   调用采集器，返回去重后的 Paper[]
 * 增强：enrichPapers()  翻译 + 分类，返回 Paper[]
 *
 * 文件输出、流程编排由 pipeline.ts / cli.ts 负责。
 * 飞书发布由 publish.ts 负责。
 * LLM 调用由 llm.ts 负责。
 * Markdown 生成由 digest.ts 负责。
 */

import fs from "node:fs/promises";
import pLimit from "p-limit";
import { resolvePath } from "./config.js";
import type { AppConfig, Paper } from "./types.js";
import { NatureParser } from "./parsers/nature-parser.js";
import { OpenAlexParser } from "./parsers/openalex-parser.js";
import { llmFilter, translatePaperFields, classifyPaper } from "./llm.js";
import { buildDigestTitle, buildMarkdown, buildRecords } from "./digest.js";
import { publishDigest, sendAlert } from "./publish.js";
import {
  normalizeText, itemKey, normalizePublicationType, shouldSkipLlmRescueByTitle
} from "./utils.js";

// ─── Taxonomy ──────────────────────────────────────────────

export async function loadTaxonomy(config: AppConfig): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "profiles/top-journal-env-energy/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { domains?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.domains) ? parsed.domains : [];
}

// ─── Collect ───────────────────────────────────────────────

export async function fetchPapers(config: AppConfig): Promise<Paper[]> {
  const taxonomy = await loadTaxonomy(config);
  const filterBudget = { remaining: Math.max(0, Number(config.ai?.filter?.max_checks_per_run ?? 20)) };

  const [naturePapers, openalexPapers] = await Promise.all([
    new NatureParser().collect(config, taxonomy, filterBudget),
    new OpenAlexParser().collect(config, taxonomy, filterBudget)
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
      classification: paper.classification || { domain: "未分类", subdomain: "未分类", tags: [] }
    };
  }
  let translated: Pick<Paper, "title_zh" | "abstract_zh"> = { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  let translationError = "";
  try {
    translated = await translatePaperFields(config, paper);
    if ((Boolean(paper.title_en) && !translated.title_zh) || (Boolean(paper.abstract_original) && !translated.abstract_zh)) {
      throw new Error("translation_partial_output");
    }
  } catch (error) {
    translationError = String(error);
    if (config.ai?.translation?.required && !translated.title_zh && Boolean(paper.title_en)) {
      throw new Error(`translation_required_failed: ${translationError}`);
    }
  }
  const merged = { ...paper, title_zh: translated.title_zh || paper.title_zh || "", abstract_zh: translated.abstract_zh || paper.abstract_zh || "" };
  let classification = merged.classification || { domain: "未分类", subdomain: "未分类", tags: [] };
  try { classification = { ...(await classifyPaper(config, merged, taxonomy)) }; } catch { /* fallback to heuristic */ }
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
