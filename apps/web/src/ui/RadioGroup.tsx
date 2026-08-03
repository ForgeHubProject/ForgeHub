import { createContext, useContext } from "react";
import { cx } from "./cx";

type RadioGroupContextValue = {
  name: string;
  value: string;
  onChange: (value: string) => void;
};

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

type RadioGroupProps = {
  /** The shared radio `name` — one per group on the page. */
  name: string;
  /** The currently selected `RadioCard` value. */
  value: string;
  onChange: (value: string) => void;
  /** Optional fieldset legend rendered above the cards. */
  legend?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
};

/**
 * A fieldset of `RadioCard` options (extracted from the create-repo visibility
 * cards, issue #109). The group owns the shared name/value/onChange wiring via
 * context so each card stays a plain declarative option.
 */
export function RadioGroup({ name, value, onChange, legend, className, children }: RadioGroupProps) {
  return (
    <fieldset className={cx("m-0 flex flex-col gap-2 border-0 p-0", className)}>
      {legend && <legend className="mb-1 p-0 text-fh-sm font-semibold text-fh-fg">{legend}</legend>}
      <RadioGroupContext.Provider value={{ name, value, onChange }}>{children}</RadioGroupContext.Provider>
    </fieldset>
  );
}

type RadioCardProps = {
  value: string;
  /** The option's bold one-line title. */
  title: React.ReactNode;
  /** Muted supporting copy under the title. */
  description?: React.ReactNode;
  /** Small functional mark rendered before the title. */
  icon?: React.ReactNode;
  disabled?: boolean;
};

/**
 * One selectable card inside a `RadioGroup`: a real radio input plus a bordered
 * label that highlights with the accent when selected. Must be rendered inside
 * a `RadioGroup`.
 */
export function RadioCard({ value, title, description, icon, disabled }: RadioCardProps) {
  const group = useContext(RadioGroupContext);
  if (!group) throw new Error("RadioCard must be rendered inside a RadioGroup");
  const active = group.value === value;

  return (
    <label
      className={cx(
        "flex items-start gap-3 rounded-md border p-3 transition-colors",
        active ? "border-fh-accent-emphasis bg-fh-accent-subtle" : "border-fh-border",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        !disabled && !active && "hover:bg-fh-surface-muted",
      )}
    >
      <input
        type="radio"
        name={group.name}
        value={value}
        checked={active}
        disabled={disabled}
        onChange={() => group.onChange(value)}
        className="mt-1 accent-fh-accent-emphasis"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-fh-sm font-semibold text-fh-fg">
          {icon}
          {title}
        </span>
        {description && <span className="mt-0.5 block text-fh-xs text-fh-fg-muted">{description}</span>}
      </span>
    </label>
  );
}
