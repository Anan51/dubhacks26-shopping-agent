import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, type BrowserContext, type Page } from "playwright";

import { CARRIER_PASS, CARRIER_WAIT, carrierSentence } from "../src/scoring/carrierSwitch.js";

const root = path.resolve(import.meta.dirname, "..");
const extensionDir = path.join(root, "extension", "dist");
const origin = "http://127.0.0.1:4321";
let activeServer: ChildProcess | undefined;
let storeDir: string | undefined;

process.on("exit", () => {
  killServer(activeServer);
});

const blankKeys = [
  "HOST",
  "WAITMATE_DEMO",
  "WAITMATE_CHANNEL",
  "WAITMATE_PUBLIC_ORIGIN",
  "PHOTON_API_KEY",
  "PHOTON_PROJECT_ID",
  "PHOTON_PLATFORM",
  "PHOTON_AGENT_HANDLE",
  "PHOTON_TEST_SENDER",
  "PHOTON_TEST_NUMBER",
  "PHOTON_API_ORIGIN",
  "PHOTON_WEBHOOK_SECRET",
  "XAI_API_KEY",
  "XAI_MODEL",
  "XAI_TIMEOUT_MS",
  "MONGODB_URI",
  "MONGODB_DB",
  "JWT_SECRET",
  "SESSION_SECRET",
  "BACKBOARD_API_KEY",
  "BACKBOARD_API_URL",
] as const;

describe("built extension smoke", { concurrency: 1 }, () => {
  let server: ChildProcess | undefined;
  let serverLog = "";
  let context: BrowserContext | undefined;
  let userDataDir: string | undefined;

  before(async () => {
    await buildDefaultExtension();
    server = await startServer((chunk) => {
      serverLog = `${serverLog}${chunk}`.slice(-12_000);
    });
    activeServer = server;
    userDataDir = mkdtempSync(path.join(tmpdir(), "simmer-e2e-"));
    context = await launchExtension(userDataDir);
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(20_000);
    if (context.serviceWorkers().length === 0) {
      await Promise.race([
        context.waitForEvent("serviceworker").then(() => undefined),
        delay(15_000),
      ]);
    }
  }, { timeout: 60_000 });

  after(async () => {
    try {
      await stopServer(server);
      await context?.close();
    } finally {
      killServer(server);
      activeServer = undefined;
      if (userDataDir) {
        rmSync(userDataDir, { recursive: true, force: true });
      }
      if (storeDir) {
        rmSync(storeDir, { recursive: true, force: true });
        storeDir = undefined;
      }
    }
  }, { timeout: 20_000 });

  it("shows the Simmer card on /fallback and blocks Check Out", { timeout: 60_000 }, async () => {
    const page = await openBag("/fallback");
    try {
      await assertSimmerCard(page, "apple", pageNotes.get(page) ?? []);
      await assertCheckoutStaysPut(page, "#checkout");
      await assertCheckoutStaysPut(page, "#apple-pay");
    } finally {
      await page.close();
    }
  });

  it("shows the Simmer card on /amazon and blocks checkout", { timeout: 60_000 }, async () => {
    const page = await openBag("/amazon");
    try {
      await assertSimmerCard(page, "amazon", pageNotes.get(page) ?? []);
      await assertCheckoutStaysPut(page, "#proceed");
      await assertCheckoutStaysPut(page, "#buy-now");
    } finally {
      await page.close();
    }
  });

  it("shows the Simmer card on /carrier-switch?case=wait and blocks Switch", { timeout: 60_000 }, async () => {
    const page = await openBag("/carrier-switch?case=wait");
    try {
      await assertSimmerCard(page, "carrier", pageNotes.get(page) ?? []);
      await page.getByText(carrierSentence(CARRIER_WAIT)).waitFor({ state: "visible", timeout: 20_000 });
      await assertCheckoutStaysPut(page, "#switch");
    } finally {
      await page.close();
    }
  });

  it("lets Switch through on /carrier-switch?case=pass", { timeout: 60_000 }, async () => {
    const page = await openBag("/carrier-switch?case=pass");
    try {
      const notes = pageNotes.get(page) ?? [];
      const root = page.locator("#simmer-root");
      try {
        await root.waitFor({ state: "attached", timeout: 20_000 });
        await page.getByText(carrierSentence(CARRIER_PASS)).waitFor({ state: "visible", timeout: 20_000 });
      } catch (error) {
        const body = await page.locator("body").innerText().catch(() => "");
        throw new Error(`Pass card did not appear.\n${notes.join("\n")}\n${body.slice(0, 500)}\n${String(error)}`);
      }
      assert.equal(await root.getAttribute("data-simmer-store"), "carrier");
      assert.equal((await page.locator(".kicker").innerText()).trim(), "Simmer · example data");
      const control = page.locator("#switch");
      await control.waitFor({ state: "visible" });
      assert.equal(await control.getAttribute("data-simmer-blocked"), null);
      assert.equal(await control.isDisabled(), false);
      await control.click();
      await page.locator("#result").waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await page.locator("#result").isHidden(), false);
    } finally {
      await page.close();
    }
  });

  async function openBag(pathname: string): Promise<Page> {
    if (!context) {
      throw new Error("Chromium is not running.");
    }
    const page = await context.newPage();
    const notes: string[] = [];
    pageNotes.set(page, notes);
    page.on("console", (message) => {
      notes.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      notes.push(`pageerror: ${error.message}`);
    });
    try {
      await page.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded" });
    } catch (error) {
      notes.push(serverLog);
      await page.close();
      throw new Error(`Could not open ${pathname}.\n${notes.join("\n")}\n${String(error)}`);
    }
    return page;
  }
});

const pageNotes = new WeakMap<Page, string[]>();

async function buildDefaultExtension(): Promise<void> {
  const env = { ...process.env };
  delete env.VITE_SIMMER_DEMO;
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  await run(process.execPath, [vite, "build", "--config", "extension/vite.config.ts"], env);
}

function launchExtension(userDataDir: string): Promise<BrowserContext> {
  // headless: false keeps Playwright from adding --headless. --headless=new is the
  // Chromium mode that still loads unpacked extensions.
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    timeout: 20_000,
    viewport: { width: 1280, height: 800 },
    chromiumSandbox: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--headless=new",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
}

async function assertSimmerCard(page: Page, store: "apple" | "amazon" | "carrier", notes: readonly string[]): Promise<void> {
  const root = page.locator("#simmer-root");
  try {
    await root.waitFor({ state: "attached", timeout: 20_000 });
    await page.getByRole("dialog", { name: "Marinating" }).waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const body = await page.locator("body").innerText().catch(() => "");
    throw new Error(
      `Simmer card did not appear for ${store}.\n${notes.join("\n")}\n${body.slice(0, 500)}\n${String(error)}`,
    );
  }
  assert.equal(await root.getAttribute("data-simmer-store"), store);
  assert.equal((await page.locator("#simmer-title").innerText()).trim(), "Marinating");
  assert.equal((await page.locator(".kicker").innerText()).trim(), "Simmer · example data");
  assert.equal(await page.getByText("Simulate reply").count(), 0);
}

async function assertCheckoutStaysPut(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector);
  await control.waitFor({ state: "visible" });
  assert.equal(await control.getAttribute("data-simmer-blocked"), "1", selector);
  assert.equal(await control.getAttribute("data-simmer-disabled"), "1", selector);
  assert.equal(await control.getAttribute("aria-disabled"), "true", selector);
  assert.equal(await control.isDisabled(), true, selector);
  assert.equal(
    await control.evaluate((node) => node.nextElementSibling?.getAttribute("data-simmer-badge") ?? null),
    "1",
    selector,
  );

  const url = page.url();
  await control.click({ force: true });
  const proceeded = await control.evaluate((node) => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const result = document.querySelector("#result");
    return result instanceof HTMLElement && result.hidden === false;
  });
  assert.equal(proceeded, false, `${selector} proceeded`);
  assert.equal(page.url(), url, `${selector} navigated`);
  assert.equal(await page.locator("#result").isHidden(), true, selector);
  assert.equal(await control.isDisabled(), true, selector);
}

async function startServer(onLog: (chunk: string) => void): Promise<ChildProcess> {
  const child = spawn("npm", ["run", "dev"], {
    cwd: root,
    env: serverEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    onLog(chunk.toString());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    onLog(chunk.toString());
  });
  const deadline = Date.now() + 45_000;
  let lastError = "server did not listen";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`npm run dev exited ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return child;
      }
      lastError = `health ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "health check failed";
    }
    await delay(200);
  }
  await stopServer(child);
  throw new Error(`Server was not ready at ${origin}. ${lastError}`);
}

function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env.PORT = "4321";
  for (const key of blankKeys) {
    env[key] = "";
  }
  storeDir = mkdtempSync(path.join(tmpdir(), "simmer-e2e-store-"));
  env.WAITMATE_STORE_PATH = path.join(storeDir, "waitmate.json");
  return env;
}

function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child) {
    return Promise.resolve();
  }
  killServer(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killServer(child);
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killServer(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) {
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
  }
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "null"}`));
    });
  });
}
