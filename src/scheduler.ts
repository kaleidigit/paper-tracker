import type { AppConfig, RunState } from "./types.js";

function nowTzParts(timezone: string): { date: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const bag: Record<string, string> = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      bag[part.type] = part.value;
    }
  });
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    hour: Number(bag.hour),
    minute: Number(bag.minute)
  };
}

export function runKeyForNow(config: AppConfig): string {
  const tz = config.app?.timezone || "Asia/Shanghai";
  const hour = config.pipeline?.schedule?.hour ?? 8;
  const minute = config.pipeline?.schedule?.minute ?? 30;
  const parts = nowTzParts(tz);
  return `${parts.date}@${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function shouldRunNow(config: AppConfig, state: RunState): { ok: boolean; runKey: string } {
  const tz = config.app?.timezone || "Asia/Shanghai";
  const hour = config.pipeline?.schedule?.hour ?? 8;
  const minute = config.pipeline?.schedule?.minute ?? 30;
  const parts = nowTzParts(tz);
  const runKey = `${parts.date}@${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (parts.hour !== hour || parts.minute !== minute) {
    return { ok: false, runKey };
  }
  if (state.last_run_key === runKey) {
    return { ok: false, runKey };
  }
  return { ok: true, runKey };
}
