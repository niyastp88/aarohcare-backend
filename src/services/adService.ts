import Ad from '../models/Ad';
import {
  AdAspectRatio,
  AdMediaType,
  AdPlacement,
  AdStatus,
  AdType,
} from '../constants/enums';
import { MSG } from '../constants/messages';
import { AppError } from '../utils/AppError';

const MS_DAY = 24 * 60 * 60 * 1000;

const parseDisplaySeconds = (value: unknown, fallback = 8) => {
  if (value == null || value === '') return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 120) {
    throw AppError.badRequest(MSG.AD_DISPLAY_SECONDS_INVALID);
  }
  return Math.round(seconds);
};

const parseEnum = <T extends string>(value: unknown, allowed: T[], fallback: T) => {
  if (typeof value !== 'string') return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
};

const applyAdFields = (
  ad: InstanceType<typeof Ad>,
  body: {
    name?: string;
    shareDetails?: string;
    redirectUrl?: string;
    imageUrl?: string;
    videoUrl?: string;
    mediaType?: AdMediaType;
    adType?: AdType;
    placement?: AdPlacement;
    objectPosition?: string;
    aspectRatio?: string;
    displaySeconds?: number;
    autoRestart?: boolean;
    status?: AdStatus;
    sortOrder?: number;
  },
) => {
  if (body.name !== undefined) ad.name = String(body.name).trim();
  if (body.shareDetails !== undefined) ad.shareDetails = String(body.shareDetails);
  if (body.redirectUrl !== undefined) {
    const redirectUrl = parseRedirectUrl(body.redirectUrl);
    ad.redirectUrl = redirectUrl || undefined;
  }
  if (body.imageUrl !== undefined) ad.imageUrl = String(body.imageUrl);
  if (body.videoUrl !== undefined) ad.videoUrl = String(body.videoUrl) || undefined;
  if (body.mediaType !== undefined) {
    ad.mediaType = parseEnum(body.mediaType, Object.values(AdMediaType), AdMediaType.IMAGE);
  }
  if (body.adType !== undefined) {
    ad.adType = parseEnum(body.adType, Object.values(AdType), AdType.SPONSORED);
  }
  if (body.placement !== undefined) {
    ad.placement = parseEnum(body.placement, Object.values(AdPlacement), AdPlacement.HOME);
  }
  if (body.objectPosition !== undefined) ad.objectPosition = String(body.objectPosition);
  if (body.aspectRatio !== undefined) {
    ad.aspectRatio = parseEnum(
      body.aspectRatio,
      Object.values(AdAspectRatio),
      AdAspectRatio.RATIO_4_3,
    );
  }
  if (body.displaySeconds !== undefined) {
    ad.displaySeconds = parseDisplaySeconds(body.displaySeconds, ad.displaySeconds);
  }
  if (body.autoRestart !== undefined) ad.autoRestart = Boolean(body.autoRestart);
  if (body.status !== undefined) ad.status = body.status;
  if (body.sortOrder !== undefined) ad.sortOrder = Number(body.sortOrder);
};

const parseRedirectUrl = (value?: unknown): string | undefined => {
  if (value == null) return undefined;
  const url = String(value).trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('bad protocol');
    }
    return parsed.toString();
  } catch {
    throw AppError.badRequest(MSG.AD_REDIRECT_INVALID);
  }
};

const resolveWindow = (input: {
  startsAt?: string | Date;
  endsAt?: string | Date;
  durationDays?: unknown;
  fallbackStart?: Date;
  fallbackDays?: number;
}) => {
  const start = input.startsAt
    ? new Date(input.startsAt)
    : input.fallbackStart
      ? new Date(input.fallbackStart)
      : new Date();
  if (Number.isNaN(start.getTime())) {
    throw AppError.badRequest(MSG.AD_DATES_INVALID);
  }

  if (input.endsAt) {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= start.getTime()) {
      throw AppError.badRequest(MSG.AD_DATES_INVALID);
    }
    const durationDays = Math.max(1, Math.ceil((endsAt.getTime() - start.getTime()) / MS_DAY));
    return { startsAt: start, endsAt, durationDays };
  }

  const durationDays = Number(input.durationDays ?? input.fallbackDays);
  if (!Number.isFinite(durationDays) || durationDays < 1) {
    throw AppError.badRequest(MSG.AD_NAME_DATES_REQUIRED);
  }
  return {
    startsAt: start,
    endsAt: new Date(start.getTime() + durationDays * MS_DAY),
    durationDays,
  };
};

const expireOverdue = async () => {
  const now = new Date();
  const autoRestartAds = await Ad.find({
    status: AdStatus.ACTIVE,
    endsAt: { $lt: now },
    autoRestart: true,
  });
  await Promise.all(
    autoRestartAds.map(async (ad) => {
      ad.startsAt = now;
      ad.endsAt = new Date(now.getTime() + ad.durationDays * MS_DAY);
      ad.status = AdStatus.ACTIVE;
      await ad.save();
    }),
  );
  await Ad.updateMany(
    { status: AdStatus.ACTIVE, endsAt: { $lt: now } },
    { $set: { status: AdStatus.EXPIRED } },
  );
};

export const adService = {
  list: async () => {
    await expireOverdue();
    return Ad.find().sort({ sortOrder: 1, createdAt: -1 });
  },

  listActiveForApp: async (placement = AdPlacement.HOME) => {
    await expireOverdue();
    const now = new Date();
    return Ad.find({
      status: AdStatus.ACTIVE,
      placement,
      startsAt: { $lte: now },
      endsAt: { $gte: now },
    })
      .select(
        'name shareDetails redirectUrl imageUrl videoUrl mediaType adType placement objectPosition aspectRatio displaySeconds sortOrder',
      )
      .sort({ sortOrder: 1, createdAt: -1 });
  },

  getById: async (id: string) => {
    await expireOverdue();
    return Ad.findById(id);
  },

  requireById: async (id: string) => {
    const ad = await adService.getById(id);
    if (!ad) throw AppError.notFound(MSG.AD_NOT_FOUND);
    return ad;
  },

  create: async (data: {
    name: string;
    shareDetails?: string;
    redirectUrl?: string;
    imageUrl?: string;
    videoUrl?: string;
    mediaType?: AdMediaType;
    adType?: AdType;
    placement?: AdPlacement;
    objectPosition?: string;
    aspectRatio?: string;
    displaySeconds?: number;
    autoRestart?: boolean;
    durationDays?: number;
    startsAt?: string | Date;
    endsAt?: string | Date;
    status?: AdStatus;
  }) => {
    const window = resolveWindow({
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      durationDays: data.durationDays,
    });
    const maxOrder = await Ad.findOne().sort({ sortOrder: -1 }).select('sortOrder');
    const redirectUrl = parseRedirectUrl(data.redirectUrl);

    return Ad.create({
      name: String(data.name).trim(),
      shareDetails: data.shareDetails,
      redirectUrl: redirectUrl || undefined,
      imageUrl: data.imageUrl,
      videoUrl: data.videoUrl,
      mediaType: parseEnum(data.mediaType, Object.values(AdMediaType), AdMediaType.IMAGE),
      adType: parseEnum(data.adType, Object.values(AdType), AdType.SPONSORED),
      placement: parseEnum(data.placement, Object.values(AdPlacement), AdPlacement.HOME),
      objectPosition: data.objectPosition || '50% 50%',
      aspectRatio: parseEnum(
        data.aspectRatio,
        Object.values(AdAspectRatio),
        AdAspectRatio.RATIO_4_3,
      ),
      displaySeconds: parseDisplaySeconds(data.displaySeconds),
      autoRestart: Boolean(data.autoRestart),
      durationDays: window.durationDays,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      status: data.status === AdStatus.BLANK ? AdStatus.BLANK : AdStatus.ACTIVE,
      sortOrder: (maxOrder?.sortOrder ?? 0) + 1,
    });
  },

  createForSuperAdmin: async (body: Record<string, unknown>) => {
    if (!body.name || !(body.durationDays || body.endsAt)) {
      throw AppError.badRequest(MSG.AD_NAME_DATES_REQUIRED);
    }
    return adService.create({
      name: String(body.name),
      shareDetails: body.shareDetails as string | undefined,
      redirectUrl: body.redirectUrl as string | undefined,
      imageUrl: body.imageUrl as string | undefined,
      videoUrl: body.videoUrl as string | undefined,
      mediaType: body.mediaType as AdMediaType | undefined,
      adType: body.adType as AdType | undefined,
      placement: body.placement as AdPlacement | undefined,
      objectPosition: body.objectPosition as string | undefined,
      aspectRatio: body.aspectRatio as string | undefined,
      displaySeconds:
        body.displaySeconds != null ? Number(body.displaySeconds) : undefined,
      autoRestart: Boolean(body.autoRestart),
      durationDays: body.durationDays != null ? Number(body.durationDays) : undefined,
      startsAt: body.startsAt as string | Date | undefined,
      endsAt: body.endsAt as string | Date | undefined,
      status: body.status as AdStatus | undefined,
    });
  },

  update: async (
    id: string,
    body: {
      name?: string;
      shareDetails?: string;
      redirectUrl?: string;
      imageUrl?: string;
      videoUrl?: string;
      mediaType?: AdMediaType;
      adType?: AdType;
      placement?: AdPlacement;
      objectPosition?: string;
      displaySeconds?: number;
      autoRestart?: boolean;
      durationDays?: number;
      startsAt?: string | Date;
      endsAt?: string | Date;
      status?: AdStatus;
      sortOrder?: number;
      restart?: boolean;
    },
  ) => {
    const ad = await Ad.findById(id);
    if (!ad) return null;

    applyAdFields(ad, body);

    const shouldRestart = Boolean(body.restart);
    const touchingDates =
      shouldRestart ||
      body.durationDays !== undefined ||
      body.startsAt !== undefined ||
      body.endsAt !== undefined;

    if (touchingDates) {
      const window = resolveWindow({
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        durationDays: body.durationDays,
        fallbackStart: shouldRestart ? new Date() : ad.startsAt,
        fallbackDays: ad.durationDays,
      });
      ad.startsAt = window.startsAt;
      ad.endsAt = window.endsAt;
      ad.durationDays = window.durationDays;
      if (shouldRestart) {
        ad.status = body.status === AdStatus.BLANK ? AdStatus.BLANK : AdStatus.ACTIVE;
      }
    }

    if (ad.endsAt.getTime() < Date.now() && ad.status === AdStatus.ACTIVE) {
      ad.status = AdStatus.EXPIRED;
    } else if (ad.endsAt.getTime() >= Date.now() && ad.status === AdStatus.EXPIRED) {
      ad.status = AdStatus.ACTIVE;
    }

    await ad.save();
    return ad;
  },

  updateForSuperAdmin: async (id: string, body: Record<string, unknown>) => {
    const ad = await adService.update(id, body as Parameters<typeof adService.update>[1]);
    if (!ad) throw AppError.notFound(MSG.AD_NOT_FOUND);
    return ad;
  },

  deleteById: async (id: string) => Ad.findByIdAndDelete(id),

  deleteForSuperAdmin: async (id: string) => {
    const ad = await adService.deleteById(id);
    if (!ad) throw AppError.notFound(MSG.AD_NOT_FOUND);
    return MSG.AD_DELETED;
  },

  reorder: async (order: Array<{ id: string; sortOrder: number }>) => {
    await Promise.all(
      order.map((item) => Ad.findByIdAndUpdate(item.id, { sortOrder: item.sortOrder })),
    );
    return Ad.find().sort({ sortOrder: 1 });
  },

  reorderForSuperAdmin: async (order: unknown) => {
    if (!Array.isArray(order)) {
      throw AppError.badRequest(MSG.ORDER_REQUIRED);
    }
    return adService.reorder(order as Array<{ id: string; sortOrder: number }>);
  },

  recordImpression: async (id: string, viewTimeMs: number) => {
    if (!id || viewTimeMs < 1000 || viewTimeMs > 300000) return;
    await Ad.findByIdAndUpdate(id, {
      $inc: { viewCount: 1, totalViewTimeMs: viewTimeMs },
    });
  },

  recordLinkClick: async (id: string) => {
    if (!id) return;
    await Ad.findByIdAndUpdate(id, { $inc: { linkClickCount: 1 } });
  },

  countActive: async () => {
    await expireOverdue();
    return Ad.countDocuments({ status: AdStatus.ACTIVE });
  },
};
