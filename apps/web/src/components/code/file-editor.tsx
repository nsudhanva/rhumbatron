import { useUser } from "@clerk/tanstack-react-start";
import { Button, Input } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { type CodeFile, submitCodeEdit } from "../../lib/api";
import { SectionError } from "../project/feedback";
import { shortSha } from "../workspace-page/model";
import { formatBytes } from "./file-view";

/** Same limit as the API (MAX_EDIT_BYTES in packages/protocol code-edit.ts). */
const MAX_EDIT_BYTES = 256 * 1024;

/**
 * Edit one file of the live tree (P16-19). A plain mono textarea in the file view's dress
 * (DESIGN.md 9.10), then a message and Save. Save creates a new Change with one human ChangeSet;
 * it ships only after the same checks as agent work, so this never changes canonical directly.
 */
export function FileEditor({
  projectId,
  file,
  onCancel,
}: {
  projectId: string;
  file: CodeFile & { content: string };
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useUser();
  const [content, setContent] = useState(file.content);
  const [message, setMessage] = useState(`Update ${file.path.split("/").at(-1) ?? file.path}`);
  // One request ID per editing session: a repeated Save finds the same Change.
  const [clientRequestId] = useState(() => `edit-${crypto.randomUUID()}`);
  // A textarea reports "\n" line ends; keep a file that used CRLF in CRLF.
  const crlf = file.content.includes("\r\n");
  const saved = crlf ? content.replace(/\r?\n/g, "\r\n") : content;
  const bytes = new TextEncoder().encode(saved).length;
  const tooLarge = bytes > MAX_EDIT_BYTES;
  const unchanged = saved === file.content;

  const save = useMutation({
    mutationFn: () =>
      submitCodeEdit({
        data: {
          projectId,
          path: file.path,
          content: saved,
          baseTree: file.treeSha,
          message: message.trim(),
          authorName: user?.fullName ?? user?.username ?? undefined,
          clientRequestId,
        },
      }),
    onSuccess: async ({ changeId }) => {
      await queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
      await navigate({ to: "/changes/$changeId", params: { changeId } });
    },
  });
  const stale = save.isError && /changed; reload/i.test(save.error.message);

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <figure className="min-w-0 rule-ink bg-kumo-elevated">
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-kumo-rule px-3 py-2 font-mono text-[12px]">
          <span className="min-w-0 truncate font-semibold" title={file.path}>
            {file.path}
          </span>
          <span className="flex items-baseline gap-3 text-kumo-subtle">
            <span className={tooLarge ? "text-kumo-danger" : undefined}>
              {formatBytes(bytes)} of {formatBytes(MAX_EDIT_BYTES)}
            </span>
            <span title={file.treeSha}>tree {shortSha(file.treeSha)}</span>
          </span>
        </figcaption>
        <textarea
          aria-label={`Contents of ${file.path}`}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.7] whitespace-pre outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
          style={{ minHeight: 360, maxHeight: 640 }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </figure>
      <Input
        label="Message"
        description="Saving creates a new Change. It ships only after its checks pass."
        value={message}
        maxLength={200}
        onChange={(e) => setMessage(e.target.value)}
        required
      />
      {tooLarge && (
        <SectionError message="Files over 256 KB cannot be edited here. Shorten the file." />
      )}
      {save.isError && (
        <SectionError
          message={
            stale
              ? "The file changed since you opened it; reload. Copy your edits first: reloading discards them."
              : `The edit was not saved. ${save.error.message}`
          }
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={save.isPending}
          disabled={unchanged || tooLarge || !message.trim()}
        >
          Save change
        </Button>
        {stale && (
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              await queryClient.invalidateQueries({ queryKey: ["code-tree", projectId] });
              await queryClient.invalidateQueries({ queryKey: ["code-versions", projectId] });
              onCancel();
            }}
          >
            Reload file
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
FileEditor.displayName = "FileEditor";
