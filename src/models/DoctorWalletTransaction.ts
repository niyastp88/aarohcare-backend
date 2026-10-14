import mongoose, { Schema } from 'mongoose';

const doctorWalletTransactionSchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true, index: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ['CREDIT_CONSULTATION', 'DEBIT_PAYOUT', 'DEBIT_REFUND'],
      required: true,
    },
    description: { type: String, required: true },
  },
  { timestamps: true },
);

export default mongoose.model('DoctorWalletTransaction', doctorWalletTransactionSchema);
