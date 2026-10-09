import { Popover } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { BellButton } from "./bell-button";
import NotificationInbox from "./notification-inbox";

/**
 * The inbox popover (DESIGN.md 8.4): Kumo Popover (Base UI) with focus trapped while open,
 * Escape and outside click to close, and focus returned to the bell. Loaded as its own chunk
 * after first paint (or on first hover, focus, or click), so the shell's first load does not
 * carry the popover or the inbox list. The list itself is read only while the popover is open.
 */
export default function NotificationPopover({
  action,
  unread,
  initialOpen,
  wasFocused,
}: {
  action: number;
  unread: number;
  /** The bell was clicked before this chunk loaded. */
  initialOpen: boolean;
  /** True when the placeholder bell had focus as it was swapped for this one. */
  wasFocused: () => boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  // The swap replaces the focused placeholder: keep keyboard focus on the bell. When opening,
  // the popover moves focus into itself instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount, when the bell is swapped
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!initialOpen && lost && wasFocused()) trigger.current?.focus();
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen} modal="trap-focus">
      <Popover.Trigger
        render={<BellButton ref={trigger} action={action} unread={unread} open={open} />}
      />
      <Popover.Content
        side="bottom"
        align="end"
        // Square overlay without the arrow (DESIGN.md 8.4); the inner list scrolls.
        className="w-[min(400px,calc(100vw-32px))] gap-0 p-0 [&>[data-side]]:hidden"
      >
        <NotificationInbox onClose={() => setOpen(false)} />
      </Popover.Content>
    </Popover>
  );
}
NotificationPopover.displayName = "NotificationPopover";
