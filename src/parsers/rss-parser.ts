/**
 * rss-parser.ts
 * RSS 采集器：支持 RDF (Science/Cell Press) / RSS 2.0 (Nature) / Atom 格式
 *
 * 采集阶段仅解析 RSS，不做文章页面抓取。
 * 筛选后通过 enrichRssPaper() 抓取文章页面（Cloudflare 保护域名走 Crossref 回退）。
 */

import pLimit from "p-limit";
import { XMLParser } from "fast-xml-parser";
import { logEvent } from "../logger.js";
import type { AppConfig, JsonRecord, Paper, TaxonomyGroup } from "../types.js";
import {
  normalizeText, toArray,
  fetchText, parseDate, parseDateTime, strictWindowStartAt,
  shouldSkipLlmRescueByTitle, extractImageFromRssItem,
  extractAffiliationsFromRssItem
} from "../utils.js";
import { buildPaper } from "./shared.js";
import { loadJournals } from "../config.js";
import { ArticlePageParser } from "./article-parser.js";

// ─── RSS helpers ────────────────────────────────────────────

function resolveFeedItems(parsed: JsonRecord): JsonRecord[] {
  const rdf = parsed["rdf:RDF"] as JsonRecord | undefined;
  if (rdf) return toArray(rdf.item as JsonRecord[] | undefined);
  const rss = parsed.rss as JsonRecord | undefined;
  if (rss) return toArray((rss.channel as JsonRecord | undefined)?.item as JsonRecord[] | undefined);
  const atom = parsed.feed as JsonRecord | undefined;
  if (atom) return toArray(atom.entry as JsonRecord[] | undefined);
  return [];
}

function parseDcCreator(raw: unknown): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Article page enrichment (post-filter) ──────────────────

const articleParser = new ArticlePageParser(30000);

/** Domains where Cloudflare blocks all non-browser requests */
const CLOUDFLARE_DOMAINS = ["science.org", "cell.com", "pnas.org", "pubs.acs.org"];

function isCloudflareBlocked(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return CLOUDFLARE_DOMAINS.some((d) => host.endsWith(d));
  } catch {
    return true;
  }
}

/** Strip JATS/HTML tags and normalize whitespace. */
function stripJats(raw: string): string {
  return normalizeText(raw.replace(/<[^>]*>/g, ""));
}

/** Fetch abstract from Crossref API by DOI. Returns empty string on failure. */
export async function fetchCrossrefAbstract(doi: string): Promise<string> {
  const cleanDoi = normalizeText(doi);
  if (!cleanDoi) return "";
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;
    const resp = await fetchText(url, 15000, 1);
    const data = JSON.parse(resp) as JsonRecord;
    const abstract = (data?.message as JsonRecord | undefined)?.abstract as string | undefined;
    return abstract ? stripJats(abstract) : "";
  } catch {
    return "";
  }
}

/**
 * Scrape article page and merge metadata into the paper.
 * For Cloudflare-protected domains, falls back to Crossref API for abstract.
 */
export async function enrichRssPaper(paper: Paper): Promise<Paper> {
  const url = paper.url;
  if (!url) return paper;

  if (isCloudflareBlocked(url)) {
    const doi = paper.doi || paper.id;
    if (!doi) return paper;
    const crossrefAbstract = await fetchCrossrefAbstract(doi);
    if (!crossrefAbstract) return paper;
    const oldAbstract = (paper.abstract_original || "").trim();
    const abstractUpdated = crossrefAbstract.length > oldAbstract.length;
    return {
      ...paper,
      abstract_original: abstractUpdated ? crossrefAbstract : paper.abstract_original,
      abstract_zh: abstractUpdated ? "" : paper.abstract_zh,
      title_zh: abstractUpdated ? "" : paper.title_zh,
    };
  }

  try {
    const meta = await articleParser.parse(url);
    const oldAbstract = (paper.abstract_original || "").trim();
    const newAbstract = meta.abstract || "";
    // 若抓取到的摘要比 RSS teaser 长，清空 abstract_zh 强制 enrich 阶段重新翻译
    const abstractUpdated = newAbstract.length > oldAbstract.length;
    return {
      ...paper,
      authors: meta.authors.length > 0 ? meta.authors : paper.authors,
      author_affiliations: meta.affiliations.length > 0 ? meta.affiliations : paper.author_affiliations,
      author_affil_map: meta.authorAffilMap || paper.author_affil_map,
      abstract_original: newAbstract || paper.abstract_original,
      abstract_zh: abstractUpdated ? "" : paper.abstract_zh,
      title_zh: abstractUpdated ? "" : paper.title_zh,
      image_url: meta.imageUrl || paper.image_url,
      publication_type: meta.publicationType !== "unknown" ? meta.publicationType : paper.publication_type,
    };
  } catch {
    return paper;
  }
}

// ─── Parser ─────────────────────────────────────────────────

export class RssParser {
  async collect(config: AppConfig, taxonomy: TaxonomyGroup[]): Promise<Paper[]> {
    const journals = await loadJournals(config);
    const rssJournals = journals.filter((j) => normalizeText(j.publisher_strategy) === "rss");
    const feeds = rssJournals.flatMap((j) => toArray(j.rss_feeds as string[] | undefined));

    if (feeds.length === 0) return [];

    const feedSortOrder = new Map<string, number>();
    const feedSourceGroup = new Map<string, string>();
    for (const j of rssJournals) {
      const sg = normalizeText(j.source_group || j.name);
      for (const feed of toArray(j.rss_feeds as string[] | undefined)) {
        if (j.sort_order !== undefined) feedSortOrder.set(feed, j.sort_order);
        feedSourceGroup.set(feed, sg);
      }
    }

    logEvent("INFO", "workflow.fetch.phase1.start", { phase: "full_collection" });
    const rawPapers = await this.collectAllRawPapers(config, feeds, feedSortOrder, feedSourceGroup, taxonomy);
    logEvent("INFO", "workflow.fetch.phase1.done", { collected: rawPapers.length });

    return rawPapers;
  }

  private async collectAllRawPapers(
    config: AppConfig, feeds: string[],
    feedSortOrder: Map<string, number>, feedSourceGroup: Map<string, string>,
    taxonomy: TaxonomyGroup[]
  ): Promise<Paper[]> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const start = strictWindowStartAt(config);
    const timeoutMs = 30000;
    const rssLimit = pLimit(8);

    const feedResults = await Promise.all(feeds.map(async (feedUrl) => {
      logEvent("INFO", "workflow.fetch.rss.start", { feed: feedUrl });
      let xml = "";
      try {
        xml = await rssLimit(() => fetchText(feedUrl, timeoutMs, 2));
      } catch {
        logEvent("WARN", "workflow.fetch.rss.failed", { feed: feedUrl });
        return [];
      }

      let items: JsonRecord[] = [];
      try {
        const parsed = parser.parse(xml) as JsonRecord;
        items = resolveFeedItems(parsed);
      } catch {
        return [];
      }

      const feedPapers: Paper[] = [];
      for (const item of items) {
        const publishedAt = parseDateTime(item.pubDate || item.published || item.updated || item["dc:date"]);
        if (publishedAt && publishedAt < start) continue;

        const title = normalizeText(item.title);
        const rssAbstract = normalizeText(item["content:encoded"] || item.description || item.summary || "");
        const journal = normalizeText(item["prism:publicationName"] || item.source || "");
        const publishedDate = parseDate(item.pubDate || item.published || item.updated || item["dc:date"]);
        const paperUrl = normalizeText(item.link);

        if (shouldSkipLlmRescueByTitle(title)) continue;

        // RSS-only: article page scraping deferred to enrichRssPaper after filter
        const rssAuthors = parseDcCreator(item["dc:creator"]);
        const pubType = normalizeText(
          item["dc:type"] || item["prism:publicationType"] || item["prism:section"] || (item.category as string)
        );

        feedPapers.push(
          buildPaper({
            title,
            authors: rssAuthors.length > 0 ? rssAuthors : toArray(item.author as string[] | undefined),
            authorAffiliations: extractAffiliationsFromRssItem(item),
            journal: journal || "Unknown Journal",
            sourceGroup: feedSourceGroup.get(feedUrl) || normalizeText(journal),
            publishedDate,
            doi: normalizeText(item["dc:identifier"]),
            url: paperUrl,
            abstractOriginal: rssAbstract,
            imageUrl: extractImageFromRssItem(item),
            publicationType: pubType,
            sourceProvider: "rss",
            rawFeed: feedUrl,
            rawRecordId: normalizeText(item.guid || item.link),
            taxonomy,
            sortOrder: feedSortOrder.get(feedUrl),
          })
        );
      }

      logEvent("INFO", "workflow.fetch.rss.done", { feed: feedUrl, papers: feedPapers.length });
      return feedPapers;
    }));

    return feedResults.flat();
  }
}
