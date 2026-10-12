import type { FastifyInstance } from "fastify";
import { handlerBuilds, officialFormats } from "../fhr/manifest.js";

// Public, unauthenticated projection of the FHR manifest's [formats] table so
// the web app can decide which files get a semantic/rendered view without
// embedding any per-format knowledge of its own. The manifest is the single
// source of truth (#74); this endpoint just serves its extension→handler map,
// and each handler's current build — which the web app puts in a renderer
// bundle's URL (/renderers/<build>/<id>) so a new build is never answered from
// the browser's cache of the old one.
//
// Response contract: { "formats": { ".gltf": "gltf-scene", … },
// "builds": { "gltf-scene": "e520cc6", … } }; a handler with no stamped build
// is absent from "builds". 503 (never a 200 with a wrong answer) when no
// manifest has ever been fetched successfully.
export async function fhrRoutes(app: FastifyInstance) {
  app.get("/fhr/formats", async (_request, reply) => {
    try {
      const [formats, builds] = await Promise.all([officialFormats(), handlerBuilds()]);
      return { formats: Object.fromEntries(formats), builds: Object.fromEntries(builds) };
    } catch {
      return reply.status(503).send({ error: "FHR manifest unavailable" });
    }
  });
}
