import { Router } from 'express';
import { listActiveAds, recordImpression, recordLinkClick } from '../controllers/adController';

const router = Router();

router.get('/', listActiveAds);
router.post('/:id/impression', recordImpression);
router.post('/:id/click', recordLinkClick);

export default router;
