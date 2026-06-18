/**
 * render-html.ts — Markdown → HTML 渲染（纯函数，无 IO）
 *
 * 使用 marked 将论文日报 markdown 转为 HTML，用于 RSS <content:encoded> 和邮件。
 * 采用 table 双栏布局：左栏目录 + 右栏正文，兼容各邮件客户端。
 */

import { marked } from "marked";
import type { Paper } from "../types.js";
import { renderPaperCard } from "../digest.js";

const INLINE_CSS = `
body {
  font-family: Charter, Georgia, Palatino, "Times New Roman",
               "Songti SC", "Noto Serif CJK SC", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color: #141413; line-height: 1.55; background: #f5f4ed;
  margin: 0; padding: 0;
}
/* ── 双栏布局 table ── */
.layout { width: 100%; max-width: 1100px; margin: 0 auto; border-collapse: collapse; }
.toc-cell {
  width: 240px; vertical-align: top;
  background: #faf9f5; border-right: 1px solid #e8e6dc;
  padding: 20px 16px;
}
/* 浏览器中目录吸附常驻；邮件客户端忽略 sticky，行为不变 */
.toc-inner {
  position: -webkit-sticky; position: sticky; top: 0;
  max-height: 100vh; overflow-y: auto;
}
.spacer { width: 0; padding: 0; }
.content-cell {
  vertical-align: top; padding: 24px 24px;
  max-width: 700px;
}

/* ── TOC ── */
.toc-title { font-size: 0.95em; margin: 0 0 10px 0; color: #6b6a64; font-weight: 500; }
.toc-list { padding-left: 18px; margin: 0; font-size: 0.85em; line-height: 1.7; }
.toc-list a { color: #504e49; text-decoration: none; }
.toc-group { font-weight: 500; color: #3d3d3a; margin-top: 6px; list-style: none; }
.toc-group::before { content: "▸ "; font-size: 0.8em; }

/* ── 正文 ── */
h1 { font-size: 1.5em; font-weight: 500;
     border-bottom: 1px solid #e8e6dc; padding-bottom: 8px; color: #1B365D; }
h2 { font-size: 1.2em; font-weight: 500; margin-top: 28px;
     border-left: 2px solid #1B365D; padding-left: 12px; }
h3 { font-size: 1.05em; font-weight: 500; margin-top: 24px; }
hr { border: none; border-top: 1px solid #e5e3d8; margin: 16px 0; }
a { color: #1B365D; text-decoration: none; }
blockquote { border-left: 2px solid #1B365D; margin: 8px 0;
             padding: 4px 12px; color: #504e49; }
img { max-width: 100%; height: auto; border-radius: 4px; }

/* ── 窄屏/移动端：单列 ── */
@media only screen and (max-width: 700px) {
  .toc-cell { display: block; width: auto; border-right: none;
              border-bottom: 1px solid #e8e6dc; padding: 12px 16px; }
  .toc-inner { position: static; max-height: none; overflow: visible; }
  .content-cell { display: block; padding: 16px; }
  .spacer { display: none; }
}

/* ── Dark mode (browser only) ── */
@media (prefers-color-scheme: dark) {
  body { background: #141413; color: #e0e0e0; }
  .toc-cell { background: #30302e; border-color: #3d3d3a; }
  .toc-list a { color: #b0b0ad; }
  .toc-group { color: #e0e0e0; }
  h1 { color: #e0e0e0; border-bottom-color: #3d3d3a; }
  h2, h3 { color: #e0e0e0; }
  h2 { border-left-color: #2D5A8A; }
  a { color: #2D5A8A; }
  blockquote { color: #b0b0ad; border-left-color: #2D5A8A; }
  hr { border-top-color: #3d3d3a; }
}
`.trim();

/** 完整 markdown digest → 完整 HTML 页面（table 双栏布局） */
export function digestToHtmlPage(title: string, markdown: string): string {
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
<table class="layout" cellpadding="0" cellspacing="0" border="0">
<tr>
  <td class="toc-cell"><div class="toc-inner">${tocHtml}</div></td>
  <td class="spacer">&nbsp;</td>
  <td class="content-cell">${bodyHtml}</td>
</tr>
</table>
</body>
</html>`;
}

// ─── TOC 数据结构 ──────────────────────────────────────────

interface TocEntry {
  level: number;
  text: string;
  id: string;
}

function buildBodyWithAnchors(markdown: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  let counter = 0;

  const processed = markdown.replace(/^(#{2,3})\s+(.+)$/gm, (_match, hashes: string, text: string) => {
    const level = hashes.length;
    const slug = "h-" + (counter++);
    const cleanText = text.replace(/<[^>]+>/g, "").replace(/[`*_~\[\]()]/g, "").replace(/^\d+\.\s+/, "").trim();
    toc.push({ level, text: cleanText, id: slug });
    return `<a id="${slug}"></a>\n${hashes} ${text}`;
  });

  const html = marked.parse(processed, { async: false }) as string;
  return { html, toc };
}

function buildTocHtml(toc: TocEntry[]): string {
  if (toc.length === 0) return "";

  const hasH3 = toc.some((e) => e.level === 3);

  let html = '<div class="toc-title">📄 目录</div><ol class="toc-list">';

  if (hasH3) {
    let inGroup = false;
    for (const entry of toc) {
      if (entry.level === 2) {
        if (inGroup) html += '</ol></li>';
        html += `<li class="toc-group"><a href="#${entry.id}">${escapeHtml(entry.text)}</a><ol class="toc-list">`;
        inGroup = true;
      } else {
        html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a></li>`;
      }
    }
    if (inGroup) html += '</ol></li>';
  } else {
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
  const clean = md.replace(/^(#{2,3}) \d+\.\s+/m, "$1 ");
  return marked.parse(clean, { async: false }) as string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
