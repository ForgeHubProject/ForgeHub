/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        gh: {
          bg: "#f6f8fa",
          canvas: "#ffffff",
          border: "#d0d7de",
          "border-muted": "#eaeef2",
          header: "#24292f",
          "header-text": "#f0f6fc",
          "header-muted": "#8b949e",
          text: "#1f2328",
          muted: "#656d76",
          accent: "#0969da",
          "accent-hover": "#0860ca",
          "accent-muted": "#ddf4ff",
          success: "#1a7f37",
          "success-muted": "#d1f8e0",
          danger: "#d1242f",
          "danger-muted": "#ffd8d3",
          warning: "#9a6700",
          "warning-muted": "#fff8c5",
          purple: "#8250df",
          "purple-muted": "#fbefff",
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
