import { Button, Switch } from "@cloudflare/kumo";
import { Check, X } from "@phosphor-icons/react";
import type { AccessRequestList } from "@rhumbatron/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDateTime } from "../components/admin/admin-format";
import { AdminPage } from "../components/admin/admin-page";
import { SectionError, SkeletonBar, SkeletonRows } from "../components/project/feedback";
import { DataTable, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Section } from "../components/ui/page";
import {
  ADMIN_KEYS,
  approveAllAccess,
  decideAccess,
  getAdminSettings,
  listAccessRequests,
  updateAdminSettings,
} from "../lib/api-admin";
import { formatAge, formatNumber } from "../lib/format";
import { loadForAdmin, prefetch } from "../lib/ssr-data";

/**
 * Admin Access: the sign-up approval switch, and the accounts that wait for a decision. These
 * are the only writes in the admin area.
 */
export const Route = createFileRoute("/admin/access")({
  loader: ({ context: { queryClient } }) =>
    loadForAdmin(queryClient, () =>
      Promise.all([
        prefetch(queryClient, ADMIN_KEYS.settings, () => getAdminSettings()),
        prefetch(queryClient, ADMIN_KEYS.accessRequests, () => listAccessRequests()),
      ]),
    ),
  component: AccessPage,
});

function AccessPage() {
  return (
    <AdminPage title="Access" trail={[{ label: "Access" }]}>
      <SignupApproval />
      <PendingUsers />
    </AdminPage>
  );
}

function SignupApproval() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ADMIN_KEYS.settings, queryFn: () => getAdminSettings() });
  const save = useMutation({
    mutationFn: (signupApprovalRequired: boolean) =>
      updateAdminSettings({ data: { signupApprovalRequired } }),
    onSuccess: (next) => {
      queryClient.setQueryData(ADMIN_KEYS.settings, next);
      void queryClient.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
    },
  });
  const data = settings.data;
  const on = save.isPending ? save.variables : data?.signupApprovalRequired;

  return (
    <Section
      label="Sign-up approval"
      meta={
        data?.updatedAt
          ? `changed ${formatAge(data.updatedAt)} ago${data.updatedBy ? ` · ${data.updatedBy}` : ""}`
          : undefined
      }
    >
      {settings.isError ? (
        <SectionError
          message={`The setting could not load. ${settings.error.message}`}
          onRetry={() => settings.refetch()}
          retrying={settings.isFetching}
        />
      ) : !data ? (
        <div className="grid gap-2" role="status" aria-label="Loading the setting">
          <SkeletonBar height={15} className="w-1/3" />
          <SkeletonBar height={13} className="w-2/3" />
        </div>
      ) : (
        <div className="grid max-w-[760px] gap-3">
          <Switch
            label={
              <span className="text-[14px] font-semibold">Require approval for new users</span>
            }
            checked={on ?? false}
            disabled={save.isPending}
            onCheckedChange={(checked) => save.mutate(checked)}
          />
          <ul className="grid gap-2 text-[14px] text-pretty">
            <li className={on ? undefined : "text-kumo-subtle"}>
              <span className="font-semibold">On:</span> a person who signs in for the first time
              waits for your decision. They see “Your account is waiting for approval” and cannot
              open or create Projects until you approve them below. Existing users keep their
              access.
            </li>
            <li className={on ? "text-kumo-subtle" : undefined}>
              <span className="font-semibold">Off:</span> a new person can use Rhumbatron at once
              after the first sign-in. Turning approval off does not approve people who already
              wait; approve or decline each of them below, or approve them all.
            </li>
          </ul>
          <p role="status" className="text-[12px] text-kumo-subtle">
            {save.isPending
              ? "Saving…"
              : save.isSuccess
                ? `Saved. Approval for new users is ${data.signupApprovalRequired ? "on" : "off"}.`
                : `Approval for new users is ${data.signupApprovalRequired ? "on" : "off"}.`}
          </p>
          {save.isError && (
            <SectionError message={`The setting was not saved. ${save.error.message}`} />
          )}
        </div>
      )}
    </Section>
  );
}

function PendingUsers() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ADMIN_KEYS.accessRequests,
    queryFn: () => listAccessRequests(),
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ADMIN_KEYS.accessRequests });
    void queryClient.invalidateQueries({ queryKey: ADMIN_KEYS.overview });
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };
  const approveAll = useMutation({
    mutationFn: () => approveAllAccess(),
    onSuccess: () => {
      setConfirmAll(false);
      refresh();
    },
  });
  const users = requests.data?.users ?? [];

  return (
    <Section
      label="Waiting for approval"
      meta={requests.data ? formatNumber(users.length) : undefined}
    >
      {requests.isError ? (
        <SectionError
          message={`The waiting users could not load. ${requests.error.message}`}
          onRetry={() => requests.refetch()}
          retrying={requests.isFetching}
        />
      ) : requests.data && users.length === 0 ? (
        <EmptyState
          what={
            approveAll.isSuccess
              ? `Approved ${formatNumber(approveAll.data.approved)} ${approveAll.data.approved === 1 ? "user" : "users"}. Nobody is waiting.`
              : "Nobody is waiting for approval."
          }
          how="People wait here only while approval for new users is on."
        />
      ) : (
        <>
          {users.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {confirmAll ? (
                <>
                  <span className="text-[13px] font-semibold">
                    Approve all {formatNumber(users.length)} waiting users?
                  </span>
                  <Button
                    variant="primary"
                    icon={Check}
                    loading={approveAll.isPending}
                    onClick={() => approveAll.mutate()}
                  >
                    Approve all
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={approveAll.isPending}
                    onClick={() => setConfirmAll(false)}
                  >
                    Keep waiting
                  </Button>
                </>
              ) : (
                <Button variant="primary" icon={Check} onClick={() => setConfirmAll(true)}>
                  Approve all
                </Button>
              )}
            </div>
          )}
          {approveAll.isError && (
            <SectionError message={`Not all users were approved. ${approveAll.error.message}`} />
          )}
          <DataTable label="Users waiting for approval" minWidth={720}>
            <thead>
              <tr>
                <Th>User</Th>
                <Th numeric>Signed up</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {requests.data ? (
                users.map((user) => (
                  <PendingRow key={user.userId} user={user} onDecided={refresh} />
                ))
              ) : (
                <SkeletonRows cells={["title", "numeric", 160]} />
              )}
            </tbody>
          </DataTable>
        </>
      )}
    </Section>
  );
}

type AccessRequest = AccessRequestList["users"][number];

function PendingRow({ user, onDecided }: { user: AccessRequest; onDecided: () => void }) {
  const [confirmDecline, setConfirmDecline] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline") =>
      decideAccess({ data: { userId: user.userId, decision } }),
    onSuccess: onDecided,
  });
  const name = user.name ?? user.email ?? user.userId;
  return (
    <TRow>
      <Td className="max-w-[320px]">
        <TitleCell
          title={
            <Link
              to="/admin/users/$userId"
              params={{ userId: user.userId }}
              className="hover:underline"
            >
              {name}
            </Link>
          }
          meta={user.email ?? user.userId}
        />
      </Td>
      <Td numeric title={formatDateTime(user.requestedAt)}>
        {formatAge(user.requestedAt)}
      </Td>
      <Td>
        <div className="flex flex-wrap items-center gap-2">
          {confirmDecline ? (
            <>
              <span className="text-[13px]">Decline {name}?</span>
              <Button
                size="sm"
                variant="secondary"
                icon={X}
                loading={decide.isPending && decide.variables === "decline"}
                onClick={() => decide.mutate("decline")}
              >
                Decline
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={decide.isPending}
                onClick={() => setConfirmDecline(false)}
              >
                Keep waiting
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                icon={Check}
                loading={decide.isPending && decide.variables === "approve"}
                disabled={decide.isPending}
                onClick={() => decide.mutate("approve")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={X}
                disabled={decide.isPending}
                onClick={() => setConfirmDecline(true)}
              >
                Decline
              </Button>
            </>
          )}
        </div>
        {decide.isError && (
          <p role="alert" className="mt-1 text-[12px] text-kumo-danger">
            Not saved. {decide.error.message}
          </p>
        )}
      </Td>
    </TRow>
  );
}
