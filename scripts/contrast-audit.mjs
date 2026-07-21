// Compute WCAG 2.1 contrast ratios for the FH token combos, from the exact
// RGB triples in apps/web/src/index.css.
const T = {
  light: {
    canvas: [246, 248, 251], surface: [255, 255, 255], "surface-muted": [238, 242, 247],
    border: [213, 221, 230], "border-strong": [194, 204, 214],
    fg: [17, 24, 32], "fg-muted": [88, 102, 117], "fg-subtle": [107, 120, 133], "fg-placeholder": [139, 151, 164],
    "accent-fg": [11, 111, 150], "accent-emphasis": [11, 127, 171], "on-emphasis": [255, 255, 255],
    "success-fg": [19, 122, 75], "danger-fg": [194, 53, 47], "warning-fg": [143, 98, 0], "purple-fg": [122, 68, 214],
  },
  dark: {
    canvas: [11, 15, 20], surface: [17, 22, 29], "surface-muted": [22, 29, 38],
    border: [36, 46, 58], "border-strong": [50, 65, 82],
    fg: [230, 237, 243], "fg-muted": [147, 161, 176], "fg-subtle": [125, 139, 154], "fg-placeholder": [106, 120, 135],
    "accent-fg": [57, 192, 232], "accent-emphasis": [57, 192, 232], "on-emphasis": [4, 20, 29],
    "success-fg": [63, 178, 127], "danger-fg": [240, 115, 107], "warning-fg": [216, 166, 58], "purple-fg": [168, 132, 243],
  },
  header: {
    "header-bg": [13, 18, 25], "header-text": [231, 237, 243], "header-muted": [154, 167, 180], "header-accent": [57, 192, 232],
  },
};
const hex = ([r, g, b]) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const la = L(a), lb = L(b); const [hi, lo] = la >= lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
const pass = (r, large) => (r >= (large ? 3 : 4.5) ? "AA" : r >= 3 ? "AA (large)" : "FAIL");

function row(theme, fgName, bgName, large = false) {
  const set = T[theme === "header" ? "header" : theme];
  const fg = set[fgName], bg = set[bgName];
  const r = ratio(fg, bg);
  return `| ${theme} | ${fgName} \`${hex(fg)}\` | ${bgName} \`${hex(bg)}\` | ${r.toFixed(2)}:1 | ${pass(r, large)} |`;
}

const combos = [
  ["light", "fg", "canvas"], ["light", "fg", "surface"],
  ["light", "fg-muted", "surface"], ["light", "fg-muted", "canvas"], ["light", "fg-subtle", "surface"],
  ["light", "accent-fg", "surface"], ["light", "accent-fg", "canvas"],
  ["light", "on-emphasis", "accent-emphasis"],
  ["light", "success-fg", "surface"], ["light", "danger-fg", "surface"], ["light", "warning-fg", "surface"], ["light", "purple-fg", "surface"],
  ["dark", "fg", "canvas"], ["dark", "fg", "surface"],
  ["dark", "fg-muted", "surface"], ["dark", "fg-muted", "canvas"], ["dark", "fg-subtle", "surface"],
  ["dark", "accent-fg", "surface"], ["dark", "accent-fg", "canvas"],
  ["dark", "on-emphasis", "accent-emphasis"],
  ["dark", "success-fg", "surface"], ["dark", "danger-fg", "surface"], ["dark", "warning-fg", "surface"], ["dark", "purple-fg", "surface"],
  ["header", "header-text", "header-bg"], ["header", "header-muted", "header-bg"], ["header", "header-accent", "header-bg"],
];
console.log("| Theme | Foreground | Background | Ratio | WCAG |");
console.log("| --- | --- | --- | --- | --- |");
for (const c of combos) console.log(row(...c));
