import Appointment from '../models/Appointment';
import { AppointmentStatus } from '../constants/enums';
import { getNowInAppTz } from '../utils/dateTime';
import { doctorService } from './doctorService';
import { appointmentService } from './appointmentService';
import { logger } from '../utils/logger';

/**
 * Parse scheduled date and time into a precise Date object in Asia/Kolkata timezone (+05:30).
 * Handles formats: "09:30 AM", "02:15 PM", "14:30", "QUEUE", etc.
 */
export const parseAppointmentScheduledDateTime = (
  date: string,
  time?: string,
  scheduleEndTime?: string,
): Date => {
  // If time is walk-in QUEUE or missing, use scheduleEndTime if available, else end-of-day (23:59)
  const rawTime = (!time || time === 'QUEUE') ? (scheduleEndTime || '23:59') : time;

  let hours = 23;
  let minutes = 59;

  const match12 = rawTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match12 && match12[1] && match12[2]) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2], 10);
    const meridiem = match12[3]?.toUpperCase();

    if (meridiem === 'PM' && h < 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;

    hours = h;
    minutes = m;
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  // Construct ISO timestamp anchored in Asia/Kolkata (+05:30)
  return new Date(`${date}T${pad(hours)}:${pad(minutes)}:00.000+05:30`);
};

/**
 * Automatically cancels OP appointments that remain PENDING and whose scheduled date and time
 * are more than 24 hours in the past, without requiring Admin intervention.
 * 
 * Rules & constraints:
 * - Cancels appointments that are still PENDING and whose patients were never marked as arrived (!arrivedAt).
 * - Under NO circumstances marks unconsulted appointments as COMPLETED.
 * - Strictly preserves arrived patients: never cancels patients who were marked as arrived.
 * - Does not modify appointments that are already COMPLETED or CANCELLED.
 * - Does not create a refund (refundAmount: 0, refunded: false).
 * - Safe & idempotent: repeated runs do not duplicate cancellations or financial transactions.
 * - Broadcasts real-time queue updates via Socket.IO across all connected clients.
 */
export const autoCancelPastDuePendingAppointments = async (): Promise<number> => {
  try {
    const now = new Date();
    const cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffMs);

    // Get cutoff date string in Asia/Kolkata (+05:30)
    const { date: cutoffDateInAppTz } = getNowInAppTz(cutoffDate);

    // Find appointments that remain PENDING, were never marked as arrived (!arrivedAt),
    // and have a scheduled date on or before the cutoff date string.
    const candidates = await Appointment.find({
      status: AppointmentStatus.PENDING,
      arrivedAt: null,
      date: { $lte: cutoffDateInAppTz },
    }).populate('doctorId', 'adminId');

    if (candidates.length === 0) return 0;

    let cancelledCount = 0;
    const affectedDoctorDates = new Set<string>();

    for (const appt of candidates) {
      const scheduledDateTime = parseAppointmentScheduledDateTime(
        appt.date,
        appt.time,
        appt.scheduleEndTime,
      );

      // Check if strictly more than 24 hours have elapsed since scheduled date and time
      if (now.getTime() - scheduledDateTime.getTime() >= 24 * 60 * 60 * 1000) {
        await Appointment.findByIdAndUpdate(appt._id, {
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
        });

        // Release doctor slot if appointment was a scheduled time slot
        if (appt.time && appt.time !== 'QUEUE') {
          const docId = String((appt.doctorId as any)?._id || appt.doctorId);
          try {
            await doctorService.releaseSlot(docId, appt.date, appt.time);
          } catch {
            // Ignore slot release error if slot was already freed
          }
        }

        cancelledCount++;
        const docIdStr = String((appt.doctorId as any)?._id || appt.doctorId);
        const adminIdStr = String((appt.doctorId as any)?.adminId || '');
        affectedDoctorDates.add(`${docIdStr}|${appt.date}|${adminIdStr}`);

        // Notify session app users about the cancelled token
        void appointmentService.notifySessionUsersOnCancellation(
          String(appt._id),
          appt.tokenNumber,
          (appt.doctorId as any)?.name,
          appt.date,
        );
      }
    }

    // Broadcast real-time queue updates for each modified doctor/date across all clients
    for (const key of affectedDoctorDates) {
      const parts = key.split('|');
      const doctorId = parts[0];
      const date = parts[1];
      const adminId = parts[2];
      if (doctorId && date) {
        void doctorService.emitSafeQueueUpdate(doctorId, date, adminId || undefined);
      }
    }

    if (cancelledCount > 0) {
      logger.info(
        `[Scheduler] Automatically cancelled ${cancelledCount} unmarked PENDING OP appointments older than 24 hours with reason PATIENT_NOT_ARRIVED.`,
      );
    }

    return cancelledCount;
  } catch (error) {
    logger.error('[Scheduler] Error in autoCancelPastDuePendingAppointments:', error);
    return 0;
  }
};

/**
 * Backward compatibility alias:
 * Replaces the legacy 24-hour auto-completion process to ensure no unconsulted appointments
 * are ever marked as COMPLETED. Points directly to autoCancelPastDuePendingAppointments.
 */
export const autoCompletePastDueAppointments = autoCancelPastDuePendingAppointments;

/**
 * Automatically cancel past day appointments where the patient was never marked as arrived
 * and the consultation date has passed.
 * - Idempotent and preserves arrived patients.
 * - Emits real-time queue updates for affected doctors.
 */
export const cancelUnmarkedPastAppointments = async (): Promise<number> => {
  try {
    const now = new Date();
    const { date: todayInAppTz } = getNowInAppTz(now);

    // Find appointments from past days that were never marked as arrived and remain pending
    const pastUnmarked = await Appointment.find({
      status: AppointmentStatus.PENDING,
      arrivedAt: null,
      date: { $lt: todayInAppTz },
    }).populate('doctorId', 'adminId');

    if (pastUnmarked.length === 0) return 0;

    const ids = pastUnmarked.map((a) => a._id);
    await Appointment.updateMany(
      { _id: { $in: ids } },
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

    const affectedDoctorDates = new Set<string>();
    for (const appt of pastUnmarked) {
      if (appt.time && appt.time !== 'QUEUE') {
        const docId = String((appt.doctorId as any)?._id || appt.doctorId);
        try {
          await doctorService.releaseSlot(docId, appt.date, appt.time);
        } catch {
          // Ignore slot release error if slot was already freed
        }
      }
      const docIdStr = String((appt.doctorId as any)?._id || appt.doctorId);
      const adminIdStr = String((appt.doctorId as any)?.adminId || '');
      affectedDoctorDates.add(`${docIdStr}|${appt.date}|${adminIdStr}`);

      // Notify session app users about the cancelled token
      void appointmentService.notifySessionUsersOnCancellation(
        String(appt._id),
        appt.tokenNumber,
        (appt.doctorId as any)?.name,
        appt.date,
      );
    }

    // Synchronize queue updates in real-time across all clients
    for (const key of affectedDoctorDates) {
      const parts = key.split('|');
      const doctorId = parts[0];
      const date = parts[1];
      const adminId = parts[2];
      if (doctorId && date) {
        void doctorService.emitSafeQueueUpdate(doctorId, date, adminId || undefined);
      }
    }

    logger.info(`[Scheduler] Cleaned up ${pastUnmarked.length} past unmarked appointments to CANCELLED.`);
    return pastUnmarked.length;
  } catch (error) {
    logger.error('[Scheduler] Error in cancelUnmarkedPastAppointments:', error);
    return 0;
  }
};

/**
 * Start the background scheduler.
 * NOTE: The 24-hour and elapsed-time automatic cancellation fallback has been removed.
 * Automatic cancellation of pending, unarrived appointments is strictly triggered ONLY
 * when the Admin explicitly ends/closes the doctor's OP session (Schedule.isClosed === true).
 * An OP session that has not been explicitly ended must not trigger automatic cancellation,
 * regardless of how much time has elapsed.
 */
export const startAppointmentScheduler = () => {
  logger.info(
    '[Scheduler] Automated OP cancellation is strictly bound to explicit Admin OP session closure (isClosed: true). 24-hour elapsed timer is disabled.',
  );
};

