/**
 * openalex-parser.ts
 * OpenAlex API 采集器：为 Science / PNAS / Joule / EES 等期刊提供元数据
 * 优势：完整作者列表、单位、摘要；免费公开 API
 */

import fs from "node:fs/promises";
import type { AppConfig, JsonRecord, Paper } from "../types.js";
import type { JournalEntry, ParsedPaper } from "./types.js";
import {
  normalizeText, dedupeStrings, toArray, resolvePath,
  fetchJson, parseDate, strictWindowStartAt, formatDateInTz,
  shouldSkipLlmRescueByTitle, restoreAbstract,
  heuristicClassification, normalizePublicationType
} from "../utils.js";
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
    author_affil_map: input.authorAffilMap,
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
  async collect(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.start", phase: "full_collection", source: "openalex" })}\n`);
    const rawPapers = await this.collectAllRawPapers(config, taxonomy);
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.done", collected: rawPapers.length, source: "openalex" })}\n`);

    return rawPapers;
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

    const windowStart = strictWindowStartAt(config);
    const startDate = formatDateInTz(windowStart, "UTC");
    const select = "id,title,doi,publication_date,type,authorships,primary_location,abstract_inverted_index";
    const papers: Paper[] = [];
    const timeoutMs = 30000;
    const perPage = 200;

    // 日期窗口放宽到 30 天（周刊期刊会漏），后端关键词+LLM 精选
    const wideStartDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const baseFilter = [
      `from_publication_date:${wideStartDate}`,
      "type:article",
      `primary_location.source.issn:${issns.join("|")}`
    ].join(",");

    const pageUrl = (page: number) =>
      `https://api.openalex.org/works?per-page=${perPage}&page=${page}&sort=publication_date:desc` +
      `&filter=${encodeURIComponent(baseFilter)}` +
      `&select=${encodeURIComponent(select)}`;

    // 分页拉取全量，直到返回不足一页或空
    for (let page = 1; ; page++) {
      const url = pageUrl(page);
      process.stdout.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.openalex.page", page, issns: issns.length })}\n`
      );

      let payload: JsonRecord = {};
      try {
        payload = await fetchJson(url, timeoutMs);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.fetch.openalex.failed", page })}\n`
        );
        break;
      }

      const results = toArray(payload.results as JsonRecord[] | undefined);
      if (results.length === 0) break;

      for (const item of results) {
        const source = (item.primary_location as JsonRecord | undefined)?.source as JsonRecord | undefined;
        const journal = normalizeText(source?.display_name);
        const title = normalizeText(item.title);
        const abstract = normalizeText(restoreAbstract(item.abstract_inverted_index as Record<string, number[]> | undefined));
        const publishedDate = parseDate(item.publication_date);

        if (shouldSkipLlmRescueByTitle(title)) continue;

        const authorships = toArray(item.authorships as JsonRecord[] | undefined);
        const affIndex = new Map<string, number>();
        const authorAffiliations: string[] = [];
        const authorAffilMap: number[][] = [];
        for (const a of authorships) {
          const authorAffIndices: number[] = [];
          for (const inst of toArray(a.institutions as JsonRecord[] | undefined)) {
            const affName = normalizeText(inst.display_name);
            if (!affName) continue;
            if (!affIndex.has(affName)) {
              affIndex.set(affName, authorAffiliations.length);
              authorAffiliations.push(affName);
            }
            authorAffIndices.push(affIndex.get(affName)!);
          }
          authorAffilMap.push(authorAffIndices);
        }

        papers.push(
          buildPaper({
            title,
            authors: authorships.map((a) => normalizeText(((a.author as JsonRecord | undefined)?.display_name) || "")),
            authorAffiliations,
            authorAffilMap,
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

      if (results.length < perPage) break;
    }

    // 按 windowStart 过滤，去掉窗口外的论文
    const windowCutoff = startDate;
    const beforeFilter = papers.length;
    const filtered = papers.filter((p) => !p.published_date || p.published_date >= windowCutoff);
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.openalex.date_filtered", before: beforeFilter, after: filtered.length, window_start: windowCutoff })}\n`
    );

    return filtered;
  }
}
