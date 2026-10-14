import { HTTP, type HttpStatusCode } from '../constants/httpStatus';
import { MSG } from '../constants/messages';

export class AppError extends Error {
  readonly statusCode: HttpStatusCode;
  readonly code?: string;
  readonly isOperational: boolean;

  constructor(message: string, statusCode: HttpStatusCode = HTTP.BAD_REQUEST, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }

  static badRequest(message: string, code?: string) {
    return new AppError(message, HTTP.BAD_REQUEST, code);
  }

  static unauthorized(message: string = MSG.NOT_AUTHORIZED, code?: string) {
    return new AppError(message, HTTP.UNAUTHORIZED, code);
  }

  static forbidden(message: string = MSG.NOT_ALLOWED, code?: string) {
    return new AppError(message, HTTP.FORBIDDEN, code);
  }

  static notFound(message: string, code?: string) {
    return new AppError(message, HTTP.NOT_FOUND, code);
  }

  static conflict(message: string, code?: string) {
    return new AppError(message, HTTP.CONFLICT, code);
  }

  static unavailable(message: string, code?: string) {
    return new AppError(message, HTTP.SERVICE_UNAVAILABLE, code);
  }

  static internal(message: string = MSG.INTERNAL, code?: string) {
    return new AppError(message, HTTP.INTERNAL, code);
  }
}

export const isAppError = (error: unknown): error is AppError =>
  error instanceof AppError;
