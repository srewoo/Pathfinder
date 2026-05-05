import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserName } from './playwright-runner.js';

export interface PathfinderConfig {
  /** Path to the exported plans JSON */
  plans?: string;
  /** Browser to run against */
  browser?: BrowserName;
  /** Run headless (default true) */
  headless?: boolean;
  /** Parallel workers */
  concurrency?: number;
  /** Where to write reports */
  outputDir?: string;
  /** Base URL when test cases lack startUrl */
  baseUrl?: string;
  /** Reporters to emit. CLI already always writes html/junit/json; this adds extra. */
  reporters?: ReporterName[];
  /** Optional retries per failing test (executed serially) */
  retries?: number;
  /** Auth personas (forwarded into the runner if used) */
  personas?: Record<string, AuthPersona>;
}

export type ReporterName = 'html' | 'junit' | 'json' | 'github' | 'console';

export interface AuthPersona {
  name: string;
  setupSteps?: unknown[];
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
}

const CANDIDATES = [
  'pathfinder.config.ts',
  'pathfinder.config.mjs',
  'pathfinder.config.js',
  'pathfinder.config.json',
];

export interface LoadedConfig {
  config: PathfinderConfig;
  path?: string;
}

export async function loadConfig(explicitPath?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
  const path = explicitPath
    ? resolve(cwd, explicitPath)
    : findConfigInCwd(cwd);

  if (!path) return { config: {} };
  if (!existsSync(path)) {
    if (explicitPath) {
      throw new Error(`Config file not found: ${path}`);
    }
    return { config: {} };
  }

  if (path.endsWith('.json')) {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PathfinderConfig;
    return { config: parsed, path };
  }

  if (path.endsWith('.ts')) {
    // Best-effort TS support: require ts-node/register or compile externally.
    // For now, surface a helpful error pointing users to .mjs / .js / .json.
    throw new Error(
      'TypeScript config files require ts-node. ' +
        'Compile to pathfinder.config.js or use pathfinder.config.json / pathfinder.config.mjs.',
    );
  }

  // .mjs / .js — dynamic import
  const mod = (await import(pathToFileURL(path).href)) as { default?: PathfinderConfig };
  const config = mod.default ?? ({} as PathfinderConfig);
  return { config, path };
}

function findConfigInCwd(cwd: string): string | undefined {
  for (const name of CANDIDATES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  // Walk up two levels — useful for monorepos.
  let dir = cwd;
  for (let i = 0; i < 2; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    for (const name of CANDIDATES) {
      const p = resolve(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export interface MergedOptions {
  plans: string;
  browser: BrowserName;
  headless: boolean;
  concurrency: number;
  outputDir: string;
  baseUrl?: string;
  reporters: ReporterName[];
  retries: number;
  shard?: { current: number; total: number };
}

export interface CliOverrides {
  plans?: string;
  browser?: string;
  headless?: boolean;
  concurrency?: string | number;
  outputDir?: string;
  baseUrl?: string;
  reporter?: string;
  retries?: string | number;
  shard?: string;
}

export function mergeOptions(config: PathfinderConfig, cli: CliOverrides): MergedOptions {
  const browser = (cli.browser ?? config.browser ?? 'chromium') as BrowserName;
  const concurrency = Math.max(
    1,
    Number(cli.concurrency ?? config.concurrency ?? 1) || 1,
  );
  const retries = Math.max(
    0,
    Number(cli.retries ?? config.retries ?? 0) || 0,
  );
  const reporters = parseReporters(cli.reporter, config.reporters);

  if (!cli.plans && !config.plans) {
    throw new Error('Missing plans file. Provide --plans <file> or set "plans" in pathfinder.config.');
  }

  return {
    plans: cli.plans ?? (config.plans as string),
    browser,
    headless: cli.headless ?? config.headless ?? true,
    concurrency,
    outputDir: cli.outputDir ?? config.outputDir ?? './reports',
    baseUrl: cli.baseUrl ?? config.baseUrl,
    reporters,
    retries,
    shard: parseShard(cli.shard),
  };
}

function parseReporters(cliReporter: string | undefined, configReporters?: ReporterName[]): ReporterName[] {
  if (cliReporter) {
    return cliReporter.split(',').map((r) => r.trim()).filter(Boolean) as ReporterName[];
  }
  if (configReporters && configReporters.length > 0) return configReporters;
  // Default: always write html/junit/json; emit console + github when running on GHA
  const base: ReporterName[] = ['html', 'junit', 'json', 'console'];
  if (process.env.GITHUB_ACTIONS === 'true') base.push('github');
  return base;
}

export function parseShard(shard: string | undefined): { current: number; total: number } | undefined {
  if (!shard) return undefined;
  const match = shard.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    throw new Error(`Invalid --shard "${shard}". Expected format: <current>/<total>, e.g. 1/4`);
  }
  const current = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (total < 1 || current < 1 || current > total) {
    throw new Error(`Invalid --shard "${shard}". Require 1 <= current <= total and total >= 1.`);
  }
  return { current, total };
}

/** Deterministic shard partition: items i where ((hash(item.id) % total) + 1) === current */
export function applyShard<T extends { id: string }>(
  items: T[],
  shard: { current: number; total: number } | undefined,
): T[] {
  if (!shard) return items;
  return items.filter((item) => {
    const bucket = (hashStringToInt(item.id) % shard.total) + 1;
    return bucket === shard.current;
  });
}

function hashStringToInt(s: string): number {
  // FNV-1a 32-bit — small, deterministic, good enough for sharding.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}
