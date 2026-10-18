import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import * as esbuild from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "extension/src/overlay.css"), "utf8");

/**
 * Stacking values taken from the live apple.com bag CSS on 2026-10-18:
 * #globalnav is z-index 9999, and .rf-odt is a fixed bottom bar at z-index 1000000.
 * The page is tall so an unpinned host would sit below the fold.
 */
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bag - Apple</title>
<style>
  #globalnav { position: absolute; top: 0; right: 0; left: 0; z-index: 9999; height: 48px; background: #fff; }
  #bag-container { min-height: 1400px; }
  #global-footersection { position: relative; z-index: 2; min-height: 320px; background: #f5f5f7; }
  .rf-odt { position: fixed; bottom: 0; left: 0; right: 0; height: 72px; z-index: 1000000; background: #111; color: #fff; }
</style></head><body>
  <nav id="globalnav">Apple</nav>
  <div id="bag-container"></div>
  <footer id="global-footersection">Footer</footer>
  <div class="rf-odt">Check Out</div>
  <style id="simmer-css">${css.replaceAll("</", "<\\/")}</style>
</body></html>`;

describe("unlock on the apple bag shell", () => {
  it("keeps Unlock above the footer and the sticky bar, and puts the card back if the host is removed", { timeout: 60_000 }, async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "simmer-unlock-"));
    const scriptPath = path.join(outDir, "unlock.js");
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["extension/src/unlock-harness.ts"],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: scriptPath,
      jsx: "automatic",
      define: { "import.meta.env.VITE_SIMMER_DEMO": '""' },
    });
    const script = readFileSync(scriptPath, "utf8").replaceAll("</script", "<\\/script");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await page.evaluate((source) => {
        const tag = document.createElement("script");
        tag.textContent = source;
        document.body.append(tag);
      }, script);
      await page.waitForTimeout(50);
      const hit = await page.evaluate(() => {
        const host = document.getElementById("simmer-root");
        const button = [...(host?.shadowRoot?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === "Unlock");
        const rect = button?.getBoundingClientRect();
        if (!host || !button || !rect) {
          return null;
        }
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        const inner = host.shadowRoot?.elementFromPoint(x, y);
        return {
          top: top?.id ?? top?.className ?? null,
          inner: inner?.textContent?.trim() ?? null,
          x,
          y,
          bottom: rect.bottom,
          viewport: window.innerHeight,
        };
      });
      assert.ok(hit);
      assert.equal(hit.top, "simmer-root");
      assert.equal(hit.inner, "Unlock");
      assert.equal(hit.y > 0 && hit.bottom < hit.viewport, true);
      await page.mouse.click(hit.x, hit.y);
      assert.equal(await page.evaluate(() => globalThis.__simmerUnlocks), 1);

      await page.evaluate(() => {
        document.getElementById("simmer-root")?.remove();
        document.querySelector("#bag-container")?.replaceChildren(document.createElement("div"));
      });
      await page.waitForTimeout(50);
      const back = await page.evaluate(() => document.getElementById("simmer-root")?.isConnected === true);
      assert.equal(back, true);
      const again = await page.evaluate(() => {
        const host = document.getElementById("simmer-root");
        const button = [...(host?.shadowRoot?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === "Unlock");
        const rect = button?.getBoundingClientRect();
        if (!rect) {
          return null;
        }
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      assert.ok(again);
      await page.mouse.click(again.x, again.y);
      assert.equal(await page.evaluate(() => globalThis.__simmerUnlocks), 2);
    } finally {
      await browser.close();
    }
  });
});
