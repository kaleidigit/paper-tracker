/**
 * rss.ts — RSS 2.0 XML 生成（纯函数，无 IO）
 *
 * 输出 RSS 2.0 + content 模块，<content:encoded> 内嵌 HTML。
 */

import { paperToHtml } from "./publishers/render-html.js";
import { itemKey } from "./utils.js";
import type { Paper } from "./types.js";

export function buildRssXml(
  title: string,
  description: string,
  papers: Paper[],
  siteUrl: string,
  feedUrl: string,
  maxItems = 100
): string {
  // Sort by date descending so RSS readers show newest first
  const sorted = [...papers].sort((a, b) =>
    `${b.published_date}`.localeCompare(`${a.published_date}`)
  );
  const items = sorted.slice(0, maxItems);

  const itemXml = items
    .map((paper) => {
      const html = paperToHtml(paper);
      const guid = itemKey(paper);
      const link = paper.url || paper.doi || `${siteUrl}`;
      const pubDate = paper.published_date ? formatRfc2822(paper.published_date) : "";
      const author = (paper.authors && paper.authors.length > 0) ? paper.authors[0] : "";
      const paperTitle = paper.title_zh || paper.title_en || "论文";
      const categories = paper.classification?.tags || [];
      const catXml = categories.map((c) => `    <category>${escapeXml(c)}</category>`).join("\n");

      return [
        "  <item>",
        `    <title>${escapeXml(paperTitle)}</title>`,
        `    <link>${escapeXml(link)}</link>`,
        `    <guid isPermaLink="false">${escapeXml(guid)}</guid>`,
        pubDate ? `    <pubDate>${pubDate}</pubDate>` : "",
        author ? `    <dc:creator>${escapeXml(author)}</dc:creator>` : "",
        `    <description>${escapeXml((paper.abstract_zh || paper.abstract_original || "").slice(0, 200))}</description>`,
        catXml,
        `    <content:encoded><![CDATA[${html}]]></content:encoded>`,
        "  </item>"
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>${escapeXml(siteUrl)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    '    <language>zh-CN</language>',
    "    <ttl>60</ttl>",
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
    itemXml,
    "  </channel>",
    "</rss>"
  ].join("\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatRfc2822(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    return d.toUTCString();
  } catch {
    return "";
  }
}
