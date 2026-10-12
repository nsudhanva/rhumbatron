import type { AccessStatus } from "@rhumbatron/protocol";
import { EMPTY } from "../../lib/format";
import { displayTimeZone } from "../../lib/render-time";
import { StatusPill } from "../ui/status-pill";

/** `2026-10-12 14:03:09` in the display time zone (24-hour clock). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY;
  const timeZone = displayTimeZone();
  const zone = timeZone ? { timeZone } : {};
  const day = date.toLocaleDateString("en-CA", zone);
  const time = date.toLocaleTimeString("en-GB", { hour12: false, ...zone });
  return `${day} ${time}`;
}

/** `2026-10-12` in the display time zone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY;
  const timeZone = displayTimeZone();
  return date.toLocaleDateString("en-CA", timeZone ? { timeZone } : {});
}

const ACCESS_LABEL: Record<AccessStatus, string> = {
  approved: "Approved",
  pending: "Waiting",
  declined: "Declined",
};

/** Access status of an account: Approved, Waiting (for a decision) or Declined. */
export function AccessPill({ status }: { status: AccessStatus }) {
  const family = status === "approved" ? "ok" : status === "pending" ? "attention" : "danger";
  return <StatusPill status={status} label={ACCESS_LABEL[status]} family={family} />;
}
AccessPill.displayName = "AccessPill";
