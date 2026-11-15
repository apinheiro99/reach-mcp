// Client process entry: parse the command line, start the Client, stop it on SIGTERM or SIGINT. systemd owns restarts.
import { CliError } from "@reach-mcp/shared/cli";
import { BootstrapError } from "./bootstrap.ts";
import { CLIENT_USAGE, parseClientArgs, startClient } from "./runtime.ts";

let client;
try {
  client = startClient(parseClientArgs(process.argv.slice(2)));
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
