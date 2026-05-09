import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";

dotenv.config();

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), "config", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  const baseUrl = String(config.ai?.base_url || "").trim();
  const model = String(config.ai?.translation?.model || config.ai?.model || "").trim();
  const keyEnv = String(config.ai?.translation?.api_key_env || config.ai?.api_key_env || "SILICONFLOW_API_KEY").trim();
  const key = process.env[keyEnv] || process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || "";

  if (!baseUrl || !model || !key) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "missing_config_or_key",
          base_url: Boolean(baseUrl),
          model: Boolean(model),
          api_key: Boolean(key),
          api_key_env: keyEnv
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 128,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是翻译助手，只输出JSON。" },
        {
          role: "user",
          content: JSON.stringify({
            title_en: "Battery materials for low-carbon systems",
            abstract_original: "This paper discusses decarbonization pathways and battery recycling."
          })
        }
      ]
    })
  });

  const body = await response.text();
  console.log(
    JSON.stringify(
      {
        ok: response.ok,
        status: response.status,
        body_preview: body.slice(0, 500)
      },
      null,
      2
    )
  );
  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
