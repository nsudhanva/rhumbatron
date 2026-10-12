import { Button, Dialog, Input, Select } from "@cloudflare/kumo";
import { UserPlus, Users, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  getProjectMembers,
  inviteProjectMember,
  type ProjectMember,
  removeProjectMember,
  revokeProjectInvitation,
} from "../../lib/api";
import { updateMemberRole } from "../../lib/api-board";
import { formatAge } from "../../lib/format";
import {
  type AssignableRole,
  asRole,
  assignableRoles,
  can,
  invitableRoles,
  type ProjectRole,
  ROLE_HINT,
  ROLE_LABEL,
} from "../../lib/permissions";
import { Tag } from "../ui/tag";

export function ProjectShare({ projectId, role }: { projectId: string; role?: string }) {
  const [open, setOpen] = useState(false);
  const known = asRole(role);
  const manages = can(known, "people.manage");

  // A missing or unknown role renders nothing.
  if (!known) return null;

  return (
    <>
      <Button variant="secondary" icon={manages ? UserPlus : Users} onClick={() => setOpen(true)}>
        {manages ? "Share" : "Members"}
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className="grid gap-5 p-6 sm:w-[500px]">
          <header className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Dialog.Title className="text-base font-semibold">
                {manages ? "Share project" : "Project members"}
              </Dialog.Title>
              <Dialog.Description className="text-[13px] text-kumo-subtle">
                {manages
                  ? "Admins review requests and ship work. Members request changes. Viewers read only."
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

          <ProjectPeople projectId={projectId} role={known} />
        </Dialog>
      </Dialog.Root>
    </>
  );
}

/**
 * Members and pending invitations of a Project. An owner or admin invites with a role, changes
 * roles under the role rules (only the owner makes or removes admins), revokes invitations and
 * removes people. Everyone sees each person's role. Used by the Share dialog and the People
 * section of Project Settings.
 */
export function ProjectPeople({
  projectId,
  role,
}: {
  projectId: string;
  role: ProjectRole | null;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const inviteRoles = invitableRoles(role);
  const [inviteRole, setInviteRole] = useState<AssignableRole>("member");
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inviteRoleId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });

  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => getProjectMembers({ data: projectId }),
  });

  const invite = useMutation({
    mutationFn: () =>
      inviteProjectMember({
        data: { projectId, email: email.trim().toLowerCase(), role: inviteRole },
      }),
    onSuccess: async () => {
      setEmail("");
      setActionError(null);
      await refresh();
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
      await refresh();
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
      await refresh();
    },
    onError: (err) => {
      setActionError(err.message);
    },
  });

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: AssignableRole }) =>
      updateMemberRole({ data: { projectId, ...input } }),
    onMutate: () => setActionError(null),
    onSettled: refresh,
    onError: (err) => setActionError(`The role was not changed. ${err.message}`),
  });

  const members = membersQuery.data?.members ?? [];
  const invitations = membersQuery.data?.invitations ?? [];
  const manages = can(role, "people.manage");

  return (
    <div className="grid gap-5">
      {manages && inviteRoles.length > 0 && (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate();
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <Input
              type="email"
              aria-label="Invite by email"
              placeholder="colleague@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="grow"
              required
            />
            <span id={inviteRoleId} className="sr-only">
              Role of the invited person
            </span>
            <Select
              aria-labelledby={inviteRoleId}
              className="w-[130px]"
              value={inviteRole}
              onValueChange={(v) => {
                if (typeof v === "string" && (inviteRoles as string[]).includes(v)) {
                  setInviteRole(v as AssignableRole);
                }
              }}
              items={Object.fromEntries(inviteRoles.map((r) => [r, ROLE_LABEL[r]]))}
            />
            {/* The input is required: an empty submit shows the browser's own message. */}
            <Button type="submit" variant="primary" loading={invite.isPending}>
              Invite
            </Button>
          </div>
          <p className="text-[12px] text-kumo-subtle">
            {ROLE_LABEL[inviteRole]}: {ROLE_HINT[inviteRole]}
          </p>
          {invite.isError && (
            <p className="text-[12px] text-kumo-danger font-medium">{invite.error.message}</p>
          )}
        </form>
      )}

      {actionError && <p className="text-[12px] text-kumo-danger font-medium">{actionError}</p>}

      <div className="grid gap-2">
        <h3 className="type-label text-kumo-subtle">Members</h3>
        {membersQuery.isPending ? (
          <p className="text-[13px] text-kumo-subtle">Loading members...</p>
        ) : members.length === 0 ? (
          <p className="text-[13px] text-kumo-subtle">No members found.</p>
        ) : (
          <ul className="divide-y divide-kumo-rule max-h-72 overflow-y-auto">
            {members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                actor={role}
                removing={remove.isPending && removingUserId === m.userId}
                changing={changeRole.isPending && changeRole.variables?.userId === m.userId}
                onRemove={() => remove.mutate(m.userId)}
                onRole={(next) => changeRole.mutate({ userId: m.userId, role: next })}
              />
            ))}
          </ul>
        )}
      </div>

      {manages && invitations.length > 0 && (
        <div className="grid gap-2 pt-2 border-t border-kumo-rule">
          <h3 className="type-label text-kumo-subtle">Pending invitations</h3>
          <ul className="divide-y divide-kumo-rule max-h-40 overflow-y-auto">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-2 text-[13px] gap-2">
                <div className="grid min-w-0">
                  <span className="truncate font-mono text-[12px]">{inv.email}</span>
                  <span className="text-[11px] text-kumo-subtle">
                    Sent {formatAge(inv.createdAt)}
                    {` · ${ROLE_LABEL[inv.role]}`}
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

/**
 * One person: name and email, their role (a select when the actor may change it, else a tag),
 * "You", and Remove when the actor may remove them.
 */
function MemberRow({
  member,
  actor,
  removing,
  changing,
  onRemove,
  onRole,
}: {
  member: ProjectMember;
  actor: ProjectRole | null;
  removing: boolean;
  changing: boolean;
  onRemove: () => void;
  onRole: (role: AssignableRole) => void;
}) {
  const role = asRole(member.role) ?? "member";
  const displayName = member.name ?? member.email ?? member.userId;
  const options = member.isYou ? [] : assignableRoles(actor, role);
  const roleLabelId = useId();
  return (
    <li className="flex flex-wrap items-center justify-between py-2 text-[13px] gap-2">
      <div className="grid min-w-0">
        <span className="truncate font-medium">{displayName}</span>
        {member.name && member.email && (
          <span className="truncate font-mono text-[11px] text-kumo-subtle">{member.email}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {options.length > 0 ? (
          <>
            <span id={roleLabelId} className="sr-only">
              Role of {displayName}
            </span>
            <Select
              aria-labelledby={roleLabelId}
              size="sm"
              className="w-[120px]"
              value={role}
              loading={changing}
              onValueChange={(v) => {
                if (typeof v === "string" && v !== role && (options as string[]).includes(v)) {
                  onRole(v as AssignableRole);
                }
              }}
              items={Object.fromEntries(options.map((r) => [r, ROLE_LABEL[r]]))}
            />
          </>
        ) : (
          <Tag variant="neutral">{ROLE_LABEL[role]}</Tag>
        )}
        {member.isYou && <Tag variant="accent">You</Tag>}
        {options.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-kumo-danger hover:text-kumo-danger text-[12px] px-2 py-1"
            loading={removing}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}
MemberRow.displayName = "ProjectMemberRow";
