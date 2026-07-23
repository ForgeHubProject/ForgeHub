/**
 * Shared presentational bits for the Projects experience: self-contained
 * Octicon marks (kept local so the milestones agent's `issues/` churn can't
 * break this feature), the issue/PR state glyph, and small subject helpers.
 * Token-only — no raw hex in chrome.
 */
import type { ProjectItemSubject, ProjectSubjectType } from "../../../types";

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Project board mark — three vertical columns. Used for the tab + list rows. */
export const ProjectIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0zM1.5 1.75v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25zM11.75 3a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75zm-8 0a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 3.75 3zm4 0a.75.75 0 0 1 .75.75v9a.75.75 0 0 1-1.5 0v-9A.75.75 0 0 1 7.75 3z" />
  </Svg>
);

/** Kanban / board view toggle. */
export const BoardIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 1h3.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 5.25 15h-3.5A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1zm9 0h3.5c.966 0 1.75.784 1.75 1.75v6.5A1.75 1.75 0 0 1 14.25 11h-3.5A1.75 1.75 0 0 1 9 9.25v-6.5C9 1.784 9.784 1 10.75 1zM1.5 2.75v10.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25h-3.5a.25.25 0 0 0-.25.25zm9 0v6.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25h-3.5a.25.25 0 0 0-.25.25z" />
  </Svg>
);

/** Table view toggle — a rows glyph. */
export const TableIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0zM1.5 6.5v4h4v-4h-4zm5.5 0v4h7.5v-4H7zm7.5-1.5v-2.5a.25.25 0 0 0-.25-.25H7v2.75h7.5zM5.5 5V2.25H1.75a.25.25 0 0 0-.25.25V5h4zm-4 7.25v1.75c0 .138.112.25.25.25H5.5v-2H1.5zm5.5 0v2h7.25a.25.25 0 0 0 .25-.25v-1.75H7z" />
  </Svg>
);

export const IssueOpenedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
    <path fillRule="evenodd" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0z" />
  </Svg>
);

export const IssueClosedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5z" />
    <path fillRule="evenodd" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-1.5 0a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z" />
  </Svg>
);

export const PullRequestIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.177 3.073 9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zM11 2.5h-1V4h1a1 1 0 0 1 1 1v5.628a2.251 2.251 0 1 0 1.5 0V5A2.5 2.5 0 0 0 11 2.5zm1 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
  </Svg>
);

export const MergeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 9.25v2.378a2.251 2.251 0 1 1-1.5 0V9.25A2.75 2.75 0 0 1 5.45 6.659l-.776-.776a.75.75 0 0 1 1.06-1.06l.716.716v-.385zm.01 5.096a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0zM9.25 5.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
  </Svg>
);

export const KebabIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2z" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25z" />
  </Svg>
);

export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-4 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm4-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM6 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm4-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM6 5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
  </Svg>
);

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086zM11.189 6.25 9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286z" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06z" />
  </Svg>
);

/** The leading state glyph for an issue/PR subject, tinted in its semantic tone. */
export function SubjectStateIcon({ subject, size = 15 }: { subject: NonNullable<ProjectItemSubject>; size?: number }) {
  if (subject.type === "issue") {
    return subject.state === "closed" ? (
      <IssueClosedIcon size={size} className="shrink-0 text-fh-purple-fg" />
    ) : (
      <IssueOpenedIcon size={size} className="shrink-0 text-fh-success-fg" />
    );
  }
  if (subject.state === "merged") return <MergeIcon size={size} className="shrink-0 text-fh-purple-fg" />;
  if (subject.state === "closed") return <PullRequestIcon size={size} className="shrink-0 text-fh-danger-fg" />;
  return <PullRequestIcon size={size} className="shrink-0 text-fh-success-fg" />;
}

/** `#N` for an issue, `!N` for a PR — matching the repo's cross-ref convention. */
export function subjectRef(type: ProjectSubjectType, number: number): string {
  return `${type === "pull" ? "!" : "#"}${number}`;
}

/** Deep link to the underlying issue/PR. */
export function subjectHref(base: string, type: ProjectSubjectType, number: number): string {
  return `${base}/${type === "pull" ? "pulls" : "issues"}/${number}`;
}
