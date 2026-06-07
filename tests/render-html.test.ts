import { describe, expect, test } from "vitest";
import { digestToHtmlPage } from "../src/publishers/render-html.js";

function sampleMd(title: string, papers: string[]): string {
  const items = papers.map((t, i) => `## ${i + 1}. ${t}\n\n*English*\n\n- **期刊**：Nature\n- **日期**：2026-06-01\n\n**中文摘要**\n\n摘要内容。`).join("\n\n---\n\n");
  return `# ${title}\n\n共收录 **${papers.length}** 篇。\n\n${items}`;
}

describe("digestToHtmlPage", () => {
  test("generates valid HTML5 document", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"zh-CN\">");
    expect(html).toContain("<title>日报</title>");
    expect(html).toContain("<meta charset=\"UTF-8\">");
    expect(html).toContain("</html>");
  });

  test("includes table layout for TOC", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain('<table class="layout"');
    expect(html).toContain('class="toc-cell"');
    expect(html).toContain('class="content-cell"');
  });

  test("generates TOC entries for headings", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A", "论文B"]));
    expect(html).toContain("论文A");
    expect(html).toContain("论文B");
    expect(html).toContain('class="toc-list"');
  });

  test("strips heading numbers from TOC (no duplicate 1. 1.)", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    // TOC should have "论文A" not "1. 论文A"
    const tocMatch = html.match(/class="toc-cell"[^]*?<\/td>/);
    expect(tocMatch).not.toBeNull();
    if (tocMatch) {
      expect(tocMatch[0]).not.toContain("1. 论文A");
      expect(tocMatch[0]).toContain("论文A");
    }
  });

  test("generates anchor IDs on headings", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A", "论文B"]));
    expect(html).toContain('<a id="h-0">');
    expect(html).toContain('<a id="h-1">');
  });

  test("TOC links point to correct anchors", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain('href="#h-0"');
  });

  test("empty digest produces no TOC items", () => {
    const html = digestToHtmlPage("日报", "# 日报\n\n共收录 **0** 篇。");
    expect(html).not.toContain('<a id="h-');
  });

  test("includes Kami/Claude design CSS", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain("#f5f4ed");  // parchment background
    expect(html).toContain("#1B365D");  // ink-blue accent
    expect(html).toContain("Charter, Georgia");  // serif fonts
  });

  test("includes dark mode CSS", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("#141413");  // dark background
  });

  test("includes mobile breakpoint", () => {
    const html = digestToHtmlPage("日报", sampleMd("日报", ["论文A"]));
    expect(html).toContain("max-width: 700px");
  });

  test("escapes HTML in title", () => {
    const html = digestToHtmlPage("<script>alert('xss')</script>", sampleMd("safe", []));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
