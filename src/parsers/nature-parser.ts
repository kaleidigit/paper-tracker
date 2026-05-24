/**
 * nature-parser.ts
 * Nature 系列期刊采集器
 * 数据来源：Nature RSS feed + 文章页面 JSON-LD/HTML
 */

import pLimit from "p-limit";
import { XMLParser } from "fast-xml-parser";
import { logEvent } from "../logger.js";
import type { AppConfig, JsonRecord, Paper } from "../types.js";
import {
  normalizeText, dedupeStrings, toArray,
  fetchText, parseDate, parseDateTime, strictWindowStartAt,
  shouldSkipLlmRescueByTitle, extractImageFromRssItem,
  extractAffiliationsFromRssItem, normalizePublicationType
} from "../utils.js";
import { loadJournals, buildPaper } from "./shared.js";
import { ArticlePageParser } from "./article-parser.js";
import type { JournalEntry, ParsedPaper } from "./types.js";


function resolveFeedItems(parsed: JsonRecord): JsonRecord[] {
  const rdf = parsed["rdf:RDF"] as JsonRecord | undefined;
  if (rdf) return toArray(rdf.item as JsonRecord[] | undefined);
  const rss = parsed.rss as JsonRecord | undefined;
  if (rss) return toArray((rss.channel as JsonRecord | undefined)?.item as JsonRecord[] | undefined);
  const atom = parsed.feed as JsonRecord | undefined;
  if (atom) return toArray(atom.entry as JsonRecord[] | undefined);
  return [];
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

    logEvent("INFO", "workflow.fetch.phase1.start", { phase: "full_collection" });
    const rawPapers = await this.collectAllRawPapers(config, feeds, feedSortOrder, taxonomy);
    logEvent("INFO", "workflow.fetch.phase1.done", { collected: rawPapers.length });

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
        logEvent("INFO", "workflow.fetch.rss.start", { feed: feedUrl });
        let xml = "";
        try {
          xml = await natureLimit(() => fetchText(feedUrl, timeoutMs, 2));
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

        logEvent("INFO", "workflow.fetch.rss.done", { feed: feedUrl, papers: feedPapers.length });
        return feedPapers;
    }));

    return feedResults.flat();
  }
}
