import mongoose, { Schema } from 'mongoose';
import type { ISuperAdmin } from '../types';

const superAdminSchema = new Schema<ISuperAdmin>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
    password: { type: String, required: true },
    isActive: { type: Boolean, default: true, index: true },
    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },
  },
  { timestamps: true },
);

superAdminSchema.index({ phone: 1 }, { unique: true });

superAdminSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as { password?: string }).password;
    return ret;
  },
});

export default mongoose.model<ISuperAdmin>('SuperAdmin', superAdminSchema);
