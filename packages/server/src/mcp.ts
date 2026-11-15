// The ChatGPT-facing MCP surface: one discovery tool and one tool per shared Operation, each addressed by client_id and
// project_id. Handlers are adapters only: they build the shared Operation and hand it to the connection registry. Argument
// schemas are derived from the shared Operation schemas, never copied. Annotations are hints, never authorization.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ClientId, Operation, ProjectId, type ResponseEnvelope } from "../../shared/src/wire/index.ts";
import type { ServerConfigStore } from "./config.ts";
import type { ClientConnectionRegistry } from "./connections.ts";

export type McpDeps = { config: ServerConfigStore; connections: ClientConnectionRegistry; serverBuild: string };

type Op = Operation["op"];

const DESCRIPTIONS: Record<Op, string> = {
  fs_list: "List a directory of a project.",
  fs_find: "Find files by name or glob in a project.",
  fs_read: "Read a text file, optionally a line range.",
  fs_search: "Search file contents for text or regex patterns.",
  fs_read_image: "Read a PNG, JPEG or WebP image as base64.",
  fs_read_pdf: "Read the text layer of a PDF, page by page.",
  fs_write: "Create or overwrite a text or base64 file inside the project's writable area.",
  fs_edit: "Replace text inside an existing file.",
  fs_remove: "Move a file to the project's trash folder.",
  git_status: "Read-only Git status of the project.",
  git_diff: "Read-only Git diff of the project.",
  git_log: "Read-only Git history of the project.",
  git_show: "Read-only Git show of a revision.",
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ANNOTATIONS: Record<Op, typeof READ | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: false; openWorldHint: false }> = {
  fs_list: READ,
  fs_find: READ,
  fs_read: READ,
  fs_search: READ,
  fs_read_image: READ,
  fs_read_pdf: READ,
  git_status: READ,
  git_diff: READ,
  git_log: READ,
  git_show: READ,
  fs_write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fs_edit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fs_remove: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

const TARGET = { client_id: ClientId, project_id: ProjectId };

/** The compact MCP outcome of a routed request. */
function toToolResult(response: ResponseEnvelope): CallToolResult {
  if (response.ok) return { content: [{ type: "text", text: JSON.stringify(response.result) }], structuredContent: response.result };
  return { isError: true, content: [{ type: "text", text: `${response.error.code}: ${response.error.message}` }] };
}

/** A fresh server per HTTP request: the stateless transport keeps no MCP session. */
export function buildMcpServer({ config, connections, serverBuild }: McpDeps): McpServer {
  const server = new McpServer({ name: "reach", version: serverBuild });

  server.registerTool(
    "reach_discover",
    { description: "List the Clients and projects you can address, with mode and online state.", annotations: { ...READ, title: "Discover REACH targets" } },
    (): CallToolResult => {
      const online = new Map(connections.status().map((s) => [s.client_id, s.online]));
      const clients = config.snapshot().clients.map((c) => ({
        client_id: c.client_id,
        display_name: c.display_name,
        enabled: c.enabled,
        online: c.enabled && online.get(c.client_id) === true,
        projects: c.projects.map((p) => ({ project_id: p.project_id, mode: p.mode })),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ clients }) }], structuredContent: { clients } };
    },
  );

  for (const option of Operation.options) {
    const op = option.shape.op.value;
    const args = Object.fromEntries(Object.entries(option.shape).filter(([key]) => key !== "op")) as z.ZodRawShape;
    const inputSchema = z.strictObject({ ...TARGET, ...args });
    server.registerTool(op, { description: DESCRIPTIONS[op], inputSchema, annotations: ANNOTATIONS[op] }, async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const { client_id, project_id, ...rest } = args as { client_id: string; project_id: string } & Record<string, unknown>;
      return toToolResult(await connections.route(client_id, project_id, { op, ...rest } as Operation));
    });
  }
  return server;
}
