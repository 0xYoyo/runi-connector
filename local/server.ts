/**
 * Local MCP server (stdio). Claude Code / Claude Desktop start this on your machine;
 * it uses the token saved by `npm run login` and talks to Moodle from your own connection.
 * Never print to stdout here: stdout is the MCP channel. Diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, type UserProps } from "../src/tools";
import { FileKV, readPrivateFile } from "./file-kv";

async function main() {
  const raw = readPrivateFile("session.json");
  if (raw === null) {
    console.error("runi-connector: not signed in. Run `npm run login` in the runi-connector folder first.");
    process.exit(1);
  }
  const session = JSON.parse(raw as string) as UserProps;
  const server = buildServer(session, new FileKV() as unknown as KVNamespace);
  await server.connect(new StdioServerTransport());
  console.error(`runi-connector: ready for ${session.fullName}`);
}

main().catch((error) => {
  console.error("runi-connector failed to start:", (error as Error).message);
  process.exit(1);
});
