import { Button, buttonVariants, cn, DropdownMenu } from "@cloudflare/kumo";
import { ArrowSquareOut, Copy, DotsThree, Scales, Wrench } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { formatUsd, generation, generationCode, timeAgo } from "../../lib/format";
import { StatusIcon } from "../ui/status-pill";
import { Term } from "../ui/term";
import type { Headline } from "./headline";

/**
 * Change page header (docs/ux/research-2026-10-09.md 7.4, P1, P4): one status (icon, word,
 * sentence), the goal, one meta line, and at most one filled button. Everything else sits in the
 * "..." menu.
 */
export function ChangeHeader({
  changeId,
  goal,
  headline,
  createdAt,
  spentUsd,
  budgetUsd,
  baseGeneration,
  riskTier,
  live,
  versionCount,
  primary,
}: {
  changeId: string;
  goal: string;
  headline: Headline;
  createdAt: string | undefined;
  spentUsd: number | null;
  budgetUsd: number;
  baseGeneration: number;
  riskTier: string | null | undefined;
  live: boolean;
  versionCount: number;
  /** The rendered primary button (or link), null in waiting states. */
  primary: ReactNode;
}) {
  const navigate = useNavigate();
  const [fullGoal, setFullGoal] = useState(false);
  const [copied, setCopied] = useState(false);
  const longGoal = goal.length > 160;

  return (
    <header className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="grid min-w-0 gap-1">
          <p className="flex items-center gap-2 text-[20px] leading-7 font-semibold">
            <StatusIcon status={headline.iconStatus} family={headline.family} size={20} />
            <span>{headline.word}</span>
          </p>
          <p className="max-w-[720px] text-[14px] text-pretty" aria-live="polite">
            {headline.sentence}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {primary}
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button
                  variant="secondary"
                  shape="square"
                  icon={DotsThree}
                  aria-label="More actions"
                />
              }
            />
            <DropdownMenu.Content align="end">
              <DropdownMenu.Item
                icon={Wrench}
                onClick={() => navigate({ to: "/changes/$changeId/flight", params: { changeId } })}
              >
                Open debug view
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={Copy}
                closeOnClick={false}
                onClick={() => {
                  void navigator.clipboard?.writeText(changeId).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy change ID"}
              </DropdownMenu.Item>
              {versionCount >= 2 && (
                <DropdownMenu.Item
                  icon={Scales}
                  onClick={() => navigate({ to: "/compare/$changeId", params: { changeId } })}
                >
                  Compare versions
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid max-w-[720px] justify-items-start gap-1">
        <h1 className={fullGoal ? "type-body" : "type-body line-clamp-2"}>{goal}</h1>
        {longGoal && (
          <button
            type="button"
            aria-expanded={fullGoal}
            onClick={() => setFullGoal((v) => !v)}
            className="text-[13px] text-kumo-link hover:underline"
          >
            {fullGoal ? "Show less" : "Show full goal"}
          </button>
        )}
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-kumo-subtle">
        {createdAt && (
          <>
            <time dateTime={createdAt} title={createdAt}>
              Started {timeAgo(createdAt)}
            </time>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="tabular-nums">
          {formatUsd(spentUsd ?? 0)} of {formatUsd(budgetUsd)} spent
        </span>
        <span aria-hidden>·</span>
        <span title={generationCode(baseGeneration)}>
          <Term k="basedOn">Based on {generation(baseGeneration)}</Term>
        </span>
        {riskTier && (
          <>
            <span aria-hidden>·</span>
            <span>{riskTier[0]?.toUpperCase() + riskTier.slice(1)} risk</span>
          </>
        )}
        {live && (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-kumo-success" />
              Updating live
            </span>
          </>
        )}
      </p>
    </header>
  );
}
ChangeHeader.displayName = "ChangeHeader";

/** An external "Open app" link styled as the primary button. */
export function OpenAppLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: "primary" }), "gap-1.5")}
    >
      Open app
      <ArrowSquareOut size={16} aria-hidden />
    </a>
  );
}
OpenAppLink.displayName = "OpenAppLink";
