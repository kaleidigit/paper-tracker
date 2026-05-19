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
import type { FilterBudget } from "./parsers/types.js";
import { loadProfilesList } from "./config.js";
import { collectRawPapers, fetchPapers, enrichPapers, loadTaxonomy, filterPapers } from "./modules.js";
import { buildDigestTitle, buildMarkdown, buildRecords, buildWeeklyDigestTitle, buildWeeklyMarkdown } from "./digest.js";
import { publishDigest, pushToFeishu } from "./publish.js";
import { upsertPapers, getWeeklyPapers } from "./db.js";
import { itemKey } from "./utils.js";

// ─── Helpers ───────────────────────────────────────────────

const f = (dir: string, name: string) => path.join(dir, name);
const readJson = async <T = Paper[]>(p: string): Promise<T> =>
  JSON.parse(await fs.readFile(p, "utf-8")) as T;
const writeJson = async (p: string, d: unknown) =>
  fs.writeFile(p, `${JSON.stringify(d, null, 2)}\n`, "utf-8");

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
  const taxonomy = await loadTaxonomy(ctx.config);
  const budget: FilterBudget = {
    remaining: Math.max(0, Number(ctx.config.ai?.filter?.max_checks_per_run ?? 20))
  };
  const filtered = await filterPapers(ctx.config, taxonomy, rawPapers, budget);
  await writeJson(out, filtered);
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "INFO",
    event: "workflow.filter.done", input: rawPapers.length, output: filtered.length,
    rejected: rawPapers.length - filtered.length
  })}\n`);
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
  const count = upsertPapers(dbPath, ctx.profile, papers);
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "INFO",
    event: "workflow.store.done", db_path: dbPath, stored: count, total: papers.length
  })}\n`);
  return {
    step: "store",
    inputCount: papers.length,
    outputCount: count,
    inputFile: in_,
    outputFile: dbPath,
    durationMs: Date.now() - t
  };
}

async function stepWeekly(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const dbPath = path.join(path.dirname(ctx.outputDir), "papers.db");

  const papers = getWeeklyPapers(dbPath, ctx.profile);
  if (papers.length === 0) {
    return {
      step: "weekly",
      inputCount: 0,
      outputCount: 0,
      inputFile: dbPath,
      outputFile: "",
      durationMs: Date.now() - t,
      error: "上周没有收录任何论文，跳过周刊推送"
    };
  }

  const title = buildWeeklyDigestTitle(
    papers.length > 0 ? (papers[papers.length - 1].published_date || "") : "",
    papers.length > 0 ? (papers[0].published_date || "") : ""
  );
  const markdown = buildWeeklyMarkdown(title, papers);
  const records = buildRecords(papers);

  // 输出目录：weekly-{start}~{end}
  const startStr = papers.length > 0 ? papers[papers.length - 1].published_date : "unknown";
  const endStr = papers.length > 0 ? papers[0].published_date : "unknown";
  const weeklyDir = path.join(path.dirname(ctx.outputDir), `weekly-${startStr}~${endStr}`);
  await fs.mkdir(weeklyDir, { recursive: true });

  const mdOut = f(weeklyDir, "6-digest.md");
  const recOut = f(weeklyDir, "6-records.json");
  const papOut = f(weeklyDir, "6-papers.json");

  await fs.writeFile(mdOut, markdown, "utf-8");
  await writeJson(recOut, records);
  await writeJson(papOut, papers);

  // 推送飞书（不重复写文件，文件已写入 weekly 目录）
  const prefix = ctx.config.feishu?.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${title}`;
  const feishuResult = await pushToFeishu(ctx.config, docTitle, markdown);
  const errors: string[] = [];
  if (feishuResult.doc_publish && (feishuResult.doc_publish as JsonRecord).error) {
    errors.push(`doc_create: ${String((feishuResult.doc_publish as JsonRecord).error)}`);
  }
  if (feishuResult.notify_publish) {
    for (const n of (feishuResult.notify_publish as JsonRecord[])) {
      if (n.error) errors.push(`notify: ${String(n.error)}`);
    }
  }

  return {
    step: "weekly",
    inputCount: papers.length,
    outputCount: papers.length,
    inputFile: dbPath,
    outputFile: mdOut,
    durationMs: Date.now() - t,
    error: errors.length > 0 ? errors.join("; ") : undefined
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
  const recFile = f(ctx.outputDir, "6-records.json");
  const title = buildDigestTitle(ctx.config);
  const papers = await readJson<Paper[]>(papFile);
  const records = await readJson<JsonRecord[]>(recFile).catch(() => buildRecords(papers));
  const markdown = await fs.readFile(mdFile, "utf-8");
  const publishResult = await publishDigest(ctx.config, { title, markdown, records, papers });
  const errors: string[] = [];
  const docPub = publishResult.doc_publish as JsonRecord | undefined;
  const notifyPub = publishResult.notify_publish as JsonRecord | undefined;
  if (docPub?.error) errors.push(`doc_create: ${String(docPub.error)}`);
  if (notifyPub?.error) errors.push(`notify: ${String(notifyPub.error)}`);
  if (!publishResult.doc_url && !docPub?.error) errors.push("doc_create: no URL returned");
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

async function stepWeeklyAll(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const dataDir = path.dirname(ctx.outputDir);

  const profiles = await loadProfilesList();

  const allPapers: Paper[] = [];
  for (const profile of profiles) {
    const dbPath = path.join(dataDir, profile, "papers.db");
    try {
      await fs.access(dbPath);
    } catch {
      continue;
    }
    const papers = getWeeklyPapers(dbPath, profile);
    allPapers.push(...papers);
  }

  // 跨 profile 按 dedup_key 去重
  const seen = new Map<string, Paper>();
  for (const paper of allPapers) {
    const key = itemKey(paper);
    if (!seen.has(key)) seen.set(key, paper);
  }
  const papers = [...seen.values()].sort((a, b) =>
    `${b.published_date}`.localeCompare(`${a.published_date}`)
  );

  if (papers.length === 0) {
    return {
      step: "weekly-all",
      inputCount: 0,
      outputCount: 0,
      inputFile: "",
      outputFile: "",
      durationMs: Date.now() - t,
      error: "上周没有收录任何论文，跳过周刊推送"
    };
  }

  const title = buildWeeklyDigestTitle(
    papers[papers.length - 1].published_date || "",
    papers[0].published_date || ""
  );
  const markdown = buildWeeklyMarkdown(title, papers);

  const startStr = papers[papers.length - 1].published_date || "unknown";
  const endStr = papers[0].published_date || "unknown";
  const weeklyDir = path.join(dataDir, ctx.profile, `weekly-${startStr}~${endStr}`);
  await fs.mkdir(weeklyDir, { recursive: true });

  const mdOut = path.join(weeklyDir, "6-digest.md");
  await fs.writeFile(mdOut, markdown, "utf-8");

  const prefix = ctx.config.feishu?.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${title}`;
  const feishuResult = await pushToFeishu(ctx.config, docTitle, markdown);

  const errors: string[] = [];
  if (feishuResult.doc_publish && (feishuResult.doc_publish as JsonRecord).error) {
    errors.push(`doc_create: ${String((feishuResult.doc_publish as JsonRecord).error)}`);
  }
  if (feishuResult.notify_publish) {
    for (const n of (feishuResult.notify_publish as JsonRecord[])) {
      if (n.error) errors.push(`notify: ${String(n.error)}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(), level: "INFO",
    event: "weekly-all.done",
    profiles: profiles.length,
    total_before_dedup: allPapers.length,
    after_dedup: papers.length,
    output_dir: weeklyDir
  })}\n`);

  return {
    step: "weekly-all",
    inputCount: allPapers.length,
    outputCount: papers.length,
    inputFile: "",
    outputFile: mdOut,
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
  weekly: stepWeekly,
  "weekly-all": stepWeeklyAll
};

export async function runStep(name: string, ctx: ProfileContext): Promise<StepResult> {
  const fn = STEPS[name];
  if (!fn) throw new Error(`Unknown step: ${name}. Valid: ${Object.keys(STEPS).join(", ")}`);
  return fn(ctx);
}
