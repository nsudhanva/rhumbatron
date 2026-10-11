import { useQuery } from "@tanstack/react-query";
import { getCandidatePreview } from "../../lib/api";

const LINK = "text-kumo-link underline-offset-2 hover:underline";

/**
 * "Open preview" in the Candidate header (P16-10, ADR 0020): the Candidate's composed source,
 * live on its own host with its own data. Renders nothing where live apps are off (local runs) or when
 * the Candidate has no preview (no app, build not passed, or the Change's 3 previews are in use).
 */
export function PreviewLink({ candidateId, active }: { candidateId: string; active: boolean }) {
  const query = useQuery({
    queryKey: ["candidate-preview", candidateId],
    queryFn: () => getCandidatePreview({ data: candidateId }),
    // The preview builds after the checks: poll while the Candidate or its preview is in progress.
    refetchInterval: (q) =>
      active || q.state.data?.preview?.status === "building" ? 10_000 : false,
  });
  const preview = query.data?.enabled ? query.data.preview : null;
  if (!preview || preview.status === "removed") return null;
  if (preview.status === "building") return <span>Preview building</span>;
  if (preview.status === "failed") {
    return <span title={preview.failureReason ?? undefined}>Preview build failed</span>;
  }
  return (
    <a href={preview.url} target="_blank" rel="noreferrer" className={LINK}>
      Open preview
    </a>
  );
}
