import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const checkInSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: "PurchaseRecord", required: true, unique: true },
    dueAt: { type: Date, required: true, index: true },
    sentAt: { type: Date, default: null },
    answeredAt: { type: Date, default: null },
    answer: { type: String, enum: ["yes", "no"], default: null },
  },
  { timestamps: true },
);

checkInSchema.index({ userId: 1, sentAt: 1, answeredAt: 1 });

type CheckInShape = InferSchemaType<typeof checkInSchema> & { _id: mongoose.Types.ObjectId };

export const CheckIn: Model<CheckInShape> =
  (mongoose.models.CheckIn as Model<CheckInShape> | undefined) ?? mongoose.model<CheckInShape>("CheckIn", checkInSchema);

export const CHECK_IN_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
