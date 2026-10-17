/**
 * esbuild configuration for building the paperclipai CLI for npm.
 *
 * Bundles all workspace packages (@paperclipai/*) into dist/index.js, plus the
 * isolated backup output guard child into dist/backup-output-guard-entry.js.
 * External npm packages remain as regular dependencies.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workspace packages whose code should be bundled into the CLI.
// Note: "server" is excluded — it's published separately and resolved at runtime.
const workspacePaths = [
  "cli",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/hermes-gateway",
  "packages/adapters/hermes",
  "packages/adapters/openclaw-gateway",
];

// Workspace packages that should NOT be bundled — they'll be published
// to npm and resolved at runtime (e.g. @paperclipai/server uses dynamic import).
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// Collect all external (non-workspace) npm package names
const externals = new Set();
for (const p of workspacePaths) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, p, "package.json"), "utf8"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (externalWorkspacePackages.has(name)) {
      externals.add(name);
    } else if (!name.startsWith("@paperclipai/")) {
      externals.add(name);
    }
  }
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    externals.add(name);
  }
}
// Also add all published workspace packages as external
for (const name of externalWorkspacePackages) {
  externals.add(name);
}

/** @type {import('esbuild').BuildOptions} */
export default {
  // The backup output guard forks an isolated child from the file next to the
  // bundled code (dist/backup-output-guard-entry.js), so it must be emitted as its
  // own self-contained entry beside dist/index.js. Without it, guarded
  // `db:backup` always fails closed with a missing child.
  entryPoints: {
    index: resolve(__dirname, "src/index.ts"),
    "backup-output-guard-entry": resolve(repoRoot, "packages/db/src/backup-output-guard-entry.ts"),
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: resolve(__dirname, "dist"),
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
