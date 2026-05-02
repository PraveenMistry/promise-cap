'use strict';

// ---------------------------------------------------------------------------
// Lightweight doubly-linked-list priority queue — zero 3rd-party deps
// ---------------------------------------------------------------------------
class Node {
  constructor(value, priority) {
    this.value = value;
    this.priority = priority;
    this.next = null;
    this.prev = null;
  }
}

class PriorityQueue {
  constructor() {
    this._head = new Node(null, -Infinity);
    this._tail = new Node(null, +Infinity);
    this._head.next = this._tail;
    this._tail.prev = this._head;
    this.size = 0;
  }

  enqueue(value, priority = 0) {
    const node = new Node(value, priority);
    let cursor = this._tail.prev;
    // Walk backward to find insertion point (stable FIFO within same priority)
    while (cursor !== this._head && cursor.priority < priority) {
      cursor = cursor.prev;
    }
    node.prev = cursor;
    node.next = cursor.next;
    cursor.next.prev = node;
    cursor.next = node;
    this.size++;
  }

  dequeue() {
    const node = this._head.next;
    if (node === this._tail) return undefined;
    node.prev.next = node.next;
    node.next.prev = node.prev;
    this.size--;
    return node.value;
  }

  drain(cb) {
    let node = this._head.next;
    while (node !== this._tail) {
      const next = node.next;
      cb(node.value);
      node = next;
    }
    this._head.next = this._tail;
    this._tail.prev = this._head;
    this.size = 0;
  }

  clear() {
    this._head.next = this._tail;
    this._tail.prev = this._head;
    this.size = 0;
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
class AbortError extends Error {
  constructor(message = 'Task aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

class TimeoutError extends Error {
  constructor(ms) {
    super(`Task timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

class DeadlockError extends Error {
  constructor() {
    super(
      '[promise-cap] Deadlock detected: a task called the same limiter it is ' +
      'running inside. Use a separate limiter for nested calls.'
    );
    this.name = 'DeadlockError';
  }
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------
function pCap(concurrencyOrOptions) {
  let concurrency, rejectOnClear;

  if (typeof concurrencyOrOptions === 'object' && concurrencyOrOptions !== null) {
    ({ concurrency, rejectOnClear = false } = concurrencyOrOptions);
  } else {
    concurrency = concurrencyOrOptions;
    rejectOnClear = false;
  }

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('Concurrency must be an integer >= 1');
  }

  const queue = new PriorityQueue();
  let activeCount = 0;
  let isPaused = false;

  // AsyncLocalStorage lets us detect when a task is nested inside itself
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();

  // -------------------------------------------------------------------------
  function resumeNext() {
    if (isPaused) return;
    if (activeCount < concurrency && queue.size > 0) {
      const item = queue.dequeue();
      item.run();
    }
  }

  function next() {
    activeCount--;
    resumeNext();
  }

  function run(fn, args, resolve, reject, signal, timeoutMs) {
    activeCount++;

    if (signal?.aborted) {
      activeCount--;
      // give back the slot properly
      queueMicrotask(() => {
        activeCount--; // undo the increment above — we already did it
        resumeNext();
      });
      // Actually: just decrement inline and call next
      activeCount++; // restore so next() is balanced
      next();
      reject(new AbortError(signal.reason?.message ?? 'Task aborted'));
      return;
    }

    let settled = false;
    let timeoutHandle;

    const settle = (type, valueOrError) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener('abort', onAbort);
      next();
      if (type === 'ok') resolve(valueOrError);
      else reject(valueOrError);
    };

    const onAbort = () =>
      settle('err', new AbortError(signal.reason?.message ?? 'Task aborted'));

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs != null) {
      timeoutHandle = setTimeout(
        () => settle('err', new TimeoutError(timeoutMs)),
        timeoutMs
      );
    }

    // Run inside ALS context so nested enqueue() can detect this limiter
    als.run(true, () => {
      let result;
      try {
        result = fn(...args);
      } catch (err) {
        settle('err', err);
        return;
      }
      Promise.resolve(result).then(
        (val) => settle('ok', val),
        (err) => settle('err', err),
      );
    });
  }

  function enqueue(fn, args, resolve, reject, priority, signal, timeoutMs) {
    if (signal?.aborted) {
      queueMicrotask(() => reject(new AbortError(signal.reason?.message ?? 'Task aborted')));
      return;
    }

    const item = {
      run: () => run(fn, args, resolve, reject, signal, timeoutMs),
      reject,
    };

    queueMicrotask(() => {
      if (signal?.aborted) {
        reject(new AbortError(signal.reason?.message ?? 'Task aborted'));
        return;
      }

      // Deadlock detection: if we are currently inside a task on this limiter
      // AND all slots are full (or this would fill the last slot leaving no
      // room for us to return), reject immediately.
      const insideSelf = als.getStore() === true;

      if (!isPaused && activeCount < concurrency) {
        if (insideSelf) {
          // Nested call on same limiter — will deadlock when concurrency=1,
          // but might work with higher concurrency. Warn and proceed only if
          // there's actually a free slot right now.
          // With concurrency > 1 this is valid (just unusual), so only
          // error when we KNOW it will deadlock: activeCount+1 >= concurrency
          // and the inner task would be waiting for the outer to finish first.
          // The simplest safe rule: always warn but only reject if concurrency=1.
          if (concurrency === 1) {
            const err = new DeadlockError();
            process.emitWarning(err.message, { code: 'P_CAP_DEADLOCK' });
            reject(err);
            return;
          }
        }
        item.run();
      } else {
        if (insideSelf) {
          // We're inside a task on this limiter and there are no free slots.
          // This is a guaranteed deadlock.
          const err = new DeadlockError();
          process.emitWarning(err.message, { code: 'P_CAP_DEADLOCK' });
          reject(err);
          return;
        }
        queue.enqueue(item, priority);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  function limit(fn, ...args) {
    return new Promise((resolve, reject) => {
      enqueue(fn, args, resolve, reject, 0, undefined, undefined);
    });
  }

  limit.run = function(fn, options, ...args) {
    const { priority = 0, signal, timeout: timeoutMs } = options ?? {};
    return new Promise((resolve, reject) => {
      enqueue(fn, args, resolve, reject, priority, signal, timeoutMs);
    });
  };

  limit.map = async function(iterable, mapper, mapOptions = {}) {
    const { stopOnError = true, priority = 0, timeout: timeoutMs } = mapOptions;
    const items = Array.from(iterable);

    if (stopOnError) {
      return Promise.all(
        items.map((item, index) =>
          limit.run(mapper, { priority, timeout: timeoutMs }, item, index)
        )
      );
    }

    const results = new Array(items.length);
    const errors = [];

    await Promise.all(
      items.map((item, index) =>
        limit.run(mapper, { priority, timeout: timeoutMs }, item, index).then(
          (val) => { results[index] = val; },
          (err) => { errors.push(err); },
        )
      )
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} task(s) failed`);
    }
    return results;
  };

  limit.clearQueue = function() {
    if (rejectOnClear) {
      queue.drain((item) => item.reject(new AbortError('Queue cleared')));
    } else {
      queue.clear();
    }
  };

  limit.pause = function() { isPaused = true; };

  limit.resume = function() {
    if (!isPaused) return;
    isPaused = false;
    while (activeCount < concurrency && queue.size > 0) {
      resumeNext();
    }
  };

  Object.defineProperties(limit, {
    activeCount: { get: () => activeCount, enumerable: true },
    pendingCount: { get: () => queue.size, enumerable: true },
    isPaused:    { get: () => isPaused, enumerable: true },
    concurrency: {
      get: () => concurrency,
      set(value) {
        if (!Number.isInteger(value) || value < 1)
          throw new TypeError('Concurrency must be an integer >= 1');
        concurrency = value;
        queueMicrotask(() => {
          while (!isPaused && activeCount < concurrency && queue.size > 0)
            resumeNext();
        });
      },
      enumerable: true,
    },
  });

  return limit;
}

// ---------------------------------------------------------------------------
// limitFunction
// ---------------------------------------------------------------------------
function limitFunction(fn, options) {
  const limit = pCap(options);
  return function(...args) {
    return limit.run(fn, {}, ...args);
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = pCap;
module.exports.pCap = pCap;
module.exports.limitFunction = limitFunction;
module.exports.AbortError = AbortError;
module.exports.TimeoutError = TimeoutError;
module.exports.DeadlockError = DeadlockError;
module.exports.default = pCap;