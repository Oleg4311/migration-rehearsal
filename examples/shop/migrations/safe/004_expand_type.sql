SET LOCAL lock_timeout = '200ms';
-- «расширить»: новая колонка, дальше пакетное копирование и переключение приложения
ALTER TABLE orders ADD COLUMN customer_id_big bigint;
