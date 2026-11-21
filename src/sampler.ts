import pg from 'pg';
import { now, sleep } from './workload.ts';

export interface Sample {
  t: number;
  blockedByMig: number;
  migWaiting: boolean;
  locks: { relation: string; mode: string }[];
}

const USER_TABLES = `c.relkind IN ('r','p','m') AND c.relnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog','pg_toast','information_schema'))`;

/** Опрашивает pg_stat_activity и pg_locks с отдельного соединения: кого блокирует сеанс миграции и что он держит. */
export class Sampler {
  readonly samples: Sample[] = [];
  private client!: pg.Client;
  private stopped = false;
  private loop?: Promise<void>;

  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async start(migPid: number): Promise<void> {
    this.client = new pg.Client({ connectionString: this.url, application_name: 'rehearsal-sampler' });
    this.client.on('error', () => {});
    await this.client.connect();
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const t = now();
          const act = await this.client.query<{ pid: number; wait_event_type: string | null; b: number[] }>(
            `SELECT pid, wait_event_type, pg_blocking_pids(pid) AS b FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
          );
          let blocked = 0;
          let migWaiting = false;
          for (const r of act.rows) {
            if (r.pid === migPid) migWaiting = r.wait_event_type === 'Lock';
            else if (r.b.includes(migPid)) blocked++;
          }
          const lk = await this.client.query<{ relname: string; mode: string }>(
            `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
             WHERE l.pid = $1 AND l.granted AND ${USER_TABLES}`,
            [migPid],
          );
          this.samples.push({ t, blockedByMig: blocked, migWaiting, locks: lk.rows.map((r) => ({ relation: r.relname, mode: r.mode })) });
        } catch {
          // соединение могло закрыться при остановке
        }
        await sleep(3);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await this.client.end().catch(() => {});
  }

  between(a: number, b: number): Sample[] {
    return this.samples.filter((s) => s.t >= a && s.t <= b);
  }

  /** Суммарное время, когда сеанс миграции ждал чужую блокировку (по выборке). */
  waitedMs(a: number, b: number): number {
    const s = this.between(a, b);
    let total = 0;
    for (let i = 0; i < s.length - 1; i++) if (s[i]!.migWaiting) total += s[i + 1]!.t - s[i]!.t;
    return total;
  }
}

export const USER_TABLES_SQL = USER_TABLES;
