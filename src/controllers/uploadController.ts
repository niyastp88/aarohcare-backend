import type { AuthRequest } from '../middleware/authMiddleware';
import { uploadService } from '../services/uploadService';
import { asyncHandler } from '../utils/asyncHandler';
import { sendCreated } from '../utils/apiResponse';

/** Upload a doctor/facility/profile image to S3 and return its permanent URL. */
export const uploadImage = asyncHandler(async (req: AuthRequest, res) => {
  const result = await uploadService.uploadImage(
    req.user!.id,
    req.file,
    req.body.folder,
  );
  return sendCreated(res, result);
});

export const uploadVideo = asyncHandler(async (req: AuthRequest, res) => {
  const result = await uploadService.uploadVideo(
    req.user!.id,
    req.file,
    req.body.folder,
  );
  return sendCreated(res, result);
});

/**
 * Proxy an existing uploaded file through the API so the browser can preview/download
 * without S3 CORS issues (and without navigating to the raw S3 URL).
 */
export const proxyImage = asyncHandler(async (req: AuthRequest, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const asDownload =
    req.query.download === '1' ||
    req.query.download === 'true' ||
    String(req.query.download || '').toLowerCase() === 'yes';
  const fileNameRaw =
    typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
  const safeName =
    fileNameRaw.replace(/[^\w.\-()+ ]+/g, '_').replace(/\s+/g, '_').slice(0, 120) ||
    'aarohcare-file';

  const { bytes, contentType } = await uploadService.proxyImage(rawUrl);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Length', String(bytes.byteLength));
  if (asDownload) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    );
  }
  return res.status(200).send(bytes);
});
