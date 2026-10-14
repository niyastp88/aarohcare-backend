import mongoose, { Schema } from 'mongoose';

const adminBillingOrderSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    monthKey: { type: String }, // Single YYYY-MM or comma-separated YYYY-MM
    monthLabel: { type: String },
    status: {
      type: String,
      enum: ['CREATED', 'PAID', 'FAILED', 'CANCELLED'],
      default: 'CREATED',
      index: true,
    },
    failureReason: { type: String },
    paymentId: { type: String },
    returnUrl: { type: String },
  },
  { timestamps: true },
);

export default mongoose.model('AdminBillingOrder', adminBillingOrderSchema);
