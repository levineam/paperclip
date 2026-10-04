import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "./config-schema.js";

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("leaves backup.expectedVolumeUuid absent by default and keeps a configured value verbatim", () => {
    const base = {
      $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
      logging: { mode: "file" },
      server: {},
    };
    const defaults = paperclipConfigSchema.parse({ ...base, database: { mode: "embedded-postgres" } });
    expect(defaults.database.backup).not.toHaveProperty("expectedVolumeUuid");

    // Malformed values must not invalidate the whole file (callers would silently drop
    // the guard); backup callers validate and fail closed instead.
    for (const value of ["11111111-2222-4333-8444-555555555555", "", "not-a-uuid", null, 42]) {
      const parsed = paperclipConfigSchema.parse({
        ...base,
        database: { mode: "embedded-postgres", backup: { expectedVolumeUuid: value } },
      });
      expect(parsed.database.backup.expectedVolumeUuid).toBe(value);
    }
  });
});
