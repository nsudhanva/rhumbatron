import { Button, cn } from "@cloudflare/kumo";
import { CaretDown, Eraser } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CodeSessionError,
  type CodeSessionExecResult,
  SESSION_COMMAND_MAX,
} from "../../lib/api-code-session";
import { formatMs } from "../../lib/format";
import { Loader } from "../ui/loader";

/** Commands kept in the scrollback and in the history. */
const MAX_ENTRIES = 200;
const TERMINAL_MIN = 96;
const TERMINAL_MAX = 720;

type Failure = { kind: "cap" | "timeout" | "error"; message: string };
type Entry = {
  id: number;
  command: string;
  startedAt: number;
  status: "running" | "done" | "failed";
  result?: CodeSessionExecResult;
  failure?: Failure;
};

/** Why a command did not run, in words a person can act on. */
function failureOf(error: unknown): Failure {
  if (error instanceof CodeSessionError) {
    if (error.status === 429 && error.reason === "sandbox_cap") {
      return {
        kind: "cap",
        message:
          "The Sandbox time for this month is used up (sandbox_cap). Commands run again when the monthly meter resets; file edits still work.",
      };
    }
    if (error.reason === "busy") {
      return {
        kind: "error",
        message: "Another command runs in this session. Wait for it to end.",
      };
    }
    if (error.status === 408 || error.status === 504) {
      return { kind: "timeout", message: "The command timed out after 120 s and was stopped." };
    }
    // Any other refusal (sandbox_busy, sandbox_unavailable, ...) carries the server's own words.
    return {
      kind: "error",
      message: `${error.message} (${error.reason ?? `HTTP ${error.status}`})`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed? ?out/i.test(message)
    ? { kind: "timeout", message: "The command timed out after 120 s and was stopped." }
    : { kind: "error", message };
}

/** Output text as lines, without the empty line after a final newline. */
function lines(text: string): string[] {
  if (!text) return [];
  const out = text.replace(/\r\n?/g, "\n").split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
}

/**
 * Terminal of an edit session: a resizable panel under the editor (a drag handle on its top
 * edge, arrow keys on the handle), a prompt with history (Up / Down), and a scrollback in the log
 * well dress (DESIGN.md 9.7). stderr lines carry an `err` gutter as well as the attention color;
 * each command ends with its exit code (`exit 0` in ok, others in danger) and its duration. One
 * command runs at a time; Ctrl+L clears the view only.
 */
export function IdeTerminal({
  exec,
  height,
  onResize,
  onCollapse,
  overlay,
  inputRef,
  hidden = false,
}: {
  exec: (command: string) => Promise<CodeSessionExecResult>;
  height: number;
  onResize: (height: number) => void;
  onCollapse: () => void;
  /** Phone width: a drawer over the editor, with no drag handle. */
  overlay: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Collapsed: the scrollback and a running command stay. */
  hidden?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = entries.some((e) => e.status === "running");

  // The running command's elapsed time ticks once a second.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // New output scrolls into view.
  const entryCount = entries.length;
  const lastStatus = entries.at(-1)?.status;
  useEffect(() => {
    if (entryCount === 0 && !lastStatus) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entryCount, lastStatus]);

  const run = async () => {
    const command = input.trim();
    if (!command) return;
    if (running) {
      setNotice("A command is running. Wait for it to finish, then run the next one.");
      return;
    }
    if (command.length > SESSION_COMMAND_MAX) {
      setNotice(`Commands are limited to ${SESSION_COMMAND_MAX} characters.`);
      return;
    }
    setNotice(null);
    const id = nextId.current++;
    setEntries((current) => [
      ...current.slice(-(MAX_ENTRIES - 1)),
      { id, command, startedAt: Date.now(), status: "running" },
    ]);
    setHistory((current) =>
      current.at(-1) === command ? current : [...current, command].slice(-MAX_ENTRIES),
    );
    setCursor(null);
    setInput("");
    setDraft("");
    setNow(Date.now());
    try {
      const result = await exec(command);
      setEntries((current) =>
        current.map((e) => (e.id === id ? { ...e, status: "done", result } : e)),
      );
    } catch (error) {
      setEntries((current) =>
        current.map((e) =>
          e.id === id ? { ...e, status: "failed", failure: failureOf(error) } : e,
        ),
      );
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run();
    } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setEntries((current) => current.filter((e) => e.status === "running"));
    } else if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      if (cursor === null) setDraft(input);
      setCursor(next);
      setInput(history[next] ?? "");
    } else if (event.key === "ArrowDown" && cursor !== null) {
      event.preventDefault();
      const next = cursor + 1;
      if (next >= history.length) {
        setCursor(null);
        setInput(draft);
      } else {
        setCursor(next);
        setInput(history[next] ?? "");
      }
    }
  };

  return (
    <section
      aria-label="Terminal"
      hidden={hidden}
      className={cn(
        "flex min-h-0 shrink-0 flex-col bg-kumo-elevated",
        overlay
          ? "absolute inset-x-0 bottom-0 z-20 h-[70%] rule-ink shadow-[0_-8px_24px_var(--color-kumo-shadow-drop)]"
          : "relative max-h-[75%] border-t-2 border-kumo-divider",
      )}
      style={overlay ? undefined : { height }}
    >
      {!overlay && <ResizeHandle height={height} onResize={onResize} />}
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-kumo-rule py-1 pr-1 pl-3">
        <span className="flex min-w-0 items-center gap-3">
          <h3 className="type-h6">Terminal</h3>
          <span className="truncate font-mono text-[11px] text-kumo-subtle">
            {running ? "running" : "session workspace"} · 120 s limit
          </span>
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<Eraser size={16} aria-hidden />}
            aria-label="Clear the terminal view"
            title="Clear the view (Ctrl+L)"
            onClick={() => setEntries((current) => current.filter((e) => e.status === "running"))}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<CaretDown size={16} aria-hidden />}
            aria-label="Hide the terminal"
            title="Hide the terminal (Ctrl+`)"
            onClick={onCollapse}
          />
        </span>
      </div>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Terminal output"
        className="type-mono-log min-h-0 flex-1 overflow-auto bg-kumo-base py-2 pr-3"
      >
        {entries.length === 0 && (
          <p className="pl-3 font-sans text-[12px] text-kumo-subtle">
            Run a command in the session workspace, for example <code>ls</code> or{" "}
            <code>bun test</code>. Files a command changes count as session edits.
          </p>
        )}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} now={now} />
        ))}
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-kumo-rule px-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <span aria-hidden className="font-mono text-[12px] text-kumo-subtle">
          $
        </span>
        <input
          ref={inputRef}
          aria-label="Command"
          aria-describedby={notice ? "ide-terminal-notice" : undefined}
          className="min-h-9 min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-kumo-subtle pointer-coarse:min-h-11 max-[640px]:text-[16px]"
          placeholder={running ? "A command is running" : "Type a command and press Enter"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          maxLength={SESSION_COMMAND_MAX}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setCursor(null);
            if (notice) setNotice(null);
          }}
          onKeyDown={onKeyDown}
        />
        {running && <Loader size={12} label="Command running" />}
      </form>
      {notice && (
        <p
          id="ide-terminal-notice"
          role="status"
          className="shrink-0 px-3 pb-1.5 text-[12px] text-kumo-warning"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
IdeTerminal.displayName = "IdeTerminal";

function Line({
  gutter,
  className,
  children,
}: {
  gutter?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className="grid grid-cols-[34px_minmax(0,1fr)] gap-1.5">
      <span aria-hidden className="text-right text-kumo-subtle select-none">
        {gutter ?? ""}
      </span>
      <span className={cn("whitespace-pre", className)}>{children}</span>
    </span>
  );
}

function EntryView({ entry, now }: { entry: Entry; now: number }) {
  const r = entry.result;
  return (
    <div className="pb-1.5">
      <Line gutter="$" className="font-semibold text-kumo-subtle">
        {entry.command}
      </Line>
      {r &&
        lines(r.stdout).map((text, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: output lines are positional
          <Line key={`o${i}`}>{text || " "}</Line>
        ))}
      {r &&
        lines(r.stderr).map((text, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: output lines are positional
          <Line key={`e${i}`} gutter="err" className="text-kumo-warning">
            {text || " "}
          </Line>
        ))}
      {entry.status === "running" && (
        <Line className="flex items-center gap-2 text-kumo-subtle">
          <Loader size={10} label="Running" />
          running · {formatMs(now - entry.startedAt)}
        </Line>
      )}
      {r && (
        <Line className={r.exitCode === 0 ? "text-kumo-success" : "text-kumo-danger"}>
          {r.timedOut ? "TIMEOUT · stopped at 120 s · " : ""}
          {r.exitCode === 0 ? "PASS" : "FAIL"} · exit {r.exitCode} · {formatMs(r.durationMs)}
          {r.truncated ? " · output truncated at 64 KB per stream" : ""}
        </Line>
      )}
      {entry.failure && (
        <Line className="text-kumo-danger">
          <span className="whitespace-pre-wrap">
            {entry.failure.kind === "cap"
              ? "REFUSED"
              : entry.failure.kind === "timeout"
                ? "TIMEOUT"
                : "ERROR"}{" "}
            · {entry.failure.message}
          </span>
        </Line>
      )}
    </div>
  );
}

/** The drag handle on the terminal's top edge: drag, or Up / Down with the keyboard. */
function ResizeHandle({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  const start = useRef<{ y: number; h: number } | null>(null);
  const clamp = (h: number) => Math.round(Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, h)));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a resizable splitter has no native element
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal"
      aria-valuemin={TERMINAL_MIN}
      aria-valuemax={TERMINAL_MAX}
      aria-valuenow={height}
      tabIndex={0}
      title="Drag to resize the terminal"
      className="absolute inset-x-0 -top-3 z-10 h-5 cursor-row-resize touch-none focus-visible:outline-2 focus-visible:outline-accent-500 [&:hover>span]:bg-kumo-ink [&:focus-visible>span]:bg-kumo-ink"
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { y: event.clientY, h: height };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        onResize(clamp(start.current.h + start.current.y - event.clientY));
      }}
      onPointerUp={(event) => {
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onResize(clamp(height + 24));
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onResize(clamp(height - 24));
        }
      }}
    >
      <span aria-hidden className="absolute inset-x-0 top-[11px] h-0.5 transition-colors" />
    </div>
  );
}
