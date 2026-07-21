/**
 * Color math for label chips and contrast checks — no dependency.
 *
 * `readableTextOn` picks black or white ink for an arbitrary label color by
 * WCAG relative luminance, so a `LabelChip` filled with any hue stays legible.
 * The same primitives (`contrastRatio`) back the ratios documented in DESIGN.md.
 */

/** Parse "#rrggbb", "rrggbb", or "#rgb" into an [r,g,b] byte triple, or null. */
export function parseHex(input: string): [number, number, number] | null {
  let h = input.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of an sRGB byte triple (0–1). */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two sRGB byte triples (1–21). */
export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK: [number, number, number] = [17, 24, 32]; // matches --fh-fg (light)
const INK_LIGHT: [number, number, number] = [255, 255, 255];

/**
 * Choose readable ink (near-black or white) for text sitting on `bgHex`.
 * Falls back to dark ink for an unparseable color.
 */
export function readableTextOn(bgHex: string): string {
  const rgb = parseHex(bgHex);
  if (!rgb) return "#111820";
  const onDark = contrastRatio(rgb, INK_LIGHT);
  const onLight = contrastRatio(rgb, INK_DARK);
  return onDark >= onLight ? "#ffffff" : "#111820";
}

/** Format a byte triple as "#rrggbb". */
export function toHex([r, g, b]: [number, number, number]): string {
  const p = (n: number) => n.toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}
