import crypto from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  getS3Bucket,
  getS3PublicUrl,
  isS3Configured,
  s3,
} from '../config/s3';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';

const extensionFor = (mimeType: string) => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return 'heic';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/webm') return 'webm';
  if (mimeType === 'video/quicktime') return 'mov';
  return mimeType.startsWith('video/') ? 'mp4' : 'jpg';
};

const safeFolder = (value: unknown) => {
  if (typeof value !== 'string') return 'aarohcare/doctors';
  const normalized = value
    .split('/')
    .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(Boolean)
    .join('/');
  return normalized || 'aarohcare/doctors';
};

const keyFromPublicUrl = (rawUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const pathKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const host = parsed.hostname.toLowerCase();
  const bucket = (process.env.S3_BUCKET_NAME || '').trim();
  const publicBase = (process.env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

  let key = '';

  if (publicBase && rawUrl.startsWith(`${publicBase}/`)) {
    key = decodeURIComponent(rawUrl.slice(publicBase.length + 1).split('?')[0] ?? '');
  } else if (
    bucket &&
    (host === `${bucket}.s3.amazonaws.com` ||
      (host.startsWith(`${bucket}.s3.`) && host.endsWith('.amazonaws.com')))
  ) {
    // Virtual-hosted–style: https://bucket.s3.region.amazonaws.com/key
    key = pathKey;
  } else if (
    bucket &&
    host.startsWith('s3.') &&
    host.endsWith('.amazonaws.com') &&
    pathKey.startsWith(`${bucket}/`)
  ) {
    // Path-style: https://s3.region.amazonaws.com/bucket/key
    key = pathKey.slice(bucket.length + 1);
  } else if (
    host.includes('.s3.') &&
    host.endsWith('.amazonaws.com') &&
    pathKey.startsWith('aarohcare/')
  ) {
    // Fallback: trust aarohcare/* keys on any *.s3.*.amazonaws.com host
    key = pathKey;
  }

  if (!key || key.includes('..') || key.startsWith('/')) {
    return null;
  }

  // Lab reports live under aarohcare/lab-reports/ — must be allowed for download proxy.
  if (!/^aarohcare\/(doctors|facilities|profiles|ads|lab-reports)\//.test(key)) {
    return null;
  }

  return key;
};

export const uploadService = {
  uploadImage: async (
    userId: string,
    file: Express.Multer.File | undefined,
    folderRaw: unknown,
  ) => {
    if (!isS3Configured()) {
      throw AppError.unavailable(MSG.S3_NOT_CONFIGURED);
    }
    if (!file) {
      throw AppError.badRequest(MSG.IMAGE_FILE_REQUIRED);
    }

    const folder = safeFolder(folderRaw);
    const key = `${folder}/${userId}/${Date.now()}-${crypto.randomUUID()}.${extensionFor(
      file.mimetype,
    )}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return {
      url: getS3PublicUrl(key),
      publicId: key,
    };
  },

  uploadVideo: async (
    userId: string,
    file: Express.Multer.File | undefined,
    folderRaw: unknown,
  ) => {
    if (!isS3Configured()) {
      throw AppError.unavailable(MSG.S3_NOT_CONFIGURED);
    }
    if (!file) {
      throw AppError.badRequest(MSG.VIDEO_FILE_REQUIRED);
    }
    if (!file.mimetype.startsWith('video/')) {
      throw AppError.badRequest(MSG.VIDEO_UPLOAD_FAIL);
    }

    const folder = safeFolder(folderRaw);
    const key = `${folder}/${userId}/${Date.now()}-${crypto.randomUUID()}.${extensionFor(
      file.mimetype,
    )}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return {
      url: getS3PublicUrl(key),
      publicId: key,
    };
  },

  proxyImage: async (rawUrl: string) => {
    if (!isS3Configured()) {
      throw AppError.unavailable(MSG.S3_STORAGE_NOT_CONFIGURED);
    }
    if (!rawUrl) {
      throw AppError.badRequest(MSG.IMAGE_URL_REQUIRED);
    }

    const key = keyFromPublicUrl(rawUrl);
    if (!key) {
      throw AppError.badRequest(MSG.IMAGE_URL_INVALID);
    }

    try {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: getS3Bucket(),
          Key: key,
        }),
      );

      if (!result.Body) {
        throw AppError.notFound(MSG.IMAGE_NOT_FOUND);
      }

      const bytes = await result.Body.transformToByteArray();
      return {
        bytes: Buffer.from(bytes),
        contentType: result.ContentType || 'image/jpeg',
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const name =
        error && typeof error === 'object' && 'name' in error
          ? String((error as { name?: string }).name)
          : '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw AppError.notFound(MSG.IMAGE_NOT_FOUND);
      }
      throw AppError.internal(MSG.IMAGE_LOAD_FAIL);
    }
  },
};
