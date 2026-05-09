import { describe, expect, test } from "vitest";
import { runCommand } from "../src/command.js";

describe("runCommand", () => {
  test("collects stdout and exits with code 0", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], 5000);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("kills timeout process", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 100)
    ).rejects.toThrow(/timed out/i);
  });
});
