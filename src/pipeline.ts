/**
 * pipeline.ts — 分步管道编排器
 *
 * 唯一的 IO 编排层：每个 step 读取上一步的输出文件，写入自己的输出文件。
 * 纯能力函数（LLM、采集器）不产生 IO 副作用。
 *
 * 文件布局（data/{profile}/{date}/）：
 *   1-raw-fetched.json    collect 输出（采集 + 关键词过滤 + LLM 过滤 + 去重）
 *   3-llm-filtered.json   filter 输出（透传，当前 collect 已内置过滤）
 *   5-enriched.json       enrich 输出（翻译 + 分类）
 *   6-digest.md           digest 输出（Markdown）
 *   6-records.json        digest 输出（论文记录，扁平化）
 *   6-papers.json         digest 输出（论文原始结构）
 *   latest.json           指向最新输出的指针（push 后写入）
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord, Paper, ProfileContext, StepResult } from "./types.js";
import { fetchPapers, enrichPapers } from "./modules.js";
import { buildDigestTitle, buildMarkdown, buildRecords } from "./digest.js";
import { publishDigest } from "./publish.js";

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
  const papers = await fetchPapers(ctx.config);
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
  // fetchPapers 已内置 LLM 过滤；此步骤从文件读取并写入透传文件
  const papers = await readJson<Paper[]>(in_);
  await writeJson(out, papers);
  return {
    step: "filter",
    inputCount: papers.length,
    outputCount: papers.length,
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

async function stepDigest(ctx: ProfileContext): Promise<StepResult> {
  const t = Date.now();
  const in_ = f(ctx.outputDir, "5-enriched.json");
  const mdOut = f(ctx.outputDir, "6-digest.md");
  const recOut = f(ctx.outputDir, "6-records.json");
  const papOut = f(ctx.outputDir, "6-papers.json");
  const papers = await readJson<Paper[]>(in_);
  const title = buildDigestTitle(ctx.config);
  await fs.writeFile(mdOut, buildMarkdown(title, papers), "utf-8");
  await writeJson(recOut, buildRecords(papers));
  await writeJson(papOut, papers);
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
  const papFile = f(ctx.outputDir, "6-papers.json");
  const recFile = f(ctx.outputDir, "6-records.json");
  const title = buildDigestTitle(ctx.config);
  const papers = await readJson<Paper[]>(papFile);
  const records = await readJson<JsonRecord[]>(recFile).catch(() => buildRecords(papers));
  const markdown = await fs.readFile(mdFile, "utf-8");
  await publishDigest(ctx.config, { title, markdown, records, papers });
  return {
    step: "push",
    inputCount: papers.length,
    outputCount: papers.length,
    inputFile: mdFile,
    outputFile: ctx.outputDir,
    durationMs: Date.now() - t
  };
}

// ─── Runner ────────────────────────────────────────────────

const STEPS: Record<string, (ctx: ProfileContext) => Promise<StepResult>> = {
  collect: stepCollect,
  filter: stepFilter,
  enrich: stepEnrich,
  digest: stepDigest,
  push: stepPush
};

export async function runStep(name: string, ctx: ProfileContext): Promise<StepResult> {
  const fn = STEPS[name];
  if (!fn) throw new Error(`Unknown step: ${name}. Valid: ${Object.keys(STEPS).join(", ")}`);
  return fn(ctx);
}
