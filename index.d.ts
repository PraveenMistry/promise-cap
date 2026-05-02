export interface LimitOptions {
  /**
   * Task priority. Higher numbers run first.
   * @default 0
   */
  priority?: number;

  /**
   * AbortSignal to cancel this individual task.
   * If the signal fires before the task starts, it is removed from the queue.
   * If it fires while the task is running, the returned promise rejects immediately.
   */
  signal?: AbortSignal;

  /**
   * Maximum milliseconds this task may run. Rejects with `TimeoutError` if exceeded.
   */
  timeout?: number;
}

export interface PCapOptions {
  /** Maximum number of tasks to run simultaneously. Must be >= 1. */
  concurrency: number;

  /**
   * When true, calling `clearQueue()` rejects all pending promises with `AbortError`.
   * @default false
   */
  rejectOnClear?: boolean;
}

export interface LimitFunction {
  /**
   * Enqueue `fn` with optional per-task options.
   *
   * @example
   * // Simple
   * await limit(fetchData, url)
   *
   * @example
   * // With per-task options
   * await limit.run(fetchData, { priority: 10, timeout: 5000, signal }, url)
   */
  <T>(fn: (...args: any[]) => PromiseLike<T> | T, ...args: any[]): Promise<T>;

  /**
   * Enqueue `fn` with explicit per-task options.
   */
  run<T, A extends any[]>(
    fn: (...args: A) => PromiseLike<T> | T,
    options: LimitOptions,
    ...args: A
  ): Promise<T>;

  /**
   * Process an iterable with limited concurrency.
   *
   * @param stopOnError - If `false`, all tasks run to completion and an
   *   `AggregateError` is thrown if any failed. Defaults to `true` (fail fast).
   */
  map<T, U>(
    iterable: Iterable<T>,
    mapper: (item: T, index: number) => PromiseLike<U> | U,
    options?: { stopOnError?: boolean; priority?: number; timeout?: number }
  ): Promise<U[]>;

  /** Discard all queued (not yet started) tasks. */
  clearQueue(): void;

  /** Pause the limiter — no new tasks will start until `resume()` is called. */
  pause(): void;

  /** Resume the limiter, starting queued tasks up to the concurrency limit. */
  resume(): void;

  /** Number of tasks currently running. */
  readonly activeCount: number;

  /** Number of tasks waiting in the queue. */
  readonly pendingCount: number;

  /** Whether the limiter is currently paused. */
  readonly isPaused: boolean;

  /** Get or set the concurrency limit at runtime. */
  concurrency: number;
}

export interface LimitFunctionOptions extends LimitOptions {
  concurrency: number;
  rejectOnClear?: boolean;
}

/**
 * Create a concurrency limiter.
 *
 * @example
 * import pCap from 'promise-cap';
 *
 * const limit = pCap(3); // max 3 concurrent
 *
 * const results = await Promise.all([
 *   limit.run(fetch, { timeout: 5000 }, 'https://example.com/a'),
 *   limit.run(fetch, { timeout: 5000 }, 'https://example.com/b'),
 * ]);
 */
export default function pCap(concurrency: number | PCapOptions): LimitFunction;
export { pCap };

/**
 * Wrap a single function with its own built-in concurrency limiter.
 */
export function limitFunction<T extends (...args: any[]) => any>(
  fn: T,
  options: number | LimitFunctionOptions
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;

/** Thrown when a task is cancelled via `AbortSignal` or `clearQueue()`. */
export class AbortError extends Error {
  name: 'AbortError';
}

/** Thrown when a task exceeds its `timeout` option. */
export class TimeoutError extends Error {
  name: 'TimeoutError';
}

/** Thrown when a nested deadlock is detected on the same limiter. */
export class DeadlockError extends Error {
  name: 'DeadlockError';
}
