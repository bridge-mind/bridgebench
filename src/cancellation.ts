export class ArenaCancellationError extends Error {
  constructor(message = 'Arena run cancelled') {
    super(message);
    this.name = 'ArenaCancellationError';
  }
}

export function isArenaCancellationError(error: unknown): error is ArenaCancellationError {
  return error instanceof ArenaCancellationError;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArenaCancellationError();
}
