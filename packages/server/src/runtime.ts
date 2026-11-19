// The Server process composition, and the only place that builds one: it constructs each existing owner exactly once and
// wires them together. The command line carries only runtime values (paths, bind addresses, build metadata); projects,
// Clients, credentials, policies and logging settings come from the config file through ServerConfigStore, and a missing
// or invalid config simply leaves the Server inactive so the admin routes of the one listener can serve setup mode.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseFlags, parsePort } from "@reach-mcp/shared/cli";
import { createAdminHandler } from "./admin.ts";
import { DirectoryArtifactSource } from "./artifacts.ts";
import { AuditWriter } from "./audit.ts";
import { ConfigError, ServerConfigStore } from "./config.ts";
import { ClientConnectionRegistry } from "./connections.ts";
import { createHttpServer } from "./http-server.ts";
import { OperationalLogger } from "./logging.ts";
import { ProposalStore } from "./proposals.ts";
import { RotatingTextWriter } from "./rotating-text.ts";

export type ServerArgs = {
  config: string;
  proposal: string;
  logs: string;
  host: string;
  port: number;
  build: string;
  repositoryCommit?: string;
  /** Optional directory holding the release manifest and Client artifacts that the admin release routes serve. */
  artifacts?: string;
};

const LOOPBACK = "127.0.0.1";

export const SERVER_USAGE =
  "usage: server --config <file> --proposal <file> --logs <dir> --port <n> --build <id> [--host <addr>] [--repository-commit <id>] [--artifacts <dir>]";

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  const flags = parseFlags(argv, {
    config: { required: true },
    proposal: { required: true },
    logs: { required: true },
    host: {},
    port: { required: true },
    build: { required: true },
    "repository-commit": {},
    artifacts: {},
  });
  const text = (name: string) => flags[name] as string;
  return {
    config: text("config"),
    proposal: text("proposal"),
    logs: text("logs"),
    host: (flags.host as string | undefined) ?? LOOPBACK,
    port: parsePort("port", text("port")),
    build: text("build"),
    ...(flags["repository-commit"] === undefined ? {} : { repositoryCommit: text("repository-commit") }),
    ...(flags.artifacts === undefined ? {} : { artifacts: text("artifacts") }),
  };
}

export type RunningServer = { port: number; stop(): Promise<void> };

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

export async function startServer(args: ServerArgs): Promise<RunningServer> {
  const config = new ServerConfigStore(args.config);
  const settings = () => config.loggingSettings();
  const logger = new OperationalLogger(new RotatingTextWriter({ dir: args.logs, base: "reach", settings }));
  const audit = new AuditWriter(new RotatingTextWriter({ dir: args.logs, base: "audit", settings }));
  try {
    config.loadInitial();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    logger.log("ERROR", "runtime", `configuration is not active, setup mode: ${error.problems.join("; ")}`);
  }
  const connections = new ClientConnectionRegistry({ config, serverBuild: args.build, isBuildCompatible: (clientBuild) => clientBuild === args.build, logger, audit });
  const proposals = new ProposalStore({ path: args.proposal, config, connections, logger, audit });
  const common = { config, connections, proposals, serverBuild: args.build, ...(args.repositoryCommit === undefined ? {} : { repositoryCommit: args.repositoryCommit }) };
  const routes = createAdminHandler({ ...common, logger, audit, ...(args.artifacts === undefined ? {} : { artifacts: new DirectoryArtifactSource(args.artifacts) }) });
  const server = createHttpServer({ ...common, routes });
  const stop = async () => {
    connections.stop();
    await close(server);
  };
  try {
    const port = await listen(server, args.port, args.host);
    connections.start();
    logger.log("INFO", "runtime", `server started build=${args.build} port=${port} active=${config.isActive()}`);
    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
