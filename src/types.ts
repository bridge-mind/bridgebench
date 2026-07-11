/**
 * Compatibility barrel for existing imports.
 *
 * New modules should import from `src/contracts/*` so category, task, event,
 * journal, gateway, and report boundaries stay explicit.
 */
export * from './contracts/categories.js';
export * from './contracts/events.js';
export * from './contracts/journal.js';
export * from './contracts/models.js';
export * from './contracts/reports.js';
export * from './contracts/tasks.js';
