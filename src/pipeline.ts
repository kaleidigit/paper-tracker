/**
 * pipeline.ts — 分步管道编排器
 *
 * 唯一的 IO 编排层：每个 step 读取上一步的输出文件，写入自己的输出文件。
 * 纯能力函数（LLM、采集器）不产生 IO 副作用。
 *
 * 文件布局（data/{profile}/{date}/）：
 *   1-raw-fetched.json    collect 输出（全量采集 + 去重）
 *   3-llm-filtered.json   filter 输出（关键词 + LLM 筛选）
 *   5-enriched.json       enrich 输出（翻译 + 分类）
 *   6-digest.md           digest 输出（Markdown）
 *   6-records.json        digest 输出（论文记录，扁平化）
 *   latest.json           指向最新输出的指针（push 后写入）
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord, Paper, ProfileContext, StepResult } from "./types.js";
import { loadProfilesList } from "./config.js";
import { collectRawPapers, enrichPapers, loadTaxonomy, filterPapers } from "./modules.js";
import { buildDigestTitle, buildMarkdown, buildRecords, buildCombinedMarkdown } from "./digest.js";
import { pushToFeishu } from "./publish.js";
import { upsertPapers, getKnownDedupKeys, openDb } from "./db.js";
import { itemKey } from "./utils.js";
import { logEvent } from "./logger.js";

// ─── Helpers ───────────────────────────────────────────────

const f = (dir: string, name: string) => path.join(dir, name);
const readJson = async <T = Paper[]>(p: string): Promise<T> =>
  JSON.parse(await fs.readFile(p, "utf-8")) as T;
const writeJson = async (p: string, d: unknown) =>
  fs.writeFile(p, `${JSON.stringify(d)}\n`, "utf-8");

// ─── Steps ─────────────────────────────────────────────────

async function stepCollect(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const out = f(ctx.outputDir, "1-raw-fetched.json");
  await fs.mkdir(ctx.outputDir, { recursive: true });
  const papers = await collectRawPapers(ctx.config);
  await writeJson(out, papers);
  return {
    step: "collect",
    inputCount: 0,
    outputCount: papers.length,
    inputFile: "",
    outputFile: out,
    durationMs: Date.now() - t
  };
}

async function stepFilter(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "1-raw-fetched.json");
  const out = f(ctx.outputDir, "3-llm-filtered.json");
  const rawPapers = await readJson<Paper[]>(in_);

  // ── DB 查重：已知论文直接跳过（省 LLM filter token）────────
  const dbPath = path.join(path.dirname(ctx.outputDir), "papers.db");
  const allKeys = rawPapers.map((p) => itemKey(p));
  let knownKeys: Set<string> = new Set();
  try {
    const db = openDb(dbPath);
    try {
      knownKeys = getKnownDedupKeys(db, ctx.profile, allKeys);
    } finally {
      db.close();
    }
  } catch {
    // DB 不存在或损坏时，全部当作新论文处理
  }
  const newPapers = rawPapers.filter((p) => !knownKeys.has(itemKey(p)));
  const skipped = rawPapers.length - newPapers.length;
  if (skipped > 0) {
    logEvent("INFO", "workflow.filter.db_skip", { skipped, remaining: newPapers.length });
  }

  const taxonomy = await loadTaxonomy(ctx.config);
  const filtered = await filterPapers(ctx.config, taxonomy, newPapers);
  await writeJson(out, filtered);
  logEvent("INFO", "workflow.filter.done", { input: rawPapers.length, skipped, new: newPapers.length, output: filtered.length, rejected: newPapers.length - filtered.length });
  return {
    step: "filter",
    inputCount: rawPapers.length,
    outputCount: filtered.length,
    inputFile: in_,
    outputFile: out,
    durationMs: Date.now() - t
  };
}

async function stepEnrich(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "3-llm-filtered.json");
  const out = f(ctx.outputDir, "5-enriched.json");
  const papers = await readJson<Paper[]>(in_);
  const enriched = await enrichPapers(ctx.config, papers);
  await writeJson(out, enriched);
  return {
    step: "enrich",
    inputCount: papers.length,
    outputCount: enriched.length,
    inputFile: in_,
    outputFile: out,
    durationMs: Date.now() - t
  };
}

async function stepStore(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "5-enriched.json");
  const papers = await readJson<Paper[]>(in_);
  const dbPath = path.join(path.dirname(ctx.outputDir), "papers.db");
  await fs.mkdir(path.dirname(ctx.outputDir), { recursive: true });
  const db = openDb(dbPath);
  let count = 0;
  try {
    count = upsertPapers(db, ctx.profile, papers);
  } finally {
    db.close();
  }
  logEvent("INFO", "workflow.store.done", { db_path: dbPath, stored: count, total: papers.length });
  return {
    step: "store",
    inputCount: papers.length,
    outputCount: count,
    inputFile: in_,
    outputFile: dbPath,
    durationMs: Date.now() - t
  };
}

async function stepDigest(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "5-enriched.json");
  const mdOut = f(ctx.outputDir, "6-digest.md");
  const recOut = f(ctx.outputDir, "6-records.json");
  const papers = await readJson<Paper[]>(in_);
  const title = buildDigestTitle(ctx.config);
  await fs.writeFile(mdOut, buildMarkdown(title, papers), "utf-8");
  await writeJson(recOut, buildRecords(papers));
  return {
    step: "digest",
    inputCount: papers.length,
    outputCount: papers.length,
    inputFile: in_,
    outputFile: mdOut,
    durationMs: Date.now() - t
  };
}

async function stepPush(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const mdFile = f(ctx.outputDir, "6-digest.md");
  const papFile = f(ctx.outputDir, "5-enriched.json");
  const title = buildDigestTitle(ctx.config);
  const papers = await readJson<Paper[]>(papFile);
  const markdown = await fs.readFile(mdFile, "utf-8");
  const prefix = ctx.config.feishu?.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${title}`;
  const feishuResult = await pushToFeishu(ctx.config, docTitle, markdown);
  const errors: string[] = [];
  const docPub = feishuResult.doc_publish as JsonRecord | undefined;
  if (docPub?.error) errors.push(`doc_create: ${String(docPub.error)}`);
  if (docPub?.permission_error) errors.push(`permission: ${String(docPub.permission_error)}`);
  if (!feishuResult.doc_url && !docPub?.error) errors.push("doc_create: no URL returned");
  return {
    step: "push",
    inputCount: papers.length,
    outputCount: papers.length,
    inputFile: mdFile,
    outputFile: ctx.outputDir,
    durationMs: Date.now() - t,
    error: errors.length > 0 ? errors.join("; ") : undefined
  };
}

// ─── Combined push（跨 profile 合并推送）────────────────────

async function stepCombinedPush(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const feishu = ctx.config.feishu || {};
  const dataDir = feishu.data_dir || "data";
  const timezone = ctx.config.app?.timezone || "Asia/Shanghai";
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dateStr = nowInTz.toISOString().slice(0, 10);

  const isDryRun = process.env.PUSH_DRY_RUN === "1";

  const profiles = await loadProfilesList();
  const profilePapers: Array<{ profile: string; papers: Paper[] }> = [];
  const seen = new Set<string>();
  let totalRaw = 0;

  for (const profile of profiles) {
    const enrichedFile = path.join(dataDir, profile, dateStr, "5-enriched.json");
    try {
      await fs.access(enrichedFile);
    } catch {
      continue; // profile has no data for today
    }
    const enriched = await readJson<Paper[]>(enrichedFile);
    totalRaw += enriched.length;

    // Cross-profile dedup
    const unique: Paper[] = [];
    for (const paper of enriched) {
      const key = itemKey(paper);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(paper);
      }
    }
    if (unique.length > 0) profilePapers.push({ profile, papers: unique });
  }

  if (profilePapers.length === 0) {
    return { step: "combined-push", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t, error: "没有论文可推送" };
  }

  const totalAfterDedup = profilePapers.reduce((sum, p) => sum + p.papers.length, 0);

  // Title: use PUSH_DAYS (strict window, no grace) when available, fall back to actual paper date range
  const pushDaysEnv = parseInt(process.env.PUSH_DAYS || "", 10);
  let title: string;
  if (pushDaysEnv > 1) {
    const startDate = new Date(nowInTz);
    startDate.setDate(startDate.getDate() - (pushDaysEnv - 1));
    const startDateStr = startDate.toISOString().slice(0, 10);
    title = `${startDateStr}~${dateStr} 论文日报（${pushDaysEnv}天）`;
  } else if (pushDaysEnv === 1) {
    title = `${dateStr} 论文日报（1天）`;
  } else {
    title = `${dateStr} 论文日报（1天）`;
  }
  const markdown = buildCombinedMarkdown(title, profilePapers);

  // Write combined digest
  const combinedDir = path.join(dataDir, "combined", dateStr);
  const mdFile = path.join(combinedDir, "6-digest-combined.md");
  await fs.mkdir(combinedDir, { recursive: true });
  await fs.writeFile(mdFile, markdown, "utf-8");

  const prefix = feishu.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${title}`;

  const errors: string[] = [];
  if (isDryRun) {
    logEvent("INFO", "combined-push.dry-run", { profiles: profilePapers.map((p) => p.profile), total: totalAfterDedup });
  } else {
    const feishuResult = await pushToFeishu(ctx.config, docTitle, markdown);
    const docPub = feishuResult.doc_publish as JsonRecord | undefined;
    if (docPub?.error) errors.push(`doc_create: ${String(docPub.error)}`);
    if (docPub?.permission_error) errors.push(`permission: ${String(docPub.permission_error)}`);
    if (!feishuResult.doc_url && !docPub?.error) errors.push("doc_create: no URL returned");
  }

  logEvent("INFO", "combined-push.done", {
    profiles: profilePapers.map((p) => p.profile),
    total_before_dedup: totalRaw,
    after_dedup: totalAfterDedup
  });

  return {
    step: "combined-push",
    inputCount: totalRaw,
    outputCount: totalAfterDedup,
    inputFile: "",
    outputFile: mdFile,
    durationMs: Date.now() - t,
    error: errors.length > 0 ? errors.join("; ") : undefined
  };
}

// ─── Runner ────────────────────────────────────────────────

const STEPS: Record<string, (ctx: ProfileContext) => Promise<StepResult>> = {
  collect: stepCollect,
  filter: stepFilter,
  enrich: stepEnrich,
  store: stepStore,
  digest: stepDigest,
  push: stepPush,
  "combined-push": stepCombinedPush
};

export async function runStep(name: string, ctx: ProfileContext): Promise<StepResult> {
  const fn = STEPS[name];
  if (!fn) throw new Error(`Unknown step: ${name}. Valid: ${Object.keys(STEPS).join(", ")}`);
  return fn(ctx);
}
