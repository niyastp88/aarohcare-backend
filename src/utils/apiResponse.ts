import type { Response } from 'express';
import { HTTP, type HttpStatusCode } from '../constants/httpStatus';
import type { ApiErrorResponseDto, ApiMessageResponseDto } from '../dto';

export const sendOk = <T>(res: Response, data: T, status: HttpStatusCode = HTTP.OK) =>
  res.status(status).json(data);

export const sendCreated = <T>(res: Response, data: T) =>
  res.status(HTTP.CREATED).json(data);

export const sendMessage = (
  res: Response,
  message: string,
  status: HttpStatusCode = HTTP.OK,
) => {
  const body: ApiMessageResponseDto = { message };
  return res.status(status).json(body);
};

export const sendError = (
  res: Response,
  message: string,
  status: HttpStatusCode = HTTP.BAD_REQUEST,
) => {
  const body: ApiErrorResponseDto = { message };
  return res.status(status).json(body);
};
