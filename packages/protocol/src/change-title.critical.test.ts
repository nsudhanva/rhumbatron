// Every Change shows a short title in lists and breadcrumbs. The fallback must stay short and
// readable for the long goals people type (examples from prod), and never return an empty title.
import { describe, expect, it } from "vitest";
import { changeTitle, clampTitle, fallbackTitle, MAX_TITLE_CHARS } from "./change-title.ts";

describe("fallbackTitle", () => {
  it.each([
    [
      "the idea is gta6 mission planner, we want a calendar that will tell us which mission to play on which day, each day has a kanban list",
      "Gta6 mission planner",
    ],
    ["Add kanban feature", "Add kanban feature"],
    [
      "The UI is not good. Use angularJS with any CSS framework and make it look presentable",
      "Use angularJS with any CSS framework",
    ],
    [
      "The UI sucks, use React js and Tailwind with some popular library to make it beautiful",
      "Use React js and Tailwind",
    ],
    [
      "Build a simple todo list app. The home page lists todos; each todo has a title and a done flag.",
      "Build a simple todo list app",
    ],
    ["make it better", "Make it better"],
    ["Can you please add dark mode?", "Add dark mode"],
    ["Edit src/app.ts", "Edit src/app.ts"],
  ])("%s", (goal, title) => {
    expect(fallbackTitle(goal)).toBe(title);
  });

  it("stays within the limits and never returns an empty title", () => {
    const long = fallbackTitle(`Add ${"supercalifragilistic ".repeat(10)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(fallbackTitle("x".repeat(200)).length).toBe(MAX_TITLE_CHARS);
    expect(fallbackTitle("The UI sucks")).toBe("The UI sucks");
    expect(fallbackTitle("...")).toBe("Untitled change");
  });
});

describe("changeTitle", () => {
  it("prefers the stored title, cut at a word boundary, and falls back to the goal", () => {
    expect(changeTitle("React and Tailwind redesign.", "The UI sucks")).toBe(
      "React and Tailwind redesign",
    );
    expect(changeTitle(null, "make it better")).toBe("Make it better");
    expect(changeTitle("   ", "Add kanban feature")).toBe("Add kanban feature");
    const cut = clampTitle("A planner title that is much longer than forty eight characters");
    expect(cut).toBe("A planner title that is much longer than forty");
    expect(clampTitle("Cart and wishlist sync with offline mode and")).toBe(
      "Cart and wishlist sync with offline mode and",
    );
    expect(clampTitle("Shared wishlists with collaborator links and revocable sharing")).toBe(
      "Shared wishlists with collaborator links",
    );
  });
});
