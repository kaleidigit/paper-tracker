/**
 * article-parser.ts
 * 统一文章页面解析器：从 HTML 页面中提取作者、单位、摘要、图片、发表类型
 * 支持：Nature / Science / PNAS / Cell / RSC 等主流期刊
 */

import type { ArticleMeta } from "./types.js";

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(articleUrl, {
        signal: controller.signal,
        headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
      });
      if (!response.ok) return this.empty();
      const html = await response.text();
      return this.parseHtml(html, articleUrl);
    } catch {
      return this.empty();
    } finally {
      clearTimeout(timer);
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

    const authors: string[] = (ldResult.authors ?? []).length > 0 ? (ldResult.authors ?? []) : htmlResult.authors ?? [];
    const affiliations: string[] = (ldResult.affiliations ?? []).length > 0 ? (ldResult.affiliations ?? []) : htmlResult.affiliations ?? [];
    const imageUrl: string = ldResult.imageUrl || htmlResult.imageUrl || "";
    const abstractText: string = ldResult.abstract || htmlResult.abstract || "";
    const publicationType: string = ldResult.publicationType !== "unknown" ? ldResult.publicationType! : htmlResult.publicationType || "unknown";

    return { authors, affiliations, imageUrl, abstract: abstractText, publicationType };
  }

  private extractFromJsonLd(html: string, pageUrl: string): Partial<ArticleMeta> {
    const result: Partial<ArticleMeta> = { authors: [], affiliations: [], imageUrl: "", abstract: "", publicationType: "unknown" };

    const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of matches) {
      try {
        const ld = JSON.parse(match[1]);
        const entities = Array.isArray(ld) ? ld : [ld];
        for (const entity of entities) {
          const type = normalizeText(entity["@type"] || "");
          // 放宽类型过滤：容纳 NewsArticle / Editorial / Report / WebPage 等内容
          const articleTypes = ["article", "scholarlyarticle", "newsarticle", "report", "webpage", "creativework"];
          if (!articleTypes.some((t) => type.includes(t))) {
            continue;
          }

          // 作者：处理对象格式 author.name 和纯字符串格式（如编辑部文章 author:"Nature Climate Change"）
          const cited = entity.author || entity.creator || [];
          const authorList = Array.isArray(cited) ? cited : [cited];
          for (const a of authorList) {
            const name = normalizeText(typeof a === "string" ? a : (a.name || ""));
            if (name) result.authors!.push(name);
            if (name) result.authors!.push(name);

            // 单位（JSON-LD 格式：author[].affiliation[]）
            if (Array.isArray(a.affiliation)) {
              for (const aff of a.affiliation) {
                const affName = normalizeText(typeof aff === "string" ? aff : (aff.name || ""));
                if (affName) result.affiliations!.push(affName);
              }
            }
          }

          // 摘要
          if (!result.abstract && entity.description) {
            result.abstract = normalizeText(entity.description);
          }

          // 发表类型
          if (result.publicationType === "unknown") {
            const section = normalizeText(entity.articleSection || entity.type || "");
            if (section) result.publicationType = this.normalizePublicationType(section);
          }

          // 图片
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
