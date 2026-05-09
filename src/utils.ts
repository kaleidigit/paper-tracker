/**
 * utils.ts
 * 各模块共享的工具函数，避免循环依赖
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord } from "./types.js";

export function resolvePath(p: string, rootDir?: string): string {
  return path.isAbsolute(p) ? p : path.join(rootDir || process.cwd(), p);
}

export function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const item = normalizeText(value);
    if (!item || seen.has(item)) return;
    seen.add(item);
    result.push(item);
  });
  return result;
}

export function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function loadTaxonomy(config: { classification?: { file?: string } }): Promise<Array<Record<string, unknown>>> {
  const file = resolvePath(config.classification?.file || "profiles/top-journal-env-energy/classification.json");
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as { domains?: Array<Record<string, unknown>> };
  return Array.isArray(parsed.domains) ? parsed.domains : [];
}

export async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string, timeoutMs: number, retries = 3): Promise<JsonRecord> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "paper-tracker/1.0 (+https://local)" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      clearTimeout(timer);
      return (await response.json()) as JsonRecord;
    } catch (error) {
      lastError = error;
      clearTimeout(timer);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

export function parseDate(value: unknown): string {
  const input = normalizeText(value);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function parseDateTime(value: unknown): Date | null {
  const input = normalizeText(value);
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateInTz(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

export function strictWindowStartAt(config: { pipeline?: { paper_window?: { timezone?: string } }; app?: { timezone?: string } }): Date {
  const timezone = config.pipeline?.paper_window?.timezone || config.app?.timezone || "Asia/Shanghai";
  const mode = (process.env.PUSH_MODE === 'auto') ? 'auto' : 'manual';

  // 支持从环境变量读取自定义天数（manual-push.sh 使用）
  const customDays = process.env.PUSH_DAYS ? parseInt(process.env.PUSH_DAYS, 10) : null;

  // 获取当前时区的时间
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dayOfWeek = nowInTz.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday

  let daysToGoBack = 1;

  if (customDays !== null && customDays > 0) {
    // 手动指定天数（优先级最高）
    daysToGoBack = customDays;
  } else if (mode === 'auto') {
    // 自动推送模式：周一推送3天，周二-周五推送1天
    if (dayOfWeek === 1) {
      // 周一：推送周五、周六、周日（3天）
      daysToGoBack = 3;
    } else if (dayOfWeek >= 2 && dayOfWeek <= 5) {
      // 周二-周五：推送昨天（1天）
      daysToGoBack = 1;
    } else {
      // 周六、周日：理论上不应该自动推送，但如果运行了，推送昨天
      daysToGoBack = 1;
    }
  } else {
    // 手动推送模式：默认推送昨天（但应该通过 PUSH_DAYS 指定）
    daysToGoBack = 1;
  }

  // 计算开始时间：往前推 daysToGoBack 天，设置为 08:00:00
  const startAt = new Date(nowInTz);
  startAt.setDate(nowInTz.getDate() - daysToGoBack);
  startAt.setHours(8, 0, 0, 0);

  return startAt;
}

export function restoreAbstract(index: Record<string, number[]> | undefined): string {
  if (!index || typeof index !== "object") return "";
  const map: Record<number, string> = {};
  Object.entries(index).forEach(([word, offsets]) => {
    offsets.forEach((offset) => { map[offset] = word; });
  });
  return Object.keys(map)
    .map((key) => Number(key))
    .sort((a, b) => a - b)
    .map((offset) => map[offset])
    .join(" ");
}

export function absoluteUrl(raw: string, base?: string): string {
  const url = normalizeText(raw);
  if (!url) return "";
  try {
    return base ? new URL(url, base).toString() : new URL(url).toString();
  } catch {
    return url;
  }
}

export function normalizePublicationType(value: unknown): string {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "unknown";
  if (text.includes("review")) return "review";
  if (text.includes("editorial") || text.includes("news & views") || text.includes("research briefing")) return "editorial";
  if (text.includes("letter") || text.includes("brief communication")) return "letter";
  if (text.includes("comment") || text.includes("perspective")) return "comment";
  if (text.includes("article") || text.includes("original research") || text.includes("research article")) return "article";
  return text;
}

export function shouldSkipLlmRescueByTitle(title: string): boolean {
  const t = normalizeText(title).toLowerCase();
  if (!t) return true;
  return /\b(author\s*correction|publisher\s*correction|retraction|correction\b|briefing\s*chat|career\s*column|podcast|news\s*&\s*views|research\s*briefing)/i.test(t);
}

export function matchesKeywords(
  config: { sources?: { keywords?: unknown[]; exclude_keywords?: unknown[] } },
  title: string,
  abstract: string,
  journal: string
): boolean {
  const blob = `${title} ${abstract} ${journal}`.toLowerCase();

  // 排除规则：命中任意一个即拒绝（优先执行）
  const excludeKeywords = toArray(config.sources?.exclude_keywords)
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
  if (excludeKeywords.some((kw) => kw && blob.includes(kw))) {
    return false;
  }

  // 包含规则：至少命中一个
  const includeKeywords = toArray(config.sources?.keywords)
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
  return includeKeywords.some((kw) => kw && blob.includes(kw));
}

export function extractImageFromRssItem(item: JsonRecord): string {
  const candidates: unknown[] = [
    item["media:content"],
    item["media:thumbnail"],
    item.enclosure,
    item.image,
    item["itunes:image"],
    item["content:encoded"]
  ];
  for (const candidate of candidates) {
    const urls = dedupeStrings(
      toArray(candidate as Record<string, unknown>).flatMap((c): string[] => {
        const v = c as Record<string, unknown>;
        return [v.name, v["#text"], v.content, v.url, v.href, v.src].map(String).filter(Boolean) as string[];
      })
    );
    const match = urls.find((u) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(u) || /^https?:\/\//i.test(u));
    if (match) {
      const base = normalizeText(item.link as string);
      try {
        return base ? new URL(match, base).toString() : match;
      } catch {
        return match;
      }
    }
  }
  return "";
}

const DOI_RE = /(?:^|[\s:])10\.\d{4,}\/[^\s]+$/;
export function extractAffiliationsFromRssItem(item: JsonRecord): string[] {
  const candidates: unknown[] = [
    item["prism:affiliation"],
    item.affiliation,
    item["author:affiliation"]
  ];
  return dedupeStrings(
    candidates
      .flatMap((c) => toArray(c as Record<string, unknown>).map((r) => normalizeText((r as Record<string, unknown>).name || (r as Record<string, unknown>)["#text"] || r as unknown as string)))
      .filter((s) => Boolean(s) && !DOI_RE.test(s))
  );
}

export function heuristicClassification(
  text: string,
  taxonomy: Array<Record<string, unknown>>
): { domain: string; subdomain: string; tags: string[] } {
  const lowered = text.toLowerCase();
  for (const domain of taxonomy) {
    const domainName = normalizeText(domain.name) || "未分类";
    const subdomains = toArray(domain.subdomains as Array<Record<string, unknown>> | undefined);
    for (const subdomain of subdomains) {
      const keywords = dedupeStrings(
        toArray(subdomain.keywords as string[] | undefined).map((k) => normalizeText(k).toLowerCase())
      );
      if (keywords.some((kw) => kw && lowered.includes(kw))) {
        return {
          domain: domainName,
          subdomain: normalizeText(subdomain.name as string) || "未分类",
          tags: keywords.slice(0, 3)
        };
      }
    }
  }
  return { domain: "未分类", subdomain: "未分类", tags: [] };
}

export function itemKey(paper: { doi?: string; url?: string; journal?: { name?: string }; title_en?: string }): string {
  return (
    normalizeText(paper.doi) ||
    normalizeText(paper.url) ||
    `${normalizeText(paper.journal?.name)}::${paper.title_en}`
  );
}

