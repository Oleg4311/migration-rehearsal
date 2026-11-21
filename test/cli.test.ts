import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { startPg, type TestPg } from './pg.ts';

let pg: TestPg;
before(async () => {
  pg = await startPg();
});
after(async () => {
  await pg.stop();
});

const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...env },
  });

test('справка: код 0; без аргументов — код 2', () => {
  const h = cli(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Репетиция миграции/);
  assert.equal(cli([]).status, 2);
});

test('без --url и с чужим хостом — отказ с кодом 2', () => {
  const noUrl = cli(['examples/shop/rehearsal.json'], { REHEARSAL_DATABASE_URL: '' });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url/);
  const remote = cli(['examples/shop/rehearsal.json', '--url', 'postgres://u:p@db.prod.example.com:5432/app']);
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /не локальный/);
});

test('небезопасный набор: отчёт в JSON и код 1 при --fail-on warn; безопасный — код 0', () => {
  const bad = cli(['examples/shop/rehearsal.json', '--url', pg.url, '--sizes', '3000', '--format', 'json', '--fail-on', 'warn']);
  assert.equal(bad.status, 1, bad.stderr);
  const report = JSON.parse(bad.stdout);
  assert.equal(report.runs[0].files.length, 6);
  assert.ok(report.worst === 'warn' || report.worst === 'danger');
  const alter = report.runs[0].files.find((f: { name: string }) => f.name.includes('004'));
  assert.ok(alter.statements[0].rewritten.includes('orders'));

  const good = cli(['examples/shop/rehearsal-safe.json', '--url', pg.url, '--sizes', '3000', '--fail-on', 'danger']);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /^# Репетиция миграции/m);
  assert.match(good.stdout, /009_set_not_null/);
});

test('неверные параметры — код 2 и понятное сообщение', () => {
  const r = cli(['examples/shop/rehearsal.json', '--url', pg.url, '--sizes', 'abc']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Ошибка/);
});
