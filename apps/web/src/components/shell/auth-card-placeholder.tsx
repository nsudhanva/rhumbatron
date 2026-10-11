import { Link } from "@tanstack/react-router";
import { SkeletonBar } from "../project/feedback";

/**
 * Stands in for Clerk's sign-in or sign-up card until Clerk's script mounts it (the page's
 * `ClerkLoading` state). It has the card's size and title, so the page paints its heading and a
 * line of text with the server HTML instead of a blank area, and nothing moves when the real card
 * takes its place. The fields are inert skeletons: only Clerk's card takes input.
 */
export function AuthCardPlaceholder({
  title,
  subtitle,
  alternate,
}: {
  title: string;
  subtitle: string;
  alternate: { prompt: string; label: string; to: "/sign-in/$" | "/sign-up/$" };
}) {
  return (
    <div className="grid min-h-[456px] w-full max-w-[400px] grid-rows-[1fr_auto] bg-kumo-base shadow-lg">
      <div className="grid content-start gap-6 px-8 pt-8 pb-10 max-[420px]:px-6">
        <div className="grid gap-1 text-center">
          <h1 className="text-[17px] leading-snug font-bold">{title}</h1>
          <p className="text-[13px] text-kumo-subtle">{subtitle}</p>
        </div>
        <p className="text-center text-[13px] leading-relaxed text-kumo-subtle">
          Many agents can propose many futures of one codebase. Only verified evidence can advance
          its canonical state.
        </p>
        <div aria-hidden className="grid gap-4">
          <SkeletonBar height={32} className="w-full" />
          <SkeletonBar height={34} className="w-full" />
          <SkeletonBar height={32} className="w-full" />
        </div>
      </div>
      <p className="border-t border-kumo-rule px-8 py-4 text-center text-[13px] text-kumo-subtle">
        {alternate.prompt}{" "}
        <Link
          to={alternate.to}
          params={{ _splat: "" }}
          className="font-medium text-kumo-default underline underline-offset-2"
        >
          {alternate.label}
        </Link>
      </p>
    </div>
  );
}
