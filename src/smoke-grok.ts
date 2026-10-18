import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { extractSignals } from "./extract-signals.js";
import { xaiModelFrom } from "./grok.js";

function loadEnvFile(): void {
  const file = path.join(process.cwd(), ".env");
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const sample = "my battery dies by 3pm";

loadEnvFile();
const apiKey = process.env.XAI_API_KEY?.trim();
if (!apiKey) {
  console.error("Missing XAI_API_KEY.");
  process.exitCode = 1;
} else {
  const model = xaiModelFrom();
  const extraction = await extractSignals(sample, { step: "problem", signals: {}, turns: [] }, { apiKey, model });
  console.log(JSON.stringify({ model, source: extraction.source, signals: extraction.signals }, null, 2));
}
