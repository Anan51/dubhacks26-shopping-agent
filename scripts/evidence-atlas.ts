import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import mongoose, { type Connection, type Model } from "mongoose";

import { connectMongo } from "../src/auth/db.js";
import { redactMongoUri } from "../src/auth/redact.js";
import { User } from "../src/auth/user.js";
import { mongoConnectOptions } from "../src/mongo-startup.js";
import { PurchaseRecord } from "../src/purchases/model.js";
import { isRecord } from "../src/record.js";

const HASH_PREFIX_LENGTH = 12;
const USER_ROW_LIMIT = 500;
const EVIDENCE_DIR = path.join("judging", "atlas-evidence");
const REDACTED_URI = "[redacted-mongodb-uri]";
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Read-only report of simmer users and purchase records.
 * Emails are masked, password hashes are truncated, and the connection string is removed before return.
 */
export async function buildAtlasEvidenceReport(
  connection: Connection,
  mongodbUri: string,
  now: Date = new Date(),
): Promise<string> {
  const userModel = modelOn(connection, "User");
  const purchaseModel = modelOn(connection, "PurchaseRecord");
  const database = databaseName(connection);
  const userCollection = userModel.collection.collectionName;
  const purchaseCollection = purchaseModel.collection.collectionName;

  const userTotal = await userModel.countDocuments();
  const userDocs = await userModel
    .find()
    .select({ email: 1, passwordHash: 1 })
    .sort({ _id: 1 })
    .limit(USER_ROW_LIMIT)
    .lean();
  const users = userDocs.map(readUser);
  const purchaseTotal = await purchaseModel.countDocuments();
  const latestDoc = await purchaseModel
    .findOne()
    .sort({ createdAt: -1, _id: -1 })
    .select({ userId: 1, item: 1, price: 1, feedback: 1, createdAt: 1, updatedAt: 1 })
    .lean();
  const latest = latestDoc === null ? null : readPurchase(latestDoc);

  const lines = [
    "# Atlas evidence",
    "",
    `- **Run time:** ${now.toISOString()}`,
    `- **Database:** ${database}`,
    `- **Collections read:** \`${database}.${userCollection}\`, \`${database}.${purchaseCollection}\``,
    "",
    `## ${userCollection}`,
    "",
    `Shown: ${users.length} of ${userTotal} (limit ${USER_ROW_LIMIT})`,
    "",
  ];

  if (users.length === 0) {
    lines.push("No users.", "");
  } else {
    for (const user of users) {
      lines.push(
        `- **_id:** ${user.id}`,
        `- **email:** ${maskEmail(user.email)}`,
        `- **passwordHash prefix:** ${passwordHashPrefix(user.passwordHash)}`,
        "",
      );
    }
  }

  lines.push(`## ${purchaseCollection}`, "", `Total: ${purchaseTotal}`, "");
  if (latest === null) {
    lines.push("No purchase records.", "");
  } else {
    lines.push(
      "### Most recent purchase record",
      "",
      "Sorted by `createdAt` descending. The shopper's vote is stored as `feedback` (`kept` or `regretted`). This collection does not store a necessity field.",
      "",
      `- **_id:** ${latest.id}`,
      `- **userId:** ${latest.userId}`,
      `- **item:** ${latest.item}`,
      `- **price:** ${latest.price}`,
      `- **feedback (vote):** ${latest.feedback}`,
      `- **createdAt:** ${latest.createdAt}`,
      `- **updatedAt:** ${latest.updatedAt}`,
      "",
    );
  }

  return guardSecrets(
    lines.join("\n"),
    mongodbUri,
    users.map((user) => user.passwordHash),
    users.map((user) => user.email),
  );
}

/** ISO-8601 timestamp with colons replaced so the report filename is valid on Windows. */
export function evidenceFileStamp(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

function modelOn(connection: Connection, name: "User" | "PurchaseRecord"): Model<unknown> {
  const registered = connection.models[name] as Model<unknown> | undefined;
  if (registered !== undefined) {
    return registered;
  }
  return connection.model(name, sourceModel(name).schema) as unknown as Model<unknown>;
}

function sourceModel(name: "User" | "PurchaseRecord"): Model<unknown> {
  switch (name) {
    case "User":
      return User as unknown as Model<unknown>;
    case "PurchaseRecord":
      return PurchaseRecord as unknown as Model<unknown>;
    default: {
      const unexpected: never = name;
      return unexpected;
    }
  }
}

function databaseName(connection: Connection): string {
  const named = connection.db?.databaseName;
  if (typeof named === "string" && named.trim().length > 0) {
    return named.trim();
  }
  if (connection.name.trim().length > 0) {
    return connection.name.trim();
  }
  return "(unknown)";
}

type EvidenceUser = {
  id: string;
  email: string;
  passwordHash: string;
};

function readUser(value: unknown): EvidenceUser {
  if (!isRecord(value)) {
    return { id: "(missing)", email: "(missing)", passwordHash: "" };
  }
  return {
    id: idString(value._id),
    email: typeof value.email === "string" && value.email.length > 0 ? value.email : "(missing)",
    passwordHash: typeof value.passwordHash === "string" ? value.passwordHash : "",
  };
}

type EvidencePurchase = {
  id: string;
  userId: string;
  item: string;
  price: string;
  feedback: string;
  createdAt: string;
  updatedAt: string;
};

function readPurchase(value: unknown): EvidencePurchase {
  if (!isRecord(value)) {
    return {
      id: "(missing)",
      userId: "(missing)",
      item: "(missing)",
      price: "(missing)",
      feedback: "(none)",
      createdAt: "(missing)",
      updatedAt: "(missing)",
    };
  }
  return {
    id: idString(value._id),
    userId: idString(value.userId),
    item: typeof value.item === "string" && value.item.length > 0 ? value.item : "(missing)",
    price: priceText(value.price),
    feedback: feedbackText(value.feedback),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
}

function idString(value: unknown): string {
  if (value instanceof mongoose.Types.ObjectId) {
    return value.toHexString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return "(missing)";
}

function priceText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "(missing)";
}

function feedbackText(value: unknown): string {
  if (value === "kept" || value === "regretted") {
    return value;
  }
  return "(none)";
}

function timestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return "(missing)";
}

/** First character of the local part, then `***`, then the domain. A value that is not an address is not printed. */
function maskEmail(email: string): string {
  if (email === "(missing)") {
    return email;
  }
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1) : "";
  if (at <= 0 || domain.length === 0 || !domain.includes(".")) {
    return "[redacted-email]";
  }
  return `${email.slice(0, 1)}***@${domain}`;
}

/** First 12 characters of a longer hash, then an ellipsis. A short hash is not printed. */
function passwordHashPrefix(passwordHash: string): string {
  if (passwordHash.length <= HASH_PREFIX_LENGTH) {
    return "[redacted]";
  }
  return `${passwordHash.slice(0, HASH_PREFIX_LENGTH)}…`;
}

function guardSecrets(
  text: string,
  mongodbUri: string,
  passwordHashes: readonly string[],
  emails: readonly string[],
): string {
  let safe = text;
  const trimmed = mongodbUri.trim();
  if (trimmed.length > 0) {
    safe = safe.split(trimmed).join(REDACTED_URI);
  }
  safe = redactMongoUri(safe);
  for (const hash of passwordHashes) {
    if (hash.length === 0) {
      continue;
    }
    const replacement = hash.length <= HASH_PREFIX_LENGTH ? "[redacted]" : passwordHashPrefix(hash);
    safe = safe.split(hash).join(replacement);
  }
  for (const email of emails) {
    if (email.length === 0 || email === "(missing)") {
      continue;
    }
    safe = safe.split(email).join(maskEmail(email));
  }
  safe = safe.replace(EMAIL_IN_TEXT, (found) => maskEmail(found));
  if (trimmed.length > 0 && safe.includes(trimmed)) {
    throw new Error("Refusing to produce evidence that still contains MONGODB_URI.");
  }
  if (/mongodb(?:\+srv)?:\/\//i.test(safe)) {
    throw new Error("Refusing to produce evidence that still contains a MongoDB connection string.");
  }
  for (const hash of passwordHashes) {
    if (hash.length > HASH_PREFIX_LENGTH && safe.includes(hash)) {
      throw new Error("Refusing to produce evidence that still contains a full password hash.");
    }
  }
  for (const email of emails) {
    if (email.length > 0 && email !== "(missing)" && safe.includes(email)) {
      throw new Error("Refusing to produce evidence that still contains a full email address.");
    }
  }
  return safe;
}

async function writeEvidence(report: string, now: Date): Promise<{ timestamped: string; latest: string }> {
  const dir = path.join(process.cwd(), EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  const timestamped = path.join(dir, `atlas-evidence-${evidenceFileStamp(now)}.md`);
  const latest = path.join(dir, "latest.md");
  await writeFile(timestamped, report, "utf8");
  await writeFile(latest, report, "utf8");
  return {
    timestamped: path.relative(process.cwd(), timestamped),
    latest: path.relative(process.cwd(), latest),
  };
}

async function main(): Promise<number> {
  const uri = process.env.MONGODB_URI?.trim() ?? "";
  if (uri.length === 0) {
    console.error("Set MONGODB_URI in your environment");
    return 1;
  }

  const now = new Date();
  try {
    await connectMongo(uri, { ...mongoConnectOptions(), autoIndex: false, autoCreate: false });
    const report = await buildAtlasEvidenceReport(mongoose.connection, uri, now);
    const written = await writeEvidence(report, now);
    console.log(report);
    console.log(`Wrote ${written.timestamped}`);
    console.log(`Wrote ${written.latest}`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Atlas evidence failed.";
    console.error(guardSecrets(message, uri, [], []));
    return 1;
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Atlas evidence failed.";
      console.error(guardSecrets(message, process.env.MONGODB_URI ?? "", [], []));
      process.exit(1);
    });
}
