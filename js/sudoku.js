// Core Sudoku engine: generation, solving, and validation helpers.
// Grid representation: flat Uint8Array/Array of 81 numbers, 0 = empty, row-major (index = r*9+c).

const SIZE = 9;
const BOX = 3;

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rc(index) {
  return [Math.floor(index / SIZE), index % SIZE];
}

function idx(r, c) {
  return r * SIZE + c;
}

export function boxIndex(r, c) {
  return Math.floor(r / BOX) * BOX + Math.floor(c / BOX);
}

// Returns true if placing `val` at (r,c) does not conflict with existing entries.
export function isSafe(grid, r, c, val) {
  for (let i = 0; i < SIZE; i++) {
    if (i !== c && grid[idx(r, i)] === val) return false;
    if (i !== r && grid[idx(i, c)] === val) return false;
  }
  const br = Math.floor(r / BOX) * BOX;
  const bc = Math.floor(c / BOX) * BOX;
  for (let dr = 0; dr < BOX; dr++) {
    for (let dc = 0; dc < BOX; dc++) {
      const rr = br + dr, cc = bc + dc;
      if ((rr !== r || cc !== c) && grid[idx(rr, cc)] === val) return false;
    }
  }
  return true;
}

// Finds the empty cell with the fewest legal candidates (MRV heuristic) for faster backtracking.
function findBestEmptyCell(grid) {
  let best = -1;
  let bestCount = 10;
  let bestCandidates = null;
  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue;
    const [r, c] = rc(i);
    const candidates = [];
    for (let v = 1; v <= 9; v++) {
      if (isSafe(grid, r, c, v)) candidates.push(v);
    }
    if (candidates.length < bestCount) {
      bestCount = candidates.length;
      best = i;
      bestCandidates = candidates;
      if (bestCount === 0) return { index: i, candidates };
    }
  }
  return best === -1 ? null : { index: best, candidates: bestCandidates };
}

// Fills an empty grid completely at random, producing a full valid solution.
export function generateFullSolution() {
  const grid = new Array(81).fill(0);

  function fill() {
    const cell = findBestEmptyCell(grid);
    if (!cell) return true;
    if (cell.candidates.length === 0) return false;
    const { index, candidates } = cell;
    const [r, c] = rc(index);
    for (const v of shuffled(candidates)) {
      grid[index] = v;
      if (fill()) return true;
      grid[index] = 0;
    }
    return false;
  }

  fill();
  return grid;
}

// Counts solutions up to `limit` (default 2) to check for uniqueness without exhaustive search.
export function countSolutions(grid, limit = 2) {
  const working = grid.slice();
  let count = 0;

  function search() {
    if (count >= limit) return;
    const cell = findBestEmptyCell(working);
    if (!cell) {
      count++;
      return;
    }
    if (cell.candidates.length === 0) return;
    const { index, candidates } = cell;
    for (const v of candidates) {
      working[index] = v;
      search();
      working[index] = 0;
      if (count >= limit) return;
    }
  }

  search();
  return count;
}

export function solve(grid) {
  const working = grid.slice();
  function step() {
    const cell = findBestEmptyCell(working);
    if (!cell) return true;
    if (cell.candidates.length === 0) return false;
    const { index, candidates } = cell;
    for (const v of shuffled(candidates)) {
      working[index] = v;
      if (step()) return true;
      working[index] = 0;
    }
    return false;
  }
  step();
  return working;
}

const DIFFICULTIES = {
  easy: 40,
  medium: 33,
  hard: 27,
  expert: 24,
};

// Removes digits from a full solution while preserving a unique solution, down to
// roughly `targetGivens` cells (best-effort — stops early if removal would create ambiguity).
export function generatePuzzle(difficulty = 'medium') {
  const solution = generateFullSolution();
  const puzzle = solution.slice();
  const targetGivens = DIFFICULTIES[difficulty] ?? DIFFICULTIES.medium;

  const order = shuffled([...Array(81).keys()]);
  let givens = 81;

  for (const index of order) {
    if (givens <= targetGivens) break;
    const backup = puzzle[index];
    if (backup === 0) continue;
    puzzle[index] = 0;
    if (countSolutions(puzzle, 2) === 1) {
      givens--;
    } else {
      puzzle[index] = backup;
    }
  }

  return { puzzle, solution, givens };
}

// Returns the set (as "r,c" strings) of empty cells where `value` cannot legally be placed,
// because it already appears in that row, column, or 3x3 box. Also returns the source cells
// that already hold `value` on the board.
export function unavailableCellsForValue(grid, value) {
  const sources = [];
  for (let i = 0; i < 81; i++) {
    if (grid[i] === value) sources.push(i);
  }

  const unavailable = new Set();
  for (const sourceIndex of sources) {
    const [r, c] = rc(sourceIndex);
    for (let i = 0; i < SIZE; i++) {
      const rowIdx = idx(r, i);
      const colIdx = idx(i, c);
      if (grid[rowIdx] === 0) unavailable.add(rowIdx);
      if (grid[colIdx] === 0) unavailable.add(colIdx);
    }
    const br = Math.floor(r / BOX) * BOX;
    const bc = Math.floor(c / BOX) * BOX;
    for (let dr = 0; dr < BOX; dr++) {
      for (let dc = 0; dc < BOX; dc++) {
        const boxIdx = idx(br + dr, bc + dc);
        if (grid[boxIdx] === 0) unavailable.add(boxIdx);
      }
    }
  }

  return { unavailable, sources: new Set(sources) };
}

export { SIZE, BOX, idx, rc };
