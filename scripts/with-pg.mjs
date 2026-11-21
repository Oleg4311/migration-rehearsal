// Запускает одноразовый встроенный PostgreSQL, выполняет команду с REHEARSAL_DATABASE_URL и останавливает сервер.
// Использование: node scripts/with-pg.mjs -- node dist/migration-rehearsal.mjs examples/shop/rehearsal.json
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const cmd = process.argv.slice(process.argv.indexOf('--') + 1);
if (cmd.length === 0) {
  console.error('Использование: node scripts/with-pg.mjs -- <команда>');
  process.exit(2);
}
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'rehearsal-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
await pg.initialise();
await pg.start();
let code = 1;
try {
  code = await new Promise((res) => {
    const p = spawn(cmd[0], cmd.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, REHEARSAL_DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${port}/postgres`, NO_PROXY: '127.0.0.1,localhost' },
    });
    p.on('exit', (c) => res(c ?? 1));
  });
} finally {
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
