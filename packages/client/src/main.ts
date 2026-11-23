// Client process entry: parse the command line, start the Client, stop it on SIGTERM or SIGINT. systemd owns restarts.
import { CliError } from "@reach-mcp/shared/cli";
import { BootstrapError } from "./bootstrap.ts";
import { CLIENT_USAGE, parseClientArgs, startClient, type RunningClient } from "./runtime.ts";

// Distinct from 1 (crash) and 2 (usage): the Linux unit lists it in RestartPreventExitStatus so a refused Client never restarts in a loop.
const REFUSED_EXIT_CODE = 3;

let client: RunningClient;
try {
  // A terminal admission rejection (bad key, duplicate Client, incompatible build) can never heal by retrying: say why and fail, so systemd and the operator see it.
  client = startClient(parseClientArgs(process.argv.slice(2)), (error) => {
    process.stderr.write(`reach-client: the Server refused this Client: ${error.code}: ${error.message}\n`);
    client.stop();
    process.exit(REFUSED_EXIT_CODE);
  });
} catch (error) {
  if (!(error instanceof CliError) && !(error instanceof BootstrapError)) throw error;
  process.stderr.write(`${error.message}\n${CLIENT_USAGE}\n`);
  process.exit(2);
}
process.stdout.write("reach-client started\n");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    client.stop();
    process.exit(0);
  });
}
