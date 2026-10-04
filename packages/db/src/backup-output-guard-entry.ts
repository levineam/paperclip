// Isolated guarded-backup child entry. Forked by backup-output-guard.ts with cwd "/".
import { resolveMacosVolume, serveGuardedBackupChild } from "./backup-output-guard-child.js";

serveGuardedBackupChild(resolveMacosVolume);
