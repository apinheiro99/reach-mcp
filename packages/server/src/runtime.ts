// The Server process composition, and the only place that builds one: it constructs each existing owner exactly once and
// wires them together. The command line carries only runtime values (paths, bind addresses, build metadata); projects,
// Clients, public keys, policies and logging settings come from the config file through ServerConfigStore, and a missing
// or invalid config simply leaves the Server inactive so the admin listener can serve setup mode. Two listeners: the service
// listener (MCP, Client WSS, health, public release downloads) and the private admin listener (Web UI and admin API).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CliError, parseFlags, parsePort } from "@reach-mcp/shared/cli";
import { createAdminHandler } from "./admin.ts";
import { DirectoryArtifactSource } from "./artifacts.ts";
import { AuditWriter } from "./audit.ts";
import { ConfigError, ServerConfigStore } from "./config.ts";
import { ClientConnectionRegistry } from "./connections.ts";
import { createHttpServer } from "./http-server.ts";
import { createReleaseHandler } from "./release.ts";
import { OperationalLogger } from "./logging.ts";
import { parseTrustedSources } from "./trusted-network.ts";
import { ProposalStore } from "./proposals.ts";
import { RotatingTextWriter } from "./rotating-text.ts";

export type ServerArgs = {
  config: string;
  proposal: string;
  logs: string;
  host: string;
  port: number;
  adminHost: string;
  adminPort: number;
  build: string;
  repositoryCommit?: string;
  /** Peer addresses or CIDRs (comma separated) that may enroll a new Client; omitted means nobody can enroll. */
  enrollFrom?: string;
  /** Optional directory holding the release manifest and Client artifacts that the public release routes serve. */
  artifacts?: string;
  /** Direct peers (comma separated addresses or CIDRs) allowed on the admin listener; required when it is not bound to loopback. */
  adminAllowFrom?: string;
  /** DEV only: reload an open admin page when the watched process restarts. Off unless this switch is given. */
  devLiveReload: boolean;
};

const LOOPBACK = "127.0.0.1";
const LOOPBACK_HOSTS = [LOOPBACK, "::1", "localhost"];

export const SERVER_USAGE =
  "usage: server --config <file> --proposal <file> --logs <dir> --port <n> --admin-port <n> --build <id> [--host <addr>] [--admin-host <addr>] [--repository-commit <id>] [--artifacts <dir>] [--enroll-from <addr-or-cidr,...>] [--admin-allow-from <addr-or-cidr,...>] [--dev-live-reload]";

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  const flags = parseFlags(argv, {
    config: { required: true },
    proposal: { required: true },
    logs: { required: true },
    host: {},
    port: { required: true },
    "admin-host": {},
    "admin-port": { required: true },
    build: { required: true },
    "repository-commit": {},
    artifacts: {},
    "enroll-from": {},
    "admin-allow-from": {},
    "dev-live-reload": { boolean: true },
  });
  const text = (name: string) => flags[name] as string;
  const adminHost = (flags["admin-host"] as string | undefined) ?? LOOPBACK;
  // The admin routes have no login of their own, so a listener that leaves loopback must name who may reach it.
  if (!LOOPBACK_HOSTS.includes(adminHost) && flags["admin-allow-from"] === undefined) throw new CliError("flag --admin-host outside loopback needs --admin-allow-from");
  return {
    config: text("config"),
    proposal: text("proposal"),
    logs: text("logs"),
    host: (flags.host as string | undefined) ?? LOOPBACK,
    port: parsePort("port", text("port")),
    adminHost,
    adminPort: parsePort("admin-port", text("admin-port")),
    build: text("build"),
    ...(flags["repository-commit"] === undefined ? {} : { repositoryCommit: text("repository-commit") }),
    ...(flags.artifacts === undefined ? {} : { artifacts: text("artifacts") }),
    ...(flags["enroll-from"] === undefined ? {} : { enrollFrom: text("enroll-from") }),
    ...(flags["admin-allow-from"] === undefined ? {} : { adminAllowFrom: text("admin-allow-from") }),
    devLiveReload: flags["dev-live-reload"] === true,
  };
}

export type RunningServer = { port: number; adminPort: number; stop(): Promise<void> };

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
  const connections = new ClientConnectionRegistry({ config, serverBuild: args.build, isBuildCompatible: (clientBuild) => clientBuild === args.build, ...(args.enrollFrom === undefined ? {} : { canEnrollFrom: parseTrustedSources(args.enrollFrom) }), logger, audit });
  const proposals = new ProposalStore({ path: args.proposal, config, connections, logger, audit });
  const common = { config, connections, proposals, serverBuild: args.build, ...(args.repositoryCommit === undefined ? {} : { repositoryCommit: args.repositoryCommit }) };
  const admin = createServer(createAdminHandler({ ...common, logger, audit, devLiveReload: args.devLiveReload, ...(args.adminAllowFrom === undefined ? {} : { allowFrom: parseTrustedSources(args.adminAllowFrom) }) }));
  const release = createReleaseHandler({ audit, ...(args.artifacts === undefined ? {} : { artifacts: new DirectoryArtifactSource(args.artifacts) }) });
  const server = createHttpServer({ ...common, release });
  const stop = async () => {
    connections.stop();
    await Promise.all([close(server), close(admin)]);
  };
  try {
    const [port, adminPort] = await Promise.all([listen(server, args.port, args.host), listen(admin, args.adminPort, args.adminHost)]);
    connections.start();
    logger.log("INFO", "runtime", `server started build=${args.build} port=${port} admin_port=${adminPort} active=${config.isActive()}`);
    return { port, adminPort, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
