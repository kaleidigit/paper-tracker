/**
 * openalex-parser.ts
 * OpenAlex API 采集器：为 Science / PNAS / Joule / EES 等期刊提供元数据
 * 优势：完整作者列表、单位、摘要；免费公开 API
 */

import fs from "node:fs/promises";
import type { AppConfig, JsonRecord, Paper } from "../types.js";
import type { FilterBudget, JournalEntry, ParsedPaper } from "./types.js";
import {
  normalizeText, dedupeStrings, toArray, resolvePath,
  fetchJson, parseDate, strictWindowStartAt, formatDateInTz,
  matchesKeywords, shouldSkipLlmRescueByTitle, restoreAbstract,
  heuristicClassification, normalizePublicationType
} from "../utils.js";
import { llmFilter } from "../llm.js";
import { loadTaxonomy } from "../modules.js";

async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "profiles/top-journal-env-energy/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function buildPaper(input: ParsedPaper): Paper {
  const titleEn = normalizeText(input.title);
  const abs = normalizeText(input.abstractOriginal);
  const cls = heuristicClassification(`${titleEn} ${abs} ${input.journal}`, input.taxonomy);
  return {
    id: normalizeText(input.doi) || normalizeText(input.url) || `${normalizeText(input.journal)}::${titleEn}`,
    title_en: titleEn,
    title_zh: "",
    authors: dedupeStrings(input.authors),
    author_affiliations: dedupeStrings(input.authorAffiliations),
    journal: { name: normalizeText(input.journal), source_group: normalizeText(input.sourceGroup || input.journal) },
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

export class OpenAlexParser {
  async collect(config: AppConfig, taxonomy: Array<Record<string, unknown>>, filterBudget: FilterBudget): Promise<Paper[]> {
    // ========== 阶段1：全量采集 ==========
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.start", phase: "full_collection", source: "openalex" })}\n`);
    const rawPapers = await this.collectAllRawPapers(config, taxonomy);
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.done", collected: rawPapers.length, source: "openalex" })}\n`);

    // ========== 阶段2：逐一筛选 ==========
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase2.start", phase: "llm_filtering", source: "openalex" })}\n`);
    const filteredPapers = await this.filterPapersWithLLM(config, rawPapers, taxonomy, filterBudget);
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase2.done", filtered: filteredPapers.length, rejected: rawPapers.length - filteredPapers.length, source: "openalex" })}\n`);

    return filteredPapers;
  }

  private async collectAllRawPapers(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
    const journals = await loadJournals(config);
    const issns = dedupeStrings(
      journals
        .filter((j) => normalizeText(j.publisher_strategy) === "openalex")
        .map((j) => normalizeText(j.issn))
        .filter(Boolean)
    );

    if (issns.length === 0) return [];

    const queries = toArray(config.sources?.openalex_queries).length
      ? (config.sources?.openalex_queries as string[])
      : ["energy", "climate"];

    const windowStart = strictWindowStartAt(config);
    const startDate = formatDateInTz(windowStart, "UTC");
    const select = "id,title,doi,publication_date,type,authorships,primary_location,abstract_inverted_index";
    const papers: Paper[] = [];
    const timeoutMs = 30000;

    // OpenAlex 日期窗口放宽到 30 天：Science/PNAS 等每周仅出 1-2 期，
    // 短窗口会漏掉大量论文，由后端关键词+LLM 过滤精选
    // 采集后按 windowStart 过滤，确保只保留窗口内的论文
    const wideStartDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const baseFilters = [`from_publication_date:${wideStartDate}`, "type:article"];
    if (issns.length > 0) {
      baseFilters.push(`primary_location.source.issn:${issns.join("|")}`);
    }

    for (const query of queries) {
      const url =
        "https://api.openalex.org/works?per-page=25&sort=publication_date:desc" +
        `&filter=${encodeURIComponent(baseFilters.join(","))}` +
        `&search=${encodeURIComponent(query)}` +
        `&select=${encodeURIComponent(select)}`;

      process.stdout.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.openalex.start", query })}\n`
      );
      let payload: JsonRecord = {};
      try {
        payload = await fetchJson(url, timeoutMs);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.fetch.openalex.failed", query })}\n`
        );
        continue;
      }

      const results = toArray(payload.results as JsonRecord[] | undefined);
      for (const item of results) {
        const source = (item.primary_location as JsonRecord | undefined)?.source as JsonRecord | undefined;
        const journal = normalizeText(source?.display_name);
        const title = normalizeText(item.title);
        const abstract = normalizeText(restoreAbstract(item.abstract_inverted_index as Record<string, number[]> | undefined));
        const publishedDate = parseDate(item.publication_date);

        // 独立检查：correction/retraction 等特殊内容不进入日报
        if (shouldSkipLlmRescueByTitle(title)) continue;

        const authorships = toArray(item.authorships as JsonRecord[] | undefined);
        const authorAffiliations = dedupeStrings(
          authorships.flatMap((a) =>
            toArray((a.institutions as JsonRecord[] | undefined)?.map((inst) => normalizeText(inst.display_name))).filter(Boolean)
          )
        );

        papers.push(
          buildPaper({
            title,
            authors: authorships.map((a) => normalizeText(((a.author as JsonRecord | undefined)?.display_name) || "")),
            authorAffiliations,
            journal: journal || "Unknown Journal",
            sourceGroup: normalizeText(source?.host_organization_name || journal),
            publishedDate,
            doi: normalizeText(item.doi),
            url: normalizeText(item.doi || item.id),
            abstractOriginal: abstract,
            imageUrl: "",
            publicationType: normalizeText(item.type),
            sourceProvider: "openalex",
            rawFeed: "https://api.openalex.org/works",
            rawRecordId: normalizeText(item.id),
            taxonomy
          })
        );
      }

      process.stdout.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.openalex.done", query, papers: papers.length })}\n`
      );
    }

    // 按 windowStart 过滤，去掉窗口外的论文
    const windowCutoff = startDate; // YYYY-MM-DD 格式
    const beforeFilter = papers.length;
    const filtered = papers.filter((p) => !p.published_date || p.published_date >= windowCutoff);
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.openalex.date_filtered", before: beforeFilter, after: filtered.length, window_start: windowCutoff })}\n`
    );

    return filtered;
  }

  private async filterPapersWithLLM(config: AppConfig, papers: Paper[], taxonomy: Array<Record<string, unknown>>, filterBudget: FilterBudget): Promise<Paper[]> {
    const filtered: Paper[] = [];

    for (const paper of papers) {
      // 关键词匹配检查
      if (!matchesKeywords(config, paper.title_en || "", paper.abstract_original || "", paper.journal?.name || "")) {
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.keyword_reject", title: paper.title_en, source: "openalex" })}\n`);
        continue;
      }

      // LLM筛选
      if (filterBudget.remaining > 0) {
        filterBudget.remaining -= 1;
        const filterResult = await llmFilter(config, taxonomy, paper);
        if (!Boolean(filterResult.keep)) {
          continue;
        }
      }

      filtered.push(paper);
    }

    return filtered;
  }
}
