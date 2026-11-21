import pg from 'pg';
import type { WorkloadItem, WorkloadStats } from './types.ts';

export const now = (): number => performance.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Op {
  name: string;
  kind: 'read' | 'write';
  t0: number;
  t1: number;
  err?: string;
}

/** Параллельная рабочая нагрузка: несколько соединений в цикле гоняют запросы и пишут задержки. */
export class Workload {
  readonly ops: Op[] = [];
  private clients: pg.Client[] = [];
  private loops: Promise<void>[] = [];
  private stopped = false;
  private seq: number;

  private readonly url: string;
  private readonly items: WorkloadItem[];
  private readonly nClients: number;
  private readonly rows: number;

  constructor(url: string, items: WorkloadItem[], nClients: number, rows: number) {
    this.url = url;
    this.items = items;
    this.nClients = nClients;
    this.rows = rows;
    this.seq = 1_000_000_000 + rows;
  }

  async start(): Promise<void> {
    const total = this.items.reduce((a, b) => a + (b.weight ?? 1), 0);
    const pick = (): WorkloadItem => {
      let r = Math.random() * total;
      for (const it of this.items) {
        r -= it.weight ?? 1;
        if (r <= 0) return it;
      }
      return this.items[0]!;
    };
    for (let i = 0; i < this.nClients; i++) {
      const c = new pg.Client({ connectionString: this.url, application_name: 'rehearsal-workload' });
      c.on('error', () => {});
      await c.connect();
      this.clients.push(c);
      this.loops.push(
        (async () => {
          while (!this.stopped) {
            const it = pick();
            const sql = it.sql
              .replaceAll('{{id}}', () => String(1 + Math.floor(Math.random() * this.rows)))
              .replaceAll('{{seq}}', () => String(this.seq++));
            const t0 = now();
            let err: string | undefined;
            try {
              await c.query(sql);
            } catch (e) {
              err = (e as Error).message;
            }
            this.ops.push({ name: it.name, kind: it.kind, t0, t1: now(), err });
            await sleep(err ? 20 : 2);
          }
        })(),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
    await Promise.all(this.clients.map((c) => c.end().catch(() => {})));
  }
}

/** Запросы, пересекающиеся с окном [a, b] по времени. */
export function window(ops: Op[], a: number, b: number): Op[] {
  return ops.filter((o) => o.t1 >= a && o.t0 <= b);
}

export function statsOf(ops: Op[], stallMs: number): WorkloadStats {
  const lat = ops.map((o) => o.t1 - o.t0).sort((x, y) => x - y);
  const errs = ops.filter((o) => o.err);
  return {
    ops: ops.length,
    errors: errs.length,
    errorSample: errs[0]?.err,
    p95Ms: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]! : 0,
    maxMs: lat.length ? lat[lat.length - 1]! : 0,
    stalled: ops.filter((o) => o.t1 - o.t0 > stallMs).length,
  };
}
