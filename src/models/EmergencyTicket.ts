import mongoose, { Schema } from 'mongoose';
import {
  EmergencyPriority,
  EmergencyReplyFrom,
  EmergencyTicketChannel,
  EmergencyTicketSource,
  EmergencyTicketStatus,
} from '../constants/enums';
import type { IEmergencyTicket } from '../types';

const replySchema = new Schema(
  {
    body: { type: String, required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    fromRole: {
      type: String,
      enum: Object.values(EmergencyReplyFrom),
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const emergencyTicketSchema = new Schema<IEmergencyTicket>(
  {
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    priority: {
      type: String,
      enum: Object.values(EmergencyPriority),
      default: EmergencyPriority.EMERGENCY,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(EmergencyTicketStatus),
      default: EmergencyTicketStatus.OPEN,
      index: true,
    },
    source: {
      type: String,
      enum: Object.values(EmergencyTicketSource),
      default: EmergencyTicketSource.SUPER_ADMIN,
      index: true,
    },
    channel: {
      type: String,
      enum: Object.values(EmergencyTicketChannel),
      default: EmergencyTicketChannel.SUPER_ADMIN,
      index: true,
    },
    rating: { type: Number, min: 1, max: 5 },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    city: { type: String, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    replies: { type: [replySchema], default: [] },
    resolvedAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.model<IEmergencyTicket>('EmergencyTicket', emergencyTicketSchema);
