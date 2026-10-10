import { cn } from "@cloudflare/kumo";
import { CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Loader } from "../ui/loader";

export type BannerFamily = "success" | "danger" | "attention" | "progress";

/* Tint fill, family-colored text and a 1px border in the family color at 30%. */
const FAMILY: Record<BannerFamily, string> = {
  success: "border-kumo-success/30 bg-kumo-success-tint text-kumo-success",
  danger: "border-kumo-danger/30 bg-kumo-danger-tint text-kumo-danger",
  attention: "border-kumo-warning/30 bg-kumo-warning-tint text-kumo-warning",
  progress: "border-kumo-info/30 bg-kumo-info-tint text-kumo-info",
};

function Icon({ family }: { family: Exclude<BannerFamily, "progress"> }) {
  const props = { size: 16, className: "mt-0.5 shrink-0", "aria-hidden": true } as const;
  if (family === "success") return <CheckCircle {...props} />;
  if (family === "danger") return <XCircle {...props} />;
  return <WarningCircle {...props} />;
}

/**
 * Banner: 8px radius, tint fill with a 1px border in the family color, 14px weight 600 title,
 * 16px leading icon (CheckCircle, XCircle, WarningCircle), optional detail line, optional
 * action on the right (a secondary button). `progress` is the blue "in progress" family: the
 * spinning Loader replaces the icon and an optional bar sits under the title. Errors that block
 * work announce assertively.
 */
export function Banner({
  family,
  title,
  children,
  action,
  progress,
  className,
}: {
  family: BannerFamily;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode | undefined;
  /** Progress family only: a 0-1 share of known work, drawn as a blue bar. */
  progress?: number | undefined;
  className?: string;
}) {
  return (
    <div
      role={family === "danger" ? "alert" : "status"}
      aria-live={family === "danger" ? "assertive" : "polite"}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-[14px] leading-5",
        FAMILY[family],
        className,
      )}
    >
      <div className="flex min-w-0 flex-[1_1_320px] items-start gap-2.5">
        {family === "progress" ? (
          <Loader size={16} className="mt-0.5 shrink-0" />
        ) : (
          <Icon family={family} />
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="font-semibold">{title}</p>
          {children && <div className="text-pretty font-normal text-kumo-default">{children}</div>}
          {family === "progress" && progress !== undefined && (
            <div aria-hidden className="mt-1 h-1 rounded-full bg-kumo-elevated">
              <div
                className="h-full rounded-full bg-kumo-info transition-[width] duration-(--rh-dur-bar)"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
Banner.displayName = "CandidateBanner";
