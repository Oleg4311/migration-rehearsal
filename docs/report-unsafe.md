# Репетиция миграции

PostgreSQL 18.3. Бюджет: 500 мс (дольше — «опасно»). Размеры: 10000, 300000 строк.
**Итог: ⛔ опасно**

## 10 000 строк

Обычная нагрузка без миграции: 427 запросов, p95 2.3 мс, максимум 5.6 мс.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/unsafe/001_add_column.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 19 | 45 | 21 | 4 |
| migrations/unsafe/002_volatile_default.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 71 | 73 | 69 | 4 |
| migrations/unsafe/003_index.sql | ✅ ок | Share (стоит запись) | 11 | 12 | 16 | 0 |
| migrations/unsafe/004_alter_type.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 170 | 171 | 167 | 4 |
| migrations/unsafe/005_foreign_key.sql | ✅ ок | ShareRowExclusive (стоит запись) | 18 | 19 | 14 | 1 |
| migrations/unsafe/006_set_not_null.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 10 | 12 | 12 | 4 |

### migrations/unsafe/001_add_column.sql — ⚠️ внимание

- кратко (до 19 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице

### migrations/unsafe/002_volatile_default.sql — ⚠️ внимание

- блокировка AccessExclusiveLock, мешающая записи, держалась до 71 мс: на больших таблицах время вырастет
- перезаписаны файлы данных: orders_pkey, orders
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ADD COLUMN token uuid DEFAULT gen_random_uuid()`: Изменчивое значение по умолчанию (random, gen_random_uuid …) заставляет переписать всю таблицу. Добавьте колонку без DEFAULT, заполните пакетами, затем установите DEFAULT.

### migrations/unsafe/003_index.sql — ✅ ок

- кратко (до 11 мс) держит ShareLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `CREATE INDEX orders_customer_idx ON orders (customer_id)`: CREATE INDEX без CONCURRENTLY держит блокировку SHARE: записи в таблицу стоят всё время построения. Используйте CREATE INDEX CONCURRENTLY (вне транзакции).

### migrations/unsafe/004_alter_type.sql — ⚠️ внимание

- блокировка AccessExclusiveLock, мешающая записи, держалась до 170 мс: на больших таблицах время вырастет
- перезаписаны файлы данных: orders, orders_pkey, orders_customer_idx
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN customer_id TYPE bigint`: Смена типа обычно переписывает таблицу под ACCESS EXCLUSIVE. Безопаснее: новая колонка, пакетное копирование, переключение, удаление старой.

### migrations/unsafe/005_foreign_key.sql — ✅ ок

- кратко (до 18 мс) держит ShareRowExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) R`: Внешний ключ проверяет все строки под блокировкой. Добавьте его с NOT VALID, затем отдельным выражением ALTER TABLE … VALIDATE CONSTRAINT (блокировка слабее).

### migrations/unsafe/006_set_not_null.sql — ⚠️ внимание

- кратко (до 10 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## 300 000 строк

Обычная нагрузка без миграции: 275 запросов, p95 29 мс, максимум 160 мс.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/unsafe/001_add_column.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 20 | 75 | 62 | 3 |
| migrations/unsafe/002_volatile_default.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 2918 | 2919 | 2911 | 4 |
| migrations/unsafe/003_index.sql | ⚠️ внимание | Share (стоит запись) | 404 | 405 | 401 | 4 |
| migrations/unsafe/004_alter_type.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 4236 | 4238 | 4309 | 4 |
| migrations/unsafe/005_foreign_key.sql | ⚠️ внимание | ShareRowExclusive (стоит запись) | 71 | 72 | 95 | 4 |
| migrations/unsafe/006_set_not_null.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 153 | 233 | 246 | 4 |

### migrations/unsafe/001_add_column.sql — ⚠️ внимание

- кратко (до 20 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице

### migrations/unsafe/002_volatile_default.sql — ⛔ опасно

- блокировка AccessExclusiveLock, мешающая записи и чтению, держалась до 2918 мс (бюджет 500 мс)
- перезаписаны файлы данных: orders_pkey, orders
- запрос рабочей нагрузки ждал 2911 мс; задержанных запросов: 5, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ADD COLUMN token uuid DEFAULT gen_random_uuid()`: Изменчивое значение по умолчанию (random, gen_random_uuid …) заставляет переписать всю таблицу. Добавьте колонку без DEFAULT, заполните пакетами, затем установите DEFAULT.

### migrations/unsafe/003_index.sql — ⚠️ внимание

- блокировка ShareLock, мешающая записи, держалась до 404 мс: на больших таблицах время вырастет
- 💡 `CREATE INDEX orders_customer_idx ON orders (customer_id)`: CREATE INDEX без CONCURRENTLY держит блокировку SHARE: записи в таблицу стоят всё время построения. Используйте CREATE INDEX CONCURRENTLY (вне транзакции).

### migrations/unsafe/004_alter_type.sql — ⛔ опасно

- блокировка AccessExclusiveLock, мешающая записи и чтению, держалась до 4236 мс (бюджет 500 мс)
- перезаписаны файлы данных: orders, orders_pkey, orders_customer_idx
- запрос рабочей нагрузки ждал 4309 мс; задержанных запросов: 4, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN customer_id TYPE bigint`: Смена типа обычно переписывает таблицу под ACCESS EXCLUSIVE. Безопаснее: новая колонка, пакетное копирование, переключение, удаление старой.

### migrations/unsafe/005_foreign_key.sql — ⚠️ внимание

- блокировка ShareRowExclusiveLock, мешающая записи, держалась до 71 мс: на больших таблицах время вырастет
- 💡 `ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) R`: Внешний ключ проверяет все строки под блокировкой. Добавьте его с NOT VALID, затем отдельным выражением ALTER TABLE … VALIDATE CONSTRAINT (блокировка слабее).

### migrations/unsafe/006_set_not_null.sql — ⚠️ внимание

- блокировка AccessExclusiveLock, мешающая записи, держалась до 153 мс: на больших таблицах время вырастет
- миграция ждала чужую блокировку ~78 мс
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## Сценарий «долгая транзакция» (10 000 строк)

Перед каждой миграцией другое соединение открывает транзакцию, читает таблицу и держит её открытой. Любое выражение, которому нужна блокировка посильнее чтения, встаёт в очередь за ней, а все новые запросы к таблице выстраиваются уже за миграцией.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/unsafe/001_add_column.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 170 | 1553 | 1545 | 4 |
| migrations/unsafe/002_volatile_default.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 166 | 1538 | 1535 | 4 |
| migrations/unsafe/003_index.sql | ✅ ок | Share (стоит запись) | 12 | 13 | 14 | 2 |
| migrations/unsafe/004_alter_type.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 104 | 1480 | 1434 | 4 |
| migrations/unsafe/005_foreign_key.sql | ✅ ок | ShareRowExclusive (стоит запись) | 15 | 18 | 87 | 3 |
| migrations/unsafe/006_set_not_null.sql | ⛔ опасно | AccessExclusive (стоят и чтение, и запись) | 22 | 1386 | 1365 | 4 |

### migrations/unsafe/001_add_column.sql — ⛔ опасно

- блокировка AccessExclusiveLock, мешающая записи, держалась до 170 мс: на больших таблицах время вырастет
- миграция ждала чужую блокировку ~1370 мс, за ней выстроились до 4 запросов
- запрос рабочей нагрузки ждал 1545 мс; задержанных запросов: 4, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице

### migrations/unsafe/002_volatile_default.sql — ⛔ опасно

- блокировка AccessExclusiveLock, мешающая записи, держалась до 166 мс: на больших таблицах время вырастет
- перезаписаны файлы данных: orders_pkey, orders
- миграция ждала чужую блокировку ~1371 мс, за ней выстроились до 4 запросов
- запрос рабочей нагрузки ждал 1535 мс; задержанных запросов: 11, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ADD COLUMN token uuid DEFAULT gen_random_uuid()`: Изменчивое значение по умолчанию (random, gen_random_uuid …) заставляет переписать всю таблицу. Добавьте колонку без DEFAULT, заполните пакетами, затем установите DEFAULT.

### migrations/unsafe/003_index.sql — ✅ ок

- кратко (до 12 мс) держит ShareLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `CREATE INDEX orders_customer_idx ON orders (customer_id)`: CREATE INDEX без CONCURRENTLY держит блокировку SHARE: записи в таблицу стоят всё время построения. Используйте CREATE INDEX CONCURRENTLY (вне транзакции).

### migrations/unsafe/004_alter_type.sql — ⛔ опасно

- блокировка AccessExclusiveLock, мешающая записи, держалась до 104 мс: на больших таблицах время вырастет
- перезаписаны файлы данных: orders, orders_pkey, orders_customer_idx
- миграция ждала чужую блокировку ~1375 мс, за ней выстроились до 4 запросов
- запрос рабочей нагрузки ждал 1434 мс; задержанных запросов: 16, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN customer_id TYPE bigint`: Смена типа обычно переписывает таблицу под ACCESS EXCLUSIVE. Безопаснее: новая колонка, пакетное копирование, переключение, удаление старой.

### migrations/unsafe/005_foreign_key.sql — ✅ ок

- кратко (до 15 мс) держит ShareRowExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) R`: Внешний ключ проверяет все строки под блокировкой. Добавьте его с NOT VALID, затем отдельным выражением ALTER TABLE … VALIDATE CONSTRAINT (блокировка слабее).

### migrations/unsafe/006_set_not_null.sql — ⛔ опасно

- кратко (до 22 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- миграция ждала чужую блокировку ~1363 мс, за ней выстроились до 4 запросов
- запрос рабочей нагрузки ждал 1365 мс; задержанных запросов: 13, одновременно в очереди за миграцией до 4
- в файле нет SET LOCAL lock_timeout: при долгой транзакции другого клиента миграция встанет в очередь и остановит запросы к таблице
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## Как время зависит от размера таблицы

| Файл (работа без ожидания чужих блокировок) | 10 000 строк, мс | 300 000 строк, мс | Растёт с размером |
|---|---:|---:|---|
| migrations/unsafe/001_add_column.sql | 45 | 35 | нет |
| migrations/unsafe/002_volatile_default.sql | 73 | 2919 | да |
| migrations/unsafe/003_index.sql | 12 | 405 | да |
| migrations/unsafe/004_alter_type.sql | 171 | 4238 | да |
| migrations/unsafe/005_foreign_key.sql | 19 | 72 | да |
| migrations/unsafe/006_set_not_null.sql | 12 | 155 | да |

- migrations/unsafe/002_volatile_default.sql: линейная оценка для 10 000 000 строк ≈ 98 с (грубо: реальное время зависит от железа и индексов).
- migrations/unsafe/003_index.sql: линейная оценка для 10 000 000 строк ≈ 14 с (грубо: реальное время зависит от железа и индексов).
- migrations/unsafe/004_alter_type.sql: линейная оценка для 10 000 000 строк ≈ 140 с (грубо: реальное время зависит от железа и индексов).
- migrations/unsafe/005_foreign_key.sql: линейная оценка для 10 000 000 строк ≈ 1.8 с (грубо: реальное время зависит от железа и индексов).
- migrations/unsafe/006_set_not_null.sql: линейная оценка для 10 000 000 строк ≈ 5.0 с (грубо: реальное время зависит от железа и индексов).

---
Замеры сделаны на тестовых данных и на железе, где запущена репетиция. Они показывают **механизм** (какие блокировки, перезапись, очереди) и как он масштабируется, а не точное время на вашем продакшене.
