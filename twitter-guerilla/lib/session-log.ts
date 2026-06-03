import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { SessionLogEntry } from './types.ts';

const SESSION_LOG_PATH = resolve(process.cwd(), '.x-session-log.json');

export function loadSessionLog(sessionLogPath = SESSION_LOG_PATH): SessionLogEntry[] {
  if (!existsSync(sessionLogPath)) return [];

  try {
    const raw = readFileSync(sessionLogPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sortEntriesByTimestamp(entries: SessionLogEntry[]): SessionLogEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    const leftValue = Number.isNaN(leftTime) ? 0 : leftTime;
    const rightValue = Number.isNaN(rightTime) ? 0 : rightTime;
    return leftValue - rightValue;
  });
}

export function loadSessionLogsFromDirectory(sessionLogsDir: string): SessionLogEntry[] {
  if (!existsSync(sessionLogsDir)) return [];

  const entries = readdirSync(sessionLogsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => loadSessionLog(resolve(sessionLogsDir, entry.name)));

  return sortEntriesByTimestamp(entries);
}

export function isSuccessfulCommentAction(entry: SessionLogEntry): boolean {
  return entry.success && (entry.action === 'commented' || entry.action === 'liked + commented');
}

export function findLatestSuccessfulComment(
  entries: SessionLogEntry[],
  tweetId: string,
): SessionLogEntry | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.tweetId !== tweetId) continue;
    if (!isSuccessfulCommentAction(entry)) continue;
    return entry;
  }

  return null;
}

export function appendSessionLog(entry: SessionLogEntry, sessionLogPath = SESSION_LOG_PATH): void {
  mkdirSync(dirname(sessionLogPath), { recursive: true });
  const log = loadSessionLog(sessionLogPath);
  log.push(entry);
  writeFileSync(sessionLogPath, JSON.stringify(log, null, 2) + '\n', 'utf8');
}
