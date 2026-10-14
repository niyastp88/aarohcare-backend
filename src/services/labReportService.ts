// This file was updated to improve the Lab Reports search functionality.
// It now allows searching reports by the patient's name and phone number.
// It also updates the Dashboard stats to only show reports created today instead of the last 7 days.
// It allows the Lab Report title to be optional by providing a default title if none is passed.
import LabReport from '../models/LabReport';
import Facility from '../models/Facility';
import AdminBillingTransaction from '../models/AdminBillingTransaction';
import Notification from '../models/Notification';
import User from '../models/User';
import { FacilityType, NotificationType, UserRole } from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { facilityService } from './facilityService';
import { notificationService } from './notificationService';
import { authService, toLocalPhone } from './authService';
import { platformFeeService } from './platformFeeService';
import { getNowInAppTz } from '../utils/dateTime';
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const REPORT_POPULATE = [
  { path: 'facilityId', select: 'name facilityType' },
  { path: 'patientId', select: 'name phone age gender bloodGroup profileImage address place' },
];

const toPatientSummary = (patient: {
  _id: unknown;
  name?: string;
  phone?: string;
  place?: string;
  age?: number;
  gender?: string;
  profileImage?: string;
  address?: string;
  healthCardId?: string;
}) => ({
  _id: String(patient._id),
  name: patient.name,
  phone: patient.phone,
  place: patient.place,
  age: patient.age,
  gender: patient.gender,
  profileImage: patient.profileImage,
  address: patient.address,
  healthCardId: patient.healthCardId,
});

export const labReportService = {
  list: async (opts?: {
    facilityId?: string;
    patientId?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
  }) => {
    const filter: Record<string, unknown> = {};
    if (opts?.facilityId) filter.facilityId = opts.facilityId;
    if (opts?.patientId) filter.patientId = opts.patientId;

    if (opts?.fromDate || opts?.toDate) {
      const createdAt: Record<string, Date> = {};
      if (opts.fromDate) createdAt.$gte = new Date(`${opts.fromDate}T00:00:00.000Z`);
      if (opts.toDate) createdAt.$lte = new Date(`${opts.toDate}T23:59:59.999Z`);
      filter.createdAt = createdAt;
    }

    if (opts?.search?.trim()) {
      const q = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      const matchedUsers = await User.find({
        $or: [
          { name: { $regex: q, $options: 'i' } },
          { phone: { $regex: q, $options: 'i' } },
        ]
      }).select('_id').lean();
      
      const userIds = matchedUsers.map(u => u._id);

      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { notes: { $regex: q, $options: 'i' } },
      ];
      
      if (userIds.length > 0) {
        (filter.$or as any[]).push({ patientId: { $in: userIds } });
      }
    }

    return LabReport.find(filter)
      .populate(REPORT_POPULATE)
      .sort({ createdAt: -1 })
      .limit(500);
  },

  create: async (data: {
    facilityId: string;
    patientId: string;
    title: string;
    reportUrl: string;
    notes?: string;
  }) => {
    if (!data.reportUrl || !String(data.reportUrl).trim()) {
      throw AppError.badRequest('Report file is required');
    }
    const created = await LabReport.create({
      facilityId: data.facilityId,
      patientId: data.patientId,
      title: String(data.title).trim(),
      reportUrl: String(data.reportUrl).trim(),
      notes: data.notes || undefined,
    });

    try {
      const facility = await Facility.findById(data.facilityId);
      if (facility?.ownerId) {
        const baseFee = await platformFeeService.get();
        const platformFee = facility.convenienceFeeOverride ?? baseFee;
        if (platformFee > 0) {
          await AdminBillingTransaction.create({
            adminId: facility.ownerId,
            amount: platformFee,
            type: 'DEBIT_PLATFORM_FEE',
            description: `Platform service fee for lab report: ${created.title}`,
          });
        }
      }
    } catch (billingErr) {
      console.error('[LabReport] Failed to create billing transaction for report:', billingErr);
    }

    return LabReport.findById(created._id).populate(REPORT_POPULATE);
  },

  /** Find a registered patient by phone so lab admin can send them a report. */
  
  searchPatientsForFacilityAdmin: async (adminId: string, queryRaw: string) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    const q = String(queryRaw || '').trim();
    if (!q) return [];

    const digits = q.replace(/\D/g, '');
    const filter: Record<string, unknown> = { role: UserRole.PATIENT };

    if (digits.length > 0) {
      filter.$or = [
        { phone: { $regex: digits, $options: 'i' } },
        { name: { $regex: q, $options: 'i' } },
      ];
    } else {
      filter.name = { $regex: q, $options: 'i' };
    }

    const patients = await User.find(filter)
      .select('name phone place age gender profileImage address healthCardId')
      .limit(10);

    const facilityId = facility._id;
    const items = await Promise.all(
      patients.map(async (patient) => {
        const reportCount = await LabReport.countDocuments({
          facilityId,
          patientId: patient._id,
        });
        const last = await LabReport.findOne({ facilityId, patientId: patient._id })
          .sort({ createdAt: -1 })
          .select('title createdAt');
        return {
          ...toPatientSummary(patient),
          reportCount,
          lastReportAt: last?.createdAt,
          lastTitle: last?.title,
        };
      }),
    );

    return items;
  },

  lookupPatientByPhoneForFacilityAdmin: async (adminId: string, phoneRaw: string) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    const phone = toLocalPhone(String(phoneRaw || ''));
    if (phone.length < 10) {
      throw AppError.badRequest('Enter a valid 10-digit mobile number');
    }

    const patient = await authService.findByPhoneLoose(phone, UserRole.PATIENT);
    if (!patient) {
      throw AppError.notFound(MSG.NO_ACCOUNT_PHONE);
    }

    const facilityId = facility._id;
    const reportCount = await LabReport.countDocuments({
      facilityId,
      patientId: patient._id,
    });
    const last = await LabReport.findOne({ facilityId, patientId: patient._id })
      .sort({ createdAt: -1 })
      .select('title createdAt');

    return {
      ...toPatientSummary(patient),
      reportCount,
      lastReportAt: last?.createdAt,
      lastTitle: last?.title,
    };
  },

  getPatientForFacilityAdmin: async (adminId: string, patientId: string) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    const doc = await User.findOne({ _id: patientId, role: UserRole.PATIENT });
    if (!doc) throw AppError.notFound(MSG.NOT_FOUND);

    const facilityId = facility._id;
    const reportCount = await LabReport.countDocuments({
      facilityId,
      patientId: doc._id,
    });
    const last = await LabReport.findOne({ facilityId, patientId: doc._id })
      .sort({ createdAt: -1 })
      .select('title createdAt');

    return {
      ...toPatientSummary(doc),
      reportCount,
      lastReportAt: last?.createdAt,
      lastTitle: last?.title,
    };
  },

  createForFacilityAdmin: async (
    adminId: string,
    body: {
      patientId?: unknown;
      phone?: unknown;
      title?: unknown;
      reportUrl?: unknown;
      notes?: unknown;
    },
  ) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    let patientId = String(body.patientId || '').trim();
    if (!patientId && body.phone) {
      const found = await labReportService.lookupPatientByPhoneForFacilityAdmin(
        adminId,
        String(body.phone),
      );
      patientId = found._id;
    }

    const title = String(body.title || '').trim() || 'Lab Report';
    if (!patientId) {
      throw AppError.badRequest('Patient (id or phone) is required');
    }

    const reportUrl = String(body.reportUrl || '').trim();
    if (!reportUrl) {
      throw AppError.badRequest('Report file is required');
    }

    const patient = await User.findOne({ _id: patientId, role: UserRole.PATIENT });
    if (!patient) throw AppError.notFound(MSG.NO_ACCOUNT_PHONE);

    const report = await labReportService.create({
      facilityId: String(facility._id),
      patientId,
      title,
      reportUrl,
      notes: body.notes ? String(body.notes) : undefined,
    });

    try {
      await notificationService.create({
        userId: patientId,
        title: 'New lab report',
        body: `${facility.name || 'Your lab'} shared “${title}” with you.`,
      });
    } catch {
      // Report is already saved; notification is best-effort.
    }

    return report;
  },

  listForPatient: async (patientId: string) =>
    labReportService.list({ patientId }),

  /** Patient asks a lab admin to upload / share their pending report. */
  remindLabAdmin: async (patientId: string, facilityIdRaw: unknown) => {
    const facilityId = String(facilityIdRaw || '').trim();
    if (!facilityId) {
      throw AppError.badRequest(MSG.LAB_REMINDER_FACILITY_REQUIRED);
    }

    const facility = await Facility.findById(facilityId).select('name facilityType ownerId');
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    if (facility.facilityType !== FacilityType.LAB) {
      throw AppError.badRequest(MSG.LAB_REMINDER_NOT_LAB);
    }

    const patient = await User.findOne({ _id: patientId, role: UserRole.PATIENT }).select(
      'name phone',
    );
    if (!patient) throw AppError.notFound(MSG.USER_NOT_FOUND);

    const ownerId = String(facility.ownerId);
    const refId = `lab-reminder:${patientId}:${facilityId}`;
    const since = new Date(Date.now() - REMINDER_COOLDOWN_MS);
    const recent = await Notification.findOne({
      type: NotificationType.LAB_REPORT_REMINDER,
      refId,
      createdAt: { $gte: since },
    }).select('_id');
    if (recent) throw AppError.conflict(MSG.LAB_REMINDER_COOLDOWN);

    const patientName = patient.name?.trim() || 'A patient';
    const patientPhone = String(patient.phone || '').trim();
    const phoneLine = patientPhone
      ? ` Patient phone: ${patientPhone}. Open Users and search this number to upload the report.`
      : '';
    await notificationService.create({
      userId: ownerId,
      title: 'Lab report reminder',
      body: `${patientName} is waiting for their lab report from ${facility.name || 'your lab'}.${phoneLine}`,
      type: NotificationType.LAB_REPORT_REMINDER,
      refId,
    });

    return { message: MSG.LAB_REMINDER_SENT };
  },

  listForFacilityAdmin: async (
    adminId: string,
    opts?: { patientId?: string; fromDate?: string; toDate?: string; search?: string },
  ) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    return labReportService.list({
      facilityId: String(facility._id),
      ...opts,
    });
  },

  statsForFacilityAdmin: async (adminId: string) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);
    const facilityId = facility._id;

    const todayStr = getNowInAppTz().date;
    const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`);

    const [totalReports, newReports, distinctPatients, monthly] = await Promise.all([
      LabReport.countDocuments({ facilityId }),
      LabReport.countDocuments({ facilityId, createdAt: { $gte: startOfToday, $lte: endOfToday } }),
      LabReport.distinct('patientId', { facilityId }),
      LabReport.aggregate<{ _id: { year: number; month: number }; count: number }>([
        { $match: { facilityId } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
        { $limit: 6 },
      ]),
    ]);

    return {
      totalReports,
      newReports,
      pendingReports: newReports,
      allUsers: distinctPatients.length,
      monthly: monthly.map((row) => ({
        year: row._id.year,
        month: row._id.month,
        count: row.count,
      })),
    };
  },

  listPatientsForFacilityAdmin: async (
    adminId: string,
    opts?: { search?: string; fromDate?: string; toDate?: string; page?: number; limit?: number },
  ) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    const page = Math.max(1, Number(opts?.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(opts?.limit) || 20));
    const match: Record<string, unknown> = { facilityId: facility._id };

    if (opts?.fromDate || opts?.toDate) {
      const createdAt: Record<string, Date> = {};
      if (opts.fromDate) createdAt.$gte = new Date(`${opts.fromDate}T00:00:00.000Z`);
      if (opts.toDate) createdAt.$lte = new Date(`${opts.toDate}T23:59:59.999Z`);
      match.createdAt = createdAt;
    }

    const pipeline: Record<string, unknown>[] = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$patientId',
          reportCount: { $sum: 1 },
          lastReportAt: { $first: '$createdAt' },
          lastTitle: { $first: '$title' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'patient',
        },
      },
      { $unwind: '$patient' },
    ];

    if (opts?.search?.trim()) {
      const q = opts.search.trim();
      pipeline.push({
        $match: {
          $or: [
            { 'patient.name': { $regex: q, $options: 'i' } },
            { 'patient.phone': { $regex: q, $options: 'i' } },
            { lastTitle: { $regex: q, $options: 'i' } },
          ],
        },
      });
    }

    pipeline.push({
      $facet: {
        items: [
          { $sort: { lastReportAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: '$patient._id',
              name: '$patient.name',
              phone: '$patient.phone',
              place: '$patient.place',
              age: '$patient.age',
              gender: '$patient.gender',
              profileImage: '$patient.profileImage',
              address: '$patient.address',
              healthCardId: '$patient.healthCardId',
              reportCount: 1,
              lastReportAt: 1,
              lastTitle: 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    });

    const [result] = await LabReport.aggregate(pipeline as any);
    const total = result?.total?.[0]?.count ?? 0;
    return {
      items: result?.items ?? [],
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  },

  deleteById: async (id: string) => LabReport.findByIdAndDelete(id),

  deleteForSuperAdmin: async (id: string) => {
    const report = await labReportService.deleteById(id);
    if (!report) throw AppError.notFound(MSG.REPORT_NOT_FOUND);
    return MSG.REPORT_DELETED;
  },

  /** Lab (facility) admin deletes a report that belongs to their own facility. */
  deleteForFacilityAdmin: async (adminId: string, reportId: string) => {
    const facility = await facilityService.findByOwner(adminId);
    if (!facility) throw AppError.notFound(MSG.FACILITY_NOT_FOUND);

    const report = await LabReport.findById(reportId);
    if (!report) throw AppError.notFound(MSG.REPORT_NOT_FOUND);

    if (String(report.facilityId) !== String(facility._id)) {
      throw AppError.forbidden('You can only delete reports from your own facility');
    }

    await LabReport.findByIdAndDelete(reportId);
    return MSG.REPORT_DELETED;
  },
};
