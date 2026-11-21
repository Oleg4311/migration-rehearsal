export type LockMode =
  | 'AccessShareLock'
  | 'RowShareLock'
  | 'RowExclusiveLock'
  | 'ShareUpdateExclusiveLock'
  | 'ShareLock'
  | 'ShareRowExclusiveLock'
  | 'ExclusiveLock'
  | 'AccessExclusiveLock';

export interface WorkloadItem {
  name: string;
  kind: 'read' | 'write';
  /** SQL; {{id}} — случайный существующий id (1..rows), {{seq}} — уникальное число для вставок. */
  sql: string;
  weight?: number;
}

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface RehearsalInput {
  /** Строка подключения к ОДНОРАЗОВОМУ серверу: инструмент создаёт и удаляет на нём свои базы. */
  adminUrl: string;
  setupSql: string;
  /** {{rows}} подставляется числом строк. */
  seedSql: string;
  workload: WorkloadItem[];
  migrations: MigrationFile[];
  sizes: number[];
  clients: number;
  /** Бюджет: дольше этого блокирующая блокировка или задержка запроса считается опасной. */
  budgetMs: number;
  /** Сценарий «долгая читающая транзакция»: SQL запроса, который она выполняет, и сколько держит. */
  longReader?: { sql: string; holdMs: number };
  /** lock_timeout для сеанса миграции, мс (0 — без таймаута). */
  lockTimeoutMs: number;
  onProgress?: (msg: string) => void;
}

export interface Hint {
  code: string;
  message: string;
}

export interface LockHeld {
  relation: string;
  mode: LockMode;
}

export interface StatementResult {
  index: number;
  sql: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Новые блокировки на таблицы (точно в транзакции, по выборке вне её). */
  locks: LockHeld[];
  locksSampled: boolean;
  rewritten: string[];
  error?: string;
  hints: Hint[];
}

export interface WorkloadStats {
  ops: number;
  errors: number;
  errorSample?: string;
  p95Ms: number;
  maxMs: number;
  /** Запросы, ставшие заметно медленнее обычного. */
  stalled: number;
}

export type Verdict = 'ok' | 'warn' | 'danger';

export interface FileResult {
  name: string;
  mode: 'transaction' | 'autocommit';
  statements: StatementResult[];
  totalMs: number;
  strongest: LockMode | null;
  blocksWrites: boolean;
  blocksReads: boolean;
  /** Сколько времени (верхняя оценка) держалась блокировка, мешающая записи. */
  conflictHoldMs: number;
  maxBlockedBackends: number;
  /** Сколько миграция ждала чужую блокировку (по выборке). */
  waitedMs: number;
  workload: WorkloadStats;
  verdict: Verdict;
  reasons: string[];
  failed?: string;
  skipped?: boolean;
  /** lock_timeout сработал, и файл успешно применён повторной попыткой после завершения долгой транзакции. */
  retried?: boolean;
}

export interface Run {
  rows: number;
  scenario: 'baseline' | 'long-reader';
  baseline: WorkloadStats;
  files: FileResult[];
}

export interface Scaling {
  file: string;
  /** workMs — время файла без ожидания чужих блокировок. */
  byRows: { rows: number; workMs: number }[];
  growsWithSize: boolean;
  /** Линейная оценка при rows строк (только если растёт с размером). */
  projection?: { rows: number; workMs: number };
}

export interface Report {
  pgVersion: string;
  budgetMs: number;
  sizes: number[];
  runs: Run[];
  scaling: Scaling[];
  worst: Verdict;
}
