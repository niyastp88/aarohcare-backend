import mongoose from 'mongoose';
import Appointment from '../models/Appointment';
// Ensure nested populate models are registered before appointment queries run.
import '../models/Doctor';
import '../models/Facility';
import '../models/User';
import Doctor from '../models/Doctor';
import Schedule from '../models/Schedule';
import { AppointmentStatus, PaymentStatus, UserRole, NotificationType } from '../constants/enums';
import type { ICancellationPolicy } from '../types';

import {
  MSG,
  formatAppointmentAlready,
  formatOpAlreadyBooked,
  formatOpNotUpcoming,
} from '../constants/messages';
import { AppError } from '../utils/AppError';
import { getNowInAppTz } from '../utils/dateTime';
import { isOpNumberTaken, nextOpNumber } from '../utils/tokenUtils';
import User from '../models/User';
import { platformFeeService } from './platformFeeService';
import { razorpayService } from './razorpayService';
import { cashfreeService } from './cashfreeService';
import Facility from '../models/Facility';
import DoctorWalletTransaction from '../models/DoctorWalletTransaction';
import AdminBillingTransaction from '../models/AdminBillingTransaction';
import { whatsappService } from './whatsappService';
import { notificationService } from './notificationService';
import { logger } from '../utils/logger';

/** Max active OP bookings a patient can hold on the same calendar day. */
export const MAX_BOOKINGS_PER_PATIENT_PER_DAY = 50;

const ADMIN_STATUS_ACTIONS = new Set([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
]);

const getWindowMs = (value = 30, unit: string = 'minutes'): number => {
  const safeVal = Math.max(1, Number(value) || 30);
  switch (unit) {
    case 'hours':
      return safeVal * 60 * 60 * 1000;
    case 'days':
      return safeVal * 24 * 60 * 60 * 1000;
    case 'minutes':
    default:
      return safeVal * 60 * 1000;
  }
};

/** Compute OP refund based on Admin-configured facility cancellation policy. */
export const calculateSlidingRefundPolicy = (
  consultationFee: number | undefined,
  bookedAt?: Date | string,
  requestedAt: Date = new Date(),
  policy?: ICancellationPolicy,
) => {
  const fee = Math.max(0, Number(consultationFee) || 0);
  const bookedMs = bookedAt ? new Date(bookedAt).getTime() : NaN;
  const elapsedMs = Number.isFinite(bookedMs) ? Math.max(0, requestedAt.getTime() - bookedMs) : 0;

  const fullWindowMs = getWindowMs(
    policy?.fullRefundWindow?.value ?? 30,
    policy?.fullRefundWindow?.unit ?? 'minutes',
  );
  const afterPercent =
    typeof policy?.afterPeriodRefundPercent === 'number'
      ? Math.max(0, Math.min(100, Math.round(policy.afterPeriodRefundPercent)))
      : 90;

  const isWithinWindow = elapsedMs <= fullWindowMs;
  const percentage = isWithinWindow ? 100 : afterPercent;
  const refundPolicy = isWithinWindow
    ? 'FULL_OP_100'
    : percentage === 0
      ? 'LAPSED_0'
      : `PARTIAL_${percentage}`;

  const refundAmount = Math.round((fee * percentage) / 100);

  return {
    refundPolicy,
    percentage,
    refundAmount,
    withinWindow: isWithinWindow,
    within30Minutes: isWithinWindow,
  };
};

export const computeRefundAmount = (
  consultationFee: number | undefined,
  refundPolicy: string,
): number => {
  const fee = Math.max(0, Number(consultationFee) || 0);
  if (refundPolicy === 'FULL_OP_100') return Math.round(fee);
  if (refundPolicy === 'LAPSED_0') return 0;
  const match = refundPolicy.match(/^PARTIAL_(\d+)$/);
  if (match) {
    const pct = Number(match[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      return Math.round((fee * pct) / 100);
    }
  }
  if (refundPolicy === 'PARTIAL_90') return Math.round(fee * 0.9);
  if (refundPolicy === 'PARTIAL_75') return Math.round(fee * 0.75);
  if (refundPolicy === 'PARTIAL_50') return Math.round(fee * 0.5);
  return Math.round(fee);
};

export const buildCancellationMeta = (args: {
  cancelledBy: 'PATIENT' | 'ADMIN';
  bookedAt?: Date | string;
  refundPhone?: string;
  refundUpiId?: string;
  policyAgreedAt?: Date;
  refunded?: boolean;
  consultationFee?: number;
  policy?: ICancellationPolicy;
}) => {
  const requestedAt = new Date();
  const policyInfo = calculateSlidingRefundPolicy(
    args.consultationFee,
    args.bookedAt,
    requestedAt,
    args.policy,
  );

  return {
    requestedAt,
    cancelledBy: args.cancelledBy,
    refundPhone: args.refundPhone,
    refundUpiId: args.refundUpiId,
    policyAgreedAt: args.policyAgreedAt,
    within30Minutes: policyInfo.within30Minutes,
    refundPolicy: policyInfo.refundPolicy,
    refundAmount: policyInfo.refundAmount,
    refunded: typeof args.refunded === 'boolean' ? args.refunded : false,
  };
};

const getDoctorIdString = (doctorId: unknown): string => {
  if (!doctorId) return '';
  if (typeof doctorId === 'string') return doctorId;
  if (typeof doctorId === 'object' && doctorId !== null && '_id' in doctorId) {
    return String((doctorId as { _id: unknown })._id);
  }
  return String(doctorId);
};

/** Next without arrival → Waiting. Mark Arrived then Next → Consulted. */
const partitionOpBoard = <
  T extends {
    _id?: unknown;
    tokenNumber?: string;
    status?: string;
    arrivedAt?: Date | string | null;
  },
>(
  appointments: T[],
  liveOpNumber = 0,
) => {
  const sorted = [...appointments].sort(
    (a, b) => Number(a.tokenNumber) - Number(b.tokenNumber),
  );
  const open = sorted.filter((appt) => appt.status !== AppointmentStatus.CANCELLED);
  const current =
    liveOpNumber > 0
      ? open.find(
          (appt) =>
            Number(appt.tokenNumber) === liveOpNumber && Boolean(appt.arrivedAt),
        ) || null
      : null;
  const waiting =
    liveOpNumber > 0
      ? open.filter(
          (appt) => Number(appt.tokenNumber) <= liveOpNumber && !appt.arrivedAt,
        )
      : [];
  const served = open
    .filter((appt) => Number(appt.tokenNumber) < liveOpNumber && Boolean(appt.arrivedAt))
    .reverse();
  const queue = open.filter((appt) =>
    liveOpNumber > 0 ? Number(appt.tokenNumber) > liveOpNumber : true,
  );
  return {
    current,
    queue,
    waiting,
    upcoming: queue.slice(0, 5),
    served,
    waitingCount: waiting.length,
    activeQueueCount: queue.length + waiting.length,
    totalRemainingCount: open.filter((appt) => appt.status !== AppointmentStatus.COMPLETED).length,
  };
};

const getPatientIdString = (patientId: unknown): string => {
  if (!patientId) return '';
  if (typeof patientId === 'string') return patientId;
  if (typeof patientId === 'object' && patientId !== null && '_id' in patientId) {
    return String((patientId as { _id: unknown })._id);
  }
  return String(patientId);
};

export type PatientListParams = {
  doctorIds: mongoose.Types.ObjectId[];
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
  refundStatus?: 'pending' | 'refunded';
  bookingType?: 'online' | 'offline';
  patientType?: 'registered' | 'walkin';
  status?: string;
  dayOfWeek?: number;
};

export const appointmentService = {
  partitionLiveBoard: partitionOpBoard,

  getAll: async (filter: Record<string, unknown> = {}) =>
    Appointment.find(filter)
      .populate({
        path: 'doctorId',
        populate: [
          {
            path: 'facilityId',
            select: 'name phone place address facilityType',
          },
          {
            path: 'adminId',
            select: 'name phone place address facilityType',
          },
        ],
      })
      .populate('patientId', '-password')
      .sort({ date: -1, time: -1 }),

  findById: async (id: string) => Appointment.findById(id),

  create: async (data: Record<string, unknown>) => Appointment.create(data),

  countActiveForDoctorDate: async (doctorId: string, date: string) =>
    Appointment.countDocuments({
      doctorId,
      date,
      status: { $ne: AppointmentStatus.CANCELLED },
    }),

  /**
   * Idempotent backfill to ensure existing appointments have consultationFeeAtBooking established.
   * If an appointment already has consultationFeeAtBooking, it is untouched.
   * If not set, it reuses the appointment's established consultationFee or doctor's fee.
   */
  backfillConsultationFeeSnapshots: async (): Promise<number> => {
    try {
      const appointmentsWithoutSnapshot = await Appointment.find({
        $or: [
          { consultationFeeAtBooking: { $exists: false } },
          { consultationFeeAtBooking: null },
        ],
      }).select('_id consultationFee doctorId');

      if (appointmentsWithoutSnapshot.length === 0) return 0;

      let updatedCount = 0;
      for (const appt of appointmentsWithoutSnapshot) {
        let fee = typeof appt.consultationFee === 'number' ? appt.consultationFee : undefined;
        if (fee === undefined && appt.doctorId) {
          const doc = await Doctor.findById(appt.doctorId).select('consultationFee');
          fee = typeof doc?.consultationFee === 'number' ? doc.consultationFee : 0;
        }
        if (fee !== undefined) {
          await Appointment.updateOne(
            { _id: appt._id },
            {
              $set: {
                consultationFeeAtBooking: fee,
                ...(appt.consultationFee === undefined ? { consultationFee: fee } : {}),
              },
            },
          );
          updatedCount++;
        }
      }
      return updatedCount;
    } catch (err) {
      console.error('Error during backfillConsultationFeeSnapshots:', err);
      return 0;
    }
  },

  /**
   * Broadcasts an OP cancellation notification to all mobile app users who booked
   * an appointment with the same doctor for that OP session/date.
   *
   * Idempotent: checks cancellationNotified flag on the appointment and atomically marks it
   * to guarantee each cancelled appointment's broadcast is sent exactly once even on retries.
   */
  notifySessionUsersOnCancellation: async (
    cancelledAppointmentId: string,
    cancelledTokenNumber?: string,
    doctorName?: string,
    appointmentDate?: string,
  ): Promise<void> => {
    try {
      // Atomically check and set cancellationNotified = true to ensure exactly-once broadcast
      const appt = await Appointment.findOneAndUpdate(
        {
          _id: cancelledAppointmentId,
          $or: [
            { cancellationNotified: { $ne: true } },
            { 'cancellation.cancellationNotified': { $ne: true } },
          ],
        },
        {
          $set: {
            cancellationNotified: true,
            'cancellation.cancellationNotified': true,
          },
        },
        { new: false },
      );

      // If already notified or appointment doesn't exist, exit safely
      if (!appt) {
        return;
      }

      const docId = getDoctorIdString(appt.doctorId);
      const date = appointmentDate || appt.date;
      const rawToken = cancelledTokenNumber || appt.tokenNumber || '';
      // Format token display: if already starts with # or Token, keep clean, else format as Token #X
      const tokenDisplay = rawToken.toString().startsWith('#')
        ? `Token ${rawToken}`
        : rawToken.toString().toLowerCase().startsWith('token')
          ? rawToken
          : `Token #${rawToken}`;

      let docName = doctorName;
      if (!docName) {
        const { doctorService } = await import('./doctorService');
        const docDoc = await doctorService.findById(docId);
        docName = docDoc?.name || 'Doctor';
      }
      // Ensure doctor name format begins with Dr.
      const formattedDoctorName = docName.startsWith('Dr.') || docName.startsWith('Dr ')
        ? docName
        : `Dr. ${docName}`;

      const title = 'OP Appointment Update';
      const body = `${tokenDisplay} for ${formattedDoctorName} has been cancelled. Please check your appointment details for updates.`;

      // Find all mobile app users who booked an appointment with the same doctor for that OP session/date.
      // - Must have a genuine registered user account (patientId != null)
      // - Must not be an offline-only booking (exclude time === 'QUEUE' with no registered user)
      // - Includes appointments in pending, completed, or cancelled status for that session/date
      const sessionAppointments = await Appointment.find({
        doctorId: docId,
        date,
        patientId: { $ne: null },
      }).select('patientId time');

      // Deduplicate distinct user IDs who have booked through the mobile app for this session
      const targetUserIds = new Set<string>();
      for (const a of sessionAppointments) {
        // Exclude offline-only bookings
        if (a.time === 'QUEUE') {
          continue;
        }
        if (a.patientId) {
          const uid = String((a.patientId as any)._id || a.patientId);
          if (uid) {
            targetUserIds.add(uid);
          }
        }
      }

      // Send the notification to all eligible mobile app users for this OP session/date
      for (const userId of targetUserIds) {
        try {
          await notificationService.create({
            userId,
            title,
            body,
            type: NotificationType.SYSTEM,
            refId: String(cancelledAppointmentId),
          });
        } catch (err) {
          console.error(`Failed to send cancellation notification to user ${userId}:`, err);
        }
      }
    } catch (error) {
      console.error('Error in notifySessionUsersOnCancellation:', error);
    }
  },

  /**
   * Active/valid bookings for one patient on one calendar day towards the 2 OP limit.
   * Includes paid/refunded bookings and cancelled bookings (cancelled OP counts towards limit).
   * Excludes unpaid/abandoned/failed payment drafts.
   */
  countActiveForPatientDate: async (patientId: string, date: string) =>
    Appointment.countDocuments({
      patientId: new mongoose.Types.ObjectId(patientId),
      date,
      $or: [
        { paymentStatus: { $in: [PaymentStatus.PAID, PaymentStatus.REFUNDED] } },
        { status: AppointmentStatus.CANCELLED },
        { consultationFee: 0 },
      ],
    }),



  updateStatus: async (
    id: string,
    status: string,
    options?: {
      completedAt?: Date;
      clearCompletedAt?: boolean;
      cancelledAt?: Date;
      cancellation?: Record<string, unknown>;
    },
  ) => {
    const update: Record<string, unknown> = { status };
    if (options?.completedAt) update.completedAt = options.completedAt;
    if (options?.clearCompletedAt) update.completedAt = null;
    if (options?.cancelledAt) update.cancelledAt = options.cancelledAt;
    if (options?.cancellation) update.cancellation = options.cancellation;

    return Appointment.findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .populate('doctorId')
      .populate('patientId', '-password');
  },

  markArrived: async (
    id: string,
    options: { completeNow?: boolean; consulting?: boolean } = {},
  ) => {
    const now = new Date();
    const update: Record<string, unknown> = options.completeNow
      ? {
          arrivedAt: now,
          completedAt: now,
          status: AppointmentStatus.COMPLETED,
        }
      : {
          arrivedAt: now,
          completedAt: null,
          status: options.consulting
            ? AppointmentStatus.CONSULTING
            : AppointmentStatus.PENDING,
        };

    return Appointment.findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .populate('doctorId')
      .populate('patientId', '-password');
  },

  unmarkArrived: async (id: string) => {
    const update = {
      $set: { status: AppointmentStatus.PENDING },
      $unset: { arrivedAt: 1, completedAt: 1 },
    };
    return Appointment.findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .populate('doctorId')
      .populate('patientId', '-password');
  },

  /** After Next, arrived patients whose token is behind live OP become Consulted. */
  completePassedArrived: async (doctorId: string, date: string, liveOpNumber: number) => {
    if (liveOpNumber <= 0) return;
    const now = new Date();
    const appointments = await Appointment.find({
      doctorId,
      date,
      status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED] },
      arrivedAt: { $ne: null },
    });
    const ids = appointments
      .filter((appt) => Number(appt.tokenNumber) < liveOpNumber)
      .map((appt) => appt._id);
    if (ids.length === 0) return;
    await Appointment.updateMany(
      { _id: { $in: ids } },
      { $set: { status: AppointmentStatus.COMPLETED, completedAt: now } },
    );
  },

  /**
   * Revert appointment statuses when the Admin clicks Back (Previous Patient) in Queue Management.
   * Restores patients whose consultation was not actually finished back to active queue state
   * (CONSULTING if currently called and arrived, PENDING otherwise), and restores any unmarked appointments
   * that were prematurely cancelled by a session-finish check.
   */
  // Why this change is needed: Prevent duplicate active tokens and invalid appointment reactivation.
  // Reverts passed completed appointments and session-cancelled unmarked appointments safely:
  // 1. Excludes refunded appointments from reactivation (settled financial transactions remain cancelled).
  // 2. Excludes cancelled appointments whose token numbers were already reused by another active booking.
  // 3. Handles bulk operations safely per record to avoid creating inconsistent appointment states.
  revertPassedAppointments: async (doctorId: string, date: string, liveOpNumber: number) => {
    // 1. Find appointments with tokenNumber >= liveOpNumber that were marked COMPLETED on Next navigation
    const completedAppointments = await Appointment.find({
      doctorId,
      date,
      status: AppointmentStatus.COMPLETED,
    });

    const toRevert = completedAppointments.filter(
      (appt) => Number(appt.tokenNumber) >= liveOpNumber,
    );

    // Track active tokens to prevent duplicate active tokens if multiple completed records share the same token
    const activeCurrent = await Appointment.find({
      doctorId,
      date,
      status: { $in: [AppointmentStatus.PENDING, AppointmentStatus.CONSULTING] },
    }).select('tokenNumber');
    const activeTokenSet = new Set(activeCurrent.map((a) => String(a.tokenNumber)));

    for (const appt of toRevert) {
      // Why this change is needed: A refunded appointment must never be restored to active consultation.
      if (
        appt.paymentStatus === PaymentStatus.REFUNDED ||
        appt.cancellation?.refunded === true
      ) {
        continue;
      }

      const tokenStr = String(appt.tokenNumber);
      // Why this change is needed: If an active appointment already occupies this token, do not revert another to active.
      if (activeTokenSet.has(tokenStr)) {
        continue;
      }

      const isCurrentArrived =
        liveOpNumber > 0 &&
        Number(appt.tokenNumber) === liveOpNumber &&
        Boolean(appt.arrivedAt);
      const newStatus = isCurrentArrived
        ? AppointmentStatus.CONSULTING
        : AppointmentStatus.PENDING;

      await Appointment.findByIdAndUpdate(appt._id, {
        $set: { status: newStatus },
        $unset: { completedAt: 1 },
      });
      activeTokenSet.add(tokenStr);
    }

    // 2. Revert any unmarked appointments that were cancelled by PATIENT_NOT_ARRIVED session-finish check
    // Why this change is needed: Prevent invalid appointment reactivation and duplicate active tokens.
    // An appointment that was refunded or whose token was reused by another active booking must not be reactivated.
    const cancelledUnmarked = await Appointment.find({
      doctorId,
      date,
      status: AppointmentStatus.CANCELLED,
      $or: [
        { 'cancellation.reason': 'PATIENT_NOT_ARRIVED' },
        { cancellationReason: 'Patient Not Arrived' },
      ],
    });

    if (cancelledUnmarked.length > 0) {
      // Find all currently active tokens (PENDING, CONSULTING, COMPLETED) to protect against token collisions
      const activeBookings = await Appointment.find({
        doctorId,
        date,
        status: {
          $in: [
            AppointmentStatus.PENDING,
            AppointmentStatus.CONSULTING,
            AppointmentStatus.COMPLETED,
          ],
        },
      }).select('tokenNumber');

      const occupiedTokens = new Set<string>();
      for (const active of activeBookings) {
        if (active.tokenNumber) {
          occupiedTokens.add(String(active.tokenNumber));
        }
      }

      for (const appt of cancelledUnmarked) {
        // Exclude refunded appointments — financial settlements are permanently cancelled
        const isRefunded =
          appt.paymentStatus === PaymentStatus.REFUNDED ||
          appt.cancellation?.refunded === true;
        if (isRefunded) {
          continue;
        }

        const tokenStr = String(appt.tokenNumber);
        // Exclude appointments whose token number has already been claimed by another active booking
        if (occupiedTokens.has(tokenStr)) {
          continue;
        }

        await Appointment.findByIdAndUpdate(appt._id, {
          $set: { status: AppointmentStatus.PENDING },
          $unset: {
            cancelledAt: 1,
            cancellation: 1,
            cancellationReason: 1,
          },
        });
        occupiedTokens.add(tokenStr);
      }
    }
  },

  completeConsultingForDoctorDate: async (doctorId: string, date: string) => {
    const now = new Date();
    await Appointment.updateMany(
      {
        doctorId,
        date,
        status: AppointmentStatus.CONSULTING,
        arrivedAt: { $exists: true, $ne: null },
      },
      { $set: { status: AppointmentStatus.COMPLETED, completedAt: now } },
    );
  },

  /**
   * Cancel appointments when the consultation session is finished and the patient was never marked as arrived.
   * Identifies appointments still in PENDING status whose arrival was never marked, and updates them to CANCELLED
   * with reason "Patient Not Arrived". Does not cancel appointments where the patient arrived or where consultation
   * is in progress or completed, or where upcoming tokens in the queue are still waiting to be called.
   */
  checkAndCancelUnmarkedAppointments: async (
    doctorId: string,
    date: string,
    adminId?: string,
  ): Promise<number> => {
    const appointments = await Appointment.find({ doctorId, date });
    if (appointments.length === 0) return 0;

    const { doctorService } = await import('./doctorService');

    // Trigger automatic cancellation strictly when the Admin explicitly ends/closes the OP session.
    // If the session has NOT been closed, an active OP session must NEVER cancel pending appointments,
    // regardless of scheduled end time or queue position.
    const schedule = await Schedule.findOne({ doctorId, date });
    const isClosed = Boolean(schedule?.isClosed);
    if (!isClosed) {
      return 0;
    }

    // Identify appointments still in PENDING status that were NEVER marked as arrived (!arrivedAt).
    // Patients who were marked as arrived (arrivedAt is truthy) are strictly preserved and never cancelled.
    // Appointments already COMPLETED or CANCELLED are never modified.

    const unmarked = appointments.filter(
      (appt) => appt.status === AppointmentStatus.PENDING && !appt.arrivedAt,
    );

    if (unmarked.length === 0) return 0;

    const now = new Date();
    const unmarkedIds = unmarked.map((a) => a._id);

    await Appointment.updateMany(
      { _id: { $in: unmarkedIds } },
      {
        $set: {
          status: AppointmentStatus.CANCELLED,
          cancelledAt: now,
          cancellationReason: 'Patient Not Arrived',
          cancellation: {
            requestedAt: now,
            cancelledBy: 'ADMIN',
            reason: 'PATIENT_NOT_ARRIVED',
            refundAmount: 0,
            refunded: false,
          },
        },
      },
    );
    for (const appt of unmarked) {
      if (appt.time && appt.time !== 'QUEUE') {
        try {
          await doctorService.releaseSlot(doctorId, date, appt.time);
        } catch {
          // Ignore slot release error if slot already freed
        }
      }

      // Notify all mobile app users for this session/date about the cancelled token
      void appointmentService.notifySessionUsersOnCancellation(
        String(appt._id),
        appt.tokenNumber,
        undefined,
        date,
      );
    }

    void doctorService.emitSafeQueueUpdate(doctorId, date, adminId);
    return unmarked.length;
  },

  getByDoctorAndDate: async (doctorId: string, date: string) =>
    Appointment.find({
      doctorId,
      date,
      status: { $ne: AppointmentStatus.CANCELLED },
    })
      .populate('patientId', '-password')
      .sort({ tokenNumber: 1 }),

  getAllByDoctorAndDate: async (doctorId: string, date: string) =>
    Appointment.find({
      doctorId,
      date,
    })
      .populate('patientId', '-password')
      .sort({ tokenNumber: 1 }),

  // Retrieve all OP appointments (online, offline, pending, completed, cancelled, auto-cancelled) for a patient across the facility's doctors without restricting to current date or pagination limits.
  getByPatientAndDoctors: async (patientIdOrKey: string, doctorIds: mongoose.Types.ObjectId[]) => {
    const isObjectId =
      mongoose.Types.ObjectId.isValid(patientIdOrKey) &&
      String(new mongoose.Types.ObjectId(patientIdOrKey)) === patientIdOrKey;

    const userIds: mongoose.Types.ObjectId[] = [];
    let phoneDigits = '';
    let nameQuery = '';

    if (isObjectId) {
      const objId = new mongoose.Types.ObjectId(patientIdOrKey);
      userIds.push(objId);

      // Check if patientIdOrKey corresponds to a registered User
      const user = await User.findById(objId).select('_id name phone');
      if (user) {
        if (user.phone) {
          phoneDigits = user.phone.replace(/\D/g, '').slice(-10);
        }
        if (user.name) {
          nameQuery = user.name.trim();
        }
      } else {
        // If not a User, it might be an Appointment ID
        const sampleAppt = await Appointment.findById(objId).populate('patientId', '-password');
        if (sampleAppt) {
          if (sampleAppt.patientId) {
            const rawPid =
              typeof sampleAppt.patientId === 'object' && '_id' in sampleAppt.patientId
                ? (sampleAppt.patientId as any)._id
                : sampleAppt.patientId;
            if (rawPid && !userIds.some((id) => String(id) === String(rawPid))) {
              userIds.push(new mongoose.Types.ObjectId(String(rawPid)));
            }
          }
          if (sampleAppt.patientPhone) {
            phoneDigits = sampleAppt.patientPhone.replace(/\D/g, '').slice(-10);
          }
          if (sampleAppt.patientName) {
            nameQuery = sampleAppt.patientName.trim();
          }
        }
      }
    } else {
      const parts = String(patientIdOrKey || '').split('_');
      const rawPhone = parts[0] || '';
      phoneDigits = rawPhone.replace(/\D/g, '').slice(-10);
      nameQuery = parts.slice(1).join('_').trim();
    }

    // If we have a 10-digit phone number, find all registered User accounts associated with this phone
    if (phoneDigits && phoneDigits.length === 10) {
      const usersWithPhone = await User.find({
        phone: { $regex: `${phoneDigits}$`, $options: 'i' },
      }).select('_id name phone');

      for (const u of usersWithPhone) {
        if (!userIds.some((id) => String(id) === String(u._id))) {
          userIds.push(u._id as mongoose.Types.ObjectId);
        }
      }
    }

    // Build query conditions that link all appointments belonging to this patient across all statuses and booking types
    const patientOrConds: any[] = [];

    if (userIds.length > 0) {
      patientOrConds.push({ patientId: { $in: userIds } });
    }

    if (phoneDigits && phoneDigits.length === 10) {
      patientOrConds.push({
        patientPhone: { $regex: `${phoneDigits}$`, $options: 'i' },
      });
    }

    if (isObjectId) {
      patientOrConds.push({ _id: new mongoose.Types.ObjectId(patientIdOrKey) });
    }

    // Fallback if no phone digits or user IDs could be derived
    if (patientOrConds.length === 0 && nameQuery) {
      patientOrConds.push({
        patientName: {
          $regex: `^\\s*${nameQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
          $options: 'i',
        },
      });
    }

    if (patientOrConds.length === 0) {
      return [];
    }

    const query: any = {
      doctorId: { $in: doctorIds },
      $or: patientOrConds,
    };

    // Retrieve all OP appointments (online, offline, pending, completed, cancelled, auto-cancelled)
    // without limiting query results or restricting to current date.
    const appointments = await Appointment.find(query)
      .populate('doctorId')
      .populate('patientId', '-password')
      .sort({ date: -1, time: -1, createdAt: -1 });

    // Deduplicate appointments by _id in case an appointment matched multiple $or conditions
    const seen = new Set<string>();
    const deduplicated: typeof appointments = [];
    for (const appt of appointments) {
      const idStr = String(appt._id);
      if (!seen.has(idStr)) {
        seen.add(idStr);
        deduplicated.push(appt);
      }
    }

    return deduplicated;
  },

  /**
   * Live OP number is display-only until Next. Mark Arrived flags presence;
   * Next then sends arrived patients to Consulted and skipped patients to Waiting.
   */
  syncStatusesFromLiveOp: async (doctorId: string, date: string, liveOpNumber: number) => {
    if (liveOpNumber <= 0) return;
    await Appointment.updateMany(
      {
        doctorId,
        date,
        tokenNumber: String(liveOpNumber),
        status: AppointmentStatus.PENDING,
        arrivedAt: { $ne: null },
      },
      { $set: { status: AppointmentStatus.CONSULTING } },
    );
  },

  getDistinctPatients: async ({
    doctorIds,
    search,
    fromDate,
    toDate,
    page = 1,
    limit = 20,
    refundStatus,
    bookingType,
    patientType,
    status,
    dayOfWeek,
  }: PatientListParams) => {
    const doctorMatch = { doctorId: { $in: doctorIds } };

    const [confirmedBookingsAllTime, distinctPatientIds] = await Promise.all([
      Appointment.countDocuments({
        ...doctorMatch,
        status: { $ne: AppointmentStatus.CANCELLED },
      }),
      Appointment.distinct('patientId', doctorMatch),
    ]);

    const match: Record<string, unknown> = { ...doctorMatch };

    // Parse fromDate and toDate boundaries across both scheduled appointment date and createdAt so bookings are accurately included in the selected period.
    if (fromDate || toDate) {
      const createdAtCond: Record<string, Date> = {};
      const dateCond: Record<string, string> = {};
      if (fromDate) {
        createdAtCond.$gte = new Date(`${fromDate}T00:00:00.000+05:30`);
        dateCond.$gte = fromDate;
      }
      if (toDate) {
        createdAtCond.$lte = new Date(`${toDate}T23:59:59.999+05:30`);
        dateCond.$lte = toDate;
      }
      match.$or = [
        { date: dateCond },
        { createdAt: createdAtCond },
      ];
    }

    if (dayOfWeek) {
      // Support weekday filtering using the record's existing date while preserving the current Year and Month filters.
      match.$expr = {
        ...((match.$expr as Record<string, unknown>) || {}),
        $eq: [{ $dayOfWeek: { date: '$createdAt', timezone: '+05:30' } }, dayOfWeek],
      };
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    // Join User documents while preserving unlinked guest appointments (patientId: null).
    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      {
        $lookup: {
          from: 'users',
          localField: 'patientId',
          foreignField: '_id',
          as: 'patientDoc',
        },
      },
      {
        $unwind: {
          path: '$patientDoc',
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    // Keep summary statistics scoped to the selected date range while allowing search/status filters to affect only the patient list.
    const itemsMatchAnd: any[] = [];

    if (bookingType === 'online') {
      itemsMatchAnd.push({ time: { $ne: 'QUEUE' } });
    } else if (bookingType === 'offline') {
      itemsMatchAnd.push({ time: 'QUEUE' });
    }

    if (refundStatus === 'pending') {
      itemsMatchAnd.push({ status: AppointmentStatus.CANCELLED });
      itemsMatchAnd.push({
        'cancellation.refunded': { $ne: true },
        'cancellation.refundAmount': { $gt: 0 },
      });
    } else if (refundStatus === 'refunded') {
      itemsMatchAnd.push({ status: AppointmentStatus.CANCELLED });
      itemsMatchAnd.push({
        'cancellation.refunded': true,
        'cancellation.refundAmount': { $gt: 0 },
      });
    }

    if (status === 'cancelled') {
      itemsMatchAnd.push({ status: AppointmentStatus.CANCELLED });
    }

    // Require termsAcceptedAt != null and role === 'PATIENT' for registered patient filter so only genuine registered app patient users are matched.
    if (patientType === 'registered') {
      itemsMatchAnd.push({
        'patientDoc.termsAcceptedAt': { $exists: true, $ne: null },
        'patientDoc.role': 'PATIENT',
      });
    } else if (patientType === 'walkin') {
      itemsMatchAnd.push({
        $or: [
          { 'patientDoc.termsAcceptedAt': { $exists: false } },
          { 'patientDoc.termsAcceptedAt': null },
        ],
      });
    }

    if (search?.trim()) {
      const rawSearch = search.trim();
      const q = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Support the Patient ID format displayed in the Admin UI so users can search using the visible ID.
      const patientIdRaw = rawSearch.replace(/^PX-/i, '');
      const patientIdQ = patientIdRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const orConditions: any[] = [
        { patientName: { $regex: q, $options: 'i' } },
        { patientPhone: { $regex: q, $options: 'i' } },
        { 'patientDoc.name': { $regex: q, $options: 'i' } },
        { 'patientDoc.email': { $regex: q, $options: 'i' } },
        { 'patientDoc.phone': { $regex: q, $options: 'i' } },
        { 'patientDoc.place': { $regex: q, $options: 'i' } },
        { 'patientDoc.healthCardId': { $regex: q, $options: 'i' } },
        {
          $expr: {
            $regexMatch: {
              input: { $toString: '$patientId' },
              regex: patientIdQ,
              options: 'i',
            },
          },
        },
      ];

      // Normalize the user's search query for phone-number searching without changing the actual database value.
      let phoneQ = rawSearch.replace(/\D/g, '');
      if (phoneQ.startsWith('91') && phoneQ.length > 10) {
        phoneQ = phoneQ.slice(2);
      }
      if (phoneQ && phoneQ !== rawSearch) {
        orConditions.push({ patientPhone: { $regex: phoneQ, $options: 'i' } });
        orConditions.push({ 'patientDoc.phone': { $regex: phoneQ, $options: 'i' } });
      }

      itemsMatchAnd.push({ $or: orConditions });
    }

    const itemsPipeline: any[] = [];
    if (itemsMatchAnd.length > 0) {
      itemsPipeline.push({ $match: { $and: itemsMatchAnd } });
    }

    // Only count as pending refund if the cancelled appointment has an actual refund amount > 0 and is not refunded
    const pendingRefundCond = {
      $and: [
        { $eq: ['$status', AppointmentStatus.CANCELLED] },
        { $ne: ['$cancellation.refunded', true] },
        { $gt: ['$cancellation.refundAmount', 0] },
      ],
    };

    // For appointment-specific filters (such as CANCELLED, ONLINE, OFFLINE, REFUND PENDING), return distinct appointment records so every individual booking is displayed under its respective date and matches the summary count.
    // For the REGISTERED filter, group items by the registered User account ID so the primary account owner is shown as the single parent patient card.
    // For ALL PATIENTS directory view, group by unique patient (phone + name).
    const isRegisteredFilter = patientType === 'registered';
    const isAppointmentFilter = Boolean(status || bookingType || refundStatus);

    const itemsFacet: any[] = isRegisteredFilter
      ? [
          ...itemsPipeline,
          { $sort: { date: -1, time: -1, createdAt: -1 } },
          {
            $group: {
              _id: '$patientDoc._id',
              patientDoc: { $first: '$patientDoc' },
              registeredName: { $first: '$patientDoc.name' },
              registeredPhone: { $first: '$patientDoc.phone' },
              registeredAge: { $first: '$patientDoc.age' },
              registeredGender: { $first: '$patientDoc.gender' },
              registeredProfileImage: { $first: '$patientDoc.profileImage' },
              registeredPlace: { $first: '$patientDoc.place' },
              registeredHealthCardId: { $first: '$patientDoc.healthCardId' },
              registeredCreatedAt: { $first: '$patientDoc.createdAt' },
              lastBookingAt: { $first: { $ifNull: ['$date', '$createdAt'] } },
              lastCompletedBookingAt: {
                $max: {
                  $cond: [
                    { $eq: ['$status', AppointmentStatus.COMPLETED] },
                    { $ifNull: ['$completedAt', '$createdAt'] },
                    null,
                  ],
                },
              },
              firstBookingAt: { $last: '$createdAt' },
              bookingCount: { $sum: 1 },
              onlineBookingCount: {
                $sum: {
                  $cond: [{ $ne: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              offlineBookingCount: {
                $sum: {
                  $cond: [{ $eq: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              doctorIds: { $addToSet: '$doctorId' },
              lastBookingType: {
                $first: {
                  $cond: [{ $ne: ['$time', 'QUEUE'] }, 'Online', 'Offline'],
                },
              },
              lastStatus: { $first: '$status' },
              lastCancellationReason: {
                $first: { $ifNull: ['$cancellation.reason', '$cancellationReason'] },
              },
              lastArrivedAt: { $first: '$arrivedAt' },
              lastRefunded: { $first: '$cancellation.refunded' },
              lastRefundAmount: { $first: '$cancellation.refundAmount' },
              lastRefundPhone: { $first: '$cancellation.refundPhone' },
              lastRefundUpiId: { $first: '$cancellation.refundUpiId' },
              lastCancelledBy: { $first: '$cancellation.cancelledBy' },
              lastDoctorId: { $first: '$doctorId' },
              pendingRefundCount: {
                $sum: {
                  $cond: [pendingRefundCond, 1, 0],
                },
              },
              pendingRefundAmount: {
                $sum: {
                  $cond: [
                    pendingRefundCond,
                    { $ifNull: ['$cancellation.refundAmount', 0] },
                    0,
                  ],
                },
              },
              rawBookings: {
                $push: {
                  patientName: { $ifNull: ['$patientName', '$patientDoc.name'] },
                  patientAge: '$patientAge',
                  time: '$time',
                  status: '$status',
                },
              },
            },
          },
          { $sort: { lastBookingAt: -1 } },
          { $skip: skip },
          { $limit: safeLimit },
          {
            $lookup: {
              from: 'doctors',
              localField: 'lastDoctorId',
              foreignField: '_id',
              as: 'lastDoctor',
            },
          },
          {
            $unwind: {
              path: '$lastDoctor',
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              _id: { $toString: '$_id' },
              name: '$registeredName',
              phone: '$registeredPhone',
              place: '$registeredPlace',
              age: '$registeredAge',
              gender: '$registeredGender',
              profileImage: '$registeredProfileImage',
              address: '$registeredPlace',
              healthCardId: '$registeredHealthCardId',
              createdAt: '$registeredCreatedAt',
              lastBookingAt: 1,
              lastVisitAt: '$lastCompletedBookingAt',
              firstBookingAt: 1,
              bookingCount: 1,
              onlineBookingCount: 1,
              offlineBookingCount: 1,
              lastBookingType: 1,
              doctorCount: { $size: '$doctorIds' },
              lastStatus: 1,
              lastCancellationReason: 1,
              lastArrivedAt: 1,
              lastRefunded: 1,
              lastRefundAmount: 1,
              lastRefundPhone: 1,
              lastRefundUpiId: 1,
              lastCancelledBy: 1,
              pendingRefundCount: 1,
              pendingRefundAmount: 1,
              hasPendingRefund: { $gt: ['$pendingRefundCount', 0] },
              lastDoctorName: '$lastDoctor.name',
              rawBookings: 1,
            },
          },
        ]
      : isAppointmentFilter
      ? [
          ...itemsPipeline,
          { $sort: { date: -1, time: -1, createdAt: -1 } },
          { $skip: skip },
          { $limit: safeLimit },
          {
            $lookup: {
              from: 'doctors',
              localField: 'doctorId',
              foreignField: '_id',
              as: 'lastDoctor',
            },
          },
          {
            $unwind: {
              path: '$lastDoctor',
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              _id: { $toString: '$_id' },
              appointmentId: { $toString: '$_id' },
              patientId: '$patientId',
              name: { $ifNull: ['$patientName', '$patientDoc.name'] },
              phone: { $ifNull: ['$patientPhone', '$patientDoc.phone'] },
              place: '$patientDoc.place',
              age: { $ifNull: ['$patientAge', '$patientDoc.age'] },
              gender: '$patientDoc.gender',
              profileImage: '$patientDoc.profileImage',
              address: '$patientDoc.address',
              healthCardId: '$patientDoc.healthCardId',
              createdAt: '$createdAt',
              // Use the actual appointment date for date grouping and display
              lastBookingAt: { $ifNull: ['$date', '$createdAt'] },
              firstBookingAt: '$createdAt',
              bookingCount: { $literal: 1 },
              onlineBookingCount: {
                $cond: [{ $ne: ['$time', 'QUEUE'] }, 1, 0],
              },
              offlineBookingCount: {
                $cond: [{ $eq: ['$time', 'QUEUE'] }, 1, 0],
              },
              doctorCount: { $literal: 1 },
              lastBookingType: {
                $cond: [{ $ne: ['$time', 'QUEUE'] }, 'Online', 'Offline'],
              },
              lastStatus: '$status',
              lastCancellationReason: {
                $ifNull: ['$cancellation.reason', '$cancellationReason'],
              },
              lastArrivedAt: '$arrivedAt',
              lastRefunded: '$cancellation.refunded',
              lastRefundAmount: '$cancellation.refundAmount',
              lastRefundPhone: '$cancellation.refundPhone',
              lastRefundUpiId: '$cancellation.refundUpiId',
              lastCancelledBy: '$cancellation.cancelledBy',
              hasPendingRefund: {
                $and: [
                  { $eq: ['$status', AppointmentStatus.CANCELLED] },
                  { $ne: ['$cancellation.refunded', true] },
                  { $gt: [{ $ifNull: ['$cancellation.refundAmount', 0] }, 0] },
                ],
              },
              pendingRefundCount: {
                $cond: [pendingRefundCond, 1, 0],
              },
              pendingRefundAmount: {
                $cond: [
                  pendingRefundCond,
                  { $ifNull: ['$cancellation.refundAmount', 0] },
                  0,
                ],
              },
              lastDoctorName: '$lastDoctor.name',
              latestOpStatus: {
                $cond: [
                  { $eq: ['$status', AppointmentStatus.COMPLETED] },
                  'Completed',
                  {
                    $cond: [
                      { $eq: ['$status', AppointmentStatus.CANCELLED] },
                      {
                        $cond: [
                          {
                            $or: [
                              { $eq: ['$cancellation.reason', 'PATIENT_NOT_ARRIVED'] },
                              { $eq: ['$cancellationReason', 'Patient Not Arrived'] },
                            ],
                          },
                          'Auto Cancelled',
                          'Cancelled',
                        ],
                      },
                      'Pending',
                    ],
                  },
                ],
              },
            },
          },
        ]
      : [
          ...itemsPipeline,
          { $sort: { date: -1, time: -1, createdAt: -1 } },
          {
            $addFields: {
              effectivePhone: {
                $ifNull: ['$patientPhone', '$patientDoc.phone'],
              },
              effectiveName: {
                $toLower: {
                  $trim: {
                    input: { $ifNull: ['$patientName', '$patientDoc.name'] },
                  },
                },
              },
            },
          },
          {
            $group: {
              _id: {
                phone: '$effectivePhone',
                name: '$effectiveName',
              },
              patientId: { $first: '$patientId' },
              patientDoc: { $first: '$patientDoc' },
              patientName: { $first: '$patientName' },
              patientAge: { $first: '$patientAge' },
              patientPhone: { $first: '$patientPhone' },
              lastBookingAt: { $first: { $ifNull: ['$date', '$createdAt'] } },
              lastCompletedBookingAt: {
                $max: {
                  $cond: [
                    { $eq: ['$status', AppointmentStatus.COMPLETED] },
                    { $ifNull: ['$completedAt', '$createdAt'] },
                    null,
                  ],
                },
              },
              firstBookingAt: { $last: '$createdAt' },
              // Compute total, online, and offline OP booking counts per unique actual patient (phone + name).
              bookingCount: { $sum: 1 },
              onlineBookingCount: {
                $sum: {
                  $cond: [{ $ne: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              offlineBookingCount: {
                $sum: {
                  $cond: [{ $eq: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              doctorIds: { $addToSet: '$doctorId' },
              lastBookingType: {
                $first: {
                  $cond: [{ $ne: ['$time', 'QUEUE'] }, 'Online', 'Offline'],
                },
              },
              lastStatus: { $first: '$status' },
              lastCancellationReason: {
                $first: { $ifNull: ['$cancellation.reason', '$cancellationReason'] },
              },
              lastArrivedAt: { $first: '$arrivedAt' },
              lastRefunded: { $first: '$cancellation.refunded' },
              lastRefundAmount: { $first: '$cancellation.refundAmount' },
              lastRefundPhone: { $first: '$cancellation.refundPhone' },
              lastRefundUpiId: { $first: '$cancellation.refundUpiId' },
              lastCancelledBy: { $first: '$cancellation.cancelledBy' },
              lastDoctorId: { $first: '$doctorId' },
              pendingRefundCount: {
                $sum: {
                  $cond: [pendingRefundCond, 1, 0],
                },
              },
              pendingRefundAmount: {
                $sum: {
                  $cond: [
                    pendingRefundCond,
                    { $ifNull: ['$cancellation.refundAmount', 0] },
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { lastBookingAt: -1 } },
          { $skip: skip },
          { $limit: safeLimit },
          {
            $lookup: {
              from: 'doctors',
              localField: 'lastDoctorId',
              foreignField: '_id',
              as: 'lastDoctor',
            },
          },
          {
            $unwind: {
              path: '$lastDoctor',
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              _id: {
                $concat: [
                  { $ifNull: ['$_id.phone', ''] },
                  '_',
                  { $ifNull: ['$_id.name', ''] },
                ],
              },
              name: { $ifNull: ['$patientName', '$patientDoc.name'] },
              phone: { $ifNull: ['$patientPhone', '$patientDoc.phone'] },
              place: '$patientDoc.place',
              age: { $ifNull: ['$patientAge', '$patientDoc.age'] },
              gender: '$patientDoc.gender',
              profileImage: '$patientDoc.profileImage',
              address: '$patientDoc.address',
              healthCardId: '$patientDoc.healthCardId',
              createdAt: '$patientDoc.createdAt',
              lastBookingAt: 1,
              lastVisitAt: '$lastCompletedBookingAt',
              firstBookingAt: 1,
              bookingCount: 1,
              onlineBookingCount: 1,
              offlineBookingCount: 1,
              lastBookingType: 1,
              doctorCount: { $size: '$doctorIds' },
              lastStatus: 1,
              lastCancellationReason: 1,
              lastArrivedAt: 1,
              lastRefunded: 1,
              lastRefundAmount: 1,
              lastRefundPhone: 1,
              lastRefundUpiId: 1,
              lastCancelledBy: 1,
              pendingRefundCount: 1,
              pendingRefundAmount: 1,
              hasPendingRefund: { $gt: ['$pendingRefundCount', 0] },
              lastDoctorName: '$lastDoctor.name',
            },
          },
        ];

    const totalFacet: any[] = isRegisteredFilter
      ? [
          ...itemsPipeline,
          { $group: { _id: '$patientDoc._id' } },
          { $count: 'count' },
        ]
      : isAppointmentFilter
      ? [
          ...itemsPipeline,
          { $count: 'count' },
        ]
      : [
          ...itemsPipeline,
          {
            $addFields: {
              effectivePhone: { $ifNull: ['$patientPhone', '$patientDoc.phone'] },
              effectiveName: {
                $toLower: {
                  $trim: { input: { $ifNull: ['$patientName', '$patientDoc.name'] } },
                },
              },
            },
          },
          { $group: { _id: { phone: '$effectivePhone', name: '$effectiveName' } } },
          { $count: 'count' },
        ];

    pipeline.push({
      $facet: {
        // Calculate canonical admin patient statistics: Online & Offline metrics include cancelled bookings, All Patients counts unique normalized phone numbers, and Registered counts distinct genuine app users.
        stats: [
          {
            $group: {
              _id: null,
              confirmedBookings: {
                $sum: {
                  $cond: [{ $ne: ['$status', AppointmentStatus.CANCELLED] }, 1, 0],
                },
              },
              // Online count includes all online bookings (time != QUEUE) in scope, including cancelled ones.
              onlineBookings: {
                $sum: {
                  $cond: [{ $ne: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              // Offline count includes all offline bookings (time == QUEUE) in scope, including cancelled ones.
              offlineBookings: {
                $sum: {
                  $cond: [{ $eq: ['$time', 'QUEUE'] }, 1, 0],
                },
              },
              cancelled: {
                $sum: {
                  $cond: [{ $eq: ['$status', AppointmentStatus.CANCELLED] }, 1, 0],
                },
              },
              pendingRefunds: {
                $sum: {
                  $cond: [pendingRefundCond, 1, 0],
                },
              },
              pendingRefundAmount: {
                $sum: {
                  $cond: [
                    pendingRefundCond,
                    { $ifNull: ['$cancellation.refundAmount', 0] },
                    0,
                  ],
                },
              },
              // Collect raw patient phone + name keys for distinct actual patient count computation.
              rawPatientKeys: {
                $addToSet: {
                  $concat: [
                    { $ifNull: ['$patientPhone', '$patientDoc.phone'] },
                    '|',
                    { $ifNull: ['$patientName', '$patientDoc.name'] },
                  ],
                },
              },
              // Calculate facility-scoped and booking-scoped Registered Patients count by collecting unique registered PATIENT account IDs (role PATIENT and termsAcceptedAt != null) directly from appointments matched within the admin's facility and date scope.
              registeredUserIds: {
                $addToSet: {
                  $cond: [
                    {
                      $and: [
                        { $ne: [{ $ifNull: ['$patientDoc.termsAcceptedAt', null] }, null] },
                        { $eq: ['$patientDoc.role', 'PATIENT'] },
                      ],
                    },
                    '$patientDoc._id',
                    '$$REMOVE',
                  ],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              confirmedBookings: 1,
              onlineBookings: 1,
              offlineBookings: 1,
              cancelled: 1,
              pendingRefunds: 1,
              pendingRefundAmount: 1,
              rawPatientKeys: 1,
              registeredUserIds: 1,
            },
          },
        ],
        items: itemsFacet,
        total: totalFacet,
      },
    });

    const [result] = await Appointment.aggregate(pipeline);
    const total = result?.total?.[0]?.count ?? 0;
    const statsRaw = result?.stats?.[0] ?? {};

    // Compute unique actual patient count (normalized phone + normalized patientName) for All Patients metric.
    const patientKeySet = new Set<string>();
    for (const rawKey of statsRaw.rawPatientKeys || []) {
      if (!rawKey) continue;
      const [phone, ...nameParts] = String(rawKey).split('|');
      const name = nameParts.join('|').trim().toLowerCase();
      const digits = String(phone).replace(/\D/g, '');
      const local = digits.length > 10 ? digits.slice(-10) : digits;
      if (local && name) {
        patientKeySet.add(`${local}_${name}`);
      }
    }

    const registeredUserCount = Array.isArray(statsRaw.registeredUserIds) ? statsRaw.registeredUserIds.length : 0;

    const periodStats = {
      confirmedBookings: statsRaw.confirmedBookings || 0,
      onlineBookings: statsRaw.onlineBookings || 0,
      offlineBookings: statsRaw.offlineBookings || 0,
      cancelled: statsRaw.cancelled || 0,
      pendingRefunds: statsRaw.pendingRefunds || 0,
      pendingRefundAmount: statsRaw.pendingRefundAmount || 0,
      allPatients: patientKeySet.size,
      allUsers: patientKeySet.size,
      registeredUsers: registeredUserCount,
      registered: registeredUserCount,
    };

    const items = result?.items ?? [];

    // Determine OP booking status (Pending, Completed, Cancelled) and last completed consultation date.
    await Promise.all(
      items.map(async (item: any) => {
        // Unify patient matching across both online and offline bookings using registered user ID and normalized 10-digit phone number.
        const patientMatch: any[] = [];
        if (item.patientId && mongoose.Types.ObjectId.isValid(item.patientId)) {
          patientMatch.push({ patientId: item.patientId });
        } else if (item._id && mongoose.Types.ObjectId.isValid(item._id) && !isAppointmentFilter) {
          patientMatch.push({ patientId: item._id });
        }
        const phoneDigits = String(item.phone || '').replace(/\D/g, '').slice(-10);
        if (phoneDigits.length === 10) {
          patientMatch.push({
            patientPhone: { $regex: `${phoneDigits}$`, $options: 'i' },
          });
        } else if (item.phone && item.name) {
          patientMatch.push({
            patientPhone: item.phone,
            patientName: {
              $regex: `^\\s*${String(item.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
              $options: 'i',
            },
          });
        } else if (item.phone) {
          patientMatch.push({ patientPhone: item.phone });
        }
        if (patientMatch.length === 0) return;

        // Retrieve the patient's all-time OP booking count at this facility across both online and offline bookings
        const allTimeCount = await Appointment.countDocuments({
          doctorId: { $in: doctorIds },
          $or: patientMatch,
        });
        if (allTimeCount > 0) {
          item.bookingCount = allTimeCount;
        }

        // For appointment-specific filters, each item represents a specific appointment document.
        // Its appointment status, booking type, and cancellation reason are evaluated from that exact booking.
        // For general patient directory views, resolve latest appointment for the patient.
        // Why this change is needed: Fix ESLint no-useless-assignment error.
        // targetAppt is unconditionally assigned in both branches of the following if-else block.
        let targetAppt: any;
        if (isAppointmentFilter) {
          targetAppt = await Appointment.findById(item._id)
            .populate('doctorId')
            .select('status date time createdAt doctorId cancellation cancellationReason patientName patientAge patientPhone');
        } else {
          const latestApptFilter: any = {
            doctorId: { $in: doctorIds },
            $or: patientMatch,
          };

          if (status === 'cancelled') {
            latestApptFilter.status = AppointmentStatus.CANCELLED;
          } else if (status) {
            latestApptFilter.status = status;
          }

          if (refundStatus === 'pending') {
            latestApptFilter.status = AppointmentStatus.CANCELLED;
            latestApptFilter['cancellation.refunded'] = { $ne: true };
            latestApptFilter['cancellation.refundAmount'] = { $gt: 0 };
          } else if (refundStatus === 'refunded') {
            latestApptFilter.status = AppointmentStatus.CANCELLED;
            latestApptFilter['cancellation.refunded'] = true;
            latestApptFilter['cancellation.refundAmount'] = { $gt: 0 };
          }

          if (bookingType === 'online') {
            latestApptFilter.time = { $ne: 'QUEUE' };
          } else if (bookingType === 'offline') {
            latestApptFilter.time = 'QUEUE';
          }

          targetAppt = await Appointment.findOne(latestApptFilter)
            .sort({ date: -1, time: -1, createdAt: -1 })
            .populate('doctorId')
            .select('status date time createdAt doctorId cancellation cancellationReason patientName patientAge patientPhone');
        }

        if (targetAppt) {
          // Booking Type: 'Online' or 'Offline' based on the specific appointment being displayed
          item.lastBookingType = targetAppt.time === 'QUEUE' ? 'Offline' : 'Online';

          // Doctor Name: from populated doctor of the appointment
          const docObj = targetAppt.doctorId as any;
          if (docObj?.name) {
            item.lastDoctorName = docObj.name;
          } else if (targetAppt.doctorId) {
            const doc = await Doctor.findById(targetAppt.doctorId).select('name');
            if (doc?.name) item.lastDoctorName = doc.name;
          }

          // Ensure patient demographic fields are reliably populated
          if (targetAppt.patientName && (!item.name || item.name === 'Patient')) {
            item.name = targetAppt.patientName;
          }
          if (targetAppt.patientPhone && !item.phone) {
            item.phone = targetAppt.patientPhone;
          }
          if (targetAppt.patientAge != null && item.age == null) {
            item.age = targetAppt.patientAge;
          }

          // Evaluate appointment status independently using its persisted status
          if (targetAppt.status === AppointmentStatus.COMPLETED) {
            item.latestOpStatus = 'Completed';
            item.lastStatus = AppointmentStatus.COMPLETED;
            // Prevent completed appointments from inheriting cancellation reason or refund statuses from other bookings
            item.lastCancellationReason = undefined;
            item.lastRefunded = undefined;
            item.lastRefundAmount = undefined;
            item.lastRefundPhone = undefined;
            item.lastRefundUpiId = undefined;
            item.lastCancelledBy = undefined;
            item.hasPendingRefund = false;
            item.pendingRefundCount = 0;
            item.pendingRefundAmount = 0;
          } else if (targetAppt.status === AppointmentStatus.CANCELLED) {
            const isAuto =
              targetAppt.cancellation?.reason === 'PATIENT_NOT_ARRIVED' ||
              (targetAppt as any).cancellationReason === 'Patient Not Arrived';
            item.latestOpStatus = isAuto ? 'Auto Cancelled' : 'Cancelled';
            item.lastStatus = AppointmentStatus.CANCELLED;
            item.lastCancellationReason =
              targetAppt.cancellation?.reason || (targetAppt as any).cancellationReason;
            item.lastRefunded = targetAppt.cancellation?.refunded;
            item.lastRefundAmount = targetAppt.cancellation?.refundAmount;
            item.lastRefundPhone = targetAppt.cancellation?.refundPhone;
            item.lastRefundUpiId = targetAppt.cancellation?.refundUpiId;
            item.lastCancelledBy = targetAppt.cancellation?.cancelledBy;
          } else {
            // New booking or in progress -> Pending
            item.latestOpStatus = 'Pending';
            item.lastStatus = targetAppt.status;
            item.lastCancellationReason = undefined;
            item.lastRefunded = undefined;
            item.lastRefundAmount = undefined;
            item.lastRefundPhone = undefined;
            item.lastRefundUpiId = undefined;
            item.lastCancelledBy = undefined;
          }
        } else {
          item.latestOpStatus = 'Pending';
        }

        // If age is still missing, look up any appointment holding patientAge for this patient
        if (item.age == null) {
          const apptWithAge = await Appointment.findOne({
            doctorId: { $in: doctorIds },
            $or: patientMatch,
            patientAge: { $ne: null, $exists: true },
          }).select('patientAge');
          if (apptWithAge?.patientAge != null) {
            item.age = apptWithAge.patientAge;
          }
        }

        // If doctor name is still missing, look up the appointment doctor
        if (!item.lastDoctorName) {
          const apptWithDoc = await Appointment.findOne({
            doctorId: { $in: doctorIds },
            $or: patientMatch,
          })
            .sort({ date: -1, time: -1, createdAt: -1 })
            .populate('doctorId')
            .select('doctorId');
          const d = apptWithDoc?.doctorId as any;
          if (d?.name) item.lastDoctorName = d.name;
        }

        // Last Visit must represent the patient's previous completed consultation strictly prior to
        // the appointment being displayed. Never use pending, cancelled, or auto-cancelled bookings.
        if (targetAppt) {
          if (targetAppt.status === AppointmentStatus.COMPLETED) {
            const priorCompletedAppt = await Appointment.findOne({
              doctorId: { $in: doctorIds },
              _id: { $ne: targetAppt._id },
              status: AppointmentStatus.COMPLETED,
              $and: [
                { $or: patientMatch },
                {
                  $or: [
                    { date: { $lt: targetAppt.date } },
                    { date: targetAppt.date, createdAt: { $lt: targetAppt.createdAt } },
                  ],
                },
              ],
            })
              .sort({ date: -1, time: -1, createdAt: -1 })
              .select('completedAt createdAt date');

            item.lastVisitAt = priorCompletedAppt
              ? priorCompletedAppt.date || priorCompletedAppt.completedAt || priorCompletedAppt.createdAt
              : undefined;
          } else {
            const priorCompletedAppt = await Appointment.findOne({
              doctorId: { $in: doctorIds },
              _id: { $ne: targetAppt._id },
              status: AppointmentStatus.COMPLETED,
              $or: patientMatch,
            })
              .sort({ date: -1, time: -1, createdAt: -1 })
              .select('completedAt createdAt date');

            item.lastVisitAt = priorCompletedAppt
              ? priorCompletedAppt.date || priorCompletedAppt.completedAt || priorCompletedAppt.createdAt
              : undefined;
          }
        } else {
          item.lastVisitAt = undefined;
        }
      }),
    );

    // For REGISTERED filter cards, group raw appointment snapshots into a patientBreakdown list by Appointment.patientName to display individual patient OP counts under the primary registered account owner.
    if (isRegisteredFilter) {
      for (const item of items) {
        const map = new Map<string, { name: string; total: number; online: number; offline: number; age?: number }>();
        for (const b of item.rawBookings || []) {
          const rawName = String(b.patientName || item.name || '').trim();
          const normKey = rawName.toLowerCase();
          if (!normKey) continue;
          const existing = map.get(normKey);
          const isOnline = b.time !== 'QUEUE';
          if (existing) {
            existing.total += 1;
            if (isOnline) existing.online += 1;
            else existing.offline += 1;
          } else {
            map.set(normKey, {
              name: rawName,
              total: 1,
              online: isOnline ? 1 : 0,
              offline: isOnline ? 0 : 1,
              age: b.patientAge,
            });
          }
        }
        item.patientBreakdown = Array.from(map.values());
        delete item.rawBookings;
      }
    }

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      stats: periodStats,
      totals: {
        confirmedBookings: confirmedBookingsAllTime,
        allUsers: distinctPatientIds.length,
      },
    };
  },

  listVisitsForFacility: async (facilityId: string) => {
    // Resolve doctors belonging to this facility via facilityId, ownerId, or adminId to match the Admin Portal scoping.
    // Why this change is needed: Fix ESLint no-useless-assignment error.
    // doctorIds is unconditionally assigned in both branches of the following if-else block.
    let doctorIds: mongoose.Types.ObjectId[];
    if (mongoose.Types.ObjectId.isValid(facilityId)) {
      const facility = await Facility.findById(facilityId).select('_id ownerId').lean();
      const docQuery: any = {
        $or: [{ facilityId: new mongoose.Types.ObjectId(facilityId) }],
      };
      if (facility?.ownerId) {
        docQuery.$or.push({ adminId: facility.ownerId });
      }
      docQuery.$or.push({ adminId: new mongoose.Types.ObjectId(facilityId) });
      const doctors = await Doctor.find(docQuery).select('_id');
      doctorIds = doctors.map((d) => d._id);
    } else {
      const doctors = await Doctor.find({ facilityId }).select('_id');
      doctorIds = doctors.map((d) => d._id);
    }

    return Appointment.find({ doctorId: { $in: doctorIds } })
      .populate('patientId', 'name phone email healthCardId age gender')
      .populate('doctorId', 'name specialization')
      .sort({ date: -1, createdAt: -1 });
  },

  getFacilityProfileStats: async (facilityId: string) => {
    // Resolve all doctors for this facility so stats match the Admin Portal exactly.
    // Why this change is needed: Fix ESLint no-useless-assignment error.
    // doctorIds is unconditionally assigned in both branches of the following if-else block.
    let doctorIds: mongoose.Types.ObjectId[];
    if (mongoose.Types.ObjectId.isValid(facilityId)) {
      const facility = await Facility.findById(facilityId).select('_id ownerId').lean();
      const docQuery: any = {
        $or: [{ facilityId: new mongoose.Types.ObjectId(facilityId) }],
      };
      if (facility?.ownerId) {
        docQuery.$or.push({ adminId: facility.ownerId });
      }
      docQuery.$or.push({ adminId: new mongoose.Types.ObjectId(facilityId) });
      const doctors = await Doctor.find(docQuery).select('_id');
      doctorIds = doctors.map((d) => d._id);
    } else {
      const doctors = await Doctor.find({ facilityId }).select('_id');
      doctorIds = doctors.map((d) => d._id);
    }

    const today = getNowInAppTz().date;
    const last30 = getNowInAppTz(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)).date;
    const prev30 = getNowInAppTz(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)).date;
    const inFacility = { doctorId: { $in: doctorIds } };

    const [
      totalBookings,
      todayCompleted,
      todayRemaining,
      cancelledLast30Days,
      recent30,
      previous30,
    ] = await Promise.all([
      Appointment.countDocuments({
        ...inFacility,
        status: { $ne: AppointmentStatus.CANCELLED },
      }),
      Appointment.countDocuments({
        ...inFacility,
        date: today,
        status: AppointmentStatus.COMPLETED,
      }),
      Appointment.countDocuments({
        ...inFacility,
        date: today,
        status: { $in: [AppointmentStatus.PENDING, AppointmentStatus.CONSULTING] },
      }),
      Appointment.countDocuments({
        ...inFacility,
        status: AppointmentStatus.CANCELLED,
        date: { $gte: last30 },
      }),
      Appointment.countDocuments({
        ...inFacility,
        status: { $ne: AppointmentStatus.CANCELLED },
        date: { $gte: last30 },
      }),
      Appointment.countDocuments({
        ...inFacility,
        status: { $ne: AppointmentStatus.CANCELLED },
        date: { $gte: prev30, $lt: last30 },
      }),
    ]);

    const bookingsDeltaPct =
      previous30 === 0
        ? recent30 > 0
          ? 100
          : 0
        : Math.round(((recent30 - previous30) / previous30) * 100);

    return {
      totalBookings,
      todayTotal: todayCompleted + todayRemaining,
      todayCompleted,
      todayRemaining,
      cancelledLast30Days,
      bookingsDeltaPct,
    };
  },

  listQueueForFacility: async (facilityId: string, date?: string) => {
    const day = date || getNowInAppTz().date;
    const docQuery: any = {
      isActive: true,
      $or: [{ facilityId }],
    };
    if (mongoose.Types.ObjectId.isValid(facilityId)) {
      const facility = await Facility.findById(facilityId).select('_id ownerId').lean();
      docQuery.$or = [{ facilityId: new mongoose.Types.ObjectId(facilityId) }];
      if (facility?.ownerId) {
        docQuery.$or.push({ adminId: facility.ownerId });
      }
      docQuery.$or.push({ adminId: new mongoose.Types.ObjectId(facilityId) });
    }
    const doctors = await Doctor.find(docQuery).sort({ name: 1 });
    const { doctorService } = await import('./doctorService');

    const columns = await Promise.all(
      doctors.map(async (doctor) => {
        const schedule = await doctorService.getSchedule(String(doctor._id), day);
        const isClosed = Boolean(schedule?.isClosed);
        const allAppointments = await appointmentService.getAllByDoctorAndDate(
          String(doctor._id),
          day,
        );
        const appointments = allAppointments.filter(
          (appt) => appt.status !== AppointmentStatus.CANCELLED,
        );
        const sameDay = doctor.liveOp?.date === day;
        const liveOpNumber = sameDay ? Number(doctor.liveOp?.currentNumber || 0) : 0;
        const onBreak = sameDay ? Boolean(doctor.liveOp?.onBreak) : false;
        const board = partitionOpBoard(appointments, liveOpNumber);

        const bookingStatus = isClosed
          ? 'CLOSED'
          : onBreak
          ? 'ON_BREAK'
          : 'ACTIVE';

        return {
          _id: doctor._id,
          name: doctor.name,
          specialization: doctor.specialization || '',
          consultationFee: doctor.consultationFee,
          phone: doctor.phone,
          profileImage: doctor.profileImage,
          liveOpNumber,
          onBreak,
          isClosed,
          bookingStatus,
          waitingCount: board.waitingCount,
          totalBooked: appointments.length,
          current: board.current,
          waiting: board.waiting.slice(0, 8),
          queue: board.queue.slice(0, 8),
        };
      }),
    );

    return { date: day, doctors: columns };
  },

  updateVisitById: async (visitId: string, body: Record<string, unknown>) => {
    const existing = await Appointment.findById(visitId);
    if (!existing) return null;

    // Use the central appointment status so all portals show the same refund state.
    const patch: Record<string, unknown> = {};
    for (const key of ['status', 'date', 'time', 'paymentStatus'] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }

    // Save the previous payment status so the Super Admin can safely undo an incorrect refund status change.
    if (body.paymentStatus === 'REFUNDED' && existing.paymentStatus !== 'REFUNDED') {
      patch.previousPaymentStatus = existing.paymentStatus;
      patch['cancellation.refunded'] = true;
    } 
    // Restore the appointment to the payment status that existed before the refund status was changed.
    else if (body.paymentStatus === 'UNDO_REFUND') {
      if (existing.paymentStatus !== 'REFUNDED') {
        throw AppError.badRequest('Can only undo if currently refunded.');
      }
      patch.paymentStatus = existing.previousPaymentStatus || 'PAID';
      patch['cancellation.refunded'] = false;
    }

    return Appointment.findByIdAndUpdate(visitId, { $set: patch }, { new: true })
      .populate('patientId', 'name phone email')
      .populate('doctorId', 'name');
  },

  updateVisitForSuperAdmin: async (visitId: string, body: Record<string, unknown>) => {
    const visit = await appointmentService.updateVisitById(visitId, body);
    if (!visit) throw AppError.notFound(MSG.VISIT_NOT_FOUND);
    return visit;
  },

  deleteVisitById: async (visitId: string) => Appointment.findByIdAndDelete(visitId),

  deleteVisitForSuperAdmin: async (visitId: string) => {
    const visit = await appointmentService.deleteVisitById(visitId);
    if (!visit) throw AppError.notFound(MSG.VISIT_NOT_FOUND);
    return MSG.VISIT_DELETED;
  },

  // Calculate payment summary values from existing appointment records.
  getPaymentsSummary: async (opts: {
    from?: string;
    to?: string;
    facilityId?: string;
    paymentStatus?: string;
  }) => {
    const appointments = await appointmentService.listPayments(opts);
    
    let paid = 0;
    let adminReceived = 0;
    let adminPending = 0;
    let adminRefunded = 0;
    let adminShare = 0;

    for (const row of appointments) {
      const amount = Number(row.consultationFee || 0) + Number(row.platformFee || 0);
      const share = Number(row.platformFee || 0);

      if (row.paymentStatus === 'PAID') {
        paid += amount;
        adminReceived += share;
      }
      if (row.paymentStatus === 'NOT_PAID') {
        adminPending += share;
      }
      if (row.paymentStatus === 'REFUNDED') {
        adminRefunded += share;
      }
      adminShare += share;
    }

    return {
      paid,
      adminReceived,
      adminPending,
      adminRefunded,
      adminShare,
    };
  },

  // Generate monthly payment totals for the Super Admin report.
  getPaymentsMonthlyReport: async () => {
    const appointments = await appointmentService.listPayments({});
    const byMonth = new Map<string, any>();

    for (const row of appointments) {
      const raw = row.createdAt || row.date;
      const date = raw ? new Date(String(raw)) : new Date();
      if (Number.isNaN(date.getTime())) continue;
      
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const existing = byMonth.get(key) ?? {
        key,
        label: new Date(date.getFullYear(), date.getMonth(), 1).toLocaleDateString('en-IN', {
          month: 'long',
          year: 'numeric',
        }),
        bookingCount: 0,
        bookingAmount: 0,
        paidAmount: 0,
        pendingAmount: 0,
        paidCount: 0,
        pendingCount: 0,
      };

      const share = Number(row.platformFee || 0);
      existing.bookingCount += 1;
      existing.bookingAmount += share;

      if (row.paymentStatus === 'PAID') {
        existing.paidAmount += share;
        existing.paidCount += 1;
      } else if (row.paymentStatus === 'NOT_PAID') {
        existing.pendingAmount += share;
        existing.pendingCount += 1;
      }
      byMonth.set(key, existing);
    }

    return [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  },

  listPayments: async (opts: {
    from?: string;
    to?: string;
    facilityId?: string;
    paymentStatus?: string;
  }) => {
    const filter: Record<string, unknown> = {};
    if (opts.paymentStatus) filter.paymentStatus = opts.paymentStatus;
    if (opts.from || opts.to) {
      filter.createdAt = {};
      if (opts.from) (filter.createdAt as Record<string, Date>).$gte = new Date(opts.from);
      if (opts.to) (filter.createdAt as Record<string, Date>).$lte = new Date(opts.to);
    }

    // When scoping by facility, query MongoDB directly with the resolved doctor IDs matching Admin Portal rules.
    if (opts.facilityId) {
      // Why this change is needed: Fix ESLint no-useless-assignment error.
      // doctorIds is unconditionally assigned in both branches of the following if-else block.
      let doctorIds: mongoose.Types.ObjectId[];
      if (mongoose.Types.ObjectId.isValid(opts.facilityId)) {
        const facility = await Facility.findById(opts.facilityId).select('_id ownerId').lean();
        const docQuery: any = {
          $or: [{ facilityId: new mongoose.Types.ObjectId(opts.facilityId) }],
        };
        if (facility?.ownerId) {
          docQuery.$or.push({ adminId: facility.ownerId });
        }
        docQuery.$or.push({ adminId: new mongoose.Types.ObjectId(opts.facilityId) });
        const doctors = await Doctor.find(docQuery).select('_id');
        doctorIds = doctors.map((d) => d._id);
      } else {
        const doctors = await Doctor.find({ facilityId: opts.facilityId }).select('_id');
        doctorIds = doctors.map((d) => d._id);
      }
      filter.doctorId = { $in: doctorIds };
    }

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone email healthCardId age gender')
      .populate({
        path: 'doctorId',
        select: 'name specialization facilityId adminId',
        populate: { path: 'facilityId', select: 'name facilityType place' },
      })
      .sort({ date: -1, createdAt: -1 });

    return appointments;
  },

  buildPaymentsCsv: async (opts?: {
    from?: string;
    to?: string;
    facilityId?: string;
    paymentStatus?: string;
  }) => {
    const rows = await appointmentService.listPayments(opts ?? {});

    const header = [
      'id',
      'date',
      'time',
      'patient',
      'phone',
      'doctor',
      'facility',
      'consultationFee',
      'platformFee',
      'paymentStatus',
      'status',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      const patient = row.patientId as unknown as { name?: string; phone?: string };
      const doctor = row.doctorId as unknown as {
        name?: string;
        facilityId?: { name?: string };
      };
      lines.push(
        [
          row.id,
          row.date,
          row.time,
          JSON.stringify(patient?.name || ''),
          patient?.phone || '',
          JSON.stringify(doctor?.name || ''),
          JSON.stringify(doctor?.facilityId?.name || ''),
          row.consultationFee ?? '',
          row.platformFee ?? '',
          row.paymentStatus ?? '',
          row.status,
        ].join(','),
      );
    }
    return lines.join('\n');
  },

  listForPatient: async (patientId: string) =>
    Appointment.find({ patientId })
      .populate({
        path: 'doctorId',
        select: 'name specialization facilityId',
        populate: { path: 'facilityId', select: 'name facilityType place' },
      })
      .sort({ createdAt: -1 })
      .limit(200),

  getAppointmentsForUser: async (
    userId: string,
    role: UserRole,
    doctorIdQuery?: string,
  ) => {
    const { doctorService } = await import('./doctorService');
    let filter: Record<string, unknown>;

    if (role === UserRole.ADMIN) {
      const doctors = await doctorService.getByAdmin(userId);
      const doctorIds = doctors.map((doc) => doc._id);
      const doctorId =
        typeof doctorIdQuery === 'string' && doctorIdQuery ? doctorIdQuery : undefined;

      if (doctorId) {
        const owned = doctors.some((doc) => String(doc._id) === doctorId);
        if (!owned) {
          throw AppError.forbidden(MSG.DOCTOR_NOT_FOR_FACILITY);
        }
        filter = { doctorId };
      } else {
        filter = { doctorId: { $in: doctorIds } };
      }
    } else {
      filter = { patientId: userId };
    }

    const appointments = await appointmentService.getAll(filter);
    if (role !== UserRole.PATIENT) return appointments;

    return appointmentService.attachScheduleClosedFlags(appointments);
  },

  /** Mark scheduleIsClosed on each appointment for patient live-OP visibility. */
  attachScheduleClosedFlags: async <T extends { doctorId?: unknown; date?: string }>(
    appointments: T[],
  ): Promise<Array<T & { scheduleIsClosed?: boolean }>> => {
    if (appointments.length === 0) return appointments;

    const { doctorService } = await import('./doctorService');
    const keys = new Map<string, { doctorId: string; date: string }>();
    for (const appt of appointments) {
      const doctorId = getDoctorIdString(appt.doctorId);
      const date = typeof appt.date === 'string' ? appt.date : '';
      if (!doctorId || !date) continue;
      keys.set(`${doctorId}|${date}`, { doctorId, date });
    }

    const closed = new Map<string, boolean>();
    await Promise.all(
      Array.from(keys.entries()).map(async ([key, { doctorId, date }]) => {
        const schedule = await doctorService.getSchedule(doctorId, date);
        closed.set(key, Boolean(schedule?.isClosed));
      }),
    );

    return appointments.map((appt) => {
      const doctorId = getDoctorIdString(appt.doctorId);
      const date = typeof appt.date === 'string' ? appt.date : '';
      const scheduleIsClosed = closed.get(`${doctorId}|${date}`) ?? false;
      const withToObject = appt as T & { toObject?: () => Record<string, unknown> };
      const plain =
        typeof withToObject.toObject === 'function'
          ? withToObject.toObject()
          : { ...(appt as object) };
      return { ...plain, scheduleIsClosed } as T & { scheduleIsClosed?: boolean };
    });
  },

  markCancellationRefunded: async (
    adminId: string,
    role: UserRole,
    appointmentId: string,
    refunded = true,
  ) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.ONLY_ADMINS_UPDATE);
    }

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) {
      throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    }

    if (appointment.status !== AppointmentStatus.CANCELLED) {
      throw AppError.badRequest('Only cancelled appointments can be marked as refunded');
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    if (!doctor || String(doctor.adminId) !== adminId) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }

    const existing = appointment.cancellation;
    const existingPlain =
      existing && typeof (existing as { toObject?: () => object }).toObject === 'function'
        ? (existing as unknown as { toObject: () => object }).toObject()
        : existing
          ? { ...existing }
          : {
              requestedAt: appointment.cancelledAt || new Date(),
              cancelledBy: 'ADMIN' as const,
            };

    // Authoritative refund amount: preserve already established refundAmount, do not recalculate with old policy
    const establishedRefundAmt =
      typeof appointment.cancellation?.refundAmount === 'number'
        ? appointment.cancellation.refundAmount
        : (appointment.time === 'QUEUE' ? (appointment.consultationFee || 0) : 0);

    const nextCancellation = {
      ...existingPlain,
      refunded: Boolean(refunded),
      refundAmount: establishedRefundAmt,
    };
    
    // OLD POLICY-BASED RECALCULATION (Commented out):
    // const oldRefundAmount = appointment.cancellation?.refundAmount ??
    //   computeRefundAmount(
    //     appointment.consultationFee,
    //     appointment.cancellation?.refundPolicy || 'FULL_OP_NO_CONVENIENCE',
    //   );
    
    if (refunded && (appointment.cashfreeOrderId || appointment.razorpayPaymentId) && appointment.paymentStatus !== 'REFUNDED') {
      try {
        if (appointment.cashfreeOrderId) {
          await cashfreeService.issueRefund(appointment.cashfreeOrderId, nextCancellation.refundAmount);
        } else if (appointment.razorpayPaymentId) {
          await razorpayService.issueRefund(appointment.razorpayPaymentId, nextCancellation.refundAmount);
        }
      } catch (err) {
        console.error('Failed to issue refund', err);
        // Continue anyway, maybe they refunded manually
      }
    }

    const updated = await Appointment.findByIdAndUpdate(
      appointmentId,
      {
        cancellation: nextCancellation,
        ...(refunded ? { 
          paymentStatus: 'REFUNDED', 
          previousPaymentStatus: appointment.paymentStatus !== 'REFUNDED' ? appointment.paymentStatus : appointment.previousPaymentStatus 
        } : {}),
      },
      { new: true },
    )
      .populate('doctorId')
      .populate('patientId', '-password');
      
    if (refunded && appointment.paymentStatus !== 'REFUNDED') {
      // Reverse Ledgers
      if (appointment.consultationFee && appointment.consultationFee > 0) {
        await DoctorWalletTransaction.create({
          doctorId: doctor._id,
          adminId: doctor.adminId,
          appointmentId: appointment._id,
          amount: -appointment.consultationFee,
          type: 'DEBIT_REFUND',
          description: `Refund for cancelled booking ${appointment.tokenNumber}`,
        });
      }

      if (appointment.platformFee && appointment.platformFee > 0) {
        await AdminBillingTransaction.create({
          adminId: doctor.adminId,
          appointmentId: appointment._id,
          amount: -appointment.platformFee,
          type: 'CREDIT_REFUND',
          description: `Platform fee refund for cancelled booking ${appointment.tokenNumber}`,
        });
      }
    }

    return updated;
  },

  bookAppointment: async (patientId: string, role: UserRole, body: {
    doctorId?: unknown;
    date?: unknown;
    patientName?: unknown;
    patientAge?: unknown;
    patientPhone?: unknown;
  }) => {
    if (role !== UserRole.PATIENT) {
      throw AppError.forbidden(MSG.ONLY_PATIENTS_BOOK);
    }

    const { doctorId, date, patientName, patientAge, patientPhone } = body;
    if (!doctorId || !date) {
      throw AppError.badRequest(MSG.DOCTOR_DATE_REQUIRED);
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(String(doctorId));
    if (!doctor || !doctor.isActive) {
      throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
    }

    const patientDayCount = await appointmentService.countActiveForPatientDate(
      patientId,
      String(date),
    );
    if (patientDayCount >= MAX_BOOKINGS_PER_PATIENT_PER_DAY) {
      throw AppError.badRequest(MSG.BOOKING_DAY_LIMIT);
    }

    const schedule = await doctorService.getSchedule(String(doctorId), String(date));
    if (!schedule || schedule.isClosed) {
      throw AppError.badRequest(MSG.NO_SCHEDULE_BOOKING);
    }

    if (
      schedule.maxTokens != null &&
      Number(schedule.maxTokens) > 0 &&
      schedule.maxTokens !== schedule.slots?.length
    ) {
      const bookedCount = await appointmentService.countActiveForDoctorDate(
        String(doctorId),
        String(date),
      );
      if (bookedCount >= schedule.maxTokens) {
        throw AppError.badRequest(MSG.NO_TOKENS_LEFT);
      }
    }

    const scheduleEndTime =
      schedule.endTime ||
      schedule.slots[schedule.slots.length - 1]?.time ||
      undefined;

    let facility = null;
    let adminRazorpayAccountId: string | undefined;

    // Fetch the facility early to check for a specific convenience fee
    if (doctor.facilityId) {
      facility = await Facility.findById(doctor.facilityId);
    } else if (doctor.adminId) {
      facility = await Facility.findOne({ ownerId: doctor.adminId });
    }

    if (facility) {
      adminRazorpayAccountId = facility.razorpayAccountId || facility.bankAccountDetails?.razorpayId;
    }

    const basePlatformFee = await platformFeeService.get();
    // Use the facility-specific fee if available; otherwise use the global fee
    const platformFee = facility?.convenienceFeeOverride ?? basePlatformFee;

    const tokenNumber = await nextOpNumber(String(doctorId), String(date));
    
    const consultationFee = doctor.consultationFee ?? 0;
    
    // Only charge the convenience fee through Razorpay/Cashfree
    const totalAmount = platformFee;

    // Reuse existing unpaid draft if payment was abandoned/failed previously for same doctor/date
    const existingUnpaid = await Appointment.findOne({
      patientId: new mongoose.Types.ObjectId(patientId),
      doctorId: new mongoose.Types.ObjectId(String(doctorId)),
      date: String(date),
      paymentStatus: PaymentStatus.NOT_PAID,
      status: AppointmentStatus.PENDING,
    });

    const isRazorpay =
      process.env.PAYMENT_GATEWAY === 'RAZORPAY' ||
      (Boolean(process.env.RAZORPAY_KEY_ID) && !process.env.CASHFREE_APP_ID);

    if (existingUnpaid) {
      // FIX: If the fee is 0, update the existing unpaid appointment directly to CONFIRMED and PAID, bypassing Razorpay.
      if (totalAmount === 0) {
        const updated = await Appointment.findByIdAndUpdate(
          existingUnpaid._id,
          {
            $set: {
              consultationFee,
              platformFee,
              paymentStatus: PaymentStatus.PAID,
              status: AppointmentStatus.PENDING,
            },
            $unset: {
              razorpayOrderId: 1,
              cashfreeOrderId: 1,
              paymentSessionId: 1,
            },
          },
          { new: true },
        );
        // FIX: Send confirmation notification to the patient upon successful booking with 0 fee.
        if (updated && updated.patientId) {
          await notificationService.create({
            userId: String(updated.patientId),
            title: 'Appointment Confirmed',
            body: `Your OP appointment with Dr. ${doctor.name} on ${updated.date} is confirmed. Token No: ${updated.tokenNumber}.`,
            type: NotificationType.SYSTEM,
            refId: String(updated._id),
          });
        }
        return updated ? updated.toObject() : existingUnpaid.toObject();
      }

      const patient = await User.findById(patientId);
      if (isRazorpay) {
        const rzpOrder = await razorpayService.createOrder(totalAmount, adminRazorpayAccountId);
        const updated = await Appointment.findByIdAndUpdate(
          existingUnpaid._id,
          {
            $set: {
              consultationFee,
              platformFee,
              razorpayOrderId: rzpOrder.id,
            },
          },
          { new: true },
        );

        const plain = updated ? updated.toObject() : existingUnpaid.toObject();
        return {
          ...plain,
          razorpayOrderId: rzpOrder.id,
          razorpayKeyId: process.env.RAZORPAY_KEY_ID,
          amount: Math.round(totalAmount * 100),
          currency: 'INR',
        };
      } else {
        const order = await cashfreeService.createOrder(totalAmount, {
          customerId: String(patientId),
          customerName: patient?.name,
          customerEmail: patient?.email,
          customerPhone: patient?.phone,
        });

        const updated = await Appointment.findByIdAndUpdate(
          existingUnpaid._id,
          {
            $set: {
              consultationFee,
              platformFee,
              cashfreeOrderId: order.orderId,
              paymentSessionId: order.paymentSessionId,
            },
          },
          { new: true },
        );

        const plain = updated ? updated.toObject() : existingUnpaid.toObject();
        return {
          ...plain,
          cashfreeOrderId: order.orderId,
          paymentSessionId: order.paymentSessionId,
        };
      }
    }

    // Why this change is needed: Reserve a schedule slot only when creating a new appointment (not when reusing existing unpaid draft)
    // and track reservedSlotTime so that it can be safely released if booking creation fails.
    let assignedTime = 'QUEUE';
    let reservedSlotTime: string | null = null;
    const freeSlot = schedule.slots.find((s) => !s.isBooked);
    if (freeSlot) {
      freeSlot.isBooked = true;
      if (schedule._id) {
        await Schedule.updateOne(
          { _id: schedule._id, 'slots.time': freeSlot.time },
          { $set: { 'slots.$.isBooked': true } },
        );
      }
      assignedTime = freeSlot.time;
      reservedSlotTime = freeSlot.time;
    }

    // Why this helper is needed: If the booking flow fails (gateway error, duplicate key retry exhaustion, or unexpected exception),
    // ensure the tentatively reserved schedule slot is released only if it genuinely belongs to this failed attempt
    // and no valid, non-cancelled appointment owns it.
    const safeReleaseSlot = async () => {
      if (!schedule._id || !reservedSlotTime) return;
      try {
        const activeOwner = await Appointment.findOne({
          doctorId: new mongoose.Types.ObjectId(String(doctorId)),
          date: String(date),
          time: reservedSlotTime,
          status: { $ne: AppointmentStatus.CANCELLED },
        }).select('_id');

        if (!activeOwner) {
          await Schedule.updateOne(
            { _id: schedule._id, 'slots.time': reservedSlotTime, 'slots.isBooked': true },
            { $set: { 'slots.$.isBooked': false } },
          );
          logger.info(
            `[AppointmentService] Safely released reserved slot ${reservedSlotTime} for doctor ${doctorId} on ${date} after failed booking attempt.`,
          );
        }
      } catch (releaseErr) {
        logger.error('[AppointmentService] Error while safely releasing reserved schedule slot:', releaseErr);
      }
    };

    let cashfreeOrderId: string | undefined;
    let paymentSessionId: string | undefined;
    let razorpayOrderId: string | undefined;
    let created: any = null;

    try {
      if (totalAmount > 0) {
        const patient = await User.findById(patientId);
        if (isRazorpay) {
          const rzpOrder = await razorpayService.createOrder(totalAmount, adminRazorpayAccountId);
          razorpayOrderId = rzpOrder.id;
        } else {
          const order = await cashfreeService.createOrder(totalAmount, {
            customerId: String(patientId),
            customerName: patient?.name,
            customerEmail: patient?.email,
            customerPhone: patient?.phone,
          });
          cashfreeOrderId = order.orderId;
          paymentSessionId = order.paymentSessionId;
        }
      }

      // Concurrency-safe token allocation with automatic retry on duplicate key collision.
      // If another concurrent booking claims the allocated token in the interim,
      // recalculate next available token and retry up to 3 times to ensure the patient gets a valid token.
      let attempts = 0;
      const maxAttempts = 3;
      let allocatedToken = tokenNumber;

      while (attempts < maxAttempts) {
        attempts++;
        if (attempts > 1) {
          allocatedToken = await nextOpNumber(String(doctorId), String(date));
        }
        try {
          created = await appointmentService.create({
            doctorId,
            patientId,
            patientName: typeof patientName === 'string' ? patientName.trim() : undefined,
            patientAge: typeof patientAge === 'number' ? patientAge : undefined,
            patientPhone: typeof patientPhone === 'string' ? patientPhone.trim() : undefined,
            date,
            time: assignedTime,
            tokenNumber: allocatedToken,
            consultationFee,
            // Persist snapshot of consultation fee at booking time to preserve historical pricing
            consultationFeeAtBooking: consultationFee,
            platformFee,
            scheduleEndTime,
            // For 0 fee bookings, immediately mark as PAID instead of NOT_PAID.
            status: AppointmentStatus.PENDING,
            paymentStatus: totalAmount === 0 ? PaymentStatus.PAID : PaymentStatus.NOT_PAID,
            cashfreeOrderId,
            paymentSessionId,
            razorpayOrderId,
          });
          break;
        } catch (err: any) {
          const isDuplicateKey =
            err?.code === 11000 ||
            (err?.name === 'MongoServerError' && typeof err?.message === 'string' && err.message.includes('duplicate key'));
          if (isDuplicateKey) {
            if (attempts < maxAttempts) {
              logger.warn(
                `[AppointmentService] Token collision on ${allocatedToken} for doctor ${doctorId} on ${date}. Retrying allocation (attempt ${attempts + 1}/${maxAttempts})...`,
              );
              continue;
            }
            // Why this change is needed: Exhausted duplicate-key retries should not leak raw MongoDB errors
            // and must safely release the reserved slot so doctor schedule does not lose capacity.
            await safeReleaseSlot();
            throw AppError.conflict(
              'Unable to allocate an appointment token due to high booking concurrency. Please try again.',
            );
          }
          throw err;
        }
      }
    } catch (bookingErr) {
      if (!created) {
        await safeReleaseSlot();
      }
      throw bookingErr;
    }

    // FIX: Send confirmation notification to the patient upon successful booking with 0 fee.
    if (totalAmount === 0 && created.patientId) {
      await notificationService.create({
        userId: String(created.patientId),
        title: 'Appointment Confirmed',
        body: `Your OP appointment with Dr. ${doctor.name} on ${created.date} is confirmed. Token No: ${created.tokenNumber}.`,
        type: NotificationType.SYSTEM,
        refId: String(created._id),
      });
    }

    if (totalAmount === 0) {
      try {
        const facility = doctor?.facilityId ? await Facility.findById(doctor.facilityId) : null;
        const patient = patientId ? await User.findById(patientId) : null;
        const recipientPhone = created.patientPhone || patient?.phone;
        const pName = created.patientName || patient?.name || 'Patient';
        const docName = doctor?.name || 'Doctor';

        if (recipientPhone) {
          void whatsappService.sendBookingConfirmation({
            recipientPhone,
            patientName: pName,
            tokenNumber: String(created.tokenNumber || tokenNumber),
            doctorName: docName,
            appointmentDate: String(date),
            facilityName: facility?.name,
          });
        }
      } catch {
        // Non-blocking
      }
    }

    const plainCreated = created.toObject();
    return {
      ...plainCreated,
      cashfreeOrderId,
      paymentSessionId,
      razorpayOrderId,
      ...(razorpayOrderId
        ? {
            razorpayKeyId: process.env.RAZORPAY_KEY_ID,
            amount: Math.round(totalAmount * 100),
            currency: 'INR',
          }
        : {}),
    };

  },

  verifyPayment: async (
    patientId: string,
    appointmentId: string,
    body: {
      cashfreeOrderId?: string;
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
      razorpaySignature?: string;
    }
  ) => {
    const { cashfreeOrderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    if (getPatientIdString(appointment.patientId) !== patientId) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }
    
    if (appointment.paymentStatus === 'PAID') {
      return appointment;
    }

    if (razorpayPaymentId && razorpaySignature) {
      const rzpOrderId = razorpayOrderId || appointment.razorpayOrderId;
      if (!rzpOrderId) {
        throw AppError.badRequest('Razorpay Order ID missing for verification');
      }
      const isValid = razorpayService.verifySignature(rzpOrderId, razorpayPaymentId, razorpaySignature);
      if (!isValid) {
        throw AppError.badRequest('Invalid Razorpay payment signature');
      }
    } else {
      const orderIdToVerify = cashfreeOrderId || appointment.cashfreeOrderId;
      if (orderIdToVerify) {
        const { isPaid } = await cashfreeService.verifyOrder(orderIdToVerify);
        if (!isPaid) {
          throw AppError.badRequest('Payment verification failed or payment is not completed.');
        }
      } else {
        throw AppError.badRequest('Missing payment payload for verification');
      }
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    if (!doctor) throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);

    const updated = await Appointment.findByIdAndUpdate(
      appointmentId,
      {
        paymentStatus: 'PAID',
        ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
      },
      { new: true }
    );


    // Create Ledger Entries
    if (appointment.consultationFee && appointment.consultationFee > 0) {
      await DoctorWalletTransaction.create({
        doctorId: doctor._id,
        adminId: doctor.adminId,
        appointmentId: appointment._id,
        amount: appointment.consultationFee,
        type: 'CREDIT_CONSULTATION',
        description: `Consultation fee for booking ${appointment.tokenNumber}`,
      });
    }

    if (appointment.platformFee && appointment.platformFee > 0) {
      await AdminBillingTransaction.create({
        adminId: doctor.adminId,
        appointmentId: appointment._id,
        amount: appointment.platformFee,
        type: 'DEBIT_PLATFORM_FEE',
        description: `Platform fee for booking ${appointment.tokenNumber}`,
      });
    }

    // FIX: Send confirmation notification to the patient upon successful payment verification.
    if (updated && updated.patientId) {
      await notificationService.create({
        userId: String((updated.patientId as any)._id || updated.patientId),
        title: 'Appointment Confirmed',
        body: `Your OP appointment with Dr. ${doctor.name} on ${updated.date} is confirmed. Token No: ${updated.tokenNumber}.`,
        type: NotificationType.SYSTEM,
        refId: String(updated._id),
      });
    }

    // Dispatch WhatsApp booking confirmation notification
    try {
      const patient = appointment.patientId ? await User.findById(appointment.patientId) : null;
      const facility = doctor?.facilityId ? await Facility.findById(doctor.facilityId) : null;
      const recipientPhone = appointment.patientPhone || patient?.phone;
      const pName = appointment.patientName || patient?.name || 'Patient';
      const docName = doctor?.name || 'Doctor';

      if (recipientPhone) {
        void whatsappService.sendBookingConfirmation({
          recipientPhone,
          patientName: pName,
          tokenNumber: String(appointment.tokenNumber || '1'),
          doctorName: docName,
          appointmentDate: String(appointment.date),
          facilityName: facility?.name,
        });
      }
    } catch {
      // Non-blocking
    }

    return updated;
  },

  updateAppointmentStatus: async (
    adminId: string,
    role: UserRole,
    appointmentId: string,
    body: {
      status?: AppointmentStatus;
      refundPhone?: string;
      refunded?: boolean;
      refundAmount?: number;
    },
  ) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.ONLY_ADMINS_UPDATE);
    }

    const { status, refundPhone, refunded, refundAmount: rawRefundAmount } = body;
    if (!status || !ADMIN_STATUS_ACTIONS.has(status)) {
      throw AppError.badRequest(MSG.STATUS_COMPLETED_OR_CANCELLED);
    }

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) {
      throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    if (!doctor) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }
    const isOwner = String(doctor.adminId) === adminId;
    if (!isOwner) {
      const facility = await Facility.findOne({ ownerId: adminId });
      if (!facility || (doctor.facilityId && String(doctor.facilityId) !== String(facility._id))) {
        throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
      }
    }

    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED
    ) {
      throw AppError.badRequest(formatAppointmentAlready(appointment.status));
    }

    const normalizedRefundPhone =
      typeof refundPhone === 'string' ? refundPhone.replace(/\D/g, '').slice(-10) : undefined;

    // OLD CANCELLATION POLICY LOGIC (Temporarily disabled in favor of manual offline refund amount entered by Admin):
    // let facilityForPolicy = null;
    // if (doctor.facilityId) {
    //   facilityForPolicy = await Facility.findById(doctor.facilityId);
    // } else if (doctor.adminId) {
    //   facilityForPolicy = await Facility.findOne({ ownerId: doctor.adminId });
    // }

    // NEW CANCELLATION LOGIC:
    // Determine authoritative refund amount for offline / walk-in appointments.
    // For offline OP appointments (time === 'QUEUE'), patients pay consultation fee in cash upfront.
    // The Admin enters the refund amount manually upon cancellation.
    const isOffline = appointment.time === 'QUEUE';
    const consultationFee = Math.max(0, Number(appointment.consultationFee) || 0);
    let resolvedRefundAmount = 0;

    if (status === AppointmentStatus.CANCELLED) {
      if (isOffline) {
        if (rawRefundAmount !== undefined && rawRefundAmount !== null) {
          const parsed = Number(rawRefundAmount);
          if (isNaN(parsed) || parsed < 0) {
            throw AppError.badRequest('Refund amount must be a valid, non-negative monetary amount');
          }
          if (parsed > consultationFee) {
            throw AppError.badRequest(
              `Refund amount (₹${parsed}) cannot exceed the consultation fee (₹${consultationFee})`,
            );
          }
          resolvedRefundAmount = Math.round(parsed);
        } else {
          // If not explicitly provided, default to consultation fee or 0
          resolvedRefundAmount = consultationFee;
        }
      } else {
        // Online appointments: patients currently cannot pay online, so no refund amount or status for consultation fee.
        resolvedRefundAmount = 0;
      }
    }

    // Cancellation metadata with authoritative refund amount
    const cancellationMeta =
      status === AppointmentStatus.CANCELLED
        ? {
            requestedAt: new Date(),
            cancelledBy: 'ADMIN' as const,
            refundPhone: normalizedRefundPhone,
            refundPolicy: undefined,
            refundAmount: resolvedRefundAmount,
            // If refund amount is 0, do not create a positive-value refund transaction or falsely report as pending.
            refunded: resolvedRefundAmount > 0 ? Boolean(refunded) : false,
          }
        : undefined;

    // OLD POLICY-BASED CANCELLATION BUILDER CALL (Kept for reference):
    // const oldCancellationMeta = status === AppointmentStatus.CANCELLED
    //   ? buildCancellationMeta({
    //       cancelledBy: 'ADMIN',
    //       bookedAt: (appointment as { createdAt?: Date }).createdAt,
    //       refundPhone: normalizedRefundPhone,
    //       refunded: typeof refunded === 'boolean' ? refunded : undefined,
    //       consultationFee: appointment.consultationFee,
    //       policy: facilityForPolicy?.cancellationPolicy,
    //     })
    //   : undefined;

    // Update appointment status and handle cancellation refund states and ledger entries idempotently for both online and offline/QUEUE appointments.
    const updated = await appointmentService.updateStatus(appointmentId, status, {
      completedAt: status === AppointmentStatus.COMPLETED ? new Date() : undefined,
      clearCompletedAt: status === AppointmentStatus.CANCELLED,
      cancelledAt: status === AppointmentStatus.CANCELLED ? new Date() : undefined,
      cancellation: cancellationMeta,
    });

    if (status === AppointmentStatus.CANCELLED) {
      const isActuallyRefunded = resolvedRefundAmount > 0 && Boolean(refunded);

      if (isActuallyRefunded && appointment.paymentStatus !== PaymentStatus.REFUNDED) {
        // Attempt online gateway refund if online payment IDs exist without failing offline/QUEUE cancellations
        if (appointment.cashfreeOrderId || appointment.razorpayPaymentId) {
          try {
            const refundAmt = updated?.cancellation?.refundAmount || resolvedRefundAmount;
            if (appointment.cashfreeOrderId) {
              await cashfreeService.issueRefund(appointment.cashfreeOrderId, refundAmt);
            } else if (appointment.razorpayPaymentId) {
              await razorpayService.issueRefund(appointment.razorpayPaymentId, refundAmt);
            }
          } catch (err) {
            console.error('Online gateway refund attempt logged warning:', err);
          }
        }

        // Update payment status to REFUNDED idempotently
        await Appointment.findByIdAndUpdate(appointmentId, {
          paymentStatus: PaymentStatus.REFUNDED,
          previousPaymentStatus: (appointment.paymentStatus || PaymentStatus.NOT_PAID) as PaymentStatus,
        });

        // Reverse ledgers for paid appointments idempotently using authoritative refund amount
        if (resolvedRefundAmount > 0) {
          await DoctorWalletTransaction.create({
            doctorId: doctor._id,
            adminId: doctor.adminId,
            appointmentId: appointment._id,
            amount: -resolvedRefundAmount,
            type: 'DEBIT_REFUND',
            description: `Refund for cancelled booking ${appointment.tokenNumber}`,
          });
        }

        // Revert platform fee in admin billing ledger ONLY for online appointments.
        // Offline OP bookings incur platform fees even if cancelled.
        if (!isOffline && appointment.platformFee && appointment.platformFee > 0) {
          await AdminBillingTransaction.create({
            adminId: doctor.adminId,
            appointmentId: appointment._id,
            amount: -appointment.platformFee,
            type: 'CREDIT_REFUND',
            description: `Platform fee refund for cancelled booking ${appointment.tokenNumber}`,
          });
        }
      }

      await doctorService.releaseSlot(
        getDoctorIdString(appointment.doctorId),
        appointment.date,
        appointment.time,
      );

      // Notify queue listeners via Socket.IO so live queue counts and active booking lists refresh in real time when an appointment is cancelled by an admin.
      await doctorService.emitSafeQueueUpdate(
        getDoctorIdString(appointment.doctorId),
        appointment.date,
        String(doctor.adminId),
      );

      // FIX: Send cancellation notification to the patient when cancelled by admin.
      if (updated && updated.patientId) {
        await notificationService.create({
          userId: String((updated.patientId as any)._id || updated.patientId),
          title: 'Appointment Cancelled',
          body: `Your OP appointment with Dr. ${doctor.name} on ${updated.date} has been cancelled by the clinic.`,
          type: NotificationType.SYSTEM,
          refId: String(updated._id),
        });
      }

      // Broadcast OP cancellation update to all mobile app users who booked for this doctor & session/date
      await appointmentService.notifySessionUsersOnCancellation(
        String(appointment._id),
        appointment.tokenNumber,
        doctor.name,
        appointment.date,
      );
    } else {
      // Synchronize appointment status update (e.g. COMPLETED) with all clients in real time
      await doctorService.emitSafeQueueUpdate(
        getDoctorIdString(appointment.doctorId),
        appointment.date,
        String(doctor.adminId),
      );

      // When an appointment is completed, check if all arrived patients are done and cancel any unmarked arrivals
      if (status === AppointmentStatus.COMPLETED) {
        await appointmentService.checkAndCancelUnmarkedAppointments(
          getDoctorIdString(appointment.doctorId),
          appointment.date,
          String(doctor.adminId),
        );
      }
    }

    return updated;
  },

  markArrivedForAdmin: async (adminId: string, role: UserRole, appointmentId: string) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.ONLY_ADMINS_ARRIVAL);
    }

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) {
      throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    if (!doctor || String(doctor.adminId) !== adminId) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw AppError.badRequest(formatAppointmentAlready(appointment.status));
    }
    if (appointment.status === AppointmentStatus.COMPLETED && appointment.arrivedAt) {
      throw AppError.badRequest(formatAppointmentAlready(appointment.status));
    }

    if (appointment.arrivedAt) {
      return appointmentService.findById(appointmentId);
    }

    const live =
      doctor.liveOp?.date === appointment.date
        ? Number(doctor.liveOp?.currentNumber || 0)
        : 0;
    const token = Number(appointment.tokenNumber);
    const alreadyCalled = live > 0 && token < live;

    // Persist arrival in the database
    const updated = await appointmentService.markArrived(appointmentId, {
      completeNow: alreadyCalled,
      consulting: live > 0 && token === live,
    });

    // Synchronize queue status in real time across Admin, Super Admin, and Mobile App
    void doctorService.emitSafeQueueUpdate(
      getDoctorIdString(appointment.doctorId),
      appointment.date,
      String(doctor.adminId),
    );

    return updated;
  },

  unmarkArrivedForAdmin: async (adminId: string, role: UserRole, appointmentId: string) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.ONLY_ADMINS_ARRIVAL);
    }

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) {
      throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    if (!doctor || String(doctor.adminId) !== adminId) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }

    if (
      appointment.status === AppointmentStatus.COMPLETED ||
      appointment.status === AppointmentStatus.CANCELLED
    ) {
      throw AppError.badRequest(`Cannot unmark arrival for a ${appointment.status} appointment.`);
    }

    if (!appointment.arrivedAt) {
      return appointment;
    }

    // Persist unmark arrival in the database
    const updated = await appointmentService.unmarkArrived(appointmentId);

    // Synchronize queue status in real time across Admin, Super Admin, and Mobile App
    void doctorService.emitSafeQueueUpdate(
      getDoctorIdString(appointment.doctorId),
      appointment.date,
      String(doctor.adminId),
    );

    return updated;
  },

  cancelByPatient: async (
    patientId: string,
    role: UserRole,
    appointmentId: string,
    refundPhoneRaw: unknown,
    refundUpiIdRaw?: unknown,
  ) => {
    if (role !== UserRole.PATIENT) {
      throw AppError.forbidden(MSG.ONLY_PATIENTS_CANCEL);
    }

    const appointment = await appointmentService.findById(appointmentId);
    if (!appointment) {
      throw AppError.notFound(MSG.APPOINTMENT_NOT_FOUND);
    }

    if (getPatientIdString(appointment.patientId) !== patientId) {
      throw AppError.forbidden(MSG.NOT_ALLOWED_APPOINTMENT);
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw AppError.badRequest(MSG.APPOINTMENT_ALREADY_CANCELLED);
    }

    if (appointment.status !== AppointmentStatus.PENDING) {
      throw AppError.badRequest(MSG.ONLY_PENDING_CANCEL);
    }

    // Allow fallback to patient phone recorded on booking snapshot or profile if refund phone wasn't explicitly supplied
    let refundPhone =
      typeof refundPhoneRaw === 'string' ? refundPhoneRaw.replace(/\D/g, '').slice(-10) : '';

    if (!refundPhone && appointment.patientPhone) {
      refundPhone = appointment.patientPhone.replace(/\D/g, '').slice(-10);
    }

    if (!/^\d{10}$/.test(refundPhone)) {
      throw AppError.badRequest(MSG.REFUND_PHONE_INVALID);
    }

    const refundUpiId =
      typeof refundUpiIdRaw === 'string' ? refundUpiIdRaw.trim() : undefined;

    const now = new Date();

    // OLD CANCELLATION POLICY CALCULATION (Temporarily disabled - online patients cannot pay consultation fee through the platform):
    // const { doctorService } = await import('./doctorService');
    // const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));
    // let facilityForPolicy = null;
    // if (doctor?.facilityId) {
    //   facilityForPolicy = await Facility.findById(doctor.facilityId);
    // } else if (doctor?.adminId) {
    //   facilityForPolicy = await Facility.findOne({ ownerId: doctor.adminId });
    // }
    // const cancellation = buildCancellationMeta({
    //   cancelledBy: 'PATIENT',
    //   bookedAt: (appointment as { createdAt?: Date }).createdAt,
    //   refundPhone,
    //   refundUpiId,
    //   policyAgreedAt: now,
    //   consultationFee: appointment.consultationFee,
    //   policy: facilityForPolicy?.cancellationPolicy,
    // });

    // NEW CANCELLATION LOGIC:
    // Online appointment cancellation simply marks the booking as Cancelled.
    // Do not apply facility cancellation policy or calculate refund percentages.
    // Do not create a refund amount, refund transaction, or refund status for the consultation fee.
    const cancellation = {
      requestedAt: now,
      cancelledBy: 'PATIENT' as const,
      refundPhone,
      refundUpiId,
      refundAmount: 0,
      refunded: false,
      refundPolicy: undefined,
    };

    const updated = await appointmentService.updateStatus(
      appointmentId,
      AppointmentStatus.CANCELLED,
      {
        clearCompletedAt: true,
        cancelledAt: now,
        cancellation,
      },
    );

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(getDoctorIdString(appointment.doctorId));

    await doctorService.releaseSlot(
      getDoctorIdString(appointment.doctorId),
      appointment.date,
      appointment.time,
    );

    // Notify queue listeners via Socket.IO so live queue counts and active booking lists refresh in real time when an offline or online booking is cancelled by a patient.
    await doctorService.emitSafeQueueUpdate(
      getDoctorIdString(appointment.doctorId),
      appointment.date,
      doctor?.adminId ? String(doctor.adminId) : undefined,
    );

    // FIX: Send cancellation notification to the patient upon successful cancellation.
    if (updated && updated.patientId) {
      await notificationService.create({
        userId: String((updated.patientId as any)._id || updated.patientId),
        title: 'Appointment Cancelled',
        body: `Your OP appointment with Dr. ${doctor?.name} on ${updated.date} has been cancelled.`,
        type: NotificationType.SYSTEM,
        refId: String(updated._id),
      });
    }

    // Broadcast OP cancellation update to all mobile app users who booked for this doctor & session/date
    await appointmentService.notifySessionUsersOnCancellation(
      String(appointment._id),
      appointment.tokenNumber,
      doctor?.name,
      appointment.date,
    );

    return updated;
  },

  getFacilityPatients: async (
    adminId: string,
    role: UserRole,
    query: {
      search?: string;
      fromDate?: string;
      toDate?: string;
      page?: number;
      limit?: number;
      refundStatus?: 'pending' | 'refunded';
      bookingType?: 'online' | 'offline';
      patientType?: 'registered' | 'walkin';
      status?: string;
      dayOfWeek?: number;
    },
  ) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.NOT_ALLOWED);
    }

    const { doctorService } = await import('./doctorService');
    const doctors = await doctorService.getByAdmin(adminId);
    // Pass status parameter to getDistinctPatients so when the Cancelled card is selected, the patient list is filtered to only patients with cancelled appointments.
    return appointmentService.getDistinctPatients({
      doctorIds: doctors.map((doc) => doc._id as unknown as mongoose.Types.ObjectId),
      search: query.search,
      fromDate: query.fromDate,
      toDate: query.toDate,
      page: query.page,
      limit: query.limit,
      refundStatus: query.refundStatus,
      bookingType: query.bookingType,
      patientType: query.patientType,
      status: query.status,
      dayOfWeek: query.dayOfWeek,
    });
  },

  getFacilityPatientDetail: async (adminId: string, role: UserRole, patientId: string) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.NOT_ALLOWED);
    }

    const { doctorService } = await import('./doctorService');
    const doctors = await doctorService.getByAdmin(adminId);
    const doctorIds = doctors.map(
      (doc) => doc._id as unknown as mongoose.Types.ObjectId,
    );

    const appointments = await appointmentService.getByPatientAndDoctors(patientId, doctorIds);
    const first = appointments[0];
    if (!first) {
      throw AppError.notFound(MSG.PATIENT_NOT_FOR_FACILITY);
    }

    // Look for a populated User account in the patient's appointments if available
    const apptWithUser = appointments.find(
      (a) => typeof a.patientId === 'object' && a.patientId,
    );
    const rawUser = apptWithUser?.patientId as any;
    const userDoc = rawUser
      ? (typeof rawUser.toObject === 'function' ? rawUser.toObject() : rawUser)
      : null;

    // Resolve patient demographic fields across user account and all retrieved appointments so records with missing individual fields remain complete.
    const resolvedName =
      appointments.find((a) => a.patientName?.trim())?.patientName?.trim() ||
      (userDoc as any)?.name ||
      first.patientName ||
      'Patient';
    const resolvedPhone =
      appointments.find((a) => a.patientPhone?.trim())?.patientPhone?.trim() ||
      (userDoc as any)?.phone ||
      first.patientPhone ||
      '';
    const resolvedAge =
      appointments.find((a) => a.patientAge != null)?.patientAge ??
      (userDoc as any)?.age ??
      first.patientAge;

    const patient = userDoc
      ? {
          ...userDoc,
          name: resolvedName,
          phone: resolvedPhone,
          age: resolvedAge,
        }
      : {
          _id: patientId,
          name: resolvedName,
          phone: resolvedPhone,
          age: resolvedAge,
          gender: 'other',
          place: '',
          address: '',
        };

    const doctorsSeen = new Map<string, { doctor: unknown; bookingCount: number }>();
    for (const appt of appointments) {
      const doctor = appt.doctorId as { _id?: unknown } | string;
      const id =
        typeof doctor === 'object' && doctor && '_id' in doctor
          ? String(doctor._id)
          : String(doctor);
      const existing = doctorsSeen.get(id);
      if (existing) {
        existing.bookingCount += 1;
      } else {
        doctorsSeen.set(id, { doctor: appt.doctorId, bookingCount: 1 });
      }
    }

    return {
      patient,
      bookingCount: appointments.length,
      doctors: Array.from(doctorsSeen.values()),
      appointments,
    };
  },

  updateFacilityPatientDetail: async (
    adminId: string,
    role: UserRole,
    patientId: string,
    body: {
      name?: string;
      phone?: string;
      age?: number;
      gender?: string;
      place?: string;
      address?: string;
    },
  ) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.NOT_ALLOWED);
    }

    const { doctorService } = await import('./doctorService');
    const doctors = await doctorService.getByAdmin(adminId);
    const doctorIds = doctors.map(
      (doc) => doc._id as unknown as mongoose.Types.ObjectId,
    );

    const appointments = await appointmentService.getByPatientAndDoctors(patientId, doctorIds);
    if (!appointments.length) {
      throw AppError.notFound(MSG.PATIENT_NOT_FOR_FACILITY);
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw AppError.badRequest('Name cannot be empty');
      updates.name = name;
    }
    if (body.phone !== undefined) {
      const phoneDigits = String(body.phone).replace(/\D/g, '');
      if (phoneDigits.length !== 10) {
        throw AppError.badRequest('Contact Number must be exactly 10 digits');
      }
      updates.phone = phoneDigits;
    }
    if (body.age !== undefined) {
      const ageNum = Number(body.age);
      if (isNaN(ageNum) || ageNum <= 0 || ageNum > 150) {
        throw AppError.badRequest('Please enter a valid age');
      }
      updates.age = ageNum;
    }
    if (body.gender !== undefined) {
      updates.gender = String(body.gender).trim();
    }
    if (body.place !== undefined) {
      updates.place = String(body.place).trim();
    }
    if (body.address !== undefined) {
      updates.address = String(body.address).trim();
    }

    const updatedUser = await User.findByIdAndUpdate(patientId, updates, {
      new: true,
      runValidators: true,
    }).select('-password');

    if (!updatedUser) {
      throw AppError.notFound('Patient not found');
    }

    return updatedUser;
  },

  bookOfflineAppointment: async (
    adminId: string,
    role: UserRole,
    body: {
      doctorId?: unknown;
      date?: unknown;
      tokenNumber?: unknown;
      patientName?: unknown;
      patientPhone?: unknown;
      patientAge?: unknown;
    },
  ) => {
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.NOT_ALLOWED);
    }

    const { doctorId, date, tokenNumber, patientName, patientPhone, patientAge } = body;
    if (!doctorId || !date || tokenNumber == null || !patientName || !patientPhone) {
      throw AppError.badRequest(MSG.OFFLINE_BOOKING_REQUIRED);
    }
    if (patientAge == null || isNaN(Number(patientAge)) || Number(patientAge) <= 0) {
      throw AppError.badRequest('Age is required');
    }

    const opNumber = Number(tokenNumber);
    if (!Number.isInteger(opNumber) || opNumber < 1) {
      throw AppError.badRequest(MSG.OP_NUMBER_INVALID);
    }

    const { doctorService } = await import('./doctorService');
    const doctor = await doctorService.findById(String(doctorId));
    if (!doctor || String(doctor.adminId) !== adminId) {
      throw AppError.notFound(MSG.DOCTOR_NOT_FOUND);
    }

    const schedule = await doctorService.getSchedule(String(doctorId), String(date));
    if (!schedule || schedule.isClosed) {
      throw AppError.badRequest(MSG.NO_SCHEDULE_CREATE_FIRST);
    }

    const sameDayLive = doctor.liveOp?.date === String(date);
    const currentOp = sameDayLive ? Number(doctor.liveOp?.currentNumber || 0) : 0;
    if (opNumber <= currentOp) {
      throw AppError.badRequest(formatOpNotUpcoming(opNumber, currentOp));
    }

    if (await isOpNumberTaken(String(doctorId), String(date), opNumber)) {
      throw AppError.badRequest(formatOpAlreadyBooked(opNumber));
    }

    // Why this change is needed: Remove unused authService import to fix ESLint unused-vars warning.
    const { toLocalPhone } = await import('./authService');
    const phone = toLocalPhone(String(patientPhone));

    // Check if a genuine registered app patient exists (termsAcceptedAt != null) to associate the appointment safely.
    const registeredPatient = await User.findOne({
      phone: { $regex: phone.slice(-10), $options: 'i' },
      role: UserRole.PATIENT,
      termsAcceptedAt: { $ne: null },
    });

    const assignedPatientId = registeredPatient ? registeredPatient._id : undefined;

    // Check daily booking limit for this patient phone / account on the selected date.
    const activeBookingCount = await Appointment.countDocuments({
      date: String(date),
      status: { $ne: AppointmentStatus.CANCELLED },
      $or: [
        { patientPhone: { $regex: phone.slice(-10), $options: 'i' } },
        ...(assignedPatientId ? [{ patientId: assignedPatientId }] : []),
      ],
    });

    if (activeBookingCount >= MAX_BOOKINGS_PER_PATIENT_PER_DAY) {
      throw AppError.badRequest(MSG.PATIENT_DAY_LIMIT);
    }

    // Guest offline bookings do not create registered patient accounts, so patientId remains unlinked until the patient genuinely registers.
    // Concurrency-safe offline booking creation: If another booking claimed the requested token in the interim,
    // catch the database duplicate key constraint cleanly and report that the OP number is already booked.
    let created: any;
    try {
      created = await appointmentService.create({
        doctorId,
        patientId: assignedPatientId,
        patientName: typeof patientName === 'string' ? patientName.trim() : undefined,
        patientAge: typeof patientAge === 'number' ? Number(patientAge) : patientAge ? Number(patientAge) : undefined,
        patientPhone: phone,
        date,
        time: 'QUEUE',
        tokenNumber: String(opNumber),
        consultationFee: doctor.consultationFee ?? 0,
        // Persist snapshot of consultation fee at booking time to preserve historical pricing
        consultationFeeAtBooking: doctor.consultationFee ?? 0,
        platformFee: await platformFeeService.get(),
        scheduleEndTime:
          schedule.endTime || schedule.slots[schedule.slots.length - 1]?.time || undefined,
        status: AppointmentStatus.PENDING,
      });
    } catch (err: any) {
      const isDuplicateKey =
        err?.code === 11000 ||
        (err?.name === 'MongoServerError' && typeof err?.message === 'string' && err.message.includes('duplicate key'));
      if (isDuplicateKey) {
        throw AppError.badRequest(formatOpAlreadyBooked(opNumber));
      }
      throw err;
    }

    const [appointment] = await appointmentService.getAll({ _id: created._id });

    // Under Business Rule 3, record the applicable platform fee debit for offline OP bookings in the billing ledger.
    if (created.platformFee && created.platformFee > 0) {
      const AdminBillingTransaction = (await import('../models/AdminBillingTransaction')).default;
      const monthKey = String(date).slice(0, 7);
      await AdminBillingTransaction.create({
        adminId: doctor.adminId,
        facilityId: doctor.facilityId,
        appointmentId: created._id,
        amount: created.platformFee,
        type: 'DEBIT_PLATFORM_FEE',
        monthKey,
        paymentMethod: 'SYSTEM',
        approvalStatus: 'CONFIRMED',
        description: `Platform fee for offline booking OP #${created.tokenNumber || opNumber}`,
      });
    }

    // FIX: Send confirmation notification for offline booking if patient is registered.
    if (created.patientId) {
      await notificationService.create({
        userId: String((created.patientId as any)._id || created.patientId),
        title: 'Appointment Confirmed',
        body: `Your offline OP appointment with Dr. ${doctor.name} on ${created.date} is confirmed. Token No: ${created.tokenNumber}.`,
        type: NotificationType.SYSTEM,
        refId: String(created._id),
      });
    }

    if (phone) {
      try {
        const facility = doctor.facilityId ? await Facility.findById(doctor.facilityId) : null;
        void whatsappService.sendBookingConfirmation({
          recipientPhone: phone,
          patientName: String(patientName || 'Patient'),
          tokenNumber: String(created.tokenNumber || opNumber),
          doctorName: doctor.name || 'Doctor',
          appointmentDate: String(date),
          facilityName: facility?.name,
        });
      } catch {
        // Non-blocking
      }
    }

    return appointment || created;
  },

  /**
   * Move a contiguous pending OP range from one doctor to another on the same date.
   * Tokens are reassigned on the target in the same relative order (ascending source tokens).
   */
  movePendingOps: async (args: {
    fromDoctorId: string;
    toDoctorId: string;
    date: string;
    fromOp: number;
    toOp: number;
    adminId: string;
    closeSource?: boolean;
  }) => {
    const { fromDoctorId, toDoctorId, date, fromOp, toOp, adminId, closeSource = true } = args;

    if (!Number.isInteger(fromOp) || !Number.isInteger(toOp) || fromOp < 1 || toOp < fromOp) {
      throw AppError.badRequest(MSG.MOVE_OP_RANGE_INVALID);
    }
    if (fromDoctorId === toDoctorId) {
      throw AppError.badRequest(MSG.MOVE_OP_SAME_DOCTOR);
    }

    const { doctorService } = await import('./doctorService');
    await doctorService.requireOwnedDoctor(fromDoctorId, adminId);
    await doctorService.requireOwnedDoctor(toDoctorId, adminId);

    const targetSchedule = await doctorService.getSchedule(toDoctorId, date);
    if (!targetSchedule || targetSchedule.isClosed) {
      throw AppError.badRequest(MSG.MOVE_OP_TARGET_CLOSED);
    }

    const fromDoctor = await doctorService.findById(fromDoctorId);
    const liveOp =
      fromDoctor?.liveOp?.date === date ? Number(fromDoctor.liveOp.currentNumber || 0) : 0;

    const sourceAppointments = await Appointment.find({
      doctorId: fromDoctorId,
      date,
      status: {
        $in: [AppointmentStatus.PENDING, AppointmentStatus.CONSULTING],
      },
    }).sort({ tokenNumber: 1 });

    const toMove = sourceAppointments.filter((appt) => {
      const token = Number(appt.tokenNumber);
      if (!Number.isInteger(token) || token < fromOp || token > toOp) return false;
      // Only pending / upcoming queue — do not move already-served tokens behind live OP.
      return liveOp <= 0 || token > liveOp;
    });

    if (toMove.length === 0) {
      throw AppError.badRequest(MSG.MOVE_OP_NO_APPOINTMENTS);
    }

    if (targetSchedule.maxTokens != null) {
      const bookedCount = await appointmentService.countActiveForDoctorDate(toDoctorId, date);
      if (bookedCount + toMove.length > targetSchedule.maxTokens) {
        throw AppError.badRequest(MSG.MOVE_OP_TARGET_FULL);
      }
    }

    const moved: Array<{
      appointmentId: string;
      fromToken: string;
      toToken: string;
      patientId: string;
    }> = [];

    for (const appt of toMove) {
      const fromToken = String(appt.tokenNumber || '');
      const toToken = await nextOpNumber(toDoctorId, date);
      await Appointment.findByIdAndUpdate(appt._id, {
        $set: {
          doctorId: toDoctorId,
          tokenNumber: toToken,
          status: AppointmentStatus.PENDING,
          arrivedAt: null,
          completedAt: null,
        },
      });
      moved.push({
        appointmentId: String(appt._id),
        fromToken,
        toToken,
        patientId: String(appt.patientId),
      });
    }

    let closedSchedule = null;
    if (closeSource) {
      closedSchedule = await doctorService.setScheduleClosed(fromDoctorId, date, true);
    }

    return {
      movedCount: moved.length,
      fromDoctorId,
      toDoctorId,
      date,
      fromOp,
      toOp,
      moved,
      scheduleClosed: Boolean(closedSchedule),
    };
  },

  // Search previous OP bookings by phone so facility admins can quickly reuse the actual patient's name and age for offline booking.
  lookupPatientByPhone: async (adminId: string, phoneRaw: string) => {
    const phoneDigits = String(phoneRaw || '').replace(/\D/g, '');
    if (phoneDigits.length < 5) return [];

    const searchDigits = phoneDigits.slice(-10);

    // Filter doctors belonging to the logged-in facility admin to guarantee strict facility data scoping.
    let doctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(adminId) })
      .select('_id')
      .lean();
    
    if (doctors.length === 0) {
      // Fallback: Check if the admin user is a facility owner and query doctors by facilityId.
      const facility = await Facility.findOne({ ownerId: new mongoose.Types.ObjectId(adminId) }).select('_id').lean();
      if (facility) {
        doctors = await Doctor.find({ facilityId: facility._id }).select('_id').lean();
      }
    }
    
    if (doctors.length === 0) return [];
    const doctorIds = doctors.map((d) => d._id);

    // Search registered account users matching the phone number.
    const matchingUsers = await User.find({
      phone: { $regex: searchDigits, $options: 'i' },
    })
      .select('_id name age phone')
      .lean();
    const userIds = matchingUsers.map((u) => u._id);

    // Fetch existing online and offline OP bookings matching the phone number or registered user IDs for doctors in this facility.
    const appointments = await Appointment.find({
      doctorId: { $in: doctorIds },
      $or: [
        { patientPhone: { $regex: searchDigits, $options: 'i' } },
        { patientId: { $in: userIds } },
      ],
    })
      .populate({ path: 'patientId', select: 'name age phone' })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // Show unique patients previously booked with this phone number while keeping the booking account owner separate from the actual patient.
    const uniqueMap = new Map<string, { name: string; age?: number; phone: string }>();

    for (const appt of appointments) {
      // Preserve patient identity from actual appointment details over registered user account name.
      const name = (appt.patientName || (appt.patientId as any)?.name || '').trim();
      if (!name) continue;
      const age = appt.patientAge ?? (appt.patientId as any)?.age;
      const phone = appt.patientPhone || (appt.patientId as any)?.phone || phoneDigits;

      // Deduplicate patient suggestions by unique name and age combination.
      const key = `${name.toLowerCase()}_${age ?? ''}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, {
          name,
          age: age != null ? Number(age) : undefined,
          phone,
        });
      }
    }

    return Array.from(uniqueMap.values());
  },
};
