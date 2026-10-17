import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(cliRoot, "..");
// Synthetic UUID; never a real volume.
const UNMOUNTED_UUID = "99999999-8888-4777-8666-555555555555";

/**
 * Externals the bundles import that a strict pnpm install keeps under the owning
 * workspace package rather than cli/node_modules. The publish flow
 * (scripts/generate-npm-package-json.mjs) inlines them as CLI dependencies; this
 * fixture emulates that surface by linking the exact installed package roots.
 */
const WORKSPACE_ONLY_EXTERNALS: Array<[name: string, ownerDir: string]> = [
  ["zod", "packages/shared"],
  ["postgres", "packages/db"],
];

describe("compiled CLI build", () => {
  it("emits the guard child beside index.js so guarded db:backup reaches the volume check", async () => {
    // Variable specifiers keep these out of the CLI typecheck (no .mjs declarations).
    const esbuildName = "esbuild";
    const esbuild = await import(esbuildName);
    const configUrl = new URL("../../esbuild.config.mjs", import.meta.url).href;
    const config = { ...((await import(configUrl)).default as Record<string, unknown>) };
    // Build into an owned directory; also lets the old single-outfile config run here.
    delete config.outfile;
    delete config.outdir;

    // Package-shaped fixture under cli/node_modules: packageRoot/{package.json,dist,node_modules}.
    // dist/ code finds ../package.json like the published CLI; both bundles share
    // packageRoot/node_modules, and direct CLI dependencies resolve from the CLI parent.
    const packageRoot = path.join(cliRoot, "node_modules", ".cache", `paperclip-guard-build-${process.pid}-${Date.now()}`);
    const outdir = path.join(packageRoot, "dist");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-build-guard-"));
    try {
      const fixtureModules = path.join(packageRoot, "node_modules");
      fs.mkdirSync(fixtureModules, { recursive: true });
      fs.copyFileSync(path.join(cliRoot, "package.json"), path.join(packageRoot, "package.json"));
      for (const [name, ownerDir] of WORKSPACE_ONLY_EXTERNALS) {
        const installed = fs.realpathSync(path.join(repoRoot, ownerDir, "node_modules", name));
        fs.symlinkSync(installed, path.join(fixtureModules, name), "dir");
      }

      await esbuild.build({ ...config, absWorkingDir: cliRoot, outdir, logLevel: "silent" });
      expect(fs.existsSync(path.join(outdir, "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(outdir, "backup-output-guard-entry.js"))).toBe(true);

      const backupDir = path.join(home, "backups");
      const missingConfig = path.join(home, "missing", "config.json");
      // Bounded allowlist: no ambient secrets, NODE_OPTIONS, or runtime variables.
      // HOME is passed through unchanged (never replaced); PAPERCLIP_HOME isolates state.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        PAPERCLIP_HOME: home,
        PAPERCLIP_CONFIG: missingConfig,
        PAPERCLIP_CONTEXT: path.join(home, "missing", "context.json"),
        DATABASE_URL: "postgres://paperclip:paperclip@127.0.0.1:1/paperclip",
        PAPERCLIP_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
      };
      const result = spawnSync(process.execPath, [
        path.join(outdir, "index.js"),
        "db:backup",
        "--config", missingConfig,
        "--dir", backupDir,
        "--expected-volume-uuid", UNMOUNTED_UUID,
      ], { cwd: home, env, encoding: "utf8", timeout: 60_000 });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      // The compiled child ran and failed closed at the volume check, not at startup.
      expect(output).not.toMatch(/without a result|Cannot find module|ERR_MODULE_NOT_FOUND/);
      expect(output).toMatch(process.platform === "darwin" ? /not found by diskutil/ : /only supported on macOS/);
      // Nothing was created before the failure: no backup dir, and no lock/marker or
      // backup output anywhere under the fixture home.
      expect(fs.existsSync(backupDir)).toBe(false);
      const created = (fs.readdirSync(home, { recursive: true }) as string[])
        .filter((entry) => /(^|\/)\.paperclip-stx-|\.sql(\.gz)?$/.test(entry));
      expect(created).toEqual([]);
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
