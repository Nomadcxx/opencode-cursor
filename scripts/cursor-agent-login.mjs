#!/usr/bin/env node
/**
 * cursor-agent-login.mjs
 *
 * OpenCode 2.0 `command` login method for the cursor-acp integration.
 *
 * OpenCode runs this with stdin closed, streams stderr to the user as progress,
 * and stores the trimmed stdout as the credential. `cursor-agent login` prints
 * its browser link on stdout, so that output is sent to stderr here. On success
 * this prints the `cursor-agent` placeholder, which the plugin reads as "no API
 * key": requests then run through the cursor-agent login.
 *
 * Usage: node cursor-agent-login.mjs [cursor-agent binary]
 */

import spawn from "cross-spawn";
import { buildCursorAgentSpawnCommand } from "../src/utils/cursor-agent-command.mjs";

const binary = process.argv[2] || "cursor-agent";
const [command, args] = buildCursorAgentSpawnCommand(binary, ["login"]);
const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });

child.stdout.pipe(process.stderr);
// A cancelled login must not leave `cursor-agent login` waiting on the browser.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(1);
  });
}
child.on("error", (error) => {
  process.stderr.write(`Could not run ${binary}: ${error.message}\n`);
  process.exit(1);
});
child.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  process.stdout.write("cursor-agent\n");
});
