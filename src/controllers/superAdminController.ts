import type { Request } from 'express';
import type { AuthRequest } from '../middleware/authMiddleware';
import { UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import { adService } from '../services/adService';
import { appointmentService } from '../services/appointmentService';
import { doctorService } from '../services/doctorService';
import { emergencyTicketService } from '../services/emergencyTicketService';
import { facilityService } from '../services/facilityService';
import { labReportService } from '../services/labReportService';
import { platformFeeService } from '../services/platformFeeService';
import {
  parsePaymentStatus,
  superAdminDashboardService,
} from '../services/superAdminDashboardService';
import { superAdminAccountService } from '../services/superAdminAccountService';
import { userService } from '../services/userService';
import Facility from '../models/Facility';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendMessage, sendOk } from '../utils/apiResponse';

// ── Accounts ────────────────────────────────────────────────────────────────

export const bootstrapSuperAdmin = asyncHandler(async (req: Request, res) => {
  return sendCreated(res, await superAdminAccountService.bootstrapAccount(req.body ?? {}));
});

export const createSuperAdminAccount = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(res, await superAdminAccountService.createAccount(req.body ?? {}));
});

export const listSuperAdminAccounts = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, await superAdminAccountService.list());
});

export const changeSuperAdminPassword = asyncHandler(async (req: AuthRequest, res) => {
  const message = await superAdminAccountService.changeOwnPassword(
    req.user!.id,
    String(req.body?.currentPassword || ''),
    String(req.body?.newPassword || ''),
  );
  return sendMessage(res, message);
});

export const changeSuperAdminEmail = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await superAdminAccountService.changeOwnEmail(
      req.user!.id,
      String(req.body?.email || ''),
      String(req.body?.currentPassword || ''),
    ),
  );
});

export const forgotSuperAdminPassword = asyncHandler(async (req: Request, res) => {
  return sendMessage(
    res,
    await superAdminAccountService.forgotPassword(String(req.body?.email || '')),
  );
});

export const resetSuperAdminPassword = asyncHandler(async (req: Request, res) => {
  return sendMessage(
    res,
    await superAdminAccountService.resetPassword(
      String(req.body?.token || ''),
      String(req.body?.password || ''),
    ),
  );
});

// ── Facilities ──────────────────────────────────────────────────────────────

export const listFacilities = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await facilityService.listFacilitiesForSuperAdmin({
      type: req.query.type ? String(req.query.type) : undefined,
      approvalStatus: req.query.approvalStatus
        ? String(req.query.approvalStatus)
        : undefined,
    }),
  );
});

export const getFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await facilityService.requireById(String(req.params.id)));
});

export const createFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(
    res,
    await facilityService.createFacilityForSuperAdmin(
      (req.body ?? {}) as Record<string, unknown>,
    ),
  );
});

export const updateFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await facilityService.updateFacilityForSuperAdmin(
      String(req.params.id),
      (req.body ?? {}) as Record<string, unknown>,
    ),
  );
});

export const deleteFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendMessage(
    res,
    await facilityService.deleteFacilityForSuperAdmin(String(req.params.id)),
  );
});

export const approveFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await facilityService.approveForSuperAdmin(String(req.params.id)));
});

export const rejectFacility = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await facilityService.rejectForSuperAdmin(String(req.params.id)));
});

export const broadcastFacilityAlert = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await facilityService.broadcastAlertForSuperAdmin(
      (req.body ?? {}) as { message?: string; facilityId?: string; city?: string },
    ),
  );
});

export const listFacilityVisits = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await appointmentService.listVisitsForFacility(String(req.params.id)),
  );
});

export const listFacilityQueue = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await appointmentService.listQueueForFacility(
      String(req.params.id),
      req.query.date ? String(req.query.date) : undefined,
    ),
  );
});

export const getFacilityStats = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await appointmentService.getFacilityProfileStats(String(req.params.id)));
});

export const updateFacilityLiveOp = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId, date, action, currentNumber } = (req.body ?? {}) as {
    doctorId?: string;
    date?: string;
    action?: 'next' | 'previous' | 'break' | 'resume';
    currentNumber?: number;
  };
  if (!doctorId) {
    throw AppError.badRequest(MSG.DOCTOR_NOT_FOUND);
  }
  return sendOk(
    res,
    await doctorService.applyLiveOpForSuperAdmin(String(req.params.id), String(doctorId), {
      date,
      action,
      currentNumber,
    }),
  );
});

export const updateVisit = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await appointmentService.updateVisitForSuperAdmin(
      String(req.params.visitId),
      (req.body ?? {}) as Record<string, unknown>,
    ),
  );
});

export const deleteVisit = asyncHandler(async (req: AuthRequest, res) => {
  return sendMessage(
    res,
    await appointmentService.deleteVisitForSuperAdmin(String(req.params.visitId)),
  );
});

// ── Users ───────────────────────────────────────────────────────────────────

export const listUsers = asyncHandler(async (req: AuthRequest, res) => {
  const role = String(req.query.role || UserRole.PATIENT);
  return sendOk(res, await userService.listForSuperAdmin(role));
});

export const getUser = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await userService.requireDetailForSuperAdmin(String(req.params.id)));
});

export const blockUser = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await userService.blockForSuperAdmin(String(req.params.id)));
});

// ── Payments ────────────────────────────────────────────────────────────────

export const getPlatformFee = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, { platformServiceFee: await platformFeeService.get() });
});

export const setPlatformFee = asyncHandler(async (req: AuthRequest, res) => {
  const facilityId = req.body?.facilityId;
  const feeValue = req.body?.platformServiceFee;
  
  // Allow Super Admin to set a separate fee for each facility.
  if (facilityId) {
    const fee = feeValue === null || feeValue === '' ? null : Number(feeValue);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
      throw AppError.badRequest(MSG.FEE_INVALID);
    }
    
    await Facility.findByIdAndUpdate(
      facilityId,
      { $set: { convenienceFeeOverride: fee === null ? undefined : fee } }
    );
    
    return sendOk(res, {
      platformServiceFee: fee,
      message: 'Facility convenience fee updated',
    });
  }
  
  return sendOk(
    res,
    await platformFeeService.setForSuperAdmin(feeValue),
  );
});

// Calculate payment summary values from existing appointment records.
export const getPaymentsSummary = asyncHandler(async (req: AuthRequest, res) => {
  const { from, to, facilityId, paymentStatus } = req.query;
  return sendOk(
    res,
    await appointmentService.getPaymentsSummary({
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      facilityId: facilityId ? String(facilityId) : undefined,
      paymentStatus: parsePaymentStatus(paymentStatus),
    })
  );
});

// Generate monthly payment totals for the Super Admin report.
export const getPaymentsMonthlyReport = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await appointmentService.getPaymentsMonthlyReport()
  );
});

export const listPayments = asyncHandler(async (req: AuthRequest, res) => {
  const { from, to, facilityId, paymentStatus } = req.query;
  return sendOk(
    res,
    await appointmentService.listPayments({
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      facilityId: facilityId ? String(facilityId) : undefined,
      paymentStatus: parsePaymentStatus(paymentStatus),
    }),
  );
});

export const exportPaymentsCsv = asyncHandler(async (req: AuthRequest, res) => {
  const { from, to, facilityId, paymentStatus } = req.query;
  const csv = await appointmentService.buildPaymentsCsv({
    from: from ? String(from) : undefined,
    to: to ? String(to) : undefined,
    facilityId: facilityId ? String(facilityId) : undefined,
    paymentStatus: parsePaymentStatus(paymentStatus),
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aarohcare-payments.csv"');
  return res.send(csv);
});

// ── Ads ─────────────────────────────────────────────────────────────────────

export const listAds = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, await adService.list());
});

export const getAd = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await adService.requireById(String(req.params.id)));
});

export const createAd = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(res, await adService.createForSuperAdmin(req.body ?? {}));
});

export const updateAd = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await adService.updateForSuperAdmin(
      String(req.params.id),
      (req.body ?? {}) as Record<string, unknown>,
    ),
  );
});

export const deleteAd = asyncHandler(async (req: AuthRequest, res) => {
  return sendMessage(res, await adService.deleteForSuperAdmin(String(req.params.id)));
});

export const reorderAds = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await adService.reorderForSuperAdmin(req.body?.order));
});

// ── Lab reports ─────────────────────────────────────────────────────────────

export const listLabReports = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.list({
      facilityId: req.query.facilityId ? String(req.query.facilityId) : undefined,
      patientId: req.query.patientId ? String(req.query.patientId) : undefined,
    }),
  );
});

export const deleteLabReport = asyncHandler(async (req: AuthRequest, res) => {
  return sendMessage(
    res,
    await labReportService.deleteForSuperAdmin(String(req.params.id)),
  );
});

// ── Emergency ───────────────────────────────────────────────────────────────

export const listEmergencyTickets = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await emergencyTicketService.list(String(req.query.status || '')),
  );
});

export const createEmergencyTicket = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(
    res,
    await emergencyTicketService.createForSuperAdmin(req.user!.id, req.body ?? {}),
  );
});

export const replyEmergencyTicket = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await emergencyTicketService.replyForSuperAdmin(
      String(req.params.id),
      req.body?.body,
      req.user!.id,
    ),
  );
});

export const resolveEmergencyTicket = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await emergencyTicketService.resolveForSuperAdmin(String(req.params.id)),
  );
});

export const dashboardStats = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, await superAdminDashboardService.getStats());
});

export const dashboardAnalytics = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await superAdminDashboardService.getAnalytics(req.query.days));
});
