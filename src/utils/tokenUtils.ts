import Appointment from '../models/Appointment';
import { AppointmentStatus } from '../constants/enums';

/** Active (non-cancelled) OP numbers already assigned for a doctor on a date. */
export const getTakenOpNumbers = async (
  doctorId: string,
  date: string,
): Promise<Set<number>> => {
  const appointments = await Appointment.find({
    doctorId,
    date,
    status: { $ne: AppointmentStatus.CANCELLED },
  }).select('tokenNumber');

  const taken = new Set<number>();
  for (const appt of appointments) {
    const n = Number(appt.tokenNumber);
    if (Number.isInteger(n) && n > 0) taken.add(n);
  }
  return taken;
};

/**
 * Next free OP number for patient booking — smallest positive integer
 * not already assigned (skips offline-reserved numbers).
 */
export const nextOpNumber = async (doctorId: string, date: string) => {
  const taken = await getTakenOpNumbers(doctorId, date);
  let next = 1;
  while (taken.has(next)) next += 1;
  return String(next);
};

export const isOpNumberTaken = async (
  doctorId: string,
  date: string,
  tokenNumber: number,
) => {
  const taken = await getTakenOpNumbers(doctorId, date);
  return taken.has(tokenNumber);
};
