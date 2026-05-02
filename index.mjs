// ESM wrapper — re-exports from the CJS source so we don't ship two copies of
// the logic. Node resolves this via the "exports" field in package.json.
import cjs from './index.js';

const { pCap, limitFunction, AbortError, TimeoutError, DeadlockError } = cjs;

export { pCap, limitFunction, AbortError, TimeoutError, DeadlockError };
export default pCap;
