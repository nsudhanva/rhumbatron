import { Button, buttonVariants, cn, Popover } from "@cloudflare/kumo";
import {
  ArrowLineUp,
  ArrowsSplit,
  CheckSquare,
  GitMerge,
  type Icon,
  Prohibit,
  UserCheck,
  WarningOctagon,
  X,
  XSquare,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type AppNotification,
  type NotificationInbox as Inbox,
  listNotifications,
  markNotificationsRead,
  type NotificationCount,
  type NotificationKind,
} from "../../lib/api";
import { formatAge } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { InboxSkeleton } from "./inbox-skeleton";
import { NOTIFICATION_KEYS } from "./notification-keys";

/**
 * Inbox popover content (DESIGN.md 8.4, 8.5, 10, 12). Loaded as its own chunk the first time the
 * bell is hovered, focused, or opened. Two groups: "Needs you" (action items, which stay until
 * their condition clears) and "Updates". Each row is one link to the page where the item is
 * handled; opening it marks it read. Approvals are never decided here: "Review" opens the
 * Candidate page, where the approval dialog shows the evidence first (DESIGN.md 10).
 */

const ICONS: Record<NotificationKind, Icon> = {
  approval_required: UserCheck,
  promotion_ready: ArrowLineUp,
  dead_letter: WarningOctagon,
  budget_blocked: Prohibit,
  candidate_rejected: XSquare,
  conflict_open: ArrowsSplit,
  change_completed: CheckSquare,
  promoted: GitMerge,
  request_not_selected: XSquare,
  request_awaiting_owner: UserCheck,
};

/** Inline action for items whose next step is a decision on another page. */
const ACTIONS: Partial<Record<NotificationKind, string>> = {
  approval_required: "Review",
  promotion_ready: "Open",
  request_awaiting_owner: "Choose",
};

/** The icon is the status here (DESIGN.md 7), paired with the title's words. */
const ICON_TONE = {
  action: "text-accent-500",
  attention: "text-kumo-warning",
  info: "text-kumo-subtle",
} as const;

export default function NotificationInbox({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const inbox = useQuery({
    queryKey: NOTIFICATION_KEYS.list,
    queryFn: async () => {
      const data = await listNotifications();
      // The list carries the same counts: keep the badge in step without a second read.
      queryClient.setQueryData<NotificationCount>(NOTIFICATION_KEYS.count, {
        unread: data.unread,
        action: data.action,
      });
      return data;
    },
    staleTime: 0,
    retry: 1,
  });

  const markRead = useMutation({
    mutationFn: (ids: string[] | "all") => markNotificationsRead({ data: ids }),
    onMutate: (ids) => {
      const marked = (item: AppNotification) => ids === "all" || ids.includes(item.id);
      const current = queryClient.getQueryData<Inbox>(NOTIFICATION_KEYS.list);
      if (!current) return;
      const items = current.items.map((item) => (marked(item) ? { ...item, read: true } : item));
      const unread = Math.max(
        0,
        current.unread - current.items.filter((i) => !i.read && marked(i)).length,
      );
      queryClient.setQueryData<Inbox>(NOTIFICATION_KEYS.list, { ...current, items, unread });
      queryClient.setQueryData<NotificationCount>(NOTIFICATION_KEYS.count, {
        unread,
        action: current.action,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_KEYS.count }),
  });

  if (inbox.isPending) return <InboxSkeleton />;

  const items = inbox.data?.items ?? [];
  const needsYou = items.filter((i) => i.severity === "action");
  const updates = items.filter((i) => i.severity !== "action");
  const unread = inbox.data?.unread ?? 0;
  const open = (item: AppNotification) => {
    if (!item.read) markRead.mutate([item.id]);
    onClose();
  };

  return (
    <div className="grid">
      <div className="flex h-11 items-center gap-2 border-b-2 border-kumo-divider pr-1.5 pl-3">
        <Popover.Title className="type-h6 m-0 grow">Notifications</Popover.Title>
        <Button
          size="xs"
          variant="ghost"
          disabled={unread === 0 || markRead.isPending}
          onClick={() => markRead.mutate("all")}
        >
          Mark all read
        </Button>
        <Popover.Close
          aria-label="Close notifications"
          title="Close"
          className="grid size-7 place-items-center hover:bg-kumo-tint focus-visible:outline-offset-[-2px] pointer-coarse:size-11"
        >
          <X size={14} aria-hidden />
        </Popover.Close>
      </div>

      <div className="max-h-[min(480px,calc(100dvh-140px))] overflow-y-auto overscroll-contain">
        {inbox.isError ? (
          <div className="grid justify-items-start gap-2 px-3 py-3 text-[13px]">
            <p className="font-semibold text-kumo-danger">
              Notifications could not load. {inbox.error.message}
            </p>
            <Button size="xs" variant="secondary" onClick={() => void inbox.refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            className="px-3"
            what="Nothing needs you."
            how="Approvals, promotions, failed commands, and finished Changes appear here."
          />
        ) : (
          <>
            <Group label="Needs you" items={needsYou} onOpen={open} />
            <Group label="Updates" items={updates} onOpen={open} />
          </>
        )}
      </div>
    </div>
  );
}
NotificationInbox.displayName = "NotificationInbox";

function Group({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: AppNotification[];
  onOpen: (item: AppNotification) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label}>
      <h3 className="flex items-baseline justify-between border-b-2 border-kumo-divider px-3 pt-3 pb-1.5">
        <span className="type-h6">{label}</span>
        <span className="font-mono text-[11px] text-kumo-subtle tabular-nums">{items.length}</span>
      </h3>
      <ul>
        {items.map((item) => (
          <Row key={item.id} item={item} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}
Group.displayName = "NotificationGroup";

function Row({ item, onOpen }: { item: AppNotification; onOpen: (item: AppNotification) => void }) {
  const IconComponent = ICONS[item.kind];
  const action = ACTIONS[item.kind];
  // `href` is an app path from the API; the router resolves it at runtime.
  const to = item.href as "/";
  return (
    <li className="flex items-center border-b border-kumo-rule transition-colors duration-(--rh-dur-ui) last:border-b-0 hover:bg-kumo-faint">
      <Link
        to={to}
        onClick={() => onOpen(item)}
        className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pr-2 pl-3 focus-visible:outline-offset-[-2px]"
      >
        <IconComponent
          size={16}
          aria-hidden
          className={cn("mt-px shrink-0", ICON_TONE[item.severity])}
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span title={item.title} className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {item.title}
            </span>
            <time
              dateTime={item.createdAt}
              title={new Date(item.createdAt).toLocaleString("en-GB", { hour12: false })}
              className="shrink-0 font-mono text-[11px] text-kumo-subtle tabular-nums"
            >
              {formatAge(item.createdAt)}
            </time>
          </span>
          <span className="line-clamp-2 text-[12px] text-kumo-subtle">{item.body}</span>
          <span className="truncate text-[11px] text-kumo-subtle">{item.projectName}</span>
        </span>
        {/* New / unread: 6px square accent dot (DESIGN.md 10). The slot is always reserved. */}
        <span
          aria-hidden
          className={cn("mt-1.5 size-1.5 shrink-0", !item.read && "bg-accent-500")}
        />
        {!item.read && <span className="sr-only">, unread</span>}
      </Link>
      {action && (
        <Link
          to={to}
          onClick={() => onOpen(item)}
          aria-label={`${action}: ${item.title}`}
          className={cn(buttonVariants({ variant: "secondary", size: "xs" }), "mr-3 shrink-0")}
        >
          {action}
        </Link>
      )}
    </li>
  );
}
Row.displayName = "NotificationRow";
