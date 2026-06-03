import type { JsonObject } from './types.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomSleep(min: number, max: number): Promise<void> {
  return sleep(rand(min, max));
}

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function parseLikeCount(text: string): number {
  const cleaned = text.replace(/,/g, '').trim();
  const match = cleaned.match(/^([\d.]+)\s*([KkMm])?$/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  const suffix = (match[2] ?? '').toUpperCase();

  if (suffix === 'K') return Math.round(num * 1000);
  if (suffix === 'M') return Math.round(num * 1_000_000);
  return Math.round(num);
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

export function isAffirmative(value: string): boolean {
  return ['y', 'yes'].includes(value.trim().toLowerCase());
}

export function ensureJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object response.');
  }
  return value as JsonObject;
}

export function getObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

export function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

export function parseJsonObject(value: string): JsonObject {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error('Expected a JSON response body but received an empty string.');
  }

  try {
    return ensureJsonObject(JSON.parse(trimmed));
  } catch {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fencedMatch) {
      return ensureJsonObject(JSON.parse(fencedMatch[1]));
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return ensureJsonObject(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
    }

    throw new Error(`Could not parse JSON from response: ${trimmed}`);
  }
}
