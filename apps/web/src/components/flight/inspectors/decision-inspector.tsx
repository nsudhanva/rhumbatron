import { Button, Collapsible, cn } from "@cloudflare/kumo";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { JsonValue } from "../../../lib/api";
import { formatNumber, formatUsd, generation } from "../../../lib/format";
import type { ActivityEvent } from "../../agents/activity-model";
import { EmptyState } from "../../ui/empty-state";
import { KeyValue, type KeyValueItem } from "../../ui/key-value";
import { Payload } from "../../ui/log-well";
import { Mono } from "../../ui/mono";
import { Section } from "../../ui/page";
import { StatusPill } from "../../ui/status-pill";
import { Tag } from "../../ui/tag";
import { useFlight } from "../flight-context";
import {
  type CandidateState,
  currentRef,
  type DecisionState,
  entityLabel,
  type FlightState,
  providerName,
} from "../flight-model";
import { type EntityRef, useFlightStore } from "../flight-store";
import { RefButton } from "../panels/arena/ref-button";
import { ByTag, CausalTrace, clockOf, KindTag } from "../panels/decisions/decision-view";

/**
 * Decision and Event inspectors. Read the folded state only (`useFlight()`): the decision's
 * recorded causes, its Decision Receipt or typed record, and the records that followed it
 * (the attempt outcome, the checks, the generations). Nothing is inferred: a receipt the API did
 * not record is named as missing, and route probabilities are shown as recorded routing inputs,
 * never as a release signal.
 */

type Json = { [key: string]: JsonValue };

const isObject = (v: JsonValue | undefined): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asStrings = (v: JsonValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const short = (sha: unknown) => (typeof sha === "string" && sha ? sha.slice(0, 12) : null);
const text = (v: JsonValue) => (typeof v === "string" ? v : JSON.stringify(v));

function subjectButton(state: FlightState, ref: EntityRef) {
  const label = entityLabel(state, ref);
  return (
    <RefButton entity={ref} mode="select" className="px-1 text-[12px]">
      <span className="text-kumo-subtle">{label.kicker}</span> · {label.title}
    </RefButton>
  );
}

/** Horizontal bar list: label · bar · value, every bar with its number. */
function Probabilities({ values }: { values: Json }) {
  const rows = (["haiku", "sonnet", "opus"] as const)
    .map((tier) => ({ tier, value: values[tier] }))
    .filter((r): r is { tier: "haiku" | "sonnet" | "opus"; value: number } => {
      return typeof r.value === "number";
    });
  const extra = Object.entries(values).filter(
    ([k, v]) => !["haiku", "sonnet", "opus"].includes(k) && typeof v === "number",
  ) as [string, number][];
  const all = [...rows.map((r) => [r.tier, r.value] as [string, number]), ...extra];
  if (all.length === 0) return null;
  return (
    <figure className="grid gap-1.5">
      <ul className="grid gap-1">
        {all.map(([tier, value]) => (
          <li key={tier} className="grid grid-cols-[64px_minmax(0,1fr)_48px] items-center gap-2">
            <span className="font-mono text-[12px]">{tier}</span>
            <span className="h-2 bg-kumo-recessed">
              <span
                className="block h-full bg-kumo-ink"
                style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
              />
            </span>
            <span className="text-right font-mono text-[12px] tabular-nums">
              {formatNumber(value, 2)}
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="text-[11px] text-kumo-subtle">
        Route probabilities as recorded in the Decision Receipt. They choose a model tier; they are
        not a confidence score and never gate a release.
      </figcaption>
    </figure>
  );
}
Probabilities.displayName = "Probabilities";

function RouteDetails({ decision, state }: { decision: DecisionState; state: FlightState }) {
  const cut = decision.id.lastIndexOf(":");
  const taskId = decision.id.slice("route:".length, cut);
  const attempt = Number(decision.id.slice(cut + 1));
  const task = state.tasks[taskId];
  const run = task?.runs.find((r) => r.attempt === attempt) ?? null;
  const receipt = decision.receipt;
  const probabilities = receipt?.probabilities;
  const signals = receipt?.signals;
  const escalateOn = asStrings(receipt?.escalateOn);
  const reasons =
    run && run.routeReasons.length > 0 ? run.routeReasons : asStrings(receipt?.reasons);
  const provider = typeof receipt?.provider === "string" ? receipt.provider : null;
  const model = typeof receipt?.selectedModel === "string" ? receipt.selectedModel : null;

  return (
    <>
      <Section as="h3" label="Route">
        <KeyValue
          items={[
            {
              label: "Tier",
              value: run ? (
                <span className="font-mono text-[12px]">
                  {run.tier}
                  {run.escalatedFrom ? ` · escalated from ${run.escalatedFrom}` : ""}
                </span>
              ) : null,
            },
            ...(provider ? [{ label: "Provider", value: providerName(provider) }] : []),
            ...(model ? [{ label: "Model", value: model, mono: true }] : []),
            {
              label: "Reasons",
              value:
                reasons.length > 0 ? (
                  <ul className="grid gap-0.5">
                    {reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-kumo-subtle">No route reason recorded</span>
                ),
            },
          ]}
        />
        {!receipt && (
          <p className="text-[12px] text-kumo-subtle">
            No Decision Receipt recorded for this attempt (route reasons from the run record only).
          </p>
        )}
        {isObject(probabilities) && <Probabilities values={probabilities} />}
        {isObject(signals) && Object.keys(signals).length > 0 && (
          <div className="grid gap-1.5">
            <p className="type-label text-kumo-subtle">Signals</p>
            <KeyValue
              items={Object.entries(signals).map(([k, v]) => ({
                label: k,
                value: text(v),
                mono: true,
              }))}
            />
          </div>
        )}
        {escalateOn.length > 0 && (
          <div className="grid gap-1.5">
            <p className="type-label text-kumo-subtle">Escalate on</p>
            <div className="flex flex-wrap gap-1">
              {escalateOn.map((e) => (
                <Tag key={e}>{e.replace(/_/g, " ")}</Tag>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section as="h3" label={`Attempt ${Number.isFinite(attempt) ? attempt : ""} outcome`}>
        {!run ? (
          <p className="text-[12px] text-kumo-subtle">
            The attempt is not in the fold at this instant.
          </p>
        ) : (
          <KeyValue
            items={[
              { label: "Status", value: <StatusPill status={run.status} /> },
              {
                label: "Model calls",
                value:
                  run.status === "running" && !state.live
                    ? "Not recorded at this instant"
                    : formatNumber(run.modelCalls),
                mono: true,
              },
              {
                label: "Tokens",
                value:
                  run.status === "running" && !state.live
                    ? null
                    : `${formatNumber(run.inputTokens)} in · ${formatNumber(run.outputTokens)} out`,
                mono: true,
              },
              {
                label: "Cost",
                value: run.status === "running" && !state.live ? null : formatUsd(run.costUsd),
                mono: true,
              },
              { label: "Started", value: clockOf(run.startedAt), mono: true },
              { label: "Ended", value: run.endedAt ? clockOf(run.endedAt) : null, mono: true },
              ...(run.status === "failed"
                ? [
                    {
                      label: "Failure",
                      value: (
                        <span className="text-kumo-danger">
                          {run.failureKind ? `${run.failureKind.replace(/_/g, " ")}: ` : ""}
                          {run.failureReason ?? "The failure reason is not recorded."}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Section>
    </>
  );
}
RouteDetails.displayName = "RouteDetails";

function GateDetails({ candidate, receipt }: { candidate: CandidateState; receipt: Json | null }) {
  const required = candidate.checks.filter((c) => c.required);
  const supported = required.filter(
    (c) => c.status === "pass" && c.coverage === "checked_supported",
  ).length;
  const gate = isObject(receipt?.gate) ? receipt.gate : null;
  const gaps = Array.isArray(gate?.gaps) ? gate.gaps.filter(isObject) : [];
  return (
    <Section
      as="h3"
      label="Checks"
      meta={`${formatNumber(supported)} / ${formatNumber(required.length)} required supported`}
    >
      <ul className="grid">
        {candidate.checks.map((c) => (
          <li
            key={c.checkId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-kumo-rule py-1 last:border-b-0"
          >
            <RefButton
              entity={{ kind: "check", id: `${candidate.id}:${c.checkId}` }}
              mode="select"
              className="min-w-0 truncate px-1 font-mono text-[12px]"
            >
              {c.checkId}
              <span className="ml-2 font-sans text-[11px] text-kumo-subtle">
                {c.required ? "required" : "optional"}
              </span>
            </RefButton>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-kumo-subtle">
                {c.coverage ? c.coverage.replace(/_/g, " ") : "no Evidence"}
              </span>
              <StatusPill status={c.coverage === "not_checked" ? "not_checked" : c.status} />
            </span>
          </li>
        ))}
      </ul>
      {gaps.length > 0 && (
        <div className="grid gap-1">
          <p className="type-label text-kumo-subtle">Gaps named by the gate</p>
          <ul className="grid gap-0.5 text-[12px]">
            {gaps.map((g) => (
              <li key={text(g.checkId ?? "")}>
                <Mono>{text(g.checkId ?? "")}</Mono>{" "}
                <span className="text-kumo-subtle">{text(g.reason ?? "")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
GateDetails.displayName = "GateDetails";

function recordItems(decision: DecisionState): KeyValueItem[] {
  const r = decision.receipt;
  if (!r) return [];
  switch (decision.kind) {
    case "fork": {
      const review = isObject(r.review) ? r.review : null;
      const fork = isObject(r.forkDecision) ? r.forkDecision : null;
      return [
        {
          label: "State",
          value: typeof r.state === "string" ? <StatusPill status={r.state} /> : null,
        },
        {
          label: "Recommended",
          value:
            typeof r.recommendedAction === "string" ? r.recommendedAction.replace(/_/g, " ") : null,
        },
        {
          label: "Reviewed by",
          value: typeof review?.decidedBy === "string" ? review.decidedBy : null,
          mono: true,
        },
        {
          label: "Rationale",
          value: typeof review?.rationale === "string" ? review.rationale : null,
        },
        {
          label: "Fork decision",
          value: typeof fork?.kind === "string" ? fork.kind : null,
          mono: true,
        },
      ];
    }
    case "approval":
      return [
        {
          label: "Decision",
          value: typeof r.decision === "string" ? <StatusPill status={r.decision} /> : null,
        },
        {
          label: "Approver",
          value: typeof r.approverUserId === "string" ? r.approverUserId : null,
          mono: true,
        },
        {
          label: "Policy",
          value: typeof r.policyVersion === "string" ? r.policyVersion : null,
          mono: true,
        },
        { label: "Bound to tree", value: short(r.candidateTree), mono: true },
        { label: "Reason", value: typeof r.reason === "string" ? r.reason : null },
      ];
    case "promotion": {
      const base = typeof r.baseGeneration === "number" ? r.baseGeneration : null;
      const promoted = typeof r.promotedGeneration === "number" ? r.promotedGeneration : null;
      return [
        {
          label: "Generation",
          value:
            base !== null && promoted !== null
              ? `${generation(base)} → ${generation(promoted)}`
              : null,
          mono: true,
        },
        { label: "Base tree", value: short(r.baseTree), mono: true },
        { label: "Promoted tree", value: short(r.composedTree), mono: true },
      ];
    }
    default:
      return [];
  }
}

export function DecisionInspector({ entity }: { entity: EntityRef }) {
  const { state } = useFlight();
  const decision = state.decisions.find((d) => d.id === entity.id);
  if (!decision) {
    return (
      <EmptyState
        what="This decision is not recorded at this instant."
        how="Move the time machine forward or select another decision."
      />
    );
  }
  const candidate =
    decision.subject.kind === "candidate" ? state.candidates[decision.subject.id] : undefined;
  const items = recordItems(decision);
  return (
    <div className="grid gap-5 text-[13px]">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindTag kind={decision.kind} />
          <ByTag by={decision.by} />
          <Mono subtle>{clockOf(decision.at)}</Mono>
        </div>
        <p className="text-pretty">{decision.verdict}</p>
        <KeyValue items={[{ label: "Subject", value: subjectButton(state, decision.subject) }]} />
      </div>

      <Section
        as="h3"
        label="Causal history"
        meta={`${formatNumber(decision.causes.length)} recorded cause${decision.causes.length === 1 ? "" : "s"}`}
      >
        <CausalTrace decision={decision} roomy />
      </Section>

      {decision.kind === "route" && <RouteDetails decision={decision} state={state} />}
      {decision.kind === "gate" && candidate && (
        <GateDetails candidate={candidate} receipt={decision.receipt} />
      )}
      {items.length > 0 && (
        <Section as="h3" label="Record">
          <KeyValue items={items} />
        </Section>
      )}

      {decision.receipt && (
        <Collapsible.Root>
          <Collapsible.DefaultTrigger>Raw receipt</Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <Payload
              value={decision.receipt}
              caption={
                decision.kind === "route"
                  ? "Decision Receipt as stored. Model reasoning is not recorded."
                  : "Typed decision record from the API records. Model reasoning is not recorded."
              }
            />
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      )}
    </div>
  );
}
DecisionInspector.displayName = "DecisionInspector";

/** The typed fields of a fact beyond the shared ones, as recorded. */
function typedFields(event: ActivityEvent): Record<string, unknown> {
  const {
    id: _id,
    at: _at,
    type: _type,
    actor: _actor,
    detail: _detail,
    kind: _kind,
    ...rest
  } = event as ActivityEvent & Record<string, unknown>;
  return rest;
}

function StepButton({ event, label }: { event: ActivityEvent | null; label: string }) {
  if (!event) {
    return (
      <span className="text-[12px] text-kumo-subtle">
        {label}: <span className="font-mono">{"—"}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        const store = useFlightStore.getState();
        // Stepping past the fold instant moves the time machine with the selection.
        if (store.time.mode === "historical" && event.at > store.time.at) store.scrubTo(event.at);
        store.select({ kind: "event", id: event.id });
      }}
      className="grid min-h-6 w-full min-w-0 cursor-pointer grid-cols-[72px_56px_minmax(0,1fr)] items-baseline gap-x-2 py-1 text-left hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-500 pointer-coarse:min-h-11"
    >
      <span className="text-[11px] tracking-[0.08em] text-kumo-subtle uppercase">{label}</span>
      <Mono subtle>{clockOf(event.at)}</Mono>
      <span className="min-w-0 truncate text-[12px]" title={event.detail}>
        <span className="mr-1.5 font-mono text-[11px]">{event.type}</span>
        {event.detail}
      </span>
    </button>
  );
}
StepButton.displayName = "StepButton";

export function EventInspector({ entity }: { entity: EntityRef }) {
  const { state, model } = useFlight();
  const index = model.events.findIndex((e) => e.id === entity.id);
  const event = index >= 0 ? model.events[index] : undefined;
  if (!event) {
    return (
      <EmptyState
        what="This event is not recorded for this Change."
        how="Select another event in the stream."
      />
    );
  }
  const inFold = state.events.some((e) => e.id === event.id);
  const about = currentRef(event);
  const aboutEntity = about && about.kind !== "event" ? about : null;
  const previous = index > 0 ? (model.events[index - 1] ?? null) : null;
  const next = index < model.events.length - 1 ? (model.events[index + 1] ?? null) : null;
  const fields = typedFields(event);
  const payload: unknown = event.kind === "fact" ? event.data : fields;

  const scrub = () => useFlightStore.getState().scrubTo(event.at);
  const items: KeyValueItem[] = [
    { label: "Type", value: event.type, mono: true },
    { label: "Kind", value: event.kind, mono: true },
    {
      label: "Recorded",
      value: `${clockOf(event.at)} · ${new Date(event.at).toISOString().slice(0, 10)}`,
      mono: true,
    },
    { label: "Actor", value: event.actor, mono: true },
    {
      label: "Sequence",
      value: `${formatNumber(index + 1)} of ${formatNumber(model.events.length)}`,
      mono: true,
    },
    ...(aboutEntity ? [{ label: "About", value: subjectButton(state, aboutEntity) }] : []),
  ];
  return (
    <div className="grid gap-5 text-[13px]">
      <div className="grid gap-2">
        {!inFold && (
          <p className="border-l-2 border-kumo-warning bg-kumo-warning-tint px-3 py-1.5 text-[12px]">
            Recorded after the time-machine instant. Jump to its time to fold it in.
          </p>
        )}
        <KeyValue items={items} />
        <div>
          <Button size="sm" icon={<ClockCounterClockwise size={14} aria-hidden />} onClick={scrub}>
            Jump to time
          </Button>
        </div>
      </div>

      <Section as="h3" label="Step through time">
        <div className={cn("grid border-y border-kumo-rule")}>
          <StepButton event={previous} label="Previous" />
          <div className="border-t border-kumo-rule" />
          <StepButton event={next} label="Next" />
        </div>
      </Section>

      {(event.kind === "fact" || Object.keys(fields).length > 0) && (
        <Section as="h3" label={event.kind === "fact" ? "Recorded data" : "Recorded fields"}>
          <Payload
            value={payload}
            caption={
              event.kind === "fact"
                ? "Event payload as stored in the Change's event feed."
                : "Typed fields of this fact, derived from the API record it came from."
            }
          />
        </Section>
      )}
    </div>
  );
}
EventInspector.displayName = "EventInspector";
