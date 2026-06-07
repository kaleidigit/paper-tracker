import { describe, expect, test } from "vitest";
import { buildRssXml } from "../src/rss.js";
import type { Paper } from "../src/types.js";

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    title_en: "Test Paper",
    title_zh: "测试论文",
    published_date: "2026-06-01",
    doi: "https://doi.org/10.1234/test",
    url: "https://example.com/test",
    authors: ["Alice", "Bob"],
    abstract_zh: "这是一篇测试论文摘要。",
    classification: { tags: ["climate", "energy"] },
    ...overrides
  };
}

describe("buildRssXml", () => {
  test("generates valid RSS 2.0 XML with required namespaces", () => {
    const papers: Paper[] = [makePaper()];
    const xml = buildRssXml("日报", "描述", papers,
      "https://test.github.io", "https://test.github.io/feeds/test.xml");

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('</rss>');
  });

  test("includes channel metadata", () => {
    const xml = buildRssXml("论文日报", "每日追踪", [makePaper()],
      "https://test.github.io", "https://test.github.io/feeds/test.xml");

    expect(xml).toContain("<title>论文日报</title>");
    expect(xml).toContain("<description>每日追踪</description>");
    expect(xml).toContain("<link>https://test.github.io</link>");
    expect(xml).toContain('<atom:link href="https://test.github.io/feeds/test.xml"');
  });

  test("generates item elements for each paper", () => {
    const papers = [makePaper(), makePaper({ title_zh: "论文2" })];
    const xml = buildRssXml("t", "d", papers, "https://x", "https://x/f");

    expect(xml.match(/<item>/g)?.length).toBe(2);
    expect(xml).toContain("<title>测试论文</title>");
    expect(xml).toContain("<title>论文2</title>");
  });

  test("uses title_zh then title_en for item title", () => {
    const zh = buildRssXml("t", "d", [makePaper({ title_zh: "中文", title_en: "English" })],
      "https://x", "https://x/f");
    expect(zh).toContain("<title>中文</title>");

    const en = buildRssXml("t", "d", [makePaper({ title_zh: "", title_en: "Only EN" })],
      "https://x", "https://x/f");
    expect(en).toContain("<title>Only EN</title>");
  });

  test("uses itemKey for guid", () => {
    const doi = buildRssXml("t", "d", [makePaper(
      { doi: "https://doi.org/10.1234/test", url: "https://other.url" }
    )], "https://x", "https://x/f");
    expect(doi).toContain("<guid isPermaLink=\"false\">https://doi.org/10.1234/test</guid>");

    const urlOnly = buildRssXml("t", "d", [makePaper(
      { doi: "", url: "https://example.com/only-url" }
    )], "https://x", "https://x/f");
    expect(urlOnly).toContain("<guid isPermaLink=\"false\">https://example.com/only-url</guid>");
  });

  test("respects maxItems limit", () => {
    const papers = Array.from({ length: 50 }, (_, i) =>
      makePaper({ title_zh: `论文${i}` })
    );
    const xml = buildRssXml("t", "d", papers, "https://x", "https://x/f", 5);
    expect(xml.match(/<item>/g)?.length).toBe(5);
  });

  test("sorts by published_date descending", () => {
    const papers = [
      makePaper({ title_zh: "旧论文", published_date: "2026-05-01" }),
      makePaper({ title_zh: "新论文", published_date: "2026-06-01" }),
    ];
    const xml = buildRssXml("t", "d", papers, "https://x", "https://x/f");
    const newIdx = xml.indexOf("新论文");
    const oldIdx = xml.indexOf("旧论文");
    expect(newIdx).toBeLessThan(oldIdx);
  });

  test("includes dc:creator for first author", () => {
    const xml = buildRssXml("t", "d", [makePaper({ authors: ["Alice", "Bob"] })],
      "https://x", "https://x/f");
    expect(xml).toContain("<dc:creator>Alice</dc:creator>");
  });

  test("escapes XML special characters", () => {
    const xml = buildRssXml("t", "d", [makePaper({ title_zh: "测试<论文>&分析" })],
      "https://x", "https://x/f");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("<论文>");
  });

  test("embeds HTML in content:encoded with CDATA", () => {
    const xml = buildRssXml("t", "d", [makePaper()], "https://x", "https://x/f");
    expect(xml).toContain("<content:encoded><![CDATA[");
    expect(xml).toContain("]]></content:encoded>");
  });

  test("empty papers produces valid feed with no items", () => {
    const xml = buildRssXml("t", "d", [], "https://x", "https://x/f");
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</channel>");
    expect(xml).not.toContain("<item>");
  });
});
