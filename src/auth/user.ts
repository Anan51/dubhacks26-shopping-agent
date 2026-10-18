import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { isPasswordHash } from "./password.js";

/**
 * Backboard memories are shared by every thread on one assistant, and Backboard has no user id.
 * `backboardAssistantId` is written only after this server calls POST /assistants.
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
    hourlyRate: { type: Number, default: null },
    weeklyBudget: { type: Number, default: null },
    surveyCompleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

type UserShape = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId };

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

type MemoryNoteShape = InferSchemaType<typeof memoryNoteSchema> & { _id: mongoose.Types.ObjectId };

/** Listing key. Backboard search results have no Simmer user id, so this copy is what GET /memories returns. */
export const MemoryNote: Model<MemoryNoteShape> =
  (mongoose.models.MemoryNote as Model<MemoryNoteShape> | undefined) ??
  mongoose.model<MemoryNoteShape>("MemoryNote", memoryNoteSchema);
