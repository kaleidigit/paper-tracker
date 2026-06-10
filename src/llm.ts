/**
 * llm.ts
 *
 * 职责：LLM 客户端，封装所有大模型调用
 *   - chatJson(): 通用 JSON 对话
 *   - llmFilter(): 论文筛选
 *   - translatePaperFields(): 标题+摘要翻译
 *   - classifyPaper(): 论文分类
 */

import { logEvent } from "./logger.js";
import type { AppConfig, JsonRecord, Paper, TaxonomyGroup } from "./types.js";
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
    // Bracket-counting extraction: find the first '{' then match balanced braces.
    // Avoids the greedy /{[\s\S]*}/ regex which can span past the JSON object
    // when the LLM appends explanatory text containing braces.
    const firstBrace = raw.indexOf("{");
    if (firstBrace !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = firstBrace; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\" && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = raw.slice(firstBrace, i + 1);
            try { return JSON.parse(candidate) as JsonRecord; } catch { /* continue scanning */ }
          }
        }
      }
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
    config.ai?.http_timeout_ms || 120_000
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


/**
 * 合并筛选+翻译：一次 LLM 调用完成判断与翻译。
 * 输入仅含标题和摘要，不提供期刊名、DOI 等元信息。
 * 若 reject → 仅返回 { keep: false }，不浪费 token 做翻译。
 * 若 keep   → 返回 { keep: true, title_zh, abstract_zh }。
 */
export async function llmFilterAndTranslate(
  config: AppConfig,
  paper: Paper
): Promise<JsonRecord & { title_zh?: string; abstract_zh?: string }> {
  // 禁用 filter 时直通，但不做翻译
  if (config.ai?.filter?.enabled === false) {
    return { used: false, keep: true, confidence: 1 };
  }
  logEvent("INFO", "workflow.filter.start", { title: paper.title_en || "" });

  const prompts = config.ai?.prompts || {};
  const values = {
    title_en: paper.title_en || "",
    abstract_original: paper.abstract_original || ""
  };

  const systemPrompt = renderTemplate(
    normalizeText(prompts.filter_translate_system) || "",
    values
  ) || "你是环境、能源与气候领域的论文筛选与翻译助手。输入英文标题和摘要，判断是否保留。若保留请同时翻译标题和摘要为中文。严格输出 JSON。";

  const userPrompt = renderTemplate(
    normalizeText(prompts.filter_translate_user_template) ||
    `英文标题：{{title_en}}\n英文摘要：{{abstract_original}}`,
    values
  );

  const parsed = await chatJson(config, {
    model: config.ai?.filter?.model || config.ai?.model,
    temperature: config.ai?.filter?.temperature ?? 0,
    max_tokens: Math.max(config.ai?.filter?.max_tokens ?? 500, 1200),
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });

  const confidence = Number(parsed.confidence ?? 0);
  const min = Number(config.ai?.filter?.min_confidence ?? 0.5);
  const keep = Boolean(parsed.keep) && confidence >= min;

  logEvent("INFO", "workflow.filter.done", { keep, confidence });

  const result: JsonRecord & { title_zh?: string; abstract_zh?: string } = {
    used: true, keep, confidence,
    reason: normalizeText(parsed.reason),
    suggested_group: normalizeText(parsed.suggested_group),
    suggested_tags: Array.isArray(parsed.suggested_tags) ? parsed.suggested_tags.map((t: unknown) => normalizeText(t)).filter(Boolean) : []
  };

  if (keep) {
    result.title_zh = normalizeText(parsed.title_zh || "");
    result.abstract_zh = normalizeText(parsed.abstract_zh || "");
  }

  return result;
}

/**
 * 批量筛选+翻译：一次 LLM 调用处理多篇论文。
 * 系统 prompt 尾部动态追加批处理输出格式指令。
 * 若批次调用失败，逐篇回退到 llmFilterAndTranslate。
 */
export async function llmFilterAndTranslateBatch(
  config: AppConfig,
  papers: Paper[]
): Promise<Array<JsonRecord & { title_zh?: string; abstract_zh?: string }>> {
  if (papers.length === 0) return [];
  if (config.ai?.filter?.enabled === false) {
    return papers.map(() => ({ used: false, keep: true, confidence: 1 }));
  }
  const count = papers.length;
  logEvent("INFO", "workflow.filter.batch.start", { count });

  const prompts = config.ai?.prompts || {};
  const values: Record<string, string> = {};
  const baseSystemPrompt = renderTemplate(
    normalizeText(prompts.filter_translate_system) || "",
    values
  ) || "你是环境、能源与气候领域的论文筛选与翻译助手。输入英文标题和摘要，判断是否保留。若保留请同时翻译标题和摘要为中文。严格输出 JSON。";

  const systemPrompt = `${baseSystemPrompt}\n\n你正在处理多篇论文。对每篇论文独立判断。返回格式：\n{"results": [{"index": 0, "keep": true/false, "confidence": 0.0-1.0, "reason": "...", "suggested_group": "...", "suggested_tags": ["..."]}, ...]}\n若 keep=true 还需输出 "title_zh" 和 "abstract_zh"。`;

  const papersList = papers
    .map((p, i) => `[${i}] 标题：${p.title_en || ""}\n    摘要：${p.abstract_original || ""}`)
    .join("\n\n");

  const userPrompt = `请对以下 ${count} 篇论文逐一判断是否保留，并翻译保留的论文：\n\n${papersList}`;

  try {
    const parsed = await chatJson(config, {
      model: config.ai?.filter?.model || config.ai?.model,
      temperature: config.ai?.filter?.temperature ?? 0,
      max_tokens: Math.max(config.ai?.filter?.max_tokens ?? 500, count * 1200),
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
    });

    const results = toArray(parsed.results as Array<Record<string, unknown>> | undefined);
    const min = Number(config.ai?.filter?.min_confidence ?? 0.5);
    const out: Array<JsonRecord & { title_zh?: string; abstract_zh?: string }> = [];

    const hasResult = new Set<number>();
    for (const r of results) {
      const idx = Number(r.index);
      if (isNaN(idx) || idx < 0 || idx >= count) continue;
      hasResult.add(idx);
      const confidence = Number(r.confidence ?? 0);
      const keep = Boolean(r.keep) && confidence >= min;
      const entry: JsonRecord & { title_zh?: string; abstract_zh?: string } = {
        used: true, keep, confidence,
        reason: normalizeText(r.reason),
        suggested_group: normalizeText(r.suggested_group),
        suggested_tags: Array.isArray(r.suggested_tags) ? (r.suggested_tags as unknown[]).map((t: unknown) => normalizeText(t)).filter(Boolean) : []
      };
      if (keep) {
        entry.title_zh = normalizeText(r.title_zh || "");
        entry.abstract_zh = normalizeText(r.abstract_zh || "");
      }
      out[idx] = entry;
    }

    // 缺失的论文回退到逐篇调用
    for (let i = 0; i < count; i++) {
      if (!hasResult.has(i)) {
        logEvent("WARN", "workflow.filter.batch.missing", { index: i, title: papers[i].title_en });
        try {
          out[i] = await llmFilterAndTranslate(config, papers[i]);
        } catch {
          out[i] = { used: true, keep: false, confidence: 0 };
        }
      }
    }

    logEvent("INFO", "workflow.filter.batch.done", { count, kept: out.filter(r => r.keep).length });
    return out;
  } catch (err) {
    logEvent("WARN", "workflow.filter.batch.error", { error: String(err) });
    throw err;
  }
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
    const response = await postJsonWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, requestPayload(withResponseFormat), headers, config.ai?.http_timeout_ms || 120_000);
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

export async function classifyPaper(config: AppConfig, paper: Paper, taxonomy: TaxonomyGroup[]): Promise<Paper["classification"]> {
  const prompts = config.ai?.prompts || {};
  const values = {
    taxonomy_json: JSON.stringify(taxonomy),
    paper_json: JSON.stringify({
      title_zh: paper.title_zh || paper.title_en || "",
      abstract_zh: paper.abstract_zh || paper.abstract_original || ""
    }),
    title_zh: paper.title_zh || paper.title_en || "",
    abstract_zh: paper.abstract_zh || paper.abstract_original || ""
  };
  const systemPrompt = renderTemplate(
    normalizeText(prompts.classify_system) || "你是环境能源论文分类助手。请只输出 JSON，字段为 classification(groups, tags)。groups 为数组，每项包含 group 和 subtopics。",
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
  const rawGroups = toArray(cls?.groups as Array<Record<string, unknown>> | undefined);
  const groups = rawGroups
    .map((g) => ({
      group: normalizeText(g.group || g.name) || "未分类",
      subtopics: dedupeStrings(toArray(g.subtopics as string[] | undefined))
    }))
    .filter((g) => g.group !== "未分类" || g.subtopics.length > 0);

  return {
    groups: groups.length > 0 ? groups : [{ group: "未分类", subtopics: [] }],
    tags: dedupeStrings(toArray(cls?.tags as string[] | undefined))
  };
}

// ─── 批量分类 ──────────────────────────────────────────────

export async function classifyPapersBatch(
  config: AppConfig,
  papers: Paper[],
  taxonomy: TaxonomyGroup[]
): Promise<Paper["classification"][]> {
  if (papers.length === 0) return [];

  const prompts = config.ai?.prompts || {};
  const baseSystemPrompt = renderTemplate(
    normalizeText(prompts.classify_system) || "你是环境能源论文分类助手。请只输出 JSON，字段为 classification(groups, tags)。groups 为数组，每项包含 group 和 subtopics。",
    { taxonomy_json: JSON.stringify(taxonomy) }
  ) || "";

  const systemPrompt = `${baseSystemPrompt}\n\n你正在处理多篇论文。对每篇独立分类。返回格式：\n{"results": [{"index": 0, "classification": {"groups": [{"group": "...", "subtopics": ["..."]}], "tags": ["..."]}}, ...]}`;

  const papersList = papers
    .map((p, i) => `[${i}] 标题：${p.title_zh || p.title_en || ""}\n    摘要：${(p.abstract_zh || p.abstract_original || "").slice(0, 300)}`)
    .join("\n\n");

  const userPrompt = `请对以下 ${papers.length} 篇论文逐一分类：\n\n${papersList}`;

  const count = papers.length;
  logEvent("INFO", "workflow.enrich.batch_classify.start", { count });

  const parsed = await chatJson(config, {
    model: config.ai?.model,
    temperature: 0,
    max_tokens: Math.max(config.ai?.max_tokens ?? 2000, count * 800),
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
  });
  const results = toArray(parsed.results as Array<Record<string, unknown>> | undefined);
  const out: Paper["classification"][] = new Array(count);

  for (const r of results) {
    const idx = Number(r.index);
    if (isNaN(idx) || idx < 0 || idx >= count) continue;
    const cls = (r.classification || r) as JsonRecord;
    const rawGroups = toArray(cls?.groups as Array<Record<string, unknown>> | undefined);
    const groups = rawGroups
      .map((g) => ({
        group: normalizeText(g.group || g.name) || "未分类",
        subtopics: dedupeStrings(toArray(g.subtopics as string[] | undefined))
      }))
      .filter((g) => g.group !== "未分类" || g.subtopics.length > 0);
    out[idx] = {
      groups: groups.length > 0 ? groups : [{ group: "未分类", subtopics: [] }],
      tags: dedupeStrings(toArray(cls?.tags as string[] | undefined))
    };
  }

  // Missing papers: log and leave undefined for caller to handle
  for (let i = 0; i < count; i++) {
    if (!out[i]) {
      logEvent("WARN", "workflow.enrich.batch_classify.missing", { index: i, title: papers[i].title_en });
    }
  }

  const kept = out.filter(Boolean).length;
  logEvent("INFO", "workflow.enrich.batch_classify.done", { count, kept });

  return out;
}
