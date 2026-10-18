import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const purchaseSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    item: { type: String, required: true, maxlength: 200 },
    category: { type: String, required: true, maxlength: 40 },
    price: { type: Number, required: true },
    verdict: { type: String, default: null, maxlength: 40 },
    feedback: { type: String, enum: ["regretted", "kept"], default: null },
    isExample: { type: Boolean, required: true, default: false },
    /** Survey entries are the shopper's own recent purchases, even if an older row was marked as an example. */
    source: { type: String, enum: ["survey", "checkout"], default: "checkout" },
    ratedAt: { type: Date, default: null },
    cartCode: { type: String, default: null },
  },
  { timestamps: true },
);

purchaseSchema.index(
  { userId: 1, cartCode: 1 },
  { unique: true, partialFilterExpression: { cartCode: { $type: "string" } } },
);

type PurchaseShape = InferSchemaType<typeof purchaseSchema> & { _id: mongoose.Types.ObjectId };

export const PurchaseRecord: Model<PurchaseShape> =
  (mongoose.models.PurchaseRecord as Model<PurchaseShape> | undefined) ??
  mongoose.model<PurchaseShape>("PurchaseRecord", purchaseSchema);
