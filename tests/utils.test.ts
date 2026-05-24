import { describe, expect, test } from "vitest";
import {
  normalizeText, dedupeStrings, toArray, parseDate, parseDateTime,
  normalizePublicationType, shouldSkipLlmRescueByTitle, isPrimarilyChinese,
  decodeHtmlEntities, itemKey, formatDateInTz
} from "../src/utils.js";

describe("normalizeText", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeText("  hello   world  ")).toBe("hello world");
  });

  test("decodes HTML entities", () => {
    expect(normalizeText("a &amp; b &lt; c")).toBe("a & b < c");
  });

  test("handles empty/null/undefined", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("dedupeStrings", () => {
  test("removes duplicates preserving order", () => {
    expect(dedupeStrings(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("filters empty strings", () => {
    expect(dedupeStrings(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  test("case-sensitive dedup", () => {
    expect(dedupeStrings(["A", "a"])).toEqual(["A", "a"]);
  });
});

describe("toArray", () => {
  test("wraps single value", () => {
    expect(toArray("x")).toEqual(["x"]);
    expect(toArray(42)).toEqual([42]);
  });

  test("passes through array", () => {
    expect(toArray(["a", "b"])).toEqual(["a", "b"]);
  });

  test("returns empty array for undefined/null", () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray(null)).toEqual([]);
  });
});

describe("parseDate", () => {
  test("parses ISO date", () => {
    expect(parseDate("2024-03-15")).toBe("2024-03-15");
  });

  test("falls back to today on invalid input", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(parseDate("not-a-date")).toBe(today);
    expect(parseDate("")).toBe(today);
  });
});

describe("parseDateTime", () => {
  test("parses valid date string", () => {
    const result = parseDateTime("2024-03-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(new Date("2024-03-15T10:30:00Z").getTime());
  });

  test("returns null for invalid", () => {
    expect(parseDateTime("garbage")).toBeNull();
    expect(parseDateTime("")).toBeNull();
  });
});

describe("normalizePublicationType", () => {
  test("classifies review", () => {
    expect(normalizePublicationType("review")).toBe("review");
    expect(normalizePublicationType("Review Article")).toBe("review");
  });

  test("classifies editorial / news & views", () => {
    expect(normalizePublicationType("editorial")).toBe("editorial");
    expect(normalizePublicationType("news & views")).toBe("editorial");
    expect(normalizePublicationType("news & view")).toBe("editorial");
    expect(normalizePublicationType("research briefing")).toBe("editorial");
  });

  test("classifies letter", () => {
    expect(normalizePublicationType("letter")).toBe("letter");
    expect(normalizePublicationType("brief communication")).toBe("letter");
  });

  test("classifies comment", () => {
    expect(normalizePublicationType("comment")).toBe("comment");
    expect(normalizePublicationType("perspective")).toBe("comment");
  });

  test("classifies article", () => {
    expect(normalizePublicationType("article")).toBe("article");
    expect(normalizePublicationType("research article")).toBe("article");
    expect(normalizePublicationType("original research")).toBe("article");
  });

  test("returns unknown for empty", () => {
    expect(normalizePublicationType("")).toBe("unknown");
    expect(normalizePublicationType(null)).toBe("unknown");
  });

  test("returns text verbatim for unrecognized type", () => {
    expect(normalizePublicationType("corrigendum")).toBe("corrigendum");
  });
});

describe("shouldSkipLlmRescueByTitle", () => {
  test("skips corrections and retractions", () => {
    expect(shouldSkipLlmRescueByTitle("Author Correction: Something")).toBe(true);
    expect(shouldSkipLlmRescueByTitle("Retraction: Bad paper")).toBe(true);
    expect(shouldSkipLlmRescueByTitle("Publisher Correction")).toBe(true);
  });

  test("skips news items", () => {
    expect(shouldSkipLlmRescueByTitle("News & Views: Something cool")).toBe(true);
    expect(shouldSkipLlmRescueByTitle("Research Briefing: Summary")).toBe(true);
  });

  test("does not skip normal papers", () => {
    expect(shouldSkipLlmRescueByTitle("Battery performance in EVs")).toBe(false);
    expect(shouldSkipLlmRescueByTitle("Solar cell efficiency")).toBe(false);
  });

  test("skips empty titles", () => {
    expect(shouldSkipLlmRescueByTitle("")).toBe(true);
  });
});

describe("isPrimarilyChinese", () => {
  test("detects Chinese text", () => {
    expect(isPrimarilyChinese("太阳能电池效率研究")).toBe(true);
  });

  test("detects mixed Chinese-English as Chinese", () => {
    expect(isPrimarilyChinese("Perovskite 太阳能电池效率研究 2024")).toBe(true);
  });

  test("returns false for pure English", () => {
    expect(isPrimarilyChinese("Solar cell efficiency study")).toBe(false);
  });

  test("returns false for empty", () => {
    expect(isPrimarilyChinese("")).toBe(false);
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes named entities", () => {
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeHtmlEntities("a &lt; b &gt; c")).toBe("a < b > c");
    expect(decodeHtmlEntities("&quot;hello&quot;")).toBe('"hello"');
    expect(decodeHtmlEntities("&apos;x&apos;")).toBe("'x'");
  });

  test("decodes numeric entities", () => {
    expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC");
    expect(decodeHtmlEntities("&#x41;&#x42;&#x43;")).toBe("ABC");
  });
});

describe("itemKey", () => {
  test("uses DOI when available", () => {
    expect(itemKey({ doi: "10.1234/foo", title_en: "Bar" })).toBe("10.1234/foo");
  });

  test("falls back to URL when no DOI", () => {
    expect(itemKey({ url: "https://example.com/paper", title_en: "Bar" })).toBe("https://example.com/paper");
  });

  test("falls back to journal::title", () => {
    const key = itemKey({ title_en: "Test Paper", journal: { name: "Nature" } });
    expect(key).toBe("Nature::Test Paper");
  });
});

describe("formatDateInTz", () => {
  test("returns YYYY-MM-DD", () => {
    const d = new Date("2024-06-15T12:00:00Z");
    const result = formatDateInTz(d, "UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
