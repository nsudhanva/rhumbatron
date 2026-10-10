import { Button } from "@cloudflare/kumo";
import type { FeedEvent, PromotionOutcome } from "../../lib/api";
import { generation, generationCode, timeAgo } from "../../lib/format";
import { shortHash } from "../candidate/model";
import { TechnicalDetails } from "../candidate/technical-details";
import { Loader } from "../ui/loader";
import { OpenAppLink } from "./change-header";
import type { VersionView } from "./headline";

/**
 * Step 5, Shipped (docs/ux/research-2026-10-09.md 7.4): "Not yet", then "Shipping Release N..."
 * with the recorded build and deploy steps, then the release result. "Live" appears only with a
 * recorded deployment (B.4). A failed release never moves the release number back.
 */

const RELEASE_STEP: Record<string, string> = {
  "build.started": "Build started",
  "build.completed": "Build finished",
  "deployment.started": "Deploying",
  "deployment.completed": "Deployed",
};

export type ShipState = {
  pending: boolean;
  error: string | null;
  outcome: PromotionOutcome | undefined;
  retry: () => void;
};

export function ShippedStep({
  version,
  changeStatus,
  ship,
  feed,
}: {
  version: VersionView | null;
  changeStatus: string;
  ship: ShipState;
  feed: FeedEvent[];
}) {
  const candidate = version?.candidate;
  const release = candidate?.release ?? null;
  const base = candidate?.baseGeneration ?? 0;
  const target = candidate?.promotedGeneration ?? ship.outcome?.generation ?? base + 1;
  const from = ship.outcome?.fromGeneration ?? base;
  const steps = feed
    .filter((e) => RELEASE_STEP[e.eventType])
    .slice(0, 4)
    .reverse();
  const technical = candidate && (candidate.status === "promoted" || ship.outcome) && (
    <TechnicalDetails>
      <p className="font-mono break-all text-kumo-subtle">
        {generation(from)} ({generationCode(from)}) → {generation(target)} ({generationCode(target)}
        )
        {(release?.commit ?? ship.outcome?.sourceCommit ?? candidate.composedCommit)
          ? ` · commit ${shortHash(release?.commit ?? ship.outcome?.sourceCommit ?? candidate.composedCommit)}`
          : ""}
        {release?.versionId ? ` · worker version ${release.versionId.slice(0, 8)}` : ""}
      </p>
    </TechnicalDetails>
  );

  if (ship.error) {
    return (
      <div className="grid justify-items-start gap-2 text-[14px]">
        <p className="text-kumo-danger">
          Shipping failed: {ship.error.replace(/\.$/, "")}. Nothing changed in the live release.
        </p>
        <Button variant="secondary" onClick={ship.retry}>
          Retry
        </Button>
      </div>
    );
  }
  const shipping =
    ship.pending ||
    changeStatus === "promoting" ||
    (changeStatus === "releasing" && !release) ||
    release?.status === "queued" ||
    release?.status === "building";
  if (shipping) {
    const saved = candidate?.status === "promoted" || !!ship.outcome;
    return (
      <div className="grid gap-1.5 text-[14px]">
        <p className="flex items-center gap-2">
          <Loader size={16} />
          {saved
            ? `${generation(target)} saved. Deploying...`
            : `Shipping ${generation(target)}...`}
        </p>
        {steps.length > 0 && (
          <ul className="grid gap-0.5 pl-6 text-[13px] text-kumo-subtle">
            {steps.map((e) => (
              <li key={e.seq}>
                {RELEASE_STEP[e.eventType]} · {timeAgo(e.occurredAt)}
              </li>
            ))}
          </ul>
        )}
        {technical}
      </div>
    );
  }
  if (release?.status === "deployed") {
    return (
      <div className="grid justify-items-start gap-2 text-[14px]">
        <p>
          {generation(release.generation)} is live.
          {release.finishedAt ? (
            <span className="text-kumo-subtle"> Deployed {timeAgo(release.finishedAt)}.</span>
          ) : null}
        </p>
        {release.url && <OpenAppLink url={release.url} />}
        {technical}
      </div>
    );
  }
  if (release?.status === "failed" || release?.status === "smoke_failed") {
    return (
      <div className="grid gap-1.5 text-[14px]">
        <p className="text-kumo-danger">
          {generation(release.generation)} was saved but did not deploy. Your previous app is still
          live.
        </p>
        <p className="text-[13px] text-kumo-subtle">
          {release.failureReason ?? "No reason was recorded."}
        </p>
        {technical}
      </div>
    );
  }
  if (release?.status === "superseded") {
    return (
      <div className="grid gap-1.5 text-[14px]">
        <p className="text-kumo-subtle">
          {generation(release.generation)} was saved, then a newer release replaced it before it
          deployed.
        </p>
        {technical}
      </div>
    );
  }
  if (candidate?.status === "promoted" || ship.outcome) {
    return (
      <div className="grid gap-1.5 text-[14px]">
        <p>{generation(target)} is saved. No deployment has been recorded yet.</p>
        {technical}
      </div>
    );
  }
  return <p className="text-[14px] text-kumo-subtle">Not yet.</p>;
}
ShippedStep.displayName = "ShippedStep";
