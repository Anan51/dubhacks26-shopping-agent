import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const marker = "simmer-demo-reply";

describe("demo reply build", () => {
  it("leaves the demo trigger out of the default extension bundle", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "simmer-ext-"));
    const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
    const built = spawnSync(
      process.execPath,
      [vite, "build", "--config", "extension/vite.config.ts", "--outDir", outDir],
      {
        cwd: root,
        env: { ...process.env, VITE_SIMMER_DEMO: "" },
        encoding: "utf8",
      },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const content = readFileSync(path.join(outDir, "content.js"), "utf8");
    assert.equal(content.includes(marker), false);
    assert.equal(content.includes("Demo: skip 24 hours"), false);
    assert.equal(content.includes("skip-vault"), false);
    rmSync(outDir, { recursive: true, force: true });
  });
});
