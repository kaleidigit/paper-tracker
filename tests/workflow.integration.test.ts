import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import { EmptyPapersError, runWorkflow } from "../src/workflow.js";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-tracker-"));
  const journalsPath = path.join(tmpDir, "journals.json");
  const classificationPath = path.join(tmpDir, "classification.json");
  await fs.writeFile(
    journalsPath,
    JSON.stringify([{ name: "Nature", source_group: "Nature", rss_feeds: ["https://example.com/feed.xml"], issn: "0028-0836", publisher_strategy: "nature-rss" }]),
    "utf-8"
  );
  await fs.writeFile(
    classificationPath,
    JSON.stringify({ domains: [{ name: "能源", subdomains: [{ name: "储能", keywords: ["battery"] }] }] }),
    "utf-8"
  );

  globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("example.com/feed.xml")) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Battery paper</title><description>battery systems for clean energy</description><dc:type>research article</dc:type><pubDate>${new Date().toUTCString()}</pubDate><link>https://paper.test/1</link><guid>https://paper.test/1</guid></item></channel></rss>`,
        { status: 200 }
      );
    }
    if (url.includes("paper.test/1")) {
      // Nature article page mock — JSON-LD data
      return new Response(
        `<html><head><script type="application/ld+json">{"@type":"ScholarlyArticle","author":[{"@type":"Person","name":"Li Wei"},{"@type":"Person","name":"Zhang San"}],"description":"Battery systems provide critical storage for renewable energy integration."}</script></head></html>`,
        { status: 200 }
      );
    }
    if (url.includes("api.openalex.org/works")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ title_zh: "中文标题", abstract_zh: "中文摘要", classification: { domain: "能源", subdomain: "储能", tags: ["battery"] } }) } }]
        }),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("workflow integration", () => {
  test("runs retrieval -> processor -> publisher", async () => {
    const config: AppConfig = {
      app: { timezone: "UTC" },
      pipeline: { default_days: 2, digest_title_template: "{date} 顶刊论文日报" },
      runtime: {
        mode: "run-once",
        state_dir: tmpDir,
        logs_dir: tmpDir,
        temp_dir: tmpDir,
        command_timeout_ms: 10000,
        retry: { max_attempts: 1, backoff_ms: 0 }
      },
      sources: {
        journals_file: path.join(tmpDir, "journals.json"),
        keywords: ["battery"],
        openalex_queries: ["battery"]
      },
      classification: {
        file: path.join(tmpDir, "classification.json")
      },
      ai: {
        base_url: "https://mock-ai.test/v1",
        model: "mock-model",
        api_key_env: "SILICONFLOW_API_KEY"
      },
      feishu: {
        execution_mode: "host",
        data_dir: tmpDir
      }
    };
    process.env.SILICONFLOW_API_KEY = "mock-key";
    const result = await runWorkflow(config);
    expect(result.payload.papers).toHaveLength(1);
    expect(result.payload.papers[0].title_zh).toBe("中文标题");
    expect(result.payload.papers[0].publication_type).toBe("article");
    expect(typeof result.publishResult.saved_markdown).toBe("string");
  });

  test("fails fast when papers is empty", async () => {
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("example.com/feed.xml")) {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss><channel></channel></rss>`, { status: 200 });
      }
      if (url.includes("api.openalex.org/works")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const config: AppConfig = {
      app: { timezone: "UTC" },
      pipeline: { default_days: 2, digest_title_template: "{date} 顶刊论文日报" },
      runtime: {
        mode: "run-once",
        state_dir: tmpDir,
        logs_dir: tmpDir,
        temp_dir: tmpDir,
        command_timeout_ms: 10000,
        retry: { max_attempts: 1, backoff_ms: 0 }
      },
      sources: {
        journals_file: path.join(tmpDir, "journals.json"),
        keywords: ["battery"],
        openalex_queries: ["battery"]
      },
      classification: {
        file: path.join(tmpDir, "classification.json")
      },
      ai: {
        base_url: "https://mock-ai.test/v1",
        model: "mock-model",
        api_key_env: "SILICONFLOW_API_KEY"
      },
      feishu: {
        execution_mode: "host",
        data_dir: tmpDir
      }
    };
    await expect(runWorkflow(config)).rejects.toBeInstanceOf(EmptyPapersError);
  });
});
