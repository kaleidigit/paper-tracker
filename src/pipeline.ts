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
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Paper, ProfileContext, StepResult } from "./types.js";
import { loadProfilesList } from "./config.js";
import { collectRawPapers, enrichPapers, loadTaxonomy, filterPapers } from "./modules.js";
import { buildDigestTitle, buildMarkdown, buildRecords } from "./digest.js";
import { upsertPapers, getKnownDedupKeys, openDb } from "./db.js";
import { buildRssXml } from "./rss.js";
import { digestToHtmlPage } from "./publishers/render-html.js";
import { sendResendEmail } from "./publishers/resend.js";
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

// ─── RSS 步骤 ──────────────────────────────────────────────

async function stepRss(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "5-enriched.json");
  const rssCfg = ctx.config.rss || {};
  if (!rssCfg.enabled) {
    return { step: "rss", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }
  const papers = await readJson<Paper[]>(in_);
  const siteUrl = rssCfg.site_url || "https://example.github.io/paper-tracker";
  const feedPath = `feeds/${ctx.profile}.xml`;
  const feedUrl = `${siteUrl.replace(/\/$/, "")}/${feedPath}`;
  const title = rssCfg.title || "论文日报";
  const desc = rssCfg.description || "每日论文追踪";
  const xml = buildRssXml(title, desc, papers, siteUrl, feedUrl, rssCfg.max_items || 100);

  const pubDir = path.join(path.dirname(ctx.outputDir), "..", "..", "public", "feeds");
  await fs.mkdir(pubDir, { recursive: true });
  const out = path.join(pubDir, `${ctx.profile}.xml`);
  await fs.writeFile(out, xml, "utf-8");

  // Optional HTML page
  const htmlTitle = `${ctx.dateStr} ${title}`;
  const htmlOut = path.join(pubDir, "..", "index.html");
  const markdownContent = await fs.readFile(f(ctx.outputDir, "6-digest.md"), "utf-8");
  await fs.writeFile(htmlOut, digestToHtmlPage(htmlTitle, markdownContent), "utf-8");

  logEvent("INFO", "workflow.rss.done", { profile: ctx.profile, feed: out, items: papers.length });
  return { step: "rss", inputCount: papers.length, outputCount: papers.length, inputFile: in_, outputFile: out, durationMs: Date.now() - t };
}

// ─── 邮件通知步骤 ──────────────────────────────────────────

async function stepNotify(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "5-enriched.json");
  const emailCfg = ctx.config.email || {};

  if (!emailCfg.enabled) {
    return { step: "notify", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }

  const papers = await readJson<Paper[]>(in_);
  if (papers.length === 0) {
    logEvent("INFO", "email.skip", { reason: "no papers" });
    return { step: "notify", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }

  const apiKeyEnv = emailCfg.api_key_env || "RESEND_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    const err = `Missing env var ${apiKeyEnv}`;
    logEvent("ERROR", "email.missing_key", { env: apiKeyEnv });
    return { step: "notify", inputCount: papers.length, outputCount: 0, inputFile: in_, outputFile: "", durationMs: Date.now() - t, error: err };
  }

  const toEnv = emailCfg.to_env || "EMAIL_RECIPIENTS";
  const toRaw = process.env[toEnv] || "";
  const to = toRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const from = emailCfg.from || "noreply@example.com";
  const subjTpl = emailCfg.subject_template || "论文日报 {date}";
  const subject = subjTpl.replace("{date}", ctx.dateStr);

  const markdownContent = await fs.readFile(f(ctx.outputDir, "6-digest.md"), "utf-8");
  const rssCfg = ctx.config.rss || {};
  const htmlTitle = `${ctx.dateStr} ${rssCfg.title || "论文日报"}`;
  const html = digestToHtmlPage(htmlTitle, markdownContent);

  try {
    await sendResendEmail(apiKey, from, to, subject, html);
    logEvent("INFO", "email.sent", { to: to.length, papers: papers.length });
  } catch (err) {
    logEvent("ERROR", "email.failed", { error: String(err) });
    return { step: "notify", inputCount: papers.length, outputCount: 0, inputFile: in_, outputFile: "", durationMs: Date.now() - t, error: String(err) };
  }

  return { step: "notify", inputCount: papers.length, outputCount: to.length, inputFile: in_, outputFile: "", durationMs: Date.now() - t };
}

// ─── Combined RSS（跨 profile 合并）────────────────────────

async function stepCombinedRss(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const rssCfg = ctx.config.rss || {};
  if (!rssCfg.enabled) {
    return { step: "combined-rss", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }

  const dataDir = "data";
  const profiles = await loadProfilesList();
  const allPapers: Paper[] = [];
  const seen = new Set<string>();

  for (const profile of profiles) {
    try {
      const enrichedFile = path.join(dataDir, profile, ctx.dateStr, "5-enriched.json");
      const enriched = await readJson<Paper[]>(enrichedFile);
      for (const paper of enriched) {
        const key = itemKey(paper);
        if (!seen.has(key)) {
          seen.add(key);
          allPapers.push(paper);
        }
      }
    } catch {
      // profile has no data for today
    }
  }

  if (allPapers.length === 0) {
    return { step: "combined-rss", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t, error: "没有论文可生成 RSS" };
  }

  const siteUrl = rssCfg.site_url || "https://example.github.io/paper-tracker";
  const feedUrl = `${siteUrl.replace(/\/$/, "")}/feeds/combined.xml`;
  const title = rssCfg.title || "论文日报";
  const desc = rssCfg.description || "每日论文追踪";
  const xml = buildRssXml(title, desc, allPapers, siteUrl, feedUrl, rssCfg.max_items || 100);

  const pubDir = path.join(dataDir, "..", "public", "feeds");
  await fs.mkdir(pubDir, { recursive: true });
  const out = path.join(pubDir, "combined.xml");
  await fs.writeFile(out, xml, "utf-8");

  logEvent("INFO", "workflow.combined-rss.done", { profiles, items: allPapers.length });
  return { step: "combined-rss", inputCount: allPapers.length, outputCount: allPapers.length, inputFile: "", outputFile: out, durationMs: Date.now() - t };
}

// ─── Runner ────────────────────────────────────────────────

const STEPS: Record<string, (ctx: ProfileContext) => Promise<StepResult>> = {
  collect: stepCollect,
  filter: stepFilter,
  enrich: stepEnrich,
  store: stepStore,
  digest: stepDigest,
  rss: stepRss,
  notify: stepNotify,
  "combined-rss": stepCombinedRss
};

export async function runStep(name: string, ctx: ProfileContext): Promise<StepResult> {
  const fn = STEPS[name];
  if (!fn) throw new Error(`Unknown step: ${name}. Valid: ${Object.keys(STEPS).join(", ")}`);
  return fn(ctx);
}
