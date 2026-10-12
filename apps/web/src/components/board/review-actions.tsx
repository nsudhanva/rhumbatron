import { Button, cn, Input } from "@cloudflare/kumo";
import { Check, X } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { useReviewRequest } from "./use-review";

const REASON_MAX = 500;

/**
 * Include / Decline for one proposed request (owner and admin only; callers hide it for other
 * roles). Decline asks for an optional reason in place, never in a browser dialog. `size="sm"`
 * fits a Board card; the Change page uses the default size with Include as its primary action.
 */
export function ReviewActions({
  projectId,
  changeId,
  title,
  size = "base",
  className,
}: {
  projectId: string;
  changeId: string;
  /** Names the request in the buttons' accessible names (a Board shows many). */
  title: string;
  size?: "sm" | "base";
  className?: string;
}) {
  const { include, decline } = useReviewRequest(projectId);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const busy = include.isPending || decline.isPending;
  const error = include.error ?? decline.error;
  const compact = size === "sm";

  return (
    <div className={cn("relative z-10 grid gap-2", className)}>
      {declining ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            decline.mutate({ changeId, reason: reason.trim() });
            setDeclining(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDeclining(false);
          }}
        >
          <Input
            id={reasonId}
            label="Reason (optional)"
            size={compact ? "sm" : "base"}
            value={reason}
            maxLength={REASON_MAX}
            // The form opens on the Decline click: the reason field takes the focus at once.
            autoFocus
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size={compact ? "sm" : "base"} variant="secondary">
              Decline request
            </Button>
            <Button
              type="button"
              size={compact ? "sm" : "base"}
              variant="ghost"
              onClick={() => setDeclining(false)}
            >
              Keep it
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size={compact ? "sm" : "base"}
            variant={compact ? "secondary" : "primary"}
            icon={Check}
            loading={include.isPending}
            disabled={decline.isPending}
            title={decline.isPending ? "Declining this request" : undefined}
            aria-label={`Include: ${title}`}
            onClick={() => include.mutate(changeId)}
          >
            Include
          </Button>
          <Button
            size={compact ? "sm" : "base"}
            variant={compact ? "ghost" : "secondary"}
            icon={X}
            loading={decline.isPending}
            disabled={include.isPending}
            title={include.isPending ? "Including this request" : undefined}
            aria-label={`Decline: ${title}`}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
        </div>
      )}
      {error && !busy && (
        <p role="alert" className="text-[12px] font-semibold text-kumo-danger">
          Not saved. {error.message}
        </p>
      )}
    </div>
  );
}
ReviewActions.displayName = "ReviewActions";
