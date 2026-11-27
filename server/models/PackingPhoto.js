import mongoose from 'mongoose';

const packingPhotoSchema = new mongoose.Schema({
  orderId: { type: String, required: true, index: true },
  productId: { type: String, required: true, index: true },
  sku: { type: String, required: true, index: true },
  productName: { type: String, required: true },
  warehouse: { type: String, enum: ['KG', 'SPB', 'BG', 'PB'], required: true },
  packerId: { type: String, required: true },
  packerName: { type: String, required: true },
  mimeType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'], required: true },
  mediaType: { type: String, enum: ['image', 'video'], default: 'image' },
  image: { type: Buffer, required: false },
  storageProvider: { type: String, enum: ['backblaze'], default: undefined },
  storageFileId: { type: String, default: '' },
  storageFileName: { type: String, default: '' },
  keep: { type: Boolean, default: false, index: true },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true, versionKey: false });

packingPhotoSchema.index({ expiresAt: 1 });

export const PackingPhoto = mongoose.models.PackingPhoto || mongoose.model('PackingPhoto', packingPhotoSchema);
