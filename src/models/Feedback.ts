import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IFeedback extends Document {
  patientId: Types.ObjectId;
  rating: number;
  message: string;
  status: 'NEW' | 'REVIEWED';
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },
    message: {
      type: String,
      trim: true,
      minlength: 4,
      maxlength: 2000,
      required: true,
    },
    status: {
      type: String,
      enum: ['NEW', 'REVIEWED'],
      default: 'NEW',
      index: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model<IFeedback>('Feedback', feedbackSchema);
