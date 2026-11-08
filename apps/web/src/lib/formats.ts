/**
 * Format names for Explore (#257). The families mirror the API's
 * FORMAT_FAMILIES (repo-formats.ts); badges name a single official handler id.
 */
export const FORMAT_FAMILY_LABELS: Record<string, string> = {
  psd: "Photoshop",
  figcraft: "FigCraft",
  "3d": "3D models",
  cad: "CAD",
  images: "Images",
  data: "Data",
  notebooks: "Notebooks",
  audio: "Audio",
};

const HANDLER_LABELS: Record<string, string> = {
  "gltf-scene": "glTF",
  figcraft: "FigCraft",
  geojson: "GeoJSON",
  ipynb: "Notebook",
  vrml: "VRML",
  blend: "Blender",
};

/** A short badge label for an official handler id: "psd" → "PSD", "gltf-scene" → "glTF". */
export function formatLabel(handlerId: string): string {
  return HANDLER_LABELS[handlerId] ?? handlerId.toUpperCase();
}
