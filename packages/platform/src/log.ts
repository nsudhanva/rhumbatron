/** One JSON line per event on stdout. Docker keeps the logs. */
type Fields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
    return;
  }
  // biome-ignore lint/suspicious/noConsole: the platform log writes JSON lines to stdout.
  console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
