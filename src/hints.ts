import { normalize } from './split.ts';
import type { Hint } from './types.ts';

// Подсказки по тексту выражения. Это не замена замеру: замер говорит, что произошло, подсказка — как поправить.
export function hintsFor(stmt: string): Hint[] {
  const s = normalize(stmt);
  const h: Hint[] = [];
  const add = (code: string, message: string) => h.push({ code, message });

  if (/^create (unique )?index (?!concurrently)/i.test(s) || /^create (unique )?index$/i.test(s)) {
    add('index-not-concurrent', 'CREATE INDEX без CONCURRENTLY держит блокировку SHARE: записи в таблицу стоят всё время построения. Используйте CREATE INDEX CONCURRENTLY (вне транзакции).');
  }
  if (/\badd constraint\b.*\bforeign key\b/i.test(s) && !/\bnot valid\b/i.test(s)) {
    add('fk-not-valid', 'Внешний ключ проверяет все строки под блокировкой. Добавьте его с NOT VALID, затем отдельным выражением ALTER TABLE … VALIDATE CONSTRAINT (блокировка слабее).');
  }
  if (/\badd (constraint \S+ )?check\b/i.test(s) && !/\bnot valid\b/i.test(s)) {
    add('check-not-valid', 'CHECK проверяет все строки под ACCESS EXCLUSIVE. Добавьте с NOT VALID и затем VALIDATE CONSTRAINT.');
  }
  if (/\balter column\b.*\bset not null\b/i.test(s)) {
    add('set-not-null', 'SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.');
  }
  if (/\balter column\b.*\b(set data )?type\b/i.test(s)) {
    add('alter-type', 'Смена типа обычно переписывает таблицу под ACCESS EXCLUSIVE. Безопаснее: новая колонка, пакетное копирование, переключение, удаление старой.');
  }
  if (/\badd column\b.*\bdefault\b.*\b(random|gen_random_uuid|uuid_generate_v4|clock_timestamp|nextval|timeofday)\s*\(/i.test(s)) {
    add('volatile-default', 'Изменчивое значение по умолчанию (random, gen_random_uuid …) заставляет переписать всю таблицу. Добавьте колонку без DEFAULT, заполните пакетами, затем установите DEFAULT.');
  }
  if (/^(vacuum full|cluster|reindex (?!.*concurrently))/i.test(s)) {
    add('heavy-maintenance', 'Эта операция блокирует таблицу на всё время работы. Для индексов — REINDEX CONCURRENTLY; для таблиц — pg_repack или перенос данных.');
  }
  if (/^truncate\b/i.test(s)) {
    add('truncate', 'TRUNCATE берёт ACCESS EXCLUSIVE и недоступен для чтения параллельно.');
  }
  if (/^drop (table|index)\b/i.test(s) && !/\bconcurrently\b/i.test(s) && /^drop index\b/i.test(s)) {
    add('drop-index', 'DROP INDEX берёт ACCESS EXCLUSIVE на таблицу; DROP INDEX CONCURRENTLY — только блокировка на изменение схемы.');
  }
  return h;
}

/** Предупреждение для файла без защиты от долгого ожидания блокировки. */
export function lacksLockTimeout(sql: string): boolean {
  return !/\block_timeout\b/i.test(sql);
}
