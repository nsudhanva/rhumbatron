import { Button, Dialog, Input } from "@cloudflare/kumo";
import { UserPlus, Users, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getProjectMembers,
  inviteProjectMember,
  removeProjectMember,
  revokeProjectInvitation,
} from "../../lib/api";
import { formatAge } from "../../lib/format";
import { Tag } from "../ui/tag";

export function ProjectShare({ projectId, role }: { projectId: string; role?: string }) {
  const [open, setOpen] = useState(false);
  const isOwner = role === "owner";

  // If role is missing at runtime or not a known member, render nothing
  if (!role) return null;

  return (
    <>
      <Button variant="secondary" icon={isOwner ? UserPlus : Users} onClick={() => setOpen(true)}>
        {isOwner ? "Share" : "Members"}
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className="grid gap-5 p-6 sm:w-[500px]">
          <header className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Dialog.Title className="text-base font-semibold">
                {isOwner ? "Share project" : "Project members"}
              </Dialog.Title>
              <Dialog.Description className="text-[13px] text-kumo-subtle">
                {isOwner
                  ? "Collaborators can view and create changes, but cannot promote or change project settings."
                  : "Members who have access to this project."}
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="text-kumo-subtle hover:text-kumo-ink cursor-pointer p-1"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>

          <ProjectPeople projectId={projectId} isOwner={isOwner} />
        </Dialog>
      </Dialog.Root>
    </>
  );
}

/**
 * Members and pending invitations of a Project, with invite, revoke and remove for the owner.
 * Used by the Share dialog and the People section of Project Settings.
 */
export function ProjectPeople({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => getProjectMembers({ data: projectId }),
  });

  const invite = useMutation({
    mutationFn: () =>
      inviteProjectMember({ data: { projectId, email: email.trim().toLowerCase() } }),
    onSuccess: async () => {
      setEmail("");
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
    },
    onError: (err) => {
      setActionError(err.message);
    },
  });

  const revoke = useMutation({
    mutationFn: (invitationId: string) =>
      revokeProjectInvitation({ data: { projectId, invitationId } }),
    onMutate: (invitationId) => {
      setRevokingId(invitationId);
      setActionError(null);
    },
    onSettled: async () => {
      setRevokingId(null);
      await queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
    },
    onError: (err) => {
      setActionError(err.message);
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => removeProjectMember({ data: { projectId, userId } }),
    onMutate: (userId) => {
      setRemovingUserId(userId);
      setActionError(null);
    },
    onSettled: async () => {
      setRemovingUserId(null);
      await queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
    },
    onError: (err) => {
      setActionError(err.message);
    },
  });

  const members = membersQuery.data?.members ?? [];
  const invitations = membersQuery.data?.invitations ?? [];

  return (
    <div className="grid gap-5">
      {/* Invite form - Owner only */}
      {isOwner && (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate();
          }}
        >
          <div className="flex gap-2">
            <Input
              type="email"
              aria-label="Invite by email"
              placeholder="colleague@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="grow"
              required
            />
            {/* The input is required: an empty submit shows the browser's own message. */}
            <Button type="submit" variant="primary" loading={invite.isPending}>
              Invite
            </Button>
          </div>
          {invite.isError && (
            <p className="text-[12px] text-kumo-danger font-medium">{invite.error.message}</p>
          )}
        </form>
      )}

      {actionError && <p className="text-[12px] text-kumo-danger font-medium">{actionError}</p>}

      {/* Members list */}
      <div className="grid gap-2">
        <h3 className="type-label text-kumo-subtle">Members</h3>
        {membersQuery.isPending ? (
          <p className="text-[13px] text-kumo-subtle">Loading members...</p>
        ) : members.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No members found.</p>
        ) : (
          <ul className="divide-y divide-kumo-rule max-h-56 overflow-y-auto">
            {members.map((m) => {
              const displayName = m.name ?? m.email ?? m.userId;
              const isCollaborator = m.role === "collaborator";
              return (
                <li
                  key={m.userId}
                  className="flex items-center justify-between py-2 text-[13px] gap-2"
                >
                  <div className="grid min-w-0">
                    <span className="truncate font-medium">{displayName}</span>
                    {m.name && m.email && (
                      <span className="truncate font-mono text-[11px] text-kumo-subtle">
                        {m.email}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Tag variant="neutral">{m.role === "owner" ? "Owner" : "Collaborator"}</Tag>
                    {m.isYou && <Tag variant="accent">You</Tag>}
                    {isOwner && isCollaborator && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-kumo-danger hover:text-kumo-danger text-[12px] px-2 py-1"
                        loading={remove.isPending && removingUserId === m.userId}
                        onClick={() => remove.mutate(m.userId)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Pending invitations - Owner only */}
      {isOwner && invitations.length > 0 && (
        <div className="grid gap-2 pt-2 border-t border-kumo-rule">
          <h3 className="type-label text-kumo-subtle">Pending invitations</h3>
          <ul className="divide-y divide-kumo-rule max-h-40 overflow-y-auto">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-2 text-[13px] gap-2">
                <div className="grid min-w-0">
                  <span className="truncate font-mono text-[12px]">{inv.email}</span>
                  <span className="text-[11px] text-kumo-subtle">
                    Sent {formatAge(inv.createdAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-kumo-subtle hover:text-kumo-danger text-[12px] px-2 py-1"
                  loading={revoke.isPending && revokingId === inv.id}
                  onClick={() => revoke.mutate(inv.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
