import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeScaling } from '../src/rehearse.ts';
import type { FileResult, Run } from '../src/types.ts';

const file = (name: string, totalMs: number, waitedMs = 0, hold = totalMs): FileResult => ({
  name, mode: 'transaction', statements: [], totalMs, strongest: null, blocksWrites: true, blocksReads: false,
  conflictHoldMs: hold, maxBlockedBackends: 0, waitedMs,
  workload: { ops: 0, errors: 0, p95Ms: 0, maxMs: 0, stalled: 0 }, verdict: 'ok', reasons: [],
});
const run = (rows: number, files: FileResult[]): Run => ({ rows, scenario: 'baseline', baseline: files[0]!.workload, files });

test('время, растущее вместе с таблицей, помечается и экстраполируется', () => {
  const s = computeScaling([run(10_000, [file('a', 40), file('b', 5)]), run(100_000, [file('a', 380), file('b', 6)])], 10_000_000);
  assert.equal(s[0]!.growsWithSize, true);
  assert.ok(Math.abs(s[0]!.projection!.workMs - (380 + (340 / 90_000) * 9_900_000)) < 1);
  assert.equal(s[1]!.growsWithSize, false);
  assert.equal(s[1]!.projection, undefined);
});

test('мелкий шум не считается ростом', () => {
  const s = computeScaling([run(10_000, [file('a', 1)]), run(100_000, [file('a', 9)])]);
  assert.equal(s[0]!.growsWithSize, false);
});

test('один размер — нечего сравнивать; сценарий долгой транзакции в масштаб не входит', () => {
  assert.equal(computeScaling([run(1000, [file('a', 500)])])[0]!.growsWithSize, false);
  const lr: Run = { ...run(1000, [file('a', 9999)]), scenario: 'long-reader' };
  assert.deepEqual(computeScaling([lr]), []);
});

test('ожидание чужой блокировки не считается ростом от размера', () => {
  const s = computeScaling([run(10_000, [file('a', 30, 0)]), run(100_000, [file('a', 900, 880)])]);
  assert.equal(s[0]!.growsWithSize, false);
});
