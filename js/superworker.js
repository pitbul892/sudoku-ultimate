import { createSuperPuzzle } from './supersudoku.js';

self.onmessage = (event) => {
  const { difficulty } = event.data;
  try {
    const result = createSuperPuzzle(difficulty);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
