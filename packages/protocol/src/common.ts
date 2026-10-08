import { z } from "zod";

export const RiskTier = z.enum(["low", "medium", "high", "critical"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const Complexity = z.enum(["small", "medium", "large"]);
export type Complexity = z.infer<typeof Complexity>;

export const ModelTier = z.enum(["haiku", "sonnet", "opus"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** Monotonic Canonical Generation number. Displayed as `S<n>`. */
export const CanonicalGeneration = z.number().int().nonnegative();
export type CanonicalGeneration = z.infer<typeof CanonicalGeneration>;

/** Colon-separated semantic resource key, for example `project:acme:wishlist:membership`. */
export const SemanticResource = z
  .string()
  .regex(/^[a-z0-9-]+(:[a-z0-9-]+)+$/, "semantic resource must be colon-separated kebab-case");
export type SemanticResource = z.infer<typeof SemanticResource>;

export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;
