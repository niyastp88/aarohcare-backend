import mongoose, { Schema } from 'mongoose';
import type { ILabReport } from '../types';

const labReportSchema = new Schema<ILabReport>(
  {
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    reportUrl: { type: String },
    notes: { type: String },
  },
  { timestamps: true },
);

export default mongoose.model<ILabReport>('LabReport', labReportSchema);
