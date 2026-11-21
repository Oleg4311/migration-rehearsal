import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hintsFor } from '../src/hints.ts';
import { normalize, splitStatements } from '../src/split.ts';

test('делит по точке с запятой и убирает пустое', () => {
  assert.deepEqual(splitStatements('SELECT 1; ;SELECT 2;\n'), ['SELECT 1', 'SELECT 2']);
});

test('не делит внутри строк, идентификаторов, комментариев и $$', () => {
  const sql = `INSERT INTO t VALUES ('a;b'); -- комментарий; с точкой
SELECT "x;y" FROM t; /* a; /* вложенный; */ b; */ SELECT 3;
CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql;
SELECT E'it\\'s; fine';`;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 5);
  assert.match(parts[0]!, /'a;b'/);
  assert.match(parts[1]!, /SELECT "x;y"/);
  assert.match(parts[3]!, /RETURN 1; END;/);
  assert.match(parts[4]!, /it\\'s; fine/);
});

test('кавычка, удвоенная внутри строки, не закрывает её', () => {
  assert.deepEqual(splitStatements("SELECT 'it''s; ok'; SELECT 2"), ["SELECT 'it''s; ok'", 'SELECT 2']);
});

test('комментарий без выражения — не выражение', () => {
  assert.deepEqual(splitStatements('-- ничего\n'), []);
});

test('normalize убирает комментарии и сжимает пробелы', () => {
  assert.equal(normalize('ALTER  TABLE t -- x\n  ADD COLUMN c int /* y */;'), 'ALTER TABLE t ADD COLUMN c int ;');
});

test('подсказки: индекс, внешний ключ, NOT NULL, смена типа, изменчивый DEFAULT', () => {
  const codes = (s: string) => hintsFor(s).map((h) => h.code);
  assert.deepEqual(codes('CREATE INDEX i ON t (a)'), ['index-not-concurrent']);
  assert.deepEqual(codes('CREATE UNIQUE INDEX i ON t (a)'), ['index-not-concurrent']);
  assert.deepEqual(codes('CREATE INDEX CONCURRENTLY i ON t (a)'), []);
  assert.deepEqual(codes('ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id)'), ['fk-not-valid']);
  assert.deepEqual(codes('ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id) NOT VALID'), []);
  assert.deepEqual(codes('ALTER TABLE t ALTER COLUMN a SET NOT NULL'), ['set-not-null']);
  assert.deepEqual(codes('ALTER TABLE t ALTER COLUMN a TYPE bigint'), ['alter-type']);
  assert.deepEqual(codes('ALTER TABLE t ADD COLUMN a uuid DEFAULT gen_random_uuid()'), ['volatile-default']);
  assert.deepEqual(codes('ALTER TABLE t ADD COLUMN a timestamptz DEFAULT now()'), []);
  assert.deepEqual(codes('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0)'), ['check-not-valid']);
});
