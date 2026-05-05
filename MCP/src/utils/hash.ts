import { createHash, randomUUID } from 'node:crypto';

export async function sha256(input: string): Promise<string> {
  return createHash('sha256').update(input).digest('hex');
}

export function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function generateRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
