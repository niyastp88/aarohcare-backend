type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
const minLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

const formatArgs = (args: unknown[]) =>
  args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');

const printLine = (level: LogLevel, line: string) => {
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

const write = (level: LogLevel, scope: string | undefined, args: unknown[]) => {
  if (LEVEL_ORDER[level] < minLevel) return;

  const prefix = scope
    ? `[Aarohcare][${level.toUpperCase()}][${scope}]`
    : `[Aarohcare][${level.toUpperCase()}]`;
  printLine(level, `${prefix} ${formatArgs(args)}`);
};

const createLogger = (scope?: string) => ({
  debug: (...args: unknown[]) => write('debug', scope, args),
  info: (...args: unknown[]) => write('info', scope, args),
  warn: (...args: unknown[]) => write('warn', scope, args),
  error: (...args: unknown[]) => write('error', scope, args),
  child: (childScope: string) =>
    createLogger(scope ? `${scope}:${childScope}` : childScope),
});

export const logger = createLogger();
export type Logger = ReturnType<typeof createLogger>;
