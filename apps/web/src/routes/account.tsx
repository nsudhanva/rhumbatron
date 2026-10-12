import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MyCosts } from "../components/account/my-costs";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { MonthlyBudgetForm } from "../components/settings/monthly-budget-form";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { getMyCosts, MY_COSTS_KEY, MY_COSTS_MONTHS } from "../lib/api-admin";
import { getMe, ME_KEY, type Me, monthName, updateMyBudget } from "../lib/api-budget";
import { loadOnServer, prefetch } from "../lib/ssr-data";

/**
 * Account (linked from the sidebar identity): the signed-in user's name and email, their own
 * monthly budget, their model spend this month across every Project
 * (docs/operations/costs.md, "Budget scopes"), and their spend over the last six months, this
 * month by Project and this month by request (`GET /v1/me/costs`).
 */
export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "Account · Rhumbatron" }] }),
  // Server render: the profile and budget are in the first HTML.
  loader: ({ context: { queryClient } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetch(queryClient, ME_KEY, () => getMe()),
        prefetch(queryClient, MY_COSTS_KEY, () => getMyCosts({ data: MY_COSTS_MONTHS })),
      ]),
    ),
  component: AccountPage,
});

function AccountPage() {
  return (
    <Page>
      <PageTitle kicker="Rhumbatron" title="Account" />
      <Show when="signed-in">
        <AccountContent />
      </Show>
      <Show when="signed-out">
        <EmptyState
          what="Sign in to see your account."
          how="Your monthly budget and spend are visible to you only."
          action={
            <SignInButton>
              <Button variant="primary" icon={SignIn}>
                Sign in
              </Button>
            </SignInButton>
          }
        />
      </Show>
    </Page>
  );
}

function AccountContent() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: () => getMe() });
  const data = me.data;

  if (me.isError) {
    return (
      <SectionError
        message={`Your account could not load. ${me.error.message}`}
        onRetry={() => me.refetch()}
        retrying={me.isFetching}
      />
    );
  }
  if (!data) {
    return (
      <Section label="Profile">
        <div className="grid gap-2" role="status" aria-label="Loading your account">
          <SkeletonBar height={13} className="w-1/2" />
          <SkeletonBar height={13} className="w-1/3" />
        </div>
      </Section>
    );
  }

  return (
    <>
      <AccountProfile data={data} />
      <MyCosts />
    </>
  );
}

function AccountProfile({ data }: { data: Me }) {
  const queryClient = useQueryClient();
  return (
    <TwoUp>
      <Section label="Profile">
        <KeyValue
          items={[
            { label: "Name", value: data.name },
            { label: "Email", value: data.email, mono: true },
          ]}
        />
      </Section>
      <Section label="Budget" meta={monthName(data.month)}>
        <MonthlyBudgetForm
          label="My monthly budget (USD)"
          description="A ceiling on the model work you request, in every Project, each month. Requests with “My budget” draw on it."
          capUsd={data.monthlyBudgetUsd}
          spentUsd={data.monthSpendUsd}
          spentLabel="Spent this month across Projects"
          save={(monthlyBudgetUsd) => updateMyBudget({ data: monthlyBudgetUsd })}
          onSaved={(next) => {
            // Keep the fields the budget write does not return (admin rights, access status).
            queryClient.setQueryData<Me>(ME_KEY, (current) =>
              current ? { ...current, ...next } : next,
            );
            // A raise resumes Changes this budget stopped.
            void queryClient.invalidateQueries({ queryKey: ["changes"] });
            void queryClient.invalidateQueries({ queryKey: ["change"] });
          }}
        />
      </Section>
    </TwoUp>
  );
}
