import { readFileSync } from "node:fs";
import path from "node:path";
import { formatDatabaseBackupResult, runDatabaseBackup } from "./backup-lib.js";
import { resolveBackupOutputGuard, type BackupOutputGuard } from "./backup-output-guard.js";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipConfigPathForInstance,
} from "@paperclipai/shared/home-paths";

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresPort?: number;
    backup?: {
      dir?: string;
      retentionDays?: number;
      expectedVolumeUuid?: unknown;
    };
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only a missing file (ENOENT) means "use defaults". An existing config that cannot
 * be read, is not valid JSON, or does not have the object shape this script reads
 * may carry the output guard in some form, so refuse rather than guess.
 */
function readConfig(configPath: string): PartialConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read ${configPath}: ${(error as Error).message}; refusing to back up with uncertain config`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${configPath}: ${(error as Error).message}; refusing to back up with uncertain config`);
  }
  // Minimal explicit shape check for the path to database.backup.expectedVolumeUuid.
  const database = isPlainObject(parsed) ? parsed.database : undefined;
  const backup = isPlainObject(database) ? database.backup : undefined;
  if (
    !isPlainObject(parsed)
    || (database !== undefined && !isPlainObject(database))
    || (backup !== undefined && !isPlainObject(backup))
  ) {
    throw new Error(`Unexpected config shape in ${configPath}; refusing to back up with uncertain config`);
  }
  return parsed as PartialConfig;
}

function resolveOutputGuard(config: PartialConfig | null): BackupOutputGuard | undefined {
  // Raw config is not schema-checked: an explicit null is passed through (and rejected).
  return resolveBackupOutputGuard({
    env: process.env.PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID,
    envName: "PAPERCLIP_DB_BACKUP_EXPECTED_VOLUME_UUID",
    config: config?.database?.backup?.expectedVolumeUuid,
  });
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function resolveEmbeddedPort(config: PartialConfig | null): number {
  return asPositiveInt(config?.database?.embeddedPostgresPort) ?? 54329;
}

function resolveConnectionString(config: PartialConfig | null): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;

  if (config?.database?.mode === "postgres" && typeof config.database.connectionString === "string") {
    const trimmed = config.database.connectionString.trim();
    if (trimmed) return trimmed;
  }

  const port = resolveEmbeddedPort(config);
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function resolveBackupDir(config: PartialConfig | null): string {
  const raw = config?.database?.backup?.dir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(expandHomePrefix(raw.trim()));
  }
  return resolveDefaultBackupDir();
}

function resolveRetentionDays(config: PartialConfig | null): number {
  return asPositiveInt(config?.database?.backup?.retentionDays) ?? 7;
}

async function main() {
  const configPath = resolvePaperclipConfigPathForInstance();

  try {
    const config = readConfig(configPath);
    const connectionString = resolveConnectionString(config);
    const backupDir = resolveBackupDir(config);
    const retentionDays = resolveRetentionDays(config);
    const outputGuard = resolveOutputGuard(config);

    console.log(`Config path: ${configPath}`);
    console.log(`Backing up database to: ${backupDir}`);
    console.log(`Retention window: ${retentionDays} day(s)`);
    if (outputGuard) console.log(`Output guard: volume ${outputGuard.expectedVolumeUuid}`);

    const result = await runDatabaseBackup({
      connectionString,
      backupDir,
      retention: { dailyDays: retentionDays, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "paperclip",
      ...(outputGuard ? { outputGuard } : {}),
    });

    console.log(`Backup saved: ${formatDatabaseBackupResult(result)}`);
  } catch (err) {
    console.error("Backup failed.");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
