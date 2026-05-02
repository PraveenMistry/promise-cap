'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');

const pCap = require('../index.js');
const { limitFunction, AbortError, TimeoutError, DeadlockError } = require('../index.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const tick = () => new Promise((res) => queueMicrotask(res));

// ─── Basic concurrency ────────────────────────────────────────────────────────
describe('Basic concurrency', () => {
  test('runs tasks up to the concurrency limit', async () => {
    const limit = pCap(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(20);
      concurrent--;
    };

    await Promise.all([
      limit.run(task, {}),
      limit.run(task, {}),
      limit.run(task, {}),
      limit.run(task, {}),
    ]);

    assert.equal(maxConcurrent, 2, 'Never exceeded concurrency of 2');
  });

  test('activeCount reflects running tasks', async () => {
    const limit = pCap(2);
    const p1 = limit.run(() => delay(50), {});
    const p2 = limit.run(() => delay(50), {});
    limit.run(() => delay(50), {}); // queued
    await tick(); await tick();
    assert.equal(limit.activeCount, 2);
    assert.equal(limit.pendingCount, 1);
    await Promise.all([p1, p2]);
  });

  test('accepts options object for concurrency', () => {
    assert.doesNotThrow(() => pCap({ concurrency: 3 }));
  });

  test('throws on invalid concurrency', () => {
    assert.throws(() => pCap(0), TypeError);
    assert.throws(() => pCap(-1), TypeError);
    assert.throws(() => pCap(1.5), TypeError);
    assert.throws(() => pCap('3'), TypeError);
  });

  test('resolves with the return value of fn', async () => {
    const limit = pCap(1);
    const result = await limit.run(() => 42, {});
    assert.equal(result, 42);
  });

  test('rejects if fn throws synchronously', async () => {
    const limit = pCap(1);
    await assert.rejects(
      limit.run(() => { throw new Error('sync throw'); }, {}),
      /sync throw/
    );
  });

  test('rejects if fn returns a rejected promise', async () => {
    const limit = pCap(1);
    await assert.rejects(
      limit.run(() => Promise.reject(new Error('async fail')), {}),
      /async fail/
    );
  });

  test('one failure does not block other tasks', async () => {
    const limit = pCap(2);
    const results = await Promise.allSettled([
      limit.run(() => Promise.reject(new Error('fail')), {}),
      limit.run(() => 'ok', {}),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
  });
});

// ─── Priority queue ───────────────────────────────────────────────────────────
describe('Priority queue', () => {
  test('higher priority tasks run before lower priority ones', async () => {
    const limit = pCap(1);
    const order = [];

    // Fill the one slot so everything else queues
    const blocker = limit.run(() => delay(30), {});

    // Queue tasks with different priorities (they will queue, not run yet)
    limit.run(async () => order.push('low'), { priority: 0 });
    limit.run(async () => order.push('high'), { priority: 10 });
    limit.run(async () => order.push('medium'), { priority: 5 });

    await blocker;
    // Wait for all queued tasks to complete
    await delay(50);

    assert.deepEqual(order, ['high', 'medium', 'low']);
  });

  test('tasks with equal priority run in FIFO order', async () => {
    const limit = pCap(1);
    const order = [];
    const blocker = limit.run(() => delay(20), {});

    limit.run(async () => order.push(1), { priority: 5 });
    limit.run(async () => order.push(2), { priority: 5 });
    limit.run(async () => order.push(3), { priority: 5 });

    await blocker;
    await delay(30);
    assert.deepEqual(order, [1, 2, 3]);
  });
});

// ─── AbortSignal ─────────────────────────────────────────────────────────────
describe('AbortSignal', () => {
  test('pre-aborted signal skips task', async () => {
    const limit = pCap(1);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      limit.run(() => 'never', { signal: ac.signal }),
      AbortError
    );
  });

  test('aborting a queued task removes it from the queue', async () => {
    const limit = pCap(1);
    const ac = new AbortController();

    const blocker = limit.run(() => delay(50), {});
    const queued = limit.run(() => 'queued result', { signal: ac.signal });

    // Abort before the queued task starts
    ac.abort();

    await assert.rejects(queued, AbortError);
    await blocker;
    assert.equal(limit.pendingCount, 0);
  });

  test('aborting a running task rejects its promise', async () => {
    const limit = pCap(1);
    const ac = new AbortController();

    const p = limit.run(() => delay(200), { signal: ac.signal });
    await tick(); await tick();

    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, AbortError);
  });
});

// ─── Timeout ─────────────────────────────────────────────────────────────────
describe('Per-task timeout', () => {
  test('rejects with TimeoutError if task exceeds timeout', async () => {
    const limit = pCap(1);
    await assert.rejects(
      limit.run(() => delay(200), { timeout: 30 }),
      TimeoutError
    );
  });

  test('resolves normally if task completes within timeout', async () => {
    const limit = pCap(1);
    const result = await limit.run(() => delay(10).then(() => 'done'), { timeout: 200 });
    assert.equal(result, 'done');
  });

  test('next task starts after timeout frees the slot', async () => {
    const limit = pCap(1);
    const results = await Promise.allSettled([
      limit.run(() => delay(200), { timeout: 30 }),
      limit.run(() => 'second', {}),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].value, 'second');
  });
});

// ─── Pause / Resume ──────────────────────────────────────────────────────────
describe('Pause / Resume', () => {
  test('paused limiter does not start new tasks', async () => {
    const limit = pCap(2);
    limit.pause();
    assert.equal(limit.isPaused, true);

    limit.run(() => 'a', {});
    limit.run(() => 'b', {});
    await tick(); await tick();

    assert.equal(limit.activeCount, 0);
    assert.equal(limit.pendingCount, 2);
  });

  test('resume starts queued tasks', async () => {
    const limit = pCap(2);
    limit.pause();

    const results = [];
    const p1 = limit.run(async () => { results.push(1); return 1; }, {});
    const p2 = limit.run(async () => { results.push(2); return 2; }, {});

    await tick();
    assert.equal(results.length, 0);

    limit.resume();
    await Promise.all([p1, p2]);
    assert.deepEqual(results, [1, 2]);
  });

  test('isPaused property reflects state', () => {
    const limit = pCap(1);
    assert.equal(limit.isPaused, false);
    limit.pause();
    assert.equal(limit.isPaused, true);
    limit.resume();
    assert.equal(limit.isPaused, false);
  });
});

// ─── clearQueue ───────────────────────────────────────────────────────────────
describe('clearQueue', () => {
  test('discards pending tasks', async () => {
    const limit = pCap(1);
    const ran = [];

    const blocker = limit.run(() => delay(50), {});
    limit.run(async () => ran.push(1), {});
    limit.run(async () => ran.push(2), {});

    await tick();
    limit.clearQueue();
    assert.equal(limit.pendingCount, 0);

    await blocker;
    await delay(10);
    assert.deepEqual(ran, [], 'Cleared tasks never ran');
  });

  test('rejectOnClear rejects pending promises', async () => {
    const limit = pCap({ concurrency: 1, rejectOnClear: true });
    const blocker = limit.run(() => delay(50), {});
    const queued = limit.run(() => 'never', {});

    await tick();
    limit.clearQueue();

    await assert.rejects(queued, AbortError);
    await blocker;
  });
});

// ─── Dynamic concurrency ─────────────────────────────────────────────────────
describe('Dynamic concurrency', () => {
  test('increasing concurrency starts queued tasks', async () => {
    const limit = pCap(1);
    const ran = [];

    const blocker = limit.run(() => delay(30), {});
    const p2 = limit.run(async () => { ran.push(2); }, {});
    const p3 = limit.run(async () => { ran.push(3); }, {});

    await tick();
    assert.equal(limit.pendingCount, 2);

    limit.concurrency = 3;
    await Promise.all([blocker, p2, p3]);
    assert.deepEqual(ran, [2, 3]);
  });

  test('throws on invalid concurrency set', () => {
    const limit = pCap(2);
    assert.throws(() => { limit.concurrency = 0; }, TypeError);
  });
});

// ─── map() ───────────────────────────────────────────────────────────────────
describe('limit.map()', () => {
  test('processes all items and returns results in order', async () => {
    const limit = pCap(2);
    const results = await limit.map([1, 2, 3, 4], async (n) => n * 2);
    assert.deepEqual(results, [2, 4, 6, 8]);
  });

  test('stopOnError=true (default) fails fast', async () => {
    const limit = pCap(2);
    await assert.rejects(
      limit.map([1, 2, 3], async (n) => {
        if (n === 2) throw new Error('fail at 2');
        return n;
      }),
      /fail at 2/
    );
  });

  test('stopOnError=false collects all errors in AggregateError', async () => {
    const limit = pCap(3);
    const err = await limit.map(
      [1, 2, 3],
      async (n) => {
        if (n !== 2) throw new Error(`fail ${n}`);
        return n;
      },
      { stopOnError: false }
    ).catch((e) => e);

    assert.ok(err instanceof AggregateError);
    assert.equal(err.errors.length, 2);
  });

  test('passes index to mapper', async () => {
    const limit = pCap(2);
    const indices = [];
    await limit.map(['a', 'b', 'c'], async (item, i) => { indices.push(i); });
    assert.deepEqual(indices.sort(), [0, 1, 2]);
  });
});

// ─── limitFunction ────────────────────────────────────────────────────────────
describe('limitFunction()', () => {
  test('wraps a function with concurrency limiting', async () => {
    let concurrent = 0;
    let max = 0;
    const fn = limitFunction(async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await delay(20);
      concurrent--;
    }, { concurrency: 2 });

    await Promise.all([fn(), fn(), fn(), fn()]);
    assert.equal(max, 2);
  });

  test('passes arguments through', async () => {
    const fn = limitFunction(async (a, b) => a + b, { concurrency: 1 });
    const result = await fn(3, 4);
    assert.equal(result, 7);
  });
});

// ─── Deadlock detection ──────────────────────────────────────────────────────
describe('Deadlock detection', () => {
  test('emits warning and rejects on deadlock', async () => {
    const limit = pCap(1);
    const warnings = [];

    // Register listener BEFORE creating tasks
    const onWarning = (w) => warnings.push(w);
    process.on('warning', onWarning);

    try {
      const outer = limit.run(async () => {
        // Nested call on same limiter with concurrency=1 — guaranteed deadlock
        return limit.run(() => 'inner', {});
      }, {});

      await assert.rejects(outer, DeadlockError);
      // Allow the warning emission microtask to flush
      await delay(10);
      assert.ok(warnings.some((w) => w.code === 'P_CAP_DEADLOCK'), 'Warning emitted');
    } finally {
      process.off('warning', onWarning);
    }
  });
});

// ─── Zero-dependency check ────────────────────────────────────────────────────
describe('Zero dependencies', () => {
  test('package.json has no runtime dependencies', () => {
    const pkg = require('../package.json');
    const deps = pkg.dependencies ?? {};
    assert.equal(Object.keys(deps).length, 0, 'No runtime dependencies');
  });
});

console.log('✓ All tests defined — running with node:test runner\n');
