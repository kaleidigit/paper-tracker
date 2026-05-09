import fs from "node:fs/promises";
import path from "node:path";
import { loadAppConfig, loadProfileContext } from "./config.js";
import { Logger } from "./logger.js";
import { buildScheduleInstruction, installSchedule } from "./schedule-install.js";
import { shouldRunNow } from "./scheduler.js";
import { ensureRuntimeDirs, readMetrics, readState, writeJson } from "./storage.js";
import type { AppConfig, MetricsState, RunState } from "./types.js";
import { EmptyPapersError, runWorkflow, sendEmptyPapersAlert } from "./modules.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    const files = await fs.readdir(tempDir);
    await Promise.all(files.map((f: string) => fs.rm(path.join(tempDir, f), { recursive: true, force: true })));
  } catch {
    // No-op: temp cleanup failures should not block run completion.
  }
}

async function saveRunState(
  stateFile: string,
  state: RunState,
  metricsFile: string,
  metrics: MetricsState
): Promise<void> {
  await writeJson(stateFile, state);
  await writeJson(metricsFile, metrics);
}

function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function runOnceWithProfile(profile?: string): Promise<void> {
  const ctx = await loadProfileContext(profile);
  const config = ctx.config;
  const paths = await ensureRuntimeDirs(config.runtime);
  const logger = new Logger(paths.logsDir);
  const state = await readState(paths.stateFile);
  const metrics = await readMetrics(paths.metricsFile);
  const runKey = new Date().toISOString();
  const startedAt = Date.now();
  const dryRun = process.env.PUSH_DRY_RUN === "1";
  let success = false;

  await logger.info("run.start", { runKey, mode: "run-once", profile: ctx.profile, dry_run: dryRun });

  try {
    const result = await runWorkflow(config);
    const duration = Date.now() - startedAt;
    state.last_run_key = runKey;
    state.last_success_at = new Date().toISOString();
    state.last_error = "";
    state.last_duration_ms = duration;

    metrics.total_runs += 1;
    metrics.success_runs += 1;
    metrics.avg_duration_ms =
      (metrics.avg_duration_ms * (metrics.total_runs - 1) + duration) / Math.max(1, metrics.total_runs);
    metrics.last_error = "";
    metrics.updated_at = new Date().toISOString();

    await saveRunState(paths.stateFile, state, paths.metricsFile, metrics);
    await logger.info("run.success", {
      runKey,
      duration_ms: duration,
      papers: result.payload.papers.length,
      profile: ctx.profile,
      dry_run: dryRun
    });
    success = true;
  } catch (error) {
    const duration = Date.now() - startedAt;
    if (error instanceof EmptyPapersError) {
      try {
        await sendEmptyPapersAlert(config);
        await logger.warn("run.empty_papers_alert_sent", { runKey, profile: ctx.profile });
      } catch (alertError) {
        await logger.error("run.empty_papers_alert_failed", { runKey, error: String(alertError) });
      }
    }
    state.last_run_key = runKey;
    state.last_error = String(error);
    state.last_duration_ms = duration;

    metrics.total_runs += 1;
    metrics.failed_runs += 1;
    metrics.avg_duration_ms =
      (metrics.avg_duration_ms * (metrics.total_runs - 1) + duration) / Math.max(1, metrics.total_runs);
    metrics.last_error = String(error);
    metrics.updated_at = new Date().toISOString();

    await saveRunState(paths.stateFile, state, paths.metricsFile, metrics);
    await logger.error("run.failed", { runKey, duration_ms: duration, profile: ctx.profile, error: String(error), dry_run: dryRun });
    throw error;
  } finally {
    await cleanupTempDir(paths.tempDir);
    await logger.info("run.cleanup_done", { temp_dir: paths.tempDir, profile: ctx.profile, success });
  }
}

async function runOnce(): Promise<void> {
  return runOnceWithProfile();
}

async function runDaemon(): Promise<void> {
  const config = await loadAppConfig();
  const paths = await ensureRuntimeDirs(config.runtime);
  const logger = new Logger(paths.logsDir);

  await logger.warn("daemon.mode", {
    message: "daemon mode keeps process alive; production should prefer OS schedule + run-once."
  });
  while (true) {
    const latest = await loadAppConfig();
    const state = await readState(paths.stateFile);
    const decision = shouldRunNow(latest, state);
    if (decision.ok) {
      try {
        await runOnce();
      } catch {
        // Failures already persisted by runOnce.
      }
    }
    const everyHours = latest.pipeline?.schedule?.check_every_hours ?? 1;
    await sleep(Math.max(10_000, everyHours * 60 * 60 * 1000));
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Extract and consume known flags
  const profile = extractArg(rawArgs, "--profile");
  const step = extractArg(rawArgs, "--step");

  // Process --dry-run
  const args = rawArgs.filter((arg) => {
    if (arg === "--dry-run") {
      process.env.PUSH_DRY_RUN = "1";
      return false;
    }
    return true;
  });

  // Filter out consumed flag values
  const mode = args.filter((a) => a !== profile && a !== step)[0] || "run-once";

  if (step) {
    // Step mode: run a single pipeline step
    const { runStep } = await import("./pipeline.js");
    const ctx = await loadProfileContext(profile);
    await fs.mkdir(ctx.outputDir, { recursive: true });
    const result = await runStep(step, ctx);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // Use profile-aware loader when --profile is specified
  const config = profile
    ? (await loadProfileContext(profile)).config
    : await loadAppConfig();

  if (mode === "schedule-print") {
    const instruction = buildScheduleInstruction(config);
    process.stdout.write(
      `${JSON.stringify({ platform: instruction.platform, note: instruction.note, command: instruction.command }, null, 2)}\n`
    );
    return;
  }
  if (mode === "schedule-install") {
    const installed = await installSchedule(config);
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
    return;
  }
  if (mode === "daemon") {
    await runDaemon();
    return;
  }
  await runOnceWithProfile(profile);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
