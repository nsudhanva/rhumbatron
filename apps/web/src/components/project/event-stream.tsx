import { cn } from "@cloudflare/kumo";
import { CheckCircle, Circle, CircleNotch, type Icon, XCircle } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { FeedEvent } from "../../lib/api";
import { useViewMode } from "../../lib/view-mode";
import { type TypeTone, typeTone } from "../events-page/feed-model";
import { EmptyState } from "../ui/empty-state";
import { SectionError, SkeletonBar } from "./feedback";

/**
 * Activity feed (research 7.1, 7.6 "Activity"): what happened, in order, as plain sentences,
 * newest first and grouped by minute. Event types, IDs and actors stay out of the default view;
 * with technical details shown, each row gets a "Technical details" disclosure. The raw table
 * is the Event log page (Advanced).
 */

/** Heartbeats and routing records: useful when debugging, noise in a plain feed. */
const NOISE = new Set(["claim.renewed", "model.route.decided", "agent.woken", "agent.slept"]);

const TONE_ICON: Record<TypeTone, { icon: Icon; className: string }> = {
  danger: { icon: XCircle, className: "text-kumo-danger" },
  success: { icon: CheckCircle, className: "text-kumo-success" },
  // A state change (a release); a static mark, never spinning.
  brand: { icon: CircleNotch, className: "text-kumo-accent" },
  default: { icon: Circle, className: "text-kumo-subtle" },
};

const CHECK_WORDS: Record<string, string> = {
  pass: "passed",
  fail: "failed",
  error: "could not run",
  skipped: "was skipped",
};

/** `project:acme:wishlist:membership` -> `wishlist membership`. */
function areaOf(resource: string | null) {
  if (!resource) return null;
  const parts = resource.split(":");
  const rest = parts[0] === "project" ? parts.slice(2) : parts;
  return rest.join(" ").replace(/[_-]+/g, " ") || null;
}

/** `task.started` -> `Task started`. */
function sentenceFromType(eventType: string) {
  const words = eventType.replace(/[._-]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Something happened";
}

/**
 * One plain sentence per event. The API summary uses internal names (S1842, claims, intents),
 * so the feed builds its own from the event type and the kept payload fields.
 */
function plainSummary(event: FeedEvent): string {
  const d = event.data;
  const s = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : undefined);
  const n = (key: string) => (typeof d[key] === "number" ? (d[key] as number) : undefined);
  const reason = s("reason") ? `: ${s("reason")}` : "";
  const title = s("title") ? `: ${s("title")}` : "";
  const area = areaOf(event.resource);
  const on = area ? ` on ${area}` : "";
  const release = n("generation") ?? n("toGeneration");
  const releaseName = release !== undefined ? `Release ${release}` : "The release";
  switch (event.eventType) {
    case "project.created":
      return "Project created";
    case "change.created":
      return "New change started";
    case "change.compiled": {
      const tasks = n("taskCount");
      return tasks !== undefined
        ? `Goal split into ${tasks} task${tasks === 1 ? "" : "s"}`
        : "Goal split into tasks";
    }
    case "change.cancelled":
      return `Change cancelled${reason}`;
    case "task.created":
      return `Task added${title}`;
    case "task.ready":
      return `Task ready to start${title}`;
    case "task.assigned":
      return `Task given to an agent${title}`;
    case "task.started":
      return `An agent started a task${title}`;
    case "task.completed":
      return `Task done${title}`;
    case "task.failed":
      return `Task failed${reason || title}`;
    case "claim.acquired":
      return `An agent started work${on}`;
    case "claim.renewed":
      return `An agent is still working${on}`;
    case "claim.released":
      return `An agent finished${on}`;
    case "claim.expired":
      return `An agent stopped responding${on}; its work there was released`;
    case "intent.declared":
      return `An agent planned its approach${s("summary") ? `: ${s("summary")}` : on}`;
    case "intent.changed":
      return `An agent changed its approach${on}`;
    case "challenge.created":
      return `An agent raised a concern${on}`;
    case "challenge.resolved":
      return `A concern was resolved${on}`;
    case "changeset.proposed":
      return "An agent submitted a code change";
    case "changeset.accepted":
      return "A code change was accepted";
    case "changeset.rejected":
      return `A code change was rejected${reason}`;
    case "candidate.forked":
      return "A new version was started";
    case "candidate.composed":
      return "A version was assembled from the code changes";
    case "candidate.stale":
      return `A version is out of date: another change shipped first${reason ? ` (${s("reason")})` : ""}`;
    case "verification.started":
      return "Checks started";
    case "verification.check.completed": {
      const word = CHECK_WORDS[s("status") ?? ""] ?? "finished";
      const name = s("checkId") ? `Check "${s("checkId")}"` : "A check";
      return `${name} ${word}${s("summary") ? `. ${s("summary")}` : ""}`;
    }
    case "verification.completed":
      if (s("status") === "verified") return "A version passed its checks";
      if (s("status") === "rejected") return `A version was set aside${reason}`;
      return "Checks finished";
    case "preview.ready":
      return "Preview ready";
    case "approval.requested":
      return "Approval requested: a person must approve before it ships";
    case "approval.granted":
      return "Approved";
    case "approval.rejected":
      return `Approval rejected${reason}`;
    case "canonical.promotion.requested":
      return "Shipping requested";
    case "canonical.advanced":
      return `${releaseName} shipped`;
    case "artifact.promoted":
      return "Live code updated";
    case "build.started":
      return `Building ${releaseName}`;
    case "build.completed":
      return s("status") && s("status") !== "success" && s("status") !== "succeeded"
        ? `${releaseName} build ${s("status")}`
        : `${releaseName} built`;
    case "deployment.started":
      return `Deploying ${releaseName}`;
    case "deployment.completed":
      return `${releaseName} deployed`;
    case "deployment.failed":
      return `${releaseName} did not deploy${reason}`;
    case "release.smoke_failed":
      return `${releaseName} failed its smoke check${reason}`;
    case "test.failed":
      return `A test failed${reason}`;
    case "security.check.failed":
      return `A security check failed${reason}`;
    case "performance.check.failed":
      return `A performance check failed${reason}`;
    case "agent.woken":
      return "An agent started";
    case "agent.slept":
      return "An agent went idle";
    case "agent.escalated":
      return `Retried with a stronger model${reason}`;
    case "model.route.decided":
      return "A model was chosen automatically";
    default:
      return `${sentenceFromType(event.eventType)}${reason}`;
  }
}

/** Local `14:03` for a minute group, with the day when it is not today. */
function minuteLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** Consecutive events (newest first) grouped by their local minute. */
function byMinute(events: FeedEvent[]) {
  const groups: { label: string; at: string; events: FeedEvent[] }[] = [];
  for (const event of events) {
    const label = minuteLabel(event.occurredAt);
    const last = groups.at(-1);
    if (last && last.label === label) last.events.push(event);
    else groups.push({ label, at: event.occurredAt, events: [event] });
  }
  return groups;
}

export function ActivityFeed({
  events,
  loading,
  error,
  onRetry,
}: {
  /** Newest first. */
  events: FeedEvent[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const technical = useViewMode() === "systems";
  const shown = technical ? events : events.filter((e) => !NOISE.has(e.eventType));
  const groups = byMinute(shown);

  return (
    <div className="grid min-w-0 gap-4">
      {error && (
        <SectionError
          message={`Activity could not load. ${error}`}
          {...(onRetry ? { onRetry } : {})}
        />
      )}
      {loading && events.length === 0 ? (
        <div className="grid gap-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBar key={i} height={14} className="w-2/3" />
          ))}
        </div>
      ) : !error && shown.length === 0 ? (
        <EmptyState
          what="Nothing has happened yet."
          how="Start a change on the Overview; each step appears here as it happens."
        />
      ) : (
        <div aria-live="polite" aria-relevant="additions" className="grid gap-5">
          {groups.map((group) => (
            <section key={`${group.label}-${group.at}`} aria-label={group.label}>
              <h3 className="pb-1.5 text-[12px] font-medium text-kumo-subtle tabular-nums">
                <time dateTime={group.at}>{group.label}</time>
              </h3>
              <ol className="grid rounded-lg border border-kumo-rule bg-kumo-elevated">
                {group.events.map((event) => (
                  <ActivityRow key={event.seq} event={event} technical={technical} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
ActivityFeed.displayName = "ActivityFeed";

function ActivityRow({ event, technical }: { event: FeedEvent; technical: boolean }) {
  const tone = TONE_ICON[typeTone(event)];
  const IconComponent = tone.icon;
  return (
    <li
      className={cn(
        "grid gap-1 border-b border-kumo-rule px-3 py-2.5 last:border-b-0",
        // New rows fade in once (150ms); nothing moves.
        "transition-opacity duration-(--rh-dur-ui) starting:opacity-0",
      )}
    >
      <div className="flex items-start gap-2.5">
        <IconComponent size={16} aria-hidden className={cn("mt-0.5 shrink-0", tone.className)} />
        <p className="min-w-0 flex-1 text-[14px] break-words">{plainSummary(event)}</p>
        {event.changeId && (
          <Link
            to="/changes/$changeId"
            params={{ changeId: event.changeId }}
            className="shrink-0 text-[13px] text-kumo-link hover:underline"
          >
            Open change
          </Link>
        )}
      </div>
      {technical && (
        <details className="pl-[26px] text-[12px] text-kumo-subtle">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <dt>Type</dt>
            <dd className="font-mono break-all">{event.eventType}</dd>
            <dt>Event ID</dt>
            <dd className="font-mono break-all">{event.eventId}</dd>
            <dt>Recorded as</dt>
            <dd className="break-words">{event.summary}</dd>
          </dl>
        </details>
      )}
    </li>
  );
}
ActivityRow.displayName = "ActivityRow";
