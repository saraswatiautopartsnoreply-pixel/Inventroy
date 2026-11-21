import mongoose from 'mongoose';

const userSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  userRole: { type: String, required: true },
  warehouse: { type: String, default: '' },
  loginAt: { type: Date, default: Date.now, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },
  endReason: { type: String, enum: ['logout', 'connection_lost', 'admin_removed', null], default: null },
  expiresAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
userSessionSchema.index({ endedAt: 1, lastSeenAt: 1 });
userSessionSchema.index({ loginAt: -1 });

export const UserSession = mongoose.models.UserSession || mongoose.model('UserSession', userSessionSchema);
