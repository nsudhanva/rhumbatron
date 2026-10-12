import { Button, Dialog, Input } from "@cloudflare/kumo";
import { SignOut, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { deleteProject, getProjectMembers, removeProjectMember } from "../../lib/api";
import { can } from "../../lib/permissions";

/**
 * "Delete project" for the owner (typed name confirms) and "Leave project" for everyone else.
 * Both end on the projects list. Deleting is irreversible; leaving keeps the person's past
 * requests with the Project and cancels the ones still open.
 */
export function ProjectRemove({
  projectId,
  projectName,
  role,
}: {
  projectId: string;
  projectName: string;
  role: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const isOwner = can(role, "project.delete");

  const members = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => getProjectMembers({ data: projectId }),
    enabled: !isOwner,
  });
  const selfId = members.data?.members.find((m) => m.isYou)?.userId;

  const done = async () => {
    setOpen(false);
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await navigate({ to: "/" });
  };
  const remove = useMutation({
    mutationFn: async () => {
      if (isOwner) await deleteProject({ data: projectId });
      else {
        if (!selfId) throw new Error("Your membership could not be found. Reload and try again.");
        await removeProjectMember({ data: { projectId, userId: selfId } });
      }
    },
    onSuccess: done,
  });

  if (!isOwner && !can(role, "project.leave")) return null;
  const label = isOwner ? "Delete project" : "Leave project";
  // Leaving needs the person's own member ID; it loads with the members list.
  const waitingForSelf = !isOwner && members.isPending;
  const confirm = () => {
    if (isOwner && typed !== projectName) {
      setMismatch(true);
      return;
    }
    remove.mutate();
  };

  return (
    <>
      <Button
        variant="secondary"
        icon={isOwner ? Trash : SignOut}
        onClick={() => {
          setTyped("");
          setMismatch(false);
          remove.reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>

      <Dialog.Root open={open} onOpenChange={(next) => !remove.isPending && setOpen(next)}>
        <Dialog className="grid gap-5 p-6 sm:w-[500px]">
          <header className="grid gap-1">
            <Dialog.Title className="text-base font-semibold">{label}</Dialog.Title>
            <Dialog.Description className="text-[13px] text-kumo-subtle">
              {isOwner
                ? "This permanently deletes the project: its source, previews, live app, app data, evidence, and request history. It cannot be undone."
                : "You lose access to this project. Your requests that are still open are cancelled; the ones already finished stay with the project."}
            </Dialog.Description>
          </header>

          {isOwner && (
            <div className="grid gap-1.5 text-[13px]">
              <label htmlFor="delete-project-name">
                Type <span className="font-mono font-medium">{projectName}</span> to confirm
              </label>
              <Input
                id="delete-project-name"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setMismatch(false);
                }}
                autoComplete="off"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? "delete-project-mismatch" : undefined}
              />
              {mismatch && (
                <p id="delete-project-mismatch" className="text-[12px] text-kumo-danger">
                  The name does not match. Type it exactly as shown to delete the project.
                </p>
              )}
            </div>
          )}
          {!isOwner && members.isError && (
            <p className="text-[12px] text-kumo-danger font-medium">
              Your membership could not load. {members.error.message}
            </p>
          )}

          {remove.isError && (
            <p className="text-[12px] text-kumo-danger font-medium">{remove.error.message}</p>
          )}

          <div className="flex justify-end gap-2">
            {/* While the request runs the dialog stays open; the action shows its progress. */}
            {!remove.isPending && (
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
            <Button
              variant="destructive"
              loading={remove.isPending || waitingForSelf}
              onClick={confirm}
            >
              {label}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
