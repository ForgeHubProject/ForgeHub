/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ForgeHub palette — warm "forge/ember" identity (orange accent, warm
        // near-black chrome) deliberately distinct from GitHub's cool blue/gray.
        gh: {
          bg: "#fafaf9",
          canvas: "#ffffff",
          border: "#e7e5e4",
          "border-muted": "#f5f5f4",
          header: "#1c1917",
          "header-text": "#fafaf9",
          "header-muted": "#a8a29e",
          text: "#1c1917",
          muted: "#78716c",
          accent: "#ea580c",
          "accent-hover": "#c2410c",
          "accent-muted": "#ffedd5",
          success: "#15803d",
          "success-muted": "#dcfce7",
          danger: "#dc2626",
          "danger-muted": "#fee2e2",
          warning: "#a16207",
          "warning-muted": "#fef9c3",
          purple: "#7c3aed",
          "purple-muted": "#f3e8ff",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Noto Sans", "Helvetica", "Arial", "sans-serif"],
        mono: ['"SFMono-Regular"', "Consolas", '"Liberation Mono"', "Menlo", "monospace"],
      },
      fontSize: {
        "gh-xs": ["11px", "16px"],
        "gh-sm": ["12px", "18px"],
        "gh-base": ["14px", "21px"],
        "gh-lg": ["16px", "24px"],
        "gh-xl": ["20px", "28px"],
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
};
