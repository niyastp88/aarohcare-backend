import DoctorWalletTransaction from '../models/DoctorWalletTransaction';
import AdminBillingTransaction from '../models/AdminBillingTransaction';
import AdminBillingOrder from '../models/AdminBillingOrder';
import Doctor from '../models/Doctor';
import User from '../models/User';
import Facility from '../models/Facility';
import Appointment from '../models/Appointment';
import { AppointmentStatus, PaymentStatus } from '../constants/enums';
import { AppError } from '../utils/AppError';

import { razorpayService } from './razorpayService';
import { cashfreeService } from './cashfreeService';
import mongoose from 'mongoose';

/**
 * Idempotent reconciliation and backfill helper for offline appointment platform fees.
 * EXPLANATION OF BILLING RULE:
 * 1. Every offline OP appointment (time === 'QUEUE') incurs a platform fee charge based on its saved platformFee (or default 3 if missing), regardless of cancellation or confirmation status.
 * 2. If an offline appointment is missing its DEBIT_PLATFORM_FEE transaction in AdminBillingTransaction, this helper creates it idempotently.
 * 3. Cancelling an offline appointment must NOT refund the platform fee to the Admin. If an invalid CREDIT_REFUND transaction exists for an offline appointment, this helper creates an auditable DEBIT_PLATFORM_FEE correction transaction to reverse the invalid refund credit.
 */
export const reconcileOfflineBillingLedger = async (targetAdminId?: string) => {
  const Appointment = (await import('../models/Appointment')).default;
  const Doctor = (await import('../models/Doctor')).default;

  const apptQuery: Record<string, any> = { time: 'QUEUE' };
  
  if (targetAdminId) {
    const doctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(targetAdminId) }).select('_id').lean();
    apptQuery.doctorId = { $in: doctors.map((d) => d._id) };
  }

  const offlineAppts = await Appointment.find(apptQuery).lean();
  if (!offlineAppts.length) return;

  const docIds = Array.from(new Set(offlineAppts.map((a) => String(a.doctorId))));
  const doctors = await Doctor.find({ _id: { $in: docIds } }).select('_id adminId').lean();
  const docMap = new Map(doctors.map((d) => [String(d._id), d]));

  for (const appt of offlineAppts) {
    const doc = docMap.get(String(appt.doctorId));
    if (!doc || !doc.adminId) continue;

    const adminObjectId = doc.adminId;
    const fee = Number(appt.platformFee || 3);
    const monthKey = appt.date ? appt.date.slice(0, 7) : (appt.createdAt ? new Date(appt.createdAt).toISOString().slice(0, 7) : '');

    // 1. Idempotently create DEBIT_PLATFORM_FEE if missing
    const existingDebit = await AdminBillingTransaction.findOne({
      appointmentId: appt._id,
      type: 'DEBIT_PLATFORM_FEE',
      description: { $not: /Reversal|Correction/i },
    });

    if (!existingDebit) {
      await AdminBillingTransaction.create({
        adminId: adminObjectId,
        appointmentId: appt._id,
        amount: fee,
        type: 'DEBIT_PLATFORM_FEE',
        monthKey,
        createdAt: appt.createdAt || new Date(),
        description: `Platform fee debit of ₹${fee} accrued for offline booking token #${appt.tokenNumber || ''}`,
      });
    }

    // 2. Idempotently reverse invalid offline CREDIT_REFUND credits if present
    const existingRefunds = await AdminBillingTransaction.find({
      appointmentId: appt._id,
      type: 'CREDIT_REFUND',
    }).lean();

    for (const refTx of existingRefunds) {
      const correctionDesc = `Auditable correction reversing invalid offline refund credit for booking token #${appt.tokenNumber || ''}`;
      const existingCorrection = await AdminBillingTransaction.findOne({
        appointmentId: appt._id,
        type: 'DEBIT_PLATFORM_FEE',
        description: correctionDesc,
      });

      if (!existingCorrection) {
        await AdminBillingTransaction.create({
          adminId: adminObjectId,
          appointmentId: appt._id,
          amount: Math.abs(refTx.amount),
          type: 'DEBIT_PLATFORM_FEE',
          monthKey,
          createdAt: new Date(),
          description: correctionDesc,
        });
      }
    }
  }
};

// Helper to extract a unique payment reference key for deduplicating repeated gateway callbacks or duplicate ledger records
const getPaymentReferenceKey = (tx: any): string => {
  if (tx.paymentId) return String(tx.paymentId);
  if (tx.orderId) return String(tx.orderId);
  if (tx.description) {
    const match = tx.description.match(/(ord_[a-zA-Z0-9_]+|Order\s*#?\s*[a-zA-Z0-9_]+)/i);
    if (match) return match[0];
  }
  return String(tx._id);
};

// Fetch platform dues for a facility admin, aggregating Lab Reports for diagnostic labs and Appointments for clinics while keeping financial ledger data separate.
// EXPLANATION OF BILLING RULE:
// Confirmed payments (approvalStatus === 'CONFIRMED' or legacy undefined) reduce outstanding dues.
// Pending payment claims (approvalStatus === 'PENDING_APPROVAL') are shown separately and do NOT reduce dues until Super Admin approval.
// Duplicate payment records with the same order/payment reference are deduplicated so only verified payments are counted.
// Oldest-month-first (FIFO) payment allocation applies confirmed payments sequentially across historical billing months.
const fetchAdminBillingDues = async (adminId: string, yearInput?: number) => {
  const selectedYear = Number(yearInput) || new Date().getFullYear();
  await reconcileOfflineBillingLedger(adminId);

  const Doctor = (await import('../models/Doctor')).default;
  const Appointment = (await import('../models/Appointment')).default;
  const Facility = (await import('../models/Facility')).default;
  const LabReport = (await import('../models/LabReport')).default;
  const { platformFeeService } = await import('./platformFeeService');

  const facility = await Facility.findOne({ ownerId: new mongoose.Types.ObjectId(adminId) }).lean();
  const isLab = facility?.facilityType === 'LAB';
  const configuredPlatformFee = await platformFeeService.get();

  const txns = await AdminBillingTransaction.find({
    adminId: new mongoose.Types.ObjectId(adminId),
  })
    .populate('appointmentId', 'tokenNumber date consultationFee platformFee')
    .sort({ createdAt: -1 })
    .lean();

  let totalFeesPaid = 0;
  let totalPendingClaims = 0;
  let totalRefundCredits = 0;
  const seenPaymentKeys = new Set<string>();

  const correctionFeeByMonth = new Map<string, number>();
  const targetedPaidByMonth = new Map<string, number>();
  let generalPaymentPool = 0;

  for (const tx of txns) {
    const amt = Number(tx.amount || 0);
    if (tx.type === 'CREDIT_PAYMENT_TO_SUPERADMIN') {
      const paymentKey = getPaymentReferenceKey(tx);
      if (seenPaymentKeys.has(paymentKey)) {
        continue; // Deduplicate payment transactions sharing the same order/payment reference
      }
      seenPaymentKeys.add(paymentKey);

      if (tx.approvalStatus === 'PENDING_APPROVAL') {
        totalPendingClaims += Math.abs(amt);
      } else if (tx.approvalStatus === 'CONFIRMED' || !tx.approvalStatus) {
        const confirmedAmt = Math.abs(amt);
        totalFeesPaid += confirmedAmt;

        if (tx.monthKey) {
          const keys = String(tx.monthKey).split(',').map((k: string) => k.trim()).filter(Boolean);
          if (keys.length > 0) {
            const perKeyAmt = confirmedAmt / keys.length;
            for (const k of keys) {
              targetedPaidByMonth.set(k, (targetedPaidByMonth.get(k) || 0) + perKeyAmt);
            }
          } else {
            generalPaymentPool += confirmedAmt;
          }
        } else {
          generalPaymentPool += confirmedAmt;
        }
      }
    } else if (tx.type === 'CREDIT_REFUND') {
      totalRefundCredits += Math.abs(amt);
    } else if (tx.type === 'DEBIT_PLATFORM_FEE') {
      if (tx.description && /Reversal|Correction/i.test(tx.description)) {
        const mKey = tx.monthKey || (tx.createdAt ? new Date(tx.createdAt).toISOString().slice(0, 7) : '');
        if (mKey) {
          correctionFeeByMonth.set(mKey, (correctionFeeByMonth.get(mKey) || 0) + amt);
        }
      }
    }
  }

  let totalFeesAccrued = 0;
  let bookingStats = { total: 0, online: 0, offline: 0, cancelled: 0 };
  let labReportStats = { total: 0 };
  let offlineFeeBreakdown: Array<{ feePerAppt: number; count: number; totalFee: number }> = [];

  const monthDataMap = new Map<string, {
    count: number;
    appointmentFee: number;
    feeMap: Map<number, { feePerAppt: number; count: number; totalFee: number }>;
  }>();

  if (isLab) {
    const reports = await LabReport.find({ facilityId: facility?._id }).lean();
    labReportStats = { total: reports.length };

    for (const rep of reports) {
      const d = rep.createdAt ? new Date(rep.createdAt) : new Date();
      const mKey = d.toISOString().slice(0, 7);
      const fee = configuredPlatformFee;
      totalFeesAccrued += fee;

      const mData = monthDataMap.get(mKey) || { count: 0, appointmentFee: 0, feeMap: new Map() };
      mData.count += 1;
      mData.appointmentFee += fee;

      const feeGroup = mData.feeMap.get(fee) || { feePerAppt: fee, count: 0, totalFee: 0 };
      feeGroup.count += 1;
      feeGroup.totalFee += fee;
      mData.feeMap.set(fee, feeGroup);

      monthDataMap.set(mKey, mData);
    }
  } else {
    const doctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(adminId) }).lean();
    const appointments = await Appointment.find({ doctorId: { $in: doctors.map((d) => d._id) } }).lean();

    let totalBookings = 0;
    let onlineBookings = 0;
    let offlineBookings = 0;
    let cancelledBookings = 0;

    const overallOfflineFeeMap = new Map<number, { feePerAppt: number; count: number; totalFee: number }>();

    for (const appt of appointments) {
      totalBookings++;
      if (appt.status === 'CANCELLED') cancelledBookings++;
      if (appt.time === 'QUEUE') {
        offlineBookings++;
        const fee = appt.platformFee !== undefined && appt.platformFee !== null ? Number(appt.platformFee) : 3;
        totalFeesAccrued += fee;

        const mKey = appt.date ? appt.date.slice(0, 7) : (appt.createdAt ? new Date(appt.createdAt).toISOString().slice(0, 7) : '');
        if (mKey) {
          const mData = monthDataMap.get(mKey) || { count: 0, appointmentFee: 0, feeMap: new Map() };
          mData.count += 1;
          mData.appointmentFee += fee;

          const feeGroup = mData.feeMap.get(fee) || { feePerAppt: fee, count: 0, totalFee: 0 };
          feeGroup.count += 1;
          feeGroup.totalFee += fee;
          mData.feeMap.set(fee, feeGroup);

          monthDataMap.set(mKey, mData);
        }

        const cur = overallOfflineFeeMap.get(fee) || { feePerAppt: fee, count: 0, totalFee: 0 };
        cur.count += 1;
        cur.totalFee += fee;
        overallOfflineFeeMap.set(fee, cur);
      } else {
        onlineBookings++;
      }
    }

    offlineFeeBreakdown = Array.from(overallOfflineFeeMap.values()).sort((a, b) => a.feePerAppt - b.feePerAppt);

    bookingStats = {
      total: totalBookings,
      online: onlineBookings,
      offline: offlineBookings,
      cancelled: cancelledBookings,
    };
  }

  // Payment Allocation: Month-targeted payments are allocated to their specified month first; general payments are allocated FIFO (oldest month first).
  const allMonthKeys = Array.from(new Set([
    ...monthDataMap.keys(),
    ...correctionFeeByMonth.keys(),
    ...targetedPaidByMonth.keys(),
  ])).sort((a, b) => a.localeCompare(b));

  const monthAllocations = new Map<string, { paidAllocated: number }>();
  let remainingGeneralPool = generalPaymentPool;
  const monthRemainingAccrued = new Map<string, number>();

  // 1. Allocate month-targeted payments first to their target month
  for (const mKey of allMonthKeys) {
    const mData = monthDataMap.get(mKey);
    const totalMonthAccrued = mData?.appointmentFee || 0;
    const targetedPaid = targetedPaidByMonth.get(mKey) || 0;

    const directAllocated = Math.min(targetedPaid, totalMonthAccrued);
    const overflow = targetedPaid - directAllocated;
    if (overflow > 0) {
      remainingGeneralPool += overflow;
    }

    monthAllocations.set(mKey, { paidAllocated: directAllocated });
    monthRemainingAccrued.set(mKey, totalMonthAccrued - directAllocated);
  }

  // 2. Allocate remaining general payment pool FIFO to oldest unpaid months first
  for (const mKey of allMonthKeys) {
    const remAccrued = monthRemainingAccrued.get(mKey) || 0;
    if (remAccrued > 0 && remainingGeneralPool > 0) {
      const fifoAllocated = Math.min(remainingGeneralPool, remAccrued);
      remainingGeneralPool -= fifoAllocated;

      const current = monthAllocations.get(mKey) || { paidAllocated: 0 };
      monthAllocations.set(mKey, { paidAllocated: current.paidAllocated + fifoAllocated });
      monthRemainingAccrued.set(mKey, remAccrued - fifoAllocated);
    }
  }

  // Build monthly cards for the requested year (12 months)
  const months = [];
  for (let m = 0; m < 12; m++) {
    const monthNum = m + 1;
    const monthStr = String(monthNum).padStart(2, '0');
    const monthKey = `${selectedYear}-${monthStr}`;
    const startOfMonth = new Date(Date.UTC(selectedYear, m, 1));

    const monthName = startOfMonth.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const monthLabel = `${monthName} ${selectedYear}`;

    const mData = monthDataMap.get(monthKey);
    const count = mData?.count || 0;
    const appointmentFee = mData?.appointmentFee || 0;
    const correctionFee = correctionFeeByMonth.get(monthKey) || 0;
    const totalMonthAccrued = appointmentFee;

    const allocation = monthAllocations.get(monthKey) || { paidAllocated: 0 };
    const paidAmount = allocation.paidAllocated;
    const remainingAmount = Math.max(0, totalMonthAccrued - paidAmount);

    // Why this change is needed: Fix ESLint no-useless-assignment error.
    // status is unconditionally assigned in all branches of the following if-else block.
    let status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'NO_DUES';
    if (totalMonthAccrued === 0 && paidAmount === 0) {
      status = 'NO_DUES';
    } else if (remainingAmount <= 0) {
      status = 'PAID';
    } else if (paidAmount > 0) {
      status = 'PARTIALLY_PAID';
    } else {
      status = 'PENDING';
    }

    const feeBreakdown = mData ? Array.from(mData.feeMap.values()).sort((a, b) => a.feePerAppt - b.feePerAppt) : [];
    const calculationText = feeBreakdown.length > 0
      ? feeBreakdown.map((g) => `${g.count} × ₹${g.feePerAppt}`).join(' + ')
      : `${count} × ₹${configuredPlatformFee}`;

    months.push({
      monthKey,
      monthLabel,
      monthName,
      count,
      amount: totalMonthAccrued,
      appointmentFee,
      correctionFee,
      paidAmount,
      remainingAmount,
      status,
      feePerItem: configuredPlatformFee,
      feeBreakdown,
      calculationText,
    });
  }

  const outstandingDues = totalFeesAccrued - totalFeesPaid;
  const displayDues = Math.max(0, outstandingDues);
  const surplusCredit = Math.max(0, totalFeesPaid - totalFeesAccrued);

  // Why this change is needed: Fix ESLint no-useless-assignment error.
  // status is unconditionally assigned in all branches of the following if-else block.
  let status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'NO_DUES';
  if (totalFeesAccrued === 0 && totalFeesPaid === 0 && outstandingDues === 0) {
    status = 'NO_DUES';
  } else if (outstandingDues <= 0) {
    status = 'PAID';
  } else if (totalFeesPaid > 0) {
    status = 'PARTIALLY_PAID';
  } else {
    status = 'PENDING';
  }

  return {
    year: selectedYear,
    isLab,
    facilityType: facility?.facilityType || 'CLINIC',
    facilityId: facility?._id,
    configuredPlatformFee,
    summary: {
      totalFeesAccrued,
      totalFeesPaid,
      totalPendingClaims,
      totalRefundCredits,
      outstandingDues,
      displayDues,
      surplusCredit,
      status,
      offlineFeeBreakdown,
    },
    bookingStats,
    labReportStats,
    months,
    transactions: txns,
  };
};

export const billingService = {
  /**
   * Get wallet summary for all doctors under a facility admin
   */
  getDoctorWallets: async (adminId: string, fromDate?: string, toDate?: string) => {
    const doctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(adminId) }).lean();
    if (!doctors.length) return [];

    const doctorIds = doctors.map((d) => d._id);

    // Only DEBIT_PAYOUT and DEBIT_REFUND wallet transactions are needed for payout tracking.
    // totalEarned is now computed directly from COMPLETED appointments (see below) rather than
    // CREDIT_CONSULTATION transactions, which are created at payment time and exist even for
    // appointments that are later cancelled — inflating the displayed figure.
    const txQuery: Record<string, unknown> = { doctorId: { $in: doctorIds } };
    if (fromDate || toDate) {
      const dateFilter: Record<string, Date> = {};
      if (fromDate) dateFilter.$gte = new Date(fromDate);
      if (toDate) dateFilter.$lte = new Date(`${toDate}T23:59:59.999Z`);
      txQuery.createdAt = dateFilter;
    }

    const txns = await DoctorWalletTransaction.find(txQuery)
      .sort({ createdAt: -1 })
      .lean();

    const appQuery: Record<string, unknown> = {
      doctorId: { $in: doctorIds },
      status: AppointmentStatus.CANCELLED,
      paymentStatus: PaymentStatus.PAID,
      'cancellation.refunded': { $ne: true },
    };
    if (fromDate || toDate) {
      const dateFilter: Record<string, string> = {};
      if (fromDate) dateFilter.$gte = fromDate;
      if (toDate) dateFilter.$lte = toDate;
      appQuery.date = dateFilter;
    }

    const unrefundedApps = await Appointment.find(appQuery).lean();

    const unrefundedMap = new Map<string, { count: number; amount: number }>();
    for (const app of unrefundedApps) {
      const docId = String(app.doctorId);
      const cur = unrefundedMap.get(docId) || { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += app.cancellation?.refundAmount || app.consultationFee || 0;
      unrefundedMap.set(docId, cur);
    }

    const walletMap = new Map<
      string,
      {
        totalEarned: number;
        totalPaid: number;
        totalRefunds: number;
        pendingBalance: number;
        lastPayoutAt?: string;
        txCount: number;
      }
    >();

    for (const doc of doctors) {
      walletMap.set(String(doc._id), {
        totalEarned: 0,
        totalPaid: 0,
        totalRefunds: 0,
        pendingBalance: 0,
        txCount: 0,
      });
    }

    // Accumulate payout and refund wallet transactions.
    // CREDIT_CONSULTATION is intentionally skipped here because totalEarned is now computed
    // directly from COMPLETED appointment records below, ensuring cancelled appointments
    // never contribute to a doctor's earned total.
    for (const tx of txns) {
      const key = String(tx.doctorId);
      const entry = walletMap.get(key);
      if (!entry) continue;

      entry.txCount += 1;
      const amt = Number(tx.amount || 0);

      if (tx.type === 'DEBIT_PAYOUT') {
        entry.totalPaid += Math.abs(amt);
        if (!entry.lastPayoutAt) {
          entry.lastPayoutAt = tx.createdAt ? new Date(tx.createdAt).toISOString() : undefined;
        }
      } else if (tx.type === 'DEBIT_REFUND') {
        // Track refunds for informational purposes; they are NOT subtracted from pendingBalance
        // because cancelled appointment fees are no longer included in totalEarned.
        entry.totalRefunds += Math.abs(amt);
      }
    }

    // Compute totalEarned from ALL COMPLETED appointments (both online and offline).
    // This is the single source of truth: only persisted COMPLETED status contributes to earnings.
    // - Online (time !== 'QUEUE'): previously relied on CREDIT_CONSULTATION transactions which
    //   include cancelled paid appointments; querying COMPLETED appointments directly avoids that.
    // - Offline (time === 'QUEUE'): already had COMPLETED filter; now unified in one query.
    const completedApptDateFilter: Record<string, string> = {};
    if (fromDate) completedApptDateFilter.$gte = fromDate.split('T')[0] as string;
    if (toDate) completedApptDateFilter.$lte = toDate.split('T')[0] as string;

    const completedApptQuery: Record<string, unknown> = {
      doctorId: { $in: doctorIds },
      status: AppointmentStatus.COMPLETED,
    };
    if (Object.keys(completedApptDateFilter).length > 0) {
      // Use the appointment's scheduled date (YYYY-MM-DD) for date range filtering,
      // consistent with how the rest of the earnings pages apply date filters.
      completedApptQuery.date = completedApptDateFilter;
    }

    const completedApps = await Appointment.find(completedApptQuery).lean();
    for (const app of completedApps) {
      const key = String(app.doctorId);
      const entry = walletMap.get(key);
      if (!entry) continue;

      const historicalFee =
        app.consultationFeeAtBooking !== undefined && app.consultationFeeAtBooking !== null
          ? app.consultationFeeAtBooking
          : app.consultationFee || 0;
      entry.totalEarned += Number(historicalFee);
    }

    return doctors.map((doc) => {
      const docIdStr = String(doc._id);
      const stats = walletMap.get(docIdStr) || {
        totalEarned: 0,
        totalPaid: 0,
        totalRefunds: 0,
        pendingBalance: 0,
        txCount: 0,
      };

      const unrefundedInfo = unrefundedMap.get(docIdStr) || { count: 0, amount: 0 };
      // pendingBalance = totalEarned (COMPLETED only) minus payouts already made.
      // totalRefunds is NOT subtracted here because cancelled appointment fees are excluded
      // from totalEarned — subtracting refunds again would under-report the balance.
      const pendingBalance = Math.max(0, stats.totalEarned - stats.totalPaid);

      return {
        _id: doc._id,
        name: doc.name,
        specialization: doc.specialization || 'Consultant',
        profileImage: doc.profileImage,
        consultationFee: doc.consultationFee || 0,
        bankAccountDetails: doc.bankAccountDetails,
        totalEarned: stats.totalEarned,
        totalPaid: stats.totalPaid,
        totalRefunds: stats.totalRefunds,
        pendingBalance,
        lastPayoutAt: stats.lastPayoutAt,
        txCount: stats.txCount,
        unrefundedCancellationsCount: unrefundedInfo.count,
        pendingPatientRefundAmount: unrefundedInfo.amount,
      };
    });
  },


  /**
   * Get list of OP orders/appointments for a specific doctor with optional status filtering
   */
  getDoctorOrders: async (
    adminId: string,
    doctorId: string,
    statusFilter?: string,
    fromDate?: string,
    toDate?: string,
  ) => {
    const doctor = await Doctor.findOne({
      _id: doctorId,
      adminId: new mongoose.Types.ObjectId(adminId),
    }).lean();

    if (!doctor) throw AppError.notFound('Doctor not found or unauthorized');

    const appQuery: Record<string, unknown> = { doctorId: doctor._id };
    if (fromDate || toDate) {
      const dateFilter: Record<string, string> = {};
      if (fromDate) dateFilter.$gte = fromDate;
      if (toDate) dateFilter.$lte = toDate;
      appQuery.date = dateFilter;
    }

    const appointments = await Appointment.find(appQuery)
      .populate('patientId', 'name phone email profileImage')
      .sort({ createdAt: -1 })
      .lean();

    let unrefundedCancellationsCount = 0;
    let pendingPatientRefundAmount = 0;
    let successOrdersCount = 0;
    let completedOrdersCount = 0;
    let cancelledOrdersCount = 0;

    const orders = appointments.map((app) => {
      const isCancelled = app.status === AppointmentStatus.CANCELLED;
      const isCompleted = app.status === AppointmentStatus.COMPLETED;
      const isSuccess =
        app.status === AppointmentStatus.COMPLETED || app.status === AppointmentStatus.CONSULTING;
      const isRefunded =
        app.cancellation?.refunded === true || app.paymentStatus === PaymentStatus.REFUNDED;
      const isPatientNotArrived =
        app.cancellation?.reason === 'PATIENT_NOT_ARRIVED' ||
        app.cancellationReason === 'Patient Not Arrived' ||
        !app.arrivedAt;
      const refundAmt = isPatientNotArrived
        ? 0
        : typeof app.cancellation?.refundAmount === 'number'
        ? app.cancellation.refundAmount
        : (app.time === 'QUEUE' ? (app.consultationFee || 0) : 0);
      const isPendingRefund = isCancelled && refundAmt > 0 && !isRefunded;

      if (isCompleted) completedOrdersCount += 1;
      if (isSuccess) successOrdersCount += 1;
      if (isCancelled) {
        cancelledOrdersCount += 1;
        if (isPendingRefund) {
          unrefundedCancellationsCount += 1;
          pendingPatientRefundAmount += refundAmt;
        }
      }

      return {
        _id: app._id,
        tokenNumber: app.tokenNumber,
        date: app.date,
        time: app.time,
        status: app.status,
        paymentStatus: app.paymentStatus,
        consultationFee: (app.consultationFeeAtBooking !== undefined && app.consultationFeeAtBooking !== null)
          ? app.consultationFeeAtBooking
          : (app.consultationFee || 0),
        consultationFeeAtBooking: app.consultationFeeAtBooking,
        platformFee: app.platformFee || 0,
        patient: app.patientId ? {
          _id: String((app.patientId as any)._id),
          name: app.patientName || (app.patientId as any).name,
          phone: app.patientPhone || (app.patientId as any).phone,
          email: (app.patientId as any).email,
          healthCardId: (app.patientId as any).healthCardId,
          age: app.patientAge || (app.patientId as any).age,
          gender: (app.patientId as any).gender,
        } : null,
        cancellation: app.cancellation,
        isPendingRefund,
        createdAt: app.createdAt,
      };
    });

    let filteredOrders = orders;
    if (statusFilter === 'SUCCESS') {
      filteredOrders = orders.filter(
        (o) =>
          o.status === AppointmentStatus.COMPLETED || o.status === AppointmentStatus.CONSULTING,
      );
    } else if (statusFilter === 'COMPLETED') {
      filteredOrders = orders.filter((o) => o.status === AppointmentStatus.COMPLETED);
    } else if (statusFilter === 'CANCELLED') {
      filteredOrders = orders.filter((o) => o.status === AppointmentStatus.CANCELLED);
    } else if (statusFilter === 'PENDING_REFUND') {
      filteredOrders = orders.filter((o) => o.isPendingRefund);
    }

    return {
      doctor: {
        _id: doctor._id,
        name: doctor.name,
        specialization: doctor.specialization,
      },
      summary: {
        totalOrders: orders.length,
        successOrdersCount,
        completedOrdersCount,
        cancelledOrdersCount,
        unrefundedCancellationsCount,
        pendingPatientRefundAmount,
        // totalRevenue: sum of consultation fees from COMPLETED appointments only, using historical fee snapshot.
        totalRevenue: appointments.reduce(
          (sum, a) =>
            sum +
            (a.status === AppointmentStatus.COMPLETED
              ? (a.consultationFeeAtBooking !== undefined && a.consultationFeeAtBooking !== null
                  ? a.consultationFeeAtBooking
                  : (a.consultationFee || 0))
              : 0),
          0,
        ),
        successRevenue: appointments.reduce(
          (sum, a) =>
            sum +
            (a.status === AppointmentStatus.COMPLETED
              ? (a.consultationFeeAtBooking !== undefined && a.consultationFeeAtBooking !== null
                  ? a.consultationFeeAtBooking
                  : (a.consultationFee || 0))
              : 0),
          0,
        ),
        totalPlatformFee: appointments.reduce((sum, a) => sum + (a.platformFee || 0), 0),
      },
      orders: filteredOrders,
    };
  },

  /**
   * Get all cancelled OP orders across facility doctors with search, date range, refund status & pagination
   */
  // Correctly calculate pending and settled patient refund statistics and filter cancelled orders using a single source of truth for refund eligibility.
  getFacilityCancelledOrders: async (
    adminId: string,
    options: {
      search?: string;
      fromDate?: string;
      toDate?: string;
      monthKey?: string;
      refundStatus?: 'ALL' | 'PENDING_REFUND' | 'REFUNDED';
      doctorId?: string;
      type?: 'ALL' | 'Online' | 'Offline';
      page?: number;
      limit?: number;
    },
  ) => {
    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const doctors = await Doctor.find({ adminId: adminObjectId }).select('_id name specialization');
    const doctorIds = doctors.map((d) => d._id);

    const baseQuery: any = {
      doctorId: { $in: doctorIds },
      status: AppointmentStatus.CANCELLED,
    };

    if (options.doctorId) {
      baseQuery.doctorId = new mongoose.Types.ObjectId(options.doctorId);
    }

    if (options.type === 'Online') {
      baseQuery.time = { $ne: 'QUEUE' };
    } else if (options.type === 'Offline') {
      baseQuery.time = 'QUEUE';
    }

    if (options.monthKey) {
      baseQuery.date = { $regex: `^${options.monthKey}` };
    } else if (options.fromDate || options.toDate) {
      const fromDateObj = options.fromDate ? new Date(options.fromDate) : null;
      const toDateObj = options.toDate ? new Date(options.toDate) : null;
      const dateStr = options.fromDate ? options.fromDate.slice(0, 10) : '';

      const dateOrArray: any[] = [];
      if (fromDateObj && toDateObj) {
        dateOrArray.push({ 'cancellation.requestedAt': { $gte: fromDateObj, $lte: toDateObj } });
        dateOrArray.push({ createdAt: { $gte: fromDateObj, $lte: toDateObj } });
      }
      if (dateStr) {
        dateOrArray.push({ date: dateStr });
      }
      if (dateOrArray.length > 0) {
        baseQuery.$or = dateOrArray;
      }
    }

    const appointments = await Appointment.find(baseQuery)
      .populate('doctorId', 'name specialization')
      .populate('patientId', 'name phone email healthCardId age gender')
      .sort({ createdAt: -1 });

    let filtered = appointments;
    if (options.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      filtered = appointments.filter((app: any) => {
        const patientName = (app.patientName || app.patientId?.name || '').toLowerCase();
        const patientPhone = app.patientPhone || app.patientId?.phone || '';
        const doctorName = app.doctorId?.name?.toLowerCase() || '';
        const upi = app.cancellation?.refundUpiId?.toLowerCase() || '';
        const token = String(app.tokenNumber || '');
        return (
          patientName.includes(q) ||
          patientPhone.includes(q) ||
          doctorName.includes(q) ||
          upi.includes(q) ||
          token.includes(q)
        );
      });
    }

    // Calculate summary totals across all matching cancelled appointments for the active date/doctor/type/search criteria
    const totalCancelledCount = filtered.length;
    let pendingRefundCount = 0;
    let pendingRefundAmount = 0;
    let totalRefundedCount = 0;
    let totalRefundedAmount = 0;

    const mappedAppointments = filtered.map((app: any) => {
      const isRefunded = app.cancellation?.refunded === true || app.paymentStatus === PaymentStatus.REFUNDED;
      const isPatientNotArrived =
        app.cancellation?.reason === 'PATIENT_NOT_ARRIVED' ||
        app.cancellationReason === 'Patient Not Arrived' ||
        !app.arrivedAt;
      // Authoritative refund amount: if cancellation.refundAmount is explicitly set (e.g., 0 or positive amount), respect it
      const refundAmt = isPatientNotArrived
        ? 0
        : typeof app.cancellation?.refundAmount === 'number'
        ? app.cancellation.refundAmount
        : (app.time === 'QUEUE' ? (app.consultationFee || 0) : 0);
      const isEligibleForRefund = refundAmt > 0;
      const isPendingRefund = !isRefunded && isEligibleForRefund;

      if (isRefunded) {
        totalRefundedCount += 1;
        totalRefundedAmount += refundAmt;
      } else if (isPendingRefund) {
        pendingRefundCount += 1;
        pendingRefundAmount += refundAmt;
      }

      return {
        _id: app._id,
        tokenNumber: app.tokenNumber,
        date: app.date,
        time: app.time,
        status: app.status,
        paymentStatus: app.paymentStatus,
        consultationFee: app.consultationFee || 0,
        platformFee: app.platformFee || 0,
        doctor: app.doctorId,
        patient: app.patientId ? {
          _id: String((app.patientId as any)._id),
          name: app.patientName || (app.patientId as any).name,
          phone: app.patientPhone || (app.patientId as any).phone,
          email: (app.patientId as any).email,
          healthCardId: (app.patientId as any).healthCardId,
          age: app.patientAge || (app.patientId as any).age,
          gender: (app.patientId as any).gender,
        } : null,
        cancellation: app.cancellation,
        isRefunded,
        isPendingRefund,
        isEligibleForRefund,
        createdAt: app.createdAt,
      };
    });

    // Apply refund status tab filter (ALL / PENDING_REFUND / REFUNDED) to table rows
    let tableItems = mappedAppointments;
    if (options.refundStatus === 'PENDING_REFUND') {
      tableItems = mappedAppointments.filter((item) => item.isPendingRefund);
    } else if (options.refundStatus === 'REFUNDED') {
      tableItems = mappedAppointments.filter((item) => item.isRefunded);
    }

    const total = tableItems.length;
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.max(1, Number(options.limit) || 20);
    const totalPages = Math.ceil(total / limit) || 1;
    const startIndex = (page - 1) * limit;
    const paginated = tableItems.slice(startIndex, startIndex + limit);

    return {
      summary: {
        totalCancelledCount,
        pendingRefundCount,
        pendingRefundAmount,
        totalRefundedCount,
        totalRefundedAmount,
      },
      page,
      limit,
      total,
      totalPages,
      items: paginated,
    };
  },

  /**
   * Mark a patient refund as processed for a cancelled appointment
   */
  markPatientRefunded: async (adminId: string, appointmentId: string) => {
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) throw AppError.notFound('Appointment not found');

    const doctor = await Doctor.findOne({
      _id: appointment.doctorId,
      adminId: new mongoose.Types.ObjectId(adminId),
    });
    if (!doctor) throw AppError.notFound('Doctor not found or unauthorized');

    if (appointment.cancellation?.refunded) {
      return { message: 'Patient refund already processed', appointment };
    }

    if (!appointment.cancellation) {
      appointment.cancellation = {
        requestedAt: new Date(),
        cancelledBy: 'ADMIN',
        refunded: true,
        refundAmount: appointment.consultationFee || 0,
      } as any;
    } else {
      appointment.cancellation.refunded = true;
    }

    if (appointment.paymentStatus !== PaymentStatus.REFUNDED) {
      appointment.previousPaymentStatus = appointment.paymentStatus;
    }
    appointment.paymentStatus = PaymentStatus.REFUNDED;
    await appointment.save();

    // Determine authoritative refund amount for doctor wallet adjustment
    const refundAmt =
      typeof appointment.cancellation?.refundAmount === 'number'
        ? appointment.cancellation.refundAmount
        : (appointment.consultationFee || 0);

    // Create DEBIT_REFUND for Doctor Wallet to adjust doctor balance using the actual refund amount
    if (refundAmt > 0) {
      await DoctorWalletTransaction.create({
        doctorId: doctor._id,
        adminId: doctor.adminId,
        appointmentId: appointment._id,
        amount: -refundAmt,
        type: 'DEBIT_REFUND',
        description: `Patient refund processed for cancelled booking ${appointment.tokenNumber || ''}`,
      });
    }

    // Revert platform fee in admin billing ledger ONLY for online appointments.
    // EXPLANATION OF BILLING RULE:
    // Offline OP bookings (time === 'QUEUE') incur platform fees even if cancelled.
    // Cancelling an offline OP booking must NOT create a platform fee refund credit for the Admin.
    const isOffline = appointment.time === 'QUEUE';
    if (!isOffline && appointment.platformFee && appointment.platformFee > 0) {
      await AdminBillingTransaction.create({
        adminId: doctor.adminId,
        appointmentId: appointment._id,
        amount: -appointment.platformFee,
        type: 'CREDIT_REFUND',
        description: `Platform fee refund credit for cancelled online booking ${appointment.tokenNumber || ''}`,
      });
    }

    return { success: true, appointment };
  },

  /**
   * Undo a patient refund processing for a cancelled appointment
   */
  undoPatientRefund: async (adminId: string, appointmentId: string) => {
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) throw AppError.notFound('Appointment not found');

    const doctor = await Doctor.findOne({
      _id: appointment.doctorId,
      adminId: new mongoose.Types.ObjectId(adminId),
    });
    if (!doctor) throw AppError.notFound('Doctor not found or unauthorized');

    if (!appointment.cancellation?.refunded) {
      return { message: 'Patient refund is not currently marked as processed', appointment };
    }

    appointment.cancellation.refunded = false;

    if (appointment.previousPaymentStatus) {
      appointment.paymentStatus = appointment.previousPaymentStatus;
    } else {
      appointment.paymentStatus = PaymentStatus.PAID;
    }
    await appointment.save();

    // Delete DEBIT_REFUND from Doctor Wallet
    await DoctorWalletTransaction.deleteMany({
      doctorId: doctor._id,
      appointmentId: appointment._id,
      type: 'DEBIT_REFUND',
    });

    // Delete CREDIT_REFUND from Admin Billing Ledger
    await AdminBillingTransaction.deleteMany({
      adminId: doctor.adminId,
      appointmentId: appointment._id,
      type: 'CREDIT_REFUND',
    });

    return { success: true, appointment };
  },

  /**
   * Get facility platform fee billing summary for a Facility Admin
   */
  getAdminBillingDues: async (adminId: string) => {
    return fetchAdminBillingDues(adminId);
  },

  /**
   * Create payment order for Facility Admin to pay platform dues to Superadmin using Razorpay
   */
  createPlatformDuesOrder: async (adminId: string, customAmount?: number, monthKey?: string, returnUrl?: string) => {
    const adminUser = await User.findById(adminId);
    if (!adminUser) throw AppError.notFound('Admin user not found');

    const duesInfo = await fetchAdminBillingDues(adminId);
    let amountToPay = 0;

    if (customAmount && customAmount > 0) {
      amountToPay = customAmount;
    } else if (monthKey) {
      const targetKeys = monthKey.split(',').map((k) => k.trim()).filter(Boolean);
      const targetMonths = duesInfo.months.filter((m) => targetKeys.includes(m.monthKey));
      amountToPay = targetMonths.reduce((sum, m) => sum + (m.remainingAmount > 0 ? m.remainingAmount : 0), 0);
    }

    if (!amountToPay || amountToPay <= 0) {
      amountToPay = duesInfo.summary.outstandingDues;
    }

    if (!amountToPay || amountToPay <= 0) {
      throw AppError.badRequest('No outstanding platform dues to pay');
    }

    const rzpOrder = await razorpayService.createOrder(amountToPay);
    const orderId = rzpOrder.id;

    await AdminBillingOrder.findOneAndUpdate(
      { orderId },
      {
        orderId,
        adminId: new mongoose.Types.ObjectId(adminId),
        amount: amountToPay,
        currency: 'INR',
        monthKey: monthKey || '',
        monthLabel: monthKey ? `Selected month(s): ${monthKey}` : 'Total Outstanding Dues',
        status: 'CREATED',
        returnUrl: returnUrl || '/admin/pay/summary',
      },
      { upsert: true, new: true }
    );

    const isSimulatedDev = orderId.startsWith('order_test_') || orderId.startsWith('order_dev_');

    return {
      gateway: 'RAZORPAY',
      orderId,
      // Only send razorpayOrderId if created on Razorpay server (not dummy/simulated)
      // Standard checkout in test mode works directly with key_id without crashing
      razorpayOrderId: isSimulatedDev ? undefined : orderId,
      internalOrderId: orderId,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
      amount: amountToPay,
      amountPaise: Math.round(amountToPay * 100),
      currency: 'INR',
      monthKey,
    };
  },

  /**
   * Get payment attempt details for failure recovery and retry
   */
  getAdminBillingOrderDetails: async (adminId: string, orderId: string) => {
    const order = await AdminBillingOrder.findOne({ orderId, adminId: new mongoose.Types.ObjectId(adminId) }).lean();
    if (!order) {
      throw AppError.notFound('Payment order attempt not found');
    }

    const duesInfo = await fetchAdminBillingDues(adminId);
    let liveAmount = order.amount;

    if (order.monthKey) {
      const targetKeys = order.monthKey.split(',').map((k) => k.trim()).filter(Boolean);
      const targetMonths = duesInfo.months.filter((m) => targetKeys.includes(m.monthKey));
      const calcRem = targetMonths.reduce((sum, m) => sum + (m.remainingAmount > 0 ? m.remainingAmount : 0), 0);
      if (calcRem > 0) liveAmount = calcRem;
    } else {
      if (duesInfo.summary.outstandingDues > 0) {
        liveAmount = duesInfo.summary.outstandingDues;
      }
    }

    return {
      orderId: order.orderId,
      amount: liveAmount,
      monthKey: order.monthKey || '',
      monthLabel: order.monthLabel || (order.monthKey ? `Selected month(s): ${order.monthKey}` : 'Total Outstanding Dues'),
      status: order.status,
      failureReason: order.failureReason || 'Payment checkout was not completed.',
      returnUrl: order.returnUrl || '/admin/pay/summary',
    };
  },

  /**
   * Mark a payment attempt as failed/cancelled
   */
  cancelPlatformDuesOrder: async (adminId: string, orderId: string, reason?: string) => {
    const order = await AdminBillingOrder.findOneAndUpdate(
      { orderId, adminId: new mongoose.Types.ObjectId(adminId) },
      { status: 'FAILED', failureReason: reason || 'Payment checkout was cancelled or failed' },
      { new: true }
    );
    return order;
  },

  /**
   * Verify platform dues payment and record credit to Superadmin
   */
  verifyPlatformDuesPayment: async (
    adminId: string,
    orderId: string,
    gatewayDetails?: { razorpayPaymentId?: string; razorpaySignature?: string; cashfreePaymentId?: string },
    monthKey?: string,
  ) => {
    let paidAmount = 0;

    // Check if transaction with this orderId already exists to prevent duplicate payment records when retried
    const existingTx = await AdminBillingTransaction.findOne({
      adminId: new mongoose.Types.ObjectId(adminId),
      type: 'CREDIT_PAYMENT_TO_SUPERADMIN',
      description: new RegExp(`Order\\s*#?\\s*${orderId}`, 'i'),
    });
    if (existingTx) {
      return {
        success: true,
        transaction: existingTx,
        amountPaid: existingTx.amount,
      };
    }

    if (gatewayDetails?.razorpayPaymentId && gatewayDetails?.razorpaySignature) {
      const isValid = razorpayService.verifySignature(
        orderId,
        gatewayDetails.razorpayPaymentId,
        gatewayDetails.razorpaySignature,
      );
      if (!isValid) throw AppError.badRequest('Invalid Razorpay signature');
    }

    // Lookup order attempt record to extract validated amount and target monthKey
    const orderAttempt = await AdminBillingOrder.findOne({ orderId }).lean();
    if (orderAttempt) {
      paidAmount = orderAttempt.amount;
      monthKey = monthKey || orderAttempt.monthKey || undefined;
    }

    if (!paidAmount || paidAmount <= 0) {
      const duesInfo = await fetchAdminBillingDues(adminId);
      paidAmount = duesInfo.summary.outstandingDues;
    }

    if (!paidAmount || paidAmount <= 0) {
      throw AppError.badRequest('No outstanding platform dues to verify');
    }

    const paymentId = gatewayDetails?.razorpayPaymentId || `pay_${Date.now()}`;
    if (orderAttempt) {
      await AdminBillingOrder.updateOne({ _id: orderAttempt._id }, { status: 'PAID', paymentId });
    }

    const txn = await AdminBillingTransaction.create({
      adminId: new mongoose.Types.ObjectId(adminId),
      amount: paidAmount,
      type: 'CREDIT_PAYMENT_TO_SUPERADMIN',
      monthKey: monthKey || '',
      description: `Platform fee payment of ₹${paidAmount} paid to Superadmin via Razorpay (Order #${orderId})`,
    });

    return {
      success: true,
      transaction: txn,
      amountPaid: paidAmount,
    };
  },

  /**
   * Record direct platform dues payment claim from Facility Admin to Superadmin (UPI / Bank Transfer / Cash).
   * EXPLANATION OF BILLING RULE:
   * Direct payment submissions by Admins are recorded with approvalStatus: 'PENDING_APPROVAL'.
   * Outstanding dues are NOT reduced until the Super Admin verifies and approves the claim.
   */
  recordDirectDuesPaymentToSuperAdmin: async (
    adminId: string,
    amount: number,
    paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'GATEWAY' = 'UPI',
    referenceNumber?: string,
    notes?: string,
    monthKey?: string,
  ) => {
    if (!amount || amount <= 0) {
      throw AppError.badRequest('Payment amount must be greater than zero');
    }

    const adminUser = await User.findById(adminId);
    if (!adminUser) throw AppError.notFound('Admin user not found');

    const Facility = (await import('../models/Facility')).default;
    const facility = await Facility.findOne({ ownerId: new mongoose.Types.ObjectId(adminId) }).lean();

    const desc = referenceNumber || notes
      ? `Platform fee payment claim of ₹${amount} reported by Admin (${paymentMethod}, Ref: ${referenceNumber || notes}) - Awaiting Approval`
      : `Platform fee payment claim of ₹${amount} reported by Admin (${paymentMethod}) - Awaiting Approval`;

    const txn = await AdminBillingTransaction.create({
      adminId: new mongoose.Types.ObjectId(adminId),
      facilityId: facility?._id,
      amount,
      type: 'CREDIT_PAYMENT_TO_SUPERADMIN',
      paymentMethod,
      approvalStatus: 'PENDING_APPROVAL',
      referenceNumber: referenceNumber || '',
      notes: notes || '',
      monthKey: monthKey || '',
      description: desc,
    });

    return {
      success: true,
      transaction: txn,
      amountPaid: amount,
    };
  },

  /**
   * Super Admin approves a pending payment claim submitted by a Facility Admin.
   * EXPLANATION OF BILLING RULE:
   * Sets approvalStatus to 'CONFIRMED', which applies the payment towards reducing outstanding dues.
   */
  approveDirectPaymentClaim: async (transactionId: string, superAdminId?: string) => {
    const txn = await AdminBillingTransaction.findById(transactionId);
    if (!txn) throw AppError.notFound('Billing transaction claim not found');

    if (txn.type !== 'CREDIT_PAYMENT_TO_SUPERADMIN') {
      throw AppError.badRequest('Only payment credit transactions can be approved');
    }

    txn.approvalStatus = 'CONFIRMED';
    txn.rejectionReason = undefined;
    txn.description = txn.description.replace(' - Awaiting Approval', ' - Approved & Confirmed');
    await txn.save();

    return txn;
  },

  /**
   * Super Admin rejects a pending payment claim submitted by a Facility Admin.
   * EXPLANATION OF BILLING RULE:
   * Sets approvalStatus to 'REJECTED' with a reason. Retains transaction in history for auditing without reducing dues.
   */
  rejectDirectPaymentClaim: async (transactionId: string, superAdminId?: string, rejectionReason?: string) => {
    const txn = await AdminBillingTransaction.findById(transactionId);
    if (!txn) throw AppError.notFound('Billing transaction claim not found');

    if (txn.type !== 'CREDIT_PAYMENT_TO_SUPERADMIN') {
      throw AppError.badRequest('Only payment credit transactions can be rejected');
    }

    txn.approvalStatus = 'REJECTED';
    txn.rejectionReason = rejectionReason || 'Payment could not be verified by Super Admin';
    txn.description = txn.description.replace(' - Awaiting Approval', ' - Rejected');
    await txn.save();

    return txn;
  },

  /**
   * Get platform dues summaries for all facilities for Super Admin.
   * EXPLANATION OF BILLING RULE:
   * Aggregates totalAccrued, confirmedPaid, pendingClaims, and outstandingDues per facility from the authoritative AdminBillingTransaction ledger.
   */
  getSuperAdminAllAdminDues: async () => {
    // Idempotently reconcile offline appointment fee charges and reverse invalid offline cancellation refund credits
    await reconcileOfflineBillingLedger();

    const Facility = (await import('../models/Facility')).default;
    const facilities = await Facility.find()
      .populate('ownerId', 'name email phone')
      .lean();

    const adminIds = facilities
      .map((f) => f.ownerId?._id)
      .filter(Boolean) as mongoose.Types.ObjectId[];

    const txns = await AdminBillingTransaction.find({
      adminId: { $in: adminIds },
    }).lean();

    const duesMap = new Map<
      string,
      {
        totalAccrued: number;
        totalPaid: number;
        pendingClaims: number;
        totalRefunds: number;
        txCount: number;
        seenKeys: Set<string>;
      }
    >();

    for (const tx of txns) {
      const key = String(tx.adminId);
      let entry = duesMap.get(key);
      if (!entry) {
        entry = { totalAccrued: 0, totalPaid: 0, pendingClaims: 0, totalRefunds: 0, txCount: 0, seenKeys: new Set<string>() };
        duesMap.set(key, entry);
      }

      entry.txCount += 1;
      const amt = Number(tx.amount || 0);
      if (tx.type === 'DEBIT_PLATFORM_FEE') {
        entry.totalAccrued += amt;
      } else if (tx.type === 'CREDIT_PAYMENT_TO_SUPERADMIN') {
        const paymentKey = getPaymentReferenceKey(tx);
        if (entry.seenKeys.has(paymentKey)) {
          continue; // Deduplicate payment transactions sharing the same order/payment reference
        }
        entry.seenKeys.add(paymentKey);

        if (tx.approvalStatus === 'PENDING_APPROVAL') {
          entry.pendingClaims += Math.abs(amt);
        } else if (tx.approvalStatus === 'CONFIRMED' || !tx.approvalStatus) {
          entry.totalPaid += Math.abs(amt);
        }
      } else if (tx.type === 'CREDIT_REFUND') {
        entry.totalRefunds += Math.abs(amt);
      }
    }

    return facilities.map((fac) => {
      const owner = fac.ownerId as unknown as { _id?: string; name?: string; email?: string; phone?: string } | undefined;
      const adminId = owner?._id ? String(owner._id) : '';
      const stats = duesMap.get(adminId) || {
        totalAccrued: 0,
        totalPaid: 0,
        pendingClaims: 0,
        totalRefunds: 0,
        txCount: 0,
        seenKeys: new Set<string>(),
      };

      const outstandingDues = stats.totalAccrued - stats.totalPaid;

      // Why this change is needed: Fix ESLint no-useless-assignment error.
      // status is unconditionally assigned in all branches of the following if-else block.
      let status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'NO_DUES';
      if (stats.totalAccrued === 0 && stats.totalPaid === 0 && outstandingDues === 0) {
        status = 'NO_DUES';
      } else if (outstandingDues <= 0) {
        status = 'PAID';
      } else if (stats.totalPaid > 0) {
        status = 'PARTIALLY_PAID';
      } else {
        status = 'PENDING';
      }

      return {
        facilityId: fac._id,
        facilityName: fac.name,
        facilityType: fac.facilityType,
        adminId,
        adminName: owner?.name || 'Facility Admin',
        adminEmail: owner?.email || '',
        adminPhone: owner?.phone || fac.phone,
        totalAccrued: stats.totalAccrued,
        totalPaid: stats.totalPaid,
        pendingClaims: stats.pendingClaims,
        totalRefunds: stats.totalRefunds,
        outstandingDues,
        status,
        txCount: stats.txCount,
      };
    });
  },

  /**
   * Record a confirmed platform fee settlement from Super Admin ("Mark Dues Received / Settle").
   * EXPLANATION OF BILLING RULE:
   * When Super Admin directly records cash or external transfer, it is immediately recorded as CONFIRMED.
   */
  settleAdminPlatformDues: async (
    adminId: string,
    amount: number,
    paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'GATEWAY' = 'CASH',
    referenceNumber?: string,
    notes?: string,
    monthKey?: string,
  ) => {
    if (!amount || amount <= 0) {
      throw AppError.badRequest('Settlement amount must be greater than zero');
    }

    const adminUser = await User.findById(adminId);
    if (!adminUser) throw AppError.notFound('Admin user not found');

    const Facility = (await import('../models/Facility')).default;
    const facility = await Facility.findOne({ ownerId: new mongoose.Types.ObjectId(adminId) }).lean();

    const desc = referenceNumber || notes
      ? `Platform fee payment of ₹${amount} received & confirmed by Super Admin (${paymentMethod}, Ref: ${referenceNumber || notes})`
      : `Platform fee payment of ₹${amount} received & confirmed by Super Admin (${paymentMethod})`;

    const txn = await AdminBillingTransaction.create({
      adminId: new mongoose.Types.ObjectId(adminId),
      facilityId: facility?._id,
      amount,
      type: 'CREDIT_PAYMENT_TO_SUPERADMIN',
      paymentMethod,
      approvalStatus: 'CONFIRMED',
      referenceNumber: referenceNumber || '',
      notes: notes || '',
      monthKey: monthKey || '',
      description: desc,
    });

    return txn;
  },

  // Retrieve all payment transactions (claims and confirmed settlements) made by facilities to Super Admin.
  getSuperAdminAllAdminTransactions: async (query: Record<string, any>) => {
    const filter: Record<string, any> = { type: 'CREDIT_PAYMENT_TO_SUPERADMIN' };

    const transactions = await AdminBillingTransaction.find(filter)
      .populate('adminId', 'name email phone')
      .sort({ createdAt: -1 })
      .lean();

    const Facility = (await import('../models/Facility')).default;
    const facilities = await Facility.find().lean();
    const facilityByAdmin = new Map();
    for (const fac of facilities) {
      if (fac.ownerId) {
        facilityByAdmin.set(String(fac.ownerId), fac);
      }
    }

    const mappedTransactions = transactions.map(tx => {
      const adminId = tx.adminId?._id ? String(tx.adminId._id) : '';
      const facility = facilityByAdmin.get(adminId);
      
      return {
        ...tx,
        facilityName: facility?.name || 'Unknown Facility',
        facilityType: facility?.facilityType || 'Unknown',
        facilityId: facility?._id,
      };
    });

    return mappedTransactions;
  },

  // Support year-based monthly billing summary for both Lab Admin (using LabReport counts) and Clinic Admin (using Appointment counts)
  getAdminDuesMonthlySummary: async (adminId: string, yearInput?: number) => {
    return fetchAdminBillingDues(adminId, yearInput);
  },

  // Aggregate monthly Appointment records or Lab Reports for billing statistics while deriving financial totals from the billing ledger.
  getAdminDuesBreakdownByDoctor: async (adminId: string, monthKey: string) => {
    const year = parseInt(monthKey.slice(0, 4), 10);
    const month = parseInt(monthKey.slice(5, 7), 10) - 1;
    
    // Bounds in UTC to perfectly match the existing frontend's toISOString().slice(0,7) logic.
    const startOfMonth = new Date(Date.UTC(year, month, 1));
    const endOfMonth = new Date(Date.UTC(year, month + 1, 1));

    const { platformFeeService } = await import('./platformFeeService');
    const Doctor = (await import('../models/Doctor')).default;
    const Appointment = (await import('../models/Appointment')).default;
    const Facility = (await import('../models/Facility')).default;
    const LabReport = (await import('../models/LabReport')).default;
    const { AppointmentStatus } = await import('../constants/enums');

    // Restrict the monthly report query to the selected facility and month to prevent cross-facility data access and build detailed report breakdowns.
    const facility = await Facility.findOne({ ownerId: new mongoose.Types.ObjectId(adminId) }).lean();
    if (facility?.facilityType === 'LAB') {
      const configuredPlatformFee = await platformFeeService.get();

      const reports = await LabReport.find({
        facilityId: facility._id,
        createdAt: { $gte: startOfMonth, $lt: endOfMonth },
      })
        .populate({
          path: 'patientId',
          select: 'name phone',
        })
        .sort({ createdAt: 1 })
        .lean();

      const totalReports = reports.length;

      const debitTxns = await AdminBillingTransaction.find({
        adminId: new mongoose.Types.ObjectId(adminId),
        type: 'DEBIT_PLATFORM_FEE',
        createdAt: { $gte: startOfMonth, $lt: endOfMonth },
      }).lean();

      let totalAmount = 0;
      for (const tx of debitTxns) {
        totalAmount += Number(tx.amount || 0);
      }
      if (totalAmount === 0 && totalReports > 0) {
        totalAmount = totalReports * configuredPlatformFee;
      }

      const creditTxns = await AdminBillingTransaction.find({
        adminId: new mongoose.Types.ObjectId(adminId),
        type: 'CREDIT_PAYMENT_TO_SUPERADMIN',
        createdAt: { $gte: startOfMonth, $lt: endOfMonth },
      }).lean();

      let paidAmount = 0;
      for (const tx of creditTxns) {
        paidAmount += Math.abs(Number(tx.amount || 0));
      }
      const remainingAmount = Math.max(0, totalAmount - paidAmount);

      const dateWiseMap = new Map<string, { dateStr: string; sortKey: string; count: number; fee: number }>();
      
      const reportList = reports.map((rep: any) => {
        const d = new Date(rep.createdAt || Date.now());
        const day = d.getUTCDate();
        const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthShort = monthNamesShort[d.getUTCMonth()];
        const yearFull = d.getUTCFullYear();
        
        const dateStr = `${day} ${monthShort} ${yearFull}`;
        const sortKey = d.toISOString().slice(0, 10);

        const cur = dateWiseMap.get(sortKey) || { dateStr, sortKey, count: 0, fee: 0 };
        cur.count += 1;
        cur.fee += configuredPlatformFee;
        dateWiseMap.set(sortKey, cur);

        const hours = d.getUTCHours();
        const minutes = d.getUTCMinutes();
        const ampm = hours >= 12 ? 'pm' : 'am';
        const formattedHours = hours % 12 || 12;
        const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
        const timeStr = `${formattedHours}:${formattedMinutes} ${ampm}`;

        const dateShort = `${day} ${monthShort}`;
        const patientName = rep.patientId?.name || 'Patient';
        const patientPhone = rep.patientId?.phone || '-';

        return {
          _id: String(rep._id),
          date: dateShort,
          fullDate: dateStr,
          time: timeStr,
          patientName,
          patientPhone,
          title: rep.title || 'Lab Report',
          fee: configuredPlatformFee,
          createdAt: rep.createdAt,
        };
      });

      const dateWise = Array.from(dateWiseMap.values())
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .map((item) => ({
          date: item.dateStr,
          count: item.count,
          fee: item.fee,
        }));

      return {
        monthKey,
        facilityName: facility.name || 'Lab',
        totalBookings: totalReports,
        totalReports,
        totalAmount,
        paidAmount,
        remainingAmount,
        onlineTotal: 0,
        offlineTotal: 0,
        cancelledTotal: 0,
        configuredPlatformFee,
        isLab: true,
        facilityType: 'LAB',
        doctors: [],
        dateWise,
        reports: reportList,
      };
    }

    // 1. Initialize Doctor Map for the given facility admin
    // Build the doctor list from facility appointments so doctors are not hidden simply because they have no financial ledger transaction or no bookings.
    const doctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(adminId), isActive: true }).lean();
    const doctorMap = new Map();
    for (const doc of doctors) {
      doctorMap.set(String(doc._id), {
        doctorId: String(doc._id),
        doctorName: doc.name,
        specialization: doc.specialization,
        profileImage: doc.profileImage,
        bookingCount: 0,
        onlineCount: 0,
        offlineCount: 0,
        cancelledCount: 0,
        amount: 0,
      });
    }

    let totalBookings = 0;
    let totalAmount = 0;
    let onlineTotal = 0;
    let offlineTotal = 0;
    let cancelledTotal = 0;

    // 2. Fetch BOOKING statistics from authoritative Appointment data
    const datePrefix = monthKey; // e.g. "2026-10"
    const appointments = await Appointment.find({
      doctorId: { $in: doctors.map(d => d._id) },
      date: { $regex: `^${datePrefix}` }
    }).lean();

    for (const appt of appointments) {
      const docId = String(appt.doctorId);
      const docEntry = doctorMap.get(docId);
      if (!docEntry) continue;

      const isCancelled = appt.status === AppointmentStatus.CANCELLED;
      const isOffline = appt.time === 'QUEUE';

      docEntry.bookingCount += 1;
      totalBookings += 1;

      if (isCancelled) {
        docEntry.cancelledCount += 1;
        cancelledTotal += 1;
      }
      if (isOffline) {
        docEntry.offlineCount += 1;
        offlineTotal += 1;
      } else {
        docEntry.onlineCount += 1;
        onlineTotal += 1;
      }
    }

    // 3. Fetch ACTUAL FINANCIAL amounts from authoritative AdminBillingTransaction
    const txns = await AdminBillingTransaction.find({
      adminId: new mongoose.Types.ObjectId(adminId),
      type: 'DEBIT_PLATFORM_FEE',
      createdAt: { $gte: startOfMonth, $lt: endOfMonth }
    })
      .populate({
        path: 'appointmentId',
        select: 'doctorId'
      })
      .lean();

    for (const tx of txns) {
      const appt: any = tx.appointmentId;
      if (!appt || !appt.doctorId) continue;

      const docId = String(appt.doctorId);
      const docEntry = doctorMap.get(docId);
      if (!docEntry) continue;

      const amt = Number(tx.amount || 0);
      docEntry.amount += amt;
      totalAmount += amt;
    }

    // We do not filter out doctors with zero bookings because the UI is meant to display all active doctors in the facility, providing a complete overview.
    const activeDoctors = Array.from(doctorMap.values()).sort(
      (a, b) => b.amount - a.amount || a.doctorName.localeCompare(b.doctorName)
    );

    // Read the current SuperAdmin-configured service fee so the UI reflects the live platform setting instead of a hardcoded amount.
    const configuredPlatformFee = await platformFeeService.get();

    return {
      monthKey,
      totalBookings,
      totalAmount,
      onlineTotal,
      offlineTotal,
      cancelledTotal,
      configuredPlatformFee,
      doctors: activeDoctors,
    };
  },

  // Fetch the detailed list of bookings and their actual financial ledger amounts for a specific doctor's platform dues view.
  getAdminDuesDoctorOrders: async (adminId: string, doctorId: string, monthKey: string) => {
    const year = parseInt(monthKey.slice(0, 4), 10);
    const month = parseInt(monthKey.slice(5, 7), 10) - 1;
    const startOfMonth = new Date(Date.UTC(year, month, 1));
    const endOfMonth = new Date(Date.UTC(year, month + 1, 1));
    
    const { platformFeeService } = await import('./platformFeeService');
    const Doctor = (await import('../models/Doctor')).default;
    const Appointment = (await import('../models/Appointment')).default;
    const { AppointmentStatus } = await import('../constants/enums');

    const doctor = await Doctor.findOne({
      _id: doctorId,
      adminId: new mongoose.Types.ObjectId(adminId),
    }).lean();

    if (!doctor) throw AppError.notFound('Doctor not found or unauthorized');

    // 1. Fetch actual appointments for this doctor in this month
    const appointments = await Appointment.find({
      doctorId: doctor._id,
      date: { $regex: `^${monthKey}` }
    })
      .populate('patientId', 'name phone profileImage')
      .sort({ date: -1, createdAt: -1 })
      .lean();

    // 2. Fetch actual financial amounts from AdminBillingTransaction
    const txns = await AdminBillingTransaction.find({
      adminId: new mongoose.Types.ObjectId(adminId),
      type: 'DEBIT_PLATFORM_FEE',
      createdAt: { $gte: startOfMonth, $lt: endOfMonth }
    }).lean();

    const txnMap = new Map();
    for (const tx of txns) {
      if (tx.appointmentId) {
        txnMap.set(String(tx.appointmentId), Number(tx.amount || 0));
      }
    }

    const configuredPlatformFee = await platformFeeService.get();

    const orders = appointments.map((app: any) => {
      const isOffline = app.time === 'QUEUE';
      const actualFee = txnMap.get(String(app._id));
      
      return {
        _id: String(app._id),
        date: app.date,
        time: app.time,
        status: app.status,
        type: isOffline ? 'Offline' : 'Online',
        // If an actual historical transaction exists, use it. Otherwise 0.
        serviceFee: actualFee !== undefined ? actualFee : 0,
        patient: app.patientId ? {
          _id: String((app.patientId as any)._id),
          name: app.patientName || (app.patientId as any).name,
          phone: app.patientPhone || (app.patientId as any).phone,
        } : null,
        cancellation: app.cancellation,
      };
    });

    return {
      doctor: {
        _id: String(doctor._id),
        name: doctor.name,
      },
      configuredPlatformFee,
      orders,
    };
  },

  // Fetch paginated appointments for the selected facility/month so Total, Online, and Offline views can reuse one booking page without creating separate data sources.
  getFacilityMonthlyBookings: async (
    adminId: string, 
    options: { monthKey: string; doctorId?: string; patientId?: string; type?: string; page: number; limit: number; }
  ) => {
    const { monthKey, doctorId, patientId, type, page, limit } = options;
    const year = parseInt(monthKey.slice(0, 4), 10);
    const month = parseInt(monthKey.slice(5, 7), 10) - 1;
    const startOfMonth = new Date(Date.UTC(year, month, 1));
    const endOfMonth = new Date(Date.UTC(year, month + 1, 1));

    const { platformFeeService } = await import('./platformFeeService');
    const Appointment = (await import('../models/Appointment')).default;
    const Doctor = (await import('../models/Doctor')).default;
    const User = (await import('../models/User')).default;
    const AdminBillingTransaction = (await import('../models/AdminBillingTransaction')).default;

    // Verify facility doctors to restrict queries to this admin's facility
    const facilityDoctors = await Doctor.find({ adminId: new mongoose.Types.ObjectId(adminId) }).select('_id name specialization profileImage').lean();
    const facilityDoctorIds = facilityDoctors.map(d => String(d._id));
    const doctorMap = new Map(facilityDoctors.map(d => [String(d._id), d]));

    // WHAT: Fetch distinct patients that have booked with this facility's doctors in the selected month.
    // WHY: Required to populate the Patient filter dropdown on the frontend accurately.
    const distinctPatientIds = await Appointment.distinct('patientId', { 
      doctorId: { $in: facilityDoctorIds },
      date: { $regex: `^${monthKey}` }
    });
    const facilityPatients = await User.find({ _id: { $in: distinctPatientIds } }).select('_id name phone').lean();

    const query: any = {
      doctorId: { $in: facilityDoctorIds },
      date: { $regex: `^${monthKey}` }
    };

    if (doctorId && doctorId !== 'ALL') {
      if (!facilityDoctorIds.includes(doctorId)) throw AppError.forbidden('Unauthorized doctor selection');
      query.doctorId = doctorId;
    }
    
    if (patientId && patientId !== 'ALL') {
      query.patientId = patientId;
    }
    
    if (type && type !== 'ALL') {
      if (type === 'Offline') {
        query.time = 'QUEUE';
      } else if (type === 'Online') {
        query.time = { $ne: 'QUEUE' };
      }
    }

    const skip = (page - 1) * limit;

    const [appointments, total, allFiltered] = await Promise.all([
      Appointment.find(query)
        .populate('patientId', 'name phone')
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Appointment.countDocuments(query),
      Appointment.find(query).select('_id time').lean()
    ]);

    // WHAT: Calculate summary counts and payment status from the full filtered dataset rather than just the paginated slice.
    // WHY: So pagination does not make the totals incorrect when displaying the summary cards on the frontend.
    let onlineCount = 0;
    let offlineCount = 0;
    const filteredApptIds = [];
    for (const app of allFiltered) {
      filteredApptIds.push(app._id);
      if (app.time === 'QUEUE') offlineCount++;
      else onlineCount++;
    }

    // Fetch actual financial amounts from AdminBillingTransaction for ALL filtered appointments
    const allTxns = await AdminBillingTransaction.find({
      adminId: new mongoose.Types.ObjectId(adminId),
      type: 'DEBIT_PLATFORM_FEE',
      appointmentId: { $in: filteredApptIds }
    }).lean();

    let totalPayment = 0;
    const txnMap = new Map();
    for (const tx of allTxns) {
      if (tx.appointmentId) {
        const amt = Number(tx.amount || 0);
        txnMap.set(String(tx.appointmentId), amt);
        totalPayment += amt;
      }
    }

    const configuredPlatformFee = await platformFeeService.get();

    const orders = appointments.map((app: any) => {
      const isOffline = app.time === 'QUEUE';
      const actualFee = txnMap.get(String(app._id));
      const doc = doctorMap.get(String(app.doctorId));
      
      return {
        _id: String(app._id),
        date: app.date,
        time: app.time,
        status: app.status,
        type: isOffline ? 'Offline' : 'Online',
        // If an actual historical transaction exists, use it. Otherwise 0.
        serviceFee: actualFee !== undefined ? actualFee : 0,
        patient: app.patientId ? {
          _id: String((app.patientId as any)._id),
          name: app.patientName || (app.patientId as any).name,
          phone: app.patientPhone || (app.patientId as any).phone,
        } : null,
        doctor: doc ? {
          _id: String(doc._id),
          name: doc.name,
          specialization: doc.specialization,
        } : null,
        cancellation: app.cancellation,
      };
    });

    const expectedTotal = total * configuredPlatformFee;
    const isPaid = totalPayment >= expectedTotal && expectedTotal > 0;
    const paymentStatus = total === 0 ? 'No Bookings' : (isPaid ? 'All Settled' : totalPayment > 0 ? 'Partially Paid' : 'Payment Pending');

    return {
      configuredPlatformFee,
      summary: {
        totalBookings: total,
        onlineCount,
        offlineCount,
        totalPayment,
        paymentStatus,
      },
      filters: {
        doctors: facilityDoctors.map(d => ({ _id: String(d._id), name: d.name })),
        patients: facilityPatients.map(p => ({ _id: String(p._id), name: p.name })),
      },
      orders,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    };
  },
};
