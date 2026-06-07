/**
 * render-html.ts — Markdown → HTML 渲染（纯函数，无 IO）
 *
 * 使用 marked 将论文日报 markdown 转为 HTML，用于 RSS <content:encoded> 和邮件。
 */

import { marked } from "marked";
import type { Paper } from "../types.js";
import { renderPaperCard } from "../digest.js";

const INLINE_CSS = `
body {
  font-family: Charter, Georgia, Palatino, "Times New Roman",
               "Songti SC", "Noto Serif CJK SC", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  max-width: 720px; padding: 24px 16px; margin: 0 auto;
  color: #141413; line-height: 1.55; background: #f5f4ed;
}
h1 {
  font-size: 1.5em; font-weight: 500;
  border-bottom: 1px solid #e8e6dc; padding-bottom: 8px; color: #1B365D;
}
h2 {
  font-size: 1.2em; font-weight: 500; margin-top: 28px;
  border-left: 2px solid #1B365D; padding-left: 12px;
}
h3 { font-size: 1.05em; font-weight: 500; margin-top: 24px; }
hr { border: none; border-top: 1px solid #e5e3d8; margin: 16px 0; }
a { color: #1B365D; text-decoration: none; }
blockquote {
  border-left: 2px solid #1B365D; margin: 8px 0;
  padding: 4px 12px; color: #504e49;
}
img { max-width: 100%; height: auto; border-radius: 4px; }

/* ── 侧边目录（仅在 screen 介质下生效，邮件客户端忽略）── */
@media screen {
  .toc-sidebar {
    position: fixed; left: 0; top: 0; width: 260px; height: 100vh;
    overflow-y: auto; background: #faf9f5; border-right: 1px solid #e8e6dc;
    padding: 20px 16px; box-sizing: border-box; z-index: 10;
  }
  .toc-sidebar h2 { font-size: 1em; margin: 0 0 12px 0; color: #6b6a64; font-weight: 500; }
  .toc-sidebar ol { padding-left: 20px; margin: 0; font-size: 0.85em; line-height: 1.8; }
  .toc-sidebar a { color: #504e49; }
  .toc-sidebar a:hover { color: #1B365D; }
  .toc-sidebar .toc-group { font-weight: 500; color: #3d3d3a; margin-top: 8px; list-style: none; }
  .toc-sidebar .toc-group::before { content: "▸ "; font-size: 0.8em; }
  body {
    margin-left: 280px;
    max-width: calc(100vw - 320px);
    padding-right: 24px;
  }
}
@media screen and (max-width: 900px) {
  .toc-sidebar { display: none; }
  body { margin: 0 auto; max-width: 720px; padding: 24px 16px; }
}

@media (prefers-color-scheme: dark) {
  body { background: #141413; color: #e0e0e0; }
  h1 { color: #e0e0e0; border-bottom-color: #3d3d3a; }
  h2, h3 { color: #e0e0e0; }
  h2 { border-left-color: #2D5A8A; }
  a { color: #2D5A8A; }
  blockquote { color: #b0b0ad; border-left-color: #2D5A8A; }
  hr { border-top-color: #3d3d3a; }
  @media screen {
    .toc-sidebar { background: #30302e; border-right-color: #3d3d3a; }
    .toc-sidebar h2 { color: #b0b0ad; }
    .toc-sidebar a { color: #b0b0ad; }
    .toc-sidebar a:hover { color: #2D5A8A; }
    .toc-sidebar .toc-group { color: #e0e0e0; }
  }
}
`.trim();

/** 完整 markdown digest → 完整 HTML 页面（含侧边目录） */
export function digestToHtmlPage(title: string, markdown: string): string {
  // 先生成正文 HTML（给 h3/h2 加 id 做锚点）
  const { html: bodyHtml, toc } = buildBodyWithAnchors(markdown);
  const tocHtml = buildTocHtml(toc);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
<nav class="toc-sidebar">${tocHtml}</nav>
${bodyHtml}
</body>
</html>`;
}

// ─── TOC 数据结构 ──────────────────────────────────────────

interface TocEntry {
  level: number;     // 2=领域标题, 3=论文标题
  text: string;
  id: string;
}

/** 解析 markdown，为 heading 加锚点 id，返回 { html, toc } */
function buildBodyWithAnchors(markdown: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  let counter = 0;

  // 给 markdown 中的 ## 和 ### 行添加 <a id> 锚点
  const processed = markdown.replace(/^(#{2,3})\s+(.+)$/gm, (_match, hashes: string, text: string) => {
    const level = hashes.length;
    const slug = "h-" + (counter++);
    const cleanText = text.replace(/<[^>]+>/g, "").replace(/[`*_~\[\]()]/g, "").trim();
    toc.push({ level, text: cleanText, id: slug });
    return `<a id="${slug}"></a>\n${hashes} ${text}`;
  });

  const html = marked.parse(processed, { async: false }) as string;
  return { html, toc };
}

/** 生成侧边栏目录 HTML */
function buildTocHtml(toc: TocEntry[]): string {
  if (toc.length === 0) return "";

  const hasH3 = toc.some((e) => e.level === 3);
  // Combined digest: h2 = 领域分组, h3 = 论文
  // Single-profile digest: h2 = 论文 (无分组)

  let html = '<h2>📄 目录</h2><ol>';

  if (hasH3) {
    // Combined: h2 groups containing h3 papers
    let inGroup = false;
    for (const entry of toc) {
      if (entry.level === 2) {
        if (inGroup) html += '</ol></li>';
        html += `<li class="toc-group"><a href="#${entry.id}">${escapeHtml(entry.text)}</a><ol>`;
        inGroup = true;
      } else {
        html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>`;
      }
    }
    if (inGroup) html += '</ol></li>';
  } else {
    // Single profile: flat list of h2 = papers
    for (const entry of toc) {
      html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>`;
    }
  }

  html += '</ol>';
  return html;
}

/** 单篇论文 → 带内联样式的 HTML 卡片（无编号，供 RSS 使用） */
export function paperToHtml(paper: Paper): string {
  const md = renderPaperCard(paper, 0, 2);
  // Remove heading number ("## 1. Title" → "## Title") since RSS items are standalone
  const clean = md.replace(/^(#{2,3}) \d+\.\s+/m, "$1 ");
  return marked.parse(clean, { async: false }) as string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
