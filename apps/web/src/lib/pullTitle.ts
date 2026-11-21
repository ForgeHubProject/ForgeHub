/**
 * The title a new pull request starts with, as GitHub picks it: one commit
 * gives its subject; several give the branch name, dashes and underscores as
 * spaces and the first letter capitalised ("art/keeper-cloak" → "Art/keeper cloak").
 */
export function suggestedPullTitle(commits: readonly { subject: string }[], headRef: string): string {
  if (commits.length === 1 && commits[0]!.subject.trim()) return commits[0]!.subject.trim();
  const words = headRef.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
