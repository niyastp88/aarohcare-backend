import mongoose, { Schema } from 'mongoose';
import { IUser } from '../types';
import { FacilityType, UserRole } from '../constants/enums';

const locationSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    formattedAddress: { type: String },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: { type: String, sparse: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: Object.values(UserRole),
      required: true,
    },
    phone: { type: String, required: true },
    healthCardId: { type: String, unique: true, sparse: true },
    place: { type: String },
    facilityType: {
      type: String,
      enum: Object.values(FacilityType),
    },
    location: { type: locationSchema },
    age: { type: Number },
    dateOfBirth: { type: String },
    bloodGroup: { type: String },
    profileImage: { type: String },
    address: { type: String },
    gender: { type: String },
    termsAcceptedAt: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },
  },
  { timestamps: true },
);

/** Same phone can exist once as PATIENT and once as ADMIN (facility). */
userSchema.index({ phone: 1, role: 1 }, { unique: true });

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as { password?: string }).password;
    delete (ret as { passwordResetToken?: string }).passwordResetToken;
    delete (ret as { passwordResetExpires?: Date }).passwordResetExpires;
    return ret;
  },
});

export default mongoose.model<IUser>('User', userSchema);
