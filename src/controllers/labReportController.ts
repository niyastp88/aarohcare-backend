import type { AuthRequest } from '../middleware/authMiddleware';
import { labReportService } from '../services/labReportService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendOk } from '../utils/apiResponse';

export const listMyLabReports = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.listForFacilityAdmin(req.user!.id, {
      patientId: typeof req.query.patientId === 'string' ? req.query.patientId : undefined,
      fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined,
      toDate: typeof req.query.toDate === 'string' ? req.query.toDate : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
    }),
  );
});

export const labReportStats = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await labReportService.statsForFacilityAdmin(req.user!.id));
});

export const listLabReportPatients = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.listPatientsForFacilityAdmin(req.user!.id, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : undefined,
      toDate: typeof req.query.toDate === 'string' ? req.query.toDate : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }),
  );
});

export const createLabReport = asyncHandler(async (req: AuthRequest, res) => {
  return sendCreated(
    res,
    await labReportService.createForFacilityAdmin(req.user!.id, req.body ?? {}),
  );
});

/** Patient app — reports shared to this user by facility labs. */
export const listPatientLabReports = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(res, await labReportService.listForPatient(req.user!.id));
});

/** Patient app — nudge lab admin to upload a pending report. */
export const remindLabReport = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.remindLabAdmin(req.user!.id, req.body?.facilityId),
  );
});

/** Lab admin finds a patient by phone to open their report page. */
export const lookupLabPatientByPhone = asyncHandler(async (req: AuthRequest, res) => {
  const queryParam =
    typeof req.query.query === 'string'
      ? req.query.query
      : typeof req.query.search === 'string'
        ? req.query.search
        : typeof req.query.phone === 'string'
          ? req.query.phone
          : undefined;

  if (queryParam !== undefined) {
    return sendOk(
      res,
      await labReportService.searchPatientsForFacilityAdmin(req.user!.id, queryParam),
    );
  }

  const phone =
    typeof req.body?.phone === 'string'
      ? req.body.phone
      : typeof req.query.phone === 'string'
        ? req.query.phone
        : '';
  return sendOk(
    res,
    await labReportService.lookupPatientByPhoneForFacilityAdmin(req.user!.id, phone),
  );
});

export const getLabPatient = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.getPatientForFacilityAdmin(req.user!.id, String(req.params.patientId)),
  );
});

/** Lab admin deletes one of their own facility's reports. */
export const deleteLabReport = asyncHandler(async (req: AuthRequest, res) => {
  return sendOk(
    res,
    await labReportService.deleteForFacilityAdmin(req.user!.id, String(req.params.id)),
  );
});
