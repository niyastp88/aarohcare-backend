import { Router } from 'express';
import {
  createLabReport,
  deleteLabReport,
  getLabPatient,
  labReportStats,
  listLabReportPatients,
  listMyLabReports,
  listPatientLabReports,
  lookupLabPatientByPhone,
  remindLabReport,
} from '../controllers/labReportController';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';

const router = Router();
const approvedAdmin = [protect, requireRole(UserRole.ADMIN), requireApprovedFacility] as const;
const patientOnly = [protect, requireRole(UserRole.PATIENT)] as const;

router.get('/me', ...patientOnly, listPatientLabReports);
router.post('/remind', ...patientOnly, remindLabReport);
router.get('/', ...approvedAdmin, listMyLabReports);
router.get('/stats', ...approvedAdmin, labReportStats);
router.get('/patients/lookup', ...approvedAdmin, lookupLabPatientByPhone);
router.post('/patients/lookup', ...approvedAdmin, lookupLabPatientByPhone);
router.get('/patients/:patientId', ...approvedAdmin, getLabPatient);
router.get('/patients', ...approvedAdmin, listLabReportPatients);
router.post('/', ...approvedAdmin, createLabReport);
router.delete('/:id', ...approvedAdmin, deleteLabReport);

export default router;
