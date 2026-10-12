import { cn } from "@cloudflare/kumo";
import { CheckCircle, Info, Warning, XCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Loader } from "../ui/loader";

export type BannerFamily = "success" | "danger" | "attention" | "progress";

const FAMILY: Record<BannerFamily, string> = {
  success: "bg-kumo-success-tint text-kumo-success",
  danger: "bg-accent-100 text-kumo-danger",
  attention: "bg-kumo-warning-tint text-kumo-warning",
  progress: "bg-kumo-elevated text-kumo-default",
};

function Icon({ family }: { family: BannerFamily }) {
  const props = { size: 16, className: "mt-px shrink-0", "aria-hidden": true } as const;
  if (family === "success") return <CheckCircle {...props} />;
  if (family === "danger") return <XCircle {...props} />;
  if (family === "attention") return <Warning {...props} />;
  return <Info {...props} />;
}

/**
 * Banner: 10 x 14px, 13px weight 600 title, 16px leading icon, optional detail
 * line, optional action on the right (a secondary button that inherits the banner color).
 * `progress` is the elevated family: a Loader replaces the icon and an optional ink bar or
 * step text sits under the title. Errors that block work announce assertively.
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
  /** Progress family only: a 0-1 share of known work, drawn as an ink bar. */
  progress?: number | undefined;
  className?: string;
}) {
  return (
    <div
      role={family === "danger" ? "alert" : "status"}
      aria-live={family === "danger" ? "assertive" : "polite"}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-2.5 text-[13px]",
        FAMILY[family],
        className,
      )}
    >
      <div className="flex min-w-0 flex-[1_1_320px] items-start gap-2.5">
        {family === "progress" ? (
          <Loader size={16} className="mt-px shrink-0" />
        ) : (
          <Icon family={family} />
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="font-semibold">{title}</p>
          {children && <div className="text-pretty font-normal">{children}</div>}
          {family === "progress" && progress !== undefined && (
            <div aria-hidden className="mt-1 h-1 bg-kumo-recessed">
              <div
                className="h-full bg-kumo-ink transition-[width] duration-(--rh-dur-bar)"
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
