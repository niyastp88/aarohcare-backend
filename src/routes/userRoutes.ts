import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { getProfile, updateProfile } from '../controllers/userController';

const router = Router();

router.get('/profile', protect, getProfile);
router.put('/profile', protect, requireApprovedFacility, updateProfile);

export default router;
