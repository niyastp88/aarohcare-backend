import { Router } from 'express';
import {
  register,
  login,
  refresh,
  me,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  csrf,
} from '../controllers/authController';
import { protect } from '../middleware/authMiddleware';

const router = Router();

router.get('/csrf', csrf);
router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/change-password', protect, changePassword);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', protect, me);

export default router;
