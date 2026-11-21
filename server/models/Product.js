import mongoose from 'mongoose';

const locationSchema = new mongoose.Schema({
  warehouse: { type: String, default: '', validate: { validator: (value) => !value || ['KG', 'SPB', 'BG', 'PB'].includes(value) }, index: true },
  rack: { type: String, trim: true, maxlength: 120, default: '' },
  qty: { type: Number, required: true, default: 0 },
  reserved: { type: Number, required: true, min: 0, default: 0 },
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  sku: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 80 },
  brand: { type: String, required: true, trim: true, maxlength: 100 },
  category: { type: String, trim: true, maxlength: 100, default: 'General' },
  unit: { type: String, trim: true, uppercase: true, maxlength: 20, default: 'PCS' },
  vehicleFitment: { type: [{ make: String, model: String, yearFrom: Number, yearTo: Number, engine: String }], default: [] },
  oe: { type: [String], default: [], index: true },
  price: { type: Number, min: 0, default: 0 },
  priceIncludesGst: { type: Boolean, default: false },
  cost: { type: Number, min: 0, default: 0 },
  reorderPoint: { type: Number, min: 0, default: 0 },
  barcode: { type: String, unique: true, sparse: true, trim: true, maxlength: 80 },
  wooCommerceId: { type: Number, index: true },
  active: { type: Boolean, default: true },
  keepPackingPhotos: { type: Boolean, default: false },
  locations: { type: [locationSchema], default: [] },
}, { timestamps: true, versionKey: false, strict: 'throw' });

productSchema.index({ name: 'text', brand: 'text', sku: 'text', oe: 'text', barcode: 'text' });

export const Product = mongoose.models.Product || mongoose.model('Product', productSchema);
