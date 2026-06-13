import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import { collectRawPapers, filterPapers, enrichPapers } from "../src/modules.js";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-tracker-"));
  const journalsPath = path.join(tmpDir, "journals.json");
  const classificationPath = path.join(tmpDir, "classification.json");
  await fs.writeFile(
    journalsPath,
    JSON.stringify([{ name: "Nature", source_group: "Nature", rss_feeds: ["https://example.com/feed.xml"], issn: "0028-0836", publisher_strategy: "rss" }]),
    "utf-8"
  );
  await fs.writeFile(
    classificationPath,
    JSON.stringify({ groups: [{ name: "油气-电力组", subtopics: [{ name: "储能与电池", keywords: ["battery"] }] }] }),
    "utf-8"
  );

  globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("example.com/feed.xml")) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Battery paper</title><description>battery systems for clean energy</description><dc:creator>Li Wei, Zhang San</dc:creator><dc:type>research article</dc:type><pubDate>${new Date().toUTCString()}</pubDate><link>https://paper.test/1</link><guid>https://paper.test/1</guid></item></channel></rss>`,
        { status: 200 }
      );
    }
    // Article page scraping (deferred to enrich step)
    if (url.includes("paper.test/1")) {
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
          choices: [{ message: { content: JSON.stringify({ keep: true, confidence: 0.9, title_zh: "中文标题", abstract_zh: "中文摘要", results: [{ index: 0, keep: true, confidence: 0.9, title_zh: "中文标题", abstract_zh: "中文摘要" }], classification: { groups: [{ group: "油气-电力组", subtopics: ["储能与电池"] }], tags: ["battery"] } }) } }]
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

function makeConfig(): AppConfig {
  return {
    app: { timezone: "UTC" },
    pipeline: { default_days: 2 },
    runtime: {
      mode: "run-once",
      state_dir: tmpDir,
      logs_dir: tmpDir,
      temp_dir: tmpDir,
      command_timeout_ms: 10000,
      retry: { max_attempts: 1, backoff_ms: 0 }
    },
    sources: {
      journals_file: path.join(tmpDir, "journals.json")
    },
    classification: {
      file: path.join(tmpDir, "classification.json")
    },
    ai: {
      base_url: "https://mock-ai.test/v1",
      model: "mock-model",
      api_key_env: "SILICONFLOW_API_KEY"
    },
  };
}

describe("pipeline steps", () => {
  test("collect → filter → enrich produces papers with translations and classification", async () => {
    process.env.SILICONFLOW_API_KEY = "mock-key";
    const config = makeConfig();

    // Step 1: Collect
    const collected = await collectRawPapers(config);
    expect(collected).toHaveLength(1);
    expect(collected[0].title_en).toBe("Battery paper");

    // Step 2: Filter (LLM filter + translate)
    const taxonomy = [{ name: "油气-电力组", subtopics: [{ name: "储能与电池", keywords: ["battery"] }] }];
    const filtered = await filterPapers(config, taxonomy, collected);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title_zh).toBe("中文标题");

    // Step 3: Enrich (article scraping + normalize + classify)
    const enriched = await enrichPapers(config, filtered);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].publication_type).toBe("article");
    expect(enriched[0].classification).toBeDefined();
    // Article scraping should have enriched authors from JSON-LD
    expect(enriched[0].authors).toContain("Li Wei");
  });

  test("empty collection skips filter and enrich cleanly", async () => {
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

    const config = makeConfig();
    const collected = await collectRawPapers(config);
    expect(collected).toHaveLength(0);

    const filtered = await filterPapers(config, [], collected);
    expect(filtered).toHaveLength(0);

    const enriched = await enrichPapers(config, filtered);
    expect(enriched).toHaveLength(0);
  });
});
