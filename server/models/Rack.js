import mongoose from 'mongoose';

const rackSchema = new mongoose.Schema({
  warehouse: { type: String, enum: ['KG', 'SPB', 'BG', 'PB'], required: true },
  rack: { type: String, required: true, trim: true, uppercase: true },
}, { timestamps: true, versionKey: false });

rackSchema.index({ warehouse: 1, rack: 1 }, { unique: true });

export const Rack = mongoose.models.Rack || mongoose.model('Rack', rackSchema);
