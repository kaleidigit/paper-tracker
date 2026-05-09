import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import type { AppConfig } from "./types.js";

function scheduleTime(config: AppConfig): { hour: string; minute: string } {
  const hour = String(config.pipeline?.schedule?.hour ?? 8).padStart(2, "0");
  const minute = String(config.pipeline?.schedule?.minute ?? 30).padStart(2, "0");
  return { hour, minute };
}

export function buildScheduleInstruction(config: AppConfig): { platform: string; command: string; note: string } {
  const cwd = process.cwd();
  const node = process.execPath;
  const { hour, minute } = scheduleTime(config);
  const taskCommand = `"${node}" "${path.join(cwd, "dist/cli.js")}" run-once`;

  if (process.platform === "win32") {
    return {
      platform: "windows",
      command: `schtasks /Create /F /SC DAILY /TN PaperTrackerDaily /TR "${taskCommand}" /ST ${hour}:${minute}`,
      note: "使用 Windows Task Scheduler，每日触发一次。"
    };
  }
  if (process.platform === "darwin") {
    const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.paper-tracker.daily.plist");
    return {
      platform: "macos",
      command: `launchctl bootstrap gui/$(id -u) "${plistPath}"`,
      note: `先写入 plist 文件到 ${plistPath}，再执行 launchctl。`
    };
  }
  return {
    platform: "linux",
    command: `(crontab -l 2>/dev/null; echo "${minute} ${hour} * * * cd ${cwd} && ${taskCommand} >> ${path.join(cwd, "data/ts-runner/cron.log")} 2>&1") | crontab -`,
    note: "使用用户级 crontab，每日触发一次。"
  };
}

async function writeMacosPlist(config: AppConfig): Promise<string> {
  const cwd = process.cwd();
  const node = process.execPath;
  const { hour, minute } = scheduleTime(config);
  const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.paper-tracker.daily.plist");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.paper-tracker.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${path.join(cwd, "dist/cli.js")}</string>
    <string>run-once</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${Number(hour)}</integer>
    <key>Minute</key>
    <integer>${Number(minute)}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(cwd, "data/ts-runner/launchd.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(cwd, "data/ts-runner/launchd.err.log")}</string>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, content, "utf-8");
  return plistPath;
}

export async function installSchedule(config: AppConfig): Promise<{ command: string; output: string }> {
  const instruction = buildScheduleInstruction(config);
  if (process.platform === "darwin") {
    await writeMacosPlist(config);
  }
  const shellExec = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/c", instruction.command] : ["-lc", instruction.command];
  const result = await runCommand(shellExec, shellArgs, config.runtime.command_timeout_ms);
  if (result.code !== 0) {
    throw new Error(`schedule install failed: ${result.stderr || result.stdout}`);
  }
  return { command: instruction.command, output: result.stdout };
}
