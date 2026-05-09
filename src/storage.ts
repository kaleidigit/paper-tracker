import fs from "node:fs/promises";
import path from "node:path";
import { defaultMetricsState, defaultRunState, resolvePath } from "./config.js";
import type { MetricsState, RunState, RuntimeConfig } from "./types.js";

export interface Paths {
  stateFile: string;
  metricsFile: string;
  logsDir: string;
  tempDir: string;
}

export async function ensureRuntimeDirs(runtime: RuntimeConfig): Promise<Paths> {
  const stateDir = resolvePath(runtime.state_dir);
  const logsDir = resolvePath(runtime.logs_dir);
  const tempDir = resolvePath(runtime.temp_dir);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
  return {
    stateFile: path.join(stateDir, "state.json"),
    metricsFile: path.join(stateDir, "metrics.json"),
    logsDir,
    tempDir
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, data: unknown): Promise<void> {
  return fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function readState(filePath: string): Promise<RunState> {
  return readJson(filePath, defaultRunState);
}

export function readMetrics(filePath: string): Promise<MetricsState> {
  return readJson(filePath, defaultMetricsState);
}
