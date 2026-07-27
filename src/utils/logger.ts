import type { LogLevel } from '../config/env.js';

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveKeyPattern =
  /(?:private.?key|seed|mnemonic|authorization|password|secret|api.?key|access.?token)/iu;

export type LogContext = Readonly<Record<string, unknown>>;

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(https?|wss?):\/\/([^/\s"'<>?#]+)(?:[/?#][^\s"'<>]*)?/giu,
      '$1://$2/[REDACTED_PATH]',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]');
}

function normalize(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack === undefined ? undefined : redactSensitiveText(value.stack),
      cause: value.cause === undefined ? undefined : normalize(value.cause),
    };
  }
  if (Array.isArray(value)) {
    return value.map((child) => normalize(child));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, normalize(child, childKey)]),
    );
  }
  return value;
}

export class Logger {
  public constructor(
    private readonly minimumLevel: LogLevel,
    private readonly baseContext: LogContext = {},
  ) {}

  public child(context: LogContext): Logger {
    return new Logger(this.minimumLevel, { ...this.baseContext, ...context });
  }

  public debug(message: string, context: LogContext = {}): void {
    this.write('debug', message, context);
  }

  public info(message: string, context: LogContext = {}): void {
    this.write('info', message, context);
  }

  public warn(message: string, context: LogContext = {}): void {
    this.write('warn', message, context);
  }

  public error(message: string, context: LogContext = {}): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (priorities[level] < priorities[this.minimumLevel]) {
      return;
    }

    const record = normalize({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.baseContext,
      ...context,
    });

    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}
