import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { listenHost, readAppConfig } from "./config.js";

describe("listen host", () => {
  it("binds to 127.0.0.1 unless HOST is set, and localhost:4321 still reaches it", async () => {
    assert.equal(listenHost({}), "127.0.0.1");
    assert.equal(listenHost({ HOST: "   " }), "127.0.0.1");
    assert.equal(readAppConfig({}).host, "127.0.0.1");
    assert.equal(readAppConfig({ HOST: "0.0.0.0" }).host, "0.0.0.0");
    assert.equal(readAppConfig({ PORT: "4321" }).port, 4321);
    assert.equal(readAppConfig({ PORT: "4321" }).origin, "http://localhost:4321");

    const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    assert.match(serverSource, /server\.listen\(appConfig\.port,\s*appConfig\.host/);

    const manifest = readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8");
    assert.match(manifest, /http:\/\/127\.0\.0\.1:4321\//);
    assert.match(manifest, /http:\/\/localhost:4321\//);
    const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
    assert.match(background, /http:\/\/127\.0\.0\.1:4321/);
    const popup = readFileSync(new URL("../extension/src/popup.ts", import.meta.url), "utf8");
    assert.match(popup, /http:\/\/127\.0\.0\.1:4321/);
    const demo = readFileSync(new URL("../scripts/dev-demo.mjs", import.meta.url), "utf8");
    assert.equal(demo.includes("HOST"), false);
    assert.match(demo, /src\/server\.ts/);

    const host = listenHost({});
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, host, () => resolve());
    });
    const address = server.address() as AddressInfo;
    try {
      assert.equal(address.address, "127.0.0.1");
      const response = await fetch(`http://localhost:${address.port}/`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
