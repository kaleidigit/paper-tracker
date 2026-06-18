import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { AppConfig, ProfileContext, RunState, MetricsState, TaxonomyGroup } from "./types.js";
import type { JournalEntry } from "./parsers/types.js";
import { resolvePath as resolvePathRaw } from "./utils.js";

dotenv.config();

const RootConfigSchema = z.object({
  profiles: z.array(z.string()).optional(),
  ai: z.record(z.string(), z.unknown()).optional(),
  rss: z.record(z.string(), z.unknown()).optional(),
  email: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const ROOT_DIR = process.cwd();
const ROOT_CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const LEGACY_CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT_DIR, "profiles", "top", "config.json");

function asNumber(input: unknown, fallback: number): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export const resolvePath = (p: string) => resolvePathRaw(p, ROOT_DIR);

// ─── 分类 / 期刊配置加载 ──────────────────────────────────────

const ClassificationSchema = z.object({
  groups: z.array(z.object({
    name: z.string(),
    subtopics: z.array(z.object({
      name: z.string(),
      keywords: z.array(z.string()).optional().default([])
    })).optional().default([])
  })).optional(),
  domains: z.array(z.object({
    name: z.string(),
    subtopics: z.array(z.object({
      name: z.string(),
      keywords: z.array(z.string()).optional().default([])
    })).optional().default([])
  })).optional(),
});

export async function loadTaxonomy(config: AppConfig): Promise<TaxonomyGroup[]> {
  const file = resolvePath(config.classification?.file || "profiles/top/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = ClassificationSchema.parse(JSON.parse(raw));
  if (Array.isArray(parsed.groups) && parsed.groups.length > 0) return parsed.groups as TaxonomyGroup[];
  if (Array.isArray(parsed.domains)) return parsed.domains as TaxonomyGroup[];
  return [];
}

const JournalEntrySchema = z.object({
  name: z.string(),
  source_group: z.string(),
  issn: z.string().optional(),
  publisher_strategy: z.string().optional(),
  rss_feeds: z.array(z.string()).optional(),
  sort_order: z.number().optional(),
});

export async function loadJournals(config: AppConfig): Promise<JournalEntry[]> {
  const file = resolvePath(config.sources?.journals_file || "profiles/top/journals.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`journals file is not an array: ${file}`);
  return z.array(JournalEntrySchema).parse(parsed);
}

// ─── 根配置加载 ────────────────────────────────────────────

interface RootConfig {
  profiles?: string[];
  ai?: Partial<AppConfig["ai"]>;
  rss?: Partial<AppConfig["rss"]>;
  email?: Partial<AppConfig["email"]>;
}

async function loadRootConfig(): Promise<RootConfig> {
  const raw = await fs.readFile(ROOT_CONFIG_PATH, "utf-8");
  return RootConfigSchema.parse(JSON.parse(raw)) as RootConfig;
}


export async function loadProfilesList(): Promise<string[]> {
  const root = await loadRootConfig();
  return root.profiles || ["top"];
}

// ─── 深度合并：用 source 覆盖 target，只合并对象，其他值 source 优先 ──

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sVal = source[key];
    const tVal = result[key];
    if (
      sVal !== null && typeof sVal === "object" && !Array.isArray(sVal) &&
      tVal !== null && typeof tVal === "object" && !Array.isArray(tVal)
    ) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>
      );
    } else if (sVal !== undefined) {
      (result as Record<string, unknown>)[key as string] = sVal;
    }
  }
  return result;
}

// ─── Profile 感知的配置加载 ──────────────────────────────────

export async function loadProfileContext(profile?: string): Promise<ProfileContext> {
  const profileName = profile || process.env.PROFILE || "top";
  const profileDir = path.join(ROOT_DIR, "profiles", profileName);
  const configFile = path.join(profileDir, "config.json");

  // 1. 加载根配置（全局 AI 默认值）
  let rootConfig: RootConfig;
  try {
    rootConfig = await loadRootConfig();
  } catch {
    rootConfig = {};
  }

  // 2. 加载 profile 配置
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf-8");
  } catch {
    raw = await fs.readFile(LEGACY_CONFIG_PATH, "utf-8");
  }
  const profileConfig = JSON.parse(raw) as AppConfig;

  // 3. 合并：根 ai 配置为底层，profile ai 配置覆盖差异项
  const mergedAi = deepMerge(
    (rootConfig.ai || {}) as Record<string, unknown>,
    (profileConfig.ai || {}) as Record<string, unknown>
  ) as AppConfig["ai"];
  const config: AppConfig = {
    ...profileConfig,
    ai: mergedAi,
    rss: { ...rootConfig.rss, ...profileConfig.rss },
    email: { ...rootConfig.email, ...profileConfig.email }
  };

  // Resolve relative paths within the profile directory
  if (config.sources?.journals_file && !path.isAbsolute(config.sources.journals_file)) {
    config.sources.journals_file = path.join(profileDir, config.sources.journals_file);
  } else if (!config.sources?.journals_file) {
    config.sources = config.sources || {};
    config.sources.journals_file = path.join(profileDir, "journals.json");
  }

  if (config.classification?.file && !path.isAbsolute(config.classification.file)) {
    config.classification.file = path.join(profileDir, config.classification.file);
  } else if (!config.classification?.file) {
    config.classification = config.classification || {};
    config.classification.file = path.join(profileDir, "classification.json");
  }

  applyDefaults(config);

  const timezone = config.app?.timezone || "Asia/Shanghai";
  const dateStr = nowInTimezone(timezone).toISOString().slice(0, 10);
  const outputDir = path.join(ROOT_DIR, "data", profileName, dateStr);

  return { profile: profileName, config, outputDir, dateStr };
}

function nowInTimezone(timezone: string): Date {
  const text = new Date().toLocaleString("en-US", { timeZone: timezone });
  return new Date(text);
}

export function applyDefaults(parsed: AppConfig): void {
  parsed.runtime = parsed.runtime || ({} as AppConfig["runtime"]);
  parsed.runtime.mode = parsed.runtime.mode || "run-once";
  parsed.runtime.state_dir = parsed.runtime.state_dir || "data/ts-runner";
  parsed.runtime.logs_dir = parsed.runtime.logs_dir || "data/ts-runner/logs";
  parsed.runtime.temp_dir = parsed.runtime.temp_dir || "data/ts-runner/tmp";
  parsed.runtime.command_timeout_ms = asNumber(parsed.runtime.command_timeout_ms, 10_000);
  parsed.runtime.retry = parsed.runtime.retry || { max_attempts: 1, backoff_ms: 1000 };
  parsed.runtime.retry.max_attempts = asNumber(parsed.runtime.retry.max_attempts, 1);
  parsed.runtime.retry.backoff_ms = asNumber(parsed.runtime.retry.backoff_ms, 1000);
  parsed.pipeline = parsed.pipeline || {};
  parsed.pipeline.default_days = asNumber(parsed.pipeline.default_days, 2);
  parsed.pipeline.schedule = parsed.pipeline.schedule || {};
  parsed.pipeline.schedule.hour = asNumber(parsed.pipeline.schedule.hour, 8);
  parsed.pipeline.schedule.minute = asNumber(parsed.pipeline.schedule.minute, 30);
  parsed.pipeline.schedule.check_every_hours = asNumber(parsed.pipeline.schedule.check_every_hours, 1);
  parsed.pipeline.paper_window = parsed.pipeline.paper_window || {};
  parsed.pipeline.paper_window.mode = parsed.pipeline.paper_window.mode || "since_yesterday_time";
  parsed.pipeline.paper_window.hour = asNumber(parsed.pipeline.paper_window.hour, 8);
  parsed.pipeline.paper_window.minute = asNumber(parsed.pipeline.paper_window.minute, 0);
  parsed.pipeline.paper_window.timezone =
    parsed.pipeline.paper_window.timezone || parsed.app?.timezone || "Asia/Shanghai";
  parsed.pipeline.paper_window.grace_days = asNumber(parsed.pipeline.paper_window.grace_days, 3);
  parsed.ai = parsed.ai || {};
  parsed.ai.translation = parsed.ai.translation || {};
  parsed.ai.translation.enabled = Boolean(parsed.ai.translation.enabled ?? true);
  parsed.ai.translation.model = parsed.ai.translation.model || parsed.ai.model || "";
  parsed.ai.translation.api_key_env = parsed.ai.translation.api_key_env || parsed.ai.api_key_env || "SILICONFLOW_API_KEY";
  parsed.ai.translation.required = Boolean(parsed.ai.translation.required ?? true);
  parsed.ai.http_timeout_ms = asNumber(parsed.ai.http_timeout_ms, 120_000);
  parsed.ai.temperature = asNumber(parsed.ai.temperature, 0.2);
  parsed.ai.max_tokens = asNumber(parsed.ai.max_tokens, 2000);
  parsed.ai.filter = parsed.ai.filter || {};
  parsed.ai.filter.enabled = Boolean(parsed.ai.filter.enabled);
  parsed.ai.filter.temperature = asNumber(parsed.ai.filter.temperature, 0);
  parsed.ai.filter.max_tokens = asNumber(parsed.ai.filter.max_tokens, 500);
  parsed.ai.filter.min_confidence = asNumber(parsed.ai.filter.min_confidence, 0.5);
  parsed.ai.filter.batch_size = asNumber(parsed.ai.filter.batch_size, 3);
  parsed.sources = parsed.sources || {};
  parsed.rss = { enabled: true, language: "zh-CN", max_items: 100, ...parsed.rss };
  parsed.email = { enabled: false, provider: "smtp", smtp_host: "smtp.126.com", smtp_port: 465, smtp_secure: true, subject_template: "论文日报 {date}", ...parsed.email };
}

// ─── Legacy config loader (backward compatible) ──────────────

export async function loadAppConfig(): Promise<AppConfig> {
  const rootConfig = await loadRootConfig();
  const raw = await fs.readFile(LEGACY_CONFIG_PATH, "utf-8");
  const profileConfig = JSON.parse(raw) as AppConfig;
  const mergedAi = deepMerge(
    (rootConfig.ai || {}) as Record<string, unknown>,
    (profileConfig.ai || {}) as Record<string, unknown>
  ) as AppConfig["ai"];
  const config = { ...profileConfig, ai: mergedAi };
  applyDefaults(config);
  return config;
}

export const defaultRunState: RunState = {
  last_run_key: "",
  last_success_at: "",
  last_error: "",
  last_duration_ms: 0
};

export const defaultMetricsState: MetricsState = {
  total_runs: 0,
  success_runs: 0,
  failed_runs: 0,
  avg_duration_ms: 0,
  last_error: "",
  updated_at: ""
};
