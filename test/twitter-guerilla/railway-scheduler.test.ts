import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDailySchedulePlan,
  evaluateSchedulerTick,
  markSlotExecuted,
  type DailySchedulePlan,
  type SchedulerConfig,
} from '../../twitter-guerilla/lib/railway-scheduler.ts';

const CONFIG: SchedulerConfig = {
  activeWeekdays: [1, 2, 3, 4, 5],
  maxSessionsPerDay: 3,
  minGapMinutes: 60,
  minSessionsPerDay: 3,
  slotMinutes: 5,
  timezone: 'UTC',
  weekendMaxSessionsPerDay: 1,
  weekendMinSessionsPerDay: 0,
  workdayEndHour: 18,
  workdayStartHour: 9,
};

function buildPlan(overrides: Partial<DailySchedulePlan> = {}): DailySchedulePlan {
  return {
    dateKey: '2026-05-11',
    executedSlotIndexes: [],
    generatedAt: '2026-05-11T08:00:00.000Z',
    maxSessionsPerDay: CONFIG.maxSessionsPerDay,
    minGapMinutes: CONFIG.minGapMinutes,
    minSessionsPerDay: CONFIG.minSessionsPerDay,
    plannedSlotIndexes: [6, 30, 72],
    slotMinutes: CONFIG.slotMinutes,
    timezone: CONFIG.timezone,
    workdayEndHour: CONFIG.workdayEndHour,
    workdayStartHour: CONFIG.workdayStartHour,
    ...overrides,
  };
}

test('buildDailySchedulePlan creates sorted slots inside the workday with spacing', () => {
  const plan = buildDailySchedulePlan(CONFIG, '2026-05-11', '2026-05-11T08:00:00.000Z', 1, makeRng([
    0.15, 0.85, 0.35, 0.65, 0.25, 0.75, 0.45, 0.55, 0.05, 0.95,
  ]));

  assert.equal(plan.plannedSlotIndexes.length, 3);
  assert.deepEqual([...plan.plannedSlotIndexes].sort((left, right) => left - right), plan.plannedSlotIndexes);

  for (const slot of plan.plannedSlotIndexes) {
    assert.ok(slot >= 0);
    assert.ok(slot < ((CONFIG.workdayEndHour - CONFIG.workdayStartHour) * 60) / CONFIG.slotMinutes);
  }

  for (let index = 1; index < plan.plannedSlotIndexes.length; index++) {
    const gapMinutes = (plan.plannedSlotIndexes[index] - plan.plannedSlotIndexes[index - 1]) * CONFIG.slotMinutes;
    assert.ok(gapMinutes >= CONFIG.minGapMinutes);
  }
});

test('evaluateSchedulerTick generates a new daily plan and skips outside work hours', () => {
  const decision = evaluateSchedulerTick(CONFIG, new Date('2026-05-11T08:10:00.000Z'), null, makeRng([0.1, 0.2, 0.3, 0.4]));

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'outside working hours');
  assert.equal(decision.currentSlotIndex, null);
  assert.equal(decision.plan?.dateKey, '2026-05-11');
});

test('weekends can generate zero planned sessions while remaining active', () => {
  const weekendConfig: SchedulerConfig = {
    ...CONFIG,
    activeWeekdays: [1, 2, 3, 4, 5, 6, 7],
    weekendMaxSessionsPerDay: 0,
    weekendMinSessionsPerDay: 0,
  };

  const decision = evaluateSchedulerTick(
    weekendConfig,
    new Date('2026-05-10T10:00:00.000Z'),
    null,
    makeRng([0.5]),
  );

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.reason, 'no session planned for this slot');
  assert.deepEqual(decision.plan?.plannedSlotIndexes, []);
});

test('evaluateSchedulerTick runs only when the current slot is planned and not already executed', () => {
  const plan = buildPlan();

  const runDecision = evaluateSchedulerTick(CONFIG, new Date('2026-05-11T09:30:00.000Z'), plan);
  assert.equal(runDecision.shouldRun, true);
  assert.equal(runDecision.currentSlotIndex, 6);
  assert.equal(runDecision.reason, 'planned slot matched');

  const idleDecision = evaluateSchedulerTick(CONFIG, new Date('2026-05-11T09:35:00.000Z'), plan);
  assert.equal(idleDecision.shouldRun, false);
  assert.equal(idleDecision.reason, 'no session planned for this slot');

  const executedDecision = evaluateSchedulerTick(
    CONFIG,
    new Date('2026-05-11T09:30:00.000Z'),
    buildPlan({ executedSlotIndexes: [6] }),
  );
  assert.equal(executedDecision.shouldRun, false);
  assert.equal(executedDecision.reason, 'slot already executed');
});

test('markSlotExecuted adds the slot once and keeps the list sorted', () => {
  const once = markSlotExecuted(buildPlan({ executedSlotIndexes: [30] }), 6);
  assert.deepEqual(once.executedSlotIndexes, [6, 30]);

  const twice = markSlotExecuted(once, 6);
  assert.deepEqual(twice.executedSlotIndexes, [6, 30]);
});

function makeRng(values: number[]): () => number {
  let index = 0;

  return () => {
    const value = values[index % values.length];
    index++;
    return value;
  };
}
