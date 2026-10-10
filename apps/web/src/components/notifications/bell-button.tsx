import { cn } from "@cloudflare/kumo";
import { Bell } from "@phosphor-icons/react";
import { type ComponentPropsWithRef, forwardRef } from "react";
import { formatBadge } from "./notification-keys";

type BellButtonProps = ComponentPropsWithRef<"button"> & {
  /** Open action items: danger badge. */
  action: number;
  /** Unread items: ink badge when nothing needs a decision. */
  unread: number;
  open?: boolean;
};

/**
 * The square header bell (DESIGN.md 6.1, 8.2 segmented-control frame). Rendered before the
 * popover code loads and, unchanged, as the popover trigger afterwards. The badge is absolutely
 * placed inside the fixed 28px (44px coarse) box, so a count never moves the header.
 */
export const BellButton = forwardRef<HTMLButtonElement, BellButtonProps>(function BellButton(
  { action, unread, open = false, className, ...rest },
  ref,
) {
  const badge = action > 0 ? action : unread;
  const name = [
    "Notifications",
    action > 0 ? `${action} ${action === 1 ? "needs" : "need"} you` : null,
    unread > 0 ? `${unread} unread` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      ref={ref}
      type="button"
      title="Notifications"
      aria-label={name}
      {...rest}
      className={cn(
        "relative grid size-7 shrink-0 place-items-center rounded-md border border-kumo-line transition-colors duration-(--rh-dur-ui) focus-visible:outline-offset-[-2px] pointer-coarse:size-11",
        open ? "bg-kumo-info-tint text-kumo-info" : "hover:bg-kumo-tint",
        className,
      )}
    >
      <Bell size={16} aria-hidden />
      {badge > 0 && (
        <span
          aria-hidden
          className={cn(
            "absolute -top-2 -right-2 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[12px] leading-none font-semibold text-white tabular-nums ring-2 ring-kumo-base",
            action > 0 ? "bg-kumo-danger" : "bg-kumo-info",
          )}
        >
          {formatBadge(badge)}
        </span>
      )}
    </button>
  );
});
BellButton.displayName = "BellButton";
