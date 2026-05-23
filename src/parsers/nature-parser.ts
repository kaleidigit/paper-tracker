/**
 * nature-parser.ts
 * Nature 系列期刊采集器
 * 数据来源：Nature RSS feed + 文章页面 JSON-LD/HTML
 */

import fs from "node:fs/promises";
import pLimit from "p-limit";
import { XMLParser } from "fast-xml-parser";
import type { AppConfig, JsonRecord, Paper } from "../types.js";
import {
  normalizeText, dedupeStrings, toArray, resolvePath,
  fetchText, parseDate, parseDateTime, strictWindowStartAt,
  shouldSkipLlmRescueByTitle, extractImageFromRssItem,
  extractAffiliationsFromRssItem, normalizePublicationType
} from "../utils.js";
import { loadTaxonomy } from "../modules.js";
import { ArticlePageParser } from "./article-parser.js";
import type { JournalEntry, ParsedPaper } from "./types.js";

async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "profiles/top/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function resolveFeedItems(parsed: JsonRecord): JsonRecord[] {
  const rdf = parsed["rdf:RDF"] as JsonRecord | undefined;
  if (rdf) return toArray(rdf.item as JsonRecord[] | undefined);
  const rss = parsed.rss as JsonRecord | undefined;
  if (rss) return toArray((rss.channel as JsonRecord | undefined)?.item as JsonRecord[] | undefined);
  const atom = parsed.feed as JsonRecord | undefined;
  if (atom) return toArray(atom.entry as JsonRecord[] | undefined);
  return [];
}

function buildPaper(input: ParsedPaper): Paper {
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

export class NatureParser {
  async collect(config: AppConfig, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
    const journals = await loadJournals(config);
    const natureJournals = journals.filter((j) => normalizeText(j.publisher_strategy) === "nature-rss");
    const feeds = natureJournals.flatMap((j) => toArray(j.rss_feeds as string[] | undefined));

    if (feeds.length === 0) return [];

    // feed URL → sort_order 查找表
    const feedSortOrder = new Map<string, number>();
    for (const j of natureJournals) {
      if (j.sort_order !== undefined) {
        for (const feed of toArray(j.rss_feeds as string[] | undefined)) {
          feedSortOrder.set(feed, j.sort_order);
        }
      }
    }

    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.start", phase: "full_collection" })}\n`);
    const rawPapers = await this.collectAllRawPapers(config, feeds, feedSortOrder, taxonomy);
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.phase1.done", collected: rawPapers.length })}\n`);

    return rawPapers;
  }

  private async collectAllRawPapers(config: AppConfig, feeds: string[], feedSortOrder: Map<string, number>, taxonomy: Array<Record<string, unknown>>): Promise<Paper[]> {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const start = strictWindowStartAt(config);
    const timeoutMs = 30000;
    const articleParser = new ArticlePageParser(timeoutMs);
    const authorInfoCache = new Map<string, ReturnType<ArticlePageParser["parse"]>>();
    const natureLimit = pLimit(4);

    const feedResults = await Promise.all(feeds.map(async (feedUrl) => {
        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.rss.start", feed: feedUrl })}\n`);
        let xml = "";
        try {
          xml = await natureLimit(() => fetchText(feedUrl, timeoutMs, 2));
        } catch {
          process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "WARN", event: "workflow.fetch.rss.failed", feed: feedUrl })}\n`);
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
          const rssAbstract = normalizeText(item.description || item.summary || "");
          const journal = normalizeText(item["prism:publicationName"] || item.source || "Nature");
          const publishedDate = parseDate(item.pubDate || item.published || item.updated || item["dc:date"]);
          const paperUrl = normalizeText(item.link);

          if (shouldSkipLlmRescueByTitle(title)) continue;

          const cacheKey = paperUrl.toLowerCase();
          if (!authorInfoCache.has(cacheKey)) {
            authorInfoCache.set(cacheKey, natureLimit(() => articleParser.parse(paperUrl)));
          }
          const authorInfo = (await authorInfoCache.get(cacheKey)) || { authors: [], affiliations: [], imageUrl: "", abstract: "", publicationType: "unknown" };

          const resolvedAbstract = authorInfo.abstract || rssAbstract;
          const pubType = authorInfo.publicationType !== "unknown"
            ? authorInfo.publicationType
            : normalizeText(item["dc:type"] || item["prism:publicationType"] || item["prism:section"] || (item.category as string));

          feedPapers.push(
            buildPaper({
              title,
              authors: authorInfo.authors.length > 0 ? authorInfo.authors : toArray(item.author as string[] | undefined),
              authorAffiliations: authorInfo.affiliations.length > 0 ? authorInfo.affiliations : extractAffiliationsFromRssItem(item),
              authorAffilMap: authorInfo.authorAffilMap,
              journal,
              sourceGroup: "Nature",
              publishedDate,
              doi: normalizeText(item["dc:identifier"]),
              url: paperUrl,
              abstractOriginal: resolvedAbstract,
              imageUrl: authorInfo.imageUrl || extractImageFromRssItem(item),
              publicationType: pubType,
              sourceProvider: "nature-rss",
              rawFeed: feedUrl,
              rawRecordId: normalizeText(item.guid || item.link),
              taxonomy,
              sortOrder: feedSortOrder.get(feedUrl)
            })
          );
        }

        process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.rss.done", feed: feedUrl, papers: feedPapers.length })}\n`);
        return feedPapers;
    }));

    return feedResults.flat();
  }
}
