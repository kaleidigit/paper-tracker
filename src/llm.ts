/**
 * llm.ts
 *
 * 职责：LLM 客户端，封装所有大模型调用
 *   - chatJson(): 通用 JSON 对话
 *   - llmFilter(): 论文筛选
 *   - translatePaperFields(): 标题+摘要翻译
 *   - classifyPaper(): 论文分类
 */

import type { AppConfig, JsonRecord, Paper } from "./types.js";
import {
  normalizeText, dedupeStrings, toArray
} from "./utils.js";

// ─── 模板渲染 ─────────────────────────────────────────────

export function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value), template);
}

// ─── JSON 解析 ─────────────────────────────────────────────

export function parseJsonLenient(text: string): JsonRecord {
  const raw = normalizeText(text);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonRecord;
  } catch {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlock?.[1]) {
      try { return JSON.parse(codeBlock[1]) as JsonRecord; } catch { /* continue */ }
    }
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj?.[0]) {
      try { return JSON.parse(obj[0]) as JsonRecord; } catch { /* ignore */ }
    }
  }
  return {};
}

// ─── HTTP 请求 ─────────────────────────────────────────────

async function postJsonWithTimeout(
  url: string,
  body: JsonRecord,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── API Key 解析 ──────────────────────────────────────────

function aiApiKey(config: AppConfig): string {
  const env = config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) throw new Error(`Missing AI API key in env ${env}`);
  return key;
}

function translationApiKey(config: AppConfig): string {
  const env = config.ai?.translation?.api_key_env || config.ai?.api_key_env || "SILICONFLOW_API_KEY";
  const key = process.env[env] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";
  if (!key) throw new Error(`Missing translation API key in env ${env}`);
  return key;
}

// ─── 通用 JSON 对话 ────────────────────────────────────────

export async function chatJson(config: AppConfig, payload: JsonRecord): Promise<JsonRecord> {
  const baseUrl = normalizeText(config.ai?.base_url);
  if (!baseUrl) throw new Error("Missing ai.base_url");
  const response = await postJsonWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    payload,
    { "Content-Type": "application/json", Authorization: `Bearer ${aiApiKey(config)}` },
    config.runtime.command_timeout_ms
  );
  if (!response.ok) {
    const body = normalizeText(await response.text());
    throw new Error(`AI request failed: HTTP ${response.status}; body=${body}`);
  }
  const json = (await response.json()) as JsonRecord;
  const choices = toArray(json.choices as JsonRecord[] | undefined);
  const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
  return parseJsonLenient(content);
}

// ─── 论文筛选 ──────────────────────────────────────────────

export async function llmFilter(config: AppConfig, taxonomy: Array<Record<string, unknown>>, candidate: Paper): Promise<JsonRecord> {
  if (!config.ai?.filter?.enabled) {
    return { used: false, keep: false, confidence: 0 };
  }
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.start", title: candidate.title_en || "" })}\n`);
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify(candidate),
    keywords_json: JSON.stringify(config.sources?.keywords || []),
    title_en: candidate.title_en || "",
    journal_name: candidate.journal?.name || "",
    published_date: candidate.published_date || "",
    doi: candidate.doi || "",
    url: candidate.url || "",
    abstract_original: candidate.abstract_original || ""
  };
  const systemPrompt = renderTemplate(
    normalizeText(prompts.filter_system) || "你是环境、能源与气候方向的论文筛选器。请只输出 JSON：keep, confidence, reason, suggested_domain, suggested_tags。",
    values
  ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.filter_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.filter?.model || config.ai?.model,
    temperature: config.ai?.filter?.temperature ?? 0,
    max_tokens: config.ai?.filter?.max_tokens ?? 500,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });
  const confidence = Number(parsed.confidence ?? 0);
  const min = Number(config.ai?.filter?.min_confidence ?? 0.5);
  const keep = Boolean(parsed.keep) && confidence >= min;
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", event: "workflow.fetch.filter.done", keep, confidence })}\n`);
  return { ...parsed, used: true, keep, confidence };
}

// ─── 翻译 ──────────────────────────────────────────────────

export async function translatePaperFields(config: AppConfig, paper: Paper): Promise<Pick<Paper, "title_zh" | "abstract_zh">> {
  if (config.ai?.translation?.enabled === false) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const baseUrl = normalizeText(config.ai?.base_url);
  const model = normalizeText(config.ai?.translation?.model || config.ai?.model);
  if (!baseUrl || !model) {
    return { title_zh: paper.title_zh || "", abstract_zh: paper.abstract_zh || "" };
  }
  const prompts = config.ai?.prompts || {};
  const values = {
    paper_json: JSON.stringify({ title_en: paper.title_en || "", abstract_original: paper.abstract_original || "" }),
    title_en: paper.title_en || "",
    abstract_original: paper.abstract_original || ""
  };
  const translationSystem = renderTemplate(
    normalizeText(prompts.translation_system) || "你是学术翻译助手。请只输出 JSON，字段为 title_zh 和 abstract_zh。要求忠实、简洁、术语准确，不要添加额外解释。",
    values
  ) || "";
  const translationUser = renderTemplate(normalizeText(prompts.translation_user_template) || values.paper_json, values);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${translationApiKey(config)}` };
  const requestPayload = (withResponseFormat: boolean): JsonRecord => ({
    model,
    temperature: 0,
    max_tokens: 1200,
    ...(withResponseFormat ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: translationSystem }, { role: "user", content: translationUser }]
  });

  const readTranslated = async (withResponseFormat: boolean): Promise<Pick<Paper, "title_zh" | "abstract_zh">> => {
    const response = await postJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, requestPayload(withResponseFormat), headers, config.runtime.command_timeout_ms);
    if (!response.ok) {
      const body = normalizeText(await response.text());
      throw new Error(`translation request failed: HTTP ${response.status}; body=${body}`);
    }
    const json = (await response.json()) as JsonRecord;
    const choices = toArray(json.choices as JsonRecord[] | undefined);
    const content = normalizeText(((choices[0] as JsonRecord | undefined)?.message as JsonRecord | undefined)?.content);
    const translated = parseJsonLenient(content);
    return { title_zh: normalizeText(translated.title_zh), abstract_zh: normalizeText(translated.abstract_zh) };
  };

  let translated = await readTranslated(true);
  if (!translated.title_zh || !translated.abstract_zh) {
    translated = await readTranslated(false);
  }
  return translated;
}

// ─── 分类 ──────────────────────────────────────────────────

export async function classifyPaper(config: AppConfig, paper: Paper, taxonomy: Array<Record<string, unknown>>): Promise<Paper["classification"]> {
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify({
      title_en: paper.title_en || "",
      title_zh: paper.title_zh || "",
      abstract_original: paper.abstract_original || "",
      abstract_zh: paper.abstract_zh || "",
      journal: paper.journal || {},
      published_date: paper.published_date || "",
      doi: paper.doi || "",
      url: paper.url || ""
    }),
    title_en: paper.title_en || "",
    title_zh: paper.title_zh || "",
    abstract_original: paper.abstract_original || "",
    abstract_zh: paper.abstract_zh || "",
    journal_name: paper.journal?.name || "",
    published_date: paper.published_date || "",
    doi: paper.doi || "",
    url: paper.url || ""
  };
  const systemPrompt = renderTemplate(
    normalizeText(prompts.classify_system) || "你是环境与能源论文分类助手。请只输出 JSON，字段为 classification(domain, subdomain, tags)。",
    values
  ) || "";
  const userPrompt = renderTemplate(normalizeText(prompts.classify_user_template) || values.paper_json, values);
  const parsed = await chatJson(config, {
    model: config.ai?.model,
    temperature: 0,
    max_tokens: Math.min(config.ai?.max_tokens ?? 2000, 800),
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });
  const cls = parsed.classification as JsonRecord | undefined;
  return {
    domain: normalizeText(cls?.domain) || "未分类",
    subdomain: normalizeText(cls?.subdomain) || "未分类",
    tags: dedupeStrings(toArray(cls?.tags as string[] | undefined))
  };
}
