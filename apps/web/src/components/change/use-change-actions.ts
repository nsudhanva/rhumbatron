import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createCandidate, createChange, promoteCandidate } from "../../lib/api";

/**
 * The Change page actions (docs/ux/research-2026-10-09.md 7.5): Run checks, Approve and ship,
 * Ship, and Start again. The header button and the timeline step call the same mutation, so a
 * click in either place shows progress in both.
 */
export function useChangeActions({
  changeId,
  projectId,
  goal,
  budgetUsd,
}: {
  changeId: string;
  projectId: string | undefined;
  goal: string | undefined;
  budgetUsd: number | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [approvalOpen, setApprovalOpen] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["change", changeId] }),
      queryClient.invalidateQueries({ queryKey: ["candidates", changeId] }),
    ]);

  const runChecks = useMutation({
    mutationFn: () => createCandidate({ data: changeId }),
    onSettled: refresh,
  });
  const ship = useMutation({
    mutationFn: (candidateId: string) => promoteCandidate({ data: candidateId }),
    onSettled: refresh,
  });
  const restart = useMutation({
    mutationFn: (budgetFactor: 1 | 2) =>
      createChange({
        data: {
          projectId: projectId ?? "",
          goal: goal ?? "",
          budgetUsd: Math.round((budgetUsd ?? 0) * budgetFactor * 100) / 100,
        },
      }),
    onSuccess: ({ id }) => navigate({ to: "/changes/$changeId", params: { changeId: id } }),
  });

  return { runChecks, ship, restart, approvalOpen, setApprovalOpen, refresh };
}
