import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';
import {
  getDoctorWallets,
  getDoctorOrders,
  getFacilityCancelledOrders,
  markPatientRefunded,
  undoPatientRefund,
  getAdminBillingDues,
  getAdminDuesMonthlySummary,
  createPlatformDuesOrder,
  getAdminBillingOrderDetails,
  cancelPlatformDuesOrder,
  verifyPlatformDuesPayment,
  recordDirectDuesPaymentToSuperAdmin,
  approveDirectPaymentClaim,
  rejectDirectPaymentClaim,
  getSuperAdminAllAdminDues,
  settleAdminPlatformDues,
  getSuperAdminAllAdminTransactions,
  getAdminDuesBreakdownByDoctor,
  getAdminDuesDoctorOrders,
  getFacilityMonthlyBookings,
} from '../controllers/billingController';

const router = Router();
const adminOnly = requireRole(UserRole.ADMIN);
const superAdminOnly = requireRole(UserRole.SUPER_ADMIN);

// Admin Routes (Doctor Wallets & Platform Dues)
router.get('/doctor-wallets', protect, adminOnly, getDoctorWallets);
router.get('/doctor-wallets/:doctorId/orders', protect, adminOnly, getDoctorOrders);
router.get('/cancelled-orders', protect, adminOnly, getFacilityCancelledOrders);
router.post('/doctor-wallets/appointments/:appointmentId/refund-patient', protect, adminOnly, markPatientRefunded);
router.post('/doctor-wallets/appointments/:appointmentId/undo-refund-patient', protect, adminOnly, undoPatientRefund);
router.get('/admin-dues', protect, adminOnly, getAdminBillingDues);
// Route to fetch year-based monthly billing summary for both Lab Admin and Clinic Admin Record Summary
router.get('/admin-dues/monthly-summary', protect, adminOnly, getAdminDuesMonthlySummary);
router.get('/admin-dues/bookings', protect, adminOnly, getFacilityMonthlyBookings);
router.get('/admin-dues/breakdown', protect, adminOnly, getAdminDuesBreakdownByDoctor);
router.get('/admin-dues/breakdown/:doctorId', protect, adminOnly, getAdminDuesDoctorOrders);
router.post('/admin-dues/create-order', protect, adminOnly, createPlatformDuesOrder);
router.get('/admin-dues/orders/:orderId', protect, adminOnly, getAdminBillingOrderDetails);
router.post('/admin-dues/orders/:orderId/cancel', protect, adminOnly, cancelPlatformDuesOrder);
router.post('/admin-dues/verify-payment', protect, adminOnly, verifyPlatformDuesPayment);
router.post('/admin-dues/direct-payment', protect, adminOnly, recordDirectDuesPaymentToSuperAdmin);

// Super Admin Routes (Facility Platform Billing Dues)
router.get('/super-admin/platform-dues', protect, superAdminOnly, getSuperAdminAllAdminDues);
// Fetch all recorded payment transactions from facilities to the Super Admin.
router.get('/super-admin/platform-transactions', protect, superAdminOnly, getSuperAdminAllAdminTransactions);
router.post('/super-admin/platform-dues/:adminId/settle', protect, superAdminOnly, settleAdminPlatformDues);
router.post('/super-admin/platform-claims/:transactionId/approve', protect, superAdminOnly, approveDirectPaymentClaim);
router.post('/super-admin/platform-claims/:transactionId/reject', protect, superAdminOnly, rejectDirectPaymentClaim);

export default router;
