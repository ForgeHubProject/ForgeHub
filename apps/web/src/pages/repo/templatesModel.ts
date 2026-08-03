import type { Label } from "../../types";

/**
 * Pure helpers for the repo-provided compose templates (issue #89). Kept free of
 * React so they unit-test like `reviewersModel.ts`.
 */

/**
 * Resolve a template's front-matter label NAMES against the repo's actual `Label`
 * rows — the API returns names because a template is just text in the repo, and
 * only labels that really exist can be applied. Matching is case-insensitive and
 * whitespace-tolerant; unknown names are dropped silently (a stale template must
 * not block issue creation). Order follows the template, de-duped.
 */
export function resolveTemplateLabels(allLabels: Label[], names: string[]): Label[] {
  const byName = new Map(allLabels.map((l) => [l.name.trim().toLowerCase(), l]));
  const resolved: Label[] = [];
  for (const name of names) {
    const label = byName.get(name.trim().toLowerCase());
    if (label && !resolved.some((l) => l.id === label.id)) resolved.push(label);
  }
  return resolved;
}

/**
 * Should a fetched template overwrite what's already in the compose box? Only
 * when the box still holds exactly what the last template put there (or nothing
 * at all) — never clobber text the author typed.
 */
export function canReplaceBody(current: string, lastApplied: string | null): boolean {
  return current.trim() === "" || current === lastApplied;
}
