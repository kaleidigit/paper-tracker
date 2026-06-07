import fs from "node:fs/promises";
import { loadAppConfig, loadProfileContext } from "./config.js";
import { Logger } from "./logger.js";
import { buildScheduleInstruction, installSchedule } from "./schedule-install.js";
import { shouldRunNow } from "./scheduler.js";
import { ensureRuntimeDirs, readState } from "./storage.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        // Daemon mode expects --step based execution via shell, skip self-running
      } catch {
        // No-op
      }
    }
    const everyHours = latest.pipeline?.schedule?.check_every_hours ?? 1;
    await sleep(Math.max(10_000, everyHours * 60 * 60 * 1000));
  }
}

function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  const profile = extractArg(rawArgs, "--profile");
  const step = extractArg(rawArgs, "--step");

  const args = rawArgs.filter((arg) => {
    if (arg === "--dry-run") {
      process.env.PUSH_DRY_RUN = "1";
      return false;
    }
    return true;
  });

  if (step) {
    const { runStep } = await import("./pipeline.js");
    const ctx = await loadProfileContext(profile);
    await fs.mkdir(ctx.outputDir, { recursive: true });
    const result = await runStep(step, ctx);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.error) {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        event: `step.${step}.error`,
        error: result.error,
        profile: ctx.profile
      })}\n`);
    }
    return;
  }

  const mode = args.filter((a) => a !== profile && a !== step)[0] || "";

  if (mode === "schedule-print") {
    const config = profile
      ? (await loadProfileContext(profile)).config
      : await loadAppConfig();
    const instruction = buildScheduleInstruction(config);
    process.stdout.write(
      `${JSON.stringify({ platform: instruction.platform, note: instruction.note, command: instruction.command }, null, 2)}\n`
    );
    return;
  }
  if (mode === "schedule-install") {
    const config = profile
      ? (await loadProfileContext(profile)).config
      : await loadAppConfig();
    const installed = await installSchedule(config);
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
    return;
  }
  if (mode === "daemon") {
    await runDaemon();
    return;
  }

  process.stderr.write("Usage: npx tsx src/cli.ts --step <name> --profile <name> [--dry-run]\n");
  process.stderr.write("Steps: collect, filter, enrich, store, digest, rss, notify, combined-rss\n");
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
