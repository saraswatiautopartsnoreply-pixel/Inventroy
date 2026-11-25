import mongoose from 'mongoose';

const orderLineSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  sku: { type: String, required: true },
  name: { type: String, required: true },
  brand: { type: String, default: '' },
  unit: { type: String, trim: true, uppercase: true, maxlength: 20, default: 'PCS' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  taxableAmount: { type: Number, min: 0, default: 0 },
  gstIncluded: { type: Boolean, default: false },
  gstRate: { type: Number, min: 0 },
  gstAmount: { type: Number, min: 0, default: 0 },
  backorderedQuantity: { type: Number, min: 0, default: 0 },
  allocations: [{ warehouse: String, rack: String, quantity: Number }],
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  source: { type: String, enum: ['manual', 'woocommerce'], default: 'manual' },
  wooCommerceId: { type: Number, sparse: true, unique: true },
  wooCommerceStatus: { type: String, enum: ['', 'processing', 'cancelled'], default: '' },
  customer: { name: { type: String, required: true }, email: String, phone: String, address: String, gstin: String },
  warehouse: { type: String, enum: ['KG', 'SPB', 'BG', 'PB'], required: true },
  items: { type: [orderLineSchema], required: true },
  subtotal: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, min: 0, default: 0 },
  shippingAmount: { type: Number, min: 0, default: 0 },
  taxRate: { type: Number, min: 0, max: 100, default: 0 },
  taxAmount: { type: Number, min: 0, default: 0 },
  total: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['cash', 'card', 'upi', 'bank_transfer', 'credit', 'razorpay', 'woocommerce'], default: 'cash' },
  paymentLink: { id: { type: String, default: '' }, url: { type: String, default: '' }, status: { type: String, default: '' }, amountPaise: { type: Number, min: 0, default: 0 }, failedAttempts: { type: Number, min: 0, default: 0 }, failedPaymentIds: { type: [String], default: [] }, lastFailureAt: { type: Date, default: null }, lastFailureReason: { type: String, default: '' }, createdAt: Date },
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'refunded'], default: 'unpaid' },
  amountPaid: { type: Number, min: 0, default: 0 },
  balanceDue: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['ready_to_pack', 'accepted', 'packing', 'packed', 'shipped', 'completed', 'cancelled'], default: 'ready_to_pack', index: true },
  assignedTo: { type: String, default: '' },
  assignedName: { type: String, default: '' },
  createdById: { type: String, default: '' },
  createdByName: { type: String, default: '' },
  createdByRole: { type: String, default: '' },
  packedBy: { type: String, default: '' },
  statusHistory: [{ status: String, userId: String, userName: String, at: { type: Date, default: Date.now }, note: String }],
  notes: { type: String, maxlength: 1000, default: '' },
}, { timestamps: true, versionKey: false });

orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

export const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
