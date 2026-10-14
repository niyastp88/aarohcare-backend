import mongoose, { Schema } from 'mongoose';
import { NotificationType } from '../constants/enums';
import type { INotification } from '../types';

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: Object.values(NotificationType),
      default: NotificationType.SYSTEM,
      index: true,
    },
    ticketId: { type: Schema.Types.ObjectId, ref: 'EmergencyTicket' },
    refId: { type: String, trim: true, index: true },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ type: 1, refId: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', notificationSchema);
