/**
 * Compatibility barrel for existing imports.
 *
 * New modules should import from `src/contracts/*` so category, task, event,
 * journal, gateway, and report boundaries stay explicit.
 */
export * from './contracts/index.js';
