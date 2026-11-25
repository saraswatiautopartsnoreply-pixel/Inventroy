import mongoose from 'mongoose';

const systemSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global' },
  allowZeroStockSales: { type: Boolean, default: true },
}, { timestamps: true, versionKey: false });

export const SystemSetting = mongoose.models.SystemSetting || mongoose.model('SystemSetting', systemSettingSchema);
