import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';

type LogLevel = pino.Level;

const resolveNumberEnv = (name: string, defaultValue: number): number => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return value;
};

class RotatingFileStream extends Writable {
  private stream: ReturnType<typeof createWriteStream>;
  private currentSize: number;
  private nextRotateAt: number;

  constructor(
    private readonly baseDirectory: string,
    private readonly filePrefix: string,
    private readonly maxSizeBytes: number,
    private readonly rotateIntervalMs: number,
    private readonly retainedFiles: number,
  ) {
    super({ decodeStrings: false });
    mkdirSync(baseDirectory, { recursive: true });
    this.stream = createWriteStream(this.createFilePath(), { flags: 'a' });
    this.currentSize = this.getCurrentFileSize(this.stream.path.toString());
    this.nextRotateAt = this.computeNextRotateAt();
    this.pruneOldFiles();
  }

  private createFilePath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(this.baseDirectory, `${this.filePrefix}.${stamp}.log`);
  }

  private computeNextRotateAt(): number {
    return Date.now() + this.rotateIntervalMs;
  }

  private getCurrentFileSize(path: string): number {
    if (!existsSync(path)) {
      return 0;
    }
    return statSync(path).size;
  }

  private rotate(): void {
    this.stream.end();
    this.stream = createWriteStream(this.createFilePath(), { flags: 'a' });
    this.currentSize = 0;
    this.nextRotateAt = this.computeNextRotateAt();
    this.pruneOldFiles();
  }

  private shouldRotate(extraBytes: number): boolean {
    const sizeLimitReached = this.currentSize + extraBytes >= this.maxSizeBytes;
    const intervalReached = Date.now() >= this.nextRotateAt;
    return sizeLimitReached || intervalReached;
  }

  private pruneOldFiles(): void {
    if (this.retainedFiles <= 0) {
      return;
    }

    const files = readdirSync(this.baseDirectory)
      .filter((name) => name.startsWith(`${this.filePrefix}.`) && name.endsWith('.log'))
      .map((name) => {
        const path = join(this.baseDirectory, name);
        const { mtimeMs } = statSync(path);
        return { path, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    while (files.length > this.retainedFiles) {
      const oldest = files.shift();
      if (!oldest) {
        return;
      }
      unlinkSync(oldest.path);
    }
  }

  _write(
    chunk: string | Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const line = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      if (this.shouldRotate(line.length)) {
        this.rotate();
      }

      this.currentSize += line.length;
      const ok = this.stream.write(line);
      if (ok) {
        callback();
      } else {
        this.stream.once('drain', callback);
      }
    } catch (error) {
      callback(error as Error);
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.stream.end(() => callback());
  }
}

const logDir = process.env.LOG_DIR ?? process.env.LOG_DIRECTORY ?? 'logs';
const logLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
const fileLogLevel = (process.env.LOG_FILE_LEVEL ?? 'debug') as LogLevel;
const rotateIntervalMinutes = resolveNumberEnv('LOG_ROTATE_INTERVAL_MINUTES', 24 * 60);
const maxFileSizeMb = resolveNumberEnv('LOG_MAX_FILE_SIZE_MB', 25);
const retainedFiles = resolveNumberEnv('LOG_RETAINED_FILES', 20);

const rotateStreamsBasePath = resolve(process.cwd(), logDir);
const createRotatingStream = (name: string): RotatingFileStream =>
  new RotatingFileStream(
    rotateStreamsBasePath,
    name,
    maxFileSizeMb * 1024 * 1024,
    rotateIntervalMinutes * 60 * 1000,
    retainedFiles,
  );

export const logger = pino(
  {
    base: { service: 'bsc-token-listener-bot' },
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'privateKey',
        '*.privateKey',
        'BSC_HTTP_RPC_URL',
        'BSC_WS_RPC_URL',
        'BSC_HTTP_RPC_URLS',
        'BSC_WS_RPC_URLS',
        'BSC_TX_RPC_URL',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.multistream([
    { stream: process.stdout, level: logLevel },
    { stream: createRotatingStream('debug'), level: fileLogLevel },
    { stream: createRotatingStream('info'), level: 'info' },
    { stream: createRotatingStream('warn'), level: 'warn' },
    { stream: createRotatingStream('error'), level: 'error' },
  ]),
);
