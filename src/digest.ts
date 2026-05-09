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
  const tpl = config.pipeline?.digest_title_template || "{date} 顶刊论文日报";
  return tpl.replace("{date}", dateText);
}

export function buildMarkdown(title: string, papers: Paper[]): string {
  const lines: string[] = [`# ${title}`, "", `共收录 **${papers.length}** 篇。`, ""];

  papers.forEach((paper, index) => {
    const cls = paper.classification || {};
    const paperTitle = paper.title_zh || paper.title_en || `论文 ${index + 1}`;
    const englishTitle = (paper.title_en || "").trim();
    const metaLines: string[] = [];
    const resourceLines: string[] = [];

    if (index > 0) lines.push("---", "");

    lines.push(`## ${index + 1}. ${paperTitle}`, "");
    if (englishTitle && englishTitle !== paperTitle) lines.push(`*${englishTitle}*`, "");

    const pushMeta = (target: string[], label: string, value?: string) => {
      const text = (value || "").trim();
      if (text) target.push(`- **${label}**：${text}`);
    };

    pushMeta(metaLines, "作者", (paper.authors || []).join(", "));
    pushMeta(metaLines, "作者单位", (paper.author_affiliations || []).join("；"));
    pushMeta(metaLines, "期刊", paper.journal?.name || "");
    pushMeta(metaLines, "日期", paper.published_date || "");
    pushMeta(metaLines, "类型", paper.publication_type || "unknown");
    pushMeta(metaLines, "一级领域", cls.domain || "");
    pushMeta(metaLines, "二级领域", cls.subdomain || "");
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
  });

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
    domain: paper.classification?.domain || "",
    subdomain: paper.classification?.subdomain || "",
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