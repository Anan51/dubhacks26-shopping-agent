import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { connectMongo } from "../src/auth/db.js";
import { User } from "../src/auth/user.js";
import { mongoConnectOptions } from "../src/mongo-startup.js";
import { PurchaseRecord } from "../src/purchases/model.js";
import { buildAtlasEvidenceReport, evidenceFileStamp } from "./evidence-atlas.js";

const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaAnotrealevidencehash";
const EMAIL_LOCAL = "atlas-evidence";
const EMAIL_DOMAIN = "example.com";
const EMAIL = `${EMAIL_LOCAL}@${EMAIL_DOMAIN}`;
const MASKED_EMAIL = `a***@${EMAIL_DOMAIN}`;
const HIDDEN_BUDGET = 424242;

describe("evidence file stamp", () => {
  it("replaces colons so the filename is valid on Windows", () => {
    const stamp = evidenceFileStamp(new Date("2026-10-18T15:04:05.006Z"));
    assert.equal(stamp, "2026-10-18T15-04-05.006Z");
    assert.equal(stamp.includes(":"), false);
  });
});

describe("atlas evidence report", { timeout: 180_000 }, () => {
  let mongod: MongoMemoryServer;
  const previousUri = process.env.MONGODB_URI;
  const previousDb = process.env.MONGODB_DB;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    delete process.env.MONGODB_DB;
    process.env.MONGODB_URI = mongod.getUri();
    await connectMongo(process.env.MONGODB_URI, mongoConnectOptions());
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    if (previousUri === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = previousUri;
    }
    if (previousDb === undefined) {
      delete process.env.MONGODB_DB;
    } else {
      process.env.MONGODB_DB = previousDb;
    }
  });

  it("prints a redacted user prefix and the latest purchase timestamps", async () => {
    const uri = process.env.MONGODB_URI ?? "";
    assert.ok(uri.length > 0);
    const user = await User.create({
      email: EMAIL,
      passwordHash: PASSWORD_HASH,
      weeklyBudget: HIDDEN_BUDGET,
      backboardAssistantId: "assistant-should-not-appear",
    });
    await PurchaseRecord.create({
      userId: user._id,
      item: "Older cable",
      category: "cable",
      price: 12,
      feedback: "kept",
      isExample: false,
      source: "checkout",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const latestItem = `Latest headphones ${uri} ${EMAIL}`;
    assert.ok(latestItem.length <= 200);
    const created = await PurchaseRecord.create({
      userId: user._id,
      item: latestItem,
      category: "audio",
      price: 89,
      feedback: "regretted",
      isExample: false,
      source: "checkout",
      createdAt: new Date("2026-10-18T15:00:00.000Z"),
      updatedAt: new Date("2026-10-18T16:30:00.000Z"),
    });
    const saved = await PurchaseRecord.findById(created._id);
    assert.ok(saved?.createdAt instanceof Date);
    assert.ok(saved.updatedAt instanceof Date);

    const report = await buildAtlasEvidenceReport(mongoose.connection, uri);

    const prefix = PASSWORD_HASH.slice(0, 12);
    assert.equal(prefix.length, 12);
    assert.equal(report.includes(MASKED_EMAIL), true);
    assert.equal(report.includes(EMAIL), false);
    assert.equal(report.includes(EMAIL_LOCAL), false);
    assert.equal(report.includes(`${prefix}…`), true);
    assert.equal(report.includes(PASSWORD_HASH), false);
    assert.equal(report.includes(PASSWORD_HASH.slice(12)), false);
    assert.equal(report.includes(String(HIDDEN_BUDGET)), false);
    assert.equal(report.includes("assistant-should-not-appear"), false);

    assert.equal(report.includes("**Database:** simmer"), true);
    assert.equal(report.includes("simmer.purchaserecords"), true);
    assert.equal(report.includes("Total: 2"), true);
    assert.equal(report.includes(saved._id.toHexString()), true);
    assert.equal(report.includes(user._id.toHexString()), true);
    assert.equal(report.includes("**price:** 89"), true);
    assert.equal(report.includes("**feedback (vote):** regretted"), true);
    assert.equal(report.includes(saved.createdAt.toISOString()), true);
    assert.equal(report.includes(saved.updatedAt.toISOString()), true);
    assert.equal(report.includes("Latest headphones"), true);
    assert.equal(report.includes("Older cable"), false);
    assert.equal(report.includes("**price:** 12"), false);
    assert.equal(report.includes("**feedback (vote):** kept"), false);
    assert.equal(report.includes("2026-01-01T00:00:00.000Z"), false);
    assert.equal(report.includes("2026-01-02T00:00:00.000Z"), false);

    assert.equal(report.includes(uri), false);
    assert.equal(report.includes("mongodb://"), false);
    assert.equal(report.includes("mongodb+srv://"), false);
    const host = new URL(uri).host;
    assert.equal(report.includes(host), false);
  });
});
