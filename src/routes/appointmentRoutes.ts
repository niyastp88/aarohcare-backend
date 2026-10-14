import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';
import {
  getAppointments,
  bookAppointment,
  updateAppointmentStatus,
  markAppointmentArrived,
  unmarkAppointmentArrived,
  cancelAppointmentByPatient,
  getFacilityPatients,
  getFacilityPatientDetail,
  updateFacilityPatientDetail,
  bookOfflineAppointment,
  lookupPatientByPhone,
  getPlatformFee,
  markAppointmentRefunded,
  verifyPayment,
  getCancellationPolicy,
} from '../controllers/appointmentController';

const router = Router();
const approvedAdmin = [protect, requireRole(UserRole.ADMIN), requireApprovedFacility] as const;

router.get('/platform-fee', protect, getPlatformFee);
router.get('/cancellation-policy', protect, getCancellationPolicy);
router.get('/:appointmentId/cancellation-policy', protect, getCancellationPolicy);
router.get('/', protect, requireApprovedFacility, getAppointments);
router.get('/patients', ...approvedAdmin, getFacilityPatients);
router.get('/patients/lookup', ...approvedAdmin, lookupPatientByPhone);
router.get('/patient-lookup', ...approvedAdmin, lookupPatientByPhone);
router.get('/patients/:patientId', ...approvedAdmin, getFacilityPatientDetail);
router.patch('/patients/:patientId', ...approvedAdmin, updateFacilityPatientDetail);
router.post('/book', protect, requireRole(UserRole.PATIENT), bookAppointment);
router.post('/verify-payment', protect, requireRole(UserRole.PATIENT), verifyPayment);
router.post('/offline', ...approvedAdmin, bookOfflineAppointment);
router.post(
  '/:appointmentId/cancel',
  protect,
  requireRole(UserRole.PATIENT),
  cancelAppointmentByPatient,
);
router.patch('/:appointmentId/arrived', ...approvedAdmin, markAppointmentArrived);
router.patch('/:appointmentId/unmark-arrived', ...approvedAdmin, unmarkAppointmentArrived);
router.patch('/:appointmentId/status', ...approvedAdmin, updateAppointmentStatus);
router.patch('/:appointmentId/refund', ...approvedAdmin, markAppointmentRefunded);

export default router;
