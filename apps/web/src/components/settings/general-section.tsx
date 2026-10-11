import { Button, InlineCopyText, Input } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getProjectApp } from "../../lib/api";
import { type ProjectSettings, updateProjectSettings } from "../../lib/api-settings";
import { timeAgo } from "../../lib/format";
import { SectionError } from "../project/feedback";
import { KeyValue } from "../ui/key-value";
import { Section } from "../ui/page";

const NAME_MAX = 80;

/** Copyable machine value (DESIGN.md 8.1 clipboard text). */
function Copy({ value }: { value: string }) {
  return (
    <InlineCopyText value={value} variant="mono" className="max-w-full break-all text-[12px]">
      {value}
    </InlineCopyText>
  );
}
Copy.displayName = "SettingsCopy";

/**
 * General: the Project name (the owner edits it), the slug and live app host (read-only, with
 * copy) and the creation date.
 */
export function GeneralSection({
  projectId,
  settings,
}: {
  projectId: string;
  settings: ProjectSettings;
}) {
  const isOwner = settings.role === "owner";
  const app = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => getProjectApp({ data: projectId }),
  });
  const live = app.data?.app && app.data.app.status !== "removed" ? app.data.app : null;
  const host = live ? live.url.replace(/^https:\/\//, "") : null;

  return (
    <Section label="General">
      {isOwner && <NameForm projectId={projectId} name={settings.name} />}
      <KeyValue
        items={[
          ...(isOwner ? [] : [{ label: "Name", value: settings.name }]),
          { label: "Slug", value: <Copy value={settings.slug} /> },
          {
            label: "Live app",
            value: host ? (
              <Copy value={host} />
            ) : app.isPending ? (
              "Loading"
            ) : app.data?.enabled === false ? (
              "Live apps are not served in this environment."
            ) : (
              "No live app yet. The first promoted Change publishes it."
            ),
          },
          {
            label: "Created",
            value: (
              <span>
                <span className="font-mono">{settings.createdAt.slice(0, 10)}</span>
                <span className="text-kumo-subtle"> · {timeAgo(settings.createdAt)}</span>
              </span>
            ),
          },
        ]}
      />
    </Section>
  );
}
GeneralSection.displayName = "GeneralSection";

function NameForm({ projectId, name }: { projectId: string; name: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  // A rename elsewhere (another tab, a refetch) resets an untouched field.
  useEffect(() => setValue(name), [name]);
  const save = useMutation({
    mutationFn: () => updateProjectSettings({ data: { projectId, name: value.trim() } }),
    onSuccess: async (next) => {
      queryClient.setQueryData(["project-settings", projectId], next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
  const unchanged = value.trim() === name;

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (unchanged) return;
        save.mutate();
      }}
    >
      <div className="max-w-[420px]">
        <Input
          label="Name"
          description={`Shown in the project list and the sidebar. Up to ${NAME_MAX} characters.`}
          value={value}
          maxLength={NAME_MAX}
          onChange={(event) => {
            setValue(event.target.value);
            save.reset();
          }}
          required
        />
      </div>
      {save.isError && <SectionError message={`The name was not saved. ${save.error.message}`} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={save.isPending}>
          Save name
        </Button>
        <span role="status" className="text-[12px] text-kumo-subtle">
          {save.isSuccess && unchanged ? "Saved." : unchanged ? "No changes to save." : ""}
        </span>
      </div>
    </form>
  );
}
