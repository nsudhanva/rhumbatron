import { Button, cn, Input } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { formatNumber, generation } from "../../lib/format";
import { EXPIRY_WARNING_MS, formatCountdown } from "./model";

const MESSAGE_MAX = 200;

/**
 * Status bar of an edit session (DESIGN.md 9.17 dress: mono 11px, `subtle`, on `elevated`): the
 * session, its base, the idle countdown, and the changed file count, then "Submit as change" (the
 * one primary action) and "Discard session". One minute before the session ends the countdown
 * turns to attention with "Keep alive". Submit opens an inline message field and Discard an
 * inline confirmation, in a row above the bar; their errors show in that row.
 */
export function IdeStatusBar({
  sessionId,
  baseGeneration,
  deadline,
  changedCount,
  defaultMessage,
  onKeepAlive,
  keepingAlive,
  onSubmit,
  onDiscard,
  onExpired,
}: {
  sessionId: string;
  baseGeneration: number;
  deadline: number;
  changedCount: number;
  defaultMessage: string;
  onKeepAlive: () => void;
  keepingAlive: boolean;
  /** Resolve to an error message, or null when the Change was created (the page navigates). */
  onSubmit: (message: string) => Promise<string | null>;
  onDiscard: () => Promise<string | null>;
  onExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [panel, setPanel] = useState<"submit" | "discard" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = deadline - now;
  const warning = left <= EXPIRY_WARNING_MS;
  useEffect(() => {
    if (left <= 0) onExpired();
  }, [left, onExpired]);

  const open = (next: "submit" | "discard") => {
    setError(null);
    if (next === "submit" && !message) setMessage(defaultMessage);
    setPanel(next);
  };

  const submit = async () => {
    const text = message.trim();
    if (!text) return setError("Enter a message for the Change.");
    if (text.length > MESSAGE_MAX)
      return setError(`Use ${MESSAGE_MAX} characters or fewer (${formatNumber(text.length)} now).`);
    setBusy(true);
    const problem = await onSubmit(text);
    setBusy(false);
    if (problem) setError(problem);
  };

  const discard = async () => {
    setBusy(true);
    const problem = await onDiscard();
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <div className="shrink-0">
      {panel === "submit" && (
        <form
          className="grid gap-2 border-t border-kumo-rule bg-kumo-base px-3 py-2.5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) setPanel(null);
          }}
        >
          <Input
            label="Change message"
            description="Every changed file becomes one Change. It runs checks, a preview and a release like any other request; the session closes."
            autoFocus
            value={message}
            maxLength={MESSAGE_MAX}
            {...(error ? { error } : {})}
            onChange={(event) => {
              setMessage(event.target.value);
              setError(null);
            }}
          />
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy}>
              Submit as change
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              title={busy ? "The Change is being created" : undefined}
              onClick={() => setPanel(null)}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}
      {panel === "discard" && (
        <div className="grid gap-2 border-t border-kumo-rule bg-kumo-base px-3 py-2.5">
          <p className="text-[13px]">
            <span className="font-semibold">Discard this session?</span>{" "}
            <span className="text-kumo-subtle">
              Every edit in it is deleted with its fork. Canonical code does not change.
            </span>
          </p>
          {error && (
            <p role="alert" className="text-[12px] text-kumo-danger">
              {error}
            </p>
          )}
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" loading={busy} onClick={() => void discard()}>
              Discard edits
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={busy ? "The session is closing" : undefined}
              onClick={() => setPanel(null)}
            >
              Keep editing
            </Button>
          </span>
        </div>
      )}
      <div className="flex min-h-9 items-center gap-3 overflow-hidden border-t-2 border-kumo-divider py-1 pr-1.5 pl-3 font-mono text-[11px] whitespace-nowrap text-kumo-subtle max-[640px]:text-[12px]">
        <span className="flex min-w-0 flex-1 items-center gap-[18px] overflow-hidden">
          <span role="status" className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0", warning ? "bg-kumo-warning" : "bg-kumo-success")}
            />
            session
          </span>
          <span className="max-[640px]:hidden" title={sessionId}>
            from {generation(baseGeneration)}
          </span>
          <span
            role="timer"
            aria-live={warning ? "polite" : "off"}
            className={cn("tabular-nums", warning && "font-semibold text-kumo-warning")}
          >
            {warning ? `ends in ${formatCountdown(left)}` : `idle ${formatCountdown(left)}`}
          </span>
          {warning && (
            <Button size="xs" variant="secondary" loading={keepingAlive} onClick={onKeepAlive}>
              Keep alive
            </Button>
          )}
          <span className="tabular-nums">{formatNumber(changedCount)} changed</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="primary"
            aria-expanded={panel === "submit"}
            onClick={() => (panel === "submit" ? setPanel(null) : open("submit"))}
          >
            <span className="max-[640px]:hidden">Submit as change</span>
            <span className="min-[641px]:hidden">Submit</span>
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={panel === "discard"}
            onClick={() => (panel === "discard" ? setPanel(null) : open("discard"))}
          >
            Discard<span className="max-[640px]:hidden"> session</span>
          </Button>
        </span>
      </div>
    </div>
  );
}
IdeStatusBar.displayName = "IdeStatusBar";
