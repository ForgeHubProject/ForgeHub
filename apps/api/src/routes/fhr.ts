import type { FastifyInstance } from "fastify";
import { officialFormats } from "../fhr/manifest.js";

// Public, unauthenticated projection of the FHR manifest's [formats] table so
// the web app can decide which files get a semantic/rendered view without
// embedding any per-format knowledge of its own. The manifest is the single
// source of truth (#74); this endpoint just serves its extension→handler map.
//
// Response contract: { "formats": { ".gltf": "gltf-scene", … } }. 503 (never a
// 200 with a wrong answer) when no manifest has ever been fetched successfully.
export async function fhrRoutes(app: FastifyInstance) {
  app.get("/fhr/formats", async (_request, reply) => {
    try {
      const formats = await officialFormats();
      return { formats: Object.fromEntries(formats) };
    } catch {
      return reply.status(503).send({ error: "FHR manifest unavailable" });
    }
  });
}
