import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Paper } from "../src/types.js";
import { openDb, getKnownDedupKeys, upsertPapers } from "../src/db.js";

let tmpDir = "";
let dbPath = "";

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    title_en: "Test Paper",
    doi: "10.1234/test",
    url: "https://example.com/test",
    journal: { name: "Nature", source_group: "Nature" },
    published_date: "2024-03-15",
    publication_type: "article",
    authors: ["Alice"],
    author_affiliations: ["Tsinghua"],
    abstract_original: "abstract",
    ...overrides
  };
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-tracker-db-"));
  dbPath = path.join(tmpDir, "test.db");
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getKnownDedupKeys", () => {
  test("returns empty set for empty keys", () => {
    const db = openDb(dbPath);
    try {
      const result = getKnownDedupKeys(db, "top", []);
      expect(result.size).toBe(0);
    } finally {
      db.close();
    }
  });

  test("returns empty set for unknown keys", () => {
    const db = openDb(dbPath);
    try {
      const result = getKnownDedupKeys(db, "top", ["doi:10.unknown"]);
      expect(result.size).toBe(0);
    } finally {
      db.close();
    }
  });

  test("returns matching keys after upsert", () => {
    const db = openDb(dbPath);
    try {
      upsertPapers(db, "top", [makePaper({ doi: "10.1234/dedup-test" })]);
    } finally {
      db.close();
    }

    const db2 = openDb(dbPath);
    try {
      const result = getKnownDedupKeys(db2, "top", ["10.1234/dedup-test", "10.unknown"]);
      expect(result.size).toBe(1);
      expect(result.has("10.1234/dedup-test")).toBe(true);
    } finally {
      db2.close();
    }
  });
});

describe("upsertPapers", () => {
  test("inserts new papers", () => {
    const db = openDb(dbPath);
    try {
      const count = upsertPapers(db, "top", [makePaper({ doi: "10.1234/insert" })]);
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("returns 0 for empty array", () => {
    const db = openDb(dbPath);
    try {
      const count = upsertPapers(db, "top", []);
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("dedups within batch", () => {
    const db = openDb(dbPath);
    try {
      const paper = makePaper({ doi: "10.1234/batch-dedup" });
      const count = upsertPapers(db, "top", [paper, paper, paper]);
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("ON CONFLICT updates existing papers", () => {
    // First insert
    const db1 = openDb(dbPath);
    try {
      upsertPapers(db1, "top", [makePaper({ doi: "10.1234/upsert", title_en: "Old Title" })]);
    } finally {
      db1.close();
    }

    // Then update
    const db2 = openDb(dbPath);
    try {
      const count = upsertPapers(db2, "top", [makePaper({ doi: "10.1234/upsert", title_en: "New Title" })]);
      expect(count).toBe(1); // still 1, not 2
    } finally {
      db2.close();
    }
  });
});
