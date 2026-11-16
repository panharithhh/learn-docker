import { type LoggerService, type LogLevel } from '@nestjs/common';
import { logs, SeverityNumber, trace } from '@opentelemetry/api';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  context: string;
  message: string;
  traceId?: string;
  spanId?: string;
  meta?: Record<string, unknown>;
}

const MAX_ENTRIES = 2000;

const SEVERITY_NUMBERS: Record<LogLevel, SeverityNumber> = {
  fatal: SeverityNumber.FATAL,
  error: SeverityNumber.ERROR,
  warn: SeverityNumber.WARN,
  log: SeverityNumber.INFO,
  debug: SeverityNumber.DEBUG,
  verbose: SeverityNumber.TRACE,
};

/**
 * Nest logger that stamps every line with the active trace/span id,
 * outputs structured JSON lines to stdout for Render, sends logs to
 * Grafana Cloud over OTLP, and keeps an in-memory ring buffer for queries.
 */
export class AppLogger implements LoggerService {
  private readonly entries: LogEntry[] = [];
  private nextId = 1;
  // Tests can turn the console copy off via LOG_STDOUT=false
  private readonly toStdout = process.env.LOG_STDOUT !== 'false';

  constructor() {
    // A closed stdout (terminal gone, pipe reader exited) must not take the API down
    process.stdout.on('error', () => undefined);
  }

  log(message: unknown, ...optional: unknown[]) {
    this.write('log', message, optional);
  }
  error(message: unknown, ...optional: unknown[]) {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.write('verbose', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.write('fatal', message, optional);
  }

  query(filter: {
    level?: string;
    traceId?: string;
    context?: string;
    search?: string;
    limit?: number;
  }): LogEntry[] {
    const levels = filter.level?.split(',');
    const search = filter.search?.toLowerCase();
    const result: LogEntry[] = [];
    for (
      let i = this.entries.length - 1;
      i >= 0 && result.length < (filter.limit ?? 200);
      i--
    ) {
      const entry = this.entries[i];
      if (levels && !levels.includes(entry.level)) continue;
      if (filter.traceId && entry.traceId !== filter.traceId) continue;
      if (filter.context && entry.context !== filter.context) continue;
      if (
        search &&
        !`${entry.context} ${entry.message}`.toLowerCase().includes(search)
      )
        continue;
      result.push(entry);
    }
    return result;
  }

  private write(level: LogLevel, message: unknown, optional: unknown[]) {
    // Nest passes the context as the last string argument; an Error stack may precede it
    const args = [...optional];
    const context =
      typeof args.at(-1) === 'string' ? (args.pop() as string) : 'App';
    const meta: Record<string, unknown> = {};
    for (const arg of args) {
      if (typeof arg === 'string') meta.stack = arg;
      else if (arg && typeof arg === 'object') Object.assign(meta, arg);
    }

    const span = trace.getActiveSpan();
    const spanContext = span?.spanContext();
    const entry: LogEntry = {
      id: this.nextId++,
      time: new Date().toISOString(),
      level,
      context,
      message:
        message instanceof Error
          ? message.message
          : typeof message === 'string'
            ? message
            : JSON.stringify(message),
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      meta: Object.keys(meta).length ? meta : undefined,
    };

    if (span && (level === 'warn' || level === 'error' || level === 'fatal')) {
      span.addEvent(`log.${level}`, {
        'log.message': entry.message,
        'log.context': context,
      });
    }

    // Forward to OpenTelemetry Logger (exports to Grafana Cloud via OTLP if configured)
    const otelLogger = logs.getLogger('libraflow');
    otelLogger.emit({
      body: entry.message,
      severityNumber: SEVERITY_NUMBERS[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      attributes: {
        'log.context': context,
        ...(entry.meta as Record<string, string | number | boolean | undefined> ?? {}),
      },
    });

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    if (this.toStdout && process.stdout.writable) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
  }
}

export const appLogger = new AppLogger();
