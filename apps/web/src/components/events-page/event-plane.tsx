import { useMemo } from "react";
import { formatMs, formatNumber } from "../../lib/format";
import type { LiveStatus } from "../../lib/live";
import { KeyValue } from "../ui/key-value";
import { Section } from "../ui/page";
import { type FeedEvent, ingestLagMs, k2StreamName, percentile } from "./feed-model";

/** Global row cap of the feed projection (`FEED_MAX_ROWS` in workers/event-router/src/feed.ts). */
const FEED_MAX_ROWS = 20_000;

const SOCKET: Record<LiveStatus, string> = {
  open: "open · ProjectViewDO deltas",
  connecting: "connecting",
  closed: "closed · polling",
};

/**
 * Systems View detail of the event plane (AGENTS.md 8.2, 19, 38.7): where this Project's events
 * flow and how far the feed trails the facts. Ingest lag is recorded time minus occurred time:
 * outbox publish delay, K2 delivery and the projector write together. The loaded rows are the
 * sample; nothing here is a release signal.
 */
export function EventPlane({
  projectId,
  events,
  live,
}: {
  projectId: string;
  events: FeedEvent[];
  live: LiveStatus;
}) {
  const lag = useMemo(() => {
    const values = events.map(ingestLagMs).filter((v): v is number => v !== null);
    return {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? Math.max(...values) : null,
    };
  }, [events]);

  return (
    <Section label="Event plane" meta="Systems View">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-x-7 gap-y-3">
        <KeyValue
          items={[
            { label: "K2 stream", value: k2StreamName(projectId), mono: true },
            { label: "Consumer group", value: "project-view-projector", mono: true },
            { label: "Feed table", value: "D1 project_events", mono: true },
            {
              label: "Retention",
              value: `newest ${formatNumber(FEED_MAX_ROWS)} rows, all Projects`,
            },
            { label: "Live socket", value: SOCKET[live], mono: true },
          ]}
        />
        <KeyValue
          items={[
            { label: "Ingest lag p50", value: formatMs(lag.p50), mono: true },
            { label: "Ingest lag p95", value: formatMs(lag.p95), mono: true },
            { label: "Ingest lag max", value: formatMs(lag.max), mono: true },
            { label: "Sample", value: `${formatNumber(lag.count)} loaded events`, mono: true },
          ]}
        />
      </div>
      <p className="max-w-[760px] text-[12px] text-kumo-subtle">
        Ingest lag is the recorded time minus the occurred time: the outbox publish delay, K2
        delivery and the projector write together. The stream shard follows the section 19 hash
        rule.
      </p>
    </Section>
  );
}
EventPlane.displayName = "EventPlane";
