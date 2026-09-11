export {
  createDb,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  STORAGE_TRANSACTION_LOCK_ARTIFACT_PREFIX,
  STORAGE_TRANSACTION_LOCK_SCHEMA,
  StorageTransactionBlockedError,
  StorageTransactionBusyError,
  StorageTransactionProtocolFaultError,
  acquireStorageTransactionLock,
  checkStorageTransactionLiveness,
  isStorageTransactionReservedArtifact,
  readStorageTransactionParticipationMarker,
  resolveStorageTransactionIdentity,
  type AcquireStorageTransactionLockOptions,
  type StorageTransactionIdentity,
  type StorageTransactionLiveness,
  type StorageTransactionLockDeps,
  type StorageTransactionLockHandle,
  type StorageTransactionLockRecord,
  type StorageTransactionParticipationMarker,
} from "./backup-transaction-lock.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
