import type { AuthRequest } from '../middleware/authMiddleware';
import { doctorService } from '../services/doctorService';
import { UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated, sendMessage, sendOk } from '../utils/apiResponse';

export const getSpecializations = asyncHandler(async (_req: AuthRequest, res) => {
  return sendOk(res, await doctorService.getSpecializations());
});

/** ADMIN sees their own doctors; patients see active doctors (optionally by facility). */
export const getDoctors = asyncHandler(async (req: AuthRequest, res) => {
  if (req.user?.role === UserRole.ADMIN) {
    return sendOk(res, await doctorService.getByAdmin(req.user.id));
  }

  if (req.user?.role === UserRole.SUPER_ADMIN) {
    throw AppError.forbidden(MSG.NOT_ALLOWED);
  }

  const facilityId =
    typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
  const doctors = facilityId
    ? await doctorService.getActiveByFacility(facilityId)
    : await doctorService.getAllActive();
  return sendOk(res, doctors);
});

export const createDoctor = asyncHandler(async (req: AuthRequest, res) => {
  const doctor = await doctorService.createDoctorForAdmin(req.user!.id, req.body);
  return sendCreated(res, doctor);
});

export const updateDoctor = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const { name, specialization, phone, email, qualifications, consultationFee, place, profileImage, isActive } =
    req.body;

  const doctor = await doctorService.updateOwn(String(doctorId), req.user!.id, {
    name,
    specialization,
    phone,
    email,
    qualifications,
    consultationFee,
    place,
    profileImage,
    isActive,
  });

  if (!doctor) throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
  return sendOk(res, doctor);
});

export const deleteDoctor = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const doctor = await doctorService.removeOwn(String(doctorId), req.user!.id);
  if (!doctor) throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
  return sendMessage(res, MSG.DOCTOR_REMOVED);
});

export const getDoctorSchedule = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId, date } = req.params;
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  return sendOk(
    res,
    await doctorService.getScheduleWithNextToken(String(doctorId), String(date)),
  );
});

/** Admin lists upcoming schedules for one of their doctors. */
export const listDoctorSchedules = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  return sendOk(
    res,
    await doctorService.listDoctorSchedulesForAdmin(String(doctorId), req.user!.id, from, to),
  );
});

/** Admin creates a schedule for one of their doctors. */
export const createSchedule = asyncHandler(async (req: AuthRequest, res) => {
  const schedule = await doctorService.createScheduleForAdmin(req.user!.id, req.body);
  return sendCreated(res, schedule);
});

/** Admin creates/saves schedules in bulk for multiple dates. */
export const bulkCreateSchedule = asyncHandler(async (req: AuthRequest, res) => {
  const schedules = await doctorService.bulkCreateScheduleForAdmin(req.user!.id, req.body);
  return sendCreated(res, schedules);
});

/** Admin closes or reopens OP for one doctor's schedule day (existing bookings stay). */
export const setScheduleClosed = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId, date } = req.params;
  const schedule = await doctorService.setScheduleClosedForAdmin(
    String(doctorId),
    String(date),
    req.user!.id,
    (req.body as { isClosed?: boolean }).isClosed,
  );
  return sendOk(res, schedule);
});

/** Admin live OP queue for one doctor on a date. */
export const getLiveQueue = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  return sendOk(
    res,
    await doctorService.getLiveQueueForAdmin(String(doctorId), req.user!.id, date),
  );
});

/** Admin sets or acts on the live OP counter (next / previous / break / resume). */
export const updateLiveOp = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const doctor = await doctorService.updateLiveOpForAdmin(
    String(doctorId),
    req.user!.id,
    req.body as {
      date?: string;
      currentNumber?: number;
      action?: 'next' | 'previous' | 'break' | 'resume';
      advance?: boolean;
    },
  );
  return sendOk(res, doctor);
});

/** All active doctors with an open schedule for the day — live OP board. */
export const getLiveOverview = asyncHandler(async (req: AuthRequest, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  return sendOk(res, await doctorService.getLiveOverviewForAdmin(req.user!.id, date));
});

/** Move a pending OP range to another doctor, then optionally close source booking. */
export const movePendingOps = asyncHandler(async (req: AuthRequest, res) => {
  const { doctorId } = req.params;
  const body = req.body as {
    date?: string;
    toDoctorId?: string;
    fromOp?: number;
    toOp?: number;
    closeSource?: boolean;
  };
  return sendOk(
    res,
    await doctorService.movePendingOpsForAdmin(String(doctorId), req.user!.id, body),
  );
});
