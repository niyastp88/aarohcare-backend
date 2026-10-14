import mongoose, { Schema } from 'mongoose';
import { ISchedule } from '../types';

const scheduleSchema = new Schema<ISchedule>(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    date: { type: String, required: true },
    startTime: { type: String },
    endTime: { type: String },
    slots: [
      {
        time: { type: String, required: true },
        isBooked: { type: Boolean, default: false },
      },
    ],
    maxTokens: { type: Number },
    isClosed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

scheduleSchema.index({ doctorId: 1, date: 1 }, { unique: true });

export default mongoose.model<ISchedule>('Schedule', scheduleSchema);
