import type { AuthRequest } from '../middleware/authMiddleware';
import { userService } from '../services/userService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendOk } from '../utils/apiResponse';

export const getProfile = asyncHandler(async (req: AuthRequest, res) => {
  const user = await userService.requireById(req.user!.id);
  return sendOk(res, user);
});

export const updateProfile = asyncHandler(async (req: AuthRequest, res) => {
  const user = await userService.updateProfile(
    req.user!.id,
    (req.body ?? {}) as Record<string, unknown>,
  );
  return sendOk(res, user);
});
