import mongoose from 'mongoose';

const productCounterSchema = new mongoose.Schema({
  _id: { type: String, default: 'products' },
  value: { type: Number, required: true, min: 0, default: 0 },
}, { versionKey: false, collection: 'productcounters' });

export const ProductCounter = mongoose.models.ProductCounter || mongoose.model('ProductCounter', productCounterSchema);
