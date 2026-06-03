import { randomInt } from 'node:crypto';

export type SchedulerConfig = {
  activeWeekdays: number[];
  maxSessionsPerDay: number;
  minGapMinutes: number;
  minSessionsPerDay: number;
  slotMinutes: number;
  timezone: string;
  weekendMaxSessionsPerDay: number;
  weekendMinSessionsPerDay: number;
  workdayEndHour: number;
  workdayStartHour: number;
};

export type ZonedTimeParts = {
  dateKey: string;
  hour: number;
  isoWeekday: number;
  minute: number;
};

export type DailySchedulePlan = {
  dateKey: string;
  executedSlotIndexes: number[];
  generatedAt: string;
  maxSessionsPerDay: number;
  minGapMinutes: number;
  minSessionsPerDay: number;
  plannedSlotIndexes: number[];
  slotMinutes: number;
  timezone: string;
  workdayEndHour: number;
  workdayStartHour: number;
};

export type SchedulerDecision = {
  currentSlotIndex: number | null;
  plan: DailySchedulePlan | null;
  reason: string;
  shouldRun: boolean;
};

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function getDefaultSchedulerConfig(): SchedulerConfig {
  return {
    activeWeekdays: [1, 2, 3, 4, 5],
    maxSessionsPerDay: 5,
    minGapMinutes: 60,
    minSessionsPerDay: 1,
    slotMinutes: 5,
    timezone: process.env.SESSION_SCHEDULER_TIMEZONE?.trim() || process.env.TZ?.trim() || 'America/New_York',
    weekendMaxSessionsPerDay: 5,
    weekendMinSessionsPerDay: 1,
    workdayEndHour: 18,
    workdayStartHour: 9,
  };
}

export function parseSchedulerConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  const defaults = getDefaultSchedulerConfig();

  return {
    activeWeekdays: parseWeekdayList(env.SESSION_SCHEDULER_WEEKDAYS, defaults.activeWeekdays),
    maxSessionsPerDay: parseNonNegativeInteger(env.SESSION_SCHEDULER_MAX_PER_DAY, defaults.maxSessionsPerDay, 'SESSION_SCHEDULER_MAX_PER_DAY'),
    minGapMinutes: parseNonNegativeInteger(env.SESSION_SCHEDULER_MIN_GAP_MINUTES, defaults.minGapMinutes, 'SESSION_SCHEDULER_MIN_GAP_MINUTES'),
    minSessionsPerDay: parseNonNegativeInteger(env.SESSION_SCHEDULER_MIN_PER_DAY, defaults.minSessionsPerDay, 'SESSION_SCHEDULER_MIN_PER_DAY'),
    slotMinutes: parsePositiveInteger(env.SESSION_SCHEDULER_SLOT_MINUTES, defaults.slotMinutes, 'SESSION_SCHEDULER_SLOT_MINUTES'),
    timezone: env.SESSION_SCHEDULER_TIMEZONE?.trim() || defaults.timezone,
    weekendMaxSessionsPerDay: parseNonNegativeInteger(
      env.SESSION_SCHEDULER_WEEKEND_MAX_PER_DAY,
      defaults.weekendMaxSessionsPerDay,
      'SESSION_SCHEDULER_WEEKEND_MAX_PER_DAY',
    ),
    weekendMinSessionsPerDay: parseNonNegativeInteger(
      env.SESSION_SCHEDULER_WEEKEND_MIN_PER_DAY,
      defaults.weekendMinSessionsPerDay,
      'SESSION_SCHEDULER_WEEKEND_MIN_PER_DAY',
    ),
    workdayEndHour: parseHour(env.SESSION_SCHEDULER_END_HOUR, defaults.workdayEndHour, 'SESSION_SCHEDULER_END_HOUR'),
    workdayStartHour: parseHour(env.SESSION_SCHEDULER_START_HOUR, defaults.workdayStartHour, 'SESSION_SCHEDULER_START_HOUR'),
  };
}

export function buildDailySchedulePlan(
  config: SchedulerConfig,
  dateKey: string,
  nowIso: string,
  isoWeekday: number,
  rng: () => number = Math.random,
): DailySchedulePlan {
  const totalSlots = countDailySlots(config);
  const bounds = resolveDailySessionBounds(config, isoWeekday);
  const minSessions = Math.min(bounds.minSessionsPerDay, totalSlots);
  const maxSessions = Math.min(bounds.maxSessionsPerDay, totalSlots);

  if (minSessions > maxSessions) {
    throw new Error('Daily session minimum cannot be greater than the daily session maximum.');
  }

  const plannedCount = randomBetween(minSessions, maxSessions, rng);
  const gapSlots = Math.max(0, Math.floor(config.minGapMinutes / config.slotMinutes));

  return {
    dateKey,
    executedSlotIndexes: [],
    generatedAt: nowIso,
    maxSessionsPerDay: bounds.maxSessionsPerDay,
    minGapMinutes: config.minGapMinutes,
    minSessionsPerDay: bounds.minSessionsPerDay,
    plannedSlotIndexes: pickRandomSlots(totalSlots, plannedCount, gapSlots, rng),
    slotMinutes: config.slotMinutes,
    timezone: config.timezone,
    workdayEndHour: config.workdayEndHour,
    workdayStartHour: config.workdayStartHour,
  };
}

export function evaluateSchedulerTick(
  config: SchedulerConfig,
  now: Date,
  plan: DailySchedulePlan | null,
  rng: () => number = Math.random,
): SchedulerDecision {
  validateSchedulerConfig(config);

  const parts = getZonedTimeParts(now, config.timezone);
  const weekdayActive = config.activeWeekdays.includes(parts.isoWeekday);

  if (!weekdayActive) {
    return {
      currentSlotIndex: null,
      plan: null,
      reason: `inactive weekday ${parts.isoWeekday}`,
      shouldRun: false,
    };
  }

  const nextPlan = isPlanReusable(plan, config, parts.dateKey)
    ? plan
    : buildDailySchedulePlan(config, parts.dateKey, now.toISOString(), parts.isoWeekday, rng);
  const currentSlotIndex = getCurrentSlotIndex(config, parts);

  if (currentSlotIndex === null) {
    return {
      currentSlotIndex: null,
      plan: nextPlan,
      reason: 'outside working hours',
      shouldRun: false,
    };
  }

  if (nextPlan.executedSlotIndexes.includes(currentSlotIndex)) {
    return {
      currentSlotIndex,
      plan: nextPlan,
      reason: 'slot already executed',
      shouldRun: false,
    };
  }

  if (!nextPlan.plannedSlotIndexes.includes(currentSlotIndex)) {
    return {
      currentSlotIndex,
      plan: nextPlan,
      reason: 'no session planned for this slot',
      shouldRun: false,
    };
  }

  return {
    currentSlotIndex,
    plan: nextPlan,
    reason: 'planned slot matched',
    shouldRun: true,
  };
}

export function markSlotExecuted(plan: DailySchedulePlan, slotIndex: number): DailySchedulePlan {
  if (plan.executedSlotIndexes.includes(slotIndex)) return plan;

  return {
    ...plan,
    executedSlotIndexes: [...plan.executedSlotIndexes, slotIndex].sort((left, right) => left - right),
  };
}

export function formatPlannedTimes(plan: DailySchedulePlan): string[] {
  return plan.plannedSlotIndexes.map((slotIndex) => formatSlotTime(plan, slotIndex));
}

export function getZonedTimeParts(date: Date, timezone: string): ZonedTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
  });
  const parts = formatter.formatToParts(date);

  const year = getNumericPart(parts, 'year');
  const month = getNumericPart(parts, 'month');
  const day = getNumericPart(parts, 'day');
  const hour = getNumericPart(parts, 'hour');
  const minute = getNumericPart(parts, 'minute');
  const weekdayToken = parts.find((part) => part.type === 'weekday')?.value;

  if (!weekdayToken || !(weekdayToken in WEEKDAY_MAP)) {
    throw new Error(`Could not resolve weekday for timezone "${timezone}".`);
  }

  return {
    dateKey: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
    hour,
    isoWeekday: WEEKDAY_MAP[weekdayToken],
    minute,
  };
}

export function getCurrentSlotIndex(config: SchedulerConfig, parts: Pick<ZonedTimeParts, 'hour' | 'minute'>): number | null {
  const minutesSinceStart = (parts.hour - config.workdayStartHour) * 60 + parts.minute;

  if (minutesSinceStart < 0) return null;

  const totalMinutes = (config.workdayEndHour - config.workdayStartHour) * 60;
  if (minutesSinceStart >= totalMinutes) return null;

  return Math.floor(minutesSinceStart / config.slotMinutes);
}

export function countDailySlots(config: SchedulerConfig): number {
  return Math.max(0, Math.floor(((config.workdayEndHour - config.workdayStartHour) * 60) / config.slotMinutes));
}

function resolveDailySessionBounds(
  config: SchedulerConfig,
  isoWeekday: number,
): Pick<DailySchedulePlan, 'maxSessionsPerDay' | 'minSessionsPerDay'> {
  if (isWeekend(isoWeekday)) {
    return {
      maxSessionsPerDay: config.weekendMaxSessionsPerDay,
      minSessionsPerDay: config.weekendMinSessionsPerDay,
    };
  }

  return {
    maxSessionsPerDay: config.maxSessionsPerDay,
    minSessionsPerDay: config.minSessionsPerDay,
  };
}

function isPlanReusable(plan: DailySchedulePlan | null, config: SchedulerConfig, dateKey: string): plan is DailySchedulePlan {
  if (!plan) return false;

  const isoWeekday = getIsoWeekdayFromDateKey(plan.dateKey, config.timezone);
  const bounds = resolveDailySessionBounds(config, isoWeekday);

  return plan.dateKey === dateKey &&
    plan.timezone === config.timezone &&
    plan.slotMinutes === config.slotMinutes &&
    plan.workdayStartHour === config.workdayStartHour &&
    plan.workdayEndHour === config.workdayEndHour &&
    plan.minSessionsPerDay === bounds.minSessionsPerDay &&
    plan.maxSessionsPerDay === bounds.maxSessionsPerDay &&
    plan.minGapMinutes === config.minGapMinutes;
}

function formatSlotTime(plan: Pick<DailySchedulePlan, 'slotMinutes' | 'workdayStartHour'>, slotIndex: number): string {
  const totalMinutes = plan.workdayStartHour * 60 + slotIndex * plan.slotMinutes;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function validateSchedulerConfig(config: SchedulerConfig): void {
  if (config.workdayEndHour <= config.workdayStartHour) {
    throw new Error('SESSION_SCHEDULER_END_HOUR must be greater than SESSION_SCHEDULER_START_HOUR.');
  }

  if (config.minSessionsPerDay > config.maxSessionsPerDay) {
    throw new Error('SESSION_SCHEDULER_MIN_PER_DAY cannot be greater than SESSION_SCHEDULER_MAX_PER_DAY.');
  }

  if (config.weekendMinSessionsPerDay > config.weekendMaxSessionsPerDay) {
    throw new Error('SESSION_SCHEDULER_WEEKEND_MIN_PER_DAY cannot be greater than SESSION_SCHEDULER_WEEKEND_MAX_PER_DAY.');
  }

  if (config.activeWeekdays.length === 0) {
    throw new Error('SESSION_SCHEDULER_WEEKDAYS must include at least one weekday.');
  }
}

function getIsoWeekdayFromDateKey(dateKey: string, timezone: string): number {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return getZonedTimeParts(date, timezone).isoWeekday;
}

function isWeekend(isoWeekday: number): boolean {
  return isoWeekday === 6 || isoWeekday === 7;
}

function pickRandomSlots(totalSlots: number, count: number, minGapSlots: number, rng: () => number): number[] {
  if (count <= 0) return [];
  if (count >= totalSlots) return [...Array.from({ length: totalSlots }, (_, index) => index)];

  for (let gap = minGapSlots; gap >= 0; gap--) {
    const selected = tryPickRandomSlots(totalSlots, count, gap, rng);
    if (selected.length === count) return selected;
  }

  throw new Error(`Could not allocate ${count} daily session slots across ${totalSlots} available slots.`);
}

function tryPickRandomSlots(totalSlots: number, count: number, minGapSlots: number, rng: () => number): number[] {
  const shuffled = Array.from({ length: totalSlots }, (_, index) => index);
  shuffleInPlace(shuffled, rng);

  const selected: number[] = [];

  for (const candidate of shuffled) {
    if (selected.every((slot) => Math.abs(slot - candidate) >= minGapSlots)) {
      selected.push(candidate);
      if (selected.length === count) {
        return selected.sort((left, right) => left - right);
      }
    }
  }

  return [];
}

function shuffleInPlace(values: number[], rng: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const target = Math.floor(rng() * (index + 1));
    [values[index], values[target]] = [values[target], values[index]];
  }
}

function getNumericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypesRegistry[keyof Intl.DateTimeFormatPartTypesRegistry] | string): number {
  const value = parts.find((part) => part.type === type)?.value;
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Missing date part "${type}".`);
  }

  return parsed;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw?.trim()) return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${envName} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw?.trim()) return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative integer.`);
  }

  return parsed;
}

function parseHour(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw?.trim()) return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) {
    throw new Error(`${envName} must be an integer between 0 and 23.`);
  }

  return parsed;
}

function parseWeekdayList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw?.trim()) return fallback;

  const weekdays = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 7);

  return [...new Set(weekdays)].sort((left, right) => left - right);
}

function randomBetween(min: number, max: number, rng: () => number): number {
  if (min === max) return min;

  if (rng === Math.random) {
    return randomInt(min, max + 1);
  }

  return min + Math.floor(rng() * (max - min + 1));
}
