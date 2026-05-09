import { describe, expect, test } from "vitest";
import { shouldRunNow } from "../src/scheduler.js";
import type { AppConfig, RunState } from "../src/types.js";

function baseConfig(hour: number, minute: number): AppConfig {
  return {
    app: { timezone: "UTC" },
    pipeline: { schedule: { hour, minute } },
    runtime: {
      mode: "run-once",
      state_dir: "data/ts-runner",
      logs_dir: "data/ts-runner/logs",
      temp_dir: "data/ts-runner/tmp",
      command_timeout_ms: 300000,
      retry: { max_attempts: 1, backoff_ms: 0 }
    }
  };
}

describe("scheduler", () => {
  test("runs when schedule matches and state key differs", () => {
    const now = new Date();
    const cfg = baseConfig(now.getUTCHours(), now.getUTCMinutes());
    const state: RunState = {
      last_run_key: "old-key",
      last_success_at: "",
      last_error: "",
      last_duration_ms: 0
    };
    const result = shouldRunNow(cfg, state);
    expect(result.ok).toBe(true);
  });

  test("skips repeated run key", () => {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const cfg = baseConfig(hour, minute);
    const date = now.toISOString().slice(0, 10);
    const sameKey = `${date}@${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    const state: RunState = {
      last_run_key: sameKey,
      last_success_at: "",
      last_error: "",
      last_duration_ms: 0
    };
    const result = shouldRunNow(cfg, state);
    expect(result.ok).toBe(false);
  });
});
