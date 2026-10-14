import { Router } from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireApprovedFacility } from '../middleware/facilityAccessMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { imageUpload, videoUpload } from '../middleware/uploadMiddleware';
import { UserRole } from '../constants/enums';
import { proxyImage, uploadImage, uploadVideo } from '../controllers/uploadController';

const router = Router();

/** Admin / Super Admin uploads (doctors / facilities / ads). */
router.post(
  '/',
  protect,
  requireRole(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  requireApprovedFacility,
  (req, res, next) => {
    imageUpload.single('image')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Invalid image upload' });
      }
      return next();
    });
  },
  uploadImage,
);

router.post(
  '/video',
  protect,
  requireRole(UserRole.SUPER_ADMIN),
  (req, res, next) => {
    videoUpload.single('video')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Invalid video upload' });
      }
      return next();
    });
  },
  uploadVideo,
);

/** Patient/admin profile photo → S3. */
router.post(
  '/profile',
  protect,
  requireRole(UserRole.PATIENT, UserRole.ADMIN),
  (req, res, next) => {
    imageUpload.single('image')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Invalid image upload' });
      }
      if (!req.body) {
        (req as { body: Record<string, string> }).body = {};
      }
      if (!req.body.folder) {
        req.body.folder = 'aarohcare/profiles';
      }
      return next();
    });
  },
  uploadImage,
);

/** Load an existing uploaded image for crop/edit / force-download (avoids S3 CORS). */
router.get(
  '/proxy',
  protect,
  requireRole(UserRole.PATIENT, UserRole.ADMIN, UserRole.SUPER_ADMIN),
  requireApprovedFacility,
  proxyImage,
);

export default router;
