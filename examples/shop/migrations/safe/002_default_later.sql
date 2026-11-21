SET LOCAL lock_timeout = '200ms';
-- сначала колонка без значения по умолчанию, значения проставит пакетный скрипт, потом DEFAULT только для новых строк
ALTER TABLE orders ADD COLUMN token uuid;
ALTER TABLE orders ALTER COLUMN token SET DEFAULT gen_random_uuid();
