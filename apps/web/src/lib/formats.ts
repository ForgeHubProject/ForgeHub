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

/** Which handler ids make up each family (mirrors the API's FORMAT_FAMILIES). */
export const FORMAT_FAMILIES: Record<string, string[]> = {
  psd: ["psd"],
  figcraft: ["figcraft"],
  "3d": ["gltf-scene", "obj", "stl", "ply", "3mf", "off", "dae", "x3d", "fbx", "usd", "3ds", "blend", "amf", "vrml"],
  cad: ["dxf"],
  images: ["png", "jpeg", "gif", "svg"],
  data: ["csv", "geojson"],
  notebooks: ["ipynb"],
  audio: ["wav"],
};

/** The families a set of handler ids touches, in the families' order. */
export function familiesOf(formats: string[]): string[] {
  return Object.entries(FORMAT_FAMILIES).filter(([, ids]) => ids.some((id) => formats.includes(id))).map(([f]) => f);
}

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
