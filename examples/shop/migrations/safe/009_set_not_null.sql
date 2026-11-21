SET LOCAL lock_timeout = '200ms';
-- PostgreSQL 12+ видит проверенный CHECK и не сканирует таблицу
ALTER TABLE orders ALTER COLUMN note SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_note_nn;
