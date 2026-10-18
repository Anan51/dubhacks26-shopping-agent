import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { isPasswordHash } from "./password.js";

/**
 * Local email + password account.
 * Backboard has no user id: its memories are shared by every thread on one assistant.
 * Each account therefore owns a separate assistant. `backboardAssistantId` is written
 * only after this server calls POST /assistants. It is never copied from a request.
 */
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: {
      type: String,
      required: true,
      validate: {
        validator: (value: string) => isPasswordHash(value),
        message: "passwordHash must be an argon2 or bcrypt hash.",
      },
    },
    backboardAssistantId: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

export type UserShape = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId };

export const User: Model<UserShape> =
  (mongoose.models.User as Model<UserShape> | undefined) ?? mongoose.model<UserShape>("User", userSchema);

const memoryNoteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true, enum: ["regret", "goal", "returned"] },
    text: { type: String, required: true, maxlength: 2_000 },
    meta: { type: Schema.Types.Mixed, default: {} },
    backboardMemoryId: { type: String, default: null },
  },
  { timestamps: true },
);

export type MemoryNoteShape = InferSchemaType<typeof memoryNoteSchema> & { _id: mongoose.Types.ObjectId };

/** Lightweight copy of a Backboard memory, always keyed by the Mongo user _id. */
export const MemoryNote: Model<MemoryNoteShape> =
  (mongoose.models.MemoryNote as Model<MemoryNoteShape> | undefined) ??
  mongoose.model<MemoryNoteShape>("MemoryNote", memoryNoteSchema);
