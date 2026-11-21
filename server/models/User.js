import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 30, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'Store Manager', 'Packer'], default: 'Packer' },
  warehouse: { type: String, enum: ['KG', 'SPB', 'BG', 'PB'], default: undefined },
  approved: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
}, { timestamps: true, versionKey: false });

export const User = mongoose.models.User || mongoose.model('User', userSchema);
