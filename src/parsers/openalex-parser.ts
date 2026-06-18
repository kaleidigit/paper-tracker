/**
 * openalex-parser.ts
 * OpenAlex API 采集器：为 Science / PNAS / Joule / EES 等期刊提供元数据
 * 优势：完整作者列表、单位、摘要；免费公开 API
 */

import { logEvent } from "../logger.js";
import type { AppConfig, JsonRecord, Paper, TaxonomyGroup } from "../types.js";
import {
  normalizeText, dedupeStrings, toArray,
  fetchJson, parseDate, graceWindowStartAt, formatDateInTz,
  shouldSkipLlmRescueByTitle, restoreAbstract
} from "../utils.js";
import { buildPaper } from "./shared.js";
import { loadJournals } from "../config.js";
import { FETCH_TIMEOUT_MS, OPENALEX_WIDE_WINDOW_DAYS, OPENALEX_PAGE_SIZE } from "../constants.js";



/** Resolve sort_order from an ISSN that may be a string or string[] (OpenAlex returns arrays) */
function resolveSortOrder(issnMap: Map<string, number>, rawIssn: unknown): number | undefined {
  const issns: unknown[] = Array.isArray(rawIssn) ? rawIssn : [rawIssn];
  for (const issn of issns) {
    const key = normalizeText(issn);
    if (key && issnMap.has(key)) return issnMap.get(key);
  }
  return undefined;
}

/**
 * Refine OpenAlex type using heuristics when the API type is unreliable.
 * A single-page article without abstract in a general journal is likely a Letter/Correspondence.
 */
function refineOpenAlexType(item: JsonRecord, originalType: unknown, abstract: string): string {
  const t = normalizeText(originalType);
  const isArticle = t.includes("article");

  if (!isArticle) return t;

  const biblio = item.biblio as JsonRecord | undefined;
  const firstPage = normalizeText(biblio?.first_page);
  const lastPage = normalizeText(biblio?.last_page);

  // Single page + no abstract → not a full research article (likely Letter/Comment/Editorial/News)
  if (firstPage && lastPage && firstPage === lastPage && !abstract) {
    return "comment";
  }

  return t;
}

export class OpenAlexParser {
  async collect(config: AppConfig, taxonomy: TaxonomyGroup[]): Promise<Paper[]> {
    logEvent("INFO", "workflow.fetch.phase1.start", { phase: "full_collection", source: "openalex" });
    const rawPapers = await this.collectAllRawPapers(config, taxonomy);
    logEvent("INFO", "workflow.fetch.phase1.done", { collected: rawPapers.length, source: "openalex" });

    return rawPapers;
  }

  private async collectAllRawPapers(config: AppConfig, taxonomy: TaxonomyGroup[]): Promise<Paper[]> {
    const journals = await loadJournals(config);
    const oaJournals = journals.filter((j) => normalizeText(j.publisher_strategy) === "openalex");
    const issns = dedupeStrings(
      oaJournals.map((j) => normalizeText(j.issn)).filter(Boolean)
    );

    // ISSN → sort_order 查找表（OpenAlex 返回 source.issn = ISSN-L，精确匹配）
    const issnSortOrder = new Map<string, number>();
    for (const j of oaJournals) {
      const issn = normalizeText(j.issn);
      if (issn && j.sort_order !== undefined) {
        issnSortOrder.set(issn, j.sort_order);
      }
    }

    if (issns.length === 0) return [];

    // 带 grace 缓冲的窗口起始，补偿 OpenAlex 索引延迟
    const graceStart = graceWindowStartAt(config);
    const startDate = formatDateInTz(graceStart, "UTC");
    const select = "id,title,doi,publication_date,type,biblio,authorships,primary_location,abstract_inverted_index";
    const papers: Paper[] = [];
    const perPage = OPENALEX_PAGE_SIZE;

    // 日期窗口放宽（周刊期刊会漏），后端关键词+LLM 精选
    const wideStartDate = new Date(Date.now() - OPENALEX_WIDE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
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
      logEvent("INFO", "workflow.fetch.openalex.page", { page, issns: issns.length });

      let payload: JsonRecord = {};
      try {
        payload = await fetchJson(url, FETCH_TIMEOUT_MS, 3);
      } catch {
        logEvent("WARN", "workflow.fetch.openalex.failed", { page });
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
            publicationType: refineOpenAlexType(item, item.type, abstract),
            sourceProvider: "openalex",
            rawFeed: "https://api.openalex.org/works",
            rawRecordId: normalizeText(item.id),
            taxonomy,
            sortOrder: resolveSortOrder(issnSortOrder, source?.issn)
          })
        );
      }

      if (results.length < perPage) break;
    }

    // 按带 grace 缓冲的窗口过滤（允许延迟索引的论文通过）
    const windowCutoff = startDate;
    const beforeFilter = papers.length;
    const filtered = papers.filter((p) => !p.published_date || p.published_date >= windowCutoff);
    logEvent("INFO", "workflow.fetch.openalex.date_filtered", { before: beforeFilter, after: filtered.length, window_start: windowCutoff });

    return filtered;
  }
}
