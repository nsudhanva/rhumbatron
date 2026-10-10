import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ProductGraph } from "../../lib/api";
import { truncate } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { KeyValue } from "../ui/key-value";
import { StatusPill } from "../ui/status-pill";
import { Tag } from "../ui/tag";
import { Term } from "../ui/term";
import { type AreaView, describeOrigin, type GraphView, STATE_LABEL, type Zoom } from "./model";

/**
 * Area details beside the product map: repeats the selected area as text in plain words. Rows
 * under 1px rules; machine values (IDs, resource keys) in mono; status through StatusPill.
 */

const STATE_EXPLAIN: Record<AreaView["state"], string> = {
  new: "This change adds it. It is not in the existing code and no earlier change touched it.",
  affected: "This change edits it. It already exists in the code or in an earlier change.",
  protected: "Its behavior must not change. Checks confirm it stays exactly as it is.",
  unchanged: "Not touched. Shown because a changed area depends on it, or it on one.",
};

function Block({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <h4 className="text-[12px] font-semibold text-kumo-subtle">{title}</h4>
      {children}
    </div>
  );
}

export function AreaInspector({
  area,
  view,
  graph,
  zoom,
}: {
  area: AreaView | undefined;
  view: GraphView;
  graph: ProductGraph;
  zoom: Zoom;
}) {
  if (!area) {
    return (
      <EmptyState
        what="No area selected."
        how="Select an area on the map to see its tasks and dependencies."
      />
    );
  }
  const { node } = area;
  const goal = new Map(graph.changes.map((c) => [c.id, c.goal]));
  const outgoing = view.edges.filter((e) => e.edge.source === node.id);
  const incoming = view.edges.filter((e) => e.edge.target === node.id);
  const name = (id: string) => view.areas.find((a) => a.node.id === id)?.node.name ?? id;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] text-kumo-subtle">{node.id}</span>
          <Tag variant={area.state === "new" ? "accent" : "neutral"}>{STATE_LABEL[area.state]}</Tag>
          {area.conflicts.length > 0 && <Tag variant="outline">Conflict</Tag>}
        </div>
        <h3 className="type-h4">{node.name}</h3>
        <p className="text-[13px] text-kumo-subtle">{STATE_EXPLAIN[area.state]}</p>
      </div>

      <KeyValue
        items={[
          { label: "Source file", value: node.baselineFile, mono: true },
          {
            label: "Must not change",
            value: node.protectedResources.length > 0 ? node.protectedResources.join(", ") : null,
            mono: true,
          },
          {
            label: "First touched",
            value: area.firstChangeId
              ? truncate(goal.get(area.firstChangeId) ?? area.firstChangeId, 60)
              : null,
          },
          { label: "Shown for", value: zoom === "change" ? "This change" : "Whole product" },
        ]}
      />

      <Block title={<Term k="area">Parts of this area</Term>}>
        {area.resources.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">None in this scope.</p>
        ) : (
          <ul className="grid">
            {area.resources.map((r) => (
              <li
                key={r}
                className="border-b border-kumo-rule py-1.5 font-mono text-[12px] break-all"
              >
                {r}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Tasks">
        {area.tasks.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No task here touches this area.</p>
        ) : (
          <ul className="grid">
            {area.touches.flatMap((t) =>
              t.tasks.map((task) => (
                <li
                  key={`${t.changeId}:${task.id}`}
                  className="flex items-center gap-2 border-b border-kumo-rule py-1.5 text-[13px]"
                >
                  <span className="shrink-0 font-mono text-[12px] text-kumo-subtle">
                    {task.key}
                  </span>
                  <Link
                    to="/changes/$changeId"
                    params={{ changeId: t.changeId }}
                    className="min-w-0 truncate hover:underline"
                    title={task.title}
                  >
                    {task.title}
                  </Link>
                  <StatusPill status={task.status} className="ml-auto" />
                </li>
              )),
            )}
          </ul>
        )}
      </Block>

      {area.conflicts.length > 0 && (
        <Block title="Conflicts">
          <ul className="grid">
            {area.conflicts.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 border-b border-kumo-rule py-1.5 text-[13px]"
              >
                <span className="min-w-0 truncate font-mono text-[12px]" title={c.resource}>
                  {c.resource}
                </span>
                <StatusPill status={c.state} className="ml-auto" />
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Depends on">
        {outgoing.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No visible dependency.</p>
        ) : (
          <ul className="grid">
            {outgoing.map(({ edge }) => (
              <li key={edge.id} className="grid gap-0.5 border-b border-kumo-rule py-1.5">
                <span className="text-[13px]">
                  <span className="font-semibold">{name(edge.target)}</span>
                  <span className="text-[12px] text-kumo-subtle"> · {edge.label}</span>
                </span>
                {edge.origins.map((o) => (
                  <span key={describeOrigin(o)} className="text-[12px] text-kumo-subtle">
                    {describeOrigin(o)}
                  </span>
                ))}
                {edge.moreOrigins > 0 && (
                  <span className="text-[12px] text-kumo-subtle">and {edge.moreOrigins} more</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Depended on by">
        {incoming.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No visible dependent area.</p>
        ) : (
          <ul className="grid">
            {incoming.map(({ edge }) => (
              <li key={edge.id} className="border-b border-kumo-rule py-1.5 text-[13px]">
                <span className="font-semibold">{name(edge.source)}</span>
                <span className="text-[12px] text-kumo-subtle"> · {edge.label}</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
