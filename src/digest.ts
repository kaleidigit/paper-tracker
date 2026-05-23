/**
 * digest.ts — Markdown / JSON 摘要生成
 *
 * 不涉及任何 IO、LLM 调用或网络操作。
 */

import type { AppConfig, JsonRecord, Paper } from "./types.js";

export function buildDigestTitle(config: AppConfig): string {
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dateText = now.toISOString().slice(0, 10);
  const tpl = config.pipeline?.digest_title_template || "{date} 环境能源论文日报";
  return tpl.replace("{date}", dateText);
}

// ─── 作者/单位角标渲染 ──────────────────────────────────────

const SUPER_DIGITS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"
};

function superscriptNum(n: number): string {
  return String(n).split("").map((d) => SUPER_DIGITS[d] || d).join("");
}

/** 当 author_affil_map 可用时，返回带角标的作者行和单位行；否则返回 null */
function formatAuthorsWithMap(paper: Paper): { authorsLine: string; affilsLine: string } | null {
  const authors = paper.authors || [];
  const affiliations = paper.author_affiliations || [];
  const map = paper.author_affil_map;
  if (!map || map.length !== authors.length || affiliations.length === 0) return null;

  const authorParts = authors.map((name, i) => {
    const refs = [...new Set(map[i] || [])].sort((a, b) => a - b);
    return refs.length > 0 ? name + refs.map((j) => superscriptNum(j + 1)).join("") : name;
  });

  const affParts = affiliations.map((aff, i) => `${superscriptNum(i + 1)}${aff}`);

  return { authorsLine: authorParts.join(", "), affilsLine: affParts.join("；") };
}

// ─── 日刊 ──────────────────────────────────────────────────

export function buildMarkdown(title: string, papers: Paper[]): string {
  const sorted = [...papers].sort((a, b) => {
    const orderA = a.journal?.sort_order ?? 999;
    const orderB = b.journal?.sort_order ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return `${b.published_date}`.localeCompare(`${a.published_date}`);
  });

  const lines: string[] = [`# ${title}`, "", `共收录 **${sorted.length}** 篇。`, ""];
  sorted.forEach((paper, i) => {
    if (i > 0) lines.push("---", "");
    lines.push(renderPaperCard(paper, i, 2));
  });

  return lines.join("\n");
}

// ─── Combined digest ────────────────────────────────────────

const PROFILE_LABELS: Record<string, string> = {
  top: "环境能源",
  econ: "环境经济",
  law: "法学"
};

function renderPaperCard(paper: Paper, index: number, headingLevel: number): string {
  const prefix = "#".repeat(headingLevel);
  const cls = paper.classification || {};
  const paperTitle = paper.title_zh || paper.title_en || `论文 ${index + 1}`;
  const englishTitle = (paper.title_en || "").trim();
  const metaLines: string[] = [];
  const resourceLines: string[] = [];
  const lines: string[] = [];

  lines.push(`${prefix} ${index + 1}. ${paperTitle}`, "");
  if (englishTitle && englishTitle !== paperTitle) lines.push(`*${englishTitle}*`, "");

  const pushMeta = (target: string[], label: string, value?: string) => {
    const text = (value || "").trim();
    if (text) target.push(`- **${label}**：${text}`);
  };

  const authorAffilFormatted = formatAuthorsWithMap(paper);
  if (authorAffilFormatted) {
    pushMeta(metaLines, "作者", authorAffilFormatted.authorsLine);
    pushMeta(metaLines, "作者单位", authorAffilFormatted.affilsLine);
  } else {
    pushMeta(metaLines, "作者", (paper.authors || []).join(", "));
    pushMeta(metaLines, "作者单位", (paper.author_affiliations || []).join("；"));
  }
  pushMeta(metaLines, "期刊", paper.journal?.name || "");
  pushMeta(metaLines, "日期", paper.published_date || "");
  pushMeta(metaLines, "类型", paper.publication_type || "unknown");
  const groups = (cls.groups || []) as Array<{ group: string; subtopics: string[] }>;
  if (groups.length > 0) {
    const groupTexts = groups.map((g) => {
      const subs = g.subtopics && g.subtopics.length > 0 ? `（${g.subtopics.join("、")}）` : "";
      return `${g.group}${subs}`;
    });
    pushMeta(metaLines, "建议关注", groupTexts.join("；"));
  }
  pushMeta(metaLines, "标签", (cls.tags || []).join("，"));
  if (metaLines.length > 0) lines.push(...metaLines, "");

  if (paper.abstract_zh) {
    lines.push(`**中文摘要**  `, paper.abstract_zh.trim(), "");
  }
  if (paper.summary_zh) {
    lines.push(
      `**摘要总结**  `,
      ...paper.summary_zh.trim().split("\n").map((l) => `> ${l}`),
      ""
    );
  }

  pushMeta(resourceLines, "DOI", paper.doi || "");
  pushMeta(resourceLines, "链接", paper.url || "");
  if (resourceLines.length > 0) {
    lines.push("**资源信息**  ", ...resourceLines, "");
  }

  if (paper.image_url) {
    lines.push("**主图**  ", `![](${paper.image_url})`, "");
  }

  return lines.join("\n");
}

export function buildCombinedMarkdown(
  title: string,
  profiles: Array<{ profile: string; papers: Paper[] }>
): string {
  const lines: string[] = [`# ${title}`, ""];
  const total = profiles.reduce((sum, p) => sum + p.papers.length, 0);
  lines.push(`共收录 **${total}** 篇。`, "");

  for (const { profile, papers } of profiles) {
    if (papers.length === 0) continue;

    const label = PROFILE_LABELS[profile] || profile;
    lines.push(`---`, "", `## ${label}（${papers.length} 篇）`, "");

    // Sort by journal order then date (same as buildMarkdown)
    const sorted = [...papers].sort((a, b) => {
      const orderA = a.journal?.sort_order ?? 999;
      const orderB = b.journal?.sort_order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return `${b.published_date}`.localeCompare(`${a.published_date}`);
    });

    sorted.forEach((paper, i) => {
      lines.push(renderPaperCard(paper, i, 3));
      if (i < sorted.length - 1) lines.push("---", "");
    });

    lines.push("");
  }

  return lines.join("\n");
}

export function buildRecords(papers: Paper[]): JsonRecord[] {
  return papers.map((paper) => ({
    title_en: paper.title_en || "",
    title_zh: paper.title_zh || "",
    authors: (paper.authors || []).join(", "),
    author_affiliations: (paper.author_affiliations || []).join("; "),
    journal: paper.journal?.name || "",
    source_group: paper.journal?.source_group || "",
    published_date: paper.published_date || "",
    publication_type: paper.publication_type || "",
    groups: (paper.classification?.groups || []).map(
      (g: { group: string; subtopics: string[] }) =>
        `${g.group}${g.subtopics && g.subtopics.length > 0 ? ":" + g.subtopics.join(",") : ""}`
    ).join("; "),
    tags: (paper.classification?.tags || []).join(", "),
    abstract_zh: paper.abstract_zh || "",
    summary_zh: paper.summary_zh || "",
    novelty_points: (paper.novelty_points || []).join("\n"),
    main_content: (paper.main_content || []).join("\n"),
    doi: paper.doi || "",
    url: paper.url || "",
    image_url: paper.image_url || ""
  }));
}