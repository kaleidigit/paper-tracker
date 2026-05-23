/**
 * article-parser.ts
 * 统一文章页面解析器：从 HTML 页面中提取作者、单位、摘要、图片、发表类型
 * 支持：Nature / Science / PNAS / Cell / RSC 等主流期刊
 */

import type { JsonRecord } from "../types.js";
import type { ArticleMeta } from "./types.js";
import { fetchText } from "../utils.js";

function normalizeText(value: unknown): string {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const item = normalizeText(value);
    if (!item || seen.has(item)) return;
    seen.add(item);
    result.push(item);
  });
  return result;
}

function absoluteUrl(raw: string, base?: string): string {
  const url = normalizeText(raw);
  if (!url) return "";
  try {
    return base ? new URL(url, base).toString() : new URL(url).toString();
  } catch {
    return url;
  }
}

export class ArticlePageParser {
  constructor(private timeoutMs: number = 15000) {}

  /**
   * 抓取并解析文章页面元数据
   */
  async parse(url: string): Promise<ArticleMeta> {
    const articleUrl = normalizeText(url);
    if (!articleUrl) {
      return this.empty();
    }

    try {
      const html = await fetchText(articleUrl, this.timeoutMs, 2);
      return this.parseHtml(html, articleUrl);
    } catch {
      return this.empty();
    }
  }

  private empty(): ArticleMeta {
    return { authors: [], affiliations: [], imageUrl: "", abstract: "", publicationType: "unknown" };
  }

  /**
   * 解析 HTML 页面，依次尝试 JSON-LD → HTML meta 标签
   */
  parseHtml(html: string, pageUrl: string): ArticleMeta {
    const ldResult = this.extractFromJsonLd(html, pageUrl);
    const htmlResult = this.extractFromHtmlMeta(html, pageUrl);

    const authors = (ldResult.authors ?? []).length > 0 ? (ldResult.authors ?? []) : htmlResult.authors ?? [];
    const affiliations = (ldResult.affiliations ?? []).length > 0 ? (ldResult.affiliations ?? []) : htmlResult.affiliations ?? [];
    const authorAffilMap = ldResult.authorAffilMap ?? htmlResult.authorAffilMap;
    const imageUrl = ldResult.imageUrl || htmlResult.imageUrl || "";
    const abstractText = ldResult.abstract || htmlResult.abstract || "";
    const publicationType = ldResult.publicationType !== "unknown" ? ldResult.publicationType! : htmlResult.publicationType || "unknown";

    return { authors, affiliations, authorAffilMap, imageUrl, abstract: abstractText, publicationType };
  }

  private extractFromJsonLd(html: string, pageUrl: string): Partial<ArticleMeta> {
    const result: Partial<ArticleMeta> = { authors: [], affiliations: [], authorAffilMap: [], imageUrl: "", abstract: "", publicationType: "unknown" };
    const affIndex = new Map<string, number>();
    const affilMap: number[][] = [];

    const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of matches) {
      try {
        const ld = JSON.parse(match[1]);

        // 递归收集实体：支持 WebPage.mainEntity、@graph 等嵌套结构
        const flatEntities: JsonRecord[] = [];
        const collectEntities = (node: unknown) => {
          if (Array.isArray(node)) {
            node.forEach(collectEntities);
          } else if (node && typeof node === "object") {
            flatEntities.push(node as JsonRecord);
            collectEntities((node as JsonRecord).mainEntity);
            collectEntities((node as JsonRecord)["@graph"]);
          }
        };
        collectEntities(ld);

        for (const entity of flatEntities) {
          const type = normalizeText(entity["@type"] || "").toLowerCase();
          const articleTypes = ["article", "scholarlyarticle", "newsarticle", "report", "webpage", "creativework"];
          if (!articleTypes.some((t) => type.includes(t))) continue;

          const cited = entity.author || entity.creator || [];
          const authorList = Array.isArray(cited) ? cited : [cited];
          for (const a of authorList) {
            const name = normalizeText(typeof a === "string" ? a : (a.name || ""));
            if (!name) continue;
            result.authors!.push(name);

            const authorAffIndices: number[] = [];
            if (Array.isArray(a.affiliation)) {
              for (const aff of a.affiliation) {
                const addr = typeof aff === "string" ? null : (aff as any).address;
                const addrName = typeof addr === "string" ? addr : (addr?.name || "");
                const shortName = typeof aff === "string" ? aff : (aff.name || "");
                const affName = normalizeText(addrName || shortName);
                if (!affName) continue;
                if (!affIndex.has(affName)) {
                  affIndex.set(affName, result.affiliations!.length);
                  result.affiliations!.push(affName);
                }
                authorAffIndices.push(affIndex.get(affName)!);
              }
            }
            affilMap.push(authorAffIndices);
          }

          if (!result.abstract && entity.description) {
            result.abstract = normalizeText(entity.description);
          }
          if (result.publicationType === "unknown") {
            const section = normalizeText(entity.articleSection || entity.type || "");
            if (section) result.publicationType = this.normalizePublicationType(section);
          }
          if (!result.imageUrl) {
            const img = entity.image;
            if (typeof img === "string") result.imageUrl = absoluteUrl(img, pageUrl);
            else if (img && typeof img === "object" && !Array.isArray(img)) {
              const imgUrl = normalizeText((img as Record<string, unknown>).url || "");
              if (imgUrl) result.imageUrl = absoluteUrl(imgUrl, pageUrl);
            }
          }
        }
      } catch {
        // ignore JSON parse error
      }
    }

    return {
      authors: dedupeStrings(result.authors || []),
      affiliations: dedupeStrings(result.affiliations || []),
      authorAffilMap: affilMap.length > 0 ? affilMap : undefined,
      imageUrl: result.imageUrl || "",
      abstract: result.abstract || "",
      publicationType: result.publicationType || "unknown"
    };
  }

  private extractFromHtmlMeta(html: string, pageUrl: string): Partial<ArticleMeta> {
    const authors = this.extractAuthorsFromHtml(html);
    const affiliations = this.extractAffiliationsFromHtml(html);
    const imageUrl = this.extractImageFromHtml(html, pageUrl);
    const pubType = this.extractPublicationTypeFromHtml(html);
    const abstract = this.extractAbstractFromHtml(html);

    return { authors, affiliations, imageUrl, abstract, publicationType: pubType };
  }

  /** 从 citation_* meta 标签提取作者列表 */
  extractAuthorsFromHtml(html: string): string[] {
    const citationMatches = html.matchAll(/name=["']citation_author["'][^>]*content=["']([^"']+)["']/gi);
    const citationAuthors = Array.from(citationMatches).map((m) => normalizeText(m[1]));
    if (citationAuthors.length > 0) return dedupeStrings(citationAuthors).filter(Boolean);

    // 回退：作者信息区块
    const sectionMatch =
      html.match(/<section[^>]*id=["']author-information["'][\s\S]*?<\/section>/i) ||
      html.match(/<h2[^>]*>\s*Author information\s*<\/h2>[\s\S]*?(<section[\s\S]*?<\/section>|<div[\s\S]*?<\/div>)/i);
    if (!sectionMatch?.[0]) return [];
    const names = Array.from(sectionMatch[0].matchAll(/<a[^>]*data-test=["']author-name["'][^>]*>([^<]+)<\/a>/gi)).map((m) => normalizeText(m[1]));
    return dedupeStrings(names).filter(Boolean);
  }

  /** 从 citation_author_institution 标签提取单位 */
  extractAffiliationsFromHtml(html: string): string[] {
    const matches = html.matchAll(/name=["']citation_author_institution["'][^>]*content=["']([^"']+)["']/gi);
    const affiliations = Array.from(matches).map((m) => normalizeText(m[1]));
    return dedupeStrings(affiliations).filter(Boolean);
  }

  /** 从 og:image / twitter:image 标签提取主图 */
  extractImageFromHtml(html: string, pageUrl: string): string {
    const patterns = [
      /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
      /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
      /name=["']citation_cover_image["'][^>]*content=["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return absoluteUrl(match[1], pageUrl);
    }
    return "";
  }

  /** 从 meta 标签提取发表类型 */
  extractPublicationTypeFromHtml(html: string): string {
    const patterns = [
      /citation_article_type["'][^>]*content=["']([^"']+)["']/i,
      /name=["']dc\.type["'][^>]*content=["']([^"']+)["']/i,
      /property=["']article:type["'][^>]*content=["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return this.normalizePublicationType(match[1]);
    }
    return "unknown";
  }

  /** 从 meta description 提取摘要 */
  extractAbstractFromHtml(html: string): string {
    const patterns = [
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return normalizeText(match[1]);
    }
    return "";
  }

  normalizePublicationType(value: string): string {
    const text = normalizeText(value).toLowerCase();
    if (!text) return "unknown";
    if (text.includes("review")) return "review";
    if (text.includes("editorial") || text.includes("news & view") || text.includes("research briefing")) return "editorial";
    if (text.includes("letter") || text.includes("brief communication")) return "letter";
    if (text.includes("comment") || text.includes("perspective") || text.includes("news & views")) return "comment";
    if (text.includes("article") || text.includes("research article") || text.includes("original research")) return "article";
    return text;
  }
}
