/**
 * Moved to `@shared/store/migrate`, so the phone build gets the same migration
 * without importing through `src/main`.
 *
 * This file stays as a re-export because the migration is referenced by name in
 * the architecture notes, and a dangling path in documentation is worse than
 * one line of indirection.
 */

export { DEFAULT_SETTINGS, SCHEMA_VERSION, migrate } from '@shared/store/migrate'
export { emptyDocument, emptyDocument as emptyStore } from '@shared/store/core'
