import type { AuthRequest } from '../middleware/authMiddleware';
import { notificationService } from '../services/notificationService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendOk } from '../utils/apiResponse';

export const listNotifications = asyncHandler(async (req: AuthRequest, res) => {
  const [items, unreadCount] = await Promise.all([
    notificationService.listForUser(req.user!.id),
    notificationService.unreadCount(req.user!.id),
  ]);
  return sendOk(res, { items, unreadCount });
});

export const markNotificationRead = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await notificationService.markRead(req.user!.id, String(req.params.id)));
});

export const markAllNotificationsRead = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await notificationService.markAllRead(req.user!.id));
});
