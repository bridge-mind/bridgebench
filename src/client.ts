/**
 * BridgeBench push-protocol client.
 *
 * The engine side of the engine↔API protocol: fetch an execution pack,
 * register a run, stream events, and publish task packs and match journals
 * to a BridgeBench API behind the x-bridgebench-admin-key header.
 */
export * from './api-client.js';
export * from './publish.js';
export * from './remote-arena.js';
export * from './remote-events.js';
