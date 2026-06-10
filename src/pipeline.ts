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
import { buildDigestTitle, buildMarkdown, buildRecords, buildCombinedMarkdown } from "./digest.js";
import { upsertPapers, getKnownDedupKeys, openDb } from "./db.js";
import { buildRssXml } from "./rss.js";
import { digestToHtmlPage } from "./publishers/render-html.js";
import { sendResendEmail } from "./publishers/resend.js";
import { itemKey } from "./utils.js";
import { logEvent } from "./logger.js";

// ─── Shared SMTP config ─────────────────────────────────────

interface SmtpConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string; to: string[]; subject: string;
}

function resolveSmtpConfig(emailCfg: Record<string, unknown>, dateStr: string): SmtpConfig | { error: string } {
  const host = (emailCfg.smtp_host as string) || "smtp.gmail.com";
  const port = Number(emailCfg.smtp_port) || 465;
  const secure = emailCfg.smtp_secure !== false;

  const userEnv = (emailCfg.user_env as string) || "EMAIL_USER";
  const passEnv = (emailCfg.pass_env as string) || "EMAIL_PASS";
  const user = process.env[userEnv] || "";
  const pass = process.env[passEnv] || "";
  if (!user || !pass) {
    return { error: `Missing SMTP credentials: ${userEnv}/${passEnv}` };
  }

  const toEnv = (emailCfg.to_env as string) || "EMAIL_RECIPIENTS";
  const toRaw = process.env[toEnv] || "";
  const to = toRaw.split(",").map((s: string) => s.trim()).filter(Boolean);
  if (to.length === 0) {
    return { error: "No recipients" };
  }

  const from = (emailCfg.from as string) || "noreply@gmail.com";
  const subjTpl = (emailCfg.subject_template as string) || "论文日报 {date}";
  const subject = subjTpl.replace("{date}", dateStr);

  return { host, port, secure, user, pass, from, to, subject };
}

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

  const smtp = resolveSmtpConfig(emailCfg, ctx.dateStr);
  if ("error" in smtp) {
    logEvent("ERROR", "email.missing_creds", { error: smtp.error });
    return { step: "notify", inputCount: papers.length, outputCount: 0, inputFile: in_, outputFile: "", durationMs: Date.now() - t, error: smtp.error };
  }

  const markdownContent = await fs.readFile(f(ctx.outputDir, "6-digest.md"), "utf-8");
  const rssCfg = ctx.config.rss || {};
  const htmlTitle = `${ctx.dateStr} ${rssCfg.title || "论文日报"}`;
  const html = digestToHtmlPage(htmlTitle, markdownContent);

  try {
    await sendResendEmail(smtp.host, smtp.port, smtp.secure, smtp.user, smtp.pass, smtp.from, smtp.to, smtp.subject, html);
    logEvent("INFO", "email.sent", { to: smtp.to.length, papers: papers.length });
  } catch (err) {
    logEvent("ERROR", "email.failed", { error: String(err) });
    return { step: "notify", inputCount: papers.length, outputCount: 0, inputFile: in_, outputFile: "", durationMs: Date.now() - t, error: String(err) };
  }

  return { step: "notify", inputCount: papers.length, outputCount: smtp.to.length, inputFile: in_, outputFile: "", durationMs: Date.now() - t };
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

  // 滚动 7 天窗口：合并去重生成 RSS
  const timezone = ctx.config.app?.timezone || "Asia/Shanghai";
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dateStrs: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(nowInTz);
    d.setDate(d.getDate() - i);
    dateStrs.push(d.toISOString().slice(0, 10));
  }

  // 清理 7 天前的数据目录
  const cutOffDate = new Date(nowInTz);
  cutOffDate.setDate(cutOffDate.getDate() - 7);
  const cutOffStr = cutOffDate.toISOString().slice(0, 10);

  for (const profile of profiles) {
    const profileDir = path.join(dataDir, profile);
    try {
      const entries = await fs.readdir(profileDir);
      for (const entry of entries) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && entry < cutOffStr) {
          await fs.rm(path.join(profileDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // directory doesn't exist yet
    }
  }

  // 收集最近 7 天论文
  for (const dateStr of dateStrs) {
    for (const profile of profiles) {
      try {
        const enrichedFile = path.join(dataDir, profile, dateStr, "5-enriched.json");
        const enriched = await readJson<Paper[]>(enrichedFile);
        for (const paper of enriched) {
          const key = itemKey(paper);
          if (!seen.has(key)) {
            seen.add(key);
            allPapers.push(paper);
          }
        }
      } catch {
        // no data for this date/profile
      }
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

  logEvent("INFO", "workflow.combined-rss.done", { profiles, days: 7, items: allPapers.length });
  return { step: "combined-rss", inputCount: allPapers.length, outputCount: allPapers.length, inputFile: "", outputFile: out, durationMs: Date.now() - t };
}

// ─── Combined Notify（跨 profile 合并发送一封邮件）─────────

async function stepCombinedNotify(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const emailCfg = ctx.config.email || {};

  if (!emailCfg.enabled) {
    return { step: "combined-notify", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }

  const smtp = resolveSmtpConfig(emailCfg, ctx.dateStr);
  if ("error" in smtp) {
    return { step: "combined-notify", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t, error: smtp.error };
  }

  const dataDir = "data";
  const profiles = await loadProfilesList();
  const profilePapers: Array<{ profile: string; papers: Paper[] }> = [];
  const seen = new Set<string>();
  let totalRaw = 0;

  for (const profile of profiles) {
    try {
      const enrichedFile = path.join(dataDir, profile, ctx.dateStr, "5-enriched.json");
      const enriched = await readJson<Paper[]>(enrichedFile);
      totalRaw += enriched.length;
      const unique: Paper[] = [];
      for (const paper of enriched) {
        const key = itemKey(paper);
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(paper);
        }
      }
      if (unique.length > 0) profilePapers.push({ profile, papers: unique });
    } catch {
      // profile has no data for today
    }
  }

  const totalPapers = profilePapers.reduce((sum, p) => sum + p.papers.length, 0);
  if (totalPapers === 0) {
    logEvent("INFO", "email.skip", { reason: "no papers" });
    return { step: "combined-notify", inputCount: 0, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t };
  }

  const mdTitle = `${ctx.dateStr} 论文日报`;
  const markdownContent = buildCombinedMarkdown(mdTitle, profilePapers);

  const rssCfg = ctx.config.rss || {};
  const htmlTitle = `${ctx.dateStr} ${rssCfg.title || "论文日报"}`;
  const html = digestToHtmlPage(htmlTitle, markdownContent);
  const subject = `${smtp.subject}（${totalPapers}篇）`;

  try {
    await sendResendEmail(smtp.host, smtp.port, smtp.secure, smtp.user, smtp.pass, smtp.from, smtp.to, subject, html);
    logEvent("INFO", "email.sent", { to: smtp.to.length, papers: totalPapers });
  } catch (err) {
    logEvent("ERROR", "email.failed", { error: String(err) });
    return { step: "combined-notify", inputCount: totalRaw, outputCount: 0, inputFile: "", outputFile: "", durationMs: Date.now() - t, error: String(err) };
  }

  return { step: "combined-notify", inputCount: totalRaw, outputCount: smtp.to.length, inputFile: "", outputFile: "", durationMs: Date.now() - t };
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
  "combined-rss": stepCombinedRss,
  "combined-notify": stepCombinedNotify
};

export async function runStep(name: string, ctx: ProfileContext): Promise<StepResult> {
  const fn = STEPS[name];
  if (!fn) throw new Error(`Unknown step: ${name}. Valid: ${Object.keys(STEPS).join(", ")}`);
  return fn(ctx);
}
