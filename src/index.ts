#!/usr/bin/env node

import { main } from "./main";

// Get command line arguments (skip node and script path)
const args = process.argv.slice(2);

main(args)
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
