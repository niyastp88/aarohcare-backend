import mongoose, { Schema } from 'mongoose';
import { FacilityApprovalStatus, FacilityType } from '../constants/enums';
import { IFacility } from '../types';

const locationSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    formattedAddress: { type: String },
  },
  { _id: false },
);

const facilitySchema = new Schema<IFacility>(
  {
    name: { type: String, required: true, trim: true },
    facilityType: {
      type: String,
      enum: Object.values(FacilityType),
      required: true,
      index: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    phone: { type: String, required: true },
    email: { type: String, sparse: true, unique: true },
    place: { type: String },
    address: { type: String },
    location: { type: locationSchema },
    image: { type: String },
    workingHours: {
      from: { type: String },
      to: { type: String },
      is24Hours: { type: Boolean, default: false },
    },
    openDays: {
      type: [{ type: String, enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }],
      default: ['mon', 'tue', 'wed', 'thu', 'fri'],
    },
    globalAlert: { type: String },
    razorpayAccountId: { type: String, sparse: true, unique: true },
    razorpayLinked: { type: Boolean, default: false },
    bankAccountDetails: {
      accountNumber: { type: String },
      ifscCode: { type: String },
      bankName: { type: String },
      accountHolderName: { type: String },
      upiId: { type: String },
      razorpayId: { type: String },
    },
    isActive: { type: Boolean, default: true, index: true },
    approvalStatus: {
      type: String,
      enum: Object.values(FacilityApprovalStatus),
      default: FacilityApprovalStatus.APPROVED,
      index: true,
    },
    adminPassword: { type: String },
    // Store a separate convenience fee for this specific facility
    convenienceFeeOverride: { type: Number, sparse: true },
    // Store the manual monthly payment status for this facility.
    manualPaymentStatuses: {
      type: [
        {
          monthYear: { type: String, required: true },
          status: { type: String, enum: ['PAID', 'NOT_PAID'], required: true },
        },
      ],
      default: [],
    },
    cancellationPolicy: {
      fullRefundWindow: {
        value: { type: Number, default: 30 },
        unit: { type: String, enum: ['minutes', 'hours', 'days'], default: 'minutes' },
      },
      afterPeriodRefundPercent: { type: Number, default: 90, min: 0, max: 100 },
      refundProcessingPeriod: {
        value: { type: Number, default: 7 },
        unit: { type: String, enum: ['working_days', 'days', 'hours'], default: 'working_days' },
      },
      additionalItems: [
        {
          icon: { type: String, required: true },
          text: {
            en: { type: String, required: true },
            ml: { type: String, default: '' },
          },
        },
      ],
    },
  },
  { timestamps: true },
);

facilitySchema.index({ facilityType: 1, isActive: 1, name: 1 });
/** Facility contact numbers are unique across hospitals / clinics / labs. */
facilitySchema.index({ phone: 1 }, { unique: true });

export default mongoose.model<IFacility>('Facility', facilitySchema);
