import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { UserRole } from '../constants/enums';
import { AUTH_COOKIE, SUPERADMIN_AUTH_COOKIE } from '../utils/cookieUtils';
import { verifyToken } from '../utils/jwtUtils';
import { logger } from '../utils/logger';

export const SOCKET_PATH = '/api/socket.io';

export const SOCKET_EVENTS = {
  NOTIFICATION_NEW: 'notification:new',
  TICKET_NEW: 'ticket:new',
  TICKET_REPLY: 'ticket:reply',
  TICKET_RESOLVED: 'ticket:resolved',
  // Added QUEUE_UPDATED to immediately push live OP state changes to patients and admins
  QUEUE_UPDATED: 'queue:updated',
} as const;

type SocketUser = { id: string; role: UserRole };

let io: Server | null = null;

const readCookie = (header: string | undefined, name: string) => {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
};

const userRoom = (userId: string) => `user:${userId}`;
const roleRoom = (role: UserRole) => `role:${role}`;

export const getIo = () => io;

/**
 * Safely disconnects all active Socket.IO clients and closes the server.
 * Emits close frame to connected clients so mobile and web clients trigger their reconnection strategy cleanly.
 */
export const closeRealtime = async () => {
  if (!io) return;
  try {
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => {
      io?.close(() => resolve());
    });
  } finally {
    io = null;
  }
};

export const emitToUser = (userId: string, event: string, payload: unknown) => {
  if (!userId) return;
  io?.to(userRoom(userId)).emit(event, payload);
};

export const emitToRole = (role: UserRole, event: string, payload: unknown) => {
  io?.to(roleRoom(role)).emit(event, payload);
};

export const emitToSuperAdmins = (event: string, payload: unknown) =>
  emitToRole(UserRole.SUPER_ADMIN, event, payload);

const authenticate = (socket: Socket): SocketUser | null => {
  const authToken =
    typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
  const header = socket.handshake.headers.authorization;
  const bearer =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken =
    readCookie(socket.handshake.headers.cookie, AUTH_COOKIE.ACCESS) ||
    readCookie(socket.handshake.headers.cookie, SUPERADMIN_AUTH_COOKIE.ACCESS);
  const token = authToken || bearer || cookieToken;
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
};

export const attachRealtime = (httpServer: HttpServer, allowedOrigins: string[]) => {
  io = new Server(httpServer, {
    path: SOCKET_PATH,
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, origin);
        return callback(null, false);
      },
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const user = authenticate(socket);
    if (!user) {
      return next(new Error('Not authorized'));
    }
    socket.data.user = user;
    return next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as SocketUser;
    socket.join(userRoom(user.id));
    socket.join(roleRoom(user.role));
    logger.debug(`socket connected ${user.role} ${user.id}`);

    socket.on('disconnect', () => {
      logger.debug(`socket disconnected ${user.id}`);
    });
  });

  return io;
};
