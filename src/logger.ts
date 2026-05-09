import fs from "node:fs/promises";
import path from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR";

export class Logger {
  constructor(private readonly logsDir: string) {}

  private async append(level: LogLevel, event: string, data?: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    const payload = { timestamp, level, event, ...data };
    const line = `${JSON.stringify(payload)}\n`;
    const day = timestamp.slice(0, 10);
    const logFile = path.join(this.logsDir, `${day}.log`);
    await fs.appendFile(logFile, line, "utf-8");
    if (level === "ERROR") {
      // Keep stderr for quick diagnosis in scheduled tasks.
      process.stderr.write(line);
      return;
    }
    process.stdout.write(line);
  }

  info(event: string, data?: Record<string, unknown>): Promise<void> {
    return this.append("INFO", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): Promise<void> {
    return this.append("WARN", event, data);
  }

  error(event: string, data?: Record<string, unknown>): Promise<void> {
    return this.append("ERROR", event, data);
  }
}
