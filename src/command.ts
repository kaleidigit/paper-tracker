import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  exec: string,
  args: string[],
  timeoutMs: number,
  stdinText?: string
): Promise<CommandResult> {
  if (!exec) {
    throw new Error("Missing command executable");
  }
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(exec, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) {
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${exec}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finished = true;
      resolve({
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

export function runShell(command: string, timeoutMs: number): Promise<CommandResult> {
  const shellExec = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/c", command] : ["-lc", command];
  return runCommand(shellExec, shellArgs, timeoutMs);
}
