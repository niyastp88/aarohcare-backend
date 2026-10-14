import mongoose, { Schema } from 'mongoose';
import { IAppointment } from '../types';
import { AppointmentStatus } from '../constants/enums';

const cancellationSchema = new Schema(
  {
    requestedAt: { type: Date, required: true },
    cancelledBy: { type: String, enum: ['PATIENT', 'ADMIN', 'SYSTEM'], required: false },
    reason: { type: String },
    refundPhone: { type: String },
    refundUpiId: { type: String },
    policyAgreedAt: { type: Date },
    within30Minutes: { type: Boolean },
    refundPolicy: {
      type: String,
      enum: [
        'FULL_OP_NO_CONVENIENCE',
        'PARTIAL_90_NO_CONVENIENCE',
        'FULL_OP_100',
        'PARTIAL_90',
        'PARTIAL_75',
        'PARTIAL_50',
        'LAPSED_0',
      ],
    },
    refundAmount: { type: Number },
    refunded: { type: Boolean },
    cancellationNotified: { type: Boolean, default: false },
  },
  { _id: false },
);

const appointmentSchema = new Schema<IAppointment>(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    // Optional for guest/walk-in offline bookings without registered user accounts
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    patientName: { type: String },
    patientAge: { type: Number },
    patientPhone: { type: String },
    date: { type: String, required: true },
    time: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(AppointmentStatus),
      default: AppointmentStatus.PENDING,
    },
    tokenNumber: { type: String },
    consultationFee: { type: Number },
    // Historical consultation fee snapshot established at booking time
    consultationFeeAtBooking: { type: Number },
    platformFee: { type: Number },
    paymentStatus: {
      type: String,
      enum: ['NOT_PAID', 'PAID', 'FAILED', 'REFUNDED'],
      default: 'NOT_PAID',
      index: true,
    },
    previousPaymentStatus: {
      type: String,
      enum: ['NOT_PAID', 'PAID', 'FAILED', 'REFUNDED'],
    },
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    cashfreeOrderId: { type: String },
    paymentSessionId: { type: String },
    scheduleEndTime: { type: String },
    arrivedAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    cancellationReason: { type: String },
    cancellation: { type: cancellationSchema },
    cancellationNotified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Added index for efficient queue:updated socket targeting
appointmentSchema.index({ doctorId: 1, date: 1 });
appointmentSchema.index({ doctorId: 1, patientPhone: 1, createdAt: -1 });

// Concurrency-safe partial unique index to guarantee token uniqueness per doctor and date.
// Why this change is needed: MongoDB rejects $ne/$not inside partialFilterExpression (Error Code 67).
// Using $in with all active booking statuses [PENDING, CONSULTING, COMPLETED] safely excludes CANCELLED
// so released tokens can be rebooked without collision, while remaining 100% compatible with MongoDB and Atlas.
appointmentSchema.index(
  { doctorId: 1, date: 1, tokenNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      tokenNumber: { $exists: true, $type: 'string' },
      status: {
        $in: [
          AppointmentStatus.PENDING,
          AppointmentStatus.CONSULTING,
          AppointmentStatus.COMPLETED,
        ],
      },
    },
  },
);

export default mongoose.model<IAppointment>('Appointment', appointmentSchema);
