/**
 * Public BridgeBench arena contract version.
 *
 * Increment this when an exported contract changes incompatibly. The entry
 * point intentionally exports contracts only; it has no arena-runner or
 * provider implementation dependency.
 */
export const CONTRACTS_VERSION = '2.0.0' as const;

export * from './categories.js';
export * from './events.js';
export * from './journal.js';
export * from './models.js';
export * from './reports.js';
export * from './tasks.js';
