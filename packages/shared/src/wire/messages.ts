// Frames of the Server-Client conversation. Compatibility is a gate on the two actual build identifiers carried in
// the handshake; there is no protocol number, no SemVer parsing and no negotiation: the Server either accepts the
// client build or rejects it with INCOMPATIBLE_BUILD. Identity is an Ed25519 key owned by the Client: the Server opens
// every connection with a fresh challenge, the Client answers once with its public key and a signature, and nothing is
// signed again after the welcome. A current Client first sends only a fresh nonce (auth_begin) and the Server answers with a signed proof over both nonces (server_auth); only a Client that verified it sends its hello, and the welcome or reject carries the proof again (ADR-0005). A pre-change Client skips the first two frames.
import { z } from "zod";
import { WireError } from "./errors.ts";
import { ClientRuntime } from "../runtime-settings.ts";
import { BuildId, ClientId, MachineUuid, Nonce, ProjectId, PublicKey, RequestId, Sha256Hex, Signature } from "./ids.ts";
import { Operation, OperationResult } from "./operations.ts";
import { PolicySync } from "./policy.ts";

/** Server -> Client, first frame of every connection: the fresh challenge the Client must sign. */
export const ServerChallenge = z.strictObject({ kind: z.literal("challenge"), nonce: Nonce });
export type ServerChallenge = z.infer<typeof ServerChallenge>;

/** One trust rotation statement signed by the Server key it replaces (ADR-0005); the generation is a positive integer that only grows. */
export const TrustRotationStatement = z.strictObject({ generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), new_public_key: PublicKey, signature: Signature });

/** The Server's proof of identity on the handshake answer: its public key, a signature over the Client's fresh nonce, and the rotation statements a Client behind the current key needs. Present only for a Client that sent its own nonce. */
export const ServerProof = z.strictObject({ server_public_key: PublicKey, server_signature: Signature, server_rotations: z.array(TrustRotationStatement).max(32).optional() });
export type ServerProof = z.infer<typeof ServerProof>;

/**
 * Client -> Server, the first answer of a current Client to the challenge: ONLY its own fresh nonce, nothing that identifies it. The Server answers with its signed
 * `server_auth`; the Client sends its hello (identity and proof) only after that proof verified against its pin (ADR-0005). A pre-change Client never sends this frame.
 */
export const ClientAuthBegin = z.strictObject({ kind: z.literal("auth_begin"), client_nonce: Nonce });
export type ClientAuthBegin = z.infer<typeof ClientAuthBegin>;

/** Server -> Client, the answer to `auth_begin`: the Server's proof over both nonces, outcome `auth`. The session is not admitted yet. */
export const ServerAuth = z.strictObject({ kind: z.literal("server_auth"), proof: ServerProof });
export type ServerAuth = z.infer<typeof ServerAuth>;

/** Client -> Server, once per connection: identity, public key and the signature of the challenge. A first valid hello from an unknown client_id registers it as Pending; it gets no access until a human enables it. */
export const ClientHello = z.strictObject({ kind: z.literal("hello"), client_id: ClientId, client_build: BuildId, public_key: PublicKey, signature: Signature, client_nonce: Nonce.optional(), display_name: z.string().min(1).max(100).optional(), machine_uuid: MachineUuid.optional(), update_capable: z.literal(true).optional() });
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerWelcome = z.strictObject({ kind: z.literal("welcome"), server_build: BuildId, compatible: z.literal(true), runtime: ClientRuntime.optional(), proof: ServerProof.optional() });
export type ServerWelcome = z.infer<typeof ServerWelcome>;

/** A refused handshake: authentication, duplicate identity or incompatible build, always as the compact error. */
export const ServerReject = z.strictObject({ kind: z.literal("reject"), server_build: BuildId.optional(), error: WireError, proof: ServerProof.optional() });
export type ServerReject = z.infer<typeof ServerReject>;

export const HandshakeReply = z.discriminatedUnion("kind", [ServerChallenge, ServerAuth, ServerWelcome, ServerReject]);
export type HandshakeReply = z.infer<typeof HandshakeReply>;

export const RequestEnvelope = z.strictObject({ kind: z.literal("request"), request_id: RequestId, project_id: ProjectId, operation: Operation });
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

/** A response carries the request's own request_id and nothing else for correlation. */
export const ResponseEnvelope = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("response"), request_id: RequestId, ok: z.literal(true), result: OperationResult }),
  z.strictObject({ kind: z.literal("response"), request_id: RequestId, ok: z.literal(false), error: WireError }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

/** Server -> Client, after the welcome: the connected Client must generate a new Ed25519 pair locally and answer with only its public key. */
export const ServerRotateKey = z.strictObject({ kind: z.literal("rotate_key"), rotation_id: RequestId });
export type ServerRotateKey = z.infer<typeof ServerRotateKey>;

/** Server -> Client: the replacement public key is durably stored next to the valid one; the Client may now make it its own. */
export const ServerRotateCommitted = z.strictObject({ kind: z.literal("rotate_committed"), rotation_id: RequestId });
export type ServerRotateCommitted = z.infer<typeof ServerRotateCommitted>;

/** Client -> Server: the answer to one rotate_key; the replacement PUBLIC key, never the private one. */
export const ClientRotated = z.strictObject({ kind: z.literal("rotated"), rotation_id: RequestId, public_key: PublicKey });
export type ClientRotated = z.infer<typeof ClientRotated>;

/** Server -> Client: the explicit operator command to update to the Server's canonical release build. It carries no URL, path, command or build: the Client resolves everything from the Server's release manifest. `update_id` is minted by the Server only and names this one attempt in every later message. Sent only to a Client whose hello said `update_capable`. */
export const ServerUpdate = z.strictObject({ kind: z.literal("update"), update_id: RequestId });
export type ServerUpdate = z.infer<typeof ServerUpdate>;

/** Why an update stopped: a closed set, so a state can never carry a path, URL or secret. `apply` is the only reason after the handoff and is written by the privileged apply wrapper alone; the others stop the update before it. */
export const UPDATE_FAILURES = ["unsupported", "current", "manifest", "artifact", "verification", "staging", "handoff", "apply"] as const;
export const UpdateFailure = z.enum(UPDATE_FAILURES);
export type UpdateFailure = z.infer<typeof UpdateFailure>;
/** The reasons the Client itself may report: everything before the handoff. */
export const PreHandoffFailure = UpdateFailure.exclude(["apply"]);
export type PreHandoffFailure = z.infer<typeof PreHandoffFailure>;

/** Client -> Server: where the update attempt `update_id` stands before the handoff. `restarting` only means the verified replacement was handed to the platform lifecycle owner: it is NOT success, which only a terminal receipt can say. */
export const ClientUpdateState = z.discriminatedUnion("state", [
  z.strictObject({ kind: z.literal("update_state"), update_id: RequestId, state: z.literal("staging") }),
  z.strictObject({ kind: z.literal("update_state"), update_id: RequestId, state: z.literal("restarting") }),
  z.strictObject({ kind: z.literal("update_state"), update_id: RequestId, state: z.literal("failed"), reason: PreHandoffFailure }),
]);
export type ClientUpdateState = z.infer<typeof ClientUpdateState>;

const receiptCommon = { schema_version: z.literal(1), update_id: RequestId, from_build: BuildId, target_build: BuildId, artifact_sha256: Sha256Hex };
/** The durable apply request the Client hands to the lifecycle owner: correlation metadata only, never an authority (the installer re-verifies the staged bytes, manifest and trust). */
export const UpdateApplyRequest = z.strictObject(receiptCommon);
export type UpdateApplyRequest = z.infer<typeof UpdateApplyRequest>;
/** The one terminal result of an attempt. Only the privileged apply wrapper authors it; the Client reads and reports it, and neither the Client nor the Server derives it from a reconnect or a build. Closed fields: no path, origin, secret or timestamp. */
export const UpdateApplyResult = z.discriminatedUnion("state", [
  z.strictObject({ ...receiptCommon, state: z.literal("applied") }),
  z.strictObject({ ...receiptCommon, state: z.literal("failed"), reason: z.literal("apply") }),
]);
export type UpdateApplyResult = z.infer<typeof UpdateApplyResult>;
/** Where both live, relative to the Client state directory; the logical schema is the same on Linux and Windows. */
export const UPDATE_APPLY_REQUEST_FILE = "update/apply-request.json";
export const UPDATE_APPLY_RESULT_FILE = "update/apply-result.json";

/** Client -> Server: the latest terminal apply result, reported after every authenticated session is established. Reporting the same result again is expected and idempotent. */
export const ClientUpdateReceipt = z.strictObject({ kind: z.literal("update_receipt"), receipt: UpdateApplyResult });
export type ClientUpdateReceipt = z.infer<typeof ClientUpdateReceipt>;

/** Why a Client refused a policy snapshot: a closed set, so a refusal can never carry a message, path, root or secret. Anything unclassified is INTERNAL. */
export const POLICY_REFUSAL_REASONS = ["OUTSIDE_ROOT", "NOT_FOUND", "NOT_DIRECTORY", "BAD_REQUEST", "INTERNAL"] as const;
export const PolicyRefusalReason = z.enum(POLICY_REFUSAL_REASONS);
export type PolicyRefusalReason = z.infer<typeof PolicyRefusalReason>;

/** Client -> Server, one per `policy_sync`, in order on the same socket: the snapshot was applied, or refused (`project_id` names the failing policy when one is). It is a diagnostic only and grants nothing. */
export const ClientPolicyResult = z.discriminatedUnion("state", [
  z.strictObject({ kind: z.literal("policy_result"), state: z.literal("applied") }),
  z.strictObject({ kind: z.literal("policy_result"), state: z.literal("refused"), reason: PolicyRefusalReason, project_id: ProjectId.optional() }),
]);
export type ClientPolicyResult = z.infer<typeof ClientPolicyResult>;

/** What an admitted Client may send: a response to a request, the outcome of a policy snapshot, the answer to a key rotation, an update state or the terminal apply receipt. */
export const SessionMessage = z.union([ClientRotated, ClientUpdateReceipt, ...ClientPolicyResult.options, ...ClientUpdateState.options, ...ResponseEnvelope.options]);
export type SessionMessage = z.infer<typeof SessionMessage>;

/** Client -> Server: the hello, then one response per request. */
/** The one constructor of an error response. */
export const failureResponse = (requestId: string, error: WireError): ResponseEnvelope => ({ kind: "response", request_id: requestId, ok: false, error });

export const ClientMessage = z.union([ClientAuthBegin, ClientHello, ...SessionMessage.options]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Server -> Client: the handshake answer, the policy snapshot, and the requests the Client executes. */
export const ServerMessage = z.union([ServerChallenge, ServerAuth, ServerWelcome, ServerReject, PolicySync, RequestEnvelope, ServerRotateKey, ServerRotateCommitted, ServerUpdate]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** What the Server may send once the Client is admitted. */
export const PostWelcomeMessage = z.union([PolicySync, RequestEnvelope, ServerRotateKey, ServerRotateCommitted, ServerUpdate]);
export type PostWelcomeMessage = z.infer<typeof PostWelcomeMessage>;

export type WireParse<T> = { ok: true; data: T } | { ok: false; error: WireError };

/**
 * Validates an unknown frame. A failure is the compact BAD_REQUEST error built from issue paths and codes only, so no
 * submitted value (a key or signature in particular) can appear in it.
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
