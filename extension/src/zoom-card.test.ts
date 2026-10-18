import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import * as esbuild from "esbuild";
import { chromium, type Page } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const cssPath = path.join(root, "extension/src/overlay.css");
const fixturePath = path.join(root, "extension/fixtures/apple-bag-cable-row.html");
const artifactDir = "/opt/cursor/artifacts/zoom";
const WINDOW_HEIGHT = 800;
const ZOOMS = [67, 80, 100, 125, 150] as const;
const WIDTHS = [1280, 800] as const;

describe("overlay zoom", () => {
  it("keeps the card inside the viewport at each zoom and width", { timeout: 120_000 }, async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "simmer-zoom-"));
    const scriptPath = path.join(outDir, "card.js");
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["extension/src/zoom-harness.ts"],
      bundle: true,
      format: "iife",
      platform: "browser",
      outfile: scriptPath,
      jsx: "automatic",
      define: {
        "import.meta.env.VITE_SIMMER_DEMO": '""',
      },
    });
    const css = readFileSync(cssPath, "utf8").replaceAll("</", "<\\/");
    const bag = readFileSync(fixturePath, "utf8");
    const htmlPath = path.join(outDir, "bag.html");
    writeFileSync(
      htmlPath,
      `<!doctype html><html><head><meta charset="utf-8"><title>Bag - Apple</title></head><body>${bag}<style id="simmer-css">${css}</style><script src="./card.js"></script></body></html>`,
    );
    mkdirSync(artifactDir, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    try {
      for (const zoom of ZOOMS) {
        for (const width of WIDTHS) {
          const scale = zoom / 100;
          const context = await browser.newContext({
            viewport: {
              width: Math.round(width / scale),
              height: Math.round(WINDOW_HEIGHT / scale),
            },
            deviceScaleFactor: scale,
          });
          const page = await context.newPage();
          await page.goto(pathToFileURL(htmlPath).href);
          await page.getByRole("button", { name: "Why" }).click();
          const box = await cardBox(page);
          const shot = path.join(artifactDir, `${zoom}-${width}.png`);
          await page.screenshot({ path: shot, fullPage: false });
          assert.ok(box, `${zoom}% ${width}px missing card`);
          assert.equal(box.scrollWidth <= box.innerWidth + 1, true, `${zoom}% ${width}px horizontal overflow`);
          assert.equal(box.x >= -1, true, `${zoom}% ${width}px left ${box.x}`);
          assert.equal(box.y >= -1, true, `${zoom}% ${width}px top ${box.y}`);
          assert.equal(box.x + box.width <= box.innerWidth + 1, true, `${zoom}% ${width}px right edge`);
          assert.equal(box.y + box.height <= box.innerHeight + 1, true, `${zoom}% ${width}px bottom edge`);
          const why = box.why.trim();
          assert.equal(why.includes("\n"), false, why);
          assert.doesNotMatch(why, /\b(score|impulse|vault)\b/i);
          assert.equal(why.split(/[.!?]/).filter((part) => part.trim().length > 0).length, 1, why);
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
});

async function cardBox(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  why: string;
} | null> {
  return page.locator("#simmer-root").evaluate((host) => {
    const root = host.shadowRoot;
    const panel = root?.querySelector(".panel");
    const card = root?.querySelector(".card");
    if (!panel || !card) {
      return null;
    }
    const panelRect = panel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const left = Math.min(panelRect.x, cardRect.x);
    const top = Math.min(panelRect.y, cardRect.y);
    const right = Math.max(panelRect.right, cardRect.right);
    const bottom = Math.max(panelRect.bottom, cardRect.bottom);
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      why: root?.querySelector(".why")?.textContent ?? "",
    };
  });
}
