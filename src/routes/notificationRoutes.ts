import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../controllers/notificationController';

const router = Router();

router.get('/', protect, listNotifications);
router.patch('/read-all', protect, markAllNotificationsRead);
router.patch('/:id/read', protect, markNotificationRead);

export default router;
