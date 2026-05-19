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

// ─── 工具函数 ──────────────────────────────────────────────

/** 从多个来源（单值或数组）解析并去重 chat_id 列表 */
function resolveChatIds(...sources: (string | string[] | undefined | null)[]): string[] {
  const ids = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src)) {
      for (const id of src) {
        const trimmed = (id || "").trim();
        if (trimmed) ids.add(trimmed);
      }
    } else {
      const trimmed = String(src).trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return [...ids];
}

// ─── lark-cli 封装 ─────────────────────────────────────────

function extractDocUrl(docRes: JsonRecord): string {
  const stdout = String(docRes.stdout || "");
  const stderr = String(docRes.stderr || "");
  return stdout.match(/https?:\/\/[^\s"]+/)?.[0]
    || stderr.match(/https?:\/\/[^\s"]+/)?.[0]
    || "";
}

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
    const record: JsonRecord = {
      command: "lark-cli docs +create",
      returncode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
    if (result.code !== 0) {
      record.error = `lark-cli exited with code ${result.code}: ${result.stderr || result.stdout || "(no output)"}`;
    }
    return record;
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
    const record: JsonRecord = {
      command: "lark-cli im +messages-send",
      returncode: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
    if (result.code !== 0) {
      record.error = `lark-cli exited with code ${result.code}: ${result.stderr || result.stdout || "(no output)"}`;
    }
    return record;
  } catch (err) {
    return { command: "lark-cli im +messages-send", error: String(err) };
  }
}

// ─── 发布摘要 ──────────────────────────────────────────────

/**
 * 纯飞书发布（不写文件）：创建文档 + 发送群通知。
 * publishDigest 和周刊步骤共用此函数。
 */
export async function pushToFeishu(
  config: AppConfig,
  docTitle: string,
  markdownContent: string
): Promise<JsonRecord> {
  const feishu = config.feishu || {};
  const dryRun = process.env.PUSH_DRY_RUN === "1";
  const result: JsonRecord = { dry_run: dryRun };

  if (dryRun) return result;

  // 创建飞书文档
  if (Boolean(feishu.doc_enabled)) {
    let docRes = await larkCreateDoc(config, docTitle, markdownContent);
    let docUrl = extractDocUrl(docRes);

    // 失败时重试一次
    if (!docUrl && docRes.error) {
      await new Promise((r) => setTimeout(r, 2000));
      docRes = await larkCreateDoc(config, docTitle, markdownContent);
      docUrl = extractDocUrl(docRes);
    }

    result.doc_publish = docRes;
    if (docUrl) result.doc_url = docUrl;
    if (docRes.error) {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        event: "workflow.publish.doc_create_failed",
        error: docRes.error,
        profile: process.env.PROFILE || "unknown",
        retried: !docUrl
      })}\n`);
    }
  }

  // 发送群通知
  if (Boolean(feishu.notify_enabled)) {
    const chatIds = resolveChatIds(feishu.notify_chat_ids, feishu.notify_chat_id);
    if (chatIds.length > 0) {
      const hasUrl = Boolean(result.doc_url);
      const defaultTpl = hasUrl
        ? "论文日报已生成：{title}\n文档链接：{doc_url}"
        : "论文日报已生成：{title}\n文档创建失败，请手动检查飞书文档列表。";
      const textTpl = normalizeText(feishu.notify_message_template) || defaultTpl;
      const notifyText = textTpl
        .replaceAll("{title}", docTitle)
        .replaceAll("{doc_url}", String(result.doc_url || ""));
      const outcomes = await Promise.allSettled(
        chatIds.map((id) => larkSendMessage(config, id, notifyText))
      );
      result.notify_publish = outcomes.map((o, i) => ({
        chat_id: chatIds[i],
        status: o.status,
        ...(o.status === "fulfilled" ? { result: o.value } : { error: String(o.reason) })
      }));
    }
  }

  return result;
}

/**
 * 将 digest 文件保存到 data/{profile}/{date}/，然后发布到飞书。
 *
 * 文件输出：
 *   6-digest.md       Markdown 全文
 *   6-records.json    论文记录（扁平化）
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

  await fs.writeFile(mdFile, payload.markdown, "utf-8");
  await fs.writeFile(recFile, `${JSON.stringify(payload.records, null, 2)}\n`, "utf-8");

  const latestPath = path.join(outputDir, "latest.json");
  await fs.writeFile(
    latestPath,
    `${JSON.stringify(
      {
        title: payload.title,
        markdown_file: mdFile,
        records_file: recFile,
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
      output_dir: outputDir,
      execution_mode: "dry-run",
      dry_run: true
    };
  }

  // ── 正式发布 ─────────────────────────────────────────
  const prefix = feishu.doc_title_prefix || "[每日论文追踪]";
  const docTitle = `${prefix} ${payload.title}`;
  const feishuResult = await pushToFeishu(config, docTitle, payload.markdown);
  return {
    saved_markdown: mdFile,
    saved_records: recFile,
    output_dir: outputDir,
    latest_meta: latestPath,
    dry_run: false,
    ...feishuResult
  };
}

// ─── 告警 ──────────────────────────────────────────────────

export async function sendAlert(config: AppConfig, message: string): Promise<void> {
  const feishu = config.feishu || {};
  if (!Boolean(feishu.alert_enabled)) return;
  const chatIds = resolveChatIds(feishu.alert_chat_ids, feishu.alert_chat_id, feishu.notify_chat_ids, feishu.notify_chat_id);
  if (chatIds.length === 0) return;
  await Promise.allSettled(
    chatIds.map((id) => larkSendMessage(config, id, message))
  );
}
