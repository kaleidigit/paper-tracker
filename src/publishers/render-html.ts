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
h3 { font-size: 1.05em; margin-top: 24px; color: #333; }
hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
a { color: #2563eb; text-decoration: none; }
blockquote { border-left: 3px solid #e0e0e0; margin: 8px 0; padding: 4px 12px; color: #555; }
img { max-width: 100%; height: auto; border-radius: 4px; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a2e; color: #e0e0e0; }
  a { color: #60a5fa; }
  blockquote { color: #aaa; border-left-color: #444; }
}
`.trim();

/** 单篇论文 → 带内联样式的 HTML 卡片 */
export function paperToHtml(paper: Paper, index: number): string {
  const md = renderPaperCard(paper, index, 2);
  return marked.parse(md, { async: false }) as string;
}

/** 完整 markdown digest → 完整 HTML 页面 */
export function digestToHtmlPage(title: string, markdown: string): string {
  const body = marked.parse(markdown, { async: false }) as string;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${INLINE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
