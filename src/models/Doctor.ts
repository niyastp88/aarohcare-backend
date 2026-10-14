import mongoose, { Schema } from 'mongoose';
import { IDoctor } from '../types';

const doctorSchema = new Schema<IDoctor>(
  {
    name: { type: String, required: true },
    specialization: { type: String },
    phone: { type: String },
    email: { type: String },
    qualifications: { type: String },
    consultationFee: { type: Number },
    place: { type: String },
    profileImage: { type: String },
    isActive: { type: Boolean, default: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    liveOp: {
      date: { type: String },
      currentNumber: { type: Number, default: 0 },
      onBreak: { type: Boolean, default: false },
    },
    bankAccountDetails: {
      accountNumber: { type: String },
      ifscCode: { type: String },
      bankName: { type: String },
      accountHolderName: { type: String },
      upiId: { type: String },
    },
  },
  { timestamps: true },
);

doctorSchema.index({ adminId: 1 });
doctorSchema.index({ facilityId: 1, isActive: 1 });

export default mongoose.model<IDoctor>('Doctor', doctorSchema);
