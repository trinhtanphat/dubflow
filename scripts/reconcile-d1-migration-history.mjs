import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_CONFIG_PATH } from './cloudflare-workers-build-config.mjs';

export const LEGACY_VISUAL_MIGRATION = '0012_visual_lipsync.sql';
export const CURRENT_VISUAL_MIGRATION = '0013_visual_lipsync.sql';

function commandArgs(sql) {
  return [
    'wrangler', 'd1', 'execute', 'DB',
    '--remote',
    '--config', PRODUCTION_CONFIG_PATH,
    '--json',
    '--command', sql,
  ];
}

function executeRemote(sql, { parseJson = true } = {}) {
  const args = commandArgs(sql);
  const result = spawnSync('npx', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || '').trim();
    throw new Error(`npx ${args.slice(0, 7).join(' ')} failed with exit code ${result.status}${details ? `: ${details}` : ''}`);
  }
  if (!parseJson) return [];

  let payload;
  try {
    payload = JSON.parse(result.stdout || '[]');
  } catch (error) {
    throw new Error(`Unable to parse Wrangler D1 JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
  const executions = Array.isArray(payload) ? payload : [payload];
  return executions.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

function flag(row, key) {
  return Number(row?.[key] ?? 0) === 1;
}

export function migrationHistoryState(rows) {
  const row = rows[0] ?? {};
  return {
    legacyRecorded: flag(row, 'legacy_recorded'),
    currentRecorded: flag(row, 'current_recorded'),
    visualSchemaPresent: [
      'lip_sync_requested_column',
      'lip_sync_provider_column',
      'lip_sync_status_column',
      'lip_sync_object_key_column',
      'provider_media_grants_table',
    ].every((key) => flag(row, key)),
  };
}

export function reconcileD1MigrationHistory() {
  const ledgerRows = executeRemote(`
    SELECT EXISTS(
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'd1_migrations'
    ) AS migrations_table;
  `);
  if (!flag(ledgerRows[0], 'migrations_table')) {
    console.log('D1 migration ledger does not exist yet; no reconciliation required.');
    return { changed: false, reason: 'fresh-database' };
  }

  const rows = executeRemote(`
    SELECT
      EXISTS(SELECT 1 FROM d1_migrations WHERE name = '${LEGACY_VISUAL_MIGRATION}') AS legacy_recorded,
      EXISTS(SELECT 1 FROM d1_migrations WHERE name = '${CURRENT_VISUAL_MIGRATION}') AS current_recorded,
      EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'lip_sync_requested') AS lip_sync_requested_column,
      EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'lip_sync_provider') AS lip_sync_provider_column,
      EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'lip_sync_status') AS lip_sync_status_column,
      EXISTS(SELECT 1 FROM pragma_table_info('project_exports') WHERE name = 'lip_sync_object_key') AS lip_sync_object_key_column,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_media_grants') AS provider_media_grants_table;
  `);
  const state = migrationHistoryState(rows);

  if (state.currentRecorded) {
    console.log(`${CURRENT_VISUAL_MIGRATION} is already recorded; no reconciliation required.`);
    return { changed: false, reason: 'already-current' };
  }
  if (!state.legacyRecorded) {
    console.log(`${LEGACY_VISUAL_MIGRATION} is not recorded; no reconciliation required.`);
    return { changed: false, reason: 'legacy-not-recorded' };
  }
  if (!state.visualSchemaPresent) {
    throw new Error(
      `Refusing to rename ${LEGACY_VISUAL_MIGRATION}: deployed schema does not prove the visual lip-sync migration completed.`,
    );
  }

  executeRemote(`
    UPDATE d1_migrations
    SET name = '${CURRENT_VISUAL_MIGRATION}'
    WHERE name = '${LEGACY_VISUAL_MIGRATION}'
      AND NOT EXISTS (
        SELECT 1 FROM d1_migrations WHERE name = '${CURRENT_VISUAL_MIGRATION}'
      );
  `, { parseJson: false });

  const verificationRows = executeRemote(`
    SELECT
      EXISTS(SELECT 1 FROM d1_migrations WHERE name = '${LEGACY_VISUAL_MIGRATION}') AS legacy_recorded,
      EXISTS(SELECT 1 FROM d1_migrations WHERE name = '${CURRENT_VISUAL_MIGRATION}') AS current_recorded;
  `);
  if (flag(verificationRows[0], 'legacy_recorded') || !flag(verificationRows[0], 'current_recorded')) {
    throw new Error('D1 migration history reconciliation did not persist the expected ledger state.');
  }

  console.log(`Reconciled deployed D1 migration history: ${LEGACY_VISUAL_MIGRATION} -> ${CURRENT_VISUAL_MIGRATION}.`);
  return { changed: true, reason: 'renamed-deployed-migration' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    reconcileD1MigrationHistory();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
