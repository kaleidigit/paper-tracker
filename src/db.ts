/**
 * db.ts — SQLite 数据库操作
 *
 * 纯能力模块：所有函数接收 dbPath 参数，不持有全局状态。
 */

import Database from "better-sqlite3";
import type { Paper } from "./types.js";

// ─── Schema ──────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doi TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL,
  title_zh TEXT DEFAULT '',
  authors TEXT DEFAULT '[]',
  author_affiliations TEXT DEFAULT '[]',
  author_affil_map TEXT DEFAULT '[]',
  journal_name TEXT DEFAULT '',
  journal_source_group TEXT DEFAULT '',
  published_date TEXT DEFAULT '',
  url TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  abstract_original TEXT DEFAULT '',
  abstract_zh TEXT DEFAULT '',
  publication_type TEXT DEFAULT '',
  domain TEXT DEFAULT '',
  subdomain TEXT DEFAULT '',
  groups TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  profile TEXT NOT NULL,
  dedup_key TEXT NOT NULL DEFAULT '',
  first_collected_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_papers_profile_date ON papers(profile, published_date);
CREATE INDEX IF NOT EXISTS idx_papers_journal ON papers(profile, journal_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_dedup ON papers(profile, dedup_key);
`;

// ─── DB 连接 ─────────────────────────────────────────────────

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // 迁移：为旧数据库添加 author_affil_map 列
  const cols = db.prepare("PRAGMA table_info(papers)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "author_affil_map")) {
    db.exec("ALTER TABLE papers ADD COLUMN author_affil_map TEXT DEFAULT '[]'");
  }
  if (!cols.some((c) => c.name === "groups")) {
    db.exec("ALTER TABLE papers ADD COLUMN groups TEXT DEFAULT '[]'");
  }
  return db;
}

// ─── 去重键 ─────────────────────────────────────────────────
// 与 utils.ts 中 itemKey() 逻辑一致：DOI > URL > journal::title

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function computeDedupKey(paper: Paper): string {
  return (
    normalizeText(paper.doi) ||
    normalizeText(paper.url) ||
    `${normalizeText(paper.journal?.name)}::${paper.title_en}`
  );
}

// ─── Paper ↔ DB row ──────────────────────────────────────────

function paperToRow(paper: Paper, profile: string, dateStr: string): Record<string, unknown> {
  return {
    doi: paper.doi || "",
    title_en: paper.title_en || "",
    title_zh: paper.title_zh || "",
    authors: JSON.stringify(paper.authors || []),
    author_affiliations: JSON.stringify(paper.author_affiliations || []),
    author_affil_map: JSON.stringify(paper.author_affil_map || []),
    journal_name: paper.journal?.name || "",
    journal_source_group: paper.journal?.source_group || "",
    published_date: paper.published_date || "",
    url: paper.url || "",
    image_url: paper.image_url || "",
    abstract_original: paper.abstract_original || "",
    abstract_zh: paper.abstract_zh || "",
    publication_type: paper.publication_type || "",
    domain: paper.classification?.domain || "",
    subdomain: paper.classification?.subdomain || "",
    groups: JSON.stringify(paper.classification?.groups || []),
    tags: JSON.stringify(paper.classification?.tags || []),
    profile,
    dedup_key: computeDedupKey(paper),
    first_collected_date: dateStr
  };
}

function rowToPaper(row: Record<string, unknown>): Paper {
  const parseArr = (v: unknown): string[] => {
    try { return JSON.parse(String(v ?? "[]")) as string[]; } catch { return []; }
  };
  const parseNumArrArr = (v: unknown): number[][] => {
    try { return JSON.parse(String(v ?? "[]")) as number[][]; } catch { return []; }
  };
  return {
    title_en: String(row.title_en || ""),
    title_zh: String(row.title_zh || ""),
    authors: parseArr(row.authors),
    author_affiliations: parseArr(row.author_affiliations),
    author_affil_map: parseNumArrArr(row.author_affil_map),
    journal: {
      name: String(row.journal_name || ""),
      source_group: String(row.journal_source_group || "")
    },
    published_date: String(row.published_date || ""),
    doi: String(row.doi || ""),
    url: String(row.url || ""),
    image_url: String(row.image_url || ""),
    abstract_original: String(row.abstract_original || ""),
    abstract_zh: String(row.abstract_zh || ""),
    publication_type: String(row.publication_type || ""),
    classification: {
      domain: String(row.domain || ""),
      subdomain: String(row.subdomain || ""),
      groups: (() => {
        try { return JSON.parse(String(row.groups || "[]")) as Array<{ group: string; subtopics: string[] }>; }
        catch { return []; }
      })(),
      tags: parseArr(row.tags)
    }
  };
}

// ─── Public API ──────────────────────────────────────────────

export function upsertPapers(dbPath: string, profile: string, papers: Paper[]): number {
  if (papers.length === 0) return 0;
  const db = openDb(dbPath);
  const dateStr = new Date().toISOString().slice(0, 10);

  // 先应用层去重：同一批次中相同 dedup_key 只保留一条
  const seen = new Set<string>();
  const unique: Paper[] = [];
  for (const paper of papers) {
    const key = computeDedupKey(paper);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(paper);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO papers (
      doi, title_en, title_zh, authors, author_affiliations, author_affil_map,
      journal_name, journal_source_group, published_date, url, image_url,
      abstract_original, abstract_zh, publication_type, domain, subdomain, groups, tags,
      profile, dedup_key, first_collected_date, updated_at
    ) VALUES (
      @doi, @title_en, @title_zh, @authors, @author_affiliations, @author_affil_map,
      @journal_name, @journal_source_group, @published_date, @url, @image_url,
      @abstract_original, @abstract_zh, @publication_type, @domain, @subdomain, @groups, @tags,
      @profile, @dedup_key, @first_collected_date, datetime('now','localtime')
    )
    ON CONFLICT(profile, dedup_key) DO UPDATE SET
      doi = excluded.doi,
      title_en = excluded.title_en,
      title_zh = excluded.title_zh,
      authors = excluded.authors,
      author_affiliations = excluded.author_affiliations,
	      author_affil_map = excluded.author_affil_map,
      journal_name = excluded.journal_name,
      journal_source_group = excluded.journal_source_group,
      published_date = excluded.published_date,
      url = excluded.url,
      image_url = excluded.image_url,
      abstract_original = excluded.abstract_original,
      abstract_zh = excluded.abstract_zh,
      publication_type = excluded.publication_type,
      domain = excluded.domain,
      subdomain = excluded.subdomain,
      groups = excluded.groups,
      tags = excluded.tags,
      updated_at = datetime('now','localtime')
  `);

  let count = 0;
  const upsert = db.transaction(() => {
    for (const paper of unique) {
      const row = paperToRow(paper, profile, dateStr);
      stmt.run(row);
      count++;
    }
  });
  upsert();
  db.close();

  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "INFO",
    event: "db.upsert.done", total_input: papers.length, deduped: unique.length, stored: count
  })}\n`);

  return count;
}

export function getPapersByDateRange(
  dbPath: string,
  profile: string,
  startDate: string,
  endDate: string
): Paper[] {
  const db = openDb(dbPath);
  const rows = db.prepare(
    `SELECT * FROM papers WHERE profile = ? AND published_date >= ? AND published_date <= ? ORDER BY published_date DESC`
  ).all(profile, startDate, endDate) as Array<Record<string, unknown>>;
  db.close();
  return rows.map(rowToPaper);
}

export function getWeeklyPapers(dbPath: string, profile: string): Paper[] {
  const timezone = "Asia/Shanghai";
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dayOfWeek = now.getDay(); // 0=Sun ... 6=Sat
  // 上周一 = 今天 - (dayOfWeek + 6) 天，上周日 = 今天 - dayOfWeek 天
  // 若今天是周一(dayOfWeek=1): 上周一 = 今天-7, 上周日 = 今天-1
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - (dayOfWeek === 0 ? 7 : dayOfWeek));
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);

  const startDate = lastMonday.toISOString().slice(0, 10);
  const endDate = lastSunday.toISOString().slice(0, 10);

  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "INFO",
    event: "db.weekly.range", start_date: startDate, end_date: endDate
  })}\n`);

  return getPapersByDateRange(dbPath, profile, startDate, endDate);
}
