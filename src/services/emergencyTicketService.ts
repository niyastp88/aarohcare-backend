import EmergencyTicket from '../models/EmergencyTicket';
import {
  EmergencyPriority,
  EmergencyReplyFrom,
  EmergencyTicketChannel,
  EmergencyTicketSource,
  EmergencyTicketStatus,
  NotificationType,
  UserRole,
} from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { facilityService } from './facilityService';
import { notificationService } from './notificationService';
import { emitToSuperAdmins, emitToUser, SOCKET_EVENTS } from '../realtime/socket';

const TICKET_POPULATE = [
  { path: 'facilityId', select: 'name place facilityType phone' },
  { path: 'createdBy', select: 'name email phone role healthCardId' },
];

const loadTicket = (id: string) =>
  EmergencyTicket.findById(id).populate(TICKET_POPULATE);

const idOf = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'object' && value && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
};

export const emergencyTicketService = {
  list: async (status?: string) => {
    const filter: Record<string, unknown> = {};
    if (
      status &&
      Object.values(EmergencyTicketStatus).includes(status as EmergencyTicketStatus)
    ) {
      filter.status = status;
    }
    return EmergencyTicket.find(filter)
      .populate(TICKET_POPULATE)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(300);
  },

  listMine: async (userId: string) => {
    const facility = await facilityService.findByOwner(userId);
    const filter = facility
      ? { $or: [{ createdBy: userId }, { facilityId: facility._id }] }
      : { createdBy: userId };
    return EmergencyTicket.find(filter)
      .populate(TICKET_POPULATE)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(100);
  },

  create: async (data: {
    subject: string;
    body: string;
    priority?: string;
    facilityId?: string;
    city?: string;
    createdBy: string;
    source?: EmergencyTicketSource;
    channel?: EmergencyTicketChannel;
    rating?: number;
  }) => {
    const priority = Object.values(EmergencyPriority).includes(data.priority as EmergencyPriority)
      ? (data.priority as EmergencyPriority)
      : EmergencyPriority.EMERGENCY;

    const ticket = await EmergencyTicket.create({
      subject: String(data.subject).trim(),
      body: String(data.body).trim(),
      priority,
      facilityId: data.facilityId || undefined,
      city: data.city || undefined,
      createdBy: data.createdBy,
      source: data.source || EmergencyTicketSource.SUPER_ADMIN,
      channel: data.channel || EmergencyTicketChannel.SUPER_ADMIN,
      rating: data.rating,
    });

    const created = await loadTicket(ticket.id);
    emitToSuperAdmins(SOCKET_EVENTS.TICKET_NEW, created);

    if (data.source === EmergencyTicketSource.SUPER_ADMIN && data.facilityId) {
      const facility = await facilityService.findById(data.facilityId);
      const ownerId = idOf(facility?.ownerId);
      if (ownerId) {
        await notificationService.create({
          userId: ownerId,
          title: String(data.subject).trim() || 'Message from Aarohacare Technologies Pvt Ltd',
          body: String(data.body).trim(),
          type: NotificationType.SYSTEM,
          ticketId: String(ticket._id),
        });
        emitToUser(ownerId, SOCKET_EVENTS.TICKET_NEW, created);
      }
    }

    return created;
  },

  createForSuperAdmin: async (
    createdBy: string,
    body: {
      subject?: unknown;
      body?: unknown;
      priority?: string;
      facilityId?: string;
      city?: string;
    },
  ) => {
    if (!body.subject || !body.body) {
      throw AppError.badRequest(MSG.SUBJECT_BODY_REQUIRED);
    }
    return emergencyTicketService.create({
      subject: String(body.subject),
      body: String(body.body),
      priority: body.priority,
      facilityId: body.facilityId,
      city: body.city,
      createdBy,
      source: EmergencyTicketSource.SUPER_ADMIN,
      channel: EmergencyTicketChannel.SUPER_ADMIN,
    });
  },

  createFromPatientFeedback: async (patientId: string, rating: number, message: string) =>
    emergencyTicketService.create({
      subject: `Patient feedback (${rating}/5)`,
      body: message,
      priority: EmergencyPriority.NORMAL,
      createdBy: patientId,
      source: EmergencyTicketSource.PATIENT,
      channel: EmergencyTicketChannel.FEEDBACK,
      rating,
    }),

  createFromFacilityAdmin: async (
    userId: string,
    body: {
      subject?: unknown;
      body?: unknown;
      priority?: string;
      channel?: string;
    },
  ) => {
    const text = String(body.body || '').trim();
    if (text.length < 4) throw AppError.badRequest(MSG.FEEDBACK_LENGTH);

    const channel = Object.values(EmergencyTicketChannel).includes(
      body.channel as EmergencyTicketChannel,
    )
      ? (body.channel as EmergencyTicketChannel)
      : EmergencyTicketChannel.SUPPORT;

    const facility = await facilityService.findByOwner(userId);
    const subject =
      String(body.subject || '').trim() ||
      (channel === EmergencyTicketChannel.SETTINGS_ALERT
        ? 'Super Admin Alert'
        : 'Support request');

    return emergencyTicketService.create({
      subject,
      body: text,
      priority: body.priority || EmergencyPriority.EMERGENCY,
      facilityId: facility ? String(facility._id) : undefined,
      city: facility?.place,
      createdBy: userId,
      source: EmergencyTicketSource.FACILITY_ADMIN,
      channel,
    });
  },

  createForUser: async (userId: string, role: UserRole, body: Record<string, unknown>) => {
    if (role === UserRole.PATIENT) {
      throw AppError.badRequest(MSG.USE_FEEDBACK);
    }
    if (role !== UserRole.ADMIN) {
      throw AppError.forbidden(MSG.NOT_ALLOWED);
    }
    return emergencyTicketService.createFromFacilityAdmin(userId, body);
  },

  reply: async (id: string, body: string, authorId: string, fromRole: EmergencyReplyFrom) =>
    EmergencyTicket.findByIdAndUpdate(
      id,
      {
        $push: {
          replies: {
            body,
            authorId,
            fromRole,
            createdAt: new Date(),
          },
        },
      },
      { new: true },
    ).populate(TICKET_POPULATE),

  replyForOwner: async (id: string, bodyRaw: unknown, userId: string, priorityRaw?: unknown) => {
    const body = String(bodyRaw || '').trim();
    if (!body) throw AppError.badRequest(MSG.BODY_REQUIRED);

    const existing = await EmergencyTicket.findById(id);
    if (!existing) throw AppError.notFound(MSG.TICKET_NOT_FOUND);
    if (existing.status === EmergencyTicketStatus.RESOLVED) {
      throw AppError.badRequest(MSG.TICKET_CLOSED);
    }

    const isCreator = idOf(existing.createdBy) === userId;
    let isFacilityOwner = false;
    if (!isCreator && existing.facilityId) {
      const facility = await facilityService.findByOwner(userId);
      isFacilityOwner = Boolean(facility && idOf(facility._id) === idOf(existing.facilityId));
    }
    if (!isCreator && !isFacilityOwner) throw AppError.forbidden(MSG.NOT_ALLOWED);

    if (priorityRaw === EmergencyPriority.EMERGENCY || priorityRaw === 'EMERGENCY') {
      existing.priority = EmergencyPriority.EMERGENCY;
      await existing.save();
    }

    const ticket = await emergencyTicketService.reply(id, body, userId, EmergencyReplyFrom.USER);
    if (!ticket) throw AppError.notFound(MSG.TICKET_NOT_FOUND);

    emitToSuperAdmins(SOCKET_EVENTS.TICKET_REPLY, ticket);
    emitToUser(userId, SOCKET_EVENTS.TICKET_REPLY, ticket);
    return ticket;
  },

  replyForSuperAdmin: async (id: string, bodyRaw: unknown, authorId: string) => {
    const body = String(bodyRaw || '').trim();
    if (!body) throw AppError.badRequest(MSG.BODY_REQUIRED);

    const ticket = await emergencyTicketService.reply(
      id,
      body,
      authorId,
      EmergencyReplyFrom.SUPER_ADMIN,
    );
    if (!ticket) throw AppError.notFound(MSG.TICKET_NOT_FOUND);

    const source = ticket.source || EmergencyTicketSource.SUPER_ADMIN;
    const createdById = idOf(ticket.createdBy);

    let notifyUserId = '';
    if (
      createdById &&
      (source === EmergencyTicketSource.PATIENT ||
        source === EmergencyTicketSource.FACILITY_ADMIN)
    ) {
      notifyUserId = createdById;
    } else if (source === EmergencyTicketSource.SUPER_ADMIN && ticket.facilityId) {
      const facility = await facilityService.findById(idOf(ticket.facilityId));
      notifyUserId = idOf(facility?.ownerId);
    }

    if (notifyUserId) {
      await notificationService.create({
        userId: notifyUserId,
        title: 'Reply from Aarohacare Technologies Pvt Ltd',
        body,
        type: NotificationType.EMERGENCY_REPLY,
        ticketId: String(ticket._id),
      });
      emitToUser(notifyUserId, SOCKET_EVENTS.TICKET_REPLY, ticket);
    }
    emitToSuperAdmins(SOCKET_EVENTS.TICKET_REPLY, ticket);

    return ticket;
  },

  resolve: async (id: string) =>
    EmergencyTicket.findByIdAndUpdate(
      id,
      {
        status: EmergencyTicketStatus.RESOLVED,
        resolvedAt: new Date(),
      },
      { new: true },
    ).populate(TICKET_POPULATE),

  resolveForSuperAdmin: async (id: string) => {
    const ticket = await emergencyTicketService.resolve(id);
    if (!ticket) throw AppError.notFound(MSG.TICKET_NOT_FOUND);
    emitToSuperAdmins(SOCKET_EVENTS.TICKET_RESOLVED, ticket);
    const createdById = idOf(ticket.createdBy);
    if (createdById && ticket.source !== EmergencyTicketSource.SUPER_ADMIN) {
      emitToUser(createdById, SOCKET_EVENTS.TICKET_RESOLVED, ticket);
    }
    if (ticket.facilityId) {
      const facility = await facilityService.findById(idOf(ticket.facilityId));
      const ownerId = idOf(facility?.ownerId);
      if (ownerId) emitToUser(ownerId, SOCKET_EVENTS.TICKET_RESOLVED, ticket);
    }
    return ticket;
  },

  countOpen: async () =>
    EmergencyTicket.countDocuments({ status: EmergencyTicketStatus.OPEN }),
};
