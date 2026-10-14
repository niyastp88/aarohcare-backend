import PlatformSetting from '../models/PlatformSetting';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';

let cachedFee: number | null = null;

export const platformFeeService = {
  // Synchronous, non-blocking getter for health check and fast lookups
  getCached: () => cachedFee ?? Number(process.env.PLATFORM_SERVICE_FEE ?? 3),

  get: async () => {
    if (cachedFee != null) return cachedFee;
    const doc = await PlatformSetting.findOne({ key: 'platformServiceFee' });
    cachedFee = Number(doc?.value ?? process.env.PLATFORM_SERVICE_FEE ?? 3);
    return cachedFee;
  },

  set: async (fee: number) => {
    await PlatformSetting.findOneAndUpdate(
      { key: 'platformServiceFee' },
      { $set: { value: fee } },
      { upsert: true, new: true },
    );
    cachedFee = fee;
    return fee;
  },

  setForSuperAdmin: async (feeRaw: unknown) => {
    const fee = Number(feeRaw);
    if (!Number.isFinite(fee) || fee < 0) {
      throw AppError.badRequest(MSG.FEE_INVALID);
    }
    return {
      platformServiceFee: await platformFeeService.set(fee),
      message: MSG.FEE_UPDATED,
    };
  },
};
