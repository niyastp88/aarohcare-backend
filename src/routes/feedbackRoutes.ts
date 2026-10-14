import { Router } from 'express';
import {
  createFeedback,
  listFeedback,
} from '../controllers/feedbackController';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';

const router = Router();

router.post('/', protect, requireRole(UserRole.PATIENT), createFeedback);
router.get('/', protect, requireRole(UserRole.ADMIN), requireApprovedFacility, listFeedback);

export default router;
