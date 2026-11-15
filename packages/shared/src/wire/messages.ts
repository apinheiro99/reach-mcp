// Frames of the Server-Client conversation. Compatibility is a gate on the two actual build identifiers carried in
// the handshake; there is no protocol number, no SemVer parsing and no negotiation: the Server either accepts the
// client build or rejects it with INCOMPATIBLE_BUILD. After the handshake the credential is never sent again.
import { z } from "zod";
import { WireError } from "./errors.ts";
import { BuildId, ClientId, Credential, ProjectId, RequestId } from "./ids.ts";
import { Operation, OperationResult } from "./operations.ts";
import { PolicySync } from "./policy.ts";

export const ClientHello = z.strictObject({ kind: z.literal("hello"), client_id: ClientId, credential: Credential, client_build: BuildId });
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerWelcome = z.strictObject({ kind: z.literal("welcome"), server_build: BuildId, compatible: z.literal(true) });
export type ServerWelcome = z.infer<typeof ServerWelcome>;

/** A refused handshake: authentication, duplicate identity or incompatible build, always as the compact error. */
export const ServerReject = z.strictObject({ kind: z.literal("reject"), server_build: BuildId.optional(), error: WireError });
export type ServerReject = z.infer<typeof ServerReject>;

export const HandshakeReply = z.discriminatedUnion("kind", [ServerWelcome, ServerReject]);
export type HandshakeReply = z.infer<typeof HandshakeReply>;

export const RequestEnvelope = z.strictObject({ kind: z.literal("request"), request_id: RequestId, project_id: ProjectId, operation: Operation });
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

/** A response carries the request's own request_id and nothing else for correlation. */
export const ResponseEnvelope = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("response"), request_id: RequestId, ok: z.literal(true), result: OperationResult }),
  z.strictObject({ kind: z.literal("response"), request_id: RequestId, ok: z.literal(false), error: WireError }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

/** Client -> Server: the hello, then one response per request. */
export const ClientMessage = z.union([ClientHello, ...ResponseEnvelope.options]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Server -> Client: the handshake answer, the policy snapshot, and the requests the Client executes. */
export const ServerMessage = z.union([ServerWelcome, ServerReject, PolicySync, RequestEnvelope]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** What the Server may send once the Client is admitted. */
export const PostWelcomeMessage = z.union([PolicySync, RequestEnvelope]);
export type PostWelcomeMessage = z.infer<typeof PostWelcomeMessage>;

export type WireParse<T> = { ok: true; data: T } | { ok: false; error: WireError };

/**
 * Validates an unknown frame. A failure is the compact BAD_REQUEST error built from issue paths and codes only, so no
 * submitted value (a credential in particular) can appear in it.
 */
export function parseWire<T>(schema: z.ZodType<T>, input: unknown): WireParse<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const where = [...new Set(parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "<frame>"} (${i.code})`))].join(", ");
  return { ok: false, error: { code: "BAD_REQUEST", message: `invalid message: ${where}`.slice(0, 500) } };
}

/** A decision the Server makes about a client build; the shared schema only fixes its shape. */
export const BuildCompatibility = z.discriminatedUnion("compatible", [z.strictObject({ compatible: z.literal(true) }), z.strictObject({ compatible: z.literal(false), error: WireError })]);
export type BuildCompatibility = z.infer<typeof BuildCompatibility>;
