# p-cap

> Run async functions with limited concurrency — with priority queuing, AbortSignal, per-task timeouts, pause/resume, and deadlock detection. **Zero dependencies.**

Built as a drop-in improvement over [`p-limit`](https://github.com/sindresorhus/p-limit), fixing every known limitation while staying lighter (no third-party packages).

## Install

```sh
npm install p-cap
```

## Quick start

```js
import pCap from 'p-cap';

const limit = pCap(3); // max 3 concurrent tasks

const results = await Promise.all([
  limit.run(fetchUser, { timeout: 5000 }, userId),
  limit.run(fetchPosts, {}, userId),
  limit.run(fetchComments, { priority: 10 }, userId), // runs first!
]);
```

## API

### `pCap(concurrency | options)` → `limit`

Creates a concurrency limiter.

```js
const limit = pCap(3);
// or
const limit = pCap({ concurrency: 3, rejectOnClear: true });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | — | Max tasks running at once. Integer ≥ 1. |
| `rejectOnClear` | `boolean` | `false` | If `true`, `clearQueue()` rejects pending promises with `AbortError`. |

---

### `limit.run(fn, options, ...args)` → `Promise`

The primary way to enqueue a task.

```js
const result = await limit.run(myAsyncFn, { priority: 5, timeout: 3000, signal: ac.signal }, arg1, arg2);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `priority` | `number` | `0` | Higher runs first. Tasks with equal priority are FIFO. |
| `signal` | `AbortSignal` | — | Cancel this specific task. Works pre-queue and mid-run. |
| `timeout` | `number` | — | Reject with `TimeoutError` after this many milliseconds. |

---

### `limit(fn, ...args)` → `Promise`

Simple call — no options, uses priority `0`.

```js
await limit(myFn, arg1, arg2);
```

---

### `limit.map(iterable, mapper, options?)` → `Promise<Array>`

Process an iterable with limited concurrency.

```js
const results = await limit.map(urls, async (url) => fetch(url).then(r => r.json()));

// Don't stop on first error — collect all:
const results = await limit.map(urls, fetchJson, { stopOnError: false });
// throws AggregateError if any failed, with all errors in .errors
```

| Option | Type | Default | Description |
|---|---|---|---|
| `stopOnError` | `boolean` | `true` | If `false`, all tasks run and failures are collected in an `AggregateError`. |
| `priority` | `number` | `0` | Priority for all tasks in this map. |
| `timeout` | `number` | — | Per-task timeout in ms. |

---

### `limit.pause()` / `limit.resume()`

Suspend and resume task execution without losing the queue.

```js
limit.pause();
// ... add tasks, they will queue up but not run
limit.resume(); // starts queued tasks up to concurrency
```

---

### `limit.clearQueue()`

Discard all pending (not yet started) tasks. Does not affect running tasks.  
If `rejectOnClear: true` was set, each pending promise is rejected with `AbortError`.

---

### `limit.activeCount` / `limit.pendingCount` / `limit.isPaused`

Read-only properties reflecting current state.

---

### `limit.concurrency` *(getter/setter)*

Get or dynamically change the concurrency limit at runtime.

```js
limit.concurrency = 10; // immediately starts more queued tasks if available
```

---

### `limitFunction(fn, options)` → `wrappedFn`

Wrap a single function with its own built-in limiter.

```js
import { limitFunction } from 'p-cap';

const fetchWithLimit = limitFunction(fetch, { concurrency: 2 });

await Promise.all([
  fetchWithLimit('https://example.com/a'),
  fetchWithLimit('https://example.com/b'),
  fetchWithLimit('https://example.com/c'), // waits for a slot
]);
```

---

## Error types

All errors are exported as named classes:

```js
import { AbortError, TimeoutError, DeadlockError } from 'p-cap';
```

| Class | When thrown |
|---|---|
| `AbortError` | Task cancelled via `AbortSignal` or `clearQueue()` with `rejectOnClear`. |
| `TimeoutError` | Task exceeded its `timeout` option. |
| `DeadlockError` | A task tried to enqueue on the same limiter it is running inside (with no free slots). |

---

## Recipes

### Abort all tasks on shutdown

```js
const ac = new AbortController();
const limit = pCap({ concurrency: 5, rejectOnClear: true });

process.on('SIGTERM', () => {
  ac.abort();
  limit.clearQueue();
});

await limit.run(longRunningTask, { signal: ac.signal });
```

### Prioritise urgent work

```js
const limit = pCap(2);

// Background work
limit.run(syncData, { priority: 0 });
limit.run(syncData, { priority: 0 });
limit.run(syncData, { priority: 0 });

// User-triggered — jumps the queue
limit.run(handleUserRequest, { priority: 100 });
```

### Rate-limited API client

```js
import { limitFunction } from 'p-cap';

const callApi = limitFunction(
  (endpoint) => fetch(`https://api.example.com${endpoint}`).then(r => r.json()),
  { concurrency: 3 }
);

const [users, posts] = await Promise.all([callApi('/users'), callApi('/posts')]);
```

### Batch processing with error tolerance

```js
const limit = pCap(5);

const results = await limit.map(largeArray, processItem, {
  stopOnError: false,
  timeout: 10_000,
}).catch((err) => {
  if (err instanceof AggregateError) {
    console.error(`${err.errors.length} items failed:`, err.errors);
  }
  throw err;
});
```

---

## How p-cap improves on p-limit

| Feature | p-limit | p-cap |
|---|---|---|
| Basic concurrency limiting | ✅ | ✅ |
| Task priority | ❌ | ✅ |
| AbortSignal (per-task) | ❌ | ✅ |
| Per-task timeout | ❌ | ✅ |
| Pause / Resume | ❌ | ✅ |
| `map()` with `stopOnError: false` | ❌ | ✅ |
| Runtime deadlock detection | ❌ | ✅ |
| Dual CJS + ESM | ❌ (ESM only) | ✅ |
| Zero dependencies | ❌ (yocto-queue) | ✅ |
| Node.js requirement | ≥ 20 | ≥ 20 |

---

## Warning: recursive limiters

Calling the same `limit` inside a task it is already limiting creates a deadlock when `concurrency = 1`. p-cap detects this and rejects with `DeadlockError` + a `process.warning` so you can find it fast.

```js
const limit = pCap(1);

// ❌ This deadlocks — p-cap will reject and warn
await limit.run(async () => {
  await limit.run(innerTask, {}); // DeadlockError
}, {});

// ✅ Use a separate limiter for inner tasks
const innerLimit = pCap(3);
await limit.run(async () => {
  await innerLimit.run(innerTask, {});
}, {});
```

---

## License

MIT
