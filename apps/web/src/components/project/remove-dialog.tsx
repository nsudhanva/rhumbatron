import { Button, Dialog, Input } from "@cloudflare/kumo";
import { SignOut, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { deleteProject, getProjectMembers, removeProjectMember } from "../../lib/api";

/**
 * "Delete project" for the owner (typed name confirms) and "Leave project" for a collaborator.
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
  const isOwner = role === "owner";

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
      else await removeProjectMember({ data: { projectId, userId: selfId ?? "" } });
    },
    onSuccess: done,
  });

  if (role !== "owner" && role !== "collaborator") return null;
  const label = isOwner ? "Delete project" : "Leave project";
  const confirmed = isOwner ? typed === projectName : Boolean(selfId);

  return (
    <>
      <Button
        variant="secondary"
        icon={isOwner ? Trash : SignOut}
        onClick={() => {
          setTyped("");
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
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {remove.isError && (
            <p className="text-[12px] text-kumo-danger font-medium">{remove.error.message}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={remove.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              disabled={!confirmed}
              onClick={() => remove.mutate()}
            >
              {label}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
