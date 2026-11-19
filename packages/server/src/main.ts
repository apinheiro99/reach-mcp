// Server process entry: parse the command line, start the Server, stop it on SIGTERM or SIGINT. systemd owns restarts.
import { CliError } from "@reach-mcp/shared/cli";
import { parseServerArgs, SERVER_USAGE, startServer } from "./runtime.ts";

let args;
try {
  args = parseServerArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  process.stderr.write(`${error.message}\n${SERVER_USAGE}\n`);
  process.exit(2);
}
const server = await startServer(args);
process.stdout.write(`reach-server listening port=${server.port} admin_port=${server.adminPort}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void server.stop().then(() => process.exit(0)));
