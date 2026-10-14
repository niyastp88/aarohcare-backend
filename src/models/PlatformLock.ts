import mongoose, { Schema } from 'mongoose';

/** One-time locks (e.g. Super Admin bootstrap) — survives emptying the SuperAdmin collection. */
const platformLockSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    locked: { type: Boolean, default: true },
    lockedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export default mongoose.model('PlatformLock', platformLockSchema);
