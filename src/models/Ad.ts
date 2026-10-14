import mongoose, { Schema } from 'mongoose';
import {
  AdAspectRatio,
  AdMediaType,
  AdPlacement,
  AdStatus,
  AdType,
} from '../constants/enums';
import type { IAd } from '../types';

const adSchema = new Schema<IAd>(
  {
    name: { type: String, required: true, trim: true },
    shareDetails: { type: String },
    redirectUrl: { type: String, trim: true },
    imageUrl: { type: String },
    videoUrl: { type: String },
    mediaType: {
      type: String,
      enum: Object.values(AdMediaType),
      default: AdMediaType.IMAGE,
    },
    adType: {
      type: String,
      enum: Object.values(AdType),
      default: AdType.SPONSORED,
    },
    placement: {
      type: String,
      enum: Object.values(AdPlacement),
      default: AdPlacement.HOME,
    },
    targetLocation: { type: String, default: '' },
    objectPosition: { type: String, default: '50% 50%' },
    aspectRatio: {
      type: String,
      enum: Object.values(AdAspectRatio),
      default: AdAspectRatio.RATIO_4_3,
    },
    displaySeconds: { type: Number, default: 8, min: 3, max: 120 },
    autoRestart: { type: Boolean, default: false },
    durationDays: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(AdStatus),
      default: AdStatus.ACTIVE,
      index: true,
    },
    sortOrder: { type: Number, default: 0, index: true },
    viewCount: { type: Number, default: 0 },
    totalViewTimeMs: { type: Number, default: 0 },
    linkClickCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export default mongoose.model<IAd>('Ad', adSchema);
