import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';
import {
  createEmergencyTicket,
  listMyEmergencyTickets,
  replyMyEmergencyTicket,
} from '../controllers/emergencyController';

const router = Router();

router.get('/', protect, listMyEmergencyTickets);
router.post('/', protect, requireRole(UserRole.ADMIN), createEmergencyTicket);
router.post('/:id/reply', protect, replyMyEmergencyTicket);

export default router;
