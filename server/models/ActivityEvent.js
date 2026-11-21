import mongoose from 'mongoose';

const activityItemSchema = new mongoose.Schema({
  sku: { type: String, required: true },
  name: { type: String, required: true },
  unit: { type: String, trim: true, uppercase: true, maxlength: 20, default: 'PCS' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  gstIncluded: { type: Boolean, default: false },
  gstRate: { type: Number, min: 0 },
  gstAmount: { type: Number, min: 0, default: 0 },
}, { _id: false });

const activityEventSchema = new mongoose.Schema({
  eventKey: { type: String, unique: true, sparse: true },
  type: { type: String, enum: ['sale_created', 'order_packed'], required: true, index: true },
  actorId: { type: String, required: true, index: true },
  actorName: { type: String, required: true },
  actorRole: { type: String, required: true },
  warehouse: { type: String, enum: ['KG', 'SPB', 'BG', 'PB'], required: true },
  orderId: { type: String, required: true, index: true },
  orderNumber: { type: String, required: true },
  customerName: { type: String, default: '' },
  source: { type: String, default: 'manual' },
  items: { type: [activityItemSchema], required: true },
  total: { type: Number, required: true, min: 0 },
  occurredAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 210 * 24 * 60 * 60 * 1000) },
}, { timestamps: true, versionKey: false });

activityEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
activityEventSchema.index({ type: 1, occurredAt: -1 });

export const ActivityEvent = mongoose.models.ActivityEvent || mongoose.model('ActivityEvent', activityEventSchema);
