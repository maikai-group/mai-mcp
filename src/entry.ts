#!/usr/bin/env node

/** The checkout's public bin has three modes. No verb is the stdio MCP
 * server; the exact verb `setup` is intercepted BEFORE cli.js/env.js module
 * evaluation so the shared visible-stage environment loader is the first
 * Preflight operation; any other verb is the lifecycle-owning operator CLI.
 * Consumer configs still point directly at build/index.js, whose direct-entry
 * guard calls the same exported server runner. */
const verb = process.argv[2];
if (verb === 'setup') {
  const { runSetupSource } = await import('./scripts/setup.js');
  await runSetupSource(process.argv.slice(3));
} else if (verb !== undefined) {
  const { runCli } = await import('./cli.js');
  await runCli(process.argv.slice(2));
} else {
  const { runStdioServer } = await import('./index.js');
  runStdioServer();
}
