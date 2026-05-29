/**
 * publish.ts — 飞书发布
 *
 * 所有 lark-cli 调用均直接调用 subprocess，不走 shell 模板字符串。
 */

import { runCommand } from "./command.js";
import type { AppConfig, JsonRecord } from "./types.js";
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
  // Prefer v2 JSON response: data.document.url
  try {
    const parsed = JSON.parse(stdout) as JsonRecord;
    const url = (parsed.data as JsonRecord | undefined)?.document as JsonRecord | undefined;
    if (typeof url?.url === "string" && url.url) return url.url;
  } catch {
    // Fall through to regex extraction
  }
  return stdout.match(/https?:\/\/[^\s"]+/)?.[0]
    || stderr.match(/https?:\/\/[^\s"]+/)?.[0]
    || "";
}

function extractDocId(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as JsonRecord;
    const data = parsed.data as JsonRecord | undefined;
    const doc = data?.document as JsonRecord | undefined;
    return String(doc?.document_id || "");
  } catch { return ""; }
}

/** Maximum bytes per markdown chunk for append. Reduced to 3000 to stay well under server timeout threshold. */
const MD_CHUNK_BYTES = 3000;

function splitMarkdown(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  let sz = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line, "utf-8") + 1;
    if (sz + n > MD_CHUNK_BYTES && buf.length > 0) {
      chunks.push(buf.join("\n"));
      buf = [];
      sz = 0;
    }
    buf.push(line);
    sz += n;
  }
  if (buf.length > 0) chunks.push(buf.join("\n"));
  return chunks;
}

async function larkCreateDoc(
  config: AppConfig,
  docTitle: string,
  markdownContent: string
): Promise<JsonRecord> {
  const timeout = config.runtime.command_timeout_ms;
  try {
    // Step 1: create doc with title only (XML, small → never times out)
    const createResult = await runCommand(
      "lark-cli",
      ["docs", "+create", "--api-version", "v2", "--as", "bot",
       "--content", docTitleToXml(docTitle)],
      timeout
    );

    if (createResult.code !== 0) {
      return {
        command: "lark-cli docs +create",
        returncode: createResult.code,
        stdout: createResult.stdout,
        stderr: createResult.stderr,
        error: `lark-cli exited with code ${createResult.code}: ${createResult.stderr || createResult.stdout || "(no output)"}`
      };
    }

    const docId = extractDocId(createResult.stdout);
    if (!docId) {
      return { command: "lark-cli docs +create", stdout: createResult.stdout, stderr: createResult.stderr, error: "Failed to extract document_id from response" };
    }

    // Step 2: split markdown into chunks and append each (avoids server timeout on large --doc-format markdown)
    const chunks = splitMarkdown(markdownContent);
    for (let i = 0; i < chunks.length; i++) {
      let lastError = "";
      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        if (i > 0 || attempt > 0) await new Promise(r => setTimeout(r, attempt > 0 ? 1000 * (2 ** attempt) : 200));
        const appendResult = await runCommand(
          "lark-cli",
          ["docs", "+update", "--api-version", "v2", "--as", "bot",
           "--doc", docId, "--command", "append", "--doc-format", "markdown",
           "--content", chunks[i]],
          timeout
        );
        if (appendResult.code === 0) {
          success = true;
        } else {
          lastError = `Chunk ${i + 1}/${chunks.length} attempt ${attempt + 1} failed: ${appendResult.stderr || appendResult.stdout}`;
        }
      }
      if (!success) {
        return {
          command: "lark-cli docs +create",
          returncode: 1,
          stdout: createResult.stdout,
          stderr: lastError,
          error: lastError
        };
      }
    }

    // Step 3: set tenant-editable permission (non-blocking)
    let permissionError = "";
    try {
      const permResult = await runCommand(
        "lark-cli",
        ["drive", "permission.public", "patch",
         "--params", JSON.stringify({ token: docId, type: "docx" }),
         "--data", JSON.stringify({ link_share_entity: "tenant_editable" }),
         "--yes", "--as", "bot"],
        timeout
      );
      if (permResult.code !== 0) {
        permissionError = permResult.stderr || permResult.stdout || `exit code ${permResult.code}`;
        process.stderr.write(`${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "WARN",
          event: "feishu.permission_failed",
          doc_id: docId,
          error: permissionError
        })}\n`);
      }
    } catch (err) {
      permissionError = String(err);
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "WARN",
        event: "feishu.permission_failed",
        doc_id: docId,
        error: permissionError
      })}\n`);
    }

    return {
      command: "lark-cli docs +create",
      returncode: 0,
      stdout: createResult.stdout,
      stderr: "",
      permission_error: permissionError || undefined
    };
  } catch (err) {
    return { command: "lark-cli docs +create", error: String(err) };
  }
}

function docTitleToXml(title: string): string {
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<title>${escaped}</title>`;
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

  // 创建飞书文档（最多 3 次尝试，指数退避）
  if (Boolean(feishu.doc_enabled)) {
    let docUrl = "";
    let lastError = "";

    for (let attempt = 0; attempt < 3 && !docUrl; attempt++) {
      if (attempt > 0) {
        const delay = 5_000 * (2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
      }
      const docRes = await larkCreateDoc(config, docTitle, markdownContent);
      docUrl = extractDocUrl(docRes);
      result.doc_publish = docRes;
      if (docUrl) {
        result.doc_url = docUrl;
        break;
      }
      lastError = String(docRes.error || "no URL returned");
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        event: "workflow.publish.doc_create_failed",
        error: lastError,
        profile: process.env.PROFILE || "unknown",
        attempt: attempt + 1
      })}\n`);
    }

    if (!docUrl) {
      const profile = process.env.PROFILE || "top";
      throw new Error(
        `飞书文档创建失败（3 次尝试均失败）: ${lastError}\n` +
        `请手动重试: npx tsx src/cli.ts --step push --profile ${profile}`
      );
    }
  }

  // 发送群通知（仅在文档创建成功后）
  if (Boolean(feishu.notify_enabled)) {
    const chatIds = resolveChatIds(feishu.notify_chat_ids, feishu.notify_chat_id);
    if (chatIds.length > 0) {
      const defaultTpl = "论文日报已生成：{title}\n文档链接：{doc_url}";
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
