import mongoose from 'mongoose';
import Doctor from '../models/Doctor';
import Schedule from '../models/Schedule';
import { AppointmentStatus } from '../constants/enums';
import { MSG } from '../constants/messages';
import type { IDoctor } from '../types';
import { AppError } from '../utils/AppError';
import { getNowInAppTz, validateScheduleAgainstNow } from '../utils/dateTime';
import { nextOpNumber } from '../utils/tokenUtils';
import { buildSlots } from '../utils/scheduleUtils';

export const doctorService = {
  /** All active doctors — used by the patient app. */
  getAllActive: async () =>
    Doctor.find({ isActive: true })
      .populate('facilityId', 'name phone place address facilityType image')
      .sort({ name: 1 }),

  /** Doctors that belong to one facility admin. */
  getByAdmin: async (adminId: string) => Doctor.find({ adminId }).sort({ name: 1 }),

  /** Get distinct specializations list for dropdowns. */
  getSpecializations: async () => {
    const list = await Doctor.distinct('specialization', {
      isActive: true,
      specialization: { $exists: true, $ne: '' },
    });
    return list.filter(Boolean).sort();
  },

  findById: async (doctorId: string) => Doctor.findById(doctorId),

  create: async (data: {
    name: string;
    specialization?: string;
    phone?: string;
    email?: string;
    qualifications?: string;
    consultationFee?: number;
    place?: string;
    profileImage?: string;
    adminId: string;
    facilityId?: string;
    bankAccountDetails?: {
      accountNumber?: string;
      ifscCode?: string;
      bankName?: string;
      accountHolderName?: string;
      upiId?: string;
    };
  }) => Doctor.create(data),

  /** Create doctor after validating name + facility ownership. */
  createDoctorForAdmin: async (
    adminId: string,
    body: {
      name?: unknown;
      specialization?: string;
      phone?: string;
      email?: string;
      qualifications?: string;
      consultationFee?: number;
      place?: string;
      profileImage?: string;
      bankAccountDetails?: {
        accountNumber?: string;
        ifscCode?: string;
        bankName?: string;
        accountHolderName?: string;
        upiId?: string;
      };
    },
  ) => {
    const { name, specialization, phone, email, qualifications, consultationFee, place, profileImage, bankAccountDetails } =
      body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw AppError.badRequest('Doctor name is required.');
    }
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      throw AppError.badRequest('Doctor name must be at least 2 characters.');
    }
    if (cleanName.length > 40) {
      throw AppError.badRequest('Doctor name cannot exceed 40 characters.');
    }
    // Restrict doctor names to professional alphabetic names and prevent numeric-only input.
    if (!/^[A-Za-z\s.'-]+$/.test(cleanName) || !/[A-Za-z]/.test(cleanName)) {
      throw AppError.badRequest('Enter a valid doctor name using letters only.');
    }

    if (!specialization || typeof specialization !== 'string' || !specialization.trim()) {
      throw AppError.badRequest('Specialization is required');
    }

    if (!phone) {
      throw AppError.badRequest('Contact number is required');
    }
    
    // Validate phone number to strictly be exactly 10 digits
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      throw AppError.badRequest('Contact number must be exactly 10 digits');
    }

    if (email && typeof email === 'string' && email.trim()) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        throw AppError.badRequest('Please enter a valid email address');
      }
    }

    const { facilityService } = await import('./facilityService');
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) {
      throw AppError.badRequest(MSG.FACILITY_BEFORE_DOCTORS);
    }

    if (bankAccountDetails?.ifscCode) {
      if (bankAccountDetails.ifscCode.trim().length !== 11) {
        throw AppError.badRequest('IFSC code must be exactly 11 characters');
      }
    }

    await facilityService.assertApprovedForOwner(adminId);

    if (consultationFee === undefined || consultationFee === null || isNaN(Number(consultationFee)) || String(consultationFee).trim() === '') {
      throw AppError.badRequest('Consultation fee is required.');
    }
    const parsedFee = Number(consultationFee);
    if (parsedFee < 0 || !/^\d*\.?\d{0,2}$/.test(String(consultationFee).trim())) {
      throw AppError.badRequest('Enter a valid consultation fee with up to 2 decimal places.');
    }

    return doctorService.create({
      name: name.trim(),
      specialization: specialization.trim(),
      phone: cleanPhone,
      email: email ? String(email).trim() : undefined,
      qualifications,
      consultationFee: parsedFee,
      place,
      profileImage,
      bankAccountDetails,
      adminId,
      facilityId: String(facility._id),
    });
  },

  updateOwn: async (doctorId: string, adminId: string, data: Partial<IDoctor>) =>
    Doctor.findOneAndUpdate({ _id: doctorId, adminId }, data, { new: true }),

  removeOwn: async (doctorId: string, adminId: string) =>
    Doctor.findOneAndDelete({ _id: doctorId, adminId }),

  requireOwnedDoctor: async (doctorId: string, adminId: string) => {
    const doctor = await doctorService.findById(doctorId);
    if (!doctor || String(doctor.adminId) !== adminId) {
      throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
    }
    return doctor;
  },

  getSchedule: async (doctorId: string, date: string) =>
    Schedule.findOne({ doctorId, date }).lean(),

  /** Patient/admin schedule payload including the OP number a new booking would get. */
  getScheduleWithNextToken: async (doctorId: string, date: string) => {
    const schedule = await doctorService.getSchedule(doctorId, date);
    if (!schedule) return null;
    const nextTokenNumber = await nextOpNumber(doctorId, date);
    const obj = typeof schedule.toObject === 'function' ? (schedule as any).toObject() : schedule;
    const startTime = typeof obj.startTime === 'string' ? obj.startTime : undefined;
    const endTime = typeof obj.endTime === 'string' ? obj.endTime : undefined;
    const todayStr = getNowInAppTz().date;
    return {
      ...obj,
      isToday: String(obj.date) === todayStr,
      timeRange: startTime && endTime ? `${startTime} - ${endTime}` : undefined,
      nextTokenNumber,
    };
  },

  listSchedules: async (doctorId: string, fromDate?: string, toDate?: string) => {
    const filter: Record<string, unknown> = { doctorId };
    if (fromDate || toDate) {
      const dateFilter: Record<string, string> = {};
      if (fromDate) dateFilter.$gte = fromDate;
      if (toDate) dateFilter.$lte = toDate;
      filter.date = dateFilter;
    }
    return Schedule.find(filter).sort({ date: 1 }).lean();
  },

  listDoctorSchedulesForAdmin: async (
    doctorId: string,
    adminId: string,
    fromQuery?: string,
    toQuery?: string,
  ) => {
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      throw AppError.badRequest(MSG.DOCTOR_NOT_FOUND);
    }
    await doctorService.requireOwnedDoctor(doctorId, adminId);
    const fromDate = typeof fromQuery === 'string' && fromQuery ? fromQuery : undefined;
    const toDate = typeof toQuery === 'string' && toQuery ? toQuery : undefined;
    const schedules = await doctorService.listSchedules(doctorId, fromDate, toDate);
    const todayStr = getNowInAppTz().date;
    return schedules.map((s: any) => {
      const obj = typeof s.toObject === 'function' ? s.toObject() : s;
      const startTime = typeof obj.startTime === 'string' ? obj.startTime : undefined;
      const endTime = typeof obj.endTime === 'string' ? obj.endTime : undefined;
      return {
        ...obj,
        doctorId: String(doctorId),
        isToday: String(obj.date) === todayStr,
        timeRange: startTime && endTime ? `${startTime} - ${endTime}` : undefined,
      };
    });
  },

  createSchedule: async (data: Record<string, unknown>) => Schedule.create(data),

  createScheduleForAdmin: async (
    adminId: string,
    body: {
      doctorId?: unknown;
      date?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      intervalMinutes?: unknown;
      maxTokens?: unknown;
    },
  ) => {
    const { doctorId, date, startTime, endTime, intervalMinutes = 30, maxTokens } = body;
    if (!doctorId || !date || !startTime || !endTime) {
      throw AppError.badRequest(MSG.MISSING_SCHEDULE_FIELDS);
    }

    if (String(startTime) >= String(endTime)) {
      throw AppError.badRequest(MSG.END_AFTER_START);
    }

    const scheduleTimeError = validateScheduleAgainstNow(String(date), String(startTime));
    if (scheduleTimeError) {
      throw AppError.badRequest(scheduleTimeError);
    }

    await doctorService.requireOwnedDoctor(String(doctorId), adminId);

    const existing = await Schedule.findOne({
      doctorId: String(doctorId),
      date: String(date),
    });

    const slots = buildSlots(String(startTime), String(endTime), Number(intervalMinutes) || 30);
    if (slots.length === 0) {
      throw AppError.badRequest(MSG.NO_SLOTS);
    }

    if (existing) {
      const bookedSlots = new Set(existing.slots.filter((s) => s.isBooked).map((s) => s.time));
      slots.forEach((s) => {
        if (bookedSlots.has(s.time)) {
          s.isBooked = true;
        }
      });

      existing.startTime = String(startTime);
      existing.endTime = String(endTime);
      existing.slots = slots;
      existing.maxTokens = maxTokens ? Number(maxTokens) : undefined;
      existing.isClosed = false;
      await existing.save();
      return existing;
    }

    try {
      return await doctorService.createSchedule({
        doctorId,
        date,
        startTime,
        endTime,
        slots,
        maxTokens: maxTokens ? Number(maxTokens) : undefined,
        isClosed: false,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('E11000')) {
        throw AppError.badRequest(MSG.SCHEDULE_EXISTS);
      }
      throw error;
    }
  },

  bulkCreateScheduleForAdmin: async (
    adminId: string,
    body: {
      doctorId?: unknown;
      dates?: unknown;
      date?: unknown;
      startTime?: unknown;
      endTime?: unknown;
      intervalMinutes?: unknown;
      maxTokens?: unknown;
    },
  ) => {
    const { doctorId, startTime, endTime, intervalMinutes = 30, maxTokens } = body;
    const rawDates = Array.isArray(body.dates) ? body.dates : body.date ? [body.date] : [];
    const dates = rawDates.map(String).filter(Boolean);

    if (!doctorId || dates.length === 0 || !startTime || !endTime) {
      throw AppError.badRequest(MSG.MISSING_SCHEDULE_FIELDS);
    }

    if (String(startTime) >= String(endTime)) {
      throw AppError.badRequest(MSG.END_AFTER_START);
    }

    await doctorService.requireOwnedDoctor(String(doctorId), adminId);

    const slots = buildSlots(String(startTime), String(endTime), Number(intervalMinutes) || 30);
    if (slots.length === 0) {
      throw AppError.badRequest(MSG.NO_SLOTS);
    }

    const calculatedMaxTokens = maxTokens ? Number(maxTokens) : undefined;
    const docObjectId = new mongoose.Types.ObjectId(String(doctorId));

    const bulkOps = dates.map((dateStr) => ({
      updateOne: {
        filter: { doctorId: docObjectId, date: dateStr },
        update: {
          $setOnInsert: {
            doctorId: docObjectId,
            date: dateStr,
            startTime: String(startTime),
            endTime: String(endTime),
            slots,
            maxTokens: calculatedMaxTokens,
            isClosed: false,
          },
        },
        upsert: true,
      },
    }));

    await Schedule.bulkWrite(bulkOps as any);
    return Schedule.find({ doctorId: docObjectId, date: { $in: dates } });
  },

  /** Free a slot when an appointment is cancelled. */
  releaseSlot: async (doctorId: string, date: string, time: string) => {
    const schedule = await Schedule.findOne({ doctorId, date });
    if (!schedule) return null;
    const slot = schedule.slots.find((s) => s.time === time);
    if (slot) {
      slot.isBooked = false;
      await schedule.save();
    }
    return schedule;
  },

  /** Active doctors belonging to one facility (patient browsing). */
  getActiveByFacility: async (facilityId: string) =>
    Doctor.find({ facilityId, isActive: true })
      .populate('facilityId', 'name phone place address facilityType image')
      .sort({ name: 1 }),

  setScheduleClosed: async (doctorId: string, date: string, isClosed: boolean) => {
    const schedule = await Schedule.findOneAndUpdate({ doctorId, date }, { isClosed }, { new: true, upsert: true });
    // When schedule is closed, automatically cancel pending appointments where patient never arrived
    if (isClosed) {
      const { appointmentService } = await import('./appointmentService');
      await appointmentService.checkAndCancelUnmarkedAppointments(doctorId, date);
    }
    return schedule;
  },

  setScheduleClosedForAdmin: async (
    doctorId: string,
    date: string,
    adminId: string,
    isClosed: unknown,
  ) => {
    if (typeof isClosed !== 'boolean') {
      throw AppError.badRequest(MSG.ISCLOSED_REQUIRED);
    }

    await doctorService.requireOwnedDoctor(doctorId, adminId);

    const schedule = await doctorService.setScheduleClosed(doctorId, date, isClosed);
    if (!schedule) {
      throw AppError.notFound(MSG.SCHEDULE_NOT_FOUND);
    }

    // If schedule is closed, automatically cancel any appointments whose arrival was never marked
    if (isClosed === true) {
      const { appointmentService } = await import('./appointmentService');
      await appointmentService.checkAndCancelUnmarkedAppointments(doctorId, date, adminId);
    }

    // Synchronize queue and schedule status in real time across Admin, Super Admin, and Mobile App
    void emitSafeQueueUpdate(doctorId, date, adminId);

    return schedule;
  },

  /** Active doctors owned by an admin (admin live OP tools). */
  getActiveByAdmin: async (adminId: string) =>
    Doctor.find({ adminId, isActive: true }).sort({ name: 1 }),

  getLiveQueueForAdmin: async (doctorId: string, adminId: string, dateQuery?: string) => {
    const date =
      typeof dateQuery === 'string' && dateQuery ? dateQuery : getNowInAppTz().date;

    const doctor = await doctorService.requireOwnedDoctor(doctorId, adminId);
    const schedule = await doctorService.getSchedule(doctorId, date);

    const { appointmentService } = await import('./appointmentService');
    const appointments = await appointmentService.getByDoctorAndDate(doctorId, date);
    const liveNumber =
      doctor.liveOp?.date === date ? Number(doctor.liveOp.currentNumber || 0) : 0;

    const startTime = schedule?.startTime;
    const endTime = schedule?.endTime;

    return {
      doctor,
      date,
      startTime,
      endTime,
      timeRange: startTime && endTime ? `${startTime} - ${endTime}` : undefined,
      isClosed: Boolean(schedule?.isClosed),
      bookingStatus: schedule?.isClosed ? 'CLOSED' : 'ACTIVE',
      liveOpNumber: liveNumber,
      appointments,
    };
  },

  updateLiveOpForAdmin: async (
    doctorId: string,
    adminId: string,
    body: {
      date?: string;
      currentNumber?: number;
      action?: 'next' | 'previous' | 'break' | 'resume';
      advance?: boolean;
    },
  ) => {
    const day = body.date || getNowInAppTz().date;
    const resolvedAction = body.action || (body.advance ? 'next' : undefined);

    await doctorService.requireOwnedDoctor(doctorId, adminId);

    const schedule = await doctorService.getSchedule(doctorId, day);
    if (!schedule) {
      throw AppError.badRequest(MSG.NO_SCHEDULE_LIVE_OP);
    }
    // Closing booking stops new bookings only — live OP can continue for remaining tokens.

    const doctor = resolvedAction
      ? await doctorService.applyLiveOpAction(doctorId, adminId, day, resolvedAction)
      : await doctorService.setLiveOp(
          doctorId,
          adminId,
          day,
          Number(body.currentNumber ?? 0),
        );

    if (!doctor) {
      throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
    }

    return doctor;
  },

  getLiveOverviewForAdmin: async (adminId: string, dateQuery?: string) => {
    const date =
      typeof dateQuery === 'string' && dateQuery ? dateQuery : getNowInAppTz().date;

    const doctors = await doctorService.getActiveByAdmin(adminId);
    const { appointmentService } = await import('./appointmentService');

    const board = (
      await Promise.all(
        doctors.map(async (doctor) => {
          const schedule = await doctorService.getSchedule(String(doctor._id), date);
          if (!schedule) return null;

          const allAppointments = await appointmentService.getAllByDoctorAndDate(
            String(doctor._id),
            date,
          );
          const appointments = allAppointments.filter(
            (appt) => appt.status !== AppointmentStatus.CANCELLED,
          );

          if (schedule.isClosed && appointments.length === 0) return null;
          const sameDay = doctor.liveOp?.date === date;
          const liveOpNumber = sameDay ? Number(doctor.liveOp?.currentNumber || 0) : 0;
          const onBreak = sameDay ? Boolean(doctor.liveOp?.onBreak) : false;

          const board = appointmentService.partitionLiveBoard(appointments, liveOpNumber);
          const onlineCount = appointments.filter((appt) => appt.time !== 'QUEUE').length;
          const offlineCount = appointments.filter((appt) => appt.time === 'QUEUE').length;
          const cancelledCount = allAppointments.filter(
            (appt) => appt.status === AppointmentStatus.CANCELLED,
          ).length;

          const bookingStatus = schedule.isClosed
            ? 'CLOSED'
            : onBreak
            ? 'ON_BREAK'
            : 'ACTIVE';

          const startTime = schedule.startTime;
          const endTime = schedule.endTime;

          return {
            doctor,
            date,
            startTime,
            endTime,
            timeRange: startTime && endTime ? `${startTime} - ${endTime}` : undefined,
            liveOpNumber,
            onBreak,
            isClosed: Boolean(schedule.isClosed),
            bookingStatus,
            totalBooked: appointments.length,
            onlineCount,
            offlineCount,
            cancelledCount,
            waitingCount: board.waitingCount,
            current: board.current,
            queue: board.queue,
            waiting: board.waiting,
            upcoming: board.upcoming,
            served: board.served,
          };
        }),
      )
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    return board;
  },

  setLiveOp: async (doctorId: string, adminId: string, date: string, currentNumber: number) => {
    const existing = await Doctor.findOne({ _id: doctorId, adminId });
    const prevCurrent = existing?.liveOp?.date === date ? Number(existing?.liveOp?.currentNumber || 0) : 0;
    const doctor = await Doctor.findOneAndUpdate(
      { _id: doctorId, adminId },
      { liveOp: { date, currentNumber, onBreak: false } },
      { new: true },
    );
    if (doctor) {
      const { appointmentService } = await import('./appointmentService');
      // If moving backwards, revert appointments that were prematurely moved to COMPLETED
      if (currentNumber < prevCurrent) {
        await appointmentService.revertPassedAppointments(doctorId, date, currentNumber);
      } else if (currentNumber > prevCurrent) {
        await appointmentService.completePassedArrived(doctorId, date, currentNumber);
        await appointmentService.checkAndCancelUnmarkedAppointments(doctorId, date, adminId);
      }
      await appointmentService.syncStatusesFromLiveOp(doctorId, date, currentNumber);
      
      // Emit a targeted queue update after the database state is fully synchronized
      // so patients receive the latest OP state without waiting for polling.
      void emitSafeQueueUpdate(doctorId, date, adminId);
    }
    return doctor;
  },

  /** Apply a live OP action: next, previous, break, or resume. */
  applyLiveOpAction: async (
    doctorId: string,
    adminId: string,
    date: string,
    action: 'next' | 'previous' | 'break' | 'resume',
  ) => {
    const doctor = await Doctor.findOne({ _id: doctorId, adminId });
    if (!doctor) return null;
    return doctorService.applyLiveOpToDoctor(doctor, date, action);
  },

  /** Super Admin: live OP without facility-admin ownership check. */
  applyLiveOpForSuperAdmin: async (
    facilityId: string,
    doctorId: string,
    body: {
      date?: string;
      action?: 'next' | 'previous' | 'break' | 'resume';
      currentNumber?: number;
    },
  ) => {
    const day = body.date || getNowInAppTz().date;
    const doctor = await Doctor.findById(doctorId);
    if (!doctor || String(doctor.facilityId) !== String(facilityId)) {
      throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
    }

    const schedule = await doctorService.getSchedule(doctorId, day);
    if (!schedule) {
      throw AppError.badRequest(MSG.NO_SCHEDULE_LIVE_OP);
    }
    // Closing booking stops new bookings only — live OP can continue for remaining tokens.

    if (body.action) {
      return doctorService.applyLiveOpToDoctor(doctor, day, body.action);
    }

    const prevCurrent = doctor.liveOp?.date === day ? Number(doctor.liveOp?.currentNumber || 0) : 0;
    const currentNumber = Number(body.currentNumber ?? 0);
    doctor.liveOp = { date: day, currentNumber, onBreak: false };
    await doctor.save();
    const { appointmentService } = await import('./appointmentService');
    if (currentNumber < prevCurrent) {
      await appointmentService.revertPassedAppointments(doctorId, day, currentNumber);
    } else if (currentNumber > prevCurrent) {
      await appointmentService.completePassedArrived(doctorId, day, currentNumber);
      await appointmentService.checkAndCancelUnmarkedAppointments(doctorId, day, String(doctor.adminId));
    }
    await appointmentService.syncStatusesFromLiveOp(doctorId, day, currentNumber);
    
    // Emit a targeted queue update after the database state is fully synchronized
    // so patients receive the latest OP state without waiting for polling.
    void emitSafeQueueUpdate(doctorId, day, String(doctor.adminId));
    
    return doctor;
  },

  applyLiveOpToDoctor: async (
    doctor: {
      _id: unknown;
      adminId?: unknown;
      liveOp?: { date?: string; currentNumber?: number; onBreak?: boolean };
      save: () => Promise<unknown>;
    },
    date: string,
    action: 'next' | 'previous' | 'break' | 'resume',
  ) => {
    const sameDay = doctor.liveOp?.date === date;
    const current = sameDay ? Number(doctor.liveOp?.currentNumber || 0) : 0;
    const onBreak = sameDay ? Boolean(doctor.liveOp?.onBreak) : false;

    if (action === 'next') {
      doctor.liveOp = { date, currentNumber: current + 1, onBreak: false };
    } else if (action === 'previous') {
      doctor.liveOp = { date, currentNumber: Math.max(0, current - 1), onBreak };
    } else if (action === 'break') {
      doctor.liveOp = { date, currentNumber: current, onBreak: true };
    } else {
      doctor.liveOp = { date, currentNumber: current, onBreak: false };
    }

    await doctor.save();

    const { appointmentService } = await import('./appointmentService');
    const liveNumber = Number(doctor.liveOp?.currentNumber || 0);
    if (action === 'next') {
      await appointmentService.completePassedArrived(String(doctor._id), date, liveNumber);
      await appointmentService.checkAndCancelUnmarkedAppointments(
        String(doctor._id),
        date,
        doctor.adminId ? String(doctor.adminId) : undefined,
      );
    } else if (action === 'previous') {
      // Revert appointments that were moved to COMPLETED or cancelled on accidental Next navigation
      await appointmentService.revertPassedAppointments(String(doctor._id), date, liveNumber);
    }
    await appointmentService.syncStatusesFromLiveOp(
      String(doctor._id),
      date,
      liveNumber,
    );

    // Emit a targeted queue update after the database state is fully synchronized
    // so patients receive the latest OP state without waiting for polling.
    void emitSafeQueueUpdate(String(doctor._id), date, doctor.adminId ? String(doctor.adminId) : undefined);

    return doctor;
  },

  movePendingOpsForAdmin: async (
    fromDoctorId: string,
    adminId: string,
    body: {
      date?: string;
      toDoctorId?: string;
      fromOp?: number;
      toOp?: number;
      closeSource?: boolean;
    },
  ) => {
    const date = typeof body.date === 'string' && body.date ? body.date : getNowInAppTz().date;
    const toDoctorId = String(body.toDoctorId || '').trim();
    if (!toDoctorId) throw AppError.badRequest(MSG.MOVE_OP_TARGET_REQUIRED);

    const { appointmentService } = await import('./appointmentService');
    return appointmentService.movePendingOps({
      fromDoctorId,
      toDoctorId,
      date,
      fromOp: Number(body.fromOp),
      toOp: Number(body.toOp),
      adminId,
      closeSource: body.closeSource !== false,
    });
  },

  // Export emitSafeQueueUpdate so appointment cancellation can trigger real-time queue updates for both online and offline bookings.
  emitSafeQueueUpdate: async (doctorId: string, date: string, adminId?: string) =>
    emitSafeQueueUpdate(doctorId, date, adminId),
};

const emitSafeQueueUpdate = async (doctorId: string, date: string, adminId?: string) => {
  try {
    const { appointmentService } = await import('./appointmentService');
    const { emitToUser, emitToSuperAdmins, SOCKET_EVENTS } = await import('../realtime/socket');

    if (adminId) {
      emitToUser(adminId, SOCKET_EVENTS.QUEUE_UPDATED, { doctorId });
    }
    // Also notify Super Admins watching live OP board in real-time
    emitToSuperAdmins(SOCKET_EVENTS.QUEUE_UPDATED, { doctorId });

    const appointments = await appointmentService.getByDoctorAndDate(doctorId, date);
    const patientIds = new Set(
      appointments
        .map((a: any) => String(a.patientId?._id || a.patientId))
        .filter((id) => id && id !== 'undefined' && id !== 'null')
    );

    for (const pid of patientIds) {
      emitToUser(pid, SOCKET_EVENTS.QUEUE_UPDATED, { doctorId });
    }
  } catch (err) {
    const { logger } = await import('../utils/logger');
    logger.error('Failed to emit queue update', err);
  }
};
