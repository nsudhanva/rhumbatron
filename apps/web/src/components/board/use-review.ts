import { useMutation, useQueryClient } from "@tanstack/react-query";
import { declineChange, includeChange, type ProjectBoard } from "../../lib/api-board";
import { applyReview } from "./board-model";

/** Query key of the Board read; the route loader and the page use the same key. */
export const boardKey = (projectId: string) => ["project-board", projectId] as const;

/** Mutation key of every Include and Decline in a Project (the Board reports the last failure). */
export const reviewKey = (projectId: string) => ["review", projectId] as const;

type Snapshot = { board: ProjectBoard | undefined };

/**
 * Include and Decline for a proposed request (owner and admin; the API checks the role). The
 * Board moves the card at once and moves it back when the API refuses; every read of the Change
 * refreshes after the answer.
 */
export function useReviewRequest(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const key = boardKey(projectId ?? "");

  const optimistic = async (
    changeId: string,
    decision: Parameters<typeof applyReview>[2],
  ): Promise<Snapshot> => {
    await queryClient.cancelQueries({ queryKey: key });
    const board = queryClient.getQueryData<ProjectBoard>(key);
    if (board) queryClient.setQueryData(key, applyReview(board, changeId, decision));
    return { board };
  };
  const rollback = (snapshot: Snapshot | undefined) => {
    if (snapshot?.board) queryClient.setQueryData(key, snapshot.board);
  };
  const refresh = (changeId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ["change", changeId] }),
      queryClient.invalidateQueries({ queryKey: ["changes", projectId] }),
    ]);

  const include = useMutation({
    mutationKey: [...reviewKey(projectId ?? ""), "include"],
    mutationFn: (changeId: string) => includeChange({ data: changeId }),
    onMutate: (changeId) => optimistic(changeId, { kind: "include" }),
    onError: (_error, _changeId, snapshot) => rollback(snapshot),
    onSettled: (_data, _error, changeId) => refresh(changeId),
  });
  const decline = useMutation({
    mutationKey: [...reviewKey(projectId ?? ""), "decline"],
    mutationFn: (input: { changeId: string; reason: string }) =>
      declineChange({
        data: { changeId: input.changeId, ...(input.reason ? { reason: input.reason } : {}) },
      }),
    onMutate: (input) =>
      optimistic(input.changeId, { kind: "decline", reason: input.reason || null, by: "you" }),
    onError: (_error, _input, snapshot) => rollback(snapshot),
    onSettled: (_data, _error, input) => refresh(input.changeId),
  });
  return { include, decline };
}
