# Репетиция миграции

PostgreSQL 18.3. Бюджет: 500 мс (дольше — «опасно»). Размеры: 10000, 300000 строк.
**Итог: ⚠️ внимание**

## 10 000 строк

Обычная нагрузка без миграции: 396 запросов, p95 1.6 мс, максимум 3.7 мс.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/safe/001_add_column.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 7.8 | 26 | 11 | 0 |
| migrations/safe/002_default_later.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 13 | 19 | 18 | 4 |
| migrations/safe/003_index_concurrently.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 24 | 6.6 | 0 |
| migrations/safe/004_expand_type.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 3.2 | 7.0 | 24 | 4 |
| migrations/safe/005_fk_not_valid.sql | ✅ ок | ShareRowExclusive (стоит запись) | 16 | 21 | 10 | 3 |
| migrations/safe/006_fk_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 21 | 12 | 0 |
| migrations/safe/007_check_not_valid.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 4.3 | 9.3 | 10 | 4 |
| migrations/safe/008_check_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 9.5 | 2.9 | 0 |
| migrations/safe/009_set_not_null.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 4.7 | 8.0 | 8.7 | 4 |

### migrations/safe/009_set_not_null.sql — ✅ ок

- кратко (до 5 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## 300 000 строк

Обычная нагрузка без миграции: 350 запросов, p95 2.9 мс, максимум 84 мс.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/safe/001_add_column.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 5.1 | 16 | 53 | 4 |
| migrations/safe/002_default_later.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 15 | 26 | 152 | 4 |
| migrations/safe/003_index_concurrently.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 317 | 60 | 0 |
| migrations/safe/004_expand_type.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 13 | 16 | 51 | 3 |
| migrations/safe/005_fk_not_valid.sql | ✅ ок | ShareRowExclusive (стоит запись) | 8.2 | 18 | 56 | 1 |
| migrations/safe/006_fk_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 64 | 155 | 0 |
| migrations/safe/007_check_not_valid.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 4.0 | 7.1 | 47 | 4 |
| migrations/safe/008_check_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 58 | 198 | 0 |
| migrations/safe/009_set_not_null.sql | ✅ ок | AccessExclusive (стоят и чтение, и запись) | 13 | 16 | 68 | 3 |

### migrations/safe/009_set_not_null.sql — ✅ ок

- кратко (до 13 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## Сценарий «долгая транзакция» (10 000 строк)

Перед каждой миграцией другое соединение открывает транзакцию, читает таблицу и держит её открытой. Любое выражение, которому нужна блокировка посильнее чтения, встаёт в очередь за ней, а все новые запросы к таблице выстраиваются уже за миграцией.

| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |
|---|---|---|---:|---:|---:|---:|
| migrations/safe/001_add_column.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 4.8 | 11 | 189 | 4 |
| migrations/safe/002_default_later.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 7.0 | 11 | 204 | 4 |
| migrations/safe/003_index_concurrently.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 20 | 5.5 | 0 |
| migrations/safe/004_expand_type.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 3.4 | 7.8 | 208 | 4 |
| migrations/safe/005_fk_not_valid.sql | ✅ ок | ShareRowExclusive (стоит запись) | 8.3 | 13 | 13 | 4 |
| migrations/safe/006_fk_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 14 | 4.4 | 0 |
| migrations/safe/007_check_not_valid.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 4.6 | 12 | 214 | 4 |
| migrations/safe/008_check_validate.sql | ✅ ок | ShareUpdateExclusive (не мешает запросам) | 0.0 | 8.5 | 4.3 | 0 |
| migrations/safe/009_set_not_null.sql | ⚠️ внимание | AccessExclusive (стоят и чтение, и запись) | 5.0 | 11 | 217 | 4 |

### migrations/safe/001_add_column.sql — ⚠️ внимание

- lock_timeout сработал: canceling statement due to lock timeout. Миграция откатилась целиком и ничего не испортила, её можно повторить позже
- миграция ждала чужую блокировку ~186 мс
- повторная попытка после завершения долгой транзакции прошла
- кратко (до 5 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)

### migrations/safe/002_default_later.sql — ⚠️ внимание

- lock_timeout сработал: canceling statement due to lock timeout. Миграция откатилась целиком и ничего не испортила, её можно повторить позже
- миграция ждала чужую блокировку ~187 мс
- повторная попытка после завершения долгой транзакции прошла
- кратко (до 7 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)

### migrations/safe/004_expand_type.sql — ⚠️ внимание

- lock_timeout сработал: canceling statement due to lock timeout. Миграция откатилась целиком и ничего не испортила, её можно повторить позже
- миграция ждала чужую блокировку ~202 мс
- повторная попытка после завершения долгой транзакции прошла
- кратко (до 3 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)

### migrations/safe/007_check_not_valid.sql — ⚠️ внимание

- lock_timeout сработал: canceling statement due to lock timeout. Миграция откатилась целиком и ничего не испортила, её можно повторить позже
- миграция ждала чужую блокировку ~202 мс
- повторная попытка после завершения долгой транзакции прошла
- кратко (до 5 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)

### migrations/safe/009_set_not_null.sql — ⚠️ внимание

- lock_timeout сработал: canceling statement due to lock timeout. Миграция откатилась целиком и ничего не испортила, её можно повторить позже
- миграция ждала чужую блокировку ~200 мс
- повторная попытка после завершения долгой транзакции прошла
- кратко (до 5 мс) держит AccessExclusiveLock: безопасно, пока нет долгих транзакций (см. сценарий «долгая транзакция»)
- 💡 `ALTER TABLE orders ALTER COLUMN note SET NOT NULL`: SET NOT NULL сканирует таблицу под ACCESS EXCLUSIVE. Сначала CHECK (колонка IS NOT NULL) NOT VALID + VALIDATE, потом SET NOT NULL (PostgreSQL 12+ пропустит скан) и удалите CHECK.

## Как время зависит от размера таблицы

| Файл (работа без ожидания чужих блокировок) | 10 000 строк, мс | 300 000 строк, мс | Растёт с размером |
|---|---:|---:|---|
| migrations/safe/001_add_column.sql | 26 | 16 | нет |
| migrations/safe/002_default_later.sql | 19 | 20 | нет |
| migrations/safe/003_index_concurrently.sql | 24 | 317 | да |
| migrations/safe/004_expand_type.sql | 7.0 | 16 | нет |
| migrations/safe/005_fk_not_valid.sql | 21 | 18 | нет |
| migrations/safe/006_fk_validate.sql | 21 | 64 | да |
| migrations/safe/007_check_not_valid.sql | 9.3 | 7.1 | нет |
| migrations/safe/008_check_validate.sql | 9.5 | 58 | да |
| migrations/safe/009_set_not_null.sql | 8.0 | 16 | нет |


---
Замеры сделаны на тестовых данных и на железе, где запущена репетиция. Они показывают **механизм** (какие блокировки, перезапись, очереди) и как он масштабируется, а не точное время на вашем продакшене.
