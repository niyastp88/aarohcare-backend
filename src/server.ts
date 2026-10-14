import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/authRoutes';
import doctorRoutes from './routes/doctorRoutes';
import appointmentRoutes from './routes/appointmentRoutes';
import facilityRoutes from './routes/facilityRoutes';
import userRoutes from './routes/userRoutes';
import uploadRoutes from './routes/uploadRoutes';
import feedbackRoutes from './routes/feedbackRoutes';
import superAdminRoutes from './routes/superAdminRoutes';
import adRoutes from './routes/adRoutes';
import emergencyRoutes from './routes/emergencyRoutes';
import notificationRoutes from './routes/notificationRoutes';
import labReportRoutes from './routes/labReportRoutes';
import billingRoutes from './routes/billingRoutes';
import { isS3Configured } from './config/s3';
import { csrfProtection } from './middleware/csrfMiddleware';
import { errorHandler } from './middleware/errorMiddleware';
import { logger } from './utils/logger';
import { platformFeeService } from './services/platformFeeService';
import { attachRealtime } from './realtime/socket';

const app = express();
const PORT = process.env.PORT || 4000;

const rawOrigins = [
  process.env.CLIENT_ORIGINS,
  process.env.FRONTEND_URL,
  process.env.SUPER_ADMIN_FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'https://superadmin.aarohcare.com',
  'https://www.superadmin.aarohcare.com',
  'https://admin.aarohcare.com',
  'https://www.admin.aarohcare.com',
  'https://aarohacare-super-admin.vercel.app',
  'https://aaroh-care-web.vercel.app',
]

  .filter(Boolean)
  .join(',');

const allowedOrigins = rawOrigins
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      if (
        allowedOrigins.includes(origin) ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1')
      ) {
        return callback(null, origin);
      }
      return callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Client', 'x-csrf-token', 'x-client'],
    exposedHeaders: [],
    maxAge: 600,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(csrfProtection);

app.use('/api/auth', authRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/facilities', facilityRoutes);
app.use('/api/users', userRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/ads', adRoutes);
app.use('/api/emergency', emergencyRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/lab-reports', labReportRoutes);
app.use('/api/billing', billingRoutes);

app.get('/', (_req: Request, res: Response) => {
  res.send('Aarohcare Backend is running!');
});

/**
 * Lightweight, non-blocking health check endpoint.
 * Immediately reports in-memory process uptime, database connection state, and cached fee
 * without executing blocking database queries or risking Docker probe timeouts.
 */
app.get('/api/health', (_req: Request, res: Response) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  res.status(isDbConnected ? 200 : 503).json({
    status: isDbConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: isDbConnected ? 'connected' : 'disconnected',
    platformServiceFee: platformFeeService.getCached(),
  });
});

app.use(errorHandler);

const httpServer = http.createServer(app);
attachRealtime(httpServer, allowedOrigins);

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/aarohcare';
    await mongoose.connect(mongoURI);
    logger.info('MongoDB Connected Successfully');

    // Refresh indexes so phone uniqueness is per role (patient vs facility admin),
    // and facility phones stay unique among hospitals / clinics / labs.
    // Refresh indexes asynchronously in background so server startup and requests do not block
    Promise.all([
      import('./models/User').then((m) => m.default.syncIndexes()),
      import('./models/Facility').then((m) => m.default.syncIndexes()),
      import('./models/SuperAdmin').then((m) => m.default.syncIndexes()),
      import('./models/PlatformLock').then((m) => m.default.syncIndexes()),
    ]).catch((err) => logger.error('Index sync error:', err));

    const { facilityService } = await import('./services/facilityService');
    const backfilled = await facilityService.backfillLegacyApproval();
    if (backfilled > 0) {
      logger.info(`Backfilled approvalStatus on ${backfilled} facilities`);
    }

    const { appointmentService } = await import('./services/appointmentService');
    const backfilledFees = await appointmentService.backfillConsultationFeeSnapshots();
    if (backfilledFees > 0) {
      logger.info(`Backfilled consultationFeeAtBooking on ${backfilledFees} appointments`);
    }

    // If Super Admins already exist (created before lock), close public bootstrap.
    const { superAdminAccountService } = await import('./services/superAdminAccountService');
    const existingAdmins = await superAdminAccountService.count();
    if (existingAdmins > 0 && !(await superAdminAccountService.isBootstrapLocked())) {
      await superAdminAccountService.lockBootstrap();
      logger.info('Super Admin bootstrap locked (existing accounts found)');
    }
  } catch (error) {
    logger.error('MongoDB Connection Error:', error);
    process.exit(1);
  }
};

/**
 * Safe production startup sequence:
 * Connect to MongoDB Atlas FIRST and verify database health before binding HTTP port.
 * Guarantees incoming client traffic and health checks never arrive at a partially initialized backend.
 */
const startServer = async () => {
  try {
    await connectDB();

    httpServer.listen(Number(PORT), '0.0.0.0', async () => {
      // Start the background automated appointment completion scheduler
      const { startAppointmentScheduler } = await import('./services/appointmentScheduler');
      startAppointmentScheduler();

      logger.info(`Server is running on port ${PORT}`);
      logger.info('Realtime: Socket.IO at /api/socket.io');
      logger.info(`CORS origins: ${allowedOrigins.join(', ') || '(none)'}`);
      logger.info(
        isS3Configured()
          ? 'S3: configured (profile photo uploads enabled)'
          : 'S3: NOT configured — set AWS_REGION and S3_BUCKET_NAME in .env',
      );
    });
  } catch (error) {
    logger.error('Fatal startup error:', error);
    process.exit(1);
  }
};

/**
 * Graceful shutdown sequence for Docker SIGTERM and OS SIGINT:
 * 1. Stops HTTP server from accepting new incoming connections.
 * 2. Drains and cleanly disconnects active Socket.IO clients with close frames.
 * 3. Closes MongoDB Mongoose connection pool cleanly.
 * 4. Bounded by a 10-second timeout to prevent hung processes.
 */
let isShuttingDown = false;

const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`[Shutdown] Received ${signal}. Starting graceful shutdown...`);

  const shutdownTimer = setTimeout(() => {
    logger.error('[Shutdown] Forced shutdown: Cleanup exceeded 10-second timeout.');
    process.exit(1);
  }, 10000);
  shutdownTimer.unref();

  httpServer.close(async (httpErr) => {
    if (httpErr) {
      logger.error('[Shutdown] Error while closing HTTP server:', httpErr);
    } else {
      logger.info('[Shutdown] HTTP server closed to new connections.');
    }

    try {
      const { closeRealtime } = await import('./realtime/socket');
      await closeRealtime();
      logger.info('[Shutdown] Realtime Socket.IO connections closed cleanly.');
    } catch (socketErr) {
      logger.error('[Shutdown] Error closing Socket.IO:', socketErr);
    }

    try {
      await mongoose.connection.close(false);
      logger.info('[Shutdown] MongoDB connection closed cleanly.');
    } catch (dbErr) {
      logger.error('[Shutdown] Error closing MongoDB connection:', dbErr);
    }

    clearTimeout(shutdownTimer);
    logger.info('[Shutdown] Graceful shutdown completed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

void startServer();
