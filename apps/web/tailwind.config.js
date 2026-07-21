/** @type {import('tailwindcss').Config} */

// Every FH color is a CSS custom property holding a space-separated RGB triple,
// so the `<alpha-value>` slot lets opacity utilities (bg-fh-surface/50) work.
// Light values live on :root and dark on `.dark` in src/index.css.
const v = (name) => `rgb(var(--fh-${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── FH design tokens (preferred namespace) ──────────────────────────
        fh: {
          canvas: v("canvas"),
          surface: v("surface"),
          "surface-muted": v("surface-muted"),
          "surface-inset": v("surface-inset"),
          border: v("border"),
          "border-muted": v("border-muted"),
          "border-strong": v("border-strong"),
          fg: v("fg"),
          "fg-muted": v("fg-muted"),
          "fg-subtle": v("fg-subtle"),
          "fg-placeholder": v("fg-placeholder"),
          "accent-fg": v("accent-fg"),
          "accent-emphasis": v("accent-emphasis"),
          "accent-emphasis-hover": v("accent-emphasis-hover"),
          "accent-muted": v("accent-muted"),
          "accent-subtle": v("accent-subtle"),
          "on-emphasis": v("on-emphasis"),
          "success-fg": v("success-fg"),
          "success-emphasis": v("success-emphasis"),
          "success-muted": v("success-muted"),
          "danger-fg": v("danger-fg"),
          "danger-emphasis": v("danger-emphasis"),
          "danger-muted": v("danger-muted"),
          "warning-fg": v("warning-fg"),
          "warning-emphasis": v("warning-emphasis"),
          "warning-muted": v("warning-muted"),
          "purple-fg": v("purple-fg"),
          "purple-emphasis": v("purple-emphasis"),
          "purple-muted": v("purple-muted"),
          "neutral-muted": v("neutral-muted"),
          header: {
            bg: v("header-bg"),
            text: v("header-text"),
            muted: v("header-muted"),
            border: v("header-border"),
            accent: v("header-accent"),
          },
        },

        // ── Legacy `gh.*` aliases (migration bridge) ─────────────────────────
        // Kept working so not-yet-migrated pages don't break; they now inherit
        // the FH palette and dark mode for free. Page agents should migrate to
        // `fh.*` + the ui/ primitives cluster by cluster, then these can go.
        gh: {
          bg: v("canvas"),
          canvas: v("surface"),
          border: v("border"),
          "border-muted": v("border-muted"),
          header: v("header-bg"),
          "header-text": v("header-text"),
          "header-muted": v("header-muted"),
          text: v("fg"),
          muted: v("fg-muted"),
          accent: v("accent-fg"),
          "accent-hover": v("accent-emphasis-hover"),
          "accent-muted": v("accent-muted"),
          success: v("success-fg"),
          "success-muted": v("success-muted"),
          danger: v("danger-fg"),
          "danger-muted": v("danger-muted"),
          warning: v("warning-fg"),
          "warning-muted": v("warning-muted"),
          purple: v("purple-fg"),
          "purple-muted": v("purple-muted"),
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Noto Sans", "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", '"SFMono-Regular"', '"SF Mono"', "Menlo", "Consolas", '"Liberation Mono"', "monospace"],
      },
      fontSize: {
        // GitHub-density type scale, exposed under both fh- and gh- prefixes.
        "fh-xs": ["11px", "16px"],
        "fh-sm": ["12px", "18px"],
        "fh-base": ["14px", "20px"],
        "fh-lg": ["16px", "24px"],
        "fh-xl": ["20px", "28px"],
        "fh-2xl": ["24px", "32px"],
        "gh-xs": ["11px", "16px"],
        "gh-sm": ["12px", "18px"],
        "gh-base": ["14px", "21px"],
        "gh-lg": ["16px", "24px"],
        "gh-xl": ["20px", "28px"],
      },
      boxShadow: {
        overlay: "var(--fh-shadow-overlay)",
        "fh-sm": "var(--fh-shadow-sm)",
      },
      keyframes: {
        "fh-spin": { to: { transform: "rotate(360deg)" } },
        "fh-fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fh-pop-in": {
          from: { opacity: "0", transform: "translateY(-4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "fh-toast-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fh-spin": "fh-spin 0.7s linear infinite",
        "fh-fade-in": "fh-fade-in 0.12s ease-out",
        "fh-pop-in": "fh-pop-in 0.12s ease-out",
        "fh-toast-in": "fh-toast-in 0.16s ease-out",
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
};
