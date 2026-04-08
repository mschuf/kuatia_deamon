import { Injectable, Logger, LogLevel, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

type StepLogLevel = Extract<
  LogLevel,
  'log' | 'error' | 'warn' | 'debug' | 'verbose'
>;

export interface StepLogContext {
  runId?: string;
  documentId?: number;
  companyId?: number;
  step?: string;
  metadata?: unknown;
}

interface StepLogPayload extends StepLogContext {
  timestamp: string;
  level: StepLogLevel;
  message: string;
}

const LEVEL_ORDER: StepLogLevel[] = [
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

@Injectable()
export class StepLoggerService implements OnModuleInit {
  private readonly logger = new Logger('KUATIA_DAEMON');
  private readonly logDir: string;
  private readonly logToFile: boolean;
  private readonly minLevel: StepLogLevel;

  constructor(private readonly configService: ConfigService) {
    this.logDir = this.resolveLogDirectory(
      this.configService.get<string>('LOG_DIR') ?? 'logs',
    );
    this.logToFile =
      (this.configService.get<string>('LOG_TO_FILE') ?? 'true') === 'true';
    this.minLevel = this.parseLevel(
      this.configService.get<string>('LOG_LEVEL') ?? 'debug',
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.logToFile) {
      return;
    }

    await mkdir(this.logDir, { recursive: true });
  }

  info(message: string, context: StepLogContext = {}): void {
    this.write('log', message, context);
  }

  warn(message: string, context: StepLogContext = {}): void {
    this.write('warn', message, context);
  }

  debug(message: string, context: StepLogContext = {}): void {
    this.write('debug', message, context);
  }

  verbose(message: string, context: StepLogContext = {}): void {
    this.write('verbose', message, context);
  }

  error(message: string, context: StepLogContext = {}, error?: unknown): void {
    const metadata =
      context.metadata && typeof context.metadata === 'object'
        ? { ...(context.metadata as Record<string, unknown>) }
        : { details: context.metadata };

    this.write('error', message, {
      ...context,
      metadata: {
        ...metadata,
        error: this.normalizeError(error),
      },
    });
  }

  private write(
    level: StepLogLevel,
    message: string,
    context: StepLogContext,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload: StepLogPayload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      runId: context.runId,
      documentId: context.documentId,
      companyId: context.companyId,
      step: context.step,
      metadata: context.metadata,
    };

    const serialized = JSON.stringify(payload);
    this.logToConsole(level, serialized);
    void this.writeToFile(serialized);
  }

  private logToConsole(level: StepLogLevel, serialized: string): void {
    if (level === 'error') {
      this.logger.error(serialized);
      return;
    }

    if (level === 'warn') {
      this.logger.warn(serialized);
      return;
    }

    if (level === 'debug') {
      this.logger.debug(serialized);
      return;
    }

    if (level === 'verbose') {
      this.logger.verbose(serialized);
      return;
    }

    this.logger.log(serialized);
  }

  private async writeToFile(serialized: string): Promise<void> {
    if (!this.logToFile) {
      return;
    }

    try {
      await appendFile(this.currentLogFilePath(), `${serialized}\n`, 'utf8');
    } catch (error) {
      this.logger.error(
        `No se pudo escribir log en archivo: ${this.normalizeError(error) ?? 'error desconocido'}`,
      );
    }
  }

  private currentLogFilePath(): string {
    const currentDate = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `daemon-${currentDate}.log`);
  }

  private shouldLog(level: StepLogLevel): boolean {
    return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(this.minLevel);
  }

  private parseLevel(rawLevel: string): StepLogLevel {
    const level = rawLevel.toLowerCase();
    if (
      level === 'error' ||
      level === 'warn' ||
      level === 'log' ||
      level === 'debug' ||
      level === 'verbose'
    ) {
      return level;
    }

    return 'debug';
  }

  private normalizeError(error: unknown): string | undefined {
    if (!error) {
      return undefined;
    }

    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    if (
      typeof error === 'string' ||
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      typeof error === 'bigint' ||
      typeof error === 'symbol'
    ) {
      return String(error);
    }

    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown_error';
    }
  }

  private resolveLogDirectory(logDir: string): string {
    if (isAbsolute(logDir)) {
      return logDir;
    }

    return join(process.cwd(), logDir);
  }
}
