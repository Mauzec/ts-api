export const LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LogLevel = keyof typeof LOG_LEVEL_PRIORITY;

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  minLevel: LogLevel = "debug",
  secrets: string[] = [],

  write = (msgLine: string): void => {
    process.stdout.write(msgLine + "\n");
  },
): Logger {
  return {
    log(level, message, fields = {}) {
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minLevel]) return;

      let msgLine = JSON.stringify({
        ...fields,
        time: new Date().toISOString(),
        level,
        message,
      });

      for (const s of secrets) {
        if (s) {
          msgLine = msgLine.replaceAll(s, "***");
        }
      }

      write(msgLine);
    },
  };
}

export function isLogLevel(v: string): v is LogLevel {
  return Object.hasOwn(LOG_LEVEL_PRIORITY, v);
}
