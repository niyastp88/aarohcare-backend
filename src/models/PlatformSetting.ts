import mongoose, { Schema } from 'mongoose';

const platformSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Number, required: true },
  },
  { timestamps: true },
);

export default mongoose.model('PlatformSetting', platformSettingSchema);
