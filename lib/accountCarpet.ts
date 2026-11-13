export type Carpet = { headline: string; caption: string };
export const DEFAULT_CARPET: Carpet = { headline: "KOOPI", caption: "what do you wanna make today?" };

export function parseCarpet(value: unknown): Carpet | null {
  if (!value || typeof value !== "object") return null;
  const { headline, caption } = value as Record<string, unknown>;
  if (typeof headline !== "string" || typeof caption !== "string") return null;
  const result = { headline: headline.trim(), caption: caption.trim() };
  return result.headline.length > 0 && result.headline.length <= 22 && result.caption.length > 0 && result.caption.length <= 46 ? result : null;
}

export function carpetFromMetadata(metadata: Record<string, unknown> | undefined): Carpet | null {
  return parseCarpet(metadata?.koopi_carpet);
}
