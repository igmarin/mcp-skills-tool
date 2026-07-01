#!/usr/bin/env node
import { runCli, reportFatalError } from "./cli.js";

runCli().catch((error) => {
  process.exit(reportFatalError(error));
});
