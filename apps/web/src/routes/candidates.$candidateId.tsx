import { Show } from "@clerk/tanstack-react-start";
import { Badge, LayerCard, Loader, Text } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CandidateEvidence } from "../components/candidate-evidence";
import { CandidatePromotion } from "../components/candidate-promotion";
import {
  type CandidateDetail,
  getCandidate,
  listCandidateEvidence,
  listCandidates,
} from "../lib/api";
import { generation } from "../lib/format";

export const Route = createFileRoute("/candidates/$candidateId")({ component: CandidatePage });

/** Verification runs for minutes; poll while it is active, then stop (AGENTS.md section 39). */
const POLL_MS = 10_000;
const ACTIVE = new Set<CandidateDetail["status"]>(["composing", "composed", "verifying"]);

const STATUS_VARIANT: Record<
  CandidateDetail["status"],
  "success" | "error" | "warning" | "info" | "secondary"
> = {
  composing: "info",
  composed: "info",
  verifying: "info",
  verified: "success",
  rejected: "error",
  stale: "warning",
  promoted: "success",
};

function CandidatePage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-4 px-6 py-8">
      <Show when="signed-in">
        <CandidateView />
      </Show>
      <Show when="signed-out">
        <Text variant="secondary">Sign in to view this Candidate.</Text>
      </Show>
    </main>
  );
}

function CandidateView() {
  const { candidateId } = Route.useParams();
  const candidate = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => getCandidate({ data: candidateId }),
    refetchInterval: (query) =>
      !query.state.data || ACTIVE.has(query.state.data.status) ? POLL_MS : false,
  });
  const active = !candidate.data || ACTIVE.has(candidate.data.status);
  const evidence = useQuery({
    queryKey: ["candidate-evidence", candidateId],
    queryFn: () => listCandidateEvidence({ data: candidateId }),
    refetchInterval: active ? POLL_MS : false,
  });
  const changeId = candidate.data?.changeId;
  const siblings = useQuery({
    queryKey: ["candidates", changeId],
    queryFn: () => listCandidates({ data: changeId ?? "" }),
    enabled: !!changeId,
    refetchInterval: active ? POLL_MS : false,
  });

  if (candidate.isError) return <Text variant="secondary">{candidate.error.message}</Text>;
  if (!candidate.data) return <Text variant="secondary">Loading Candidate…</Text>;
  const data = candidate.data;

  return (
    <>
      <LayerCard>
        <LayerCard.Primary className="grid gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[data.status]}>{data.status}</Badge>
            <Badge variant="secondary">Base {generation(data.baseGeneration)}</Badge>
            <Badge variant="secondary">
              {data.changeSetIds.length === 0
                ? "Canonical baseline"
                : `${data.changeSetIds.length} ChangeSets`}
            </Badge>
            {ACTIVE.has(data.status) && (
              <span className="ml-auto flex items-center gap-2 text-sm text-kumo-subtle">
                <Loader size="sm" /> Verifying in the Sandbox
              </span>
            )}
          </div>
          <Text as="h1" variant="heading3">
            Candidate <span className="font-mono">{data.id}</span>
          </Text>
          <Text variant="secondary">
            <span className="font-mono text-xs">{data.artifactRef ?? "fork pending"}</span>
            {data.composedTree && (
              <span className="font-mono text-xs"> · tree {data.composedTree.slice(0, 12)}</span>
            )}
          </Text>
          <Link
            to="/changes/$changeId"
            params={{ changeId: data.changeId }}
            className="text-sm text-kumo-link"
          >
            Back to the Change
          </Link>
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard>
        <LayerCard.Secondary className="px-5 py-2.5">
          <Text as="h2" variant="heading3">
            Approval and promotion
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="px-5 py-4">
          <CandidatePromotion candidate={data} />
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard>
        <LayerCard.Secondary className="px-5 py-2.5">
          <Text as="h2" variant="heading3">
            Verification Evidence
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="px-5 py-4">
          <CandidateEvidence candidate={data} evidence={evidence.data ?? []} />
        </LayerCard.Primary>
      </LayerCard>

      {(siblings.data?.length ?? 0) > 1 && (
        <LayerCard>
          <LayerCard.Secondary className="px-5 py-2.5">
            <Text as="h2" variant="heading3">
              Candidates of this Change
            </Text>
          </LayerCard.Secondary>
          <LayerCard.Primary className="overflow-x-auto px-5 py-4">
            <CandidateComparison candidates={siblings.data ?? []} currentId={data.id} />
          </LayerCard.Primary>
        </LayerCard>
      )}
    </>
  );
}

/** Side-by-side gate results (P10-13). Evidence decides; model confidence is not shown. */
function CandidateComparison({
  candidates,
  currentId,
}: {
  candidates: CandidateDetail[];
  currentId: string;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-kumo-subtle">
        <tr>
          <th className="py-1 pr-4 font-normal">Candidate</th>
          <th className="py-1 pr-4 font-normal">Status</th>
          <th className="py-1 pr-4 font-normal">ChangeSets</th>
          <th className="py-1 pr-4 font-normal">p95</th>
          <th className="py-1 font-normal">Unsatisfied checks</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr key={c.id} className={c.id === currentId ? "font-semibold" : ""}>
            <td className="py-1 pr-4 font-mono text-xs">
              <Link to="/candidates/$candidateId" params={{ candidateId: c.id }}>
                {c.id}
              </Link>
            </td>
            <td className="py-1 pr-4">
              <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
            </td>
            <td className="py-1 pr-4">{c.changeSetIds.length}</td>
            <td className="py-1 pr-4">
              {c.gate?.p95Ms === undefined ? "—" : `${c.gate.p95Ms.toFixed(2)} ms`}
            </td>
            <td className="py-1">
              {c.gate === null
                ? "pending"
                : c.gate.gaps.length === 0
                  ? "none"
                  : c.gate.gaps
                      .map((g) => `${g.checkId} (${g.reason.replace(/_/g, " ")})`)
                      .join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
