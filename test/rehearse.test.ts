import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rehearse } from '../src/rehearse.ts';
import type { FileResult, RehearsalInput, Report } from '../src/types.ts';
import { startPg, type TestPg } from './pg.ts';

let pg: TestPg;
before(async () => {
  pg = await startPg();
});
after(async () => {
  await pg.stop();
});

const SETUP = `
CREATE TABLE customers (id bigint PRIMARY KEY, email text NOT NULL);
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id integer NOT NULL,
  status text NOT NULL DEFAULT 'new',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);`;
const SEED = `
INSERT INTO customers SELECT g, 'u' || g FROM generate_series(1, 100) g;
INSERT INTO orders (customer_id, note) SELECT 1 + (g % 100), 'n' FROM generate_series(1, {{rows}}) g;`;

function input(migrations: string[], extra: Partial<RehearsalInput> = {}): RehearsalInput {
  return {
    adminUrl: pg.url,
    setupSql: SETUP,
    seedSql: SEED,
    workload: [
      { name: 'чтение', kind: 'read', sql: 'SELECT * FROM orders WHERE id = {{id}}', weight: 4 },
      { name: 'вставка', kind: 'write', sql: "INSERT INTO orders (customer_id, note) VALUES (1 + ({{seq}} % 100), 'x')", weight: 2 },
      { name: 'смена статуса', kind: 'write', sql: "UPDATE orders SET status = 'paid' WHERE id = {{id}}", weight: 2 },
    ],
    migrations: migrations.map((sql, i) => ({ name: `m${i + 1}.sql`, sql })),
    sizes: [3000],
    clients: 3,
    budgetMs: 500,
    lockTimeoutMs: 0,
    ...extra,
  };
}

const run = async (migrations: string[], extra: Partial<RehearsalInput> = {}): Promise<{ report: Report; files: FileResult[] }> => {
  const report = await rehearse(input(migrations, extra));
  return { report, files: report.runs[0]!.files };
};

test('добавление колонки: ACCESS EXCLUSIVE на миг, без перезаписи', async () => {
  const { files } = await run(['ALTER TABLE orders ADD COLUMN coupon text;']);
  const f = files[0]!;
  assert.equal(f.mode, 'transaction');
  assert.equal(f.strongest, 'AccessExclusiveLock');
  assert.ok(f.blocksReads && f.blocksWrites);
  assert.deepEqual(f.statements[0]!.rewritten, []);
  assert.ok(f.conflictHoldMs < 500);
  assert.notEqual(f.verdict, 'danger');
});

test('изменчивый DEFAULT перезаписывает таблицу, обычный (now()) — нет', async () => {
  const { files } = await run([
    'ALTER TABLE orders ADD COLUMN token uuid DEFAULT gen_random_uuid();',
    'ALTER TABLE orders ADD COLUMN seen timestamptz DEFAULT now();',
  ]);
  assert.ok(files[0]!.statements[0]!.rewritten.includes('orders'), 'orders должна быть перезаписана');
  assert.ok(files[0]!.statements[0]!.hints.some((h) => h.code === 'volatile-default'));
  assert.deepEqual(files[1]!.statements[0]!.rewritten, []);
  assert.equal(files[0]!.verdict, 'warn');
});

test('смена типа колонки перезаписывает таблицу и её индексы', async () => {
  const { files } = await run(['ALTER TABLE orders ALTER COLUMN customer_id TYPE bigint;']);
  const rw = files[0]!.statements[0]!.rewritten;
  assert.ok(rw.includes('orders'));
  assert.ok(rw.includes('orders_pkey'));
});

test('CREATE INDEX держит SHARE (стоит запись), CONCURRENTLY — нет', async () => {
  const { files } = await run(['CREATE INDEX i1 ON orders (customer_id);', 'CREATE INDEX CONCURRENTLY i2 ON orders (customer_id);']);
  assert.equal(files[0]!.strongest, 'ShareLock');
  assert.equal(files[0]!.blocksWrites, true);
  assert.equal(files[0]!.blocksReads, false);
  assert.equal(files[1]!.mode, 'autocommit');
  assert.equal(files[1]!.blocksWrites, false);
  assert.ok(files[0]!.statements[0]!.hints.some((h) => h.code === 'index-not-concurrent'));
  assert.equal(files[1]!.statements[0]!.hints.length, 0);
});

test('внешний ключ: NOT VALID держит SHARE ROW EXCLUSIVE кратко, VALIDATE уже не мешает записи', async () => {
  const { files } = await run([
    'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;',
    'ALTER TABLE orders VALIDATE CONSTRAINT fk;',
  ]);
  assert.equal(files[0]!.strongest, 'ShareRowExclusiveLock');
  assert.equal(files[1]!.blocksWrites, false);
  assert.equal(files[1]!.verdict, 'ok');
});

test('намеренно долгая блокировка: опасно, запросы нагрузки стоят и выстраиваются в очередь', async () => {
  const { files } = await run(['LOCK TABLE orders IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(0.8);']);
  const f = files[0]!;
  assert.ok(f.conflictHoldMs >= 750, `держалась ${f.conflictHoldMs}`);
  assert.equal(f.verdict, 'danger');
  assert.ok(f.workload.maxMs >= 600, `макс. задержка ${f.workload.maxMs}`);
  assert.ok(f.maxBlockedBackends >= 1);
  assert.ok(f.workload.stalled >= 1);
});

test('миграция, ломающая приложение, ловится по ошибкам нагрузки', async () => {
  const { files } = await run(['ALTER TABLE orders RENAME COLUMN status TO state;']);
  assert.ok(files[0]!.workload.errors > 0);
  assert.match(files[0]!.workload.errorSample ?? '', /status/);
  assert.equal(files[0]!.verdict, 'danger');
});

test('упавшая миграция откатывается целиком, следующие пропускаются', async () => {
  const { files } = await run(['ALTER TABLE orders ADD COLUMN a int; ALTER TABLE orders ADD COLUMN id int;', 'ALTER TABLE orders ADD COLUMN b int;']);
  assert.match(files[0]!.failed ?? '', /already exists/);
  assert.equal(files[0]!.verdict, 'danger');
  assert.equal(files[1]!.skipped, true);
});

test('долгая транзакция: миграция ждёт, за ней встают запросы; lock_timeout ограничивает потери', async () => {
  const longReader = { sql: 'SELECT count(*) FROM orders', holdMs: 1500 };
  const slow = await rehearse(input(['ALTER TABLE orders ADD COLUMN c1 text;'], { longReader }));
  const lr = slow.runs.find((r) => r.scenario === 'long-reader')!.files[0]!;
  assert.ok(lr.waitedMs >= 1000, `ждала ${lr.waitedMs}`);
  assert.ok(lr.maxBlockedBackends >= 1, 'запросы нагрузки должны встать за миграцией');
  assert.ok(lr.workload.maxMs >= 1000);
  assert.equal(lr.verdict, 'danger');
  // сам по себе (без долгой транзакции) тот же файл безопасен
  assert.notEqual(slow.runs[0]!.files[0]!.verdict, 'danger');

  const guarded = await rehearse(input(['ALTER TABLE orders ADD COLUMN c1 text;'], { longReader, lockTimeoutMs: 300 }));
  const g = guarded.runs.find((r) => r.scenario === 'long-reader')!.files[0]!;
  assert.equal(g.retried, true, 'после таймаута повтор должен пройти');
  assert.equal(g.failed, undefined);
  assert.match(g.reasons.join(' '), /lock_timeout/);
  assert.equal(g.verdict, 'warn');
  assert.ok(g.workload.maxMs < 900, `очередь должна ограничиться таймаутом, а была ${g.workload.maxMs}`);
});

test('масштаб: время перезаписи растёт с размером таблицы, добавление колонки — нет', async () => {
  const report = await rehearse(
    input(['ALTER TABLE orders ALTER COLUMN customer_id TYPE bigint;', 'ALTER TABLE orders ADD COLUMN z text;'], { sizes: [2000, 60000] }),
    1_000_000,
  );
  const [rewrite, add] = report.scaling;
  assert.equal(rewrite!.growsWithSize, true, JSON.stringify(rewrite));
  assert.ok(rewrite!.projection!.workMs > rewrite!.byRows[1]!.workMs);
  assert.equal(add!.growsWithSize, false, JSON.stringify(add));
});
