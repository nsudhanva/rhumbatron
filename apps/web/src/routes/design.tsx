import {
  Badge,
  Button,
  Checkbox,
  cn,
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
import { Banner } from "../components/candidate/banner";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Loader } from "../components/ui/loader";
import { LogWell, Payload } from "../components/ui/log-well";
import { SegmentedSteps, ThresholdMeter } from "../components/ui/meter";
import { Mono, Num } from "../components/ui/mono";
import { Page, PageTitle, Section, SectionLabel, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import {
  FAMILY_TEXT,
  type StatusFamily,
  StatusIcon,
  StatusPill,
  statusView,
} from "../components/ui/status-pill";
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
 * Design reference: every shared primitive and the themed Kumo components on one page, in the
 * current mode. Not linked from the navigation. Check it in both modes and at
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

/** Statuses grouped by family, to check every icon, word and tint in both modes. */
const STATUS_GROUPS: { family: StatusFamily; label: string; statuses: string[] }[] = [
  {
    family: "ok",
    label: "Done",
    statuses: ["completed", "verified", "promoted", "deployed", "approved", "live"],
  },
  {
    family: "active",
    label: "In progress",
    statuses: ["compiling", "running", "assigned", "composing", "verifying", "releasing"],
  },
  {
    family: "attention",
    label: "Needs you or missing",
    statuses: [
      "awaiting_approval",
      "waiting",
      "budget_blocked",
      "not_checked",
      "stale",
      "confirmed",
    ],
  },
  {
    family: "danger",
    label: "Failed or lost",
    statuses: ["failed", "error", "rejected", "blocked", "timed_out", "smoke_failed"],
  },
  {
    family: "idle",
    label: "Not started or resting",
    statuses: ["queued", "ready", "skipped", "cancelled", "checked_no_signal", "sleeping"],
  },
];

const TYPE_SCALE = [
  { className: "type-display", spec: "28/36 600", sample: "Release 1842" },
  { className: "type-h1", spec: "24/32 600", sample: "Acme Shop" },
  { className: "type-h2", spec: "20/28 600", sample: "Add shared wishlists" },
  { className: "type-h3", spec: "16/24 600", sample: "Done when" },
  { className: "type-h4", spec: "15/22 600", sample: "Agents working" },
  { className: "type-h5", spec: "14/20 600", sample: "Table header" },
  { className: "type-body", spec: "15/24 400", sample: "Users can share a wishlist with a link." },
  { className: "type-ui", spec: "14/20 400", sample: "All UI text" },
  { className: "type-ui-sm", spec: "13/18 400", sample: "Dense tables only" },
  { className: "type-label", spec: "12/16 500", sample: "Field label" },
  { className: "type-meta", spec: "12/16 400", sample: "Started 14 min ago" },
  { className: "type-mono", spec: "13/20 mono", sample: "project:acme:wishlist" },
  { className: "type-mono-log", spec: "12.5/20 mono", sample: "PASS cart.test.ts" },
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
        kicker="Developer reference, not in the navigation"
        title="Design reference"
        meta={
          <>
            <Mono>docs/ux/research-2026-10-09.md</Mono>
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

      <StatStrip>
        <StatCell label="Live release" value="Release 1841" footnote="S1841 · tree 3f9c2a1b7d" />
        <StatCell label="Active changes" value={formatNumber(3)} footnote="2 waiting" />
        <StatCell
          label="Response time (p95)"
          value={formatNumber(164)}
          unit="ms"
          pill={<StatusPill status="pass" />}
        >
          <ThresholdMeter
            label="Limit"
            value={164}
            max={300}
            threshold={200}
            size="inline"
            format={(n) => formatUnit(n, "ms")}
          />
        </StatCell>
        <StatCell label="Change cost" value={formatUsd(1.42)} footnote="of $3.00 budget" />
      </StatStrip>

      <Section
        label="Status: icon + word + color"
        meta={<span>Pass `label` when the context needs another word</span>}
      >
        <div className="grid gap-3">
          {STATUS_GROUPS.map((group) => (
            <div
              key={group.family}
              className="grid items-center gap-x-4 gap-y-2 sm:grid-cols-[200px_minmax(0,1fr)]"
            >
              <p className="flex items-center gap-2">
                <StatusIcon family={group.family} />
                <span className="font-semibold">{group.label}</span>
                <Mono subtle>{group.family}</Mono>
              </p>
              <div className="flex flex-wrap gap-2">
                {group.statuses.map((status) => (
                  <StatusPill key={status} status={status} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status="rejected" label="Rejected" />
            <StatusPill status="custom" label="Over budget" family="danger" />
            <span className="flex items-center gap-2 type-h3">
              <StatusIcon status="awaiting_approval" size={20} /> Needs your approval
            </span>
          </div>
        </div>
      </Section>

      <Section label="Banners">
        <div className="grid gap-3">
          <Banner family="success" title="Shipped as Release 1842">
            Version B passed every required check.
          </Banner>
          <Banner
            family="attention"
            title="Needs your approval"
            action={<Button size="sm">Review and approve</Button>}
          >
            A person must approve high-risk changes before they ship.
          </Banner>
          <Banner family="danger" title="Set aside: response time 312 ms, limit 200 ms" />
          <Banner family="progress" title="Running 7 checks on Version B" progress={0.4}>
            3 of 7 checks finished.
          </Banner>
        </div>
      </Section>

      <TwoUp>
        <Section label="Type scale">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
            {TYPE_SCALE.map((row) => (
              <div key={row.className} className="contents">
                <dt className="type-meta text-kumo-subtle">
                  <Mono subtle>{row.className}</Mono> {row.spec}
                </dt>
                <dd className={cn("min-w-0 truncate", row.className)}>{row.sample}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section label="Tags, mono and numbers">
          <div className="flex flex-wrap gap-2">
            <Tag variant="accent">New</Tag>
            <Tag>Wishlist</Tag>
            <Tag variant="outline">High risk</Tag>
          </div>
          <KeyValue
            items={[
              { label: "Version", value: "cand_7f3a9c2e1b", mono: true },
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
          <p>
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
          Section label with a link
        </SectionLabel>
        <p className="type-body max-w-[720px]">
          A section label is a 16px heading over a 1px rule. Use the right slot for a count, a short
          meta value or one link.
        </p>
      </div>

      <Section label="Table" meta={<span>1–3 of 3</span>}>
        <DataTable label="Versions" minWidth={640}>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Status</Th>
              <Th numeric>Code changes</Th>
              <Th numeric>p95</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {[
              { id: "cand_a", name: "Version A", status: "rejected", p95: 312.4 },
              { id: "cand_b", name: "Version B", status: "verified", p95: 164.2 },
              { id: "cand_c", name: "Version C", status: "verifying", p95: null },
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
            label="Version A p95"
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
            label="Checks"
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
            what="No versions yet."
            how="A version appears when the agents finish their tasks."
            action={<Button size="sm">Run checks</Button>}
          />
          <p className="flex items-center gap-2">
            <Loader /> Planning
          </p>
          <div className="flex flex-wrap gap-2">
            <Button loading>Saving</Button>
            <Button variant="primary" loading>
              Shipping
            </Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="grid gap-2">
            <div className="skeleton-line h-4 w-2/3 rounded-sm" />
            <div className="skeleton-line h-4 w-1/2 rounded-sm" />
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
              { text: "WARN wishlist p95 close to the limit: 188 ms", role: "warn" },
              { text: "FAIL membership.concurrent.test.ts: 3 of 200 writes lost", role: "fail" },
            ]}
          />
        </Section>
        <Section label="Payload">
          <div className="rounded-lg border border-kumo-rule bg-kumo-elevated p-3">
            <Payload
              value={{
                decisionType: "MODEL_ROUTE",
                taskId: "task_wishlist_api",
                selectedModel: "sonnet",
                signals: { complexity: "medium", riskTier: "medium", attempt: 1 },
              }}
              caption="Model choice as stored. Model reasoning is never recorded."
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
            <Switch label="Ship low-risk changes automatically" defaultChecked />
          </div>
          <Radio.Group legend="Rollout" defaultValue="preview" orientation="horizontal">
            <Radio.Item label="Preview" value="preview" />
            <Radio.Item label="Production" value="production" />
          </Radio.Group>
          <Tabs
            variant="underline"
            tabs={[
              { value: "progress", label: "Progress" },
              { value: "files", label: "Files changed" },
              { value: "checks", label: "Checks" },
            ]}
            selectedValue="progress"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Kumo badge</Badge>
            <Badge variant="info">Info is in progress</Badge>
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
        <Section label="Motion">
          <MotionSample />
        </Section>
      </TwoUp>
    </Page>
  );
}

/**
 * The motion that remains: the spinner (the only loop) and a 300ms progress bar. Hover and
 * overlays use 120-180ms. Reduced motion stops the spinner and makes the bar jump.
 */
function MotionSample() {
  const [share, setShare] = useState(0.3);
  const reduce = usePrefersReducedMotion();
  return (
    <div className="grid gap-3">
      <p className="flex items-center gap-3">
        <Loader size={16} /> <Loader size={20} /> <StatusPill status="running" />
      </p>
      <div aria-hidden className="h-1 rounded-full bg-kumo-recessed">
        <div
          className="h-full rounded-full bg-kumo-brand transition-[width] duration-(--rh-dur-bar)"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setShare((v) => (v >= 1 ? 0.1 : Math.min(1, v + 0.3)))}>
          Advance bar
        </Button>
        <span className="type-meta font-mono text-kumo-subtle">
          ui {MOTION.uiMs} ms · overlay {MOTION.overlayInMs} ms · bar {MOTION.barMs} ms
          {reduce ? " · reduced motion" : ""}
        </span>
      </div>
    </div>
  );
}
