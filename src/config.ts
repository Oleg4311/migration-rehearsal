import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MigrationFile, RehearsalInput, WorkloadItem } from './types.ts';

interface RawConfig {
  setup: string;
  seed: string;
  clients?: number;
  workload: WorkloadItem[];
  longReader?: { sql: string; holdMs?: number };
  migrations: string[];
}

export function loadConfig(path: string): Omit<RehearsalInput, 'adminUrl' | 'sizes' | 'budgetMs' | 'lockTimeoutMs'> & { clients: number } {
  const base = dirname(resolve(path));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`Конфигурация ${path}: ${msg}`);
  };
  need(typeof raw.setup === 'string' && typeof raw.seed === 'string', 'нужны поля setup и seed (пути к SQL-файлам)');
  need(Array.isArray(raw.workload) && raw.workload.length > 0, 'нужен непустой массив workload');
  need(Array.isArray(raw.migrations) && raw.migrations.length > 0, 'нужен непустой массив migrations');
  for (const w of raw.workload) need(w && typeof w.sql === 'string' && typeof w.name === 'string' && (w.kind === 'read' || w.kind === 'write'), `каждый элемент workload — {name, kind: "read"|"write", sql}`);
  const read = (p: string): string => readFileSync(resolve(base, p), 'utf8');
  const migrations: MigrationFile[] = raw.migrations.map((m) => ({ name: m, sql: read(m) }));
  return {
    setupSql: read(raw.setup),
    seedSql: read(raw.seed),
    workload: raw.workload,
    migrations,
    clients: raw.clients ?? 4,
    longReader: raw.longReader ? { sql: raw.longReader.sql, holdMs: raw.longReader.holdMs ?? 1500 } : undefined,
  };
}
