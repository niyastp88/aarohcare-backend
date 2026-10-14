import type { AuthRequest } from '../middleware/authMiddleware';
import { feedbackService } from '../services/feedbackService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendOk } from '../utils/apiResponse';

export const createFeedback = asyncHandler(async (req: AuthRequest, res) => {
  const feedback = await feedbackService.create(
    req.user!.id,
    req.body.rating,
    req.body.message,
  );
  return sendCreated(res, feedback);
});

/** Super Admin dashboard can consume this endpoint when its UI is added. */
export const listFeedback = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, await feedbackService.list());
});
