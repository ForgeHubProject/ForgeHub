import "@fastify/jwt";
import "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PatScope } from "./scopes.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Scopes of the PAT that authenticated this request (issue #87), or null when
     * the caller is a session/JWT — sessions are unscoped (full power). Consulted
     * by the `requireScope` preHandler.
     */
    patScopes: PatScope[] | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuthenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** PreHandler factory: 403 unless the authenticated PAT grants `scope`. */
    requireScope: (scope: PatScope) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
