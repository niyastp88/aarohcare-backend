import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';
import {
  getDoctors,
  getSpecializations,
  createDoctor,
  updateDoctor,
  deleteDoctor,
  getDoctorSchedule,
  listDoctorSchedules,
  createSchedule,
  bulkCreateSchedule,
  setScheduleClosed,
  getLiveQueue,
  getLiveOverview,
  updateLiveOp,
  movePendingOps,
} from '../controllers/doctorController';

const router = Router();
const adminOnly = requireRole(UserRole.ADMIN);
const approvedAdmin = [protect, adminOnly, requireApprovedFacility] as const;

router.get('/specializations', protect, getSpecializations);
router.get('/', protect, requireApprovedFacility, getDoctors);
router.post('/', ...approvedAdmin, createDoctor);
router.post('/schedule', ...approvedAdmin, createSchedule);
router.post('/schedule/bulk', ...approvedAdmin, bulkCreateSchedule);
router.get('/live-overview', ...approvedAdmin, getLiveOverview);
router.get('/:doctorId/schedules', ...approvedAdmin, listDoctorSchedules);
router.get('/:doctorId/schedule/:date', protect, requireApprovedFacility, getDoctorSchedule);
router.patch('/:doctorId/schedule/:date', ...approvedAdmin, setScheduleClosed);
router.get('/:doctorId/live-queue', ...approvedAdmin, getLiveQueue);
router.patch('/:doctorId/live-op', ...approvedAdmin, updateLiveOp);
router.post('/:doctorId/move-ops', ...approvedAdmin, movePendingOps);
router.patch('/:doctorId', ...approvedAdmin, updateDoctor);
router.delete('/:doctorId', ...approvedAdmin, deleteDoctor);

export default router;
