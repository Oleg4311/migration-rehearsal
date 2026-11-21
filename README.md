# migration-rehearsal

[![CI](https://github.com/Oleg4311/migration-rehearsal/actions/workflows/ci.yml/badge.svg)](https://github.com/Oleg4311/migration-rehearsal/actions/workflows/ci.yml)
[Релизы](https://github.com/Oleg4311/migration-rehearsal/releases) · [Отчёт по опасным миграциям](docs/report-unsafe.md) · [Отчёт по безопасным](docs/report-safe.md)

**Репетиция миграции PostgreSQL.** Инструмент берёт ваши SQL-миграции, создаёт одноразовую базу с тестовыми данными, запускает рабочую нагрузку (читающие и пишущие запросы в нескольких соединениях) и **выполняет миграцию по-настоящему**, замеряя то, что обычно выясняется уже на проде: какие блокировки взяты и как долго они держатся, перезаписана ли таблица, кто встал в очередь и сколько ждал, не сломались ли запросы приложения. Результат — отчёт с вердиктом по каждому файлу и подсказкой, как переписать опасное.

*English: rehearse PostgreSQL migrations against a throw-away database under a live query workload and measure real lock modes, table rewrites, queueing and application errors. See the [English section](#english).*

## Зачем

Миграция может быть верной и всё равно положить сервис: `ALTER COLUMN … TYPE` на большой таблице переписывает её под `ACCESS EXCLUSIVE`, `CREATE INDEX` без `CONCURRENTLY` останавливает запись, а самая безобидная `ADD COLUMN` встаёт в очередь за чужой долгой транзакцией, и все новые запросы выстраиваются за ней. Линтеры смотрят на текст выражения; здесь выражение исполняется и измеряется.

## Пример: одни и те же 6 изменений, опасный и безопасный путь

Таблица `orders` на 300 000 строк, 4 клиента крутят чтение и запись. Время — реальное, ноутбук разработчика (Windows, PostgreSQL 18, [полный отчёт](docs/report-unsafe.md)):

| Миграция | Что делает | Блокировка | Держалась | Макс. задержка запроса |
|---|---|---|---:|---:|
| `ADD COLUMN token uuid DEFAULT gen_random_uuid()` | перезаписывает таблицу | ACCESS EXCLUSIVE | **2,9 с** | 2,9 с |
| `ALTER COLUMN customer_id TYPE bigint` | перезаписывает таблицу и индексы | ACCESS EXCLUSIVE | **4,2 с** | 4,3 с |
| `CREATE INDEX` | блокирует запись | SHARE | 0,4 с | 0,4 с |
| `ADD CONSTRAINT … FOREIGN KEY` | проверка под блокировкой | SHARE ROW EXCLUSIVE | 71 мс | 95 мс |

Безопасный вариант ([отчёт](docs/report-safe.md)): колонка без значения по умолчанию, `CREATE INDEX CONCURRENTLY`, внешний ключ и `CHECK` с `NOT VALID` и отдельным `VALIDATE`, `lock_timeout` в каждом файле. Те же изменения на тех же данных: все файлы «ок», **максимальная задержка запроса — 166 мс**.

### Сценарий «долгая транзакция»

Самая частая настоящая авария. Перед каждой миграцией другое соединение открывает транзакцию, читает таблицу и держит её 1,5 с. Миграция `ADD COLUMN` сама занимает 7 мс, но ждёт эту транзакцию, а **запросы приложения встают в очередь за миграцией**:

| | Миграция ждала | Запросов в очереди | Макс. задержка запроса |
|---|---:|---:|---:|
| без защиты | ≈ 1,5 с | 4 из 4 | **≈ 1,5 с** (⛔ опасно) |
| `SET LOCAL lock_timeout = '200ms'` | 0,2 с, откат и повтор | 4 из 4 | **0,2–0,35 с** (⚠️ внимание, повтор прошёл) |

## Как это работает

```
config ──▶ одноразовая база ──▶ схема + {{rows}} строк ──▶ рабочая нагрузка (N соединений)
                                                              │
                      ┌───────────────────────────────────────┤
                      ▼                                       ▼
        сеанс миграции: BEGIN; выражение за выражением   сэмплер (отдельное соединение, каждые ~3 мс):
        после каждого — pg_locks своего pid,             pg_stat_activity + pg_blocking_pids,
        снимок relfilenode до/после                      pg_locks сеанса миграции
                      └───────────────────┬───────────────────┘
                                          ▼
                       вердикт: блокировки × время × задержки запросов × ошибки × масштаб
```

- **Блокировки** берутся точно: внутри транзакции после каждого выражения читается `pg_locks` собственного сеанса (блокировки живут до фиксации, поэтому ничего не пропустить). Файлы с `CONCURRENTLY` нельзя выполнять в транзакции: для них блокировки берутся выборкой и помечены как приблизительные.
- **Перезапись таблицы** определяется по смене `relfilenode` у таблиц и индексов до и после выражения: без разбора текста и без догадок о версии PostgreSQL.
- **Задержки и ошибки** — это измерения реальных запросов нагрузки, пересекающихся с окном миграции (плюс 250 мс после фиксации, чтобы поймать ожидавших и упавших). Миграция, переименовавшая колонку, которую использует приложение, видна как «N запросов упали: column "status" does not exist».
- **Очередь**: сэмплер считает соединения, у которых `pg_blocking_pids` содержит сеанс миграции, и время, которое сама миграция ждала чужую блокировку.
- **Масштаб**: при нескольких размерах (`--sizes 10000,300000`) для каждого файла сравнивается время работы без ожидания. Если оно растёт вместе с таблицей, файл помечается, а `--project-rows 10000000` даёт линейную оценку (грубую).
- **Подсказки** по тексту выражения ([src/hints.ts](src/hints.ts)): индекс без `CONCURRENTLY`, внешний ключ и `CHECK` без `NOT VALID`, `SET NOT NULL`, смена типа, изменчивый `DEFAULT`, `VACUUM FULL`, `TRUNCATE`. Подсказка говорит, как исправить; замер говорит, что произошло.

## Использование

Нужен **одноразовый** сервер PostgreSQL 13+ (локальный, в контейнере, сервис CI) и Node.js 22+. Инструмент создаёт на нём базы `rehearsal_*` и удаляет их; к не-локальному хосту он подключится только с `--allow-remote`. **Не указывайте боевой сервер.**

```bash
# файл migration-rehearsal.mjs — со страницы Releases (внутри примеры)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:17
node migration-rehearsal.mjs examples/shop/rehearsal.json \
  --url postgres://postgres:pw@localhost:5432/postgres \
  --sizes 10000,300000 --long-reader --project-rows 10000000 --fail-on danger
```

Параметры: `--budget-ms` (порог «опасно», 500), `--lock-timeout-ms` (общий `lock_timeout` для миграций), `--format md|json`, `--out файл`, `--fail-on warn|danger` (код выхода 1). Подробнее: `--help`.

Конфигурация ([examples/shop/rehearsal.json](examples/shop/rehearsal.json)): схема, начальные данные (`{{rows}}` подставляется числом строк), нагрузка (`{{id}}` — случайный существующий id, `{{seq}}` — уникальное число для вставок), список миграций по порядку. Каждый файл выполняется в одной транзакции, как это делают большинство инструментов миграций; файл с `CONCURRENTLY` или собственным `BEGIN` выполняется как есть.

В CI это шаг «репетиция на сервисном контейнере» с `--fail-on danger`: миграция, которая на тестовых данных останавливает запросы дольше бюджета, не пройдёт проверку.

## Что проверено

- **Тесты на реальном PostgreSQL** (24 теста; в CI на 14, 16 и 17, локально на встроенном 18): добавление колонки даёт ACCESS EXCLUSIVE без перезаписи; изменчивый `DEFAULT` и смена типа перезаписывают таблицу и её индексы, а `DEFAULT now()` нет; `CREATE INDEX` держит SHARE, а `CONCURRENTLY` не мешает записи; `NOT VALID` и `VALIDATE` берут разные блокировки; намеренная блокировка `LOCK TABLE … ; pg_sleep` оказывается «опасно» с очередью и задержкой запросов; переименование используемой колонки ловится по ошибкам нагрузки; упавшая миграция откатывается целиком, остальные пропускаются; долгая транзакция даёт очередь, а `lock_timeout` ограничивает её и повтор проходит; время перезаписи растёт с размером, добавление колонки нет.
- **Мутационные проверки**: порог «мешает записи», обнаружение перезаписи, код ошибки `lock_timeout`, окно замера после фиксации по одной убирались — тесты падают.
- **CLI**: код выхода, отказ без `--url` и для чужого хоста, неверные параметры; собранный файл запускается без `node_modules` (в CI): опасный набор не проходит `--fail-on warn`, безопасный проходит.
- Разбор SQL ([src/split.ts](src/split.ts)): строки, `E'…'`, идентификаторы, вложенные комментарии, `$$`-блоки.

## Честные ограничения

- **Это не замена проверке на копии боевых данных.** Репетиция показывает механизм (какие блокировки, перезапись, очередь, ошибки) и как он масштабируется на синтетических данных. Время на вашем проде зависит от железа, индексов, TOAST, нагрузки, репликации. Линейная оценка по двум размерам — грубая.
- Время удержания — верхняя оценка (от начала выражения до фиксации, за вычетом замеренного ожидания).
- Блокировки файлов с `CONCURRENTLY` собираются выборкой каждые ~3 мс: очень короткие блокировки можно пропустить.
- Нагрузка простая (запросы по первичному ключу из вашей конфигурации), а не воспроизведение боевого трафика. Реплики, логическая репликация, `pg_stat_statements` не моделируются.
- Блокировки учитываются на таблицах пользователя; блокировки на индексах и системных каталогах в сводку не входят (перезапись индексов видна отдельно).
- Тесты на Windows идут на встроенном PostgreSQL 18, в CI — на 14/16/17 в контейнерах; изменчивые пороги в тестах подобраны с запасом, но на очень медленной машине возможны ложные срабатывания.

## Разработка

```bash
npm ci
npm test                 # встроенный PostgreSQL (скачивается npm-пакетом); либо REHEARSAL_TEST_URL=postgres://… на свой сервер
npm run typecheck
npm run build            # dist/migration-rehearsal.mjs — один файл
node scripts/with-pg.mjs -- node dist/migration-rehearsal.mjs examples/shop/rehearsal.json   # демонстрация на встроенном сервере
```

Релизы (`v*`) собираются в CI после тестов на PostgreSQL 17, содержат контрольные суммы и подтверждение происхождения: `gh attestation verify migration-rehearsal-v0.1.0.tar.gz --repo Oleg4311/migration-rehearsal`.

Лицензия: MIT. Сделано с помощью Claude.

---

## English

**migration-rehearsal** executes your PostgreSQL migrations against a throw-away database while a live query workload runs, and measures what actually happens: lock modes taken (exact, via `pg_locks` of the migration session inside the transaction), table/index rewrites (`relfilenode` before/after), how long the conflicting lock was held, which workload queries queued behind the migration (`pg_blocking_pids`), query latency, and application errors the migration caused. It scales the table (`--sizes`) to tell constant-time from size-proportional steps, and has a **long-running-transaction scenario** that reproduces the classic outage (a harmless `ADD COLUMN` queueing behind someone's open transaction and stalling everything behind it), with `lock_timeout` + retry as the fix.

On a 300k-row table: `ADD COLUMN … DEFAULT gen_random_uuid()` held ACCESS EXCLUSIVE for 2.9 s, `ALTER COLUMN TYPE` for 4.2 s; the expand/contract rewrite of the same six changes (`CONCURRENTLY`, `NOT VALID` + `VALIDATE`, `lock_timeout`) kept the worst query delay at 166 ms.

```bash
node migration-rehearsal.mjs examples/shop/rehearsal.json --url postgres://postgres:pw@localhost:5432/postgres --sizes 10000,300000 --long-reader --fail-on danger
```

Use a **disposable** server only (it creates and drops `rehearsal_*` databases; non-local hosts need `--allow-remote`). Needs PostgreSQL 13+ and Node.js 22+. 24 tests on real PostgreSQL (14/16/17 in CI), mutation-checked, release artifacts carry SHA-256 sums and build provenance. Honest limits: synthetic data and workload — it shows the mechanism and its scaling, not your production timings. MIT licensed. Built with Claude.
