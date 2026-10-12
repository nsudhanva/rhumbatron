import { Button } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getProject } from "../../lib/api";
import { can } from "../../lib/permissions";

/**
 * "New change" in the header of every Project page. It opens the Overview with `?new=1`: the
 * Overview opens its New change box and moves focus to the goal (on the Overview itself too).
 * Hidden for a role that cannot submit, for an archived Project, and under 720px, where the box
 * at the top of the Overview is enough. It shows while the role loads, so the header does not
 * change width for the roles that can submit.
 */
export function NewChangeButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  if (project.isError) return null;
  if (
    project.data &&
    (!can(project.data.role, "change.create") || project.data.status === "archived")
  ) {
    return null;
  }
  return (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      // 28px like the mode toggle, so the header keeps its height; 44px for touch.
      className="h-7 px-2.5 text-[14px] max-[720px]:hidden pointer-coarse:h-11"
      onClick={() => {
        void navigate({ to: "/projects/$projectId", params: { projectId }, search: { new: 1 } });
      }}
    >
      New change
    </Button>
  );
}
NewChangeButton.displayName = "NewChangeButton";
