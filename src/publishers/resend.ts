/**
 * resend.ts — SMTP 邮件发送（HTTP-free，走 SMTP 协议）
 *
 * 使用 nodemailer 连接 SMTP 服务器（默认 163 邮箱）。
 * 无文件 IO。
 */

import { createTransport } from "nodemailer";
import type { JsonRecord } from "../types.js";
import { retry } from "../utils.js";
import { logEvent } from "../logger.js";

export async function sendResendEmail(
  host: string,
  port: number,
  secure: boolean,
  user: string,
  pass: string,
  from: string,
  to: string[],
  subject: string,
  htmlContent: string
): Promise<JsonRecord> {
  if (to.length === 0) {
    logEvent("INFO", "email.skip", { reason: "no recipients" });
    return { sent: false, reason: "no recipients" };
  }

  return retry(
    async () => {
      const transporter = createTransport({
        host, port, secure,
        auth: { user, pass },
        name: 'github-actions',
        tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
      });
      const info = await transporter.sendMail({ from, to: to.join(", "), subject, html: htmlContent });
      logEvent("INFO", "email.sent", { messageId: info.messageId, to: to.length });
      return { sent: true, messageId: info.messageId } as unknown as JsonRecord;
    },
    {
      maxAttempts: 3,
      baseDelayMs: 5000,
      onRetry: (attempt, delay, err) => {
        logEvent("WARN", "email.retry", { attempt, delayMs: delay, error: String(err) });
      }
    }
  );
}
