import mongoose, { Schema } from 'mongoose';

const adminBillingTransactionSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    labReportId: { type: Schema.Types.ObjectId, ref: 'LabReport' },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ['DEBIT_PLATFORM_FEE', 'CREDIT_PAYMENT_TO_SUPERADMIN', 'CREDIT_REFUND'],
      required: true,
    },
    monthKey: { type: String, index: true }, // Format YYYY-MM
    paymentMethod: {
      type: String,
      enum: ['CASH', 'BANK_TRANSFER', 'UPI', 'GATEWAY', 'SYSTEM'],
      default: 'SYSTEM',
    },
    approvalStatus: {
      type: String,
      enum: ['CONFIRMED', 'PENDING_APPROVAL', 'REJECTED'],
      default: 'CONFIRMED',
      index: true,
    },
    rejectionReason: { type: String },
    referenceNumber: { type: String },
    notes: { type: String },
    description: { type: String, required: true },
  },
  { timestamps: true },
);

export default mongoose.model('AdminBillingTransaction', adminBillingTransactionSchema);
