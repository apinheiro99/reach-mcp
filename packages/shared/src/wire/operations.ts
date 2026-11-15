// The typed operation surface of the Story 5 capabilities (filesystem and the transitional read-only Git inspection),
// as plain JSON data. Arguments mirror the shared reader, writer and the read-only Git inspector; nothing here implements them.
// No generic "operation: string / payload: unknown" escape hatch exists: an unknown op is a validation error.
import { z } from "zod";
import { WIRE_MAX_BASE64, WIRE_MAX_TEXT, WirePath } from "./ids.ts";

const count = z.int().min(0);
const posInt = z.int().min(1);
const text = z.string().max(WIRE_MAX_TEXT);
const globs = z.array(z.string().max(512)).max(50);

// ---- requests -------------------------------------------------------------------------------------------------

export const Operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("fs_list"), path: WirePath.optional(), depth: posInt.max(10).optional() }),
  z.strictObject({ op: z.literal("fs_find"), pattern: z.string().min(1).max(512), path: WirePath.optional(), limit: posInt.optional() }),
  z.strictObject({ op: z.literal("fs_read"), path: WirePath, start_line: posInt.optional(), end_line: posInt.optional() }),
  z.strictObject({
    op: z.literal("fs_search"),
    patterns: z.array(z.string().min(1).max(200)).min(1).max(10),
    mode: z.enum(["text", "regex"]).optional(),
    case_sensitive: z.boolean().optional(),
    path: WirePath.optional(),
    include: globs.optional(),
    exclude: globs.optional(),
    context_lines: count.max(3).optional(),
    limit: posInt.optional(),
  }),
  z.strictObject({ op: z.literal("fs_read_image"), path: WirePath }),
  z.strictObject({ op: z.literal("fs_read_pdf"), path: WirePath, start_page: posInt.optional(), max_pages: posInt.optional() }),
  // mutations
  z.strictObject({ op: z.literal("fs_write"), path: WirePath, content: z.string().max(WIRE_MAX_BASE64), encoding: z.enum(["utf8", "base64"]).optional() }),
  z.strictObject({ op: z.literal("fs_edit"), path: WirePath, old_text: z.string().min(1).max(WIRE_MAX_TEXT), new_text: text, replace_all: z.boolean().optional() }),
  z.strictObject({ op: z.literal("fs_remove"), path: WirePath }),
  // transitional, read-only Git inspection
  z.strictObject({ op: z.literal("git_status") }),
  z.strictObject({ op: z.literal("git_diff"), base: z.string().max(100).optional(), head: z.string().max(100).optional(), staged: z.boolean().optional(), paths: z.array(WirePath).max(50).optional(), stat: z.boolean().optional() }),
  z.strictObject({ op: z.literal("git_log"), rev: z.string().max(100).optional(), count: posInt.optional(), paths: z.array(WirePath).max(50).optional() }),
  z.strictObject({ op: z.literal("git_show"), rev: z.string().min(1).max(100), paths: z.array(WirePath).max(50).optional(), stat: z.boolean().optional() }),
]);
export type Operation = z.infer<typeof Operation>;

/** Operations that change the project; everything else is a read. The Client queues mutations per project. */
export const MUTATING_OPERATIONS = ["fs_write", "fs_edit", "fs_remove"] as const satisfies readonly Operation["op"][];
export const isMutation = (op: Operation["op"]): boolean => (MUTATING_OPERATIONS as readonly string[]).includes(op);

// ---- results --------------------------------------------------------------------------------------------------

const Entry = z.strictObject({ path: WirePath, type: z.enum(["file", "dir"]), size: count.optional() });
const TextOutput = z.strictObject({ output: text, truncated: z.boolean() });

export const OperationResult = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("fs_list"), path: WirePath, entries: z.array(Entry), truncated: z.boolean() }),
  z.strictObject({ op: z.literal("fs_find"), path: WirePath, pattern: z.string(), matches: z.array(Entry), truncated: z.boolean(), scanned: count }),
  z.strictObject({
    op: z.literal("fs_read"),
    path: WirePath,
    start_line: count,
    end_line: count,
    total_lines: count,
    truncated: z.boolean(),
    next_start_line: posInt.nullable(),
    redactions: count,
    content: text,
  }),
  z.strictObject({
    op: z.literal("fs_search"),
    path: WirePath,
    mode: z.enum(["text", "regex"]),
    summary: z.array(z.strictObject({ pattern: z.string(), matches: count })),
    matches: z.array(z.strictObject({ pattern: z.string(), path: WirePath, line: posInt, text: z.string(), before: z.array(z.string()).optional(), after: z.array(z.string()).optional() })),
    truncated: z.boolean(),
    files_scanned: count,
    files_skipped: z.strictObject({ too_large: count, binary: count, secret_content: count }),
    stopped_by: z.enum(["results", "files", "bytes"]).nullable(),
  }),
  // Bytes travel as base64 plus metadata, never as a Buffer.
  z.strictObject({
    op: z.literal("fs_read_image"),
    path: WirePath,
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: count,
    width: posInt.optional(),
    height: posInt.optional(),
    data_base64: z.base64().max(WIRE_MAX_BASE64),
  }),
  z.strictObject({
    op: z.literal("fs_read_pdf"),
    path: WirePath,
    total_pages: posInt,
    start_page: posInt,
    end_page: posInt,
    pages: z.array(z.strictObject({ page: posInt, text, truncated: z.boolean() })),
    has_text: z.boolean(),
    redactions: count,
    truncated: z.boolean(),
    next_page: posInt.nullable(),
  }),
  z.strictObject({ op: z.literal("fs_write"), path: WirePath, bytes: count }),
  z.strictObject({ op: z.literal("fs_edit"), path: WirePath, bytes: count, replacements: posInt }),
  z.strictObject({ op: z.literal("fs_remove"), path: WirePath, moved_to: WirePath }),
  z.strictObject({
    op: z.literal("git_status"),
    branch: z.string().nullable(),
    clean: z.boolean(),
    entries: z.array(z.strictObject({ status: z.string().length(2), path: WirePath })),
    hidden_by_policy: count,
  }),
  z.strictObject({ op: z.literal("git_diff"), ...TextOutput.shape }),
  z.strictObject({
    op: z.literal("git_log"),
    commits: z.array(z.strictObject({ hash: z.string(), author: z.string(), date: z.string(), subject: z.string() })),
    truncated: z.boolean(),
  }),
  z.strictObject({ op: z.literal("git_show"), ...TextOutput.shape }),
]);
export type OperationResult = z.infer<typeof OperationResult>;
