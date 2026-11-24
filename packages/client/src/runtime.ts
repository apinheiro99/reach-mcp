// The Client process composition: the one place that builds a running Client. Endpoint, id, credential and root anchors
// come only from the bootstrap file; the command line carries the build id and the explicit development switch.
import { parseFlags } from "@reach-mcp/shared/cli";
import type { WireError } from "@reach-mcp/shared/wire";
import { loadBootstrap } from "./bootstrap.ts";
import { ClientDispatcher } from "./dispatcher.ts";
import { ClientTransport } from "./transport.ts";
import { runUpdate } from "./updater.ts";
import path from "node:path";

export type ClientArgs = { bootstrap: string; build: string; allowInsecureWs: boolean };

export const CLIENT_USAGE = "usage: client --bootstrap <file> --build <id> [--allow-insecure-ws]";

export function parseClientArgs(argv: readonly string[]): ClientArgs {
  const flags = parseFlags(argv, { bootstrap: { required: true }, build: { required: true }, "allow-insecure-ws": { boolean: true } });
  return { bootstrap: flags.bootstrap as string, build: flags.build as string, allowInsecureWs: flags["allow-insecure-ws"] === true };
}

export type RunningClient = { transport: ClientTransport; stop(): void };

export function startClient(args: ClientArgs, onTerminal?: (error: WireError) => void): RunningClient {
  const bootstrap = loadBootstrap(args.bootstrap, { allowInsecureWs: args.allowInsecureWs, createIdentity: true });
  const dispatcher = new ClientDispatcher({ anchors: bootstrap.anchors });
  const transport = new ClientTransport(bootstrap, { build: args.build, handler: dispatcher, updater: (report) => runUpdate({ bootstrap, endpoint: bootstrap.endpoint, build: args.build, stateDir: path.dirname(args.bootstrap) }, report), ...(onTerminal ? { onTerminal } : {}) });
  transport.start();
  return { transport, stop: () => transport.stop() };
}
