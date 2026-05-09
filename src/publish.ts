/**
 * publish.ts
 *
 * 职责：飞书发布
 *   - publishDigest(): 将 digest 文件保存到 profile/date 目录 + 发布到飞书
 *   - sendAlert(): 发送告警消息
 *
 * 所有 lark-cli 调用均直接调用 subprocess，不走 shell 模板字符串。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import type { AppConfig, JsonRecord, PublishPayload } from "./types.js";
import { normalizeText } from "./utils.js";

// ─── lark-cli 封装 ─────────────────────────────────────────

async function larkCreateDoc(
  config: AppConfig,
  docTitle: string,
  markdownContent: string
): Promise<JsonRecord> {
  try {
    const result = await runCommand(
      "lark-cli",
      [
        "docs", "+create",
        "--as", "bot",
        "--title", docTitle,
        "--markdown", markdownContent
      ],
      config.runtime.command_timeout_ms
    );
    return {
      command: "lark-cli docs +create",
      returncode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (err) {
    return { command: "lark-cli docs +create", error: String(err) };
  }
}

async function larkSendMessage(
  config: AppConfig,
  chatId: string,
  text: string
): Promise<JsonRecord> {
  if (!chatId) return { command: "lark-cli im +messages-send", skip: true };
  try {
    const result = await runCommand(
      "lark-cli",
      [
        "im", "+messages-send",
        "--as", "bot",
        "--chat-id", chatId,
        "--text", text
      ],
      config.runtime.command_timeout_ms
    );
    return {
      command: "lark-cli im +messages-send",
      returncode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (err) {
    return { command: "lark-cli im +messages-send", error: String(err) };
  }
}

// ─── 发布摘要 ──────────────────────────────────────────────

/**
 * 将 digest 文件保存到 data/{profile}/{date}/，然后发布到飞书。
 *
 * 文件输出：
 *   6-digest.md       Markdown 全文
 *   6-records.json    论文记录（扁平化）
 *   6-papers.json     论文原始结构
 *   latest.json       指向最新输出的指针
 */
export async function publishDigest(
  config: AppConfig,
  payload: PublishPayload
): Promise<JsonRecord> {
  const feishu = config.feishu || {};
  const dataDir = config.feishu?.data_dir || "data";
  const timezone = config.app?.timezone || "Asia/Shanghai";
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const dateStr = now.toISOString().slice(0, 10);

  const profile = (process.env.PROFILE as string) || "top-journal-env-energy";
  const outputDir = path.join(dataDir, profile, dateStr);
  await fs.mkdir(outputDir, { recursive: true });

  const dryRun = process.env.PUSH_DRY_RUN === "1";

  // ── 写入文件 ─────────────────────────────────────────
  const mdFile = path.join(outputDir, "6-digest.md");
  const recFile = path.join(outputDir, "6-records.json");
  const papFile = path.join(outputDir, "6-papers.json");

  await fs.writeFile(mdFile, payload.markdown, "utf-8");
  await fs.writeFile(recFile, `${JSON.stringify(payload.records, null, 2)}\n`, "utf-8");
  await fs.writeFile(papFile, `${JSON.stringify(payload.papers, null, 2)}\n`, "utf-8");

  const latestPath = path.join(outputDir, "latest.json");
  await fs.writeFile(
    latestPath,
    `${JSON.stringify(
      {
        title: payload.title,
        markdown_file: mdFile,
        records_file: recFile,
        papers_file: papFile,
        profile,
        date: dateStr,
        created_at: now.toISOString(),
        dry_run: dryRun
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "INFO",
      event: "workflow.publish.files_written",
      output_dir: outputDir,
      markdown: mdFile,
      dry_run: dryRun
    })}\n`
  );

  // ── Dry-run：跳过飞书发布 ─────────────────────────────
  if (dryRun) {
    return {
      saved_markdown: mdFile,
      saved_records: recFile,
      saved_papers: papFile,
      output_dir: outputDir,
      execution_mode: "dry-run",
      dry_run: true
    };
  }

  // ── 正式发布 ─────────────────────────────────────────
  const prefix = feishu.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${payload.title}`;
  const result: JsonRecord = {
    saved_markdown: mdFile,
    saved_records: recFile,
    saved_papers: papFile,
    output_dir: outputDir,
    dry_run: false
  };

  // 创建飞书文档
  if (Boolean(feishu.doc_enabled)) {
    const markdown = await fs.readFile(mdFile, "utf-8");
    const docRes = await larkCreateDoc(config, docTitle, markdown);
    result.doc_publish = docRes;
    const url = (String(docRes.stdout || "")).match(/https?:\/\/[^\s"]+/)?.[0] || "";
    if (url) result.doc_url = url;
  }

  // 发送群通知
  const chatId = normalizeText(feishu.notify_chat_id);
  if (Boolean(feishu.notify_enabled) && chatId) {
    const textTpl =
      normalizeText(feishu.notify_message_template) ||
      "论文日报已生成：{title}\n文档链接：{doc_url}";
    const notifyText = textTpl
      .replaceAll("{title}", docTitle)
      .replaceAll("{doc_url}", String(result.doc_url || ""));
    result.notify_publish = await larkSendMessage(config, chatId, notifyText);
  }

  result.latest_meta = latestPath;
  return result;
}

// ─── 告警 ──────────────────────────────────────────────────

export async function sendAlert(config: AppConfig, message: string): Promise<void> {
  const feishu = config.feishu || {};
  if (!Boolean(feishu.alert_enabled)) return;
  const chatId = normalizeText(feishu.alert_chat_id || feishu.notify_chat_id);
  if (!chatId) return;
  await larkSendMessage(config, chatId, message);
}
