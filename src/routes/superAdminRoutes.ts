import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { UserRole } from '../constants/enums';
import * as ctrl from '../controllers/superAdminController';

const router = Router();
const superAdminOnly = [protect, requireRole(UserRole.SUPER_ADMIN)] as const;

/**
 * One-time public bootstrap (Postman). Returns 404 after first Super Admin exists
 * or after bootstrap lock is set — even if the collection is emptied later.
 */
router.post('/bootstrap', ctrl.bootstrapSuperAdmin);

/** Public password recovery for SuperAdmin collection (generic responses). */
router.post('/forgot-password', ctrl.forgotSuperAdminPassword);
router.post('/reset-password', ctrl.resetSuperAdminPassword);

/** Authenticated account management */
router.get('/accounts', ...superAdminOnly, ctrl.listSuperAdminAccounts);
router.post('/accounts', ...superAdminOnly, ctrl.createSuperAdminAccount);
router.patch('/me/password', ...superAdminOnly, ctrl.changeSuperAdminPassword);
router.patch('/me/email', ...superAdminOnly, ctrl.changeSuperAdminEmail);

router.get('/dashboard', ...superAdminOnly, ctrl.dashboardStats);
router.get('/analytics', ...superAdminOnly, ctrl.dashboardAnalytics);

router.get('/facilities', ...superAdminOnly, ctrl.listFacilities);
router.post('/facilities', ...superAdminOnly, ctrl.createFacility);
router.post('/facilities/broadcast', ...superAdminOnly, ctrl.broadcastFacilityAlert);
router.get('/facilities/:id', ...superAdminOnly, ctrl.getFacility);
router.patch('/facilities/:id', ...superAdminOnly, ctrl.updateFacility);
router.delete('/facilities/:id', ...superAdminOnly, ctrl.deleteFacility);
router.post('/facilities/:id/approve', ...superAdminOnly, ctrl.approveFacility);
router.post('/facilities/:id/reject', ...superAdminOnly, ctrl.rejectFacility);
router.get('/facilities/:id/visits', ...superAdminOnly, ctrl.listFacilityVisits);
router.get('/facilities/:id/stats', ...superAdminOnly, ctrl.getFacilityStats);
router.get('/facilities/:id/queue', ...superAdminOnly, ctrl.listFacilityQueue);
router.post('/facilities/:id/queue/live-op', ...superAdminOnly, ctrl.updateFacilityLiveOp);
router.patch('/visits/:visitId', ...superAdminOnly, ctrl.updateVisit);
router.delete('/visits/:visitId', ...superAdminOnly, ctrl.deleteVisit);

router.get('/users', ...superAdminOnly, ctrl.listUsers);
router.get('/users/:id', ...superAdminOnly, ctrl.getUser);
router.post('/users/:id/block', ...superAdminOnly, ctrl.blockUser);

router.get('/payments/fee', ...superAdminOnly, ctrl.getPlatformFee);
router.put('/payments/fee', ...superAdminOnly, ctrl.setPlatformFee);
router.get('/payments/export', ...superAdminOnly, ctrl.exportPaymentsCsv);
router.get('/payments/summary', ...superAdminOnly, ctrl.getPaymentsSummary);
router.get('/payments/monthly-report', ...superAdminOnly, ctrl.getPaymentsMonthlyReport);
router.get('/payments', ...superAdminOnly, ctrl.listPayments);

router.get('/ads', ...superAdminOnly, ctrl.listAds);
router.post('/ads', ...superAdminOnly, ctrl.createAd);
router.post('/ads/reorder', ...superAdminOnly, ctrl.reorderAds);
router.get('/ads/:id', ...superAdminOnly, ctrl.getAd);
router.patch('/ads/:id', ...superAdminOnly, ctrl.updateAd);
router.delete('/ads/:id', ...superAdminOnly, ctrl.deleteAd);

router.get('/lab-reports', ...superAdminOnly, ctrl.listLabReports);
router.delete('/lab-reports/:id', ...superAdminOnly, ctrl.deleteLabReport);

router.get('/emergency', ...superAdminOnly, ctrl.listEmergencyTickets);
router.post('/emergency', ...superAdminOnly, ctrl.createEmergencyTicket);
router.post('/emergency/:id/reply', ...superAdminOnly, ctrl.replyEmergencyTicket);
router.post('/emergency/:id/resolve', ...superAdminOnly, ctrl.resolveEmergencyTicket);

export default router;
