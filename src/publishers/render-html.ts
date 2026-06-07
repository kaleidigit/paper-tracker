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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  max-width: 720px; margin: 0 auto; padding: 24px 16px;
  color: #1a1a1a; line-height: 1.7; background: #fff;
}
h1 { font-size: 1.5em; border-bottom: 2px solid #e0e0e0; padding-bottom: 8px; }
h2 { font-size: 1.2em; margin-top: 28px; }
h3 { font-size: 1.05em; margin-top: 24px; }
hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
a { color: #2563eb; text-decoration: none; }
blockquote { border-left: 3px solid #e0e0e0; margin: 8px 0; padding: 4px 12px; color: #555; }
img { max-width: 100%; height: auto; border-radius: 4px; }

/* ── 侧边目录（仅在 screen 介质下生效，邮件客户端忽略）── */
@media screen {
  .toc-sidebar {
    position: fixed; left: 0; top: 0; width: 260px; height: 100vh;
    overflow-y: auto; background: #f8f9fa; border-right: 1px solid #e0e0e0;
    padding: 20px 16px; box-sizing: border-box; z-index: 10;
  }
  .toc-sidebar h2 { font-size: 1em; margin: 0 0 12px 0; color: #666; }
  .toc-sidebar ol { padding-left: 20px; margin: 0; font-size: 0.85em; line-height: 1.8; }
  .toc-sidebar a { color: #555; }
  .toc-sidebar a:hover { color: #2563eb; }
  .toc-sidebar .toc-group { font-weight: 600; color: #333; margin-top: 8px; list-style: none; }
  .toc-sidebar .toc-group::before { content: "▸ "; font-size: 0.8em; }
  body { margin-left: 260px; max-width: calc(100vw - 300px); }
}
@media screen and (max-width: 900px) {
  .toc-sidebar { display: none; }
  body { margin-left: 0; max-width: 100%; }
}

@media (prefers-color-scheme: dark) {
  body { background: #1a1a2e; color: #e0e0e0; }
  h1, h2, h3 { color: #e0e0e0; }
  a { color: #60a5fa; }
  blockquote { color: #aaa; border-left-color: #444; }
  hr { border-top-color: #444; }
  @media screen {
    .toc-sidebar { background: #1e1e36; border-right-color: #333; }
    .toc-sidebar a { color: #aaa; }
    .toc-sidebar a:hover { color: #60a5fa; }
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

/** 单篇论文 → 带内联样式的 HTML 卡片 */
export function paperToHtml(paper: Paper, index: number): string {
  const md = renderPaperCard(paper, index, 2);
  return marked.parse(md, { async: false }) as string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
