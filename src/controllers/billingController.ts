import type { AuthRequest } from '../middleware/authMiddleware';
import { billingService } from '../services/billingService';
import { UserRole } from '../constants/enums';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendOk } from '../utils/apiResponse';

export const getDoctorWallets = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const fromDate = req.query.fromDate ? String(req.query.fromDate) : undefined;
  const toDate = req.query.toDate ? String(req.query.toDate) : undefined;
  const wallets = await billingService.getDoctorWallets(adminId, fromDate, toDate);
  return sendOk(res, wallets);
});

export const getDoctorOrders = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const doctorId = String(req.params.doctorId);
  const statusFilter = req.query.status ? String(req.query.status) : undefined;
  const fromDate = req.query.fromDate ? String(req.query.fromDate) : undefined;
  const toDate = req.query.toDate ? String(req.query.toDate) : undefined;
  const data = await billingService.getDoctorOrders(adminId, doctorId, statusFilter, fromDate, toDate);
  return sendOk(res, data);
});

export const getFacilityCancelledOrders = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const options = {
    search: req.query.search ? String(req.query.search) : undefined,
    fromDate: req.query.fromDate ? String(req.query.fromDate) : undefined,
    toDate: req.query.toDate ? String(req.query.toDate) : undefined,
    monthKey: req.query.monthKey ? String(req.query.monthKey) : undefined,
    refundStatus: req.query.refundStatus as 'ALL' | 'PENDING_REFUND' | 'REFUNDED' | undefined,
    doctorId: req.query.doctorId ? String(req.query.doctorId) : undefined,
    type: req.query.type as 'ALL' | 'Online' | 'Offline' | undefined,
    page: req.query.page ? Number(req.query.page) : 1,
    limit: req.query.limit ? Number(req.query.limit) : 20,
  };
  const data = await billingService.getFacilityCancelledOrders(adminId, options);
  return sendOk(res, data);
});

export const markPatientRefunded = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const appointmentId = String(req.params.appointmentId);
  const result = await billingService.markPatientRefunded(adminId, appointmentId);
  return sendOk(res, result);
});

export const undoPatientRefund = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const appointmentId = String(req.params.appointmentId);
  const result = await billingService.undoPatientRefund(adminId, appointmentId);
  return sendOk(res, result);
});

export const getAdminBillingDues = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const dues = await billingService.getAdminBillingDues(adminId);
  return sendOk(res, dues);
});

// Serve year-based monthly billing summary for both Lab Admin and Clinic Admin Record Summary
export const getAdminDuesMonthlySummary = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const year = req.query.year ? Number(req.query.year) : undefined;
  const summary = await billingService.getAdminDuesMonthlySummary(adminId, year);
  return sendOk(res, summary);
});

// Serve the doctor-wise billing breakdown so the Web portal can load the selected month's authoritative billing data.
export const getAdminDuesBreakdownByDoctor = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { monthKey } = req.query;
  if (!monthKey || typeof monthKey !== 'string') {
    throw AppError.badRequest('monthKey is required');
  }
  const breakdown = await billingService.getAdminDuesBreakdownByDoctor(adminId, monthKey);
  return sendOk(res, breakdown);
});

// Serve the detailed orders for a specific doctor under the platform dues context.
export const getAdminDuesDoctorOrders = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { doctorId } = req.params;
  const { monthKey } = req.query;
  if (!monthKey || typeof monthKey !== 'string') {
    throw AppError.badRequest('monthKey is required');
  }
  const result = await billingService.getAdminDuesDoctorOrders(adminId, String(doctorId), monthKey);
  return sendOk(res, result);
});

// Fetch paginated appointments for the selected facility/month so Total, Online, and Offline views can reuse one booking page without creating separate data sources.
export const getFacilityMonthlyBookings = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { monthKey, doctorId, patientId, type, page, limit } = req.query;
  
  if (!monthKey || typeof monthKey !== 'string') {
    throw AppError.badRequest('monthKey is required');
  }
  
  const options = {
    monthKey,
    doctorId: doctorId ? String(doctorId) : undefined,
    patientId: patientId ? String(patientId) : undefined,
    type: type ? String(type) : undefined,
    page: page ? Number(page) : 1,
    limit: limit ? Number(limit) : 20,
  };
  
  const result = await billingService.getFacilityMonthlyBookings(adminId, options);
  return sendOk(res, result);
});

export const createPlatformDuesOrder = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { amount, monthKey, returnUrl } = req.body || {};
  const order = await billingService.createPlatformDuesOrder(
    adminId,
    amount ? Number(amount) : undefined,
    monthKey ? String(monthKey) : undefined,
    returnUrl ? String(returnUrl) : undefined,
  );
  return sendOk(res, order);
});

export const getAdminBillingOrderDetails = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { orderId } = req.params;
  const details = await billingService.getAdminBillingOrderDetails(adminId, String(orderId));
  return sendOk(res, details);
});

export const cancelPlatformDuesOrder = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { orderId } = req.params;
  const { reason } = req.body || {};
  const result = await billingService.cancelPlatformDuesOrder(adminId, String(orderId), reason ? String(reason) : undefined);
  return sendOk(res, result);
});

export const verifyPlatformDuesPayment = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { orderId, razorpayPaymentId, razorpaySignature, cashfreePaymentId, monthKey } = req.body || {};
  if (!orderId) throw AppError.badRequest('Order ID is required');
  const result = await billingService.verifyPlatformDuesPayment(
    adminId,
    String(orderId),
    {
      razorpayPaymentId: razorpayPaymentId ? String(razorpayPaymentId) : undefined,
      razorpaySignature: razorpaySignature ? String(razorpaySignature) : undefined,
      cashfreePaymentId: cashfreePaymentId ? String(cashfreePaymentId) : undefined,
    },
    monthKey ? String(monthKey) : undefined,
  );
  return sendOk(res, result);
});

export const recordDirectDuesPaymentToSuperAdmin = asyncHandler(async (req: AuthRequest, res) => {
  if (!req.user?.id) throw AppError.unauthorized('Authentication required');
  const adminId = req.user.id;
  const { amount, paymentMethod, referenceNumber, notes, monthKey } = req.body || {};
  const result = await billingService.recordDirectDuesPaymentToSuperAdmin(
    adminId,
    Number(amount),
    paymentMethod,
    referenceNumber,
    notes,
    monthKey,
  );
  return sendOk(res, result);
});

export const approveDirectPaymentClaim = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only Super Admin can approve payment claims');
  }
  const { transactionId } = req.params;
  const txn = await billingService.approveDirectPaymentClaim(String(transactionId), req.user?.id);
  return sendOk(res, txn);
});

export const rejectDirectPaymentClaim = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only Super Admin can reject payment claims');
  }
  const { transactionId } = req.params;
  const { rejectionReason } = req.body || {};
  const txn = await billingService.rejectDirectPaymentClaim(String(transactionId), req.user?.id, rejectionReason);
  return sendOk(res, txn);
});

export const getSuperAdminAllAdminDues = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only Super Admin can access all facility platform dues');
  }
  const duesList = await billingService.getSuperAdminAllAdminDues();
  return sendOk(res, duesList);
});

export const settleAdminPlatformDues = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only Super Admin can settle facility platform dues');
  }
  const adminId = String(req.params.adminId);
  const { amount, paymentMethod, referenceNumber, notes, monthKey } = req.body || {};
  const txn = await billingService.settleAdminPlatformDues(
    adminId,
    Number(amount),
    paymentMethod,
    referenceNumber,
    notes,
    monthKey,
  );
  return sendOk(res, txn);
});

// Handle the Super Admin request to fetch all facility-to-Super-Admin transactions.
export const getSuperAdminAllAdminTransactions = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role !== UserRole.SUPER_ADMIN) {
    throw AppError.forbidden('Only Super Admin can access all facility platform transactions');
  }
  const result = await billingService.getSuperAdminAllAdminTransactions(req.query);
  return sendOk(res, result);
});
