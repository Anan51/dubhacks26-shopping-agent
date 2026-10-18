import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import { connectMongo } from "../auth/db.js";
import { User } from "../auth/user.js";
import { PurchaseRecord } from "../purchases/model.js";
import { computeImpulseScore } from "./backboardScore.js";

describe("computeImpulseScore reads shopper services", { concurrency: false }, () => {
  let mongod: MongoMemoryServer;

  before(async () => {
    mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    await connectMongo(mongod.getUri());
  });

  after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it("keeps a new shopper at 4.5, skips example rows, and counts survey regrets", async () => {
    const quiet = await User.create({
      email: "quiet-score@example.com",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hourlyRate: 30,
      weeklyBudget: 200,
      goals: [],
    });
    const blank = await computeImpulseScore(
      quiet.id,
      {
        item: "Example phone",
        category: "phone",
        price: 40,
        necessary: false,
      },
      undefined,
      { backboardEnabled: true },
    );
    assert.equal(blank.score, 4.5);
    assert.equal(blank.why, null);

    const ada = await User.create({
      email: "ada-score@example.com",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      hourlyRate: 30,
      weeklyBudget: 200,
      goals: [],
    });
    await PurchaseRecord.create({
      userId: ada.id,
      item: "Sample phone",
      category: "phone",
      price: 20,
      feedback: "regretted",
      isExample: true,
      source: "checkout",
    });
    const ignored = await computeImpulseScore(
      ada.id,
      {
        item: "Example phone",
        category: "phone",
        price: 40,
        necessary: false,
      },
      undefined,
      { backboardEnabled: true },
    );
    assert.equal(ignored.score, 4.5);
    assert.equal(ignored.why, null);

    await PurchaseRecord.create({
      userId: ada.id,
      item: "Flagged survey phone",
      category: "phone",
      price: 30,
      feedback: "regretted",
      isExample: true,
      source: "survey",
    });
    const flagged = await computeImpulseScore(
      ada.id,
      {
        item: "Example phone",
        category: "phone",
        price: 40,
        necessary: false,
      },
      undefined,
      { backboardEnabled: true },
    );
    assert.equal(flagged.score, 4.5);
    assert.equal(flagged.why, null);

    await PurchaseRecord.create({
      userId: ada.id,
      item: "Old phone",
      category: "phone",
      price: 30,
      feedback: "regretted",
      isExample: false,
      source: "survey",
    });
    const phone = {
      item: "Example phone",
      category: "phone",
      price: 40,
      necessary: false,
    };
    const held = await computeImpulseScore(ada.id, phone, undefined, { backboardEnabled: false });
    assert.equal(held.score, 4.5);
    assert.equal(held.why, null);

    const surveyed = await computeImpulseScore(ada.id, phone, undefined, { backboardEnabled: true });
    assert.equal(surveyed.why, "You regretted a similar purchase before.");
    assert.ok(surveyed.score > blank.score);
    assert.equal(blank.score, 4.5);

    const necessary = await computeImpulseScore(
      ada.id,
      {
        item: "USB-C charge cable",
        category: "cable",
        price: 19,
        necessary: true,
        hours: 12,
      },
      undefined,
      { backboardEnabled: true },
    );
    assert.equal(necessary.score, 4.5);
    assert.equal(necessary.why, null);
  });

  it("does not treat a missing goal list as a penalty", async () => {
    const blake = await User.create({
      email: "blake-score@example.com",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const scored = await computeImpulseScore(blake.id, {
      item: "Watch",
      category: "watch",
      price: 80,
      necessary: false,
    });
    assert.equal(scored.score, 4.5);
    assert.equal(scored.why, null);
  });
});
