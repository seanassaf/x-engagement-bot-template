import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadEnvFiles } from './lib/config.ts';
import type { DailySchedulePlan } from './lib/railway-scheduler.ts';
import {
  evaluateSchedulerTick,
  formatPlannedTimes,
  getDefaultSchedulerConfig,
  markSlotExecuted,
  parseSchedulerConfig,
} from './lib/railway-scheduler.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SESSION_ARGS = ['session', 'myaccount', '--buyer-intent-random'];

loadEnvFiles();

async function main(): Promise<void> {
  const forceRun = process.argv.includes('--force-run') || isTruthy(process.env.SESSION_SCHEDULER_FORCE_RUN);
  const dryRun = process.argv.includes('--dry-run') || isTruthy(process.env.SESSION_SCHEDULER_DRY_RUN);
  const sessionArgs = parseSessionArgs(process.env.SESSION_SCHEDULER_SESSION_ARGS);

  if (forceRun) {
    console.log(`Force-running session now: ${sessionArgs.join(' ')}`);
    process.exitCode = await runSession(sessionArgs, dryRun ? ['--dry-run'] : []);
    return;
  }

  const config = parseSchedulerConfig(process.env);
  const statePath = resolveSchedulerStatePath();
  const stateDir = dirname(statePath);
  mkdirSync(stateDir, { recursive: true });

  const previousPlan = loadPlan(statePath);
  const now = new Date();
  const decision = evaluateSchedulerTick(config, now, previousPlan);

  if (decision.plan && decision.plan !== previousPlan) {
    savePlan(statePath, decision.plan);
    console.log(
      `Generated schedule for ${decision.plan.dateKey} (${config.timezone}): ${formatPlannedTimes(decision.plan).join(', ') || 'no sessions'}`,
    );
  }

  if (!decision.shouldRun || !decision.plan || decision.currentSlotIndex === null) {
    console.log(`Scheduler idle: ${decision.reason}.`);
    return;
  }

  const updatedPlan = markSlotExecuted(decision.plan, decision.currentSlotIndex);
  savePlan(statePath, updatedPlan);

  console.log(`Scheduler launching session at slot ${decision.currentSlotIndex}: ${sessionArgs.join(' ')}`);
  process.exitCode = await runSession(sessionArgs, dryRun ? ['--dry-run'] : []);
}

function resolveSchedulerStatePath(): string {
  const explicit = process.env.SESSION_SCHEDULER_STATE_PATH?.trim();
  if (explicit) return resolve(explicit);

  const runtimeRoot = process.env.RUNTIME_DATA_ROOT?.trim() || process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || ROOT_DIR;
  return resolve(runtimeRoot, '.x-session-scheduler', 'daily-plan.json');
}

function loadPlan(path: string): DailySchedulePlan | null {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DailySchedulePlan;
  } catch {
    return null;
  }
}

function savePlan(path: string, plan: DailySchedulePlan): void {
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

function parseSessionArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return DEFAULT_SESSION_ARGS;

  return raw
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function runSession(args: string[], extraArgs: string[] = []): Promise<number> {
  return new Promise((resolvePromise) => {
    const launchArgs = [...args, ...extraArgs];
    const child = spawn(process.execPath, [resolve(ROOT_DIR, 'marketing.ts'), ...launchArgs], {
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`Failed to start scheduled session: ${error.message}`);
      resolvePromise(1);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`Scheduled session exited with signal ${signal}.`);
        resolvePromise(1);
        return;
      }

      resolvePromise(code ?? 1);
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});
