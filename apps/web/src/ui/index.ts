/**
 * ForgeHub UI primitives — the single import surface for page code.
 *
 * Migration contract for page agents: build pages from these primitives and the
 * semantic `fh-*` / legacy `gh-*` Tailwind tokens only. No raw hex, no bespoke
 * one-off buttons/inputs. See apps/web/DESIGN.md for the full catalog and rules.
 */
export { cx } from "./cx";
export type { ClassValue } from "./cx";

export { parseHex, relativeLuminance, contrastRatio, readableTextOn, toHex } from "./color";

export { ThemeProvider, useTheme } from "./theme";
export type { ThemeMode, ResolvedTheme } from "./theme";

export { Button } from "./Button";
export type { ButtonVariant, ButtonSize } from "./Button";

export { TabNav, TabItem } from "./TabNav";
export { Badge, LabelChip } from "./Badge";
export type { BadgeTone } from "./Badge";
export { Avatar } from "./Avatar";

export { DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel } from "./DropdownMenu";
export { Dialog } from "./Dialog";
export { ConfirmDialog } from "./ConfirmDialog";

export { TextInput, Textarea, Select, Field } from "./Field";

export { EmptyState } from "./EmptyState";
export { Spinner } from "./Spinner";
export { Skeleton } from "./Skeleton";
export { Tooltip } from "./Tooltip";
export { Breadcrumbs } from "./Breadcrumbs";
export type { Crumb } from "./Breadcrumbs";
export { PageHeading } from "./PageHeading";
export { Pagination } from "./Pagination";
export { RelativeTime } from "./RelativeTime";

export { ToastProvider, useToast } from "./Toast";
export type { ToastTone, ToastOptions } from "./Toast";

export * as Icons from "./icons";
