#!/usr/bin/env node

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { sync, startWatch, loadConfig } from "../src/index.mjs";

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--watch" || args[i] === "-w") {
    flags.watch = true;
  } else if (args[i] === "--config" || args[i] === "-c") {
    flags.config = args[++i];
  } else if (args[i] === "--vault") {
    flags.vaultPath = args[++i];
  } else if (args[i] === "--content-dir") {
    flags.contentDir = args[++i];
  } else if (args[i] === "--media-dir") {
    flags.mediaDir = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`hyalite-sync — sync vault content to a static site

Usage:
  hyalite-sync [options] [vault-path]

Options:
  -c, --config <path>       Path to config JSON file (default: ./hyalite-sync.json)
  --vault <path>            Vault path (or set OBSIDIAN_VAULT env var)
  --content-dir <path>      Output directory for content files (default: ./content)
  --media-dir <path>        Output directory for media files (default: ./public/media)
  -w, --watch               Watch vault for changes
  -h, --help                Show this help

Config file format (hyalite-sync.json):
  {
    "vaultPath": "/path/to/vault",
    "contentDir": "./content",
    "mediaDir": "./public/media",
    "filter": {
      "project": "My Project"
    },
    "stripFields": ["draft"]
  }
`);
    process.exit(0);
  } else if (!args[i].startsWith("-")) {
    positional.push(args[i]);
  }
}

// Vault path from positional arg
if (positional[0]) {
  flags.vaultPath = positional[0];
}

// Load .env.local from cwd
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

// Find config file
const configPath =
  flags.config ||
  (existsSync("hyalite-sync.json") ? "hyalite-sync.json" : null);

try {
  const config = loadConfig(configPath, flags);
  sync(config);

  if (flags.watch) {
    startWatch(config);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
