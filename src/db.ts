/**
 * db.ts — SQLite 去重缓存
 *
 * 仅存储论文原始字段（不含 LLM 派生数据），用于：
 *   1. 采集后快速查重，跳过已知论文（省 LLM token）
 *   2. 跨天去重（已知论文不重复推送）
 */

import Database from "better-sqlite3";
import type { Paper } from "./types.js";
import { itemKey } from "./utils.js";
import { logEvent } from "./logger.js";

// ─── Schema ──────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  dedup_key TEXT NOT NULL,
  title_en TEXT NOT NULL,
  abstract_original TEXT DEFAULT '',
  journal_name TEXT DEFAULT '',
  journal_source_group TEXT DEFAULT '',
  published_date TEXT DEFAULT '',
  publication_type TEXT DEFAULT '',
  doi TEXT DEFAULT '',
  url TEXT DEFAULT '',
  authors TEXT DEFAULT '[]',
  author_affiliations TEXT DEFAULT '[]',
  profile TEXT NOT NULL,
  first_collected_date TEXT NOT NULL,
  PRIMARY KEY (profile, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_papers_published ON papers(profile, published_date);
`;

// ─── DB 连接 ─────────────────────────────────────────────────

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

// ─── 去重键 ─────────────────────────────────────────────────
// 与 utils.ts 中 itemKey() 逻辑一致：DOI > URL > journal::title




// ─── Paper → DB row ──────────────────────────────────────────

function paperToRow(paper: Paper, profile: string, dateStr: string): Record<string, unknown> {
  return {
    dedup_key: itemKey(paper),
    title_en: paper.title_en || "",
    abstract_original: paper.abstract_original || "",
    journal_name: paper.journal?.name || "",
    journal_source_group: paper.journal?.source_group || "",
    published_date: paper.published_date || "",
    publication_type: paper.publication_type || "",
    doi: paper.doi || "",
    url: paper.url || "",
    authors: JSON.stringify(paper.authors || []),
    author_affiliations: JSON.stringify(paper.author_affiliations || []),
    profile,
    first_collected_date: dateStr
  };
}

// ─── Public API ──────────────────────────────────────────────

/** 返回已在 DB 中的 dedup_key 集合（用于采集后跳过已知论文） */
export function getKnownDedupKeys(db: Database.Database, profile: string, keys: string[]): Set<string> {
  if (keys.length === 0) return new Set();
  const placeholders = keys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT dedup_key FROM papers WHERE profile = ? AND dedup_key IN (${placeholders})`
  ).all(profile, ...keys) as Array<{ dedup_key: string }>;
  return new Set(rows.map((r) => r.dedup_key));
}

/** 写入论文（仅原始字段），ON CONFLICT 时更新已有记录 */
export function upsertPapers(db: Database.Database, profile: string, papers: Paper[]): number {
  if (papers.length === 0) return 0;
  const dateStr = new Date().toISOString().slice(0, 10);

  // 批次内去重
  const seen = new Set<string>();
  const unique: Paper[] = [];
  for (const paper of papers) {
    const key = itemKey(paper);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(paper);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO papers (
      dedup_key, title_en, abstract_original, journal_name, journal_source_group,
      published_date, publication_type, doi, url, authors, author_affiliations,
      profile, first_collected_date
    ) VALUES (
      @dedup_key, @title_en, @abstract_original, @journal_name, @journal_source_group,
      @published_date, @publication_type, @doi, @url, @authors, @author_affiliations,
      @profile, @first_collected_date
    )
    ON CONFLICT(profile, dedup_key) DO UPDATE SET
      title_en = excluded.title_en,
      abstract_original = excluded.abstract_original,
      journal_name = excluded.journal_name,
      journal_source_group = excluded.journal_source_group,
      published_date = excluded.published_date,
      publication_type = excluded.publication_type,
      doi = excluded.doi,
      url = excluded.url,
      authors = excluded.authors,
      author_affiliations = excluded.author_affiliations
  `);

  let count = 0;
  const upsert = db.transaction(() => {
    for (const paper of unique) {
      stmt.run(paperToRow(paper, profile, dateStr));
      count++;
    }
  });
  upsert();

  logEvent("INFO", "db.upsert.done", { total_input: papers.length, deduped: unique.length, stored: count });

  return count;
}
