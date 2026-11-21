import type { FileResult, Report, Run, Verdict } from './types.ts';

const ICON: Record<Verdict, string> = { ok: '✅ ок', warn: '⚠️ внимание', danger: '⛔ опасно' };
const ms = (v: number): string => (v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1));
const esc = (s: string): string => s.replaceAll('|', '\\|').replaceAll('\n', ' ');

function lockText(f: FileResult): string {
  if (!f.strongest) return '—';
  const name = f.strongest.replace(/Lock$/, '');
  const effect = f.blocksReads ? 'стоят и чтение, и запись' : f.blocksWrites ? 'стоит запись' : 'не мешает запросам';
  return `${name} (${effect})`;
}

function runTable(run: Run): string {
  const lines = [
    '| Файл | Вердикт | Самая сильная блокировка | Держалась, мс | Всего, мс | Макс. задержка запроса, мс | В очереди за миграцией |',
    '|---|---|---|---:|---:|---:|---:|',
  ];
  for (const f of run.files) {
    lines.push(
      `| ${esc(f.name)} | ${ICON[f.verdict]} | ${esc(lockText(f))} | ${f.skipped ? '—' : ms(f.conflictHoldMs)} | ${f.skipped ? '—' : ms(f.totalMs)} | ${f.skipped ? '—' : ms(f.workload.maxMs)} | ${f.skipped ? '—' : f.maxBlockedBackends} |`,
    );
  }
  return lines.join('\n');
}

export function renderMarkdown(r: Report): string {
  const out: string[] = [];
  out.push('# Репетиция миграции');
  out.push('');
  out.push(`PostgreSQL ${r.pgVersion}. Бюджет: ${r.budgetMs} мс (дольше — «опасно»). Размеры: ${r.sizes.join(', ')} строк.`);
  out.push(`**Итог: ${ICON[r.worst]}**`);
  out.push('');
  for (const run of r.runs) {
    const title =
      run.scenario === 'baseline'
        ? `## ${run.rows.toLocaleString('ru-RU')} строк`
        : `## Сценарий «долгая транзакция» (${run.rows.toLocaleString('ru-RU')} строк)`;
    out.push(title);
    out.push('');
    if (run.scenario === 'long-reader') {
      out.push('Перед каждой миграцией другое соединение открывает транзакцию, читает таблицу и держит её открытой. Любое выражение, которому нужна блокировка посильнее чтения, встаёт в очередь за ней, а все новые запросы к таблице выстраиваются уже за миграцией.');
      out.push('');
    } else {
      out.push(`Обычная нагрузка без миграции: ${run.baseline.ops} запросов, p95 ${ms(run.baseline.p95Ms)} мс, максимум ${ms(run.baseline.maxMs)} мс.`);
      out.push('');
    }
    out.push(runTable(run));
    out.push('');
    for (const f of run.files) {
      if (f.verdict === 'ok' && !f.statements.some((s) => s.hints.length)) continue;
      out.push(`### ${f.name} — ${ICON[f.verdict]}`);
      out.push('');
      for (const reason of f.reasons) out.push(`- ${reason}`);
      for (const s of f.statements) {
        for (const h of s.hints) out.push(`- 💡 \`${s.sql.slice(0, 80)}\`: ${h.message}`);
      }
      out.push('');
    }
  }
  const grows = r.scaling.filter((s) => s.growsWithSize);
  if (r.scaling.length && r.sizes.length > 1) {
    out.push('## Как время зависит от размера таблицы');
    out.push('');
    out.push('| Файл (работа без ожидания чужих блокировок) | ' + r.sizes.map((n) => `${n.toLocaleString('ru-RU')} строк, мс`).join(' | ') + ' | Растёт с размером |');
    out.push('|---|' + r.sizes.map(() => '---:').join('|') + '|---|');
    for (const s of r.scaling) {
      out.push(`| ${esc(s.file)} | ${s.byRows.map((p) => ms(p.workMs)).join(' | ')} | ${s.growsWithSize ? 'да' : 'нет'} |`);
    }
    out.push('');
    for (const s of grows) {
      if (s.projection) out.push(`- ${s.file}: линейная оценка для ${s.projection.rows.toLocaleString('ru-RU')} строк ≈ ${ms(s.projection.workMs / 1000)} с (грубо: реальное время зависит от железа и индексов).`);
    }
    out.push('');
  }
  out.push('---');
  out.push('Замеры сделаны на тестовых данных и на железе, где запущена репетиция. Они показывают **механизм** (какие блокировки, перезапись, очереди) и как он масштабируется, а не точное время на вашем продакшене.');
  return out.join('\n') + '\n';
}

export function renderJson(r: Report): string {
  return JSON.stringify(r, null, 2) + '\n';
}
