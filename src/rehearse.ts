import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hintsFor, lacksLockTimeout } from './hints.ts';
import { Sampler, USER_TABLES_SQL } from './sampler.ts';
import { normalize, splitStatements } from './split.ts';
import { Workload, now, sleep, statsOf, window } from './workload.ts';
import type {
  FileResult,
  LockHeld,
  LockMode,
  MigrationFile,
  RehearsalInput,
  Report,
  Run,
  Scaling,
  StatementResult,
  Verdict,
  WorkloadStats,
} from './types.ts';

const ORDER: LockMode[] = [
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
];
const rank = (m: string): number => ORDER.indexOf(m as LockMode);
/** Режимы, конфликтующие с RowExclusive (то есть мешающие INSERT/UPDATE/DELETE). */
export const blocksWritesMode = (m: string): boolean => rank(m) >= rank('ShareLock');
export const blocksReadsMode = (m: string): boolean => m === 'AccessExclusiveLock';

const withDb = (adminUrl: string, db: string): string => {
  const u = new URL(adminUrl);
  u.pathname = '/' + db;
  return u.toString();
};

const SYSTEM = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;

async function filenodes(c: pg.Client): Promise<Map<string, string>> {
  const r = await c.query<{ name: string; fn: string | null }>(
    `SELECT n.nspname || '.' || c.relname AS name, pg_relation_filenode(c.oid)::text AS fn
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','i','m') AND ${SYSTEM}`,
  );
  return new Map(r.rows.filter((x) => x.fn).map((x) => [x.name, x.fn!]));
}

async function ownLocks(c: pg.Client): Promise<LockHeld[]> {
  const r = await c.query<{ relname: string; mode: LockMode }>(
    `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
     WHERE l.pid = pg_backend_pid() AND l.granted AND ${USER_TABLES_SQL}`,
  );
  return r.rows.map((x) => ({ relation: x.relname, mode: x.mode }));
}

const lockKey = (l: LockHeld): string => `${l.relation}\u0000${l.mode}`;

interface Ctx {
  input: RehearsalInput;
  mig: pg.Client;
  sampler: Sampler;
  workload: Workload;
  stallMs: number;
}

const short = (s: string, n = 140): string => {
  const t = normalize(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

async function runFile(ctx: Ctx, file: MigrationFile): Promise<FileResult> {
  const { mig, input } = ctx;
  const stmts = splitStatements(file.sql);
  const norm = stmts.map(normalize);
  const autocommit = norm.some((s) => /\bconcurrently\b/i.test(s) || /^(begin|start transaction|commit)\b/i.test(s));
  const results: StatementResult[] = [];
  const fileStart = now();
  let failed: string | undefined;
  let commitEnd = fileStart;

  if (input.lockTimeoutMs > 0) await mig.query(`SET lock_timeout = ${Math.floor(input.lockTimeoutMs)}`);
  if (!autocommit) await mig.query('BEGIN');
  const seenLocks = new Set<string>();

  for (let i = 0; i < stmts.length; i++) {
    const sql = stmts[i]!;
    const before = await filenodes(mig);
    const t0 = now();
    let error: string | undefined;
    try {
      await mig.query(sql);
    } catch (e) {
      error = (e as pg.DatabaseError).message;
      if ((e as pg.DatabaseError).code === '55P03') error = `lock_timeout сработал: ${error}`;
    }
    const t1 = now();
    const locks: LockHeld[] = [];
    let sampled = false;
    if (!error) {
      if (!autocommit) {
        for (const l of await ownLocks(mig)) {
          if (!seenLocks.has(lockKey(l))) {
            seenLocks.add(lockKey(l));
            locks.push(l);
          }
        }
      } else {
        sampled = true;
        const uniq = new Map<string, LockHeld>();
        for (const s of ctx.sampler.between(t0, t1)) {
          for (const l of s.locks) uniq.set(lockKey({ relation: l.relation, mode: l.mode as LockMode }), { relation: l.relation, mode: l.mode as LockMode });
        }
        locks.push(...uniq.values());
      }
    }
    const after = error ? before : await filenodes(mig);
    const rewritten = [...before].filter(([k, v]) => after.has(k) && after.get(k) !== v).map(([k]) => k.replace(/^public\./, ''));
    results.push({ index: i + 1, sql: short(sql), startMs: t0, endMs: t1, durationMs: t1 - t0, locks, locksSampled: sampled, rewritten, error, hints: hintsFor(sql) });
    if (error) {
      failed = error;
      break;
    }
  }

  if (!autocommit) {
    await mig.query(failed ? 'ROLLBACK' : 'COMMIT').catch(() => {});
    commitEnd = now();
  } else {
    commitEnd = now();
    await mig.query('ROLLBACK').catch(() => {}); // если файл сам открыл транзакцию и упал
  }
  await mig.query('RESET lock_timeout'); // файл мог выставить его на весь сеанс

  // Сводка по блокировкам
  const all = results.flatMap((r) => r.locks);
  const strongest = all.reduce<LockMode | null>((a, l) => (a === null || rank(l.mode) > rank(a) ? l.mode : a), null);
  const blocksWrites = all.some((l) => blocksWritesMode(l.mode));
  const blocksReads = all.some((l) => blocksReadsMode(l.mode));

  // Сколько держалась мешающая блокировка
  let conflictHoldMs = 0;
  if (!autocommit) {
    const first = results.find((r) => r.locks.some((l) => blocksWritesMode(l.mode)));
    if (first) conflictHoldMs = commitEnd - first.startMs;
  } else {
    for (const r of results) if (r.locks.some((l) => blocksWritesMode(l.mode))) conflictHoldMs = Math.max(conflictHoldMs, r.durationMs);
  }

  await sleep(250); // запросы, ждавшие блокировку, дописывают замеры, а поломанные миграцией запросы успевают упасть
  const samples = ctx.sampler.between(fileStart, commitEnd);
  const maxBlocked = samples.reduce((a, s) => Math.max(a, s.blockedByMig), 0);
  const waitedMs = ctx.sampler.waitedMs(fileStart, commitEnd);
  // Время ожидания чужой блокировки — не время удержания собственной
  conflictHoldMs = Math.max(0, conflictHoldMs - (conflictHoldMs > 0 ? waitedMs : 0));
  const wl: WorkloadStats = statsOf(window(ctx.workload.ops, fileStart, now()), ctx.stallMs);

  // Вердикт
  const reasons: string[] = [];
  let verdict: Verdict = 'ok';
  const raise = (v: Verdict) => {
    if (v === 'danger' || (v === 'warn' && verdict === 'ok')) verdict = v;
  };
  const budget = input.budgetMs;
  const warnMs = Math.max(20, budget / 10);
  if (failed) {
    if (failed.startsWith('lock_timeout')) {
      reasons.push(`${failed}. Миграция откатилась целиком и ничего не испортила, её можно повторить позже`);
      raise('warn');
    } else {
      reasons.push(`миграция завершилась ошибкой: ${failed}`);
      raise('danger');
    }
  }
  if (blocksWrites && conflictHoldMs >= budget) {
    reasons.push(`блокировка ${strongest}, мешающая записи${blocksReads ? ' и чтению' : ''}, держалась до ${Math.round(conflictHoldMs)} мс (бюджет ${budget} мс)`);
    raise('danger');
  } else if (blocksWrites && conflictHoldMs >= warnMs) {
    reasons.push(`блокировка ${strongest}, мешающая записи, держалась до ${Math.round(conflictHoldMs)} мс: на больших таблицах время вырастет`);
    raise('warn');
  } else if (blocksWrites) {
    reasons.push(`кратко (до ${Math.round(conflictHoldMs)} мс) держит ${strongest}: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)`);
  }
  const rewrites = [...new Set(results.flatMap((r) => r.rewritten))];
  if (rewrites.length) {
    reasons.push(`перезаписаны файлы данных: ${rewrites.join(', ')}`);
    raise('warn');
  }
  if (waitedMs >= budget) {
    reasons.push(`миграция ждала чужую блокировку ~${Math.round(waitedMs)} мс${maxBlocked ? `, за ней выстроились до ${maxBlocked} запросов` : ''}`);
    raise('danger');
  } else if (waitedMs >= warnMs) {
    reasons.push(`миграция ждала чужую блокировку ~${Math.round(waitedMs)} мс`);
    raise('warn');
  }
  if ((maxBlocked > 0 || blocksWrites) && wl.maxMs >= budget) {
    reasons.push(`запрос рабочей нагрузки ждал ${Math.round(wl.maxMs)} мс; задержанных запросов: ${wl.stalled}, одновременно в очереди за миграцией до ${maxBlocked}`);
    raise('danger');
  }
  if (wl.errors > 0) {
    reasons.push(`${wl.errors} запросов нагрузки упали во время миграции: ${wl.errorSample}`);
    raise('danger');
  }
  if (lacksLockTimeout(file.sql) && input.lockTimeoutMs === 0 && blocksReads) {
    reasons.push('в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице');
    raise('warn');
  }

  return {
    name: file.name,
    mode: autocommit ? 'autocommit' : 'transaction',
    statements: results,
    totalMs: commitEnd - fileStart,
    strongest,
    blocksWrites,
    blocksReads,
    conflictHoldMs,
    maxBlockedBackends: maxBlocked,
    waitedMs,
    workload: wl,
    verdict,
    reasons,
    failed,
  };
}

async function runOnce(input: RehearsalInput, rows: number, scenario: 'baseline' | 'long-reader', log: (s: string) => void): Promise<Run> {
  const admin = new pg.Client({ connectionString: input.adminUrl });
  await admin.connect();
  const db = 'rehearsal_' + randomBytes(5).toString('hex');
  await admin.query(`CREATE DATABASE ${db}`);
  const url = withDb(input.adminUrl, db);
  let workload: Workload | undefined;
  let sampler: Sampler | undefined;
  let mig: pg.Client | undefined;
  try {
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query(input.setupSql);
    await setup.query(input.seedSql.replaceAll('{{rows}}', String(rows)));
    await setup.query('ANALYZE');
    await setup.end();

    mig = new pg.Client({ connectionString: url, application_name: 'rehearsal-migration' });
    mig.on('error', () => {});
    await mig.connect();
    const pid = (await mig.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
    sampler = new Sampler(url);
    await sampler.start(pid);
    workload = new Workload(url, input.workload, input.clients, rows);
    await workload.start();

    // «Обычная» картина: без миграции
    const b0 = now();
    await sleep(900);
    const b1 = now();
    const baseOps = window(workload.ops, b0 + 150, b1);
    const stallMs = Math.max(50, statsOf(baseOps, Infinity).p95Ms * 5);
    const baseline = statsOf(baseOps, stallMs);

    const ctx: Ctx = { input, mig, sampler, workload, stallMs };
    const files: FileResult[] = [];
    let broken = false;
    for (const f of input.migrations) {
      if (broken) {
        files.push({
          name: f.name,
          mode: 'transaction',
          statements: [],
          totalMs: 0,
          strongest: null,
          blocksWrites: false,
          blocksReads: false,
          conflictHoldMs: 0,
          maxBlockedBackends: 0,
          waitedMs: 0,
          workload: baseline,
          verdict: 'ok',
          reasons: ['пропущен: предыдущая миграция не применилась'],
          skipped: true,
        });
        continue;
      }
      let readerDone: Promise<void> | undefined;
      if (scenario === 'long-reader' && input.longReader) {
        const reader = new pg.Client({ connectionString: url, application_name: 'rehearsal-long-reader' });
        reader.on('error', () => {});
        await reader.connect();
        await reader.query('BEGIN');
        await reader.query(input.longReader.sql);
        const hold = input.longReader.holdMs;
        readerDone = (async () => {
          await sleep(hold);
          await reader.query('COMMIT').catch(() => {});
          await reader.end().catch(() => {});
        })();
        await sleep(120);
      }
      log(`  ${f.name} (${rows} строк, ${scenario})`);
      let res = await runFile(ctx, f);
      if (readerDone) await readerDone;
      if (res.failed?.startsWith('lock_timeout') && readerDone) {
        // как в жизни: таймаут сработал, миграция откатилась; повторяем, когда долгая транзакция закончилась
        const first = res;
        const again = await runFile(ctx, f);
        res = {
          ...again,
          workload: first.workload.maxMs >= again.workload.maxMs ? first.workload : again.workload,
          maxBlockedBackends: Math.max(first.maxBlockedBackends, again.maxBlockedBackends),
          waitedMs: first.waitedMs + again.waitedMs,
          retried: !again.failed,
          reasons: [...first.reasons, again.failed ? 'повторная попытка тоже не удалась' : 'повторная попытка после завершения долгой транзакции прошла', ...again.reasons],
          verdict: again.verdict === 'danger' || first.verdict === 'danger' ? 'danger' : 'warn',
        };
      }
      files.push(res);
      if (res.failed) broken = true;
      await sleep(150);
    }
    return { rows, scenario, baseline, files };
  } finally {
    await workload?.stop().catch(() => {});
    await sampler?.stop().catch(() => {});
    await mig?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

export function computeScaling(runs: Run[], projectRows?: number): Scaling[] {
  const base = runs.filter((r) => r.scenario === 'baseline').sort((a, b) => a.rows - b.rows);
  if (!base.length) return [];
  return base[0]!.files.map((f0) => {
    const pts = base.map((r) => {
      const f = r.files.find((x) => x.name === f0.name);
      return { rows: r.rows, workMs: f ? Math.max(0, f.totalMs - f.waitedMs) : 0 };
    });
    const lo = pts[0]!;
    const hi = pts[pts.length - 1]!;
    const ratio = hi.rows / Math.max(1, lo.rows);
    const grows = pts.length > 1 && ratio > 1 && hi.workMs - lo.workMs >= 20 && hi.workMs / Math.max(1, lo.workMs) >= Math.max(2, 0.1 * ratio);
    const sc: Scaling = { file: f0.name, byRows: pts, growsWithSize: grows };
    if (grows && projectRows) sc.projection = { rows: projectRows, workMs: hi.workMs + ((hi.workMs - lo.workMs) / (hi.rows - lo.rows)) * (projectRows - hi.rows) };
    return sc;
  });
}

export async function rehearse(input: RehearsalInput, projectRows?: number): Promise<Report> {
  const log = input.onProgress ?? (() => {});
  const admin = new pg.Client({ connectionString: input.adminUrl });
  await admin.connect();
  const pgVersion = (await admin.query<{ server_version: string }>('SHOW server_version')).rows[0]!.server_version;
  await admin.end();
  const runs: Run[] = [];
  for (const rows of input.sizes) {
    log(`Размер: ${rows} строк`);
    runs.push(await runOnce(input, rows, 'baseline', log));
  }
  if (input.longReader) {
    const rows = input.sizes[0]!;
    log(`Сценарий «долгая транзакция»: ${rows} строк`);
    runs.push(await runOnce(input, rows, 'long-reader', log));
  }
  const order = { ok: 0, warn: 1, danger: 2 } as const;
  const worst = runs.flatMap((r) => r.files).reduce<Verdict>((a, f) => (order[f.verdict] > order[a] ? f.verdict : a), 'ok');
  return { pgVersion, budgetMs: input.budgetMs, sizes: input.sizes, runs, scaling: computeScaling(runs, projectRows), worst };
}
