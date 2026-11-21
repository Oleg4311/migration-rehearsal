// Разбиение SQL-файла на выражения по «;» с учётом строк, идентификаторов, комментариев и $$-блоков.

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  const push = () => {
    const t = cur.trim();
    if (t && !/^(?:--[^\n]*\n?|\s)*$/.test(t)) out.push(t);
    cur = '';
  };
  while (i < n) {
    const c = sql[i]!;
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const e = sql.indexOf('\n', i);
      const end = e === -1 ? n : e;
      cur += sql.slice(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      // вложенные комментарии допустимы в PostgreSQL
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      cur += sql.slice(i, j);
      i = j;
    } else if (c === "'" || c === '"') {
      const escaped = c === "'" && /[eE]$/.test(cur) && !/[A-Za-z0-9_]/.test(cur[cur.length - 2] ?? ' ');
      let j = i + 1;
      while (j < n) {
        if (escaped && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      const prev = cur[cur.length - 1];
      if (m && !(prev && /[A-Za-z0-9_]/.test(prev))) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        cur += sql.slice(i, end);
        i = end;
      } else {
        cur += c;
        i++;
      }
    } else if (c === ';') {
      push();
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  push();
  return out;
}

/** Выражение без комментариев и лишних пробелов: для подсказок и коротких подписей. */
export function normalize(stmt: string): string {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
