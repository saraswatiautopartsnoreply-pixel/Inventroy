import mongoose from 'mongoose';

const paymentLinkSchema = new mongoose.Schema({
  razorpayId: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  referenceId: { type: String, required: true, index: true },
  description: { type: String, required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  amountPaidPaise: { type: Number, min: 0, default: 0 },
  status: { type: String, default: 'created', index: true },
  failedAttempts: { type: Number, min: 0, default: 0 },
  failedPaymentIds: { type: [String], default: [] },
  lastFailureAt: { type: Date, default: null },
  lastFailureReason: { type: String, default: '' },
  customer: { name: { type: String, default: '' }, email: { type: String, default: '' }, phone: { type: String, default: '' } },
  expiresAt: { type: Date, default: null },
  createdById: { type: String, default: '' },
  createdByName: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

paymentLinkSchema.index({ createdAt: -1 });

export const PaymentLink = mongoose.models.PaymentLink || mongoose.model('PaymentLink', paymentLinkSchema);
