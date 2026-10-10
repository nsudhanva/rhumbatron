import { Button } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  overrideChange,
  type RequestConflictCriterion,
  type RequestConflictDetail,
  type RequestConflictSide,
} from "../../lib/api";
import { ChangeStatusPill } from "../project/status";
import { Mono } from "../ui/mono";
import { Tag } from "../ui/tag";

export function RequestConflictCard({
  conflict,
  currentChangeId,
  projectId,
  isOwner,
}: {
  conflict: RequestConflictDetail;
  currentChangeId: string;
  projectId: string;
  isOwner?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const override = useMutation({
    mutationFn: (targetId: string) => overrideChange({ data: targetId }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["changes", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["change", currentChangeId] }),
        queryClient.invalidateQueries({ queryKey: ["request-conflicts", currentChangeId] }),
      ]);
      if (result?.changeId) {
        await navigate({ to: "/changes/$changeId", params: { changeId: result.changeId } });
      }
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const a = conflict.a;
  const b = conflict.b;

  // Criteria pairs
  const criteriaList = (
    Array.isArray(conflict.criteria) ? conflict.criteria : []
  ) as RequestConflictCriterion[];

  // Determine which change is not selected or awaiting owner
  const loserId =
    conflict.loserChangeId ??
    (conflict.winnerChangeId
      ? conflict.winnerChangeId === a.changeId
        ? b.changeId
        : a.changeId
      : null);

  // The change that can be chosen instead
  const overridableSide =
    (loserId === a.changeId ? a : loserId === b.changeId ? b : null) ??
    (a.status === "not_selected" || a.status === "awaiting_owner" ? a : null) ??
    (b.status === "not_selected" || b.status === "awaiting_owner" ? b : null);

  // Plain words formatting
  const policyLabel =
    conflict.policy === "priority_wins" || !conflict.policy
      ? "Owner priority (priority_wins)"
      : conflict.policy;

  const decisionLabel = conflict.winnerChangeId
    ? `Winner: ${
        conflict.winnerChangeId === a.changeId
          ? (a.requester.name ?? (a.requester.isYou ? "You" : "Request A"))
          : (b.requester.name ?? (b.requester.isYou ? "You" : "Request B"))
      } (${conflict.winnerChangeId === a.changeId ? a.goal : b.goal})`
    : "Waiting for the owner to choose";

  return (
    <article
      aria-label={`Conflicting requests between ${a.changeId} and ${b.changeId}`}
      className="grid gap-4 bg-kumo-elevated p-4 shadow-[inset_2px_0_0_var(--color-accent-500)]"
    >
      <header className="flex flex-wrap items-center gap-2">
        <Warning size={16} className="shrink-0 text-kumo-accent" />
        <h3 className="text-[14px] font-semibold">Conflicting requests</h3>
        <Tag variant="outline">{policyLabel}</Tag>
        <span className="ml-auto text-[12px] text-kumo-subtle">
          {conflict.winnerChangeId ? "Decided" : "Awaiting owner"}
        </span>
      </header>

      {error && <p className="text-[12px] text-kumo-danger font-medium">{error}</p>}

      {/* Both requests side by side */}
      <div className="grid gap-3 min-[760px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <RequestSide
          side={a}
          isWinner={conflict.winnerChangeId === a.changeId}
          isLoser={conflict.loserChangeId === a.changeId}
          isCurrent={currentChangeId === a.changeId}
        />
        <span className="self-center font-mono text-[11px] text-kumo-subtle text-center">vs</span>
        <RequestSide
          side={b}
          isWinner={conflict.winnerChangeId === b.changeId}
          isLoser={conflict.loserChangeId === b.changeId}
          isCurrent={currentChangeId === b.changeId}
        />
      </div>

      {/* Cited criteria pairs (text, not IDs, if available) */}
      {criteriaList.length > 0 && (
        <div className="grid gap-2">
          <h4 className="type-label text-kumo-subtle">Cited conflicting criteria</h4>
          <ul className="grid gap-2">
            {criteriaList.map((crit) => {
              const textA = crit.aText;
              const textB = crit.bText;
              return (
                <li
                  key={`${crit.a}:${crit.b}`}
                  className="bg-kumo-base p-3 grid gap-1.5 text-[13px] border border-kumo-rule"
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-0.5">
                      <span className="text-[11px] font-mono text-kumo-subtle">
                        {a.requester.name ?? (a.requester.isYou ? "You" : "Request A")} criterion:
                      </span>
                      <span className="font-medium">{textA ?? crit.a ?? "Criterion"}</span>
                    </div>
                    <div className="grid gap-0.5">
                      <span className="text-[11px] font-mono text-kumo-subtle">
                        {b.requester.name ?? (b.requester.isYou ? "You" : "Request B")} criterion:
                      </span>
                      <span className="font-medium">{textB ?? crit.b ?? "Criterion"}</span>
                    </div>
                  </div>
                  {crit.why && (
                    <p className="text-[12px] text-kumo-subtle border-t border-kumo-rule pt-1.5 mt-0.5">
                      {crit.why}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Policy and decision in plain words, plus owner override action */}
      <footer className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-kumo-rule text-[13px]">
        <div className="grid gap-0.5">
          <p className="font-medium">{decisionLabel}</p>
          <p className="text-[12px] text-kumo-subtle">
            Policy: {policyLabel}
            {conflict.decidedBy ? ` · Decided by ${conflict.decidedBy}` : ""}
          </p>
        </div>

        {isOwner && overridableSide && (
          <Button
            size="sm"
            variant="secondary"
            loading={override.isPending}
            onClick={() => override.mutate(overridableSide.changeId)}
          >
            Use this instead
          </Button>
        )}
      </footer>
    </article>
  );
}

function RequestSide({
  side,
  isWinner,
  isLoser,
  isCurrent,
}: {
  side: RequestConflictSide;
  isWinner: boolean;
  isLoser: boolean;
  isCurrent: boolean;
}) {
  const requesterLabel = side.requester.isYou ? "You" : (side.requester.name ?? "Collaborator");

  return (
    <div className="grid min-w-0 content-start gap-2 bg-kumo-base p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mono subtle>{side.changeId}</Mono>
        {isCurrent && <Tag variant="neutral">This change</Tag>}
        {isWinner && <Tag variant="accent">Winner</Tag>}
        {isLoser && <Tag variant="outline">Not selected</Tag>}
        <ChangeStatusPill status={side.status} />
      </div>

      <div className="grid gap-1">
        <Link
          to="/changes/$changeId"
          params={{ changeId: side.changeId }}
          className="font-semibold text-[14px] text-kumo-ink hover:underline line-clamp-2"
        >
          {side.goal}
        </Link>
        <p className="text-[12px] text-kumo-subtle">
          Requested by <span className="font-medium text-kumo-ink">{requesterLabel}</span>
        </p>
      </div>
    </div>
  );
}
