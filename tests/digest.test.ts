import { describe, expect, test } from "vitest";
import type { Paper } from "../src/types.js";
import { buildMarkdown, buildRecords, buildCombinedMarkdown, buildDigestTitle } from "../src/digest.js";

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    title_en: "Test Paper",
    title_zh: "测试论文",
    authors: ["Alice Wang", "Bob Li"],
    author_affiliations: ["Tsinghua University", "Peking University"],
    author_affil_map: [[0], [1]],
    journal: { name: "Nature", source_group: "Nature", sort_order: 1 },
    published_date: "2024-03-15",
    doi: "10.1234/test",
    url: "https://example.com/test",
    abstract_original: "This is a test abstract.",
    abstract_zh: "这是测试摘要。",
    publication_type: "article",
    classification: {
      groups: [{ group: "储能与电池", subtopics: ["锂电池"] }],
      tags: ["battery", "energy"]
    },
    ...overrides
  };
}

describe("buildDigestTitle", () => {
  test("includes date", () => {
    const title = buildDigestTitle({ app: { timezone: "UTC" } } as any);
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe("buildMarkdown", () => {
  test("generates heading with paper count", () => {
    const md = buildMarkdown("Test Digest", [makePaper()]);
    expect(md).toContain("# Test Digest");
    expect(md).toContain("共收录 **1** 篇");
  });

  test("includes author affiliations with superscript", () => {
    const md = buildMarkdown("Test", [makePaper()]);
    expect(md).toContain("Alice Wang¹");
    expect(md).toContain("Bob Li²");
    expect(md).toContain("¹Tsinghua University");
    expect(md).toContain("²Peking University");
  });

  test("falls back to plain author list when no affil_map", () => {
    const md = buildMarkdown("Test", [makePaper({ author_affil_map: undefined })]);
    expect(md).toContain("Alice Wang, Bob Li");
    expect(md).toContain("Tsinghua University");
    expect(md).toContain("Peking University");
  });

  test("includes classification groups and tags", () => {
    const md = buildMarkdown("Test", [makePaper()]);
    expect(md).toContain("储能与电池（锂电池）");
    expect(md).toContain("battery，energy");
  });

  test("sorts by journal sort_order then date", () => {
    const a = makePaper({ journal: { name: "Nature", source_group: "Nature", sort_order: 1 }, published_date: "2024-01-01" });
    const b = makePaper({ journal: { name: "Science", source_group: "Science", sort_order: 0 }, published_date: "2024-02-01" });
    const md = buildMarkdown("Test", [a, b]);
    const idxA = md.indexOf("测试论文");
    const idxB = md.lastIndexOf("测试论文");
    expect(idxB).toBeGreaterThan(idxA); // Science (sort_order 0) comes first
  });

  test("handles no classification gracefully", () => {
    const md = buildMarkdown("Test", [makePaper({ classification: undefined })]);
    expect(md).toBeDefined();
    expect(md).not.toContain("undefined");
  });
});

describe("buildCombinedMarkdown", () => {
  test("merges multiple profiles", () => {
    const md = buildCombinedMarkdown("Combined", [
      { profile: "top", papers: [makePaper()] },
      { profile: "econ", papers: [makePaper({ title_zh: "经济论文" })] }
    ]);
    expect(md).toContain("# Combined");
    expect(md).toContain("环境能源（1 篇）");
    expect(md).toContain("经济论文");
  });
});

describe("buildRecords", () => {
  test("flattens paper fields", () => {
    const records = buildRecords([makePaper()]);
    expect(records).toHaveLength(1);
    expect(records[0].title_en).toBe("Test Paper");
    expect(records[0].title_zh).toBe("测试论文");
    expect(records[0].doi).toBe("10.1234/test");
    expect(records[0].groups).toBe("储能与电池:锂电池");
    expect(records[0].tags).toBe("battery, energy");
  });
});
