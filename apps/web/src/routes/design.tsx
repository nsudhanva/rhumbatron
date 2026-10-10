import {
  Badge,
  Button,
  Checkbox,
  Input,
  Meter,
  Radio,
  Switch,
  Tabs,
  Tooltip,
} from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentActivityPreview } from "../components/agents/agent-activity";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Loader } from "../components/ui/loader";
import { LogWell, Payload } from "../components/ui/log-well";
import { SegmentedSteps, ThresholdMeter } from "../components/ui/meter";
import { Mono, Num } from "../components/ui/mono";
import { Page, PageTitle, Section, SectionLabel, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { FAMILY_TEXT, StatusPill, statusView } from "../components/ui/status-pill";
import { Tag } from "../components/ui/tag";
import {
  EMPTY,
  formatAge,
  formatClock,
  formatDelta,
  formatDuration,
  formatFraction,
  formatMs,
  formatNumber,
  formatUnit,
  formatUsd,
} from "../lib/format";
import { MOTION, usePrefersReducedMotion } from "../lib/motion";

/**
 * Design reference: every shared primitive and the Modernist-themed Kumo components on one
 * page, in the current mode. Not linked from the navigation. Check it in both modes and at
 * 720 / 1024 / 1280 / 1600px after any change to theme.css or components/ui.
 */
export const Route = createFileRoute("/design")({
  head: () => ({
    meta: [
      { title: "Design reference · Rhumbatron" },
      {
        name: "description",
        content: "Rhumbatron design reference: tokens, primitives and Kumo components.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DesignReference,
});

const STATUSES = [
  "completed",
  "verified",
  "promoted",
  "pass",
  "running",
  "verifying",
  "stale",
  "awaiting_approval",
  "not_checked",
  "failed",
  "rejected",
  "budget_blocked",
  "error",
  "queued",
  "skipped",
  "cancelled",
];

function DesignReference() {
  const [checked, setChecked] = useState(true);
  // Wall-clock examples render after hydration: the server's clock and time zone differ from
  // the browser's, and a mismatch would make React discard the server HTML.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return (
    <Page>
      <PageTitle
        kicker="Kumo x Modernist"
        title="Design reference"
        meta={
          <>
            <Mono>DESIGN.md</Mono>
            <span>·</span>
            <span>tokens, primitives and Kumo components in the current mode</span>
          </>
        }
        actions={
          <>
            <Button>Secondary</Button>
            <Button variant="primary" icon={Plus}>
              Primary action
            </Button>
          </>
        }
      />

      <Section label="Agent activity" meta="fixture replay of the Wishlist story (DESIGN §11.1)">
        <AgentActivityPreview />
      </Section>

      <StatStrip>
        <StatCell label="Canonical generation" value="S1841" mono footnote="tree 3f9c2a1b7d" />
        <StatCell label="Active changes" value={formatNumber(3)} footnote="2 waiting" />
        <StatCell
          label="Wishlist p95"
          value={formatNumber(164)}
          unit="ms"
          pill={<StatusPill status="pass" />}
        >
          <ThresholdMeter
            label="threshold"
            value={164}
            max={300}
            threshold={200}
            size="inline"
            format={(n) => formatUnit(n, "ms")}
          />
        </StatCell>
        <StatCell label="Change cost" value={formatUsd(1.42)} footnote="of $3.00 budget" />
      </StatStrip>

      <TwoUp>
        <Section label="Status pills" meta={<Mono subtle>{STATUSES.length}</Mono>}>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((status) => (
              <StatusPill key={status} status={status} />
            ))}
          </div>
          <KeyValue
            items={STATUSES.slice(0, 6).map((status) => ({
              label: status,
              value: `${statusView(status).family} · ${statusView(status).label}`,
              mono: true,
            }))}
          />
        </Section>

        <Section label="Tags, mono and numbers">
          <div className="flex flex-wrap gap-2">
            <Tag variant="accent">New</Tag>
            <Tag>Wishlist</Tag>
            <Tag variant="outline">Risk high</Tag>
          </div>
          <KeyValue
            items={[
              { label: "Candidate", value: "cand_7f3a9c2e1b", mono: true },
              { label: "Thousands", value: formatNumber(7200) },
              { label: "Latency", value: formatMs(164) },
              { label: "Duration", value: formatDuration(192) },
              { label: "Delta", value: formatDelta(-12, "ms") },
              { label: "Budget", value: formatFraction(formatUsd(1.42), formatUsd(3)) },
              {
                label: "Age",
                value: now === null ? null : formatAge(new Date(now - 7 * 60_000).toISOString()),
              },
              {
                label: "Clock",
                value: now === null ? null : formatClock(new Date(now).toISOString()),
                mono: true,
              },
              { label: "Unknown", value: null },
            ]}
          />
          <p className="text-[13px]">
            Inline machine values: <Mono>project:acme:wishlist:membership</Mono> ·{" "}
            <Num value={412} unit="MB" /> · <Num>{formatUsd(-0.4)}</Num> · {EMPTY}
          </p>
        </Section>
      </TwoUp>

      <div className="grid gap-3">
        <SectionLabel
          meta={
            <Link to="/" className="font-semibold text-kumo-link hover:underline">
              View all
            </Link>
          }
        >
          Section label with a ghost link
        </SectionLabel>
        <p className="type-body max-w-[760px]">
          A section label is an uppercase h6 over a 2px divider. Use the right slot for a count, a
          meta value or one ghost link.
        </p>
      </div>

      <Section label="Table" meta={<span>1–3 of 3</span>}>
        <DataTable label="Candidates" minWidth={640}>
          <thead>
            <tr>
              <Th>Candidate</Th>
              <Th>Status</Th>
              <Th numeric>ChangeSets</Th>
              <Th numeric>p95</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {[
              { id: "cand_a", name: "Normalized membership", status: "rejected", p95: 312.4 },
              { id: "cand_b", name: "Append-only membership", status: "verified", p95: 164.2 },
              { id: "cand_c", name: "Canonical baseline", status: "verifying", p95: null },
            ].map((row) => (
              <TRow key={row.id} selected={row.id === "cand_b"}>
                <Td>
                  <TitleCell title={<RowLink to="/design">{row.name}</RowLink>} meta={row.id} />
                </Td>
                <Td>
                  <StatusPill status={row.status} />
                </Td>
                <Td numeric>{formatNumber(2)}</Td>
                <Td numeric>{formatMs(row.p95, 1)}</Td>
                <Td className={FAMILY_TEXT[statusView(row.status).family]}>
                  <span className="font-semibold">{statusView(row.status).label}</span>
                </Td>
              </TRow>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <TwoUp>
        <Section label="Meters">
          <ThresholdMeter
            label="Wishlist API p95"
            value={164}
            max={300}
            threshold={200}
            alert={180}
            format={(n) => formatUnit(n, "ms")}
          />
          <ThresholdMeter
            label="Candidate A p95"
            value={312}
            max={400}
            threshold={200}
            format={(n) => formatUnit(n, "ms")}
          />
          <ThresholdMeter
            label="Change budget"
            value={1.42}
            max={3}
            size="hero"
            format={formatUsd}
            valueText={formatFraction(formatUsd(1.42), formatUsd(3))}
          />
          <SegmentedSteps
            label="Verification checks"
            steps={[
              { label: "build", status: "pass" },
              { label: "unit", status: "pass" },
              { label: "contract", status: "pass" },
              { label: "browser", status: "running" },
              { label: "performance", status: "not_checked" },
              { label: "security", status: "fail" },
              { label: "smoke", status: "queued" },
            ]}
          />
          <Meter label="Kumo Meter (themed)" value={62} customValue="62 %" />
        </Section>

        <Section label="Empty and loading">
          <EmptyState
            what="No Candidates yet."
            how="Candidates appear when a Change has composable ChangeSets."
            action={<Button size="sm">Compose Candidate</Button>}
          />
          <p className="flex items-center gap-2 text-[13px]">
            <Loader /> Compiling the Work Graph
          </p>
          <div className="flex flex-wrap gap-2">
            <Button loading>Saving</Button>
            <Button variant="primary" loading>
              Promoting
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </Section>
      </TwoUp>

      <TwoUp>
        <Section label="Log well">
          <LogWell
            title="evidence/acme/chg_12/cand_b/unit/stdout.txt"
            toolbar={
              <>
                <span>Copy</span>
                <span>·</span>
                <span>Download</span>
              </>
            }
            lines={[
              { text: "$ bun test --filter cart", role: "cmd" },
              { text: "cart.add keeps quantity totals", role: "info" },
              { text: "PASS cart.test.ts (14 tests)", role: "pass" },
              { text: "WARN wishlist p95 close to threshold: 188 ms", role: "warn" },
              { text: "FAIL membership.concurrent.test.ts: 3 of 200 writes lost", role: "fail" },
            ]}
          />
        </Section>
        <Section label="Payload">
          <div className="bg-kumo-elevated p-3">
            <Payload
              value={{
                decisionType: "MODEL_ROUTE",
                taskId: "task_wishlist_api",
                selectedModel: "sonnet",
                signals: { complexity: "medium", riskTier: "medium", attempt: 1 },
              }}
              caption="Decision Receipt as stored. Model reasoning is never recorded."
            />
          </div>
        </Section>
      </TwoUp>

      <TwoUp>
        <Section label="Kumo controls">
          <Input label="Goal" placeholder="Add shared wishlists" />
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox
              label="Start from Acme Shop"
              checked={checked}
              onCheckedChange={(v) => setChecked(v === true)}
            />
            <Switch label="Auto-promote low risk" defaultChecked />
          </div>
          <Radio.Group legend="Rollout" defaultValue="preview" orientation="horizontal">
            <Radio.Item label="Preview" value="preview" />
            <Radio.Item label="Production" value="production" />
          </Radio.Group>
          <Tabs
            variant="underline"
            tabs={[
              { value: "evidence", label: "Evidence" },
              { value: "diff", label: "Diff" },
              { value: "trace", label: "Trace" },
            ]}
            selectedValue="evidence"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Kumo badge</Badge>
            <Badge variant="info">Info is active</Badge>
            <Tooltip
              content="Full value: cand_7f3a9c2e1b"
              render={
                <Button variant="ghost" size="sm">
                  Hover for tooltip
                </Button>
              }
            />
          </div>
        </Section>
        <Section label="Agent motion">
          <MotionSample />
        </Section>
      </TwoUp>
    </Page>
  );
}

/** A minimal sample of the agent-activity motion classes; the real view is built elsewhere. */
function MotionSample() {
  const [run, setRun] = useState(0);
  const [rejected, setRejected] = useState(false);
  const reduce = usePrefersReducedMotion();
  return (
    <div className="grid gap-3">
      <div key={run} className="relative h-24 bg-kumo-elevated">
        <svg
          viewBox="0 0 300 96"
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d="M0 24 H300" className="stroke-kumo-ink" strokeWidth={2} fill="none" />
          <path
            d="M40 24 C 80 24, 80 72, 120 72 H300"
            pathLength={1}
            className="rh-fork stroke-kumo-ink"
            strokeWidth={2}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span className="absolute top-1 left-2 font-mono text-[10px] text-kumo-subtle">S1841</span>
        <span
          className="rh-packet"
          style={{ ["--rh-packet-path" as string]: "path('M120 68 L 280 20')" }}
        />
        <span className="rh-arrive absolute right-2 bottom-2 px-1.5 font-mono text-[10px]">
          intent
        </span>
      </div>
      <div
        data-state={rejected ? "rejected" : undefined}
        className="rh-greyout flex items-center justify-between gap-3 border-b border-kumo-rule py-2 text-[13px]"
      >
        <span>Candidate A · normalized membership</span>
        <StatusPill status={rejected ? "rejected" : "verifying"} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setRun((n) => n + 1)}>
          Replay
        </Button>
        <Button size="sm" onClick={() => setRejected((v) => !v)}>
          Toggle reject
        </Button>
        <span className="font-mono text-[11px] text-kumo-subtle">
          fork {MOTION.forkMs} ms · cadence {MOTION.agentCadenceMs} ms
          {reduce ? " · reduced motion" : ""}
        </span>
      </div>
    </div>
  );
}
