import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { resolveRepo } from "../repo-access.js";
import { createWebhookBodySchema, updateWebhookBodySchema } from "../validation.js";
import { pingWebhook, redeliverWebhookDelivery } from "../webhook-service.js";

/**
 * Owner-only outbound-webhook management (issue #87), mounted under
 * `/repos/:handle/:name/hooks`. Managing hooks is an `admin`-scoped, owner-only
 * action; the deliveries log + redeliver endpoint are what make a hook
 * debuggable. The `secret` is write-only: it is never returned once stored.
 */

type HookRow = { id: string; url: string; events: string; active: boolean; createdAt: Date; updatedAt: Date };

function publicHook(h: HookRow) {
  return {
    id: h.id,
    url: h.url,
    events: h.events === "*" ? ["*"] : h.events.split(",").filter(Boolean),
    active: h.active,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

type DeliveryRow = {
  id: string; event: string; statusCode: number | null; ok: boolean;
  durationMs: number; error: string | null; redeliveredFromId: string | null; createdAt: Date;
};

function publicDelivery(d: DeliveryRow) {
  return {
    id: d.id,
    event: d.event,
    statusCode: d.statusCode,
    ok: d.ok,
    durationMs: d.durationMs,
    error: d.error,
    redeliveredFromId: d.redeliveredFromId,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Serialize the requested events to the stored column form ("*" = all). */
function serializeEvents(events: string[] | undefined): string {
  if (!events || events.length === 0) return "*";
  return [...new Set(events)].join(",");
}

export async function webhookRoutes(app: FastifyInstance) {
  const admin = app.requireScope("admin");

  // Resolve the repo and assert the caller is its owner. Returns the repo or sends
  // a response and returns null.
  async function ownerRepo(request: FastifyRequest, reply: FastifyReply) {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = request.user.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo) {
      reply.status(404).send({ error: "Not found" });
      return null;
    }
    if (repo.ownerId !== userId) {
      // Don't reveal private repos to non-owners; owners of public repos get 403.
      reply.status(repo.visibility === "PRIVATE" ? 404 : 403).send({ error: "Only the repository owner can manage webhooks" });
      return null;
    }
    return repo;
  }

  // GET /repos/:handle/:name/hooks — list hooks (owner only)
  app.get("/repos/:handle/:name/hooks", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const hooks = await prisma.webhook.findMany({ where: { repoId: repo.id }, orderBy: { createdAt: "desc" } });
    return { hooks: hooks.map(publicHook) };
  });

  // POST /repos/:handle/:name/hooks — create a hook + fire a ping
  app.post("/repos/:handle/:name/hooks", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;

    const parsed = createWebhookBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const hook = await prisma.webhook.create({
      data: {
        repoId: repo.id,
        url: parsed.data.url,
        secret: parsed.data.secret,
        events: serializeEvents(parsed.data.events),
        active: parsed.data.active ?? true,
      },
    });

    // Fire-and-forget ping so the deliveries log immediately shows reachability.
    void pingWebhook(hook.id);

    return reply.status(201).send(publicHook(hook));
  });

  // PATCH /repos/:handle/:name/hooks/:id — update url / secret / events / active
  app.patch("/repos/:handle/:name/hooks/:id", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const { id } = request.params as { id: string };

    const hook = await prisma.webhook.findFirst({ where: { id, repoId: repo.id } });
    if (!hook) return reply.status(404).send({ error: "Webhook not found" });

    const parsed = updateWebhookBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const updated = await prisma.webhook.update({
      where: { id },
      data: {
        ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
        ...(parsed.data.secret !== undefined ? { secret: parsed.data.secret } : {}),
        ...(parsed.data.events !== undefined ? { events: serializeEvents(parsed.data.events) } : {}),
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      },
    });
    return publicHook(updated);
  });

  // DELETE /repos/:handle/:name/hooks/:id
  app.delete("/repos/:handle/:name/hooks/:id", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const { id } = request.params as { id: string };

    const hook = await prisma.webhook.findFirst({ where: { id, repoId: repo.id } });
    if (!hook) return reply.status(404).send({ error: "Webhook not found" });

    await prisma.webhook.delete({ where: { id } });
    return reply.status(204).send();
  });

  // GET /repos/:handle/:name/hooks/:id/deliveries — recent delivery attempts
  app.get("/repos/:handle/:name/hooks/:id/deliveries", { preHandler: [app.authenticate, admin] }, async (request, reply) => {
    const repo = await ownerRepo(request, reply);
    if (!repo) return reply;
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };

    const hook = await prisma.webhook.findFirst({ where: { id, repoId: repo.id } });
    if (!hook) return reply.status(404).send({ error: "Webhook not found" });

    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: "desc" },
      take,
    });
    return { deliveries: deliveries.map(publicDelivery) };
  });

  // POST /repos/:handle/:name/hooks/:id/deliveries/:deliveryId/redeliver
  app.post(
    "/repos/:handle/:name/hooks/:id/deliveries/:deliveryId/redeliver",
    { preHandler: [app.authenticate, admin] },
    async (request, reply) => {
      const repo = await ownerRepo(request, reply);
      if (!repo) return reply;
      const { id, deliveryId } = request.params as { id: string; deliveryId: string };

      const source = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, webhookId: id, webhook: { repoId: repo.id } },
      });
      if (!source) return reply.status(404).send({ error: "Delivery not found" });

      const redelivered = await redeliverWebhookDelivery(deliveryId);
      if (!redelivered) return reply.status(404).send({ error: "Delivery not found" });
      return reply.status(201).send(publicDelivery(redelivered));
    },
  );
}
