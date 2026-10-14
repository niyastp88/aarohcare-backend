import Notification from '../models/Notification';
import { NotificationType } from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';
import { emitToUser, SOCKET_EVENTS } from '../realtime/socket';

const toPayload = (doc: {
  _id: unknown;
  title: string;
  body: string;
  type?: NotificationType;
  ticketId?: unknown;
  refId?: string;
  read?: boolean;
  createdAt?: Date;
}) => ({
  _id: String(doc._id),
  title: doc.title,
  body: doc.body,
  type: doc.type,
  ticketId: doc.ticketId ? String(doc.ticketId) : undefined,
  refId: doc.refId || undefined,
  read: Boolean(doc.read),
  createdAt: doc.createdAt,
});

export const notificationService = {
  create: async (data: {
    userId: string;
    title: string;
    body: string;
    type?: NotificationType;
    ticketId?: string;
    refId?: string;
  }) => {
    const doc = await Notification.create({
      userId: data.userId,
      title: data.title,
      body: data.body,
      type: data.type || NotificationType.SYSTEM,
      ticketId: data.ticketId || undefined,
      refId: data.refId || undefined,
    });
    emitToUser(data.userId, SOCKET_EVENTS.NOTIFICATION_NEW, toPayload(doc));
    return doc;
  },

  listForUser: async (userId: string) => {
    const docs = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
    return docs.map(toPayload);
  },

  unreadCount: async (userId: string) =>
    Notification.countDocuments({ userId, read: false }),

  markRead: async (userId: string, id: string) => {
    const doc = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { $set: { read: true } },
      { new: true },
    );
    if (!doc) throw AppError.notFound(MSG.NOTIFICATION_NOT_FOUND);
    return doc;
  },

  markAllRead: async (userId: string) => {
    await Notification.updateMany({ userId, read: false }, { $set: { read: true } });
    return { message: MSG.NOTIFICATIONS_READ };
  },
};
