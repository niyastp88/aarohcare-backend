import {
  AppointmentStatus,
  FacilityApprovalStatus,
  FacilityType,
  PaymentStatus,
  UserRole,
} from '../constants/enums';
import Ad from '../models/Ad';
import Appointment from '../models/Appointment';
import EmergencyTicket from '../models/EmergencyTicket';
import Facility from '../models/Facility';
import User from '../models/User';
import { platformFeeService } from './platformFeeService';
import { adService } from './adService';
import { emergencyTicketService } from './emergencyTicketService';
import { facilityService } from './facilityService';
import { userService } from './userService';

const RANGE_DAYS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_DAYS)[number];

type PaidRow = {
  consultationFee?: number;
  platformFee?: number;
  createdAt: Date;
  patientId?: unknown;
  arrivedAt?: Date;
  completedAt?: Date;
  status?: string;
  facilityId?: unknown;
  facilityName?: string;
  facilityType?: string;
  place?: string;
};

const ymd = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const monthKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const monthLabel = (key: string) => {
  const [yearRaw, monthRaw] = key.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
  return new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'short' });
};

const lastMonths = (count: number) => {
  const now = new Date();
  const months: { key: string; start: Date; end: Date }[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    months.push({ key: monthKey(start), start, end });
  }
  return months;
};

const percentChange = (current: number, previous: number) => {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

const money = (row: { consultationFee?: number; platformFee?: number }) =>
  Number(row.consultationFee || 0) + Number(row.platformFee || 0);

const regionName = (place?: string) => {
  const value = String(place || '').trim();
  return value || 'Unspecified';
};

const parseRangeDays = (raw: unknown): RangeDays => {
  const days = Number(raw);
  return RANGE_DAYS.includes(days as RangeDays) ? (days as RangeDays) : 30;
};

const paidWithFacility = async (from: Date, to: Date) =>
  Appointment.aggregate<PaidRow>([
    {
      $match: {
        paymentStatus: PaymentStatus.PAID,
        createdAt: { $gte: from, $lt: to },
      },
    },
    {
      $lookup: {
        from: 'doctors',
        localField: 'doctorId',
        foreignField: '_id',
        as: 'doctor',
      },
    },
    { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'facilities',
        localField: 'doctor.facilityId',
        foreignField: '_id',
        as: 'facility',
      },
    },
    { $unwind: { path: '$facility', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        consultationFee: 1,
        platformFee: 1,
        createdAt: 1,
        patientId: 1,
        arrivedAt: 1,
        completedAt: 1,
        status: 1,
        facilityId: '$facility._id',
        facilityName: '$facility.name',
        facilityType: '$facility.facilityType',
        place: '$facility.place',
      },
    },
  ]);

const inRange = (date: Date, from: Date, to: Date) => date >= from && date < to;

const avgConsultMinutes = (rows: PaidRow[]) => {
  const durations = rows
    .map((row) => {
      if (!row.arrivedAt || !row.completedAt) return null;
      const minutes =
        (new Date(row.completedAt).getTime() - new Date(row.arrivedAt).getTime()) / 60_000;
      return minutes > 0 && minutes < 24 * 60 ? minutes : null;
    })
    .filter((value): value is number => value != null);
  if (!durations.length) return 0;
  return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
};

const serviceLabel = (type?: string) => {
  if (type === FacilityType.HOSPITAL) return 'Hospitals';
  if (type === FacilityType.LAB) return 'Labs';
  if (type === FacilityType.CLINIC) return 'Clinics';
  return 'Other';
};

const departmentLabel = (type?: string) => {
  if (type === FacilityType.HOSPITAL) return 'Medical';
  if (type === FacilityType.LAB) return 'Diagnostics';
  if (type === FacilityType.CLINIC) return 'Clinics';
  return 'Other';
};

export const superAdminDashboardService = {
  getStats: async () => {
    const today = ymd(new Date());
    const [
      clinics,
      hospitals,
      labs,
      patients,
      pendingFacilities,
      openEmergencies,
      activeAds,
      todayPaid,
      pendingList,
      recentFacilities,
      recentEmergencies,
      recentPayments,
      recentAds,
    ] = await Promise.all([
      facilityService.countByType(FacilityType.CLINIC),
      facilityService.countByType(FacilityType.HOSPITAL),
      facilityService.countByType(FacilityType.LAB),
      userService.countPatients(),
      facilityService.countPending(),
      emergencyTicketService.countOpen(),
      adService.countActive(),
      Appointment.aggregate<{ total: number; platform: number; count: number }>([
        { $match: { paymentStatus: PaymentStatus.PAID, date: today } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $add: [{ $ifNull: ['$consultationFee', 0] }, { $ifNull: ['$platformFee', 0] }],
              },
            },
            platform: { $sum: { $ifNull: ['$platformFee', 0] } },
            count: { $sum: 1 },
          },
        },
      ]),
      Facility.find({ approvalStatus: FacilityApprovalStatus.PENDING })
        .select('name facilityType place email phone createdAt')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      Facility.find()
        .select('name facilityType approvalStatus createdAt')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      EmergencyTicket.find()
        .select('subject status priority city createdAt')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Appointment.find({ paymentStatus: PaymentStatus.PAID })
        .select('consultationFee platformFee paymentStatus createdAt')
        .populate({
          path: 'doctorId',
          select: 'name facilityId',
          populate: { path: 'facilityId', select: 'name' },
        })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Ad.find().select('name status createdAt').sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    const todayRow = todayPaid[0];
    const activity = [
      ...recentFacilities.map((row) => ({
        id: String(row._id),
        type: 'facility' as const,
        title: row.name,
        detail:
          row.approvalStatus === FacilityApprovalStatus.PENDING
            ? `${row.facilityType} registration pending review`
            : `${row.facilityType} ${String(row.approvalStatus || 'UPDATED').toLowerCase()}`,
        tone:
          row.approvalStatus === FacilityApprovalStatus.PENDING
            ? ('amber' as const)
            : ('blue' as const),
        createdAt: row.createdAt,
      })),
      ...recentEmergencies.map((row) => ({
        id: String(row._id),
        type: 'emergency' as const,
        title: row.subject,
        detail: row.city ? `${row.status} · ${row.city}` : row.status,
        tone: row.status === 'OPEN' ? ('red' as const) : ('green' as const),
        createdAt: row.createdAt,
      })),
      ...recentPayments.map((row) => {
        const doctor = row.doctorId as unknown as {
          name?: string;
          facilityId?: { name?: string };
        };
        return {
          id: String(row._id),
          type: 'payment' as const,
          title: doctor?.facilityId?.name || doctor?.name || 'Payment received',
          detail: `Paid ₹${money(row).toLocaleString('en-IN')}`,
          tone: 'green' as const,
          createdAt: row.createdAt,
        };
      }),
      ...recentAds.map((row) => ({
        id: String(row._id),
        type: 'ad' as const,
        title: row.name,
        detail: `Campaign ${String(row.status).toLowerCase()}`,
        tone: 'blue' as const,
        createdAt: row.createdAt,
      })),
    ]
      .sort(
        (a, b) =>
          new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
      )
      .slice(0, 10);

    return {
      clinics,
      hospitals,
      labs,
      patients,
      pendingFacilities,
      openEmergencies,
      activeAds,
      platformServiceFee: await platformFeeService.get(),
      todayRevenue: todayRow?.total ?? 0,
      todayPlatformShare: todayRow?.platform ?? 0,
      todayPaidCount: todayRow?.count ?? 0,
      pendingRequests: pendingList.map((row) => ({
        _id: String(row._id),
        name: row.name,
        facilityType: row.facilityType,
        place: row.place || '',
        email: row.email || '',
        phone: row.phone || '',
        createdAt: row.createdAt,
      })),
      recentActivity: activity,
    };
  },

  getAnalytics: async (daysRaw?: unknown) => {
    const rangeDays = parseRangeDays(daysRaw);
    const now = new Date();
    const rangeTo = now;
    const rangeFrom = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const prevFrom = new Date(rangeFrom.getTime() - rangeDays * 24 * 60 * 60 * 1000);
    const twelveMonthsAgo = lastMonths(12)[0]?.start ?? new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      paidRows,
      consultationsCurrent,
      consultationsPrevious,
      newClinicsCurrent,
      newClinicsPrevious,
      patientsCurrent,
      patientsPrevious,
      patientsThisMonth,
      patientsPrevMonth,
      approvedTotal,
      approvedActive,
      patientMonthly,
    ] = await Promise.all([
      paidWithFacility(twelveMonthsAgo, rangeTo),
      Appointment.countDocuments({
        status: { $ne: AppointmentStatus.CANCELLED },
        createdAt: { $gte: rangeFrom, $lt: rangeTo },
      }),
      Appointment.countDocuments({
        status: { $ne: AppointmentStatus.CANCELLED },
        createdAt: { $gte: prevFrom, $lt: rangeFrom },
      }),
      Facility.countDocuments({
        facilityType: FacilityType.CLINIC,
        createdAt: { $gte: rangeFrom, $lt: rangeTo },
      }),
      Facility.countDocuments({
        facilityType: FacilityType.CLINIC,
        createdAt: { $gte: prevFrom, $lt: rangeFrom },
      }),
      User.countDocuments({
        role: UserRole.PATIENT,
        createdAt: { $gte: rangeFrom, $lt: rangeTo },
      }),
      User.countDocuments({
        role: UserRole.PATIENT,
        createdAt: { $gte: prevFrom, $lt: rangeFrom },
      }),
      User.countDocuments({
        role: UserRole.PATIENT,
        createdAt: { $gte: monthStart, $lt: rangeTo },
      }),
      User.countDocuments({
        role: UserRole.PATIENT,
        createdAt: { $gte: prevMonthStart, $lt: monthStart },
      }),
      Facility.countDocuments({ approvalStatus: FacilityApprovalStatus.APPROVED }),
      Facility.countDocuments({
        approvalStatus: FacilityApprovalStatus.APPROVED,
        isActive: true,
      }),
      User.aggregate<{ _id: { year: number; month: number }; count: number }>([
        { $match: { role: UserRole.PATIENT, createdAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const currentPaid = paidRows.filter((row) => inRange(new Date(row.createdAt), rangeFrom, rangeTo));
    const previousPaid = paidRows.filter((row) =>
      inRange(new Date(row.createdAt), prevFrom, rangeFrom),
    );

    const revenue = currentPaid.reduce((sum, row) => sum + money(row), 0);
    const previousRevenue = previousPaid.reduce((sum, row) => sum + money(row), 0);

    const patientCounts = new Map<string, number>();
    for (const row of currentPaid) {
      const id = String(row.patientId || '');
      if (!id) continue;
      patientCounts.set(id, (patientCounts.get(id) || 0) + 1);
    }
    const activeUsers = patientCounts.size;
    const returningUsers = [...patientCounts.values()].filter((count) => count >= 2).length;
    const retentionRate = activeUsers === 0 ? 0 : Math.round((returningUsers / activeUsers) * 1000) / 10;

    const prevPatientCounts = new Map<string, number>();
    for (const row of previousPaid) {
      const id = String(row.patientId || '');
      if (!id) continue;
      prevPatientCounts.set(id, (prevPatientCounts.get(id) || 0) + 1);
    }
    const prevActive = prevPatientCounts.size;
    const prevReturning = [...prevPatientCounts.values()].filter((count) => count >= 2).length;
    const prevRetention = prevActive === 0 ? 0 : Math.round((prevReturning / prevActive) * 1000) / 10;

    const months = lastMonths(12);
    const revenueByMonth = new Map<string, number>();
    const consultsByMonth = new Map<string, number>();
    const returningByMonth = new Map<string, Set<string>>();
    for (const month of months) {
      revenueByMonth.set(month.key, 0);
      consultsByMonth.set(month.key, 0);
      returningByMonth.set(month.key, new Set());
    }
    for (const row of paidRows) {
      const key = monthKey(new Date(row.createdAt));
      if (!revenueByMonth.has(key)) continue;
      revenueByMonth.set(key, (revenueByMonth.get(key) || 0) + money(row));
      consultsByMonth.set(key, (consultsByMonth.get(key) || 0) + 1);
      const patientId = String(row.patientId || '');
      if (patientId) returningByMonth.get(key)?.add(patientId);
    }

    const acquisitionByMonth = new Map<string, number>();
    for (const month of months) acquisitionByMonth.set(month.key, 0);
    for (const row of patientMonthly) {
      const key = `${row._id.year}-${String(row._id.month).padStart(2, '0')}`;
      if (acquisitionByMonth.has(key)) acquisitionByMonth.set(key, row.count);
    }

    const serviceTotals = new Map<string, number>();
    const departmentTotals = new Map<string, number>();
    const facilityTotals = new Map<string, { name: string; value: number }>();
    const regionMap = new Map<
      string,
      {
        revenue: number;
        consultations: number;
        users: Set<string>;
        facilities: Set<string>;
        monthly: Map<string, number>;
      }
    >();

    const ensureRegion = (region: string) => {
      const existing = regionMap.get(region);
      if (existing) return existing;
      const created = {
        revenue: 0,
        consultations: 0,
        users: new Set<string>(),
        facilities: new Set<string>(),
        monthly: new Map<string, number>(months.map((month) => [month.key, 0])),
      };
      regionMap.set(region, created);
      return created;
    };

    for (const row of currentPaid) {
      const service = serviceLabel(row.facilityType);
      const department = departmentLabel(row.facilityType);
      serviceTotals.set(service, (serviceTotals.get(service) || 0) + money(row));
      departmentTotals.set(department, (departmentTotals.get(department) || 0) + money(row));
      const facilityId = String(row.facilityId || row.facilityName || 'unknown');
      const current = facilityTotals.get(facilityId) || {
        name: row.facilityName || 'Unknown facility',
        value: 0,
      };
      current.value += money(row);
      facilityTotals.set(facilityId, current);

      const region = ensureRegion(regionName(row.place));
      region.revenue += money(row);
      region.consultations += 1;
      if (row.patientId) region.users.add(String(row.patientId));
      if (row.facilityId) region.facilities.add(String(row.facilityId));
    }

    const prevRegionRevenue = new Map<string, number>();
    for (const row of previousPaid) {
      const region = regionName(row.place);
      prevRegionRevenue.set(region, (prevRegionRevenue.get(region) || 0) + money(row));
    }

    for (const row of paidRows) {
      const region = regionMap.get(regionName(row.place));
      if (!region) continue;
      const key = monthKey(new Date(row.createdAt));
      if (region.monthly.has(key)) {
        region.monthly.set(key, (region.monthly.get(key) || 0) + money(row));
      }
    }

    const facilitiesOnlinePct =
      approvedTotal === 0 ? 0 : Math.round((approvedActive / approvedTotal) * 1000) / 10;
    const avgMinutes = avgConsultMinutes(currentPaid);
    const prevAvgMinutes = avgConsultMinutes(previousPaid);

    const topRegions = [...regionMap.entries()]
      .map(([region, stats]) => ({
        region,
        activeUsers: stats.users.size,
        growthPct: percentChange(stats.revenue, prevRegionRevenue.get(region) || 0),
      }))
      .sort((a, b) => b.activeUsers - a.activeUsers)
      .slice(0, 6);

    return {
      rangeDays,
      kpis: {
        consultations: {
          value: consultationsCurrent,
          changePct: percentChange(consultationsCurrent, consultationsPrevious),
        },
        revenue: {
          value: Math.round(revenue),
          changePct: percentChange(revenue, previousRevenue),
        },
        newClinics: {
          value: newClinicsCurrent,
          changePct: percentChange(newClinicsCurrent, newClinicsPrevious),
        },
        retentionRate: {
          value: retentionRate,
          changePct: percentChange(retentionRate, prevRetention),
        },
        activeUsers: {
          value: activeUsers,
          changePct: percentChange(activeUsers, prevActive),
        },
        monthlyGrowth: {
          value: patientsThisMonth,
          changePct: percentChange(patientsThisMonth, patientsPrevMonth),
        },
        avgConsultMinutes: {
          value: avgMinutes,
          changePct: percentChange(avgMinutes, prevAvgMinutes),
        },
        facilitiesOnlinePct: {
          value: facilitiesOnlinePct,
          label:
            facilitiesOnlinePct >= 95
              ? 'Optimal'
              : facilitiesOnlinePct >= 80
                ? 'Healthy'
                : approvedTotal === 0
                  ? 'No facilities'
                  : 'Needs attention',
        },
        newPatients: {
          value: patientsCurrent,
          changePct: percentChange(patientsCurrent, patientsPrevious),
        },
      },
      revenueTrend: months.map((month) => ({
        month: monthLabel(month.key),
        value: Math.round(revenueByMonth.get(month.key) || 0),
      })),
      revenueByService: [...serviceTotals.entries()]
        .map(([label, value]) => ({ label, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value),
      topFacilities: [...facilityTotals.values()]
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map((row) => ({ name: row.name, value: Math.round(row.value) })),
      topRegions,
      acquisitionVsRetention: months.map((month) => ({
        month: monthLabel(month.key),
        acquisition: acquisitionByMonth.get(month.key) || 0,
        retention: returningByMonth.get(month.key)?.size || 0,
      })),
      revenueByDepartment: [...departmentTotals.entries()]
        .map(([label, value]) => ({ label, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value),
      regionalMatrix: [...regionMap.entries()]
        .map(([region, stats]) => ({
          region,
          activeClinics: stats.facilities.size,
          consultations: stats.consultations,
          revenue: Math.round(stats.revenue),
          trend: months.slice(-6).map((month) => Math.round(stats.monthly.get(month.key) || 0)),
          growthPct: percentChange(stats.revenue, prevRegionRevenue.get(region) || 0),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  },
};

export const parsePaymentStatus = (raw?: unknown) =>
  raw && Object.values(PaymentStatus).includes(raw as PaymentStatus)
    ? String(raw)
    : undefined;
