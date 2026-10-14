import { Router } from 'express';
import { getFacilities, getMyFacility, updateMyFacility } from '../controllers/facilityController';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';

const router = Router();
const adminOnly = requireRole(UserRole.ADMIN);

router.get('/', getFacilities);
router.get('/mine', protect, adminOnly, getMyFacility);
router.patch('/mine', protect, adminOnly, requireApprovedFacility, updateMyFacility);

export default router;
