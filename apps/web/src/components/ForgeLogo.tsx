type Props = {
  size?: number;
  className?: string;
};

/**
 * ForgeHub brand mark — a forge flame with a cut-out ember, in the app's own
 * identity (not a borrowed GitHub octocat). Uses `currentColor`, so it takes on
 * the surrounding text color (the cyan header accent in the top bar, the accent
 * ink elsewhere). The ember is negative space via `fillRule="evenodd"`, so the
 * mark stays crisp in any single color.
 */
export function ForgeLogo({ size = 24, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.55 1.2a1 1 0 0 1 1.1.28c1.02 1.2 1.62 2.2 2.5 3.36.9 1.2 2.02 2.42 2.94 3.86C20.02 10.14 20.75 12 20.75 14.2A8.75 8.75 0 0 1 3.25 14.2c0-2.02.86-3.7 1.9-5.06a1 1 0 0 1 1.72.34c.13.5.35.9.63 1.2.2-1.9.86-3.62 1.73-5.16.9-1.6 2.05-2.98 3.24-4.12a1 1 0 0 1 .08-.2Zm-.36 10.03a4.25 4.25 0 1 0 3.02 1.25 4.2 4.2 0 0 0-1.6-1c.13.5.2 1 .2 1.5a2.62 2.62 0 0 1-4.13 2.14 2.62 2.62 0 0 1 .34-4.5c.5-.24 1.06-.35 1.62-.32a4.3 4.3 0 0 0 .53.83Z"
      />
    </svg>
  );
}
