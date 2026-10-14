import {
  MSG,
  formatScheduleStartAfterNow,
} from '../constants/messages';

/** App business timezone for schedule / OP dates. */
export const APP_TIMEZONE = 'Asia/Kolkata';

const pad2 = (value: string | number) => String(value).padStart(2, '0');

/** Current calendar date + clock time in the app timezone. */
export const getNowInAppTz = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  const minute = get('minute');

  // Some engines can emit "24" for midnight with hourCycle h23.
  if (hour === '24') hour = '00';

  return {
    date: `${year}-${month}-${day}`,
    time: `${pad2(hour)}:${pad2(minute)}`,
  };
};

/** Normalize "09:00" / "09:00:00" → "HH:mm" for comparison. */
export const toHm = (value: string) => value.trim().slice(0, 5);

export const isValidYmd = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const isValidHm = (value: string) => /^\d{2}:\d{2}$/.test(toHm(value));

/**
 * Validate schedule date/time against "now" in Asia/Kolkata.
 * - No past dates
 * - If date is today, startTime must be strictly after current time
 */
export const validateScheduleAgainstNow = (
  date: string,
  startTime: string,
  now = new Date(),
): string | null => {
  if (!isValidYmd(date)) return MSG.SCHEDULE_DATE_INVALID;
  const start = toHm(startTime);
  if (!isValidHm(start)) return MSG.SCHEDULE_START_INVALID;

  const { date: today, time: nowTime } = getNowInAppTz(now);

  if (date < today) {
    return MSG.SCHEDULE_PAST_DATE;
  }

  if (date === today && start <= nowTime) {
    return formatScheduleStartAfterNow(nowTime);
  }

  return null;
};
