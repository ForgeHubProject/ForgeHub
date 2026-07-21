import { forwardRef, useId } from "react";
import { cx } from "./cx";
import { ChevronDownIcon } from "./icons";

/** Shared control chrome: border, surface, and the accent focus ring. */
const controlBase =
  "w-full text-fh-base bg-fh-surface text-fh-fg border border-fh-border rounded-md " +
  "placeholder:text-fh-fg-placeholder outline-none transition-[border-color,box-shadow] duration-100 " +
  "focus:border-fh-accent-emphasis focus:shadow-[0_0_0_3px_rgb(var(--fh-accent-emphasis)/0.3)] " +
  "disabled:opacity-60 disabled:cursor-not-allowed " +
  "aria-[invalid=true]:border-fh-danger-emphasis aria-[invalid=true]:focus:shadow-[0_0_0_3px_rgb(var(--fh-danger-emphasis)/0.3)]";

type TextInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  sizing?: "sm" | "md";
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, invalid, sizing = "md", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(controlBase, sizing === "sm" ? "h-6 px-2" : "h-8 px-3", className)}
      {...rest}
    />
  );
});

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(controlBase, "px-3 py-1.5 resize-y leading-normal", className)}
      {...rest}
    />
  );
});

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  sizing?: "sm" | "md";
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, sizing = "md", children, ...rest },
  ref,
) {
  return (
    <div className="relative inline-flex w-full">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cx(
          controlBase,
          "appearance-none pr-8 cursor-pointer",
          sizing === "sm" ? "h-6 pl-2" : "h-8 pl-3",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fh-fg-muted"
      />
    </div>
  );
});

type FieldProps = {
  label: string;
  htmlFor?: string;
  /** Marks the control required with a subtle asterisk. */
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  /**
   * Render-prop receiving the generated id so the label's `htmlFor` and the
   * control's `id` stay wired even when the caller doesn't supply one.
   */
  children: (id: string) => React.ReactNode;
};

/** Labeled form row: label + optional hint/error, wired for accessibility. */
export function Field({ label, htmlFor, required, hint, error, className, children }: FieldProps) {
  const generated = useId();
  const id = htmlFor ?? generated;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-fh-sm font-semibold text-fh-fg">
        {label}
        {required && <span className="text-fh-danger-fg ml-0.5">*</span>}
      </label>
      {children(id)}
      {error ? (
        <p className="text-fh-xs text-fh-danger-fg">{error}</p>
      ) : hint ? (
        <p className="text-fh-xs text-fh-fg-muted">{hint}</p>
      ) : null}
    </div>
  );
}
