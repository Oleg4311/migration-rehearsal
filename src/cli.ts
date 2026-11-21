import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { rehearse } from './rehearse.ts';
import { renderJson, renderMarkdown } from './report.ts';

const HELP = `Репетиция миграции PostgreSQL.

Использование:
  migration-rehearsal <rehearsal.json> --url postgres://user:pass@localhost:5432/postgres [параметры]

ВАЖНО: --url — одноразовый сервер для репетиций. Инструмент создаёт на нём временные базы (rehearsal_*) и удаляет их.
Не указывайте боевой сервер. Подключение к не-локальному хосту разрешается только с --allow-remote.

Параметры:
  --url URL             строка подключения (или переменная REHEARSAL_DATABASE_URL)
  --sizes 10000,100000  размеры таблиц для прогонов (по умолчанию 10000,100000)
  --budget-ms 500       дольше этого блокировка или задержка запроса — «опасно»
  --lock-timeout-ms N   lock_timeout для сеанса миграции (0 — не задан)
  --long-reader         добавить сценарий «долгая транзакция» (держит читающую транзакцию во время миграции)
  --project-rows N      линейная оценка времени для N строк
  --format md|json      формат отчёта (по умолчанию md)
  --out FILE            записать отчёт в файл (иначе в stdout)
  --fail-on warn|danger код выхода 1, если есть вердикт не ниже указанного (по умолчанию danger)
  --allow-remote        разрешить не-локальный хост
  -h, --help            эта справка
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      sizes: { type: 'string' },
      'budget-ms': { type: 'string' },
      'lock-timeout-ms': { type: 'string' },
      'long-reader': { type: 'boolean' },
      'project-rows': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      'fail-on': { type: 'string' },
      'allow-remote': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  const url = values.url ?? process.env.REHEARSAL_DATABASE_URL;
  if (!url) {
    process.stderr.write('Не задан --url (или REHEARSAL_DATABASE_URL).\n');
    return 2;
  }
  const host = new URL(url).hostname;
  if (!values['allow-remote'] && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    process.stderr.write(`Хост ${host} не локальный. Репетиция создаёт и удаляет базы и нагружает сервер: используйте одноразовый сервер или добавьте --allow-remote.\n`);
    return 2;
  }
  const num = (s: string | undefined, d: number): number => {
    if (s === undefined) return d;
    const v = Number(s);
    if (!Number.isFinite(v) || v < 0) throw new Error(`Неверное число: ${s}`);
    return v;
  };
  const sizes = (values.sizes ?? '10000,100000').split(',').map((s) => num(s.trim(), 0)).filter((n) => n > 0);
  if (!sizes.length) throw new Error('--sizes: нужен хотя бы один размер больше нуля');
  const failOn = values['fail-on'] ?? 'danger';
  if (failOn !== 'warn' && failOn !== 'danger') throw new Error('--fail-on: warn или danger');
  const format = values.format ?? 'md';
  if (format !== 'md' && format !== 'json') throw new Error('--format: md или json');

  const cfg = loadConfig(positionals[0]!);
  const report = await rehearse(
    {
      ...cfg,
      adminUrl: url,
      sizes,
      budgetMs: num(values['budget-ms'], 500),
      lockTimeoutMs: num(values['lock-timeout-ms'], 0),
      longReader: values['long-reader'] ? cfg.longReader ?? { sql: 'SELECT 1', holdMs: 1500 } : undefined,
      onProgress: (m) => process.stderr.write(m + '\n'),
    },
    values['project-rows'] ? num(values['project-rows'], 0) : undefined,
  );
  const text = format === 'json' ? renderJson(report) : renderMarkdown(report);
  if (values.out) writeFileSync(values.out, text);
  else process.stdout.write(text);
  const bad = failOn === 'warn' ? report.worst !== 'ok' : report.worst === 'danger';
  return bad ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`Ошибка: ${e.message}\n`);
    process.exit(2);
  },
);
