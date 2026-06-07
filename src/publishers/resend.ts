/**
 * resend.ts — Resend 邮件发送（HTTP client，无文件 IO）
 *
 * POST https://api.resend.com/emails
 */

import type { JsonRecord } from "../types.js";
import { retry } from "../utils.js";
import { logEvent } from "../logger.js";

const RESEND_API = "https://api.resend.com/emails";

export async function sendResendEmail(
  apiKey: string,
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
      const res = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to, subject, html: htmlContent }),
        signal: AbortSignal.timeout(15_000)
      });

      const body = await res.json() as JsonRecord;
      if (!res.ok) {
        throw new Error(`Resend HTTP ${res.status}: ${JSON.stringify(body)}`);
      }
      return body as JsonRecord;
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
