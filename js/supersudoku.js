// Super Sudoku engine: 8 interlocking 9x9 sudoku variants arranged in a ring,
// where EVERY pair of ring-neighbors overlaps in exactly one shared 3x3 box
// (a single-corner touch, like classic Samurai Sudoku's hub/corner overlaps) —
// never a full shared edge. There is no 9th "hub" grid; the 8 grids touch each
// other directly, tracing a closed diamond-shaped ring with an unused hole
// in the middle.
//
// Derivation: two 3-box-wide grids overlap in exactly one corner box iff their
// origins differ by exactly (±2,±2) box-units (both dimensions offset by 2 —
// an offset of (±2,0) or (0,±2) instead would share a full 3-box edge, which
// is exactly what we must avoid). Walking 8 such diagonal steps in the order
// ++, ++, +-, +-, --, --, -+, -+ traces a closed loop (a rhombus/diamond) that
// visits 8 distinct box-positions with no accidental overlaps between
// non-neighboring grids — verified against every non-consecutive pair.
//
// Every sub-grid always requires its own 9 rows + 9 columns + 9 boxes (or, for the
// "irregular" grid, 9 jigsaw regions instead of boxes) to contain 1-9 exactly once.
// Some variants add extra all-different groups (diagonals, offset classes, cages).
// Consecutive bridges and greater/less signs need no extra constraint: they are
// simply read off the finished solution, since they are true by construction.

const LOCAL_SIZE = 9;

// Grid metadata: id, display name, short rule text, top-left cell origin on the
// shared canvas (cell units = box-units * 3; see derivation above), rule type.
export const GRID_DEFS = [
  {
    id: 'standard',
    name: 'Обычное Судоку',
    rule: 'standard',
    origin: [0, 12],
    hint: 'Ничего особенного — обычные правила судоку.',
  },
  {
    id: 'sum',
    name: 'Судоку на Сложение',
    rule: 'sum',
    origin: [6, 18],
    hint: 'Сумма чисел в выделенной группе клеток равна числу-подсказке рядом с ней.',
  },
  {
    id: 'consecutive',
    name: 'Последовательное Судоку',
    rule: 'consecutive',
    origin: [12, 24],
    hint: 'Розовый мостик между клетками означает, что их числа соседние (отличаются на 1).',
  },
  {
    id: 'irregular',
    name: 'Нестандартные Блоки',
    rule: 'irregular',
    origin: [18, 18],
    hint: 'Вместо квадратов 3×3 — фигурные блоки. Правила те же: каждая фигура содержит 1-9.',
  },
  {
    id: 'offset',
    name: 'Смещённое Судоку',
    rule: 'offset',
    origin: [24, 12],
    hint: 'Дополнительно: клетки одного цвета (одинаковая позиция внутри своего квадрата) тоже содержат 1-9.',
  },
  {
    id: 'x',
    name: 'Судоку X',
    rule: 'x',
    origin: [18, 6],
    hint: 'Обе главные диагонали (отмечены) также содержат числа 1-9.',
  },
  {
    id: 'killer',
    name: 'Судоку-Киллер',
    rule: 'killer',
    origin: [12, 0],
    hint: 'Числа внутри выделенной пунктиром области не повторяются и суммируются в число в её углу.',
  },
  {
    id: 'greater',
    name: '>Судоку<',
    rule: 'greater',
    origin: [6, 6],
    hint: 'Знаки «больше»/«меньше» между соседними клетками должны быть верными.',
  },
];

function localIndex(r, c) {
  return r * LOCAL_SIZE + c;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Jigsaw region generation (for the "irregular" grid) ---------------------

const SEED_CELLS = [
  [1, 1], [1, 4], [1, 7],
  [4, 1], [4, 4], [4, 7],
  [7, 1], [7, 4], [7, 7],
];

// `lockedBoxIds` (0-8, row-major) are pinned to their plain 3x3 shape instead
// of being grown/scrambled — used to keep a grid's shared corners as regular
// squares so they don't visually conflict with whatever the neighboring grid
// draws there.
function tryGenerateJigsaw(lockedBoxIds = []) {
  const region = new Array(81).fill(-1);
  const regionCells = Array.from({ length: 9 }, () => []);
  const locked = new Set(lockedBoxIds);

  for (const boxId of locked) {
    const br = Math.floor(boxId / 3) * 3;
    const bc = (boxId % 3) * 3;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        const idx = localIndex(br + dr, bc + dc);
        region[idx] = boxId;
        regionCells[boxId].push(idx);
      }
    }
  }

  SEED_CELLS.forEach(([r, c], id) => {
    if (locked.has(id)) return;
    const idx = localIndex(r, c);
    region[idx] = id;
    regionCells[id].push(idx);
  });

  const candidatesFor = (id) => {
    const candidates = new Set();
    for (const cellIdx of regionCells[id]) {
      const r = Math.floor(cellIdx / 9);
      const c = cellIdx % 9;
      const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      for (const [nr, nc] of neighbors) {
        if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
        const nIdx = localIndex(nr, nc);
        if (region[nIdx] === -1) candidates.add(nIdx);
      }
    }
    return candidates;
  };

  let remaining = 81 - regionCells.reduce((sum, cells) => sum + cells.length, 0);
  let stalled = 0;
  while (remaining > 0) {
    const growable = shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8].filter((id) => !locked.has(id) && regionCells[id].length < 9));
    // Most-constrained-first: growing the region with the fewest options first
    // sharply cuts how often a region gets boxed in with nowhere left to grow
    // (the deadlock this whole retry loop exists to recover from).
    growable.sort((a, b) => candidatesFor(a).size - candidatesFor(b).size);
    let progressed = false;
    for (const id of growable) {
      if (regionCells[id].length >= 9) continue;
      const candidates = candidatesFor(id);
      if (candidates.size === 0) continue;
      const pick = shuffled([...candidates])[0];
      region[pick] = id;
      regionCells[id].push(pick);
      remaining--;
      progressed = true;
    }
    if (!progressed) {
      stalled++;
      if (stalled > 3) return null; // deadlocked, caller should retry
    } else {
      stalled = 0;
    }
  }
  return region;
}

// Regions that came out as a plain 3x3 box. Growth leaves several of them by
// chance, and a layout full of squares reads as an ordinary grid rather than a
// jigsaw one. Two are already spoken for by the locked corners, so the cap
// allows one more; about 63% of layouts pass, making the retry cheap.
const MAX_PLAIN_SQUARES = 3;

function plainSquareCount(region) {
  const cellsById = Array.from({ length: 9 }, () => []);
  region.forEach((id, idx) => cellsById[id].push(idx));

  let count = 0;
  for (const cells of cellsById) {
    if (cells.length !== 9) continue;
    const rows = cells.map((i) => Math.floor(i / 9));
    const cols = cells.map((i) => i % 9);
    const top = Math.min(...rows);
    const left = Math.min(...cols);
    if (top % 3 !== 0 || left % 3 !== 0) continue;
    // 9 cells inside one aligned 3x3 window can only be that whole box.
    if (rows.every((r) => r < top + 3) && cols.every((c) => c < left + 3)) count++;
  }
  return count;
}

export function generateJigsawRegions(lockedBoxIds = []) {
  for (let attempt = 0; attempt < 5000; attempt++) {
    const result = tryGenerateJigsaw(lockedBoxIds);
    if (result && plainSquareCount(result) <= MAX_PLAIN_SQUARES) return result;
  }
  throw new Error('Failed to generate jigsaw regions');
}

// --- Killer cage generation (for the "killer" grid) ---------------------------

export function generateCages() {
  const claimed = new Array(81).fill(false);
  const cages = [];
  const order = shuffled([...Array(81).keys()]);

  for (const start of order) {
    if (claimed[start]) continue;
    const targetSize = 1 + Math.floor(Math.random() * 3) + 1; // 2..4
    const cage = [start];
    claimed[start] = true;
    while (cage.length < targetSize) {
      const frontier = new Set();
      for (const cellIdx of cage) {
        const r = Math.floor(cellIdx / 9);
        const c = cellIdx % 9;
        const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
        for (const [nr, nc] of neighbors) {
          if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
          const nIdx = localIndex(nr, nc);
          if (!claimed[nIdx]) frontier.add(nIdx);
        }
      }
      if (frontier.size === 0) break;
      const pick = shuffled([...frontier])[0];
      cage.push(pick);
      claimed[pick] = true;
    }
    cages.push(cage);
  }
  return cages;
}

// --- Sum-group generation (for the "sum" grid) --------------------------------
//
// The rule: a connected blob of 2-4 "blue" cells plus one "red" cell, where the
// red cell's own solved value equals the sum of the blue ones (so it's a real
// grid digit shown via its color, never a floating clue number — the group is
// just colored, and 9 is the hard ceiling since all cells are single digits).

function boxOfLocal(r, c) {
  return Math.floor(r / 3) * 3 + Math.floor(c / 3);
}

function allNeighbors(r, c) {
  const out = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < 8) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < 8) out.push([r, c + 1]);
  return out;
}

// `excludedBoxId` keeps groups out of the box shared with "standard".
export function generateSumGroups(excludedBoxId, targetCount) {
  const blocked = new Array(81).fill(false);
  const order = shuffled([...Array(81).keys()]);
  const groups = [];

  for (const red of order) {
    if (groups.length >= targetCount) break;
    if (blocked[red]) continue;
    const r0 = Math.floor(red / 9);
    const c0 = red % 9;
    if (boxOfLocal(r0, c0) === excludedBoxId) continue;

    const blueCount = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4
    const cells = [red];
    const claimed = new Set([red]);
    let ok = true;
    while (cells.length < blueCount + 1) {
      const frontier = new Set();
      for (const cell of cells) {
        const cr = Math.floor(cell / 9);
        const cc = cell % 9;
        for (const [nr, nc] of allNeighbors(cr, cc)) {
          const ni = nr * 9 + nc;
          if (blocked[ni] || claimed.has(ni) || boxOfLocal(nr, nc) === excludedBoxId) continue;
          frontier.add(ni);
        }
      }
      if (frontier.size === 0) {
        ok = false;
        break;
      }
      const pick = shuffled([...frontier])[0];
      cells.push(pick);
      claimed.add(pick);
    }
    if (!ok) continue;

    // Block the group's own cells plus a ring around them so no other group
    // ever ends up touching this one.
    for (const cell of cells) {
      blocked[cell] = true;
      const cr = Math.floor(cell / 9);
      const cc = cell % 9;
      for (const [nr, nc] of allNeighbors(cr, cc)) blocked[nr * 9 + nc] = true;
    }
    groups.push({ red, blues: cells.slice(1) });
  }
  return groups;
}

// --- Board assembly: merge 8 local 9x9 grids into one global cell/group set ---

export function buildBoard() {
  const cellKeyToIndex = new Map();
  const cellCoords = [];
  const grids = GRID_DEFS.map((def) => ({
    ...def,
    cellIndex: new Array(81), // local index -> global cell index
  }));

  for (const grid of grids) {
    const [originRow, originCol] = grid.origin;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const gr = originRow + r;
        const gc = originCol + c;
        const key = `${gr},${gc}`;
        let globalIndex = cellKeyToIndex.get(key);
        if (globalIndex === undefined) {
          globalIndex = cellCoords.length;
          cellKeyToIndex.set(key, globalIndex);
          cellCoords.push([gr, gc]);
        }
        grid.cellIndex[localIndex(r, c)] = globalIndex;
      }
    }
  }

  const groups = []; // each group: { type, gridId, cells: number[] (global indices), meta? }

  const jigsawByGrid = {};
  const cagesByGrid = {};
  const sumConstraints = [];

  for (const grid of grids) {
    const toGlobal = (localIdxList) => localIdxList.map((li) => grid.cellIndex[li]);

    for (let r = 0; r < 9; r++) {
      const rowLocal = [];
      for (let c = 0; c < 9; c++) rowLocal.push(localIndex(r, c));
      groups.push({ type: 'row', gridId: grid.id, cells: toGlobal(rowLocal) });
    }
    for (let c = 0; c < 9; c++) {
      const colLocal = [];
      for (let r = 0; r < 9; r++) colLocal.push(localIndex(r, c));
      groups.push({ type: 'col', gridId: grid.id, cells: toGlobal(colLocal) });
    }

    if (grid.rule === 'irregular') {
      // Boxes 2 (top-right) and 6 (bottom-left, row-major) are this grid's two
      // shared corners (with "consecutive" and "offset") — keep them as plain
      // 3x3 squares so the jigsaw shapes don't visually clash with whatever
      // the neighboring grid draws there.
      const region = generateJigsawRegions([2, 6]);
      jigsawByGrid[grid.id] = region;
      for (let id = 0; id < 9; id++) {
        const cellsLocal = [];
        for (let i = 0; i < 81; i++) if (region[i] === id) cellsLocal.push(i);
        groups.push({ type: 'box', gridId: grid.id, cells: toGlobal(cellsLocal) });
      }
    } else {
      for (let br = 0; br < 3; br++) {
        for (let bc = 0; bc < 3; bc++) {
          const cellsLocal = [];
          for (let dr = 0; dr < 3; dr++) {
            for (let dc = 0; dc < 3; dc++) {
              cellsLocal.push(localIndex(br * 3 + dr, bc * 3 + dc));
            }
          }
          groups.push({ type: 'box', gridId: grid.id, cells: toGlobal(cellsLocal) });
        }
      }
    }

    if (grid.rule === 'x') {
      const main = [];
      const anti = [];
      for (let i = 0; i < 9; i++) {
        main.push(localIndex(i, i));
        anti.push(localIndex(i, 8 - i));
      }
      groups.push({ type: 'diagonal', gridId: grid.id, cells: toGlobal(main) });
      groups.push({ type: 'diagonal', gridId: grid.id, cells: toGlobal(anti) });
    }

    if (grid.rule === 'offset') {
      for (let posR = 0; posR < 3; posR++) {
        for (let posC = 0; posC < 3; posC++) {
          const cellsLocal = [];
          for (let boxR = 0; boxR < 3; boxR++) {
            for (let boxC = 0; boxC < 3; boxC++) {
              cellsLocal.push(localIndex(boxR * 3 + posR, boxC * 3 + posC));
            }
          }
          groups.push({ type: 'offset', gridId: grid.id, cells: toGlobal(cellsLocal) });
        }
      }
    }

    if (grid.rule === 'killer') {
      const cages = generateCages();
      cagesByGrid[grid.id] = cages;
      for (const cage of cages) {
        groups.push({ type: 'cage', gridId: grid.id, cells: toGlobal(cage) });
      }
    }

    if (grid.rule === 'sum') {
      // Box 0 (top-left, row-major) is this grid's corner shared with
      // "standard" — kept free of groups so that corner stays uncluttered.
      const localGroups = generateSumGroups(0, 4 + Math.floor(Math.random() * 2));
      for (const group of localGroups) {
        sumConstraints.push({
          red: grid.cellIndex[group.red],
          blues: group.blues.map((li) => grid.cellIndex[li]),
        });
      }
    }
  }

  const cellCount = cellCoords.length;
  const peers = Array.from({ length: cellCount }, () => new Set());
  const cellGroups = Array.from({ length: cellCount }, () => []);
  for (const group of groups) {
    for (const idx of group.cells) cellGroups[idx].push(group);
    for (const a of group.cells) {
      for (const b of group.cells) {
        if (a !== b) peers[a].add(b);
      }
    }
  }

  // Which grid(s) own each global cell (for rendering / ownership lookups).
  const cellOwners = Array.from({ length: cellCount }, () => []);
  for (const grid of grids) {
    for (let li = 0; li < 81; li++) {
      cellOwners[grid.cellIndex[li]].push({ gridId: grid.id, local: li });
    }
  }

  const sumByCell = Array.from({ length: cellCount }, () => []);
  for (const constraint of sumConstraints) {
    sumByCell[constraint.red].push(constraint);
    for (const b of constraint.blues) sumByCell[b].push(constraint);
  }

  return {
    grids,
    groups,
    cellCoords,
    cellCount,
    sumConstraints,
    sumByCell,
    peers: peers.map((s) => [...s]),
    cellGroups,
    cellOwners,
    jigsawByGrid,
    cagesByGrid,
  };
}

// --- Generic constraint solver (works over arbitrary groups) -----------------
//
// Plain MRV backtracking thrashes badly once the board has ~500 coupled cells
// (shared cells between grids create long-range dependencies a purely local
// heuristic can't see). Instead we use bitmask constraint propagation — the
// technique behind fast Sudoku solvers (Norvig-style naked+hidden singles
// cascades) — so most of the board fills itself after each assignment and the
// search tree stays small.

const FULL_MASK = 0b111111111;
const POPCOUNT = new Array(512);
const SINGLE_DIGIT = new Array(512).fill(0);
for (let mask = 0; mask < 512; mask++) {
  let count = 0;
  for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) count++;
  POPCOUNT[mask] = count;
  if (count === 1) {
    for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) SINGLE_DIGIT[mask] = d;
  }
}

function digitsOf(mask) {
  const out = [];
  for (let d = 1; d <= 9; d++) if (mask & (1 << (d - 1))) out.push(d);
  return out;
}

// All achievable sums (capped at 9, since "red" is a single digit) of a list
// of cells given their current candidate domains, as a bitmask (bit s = sum s
// is reachable). Bitwise instead of Set-based: this runs on every relevant
// eliminate() call during search, and Set churn there was measured to blow up
// generation time (up to ~50s on some puzzles vs a couple hundred ms).
function achievableSumsMask(values, cells) {
  let sums = 1; // bit 0 set: sum 0 is achievable with zero cells picked so far
  for (const cell of cells) {
    const digitMask = values[cell]; // bit (d-1) set for each candidate digit d
    let next = 0;
    for (let s = 0; s <= 9; s++) {
      if (sums & (1 << s)) next |= digitMask << (s + 1);
    }
    sums = next & 0b1111111111; // keep only sum bits 0-9
  }
  return sums;
}

// Arc-consistency for a "sum" grid group: blues.reduce(sum) === red (2-4
// blues). Removes any candidate that could never satisfy the equation given
// the other cells' current domains. Called from eliminate() whenever one of
// the group's cells changes.
function enforceSumGroup(values, board, constraint) {
  const { red, blues } = constraint;

  const totalSums = achievableSumsMask(values, blues);
  for (const d of digitsOf(values[red])) {
    if (!(totalSums & (1 << d)) && eliminate(values, board, red, d) === null) return null;
  }

  for (let i = 0; i < blues.length; i++) {
    const cell = blues[i];
    const others = blues.filter((_, j) => j !== i);
    const otherSums = achievableSumsMask(values, others);
    for (const d of digitsOf(values[cell])) {
      // Need some achievable "others" sum os (0-9) with digit (d+os) a valid
      // red candidate — i.e. bit os of (red's candidate mask >> (d-1)) set —
      // so intersect that shifted mask with the achievable-sums bitmask.
      if (!(otherSums & (values[red] >> (d - 1))) && eliminate(values, board, cell, d) === null) return null;
    }
  }

  return values;
}

// Eliminates `d` as a possibility for cell `s`, cascading naked singles (a cell
// left with one candidate propagates to its peers) and hidden singles (a group
// where `d` has exactly one remaining home gets it assigned). Returns the same
// `values` array on success, or null on contradiction.
function eliminate(values, board, s, d) {
  const bit = 1 << (d - 1);
  if (!(values[s] & bit)) return values;
  values[s] &= ~bit;
  const remaining = values[s];
  if (remaining === 0) return null;
  if (POPCOUNT[remaining] === 1) {
    const d2 = SINGLE_DIGIT[remaining];
    for (const s2 of board.peers[s]) {
      if (eliminate(values, board, s2, d2) === null) return null;
    }
  }
  for (const group of board.cellGroups[s]) {
    // The "hidden single" deduction (digit has only one home left, so it must
    // go there) only holds for groups that must contain every digit 1-9 exactly
    // once (rows/cols/boxes/diagonals/offset-classes). Cages merely forbid
    // duplicates among 2-4 cells — a digit need not appear there at all, so
    // this check would force wrong assignments and thrash the search.
    if (group.cells.length !== 9) continue;
    let count = 0;
    let place = -1;
    for (const cell of group.cells) {
      if (values[cell] & bit) {
        count++;
        place = cell;
        if (count > 1) break;
      }
    }
    if (count === 0) return null;
    if (count === 1 && POPCOUNT[values[place]] > 1) {
      if (assign(values, board, place, d) === null) return null;
    }
  }

  for (const constraint of board.sumByCell[s]) {
    if (enforceSumGroup(values, board, constraint) === null) return null;
  }

  return values;
}

function assign(values, board, s, d) {
  const bit = 1 << (d - 1);
  for (const d2 of digitsOf(values[s] & ~bit)) {
    if (eliminate(values, board, s, d2) === null) return null;
  }
  return values;
}

function valuesFromGrid(board, grid) {
  const values = new Array(board.cellCount).fill(FULL_MASK);
  for (let i = 0; i < board.cellCount; i++) {
    if (grid[i] !== 0 && assign(values, board, i, grid[i]) === null) return null;
  }
  return values;
}

function pickBranchCell(values, board) {
  let best = -1;
  let bestCount = 10;
  for (let i = 0; i < board.cellCount; i++) {
    const count = POPCOUNT[values[i]];
    if (count > 1 && count < bestCount) {
      bestCount = count;
      best = i;
      if (bestCount === 2) break;
    }
  }
  return best;
}

function isSolved(values, board) {
  for (let i = 0; i < board.cellCount; i++) if (POPCOUNT[values[i]] !== 1) return false;
  return true;
}

function valuesToGrid(values, board) {
  const grid = new Array(board.cellCount);
  for (let i = 0; i < board.cellCount; i++) grid[i] = SINGLE_DIGIT[values[i]];
  return grid;
}

function searchOne(values, board, budget) {
  if (values === null || budget.exceeded) return null;
  budget.nodes++;
  if (budget.nodes > budget.max) {
    budget.exceeded = true;
    return null;
  }
  if (isSolved(values, board)) return values;
  const cell = pickBranchCell(values, board);
  for (const d of shuffled(digitsOf(values[cell]))) {
    if (budget.exceeded) return null;
    const copy = values.slice();
    const result = searchOne(assign(copy, board, cell, d) === null ? null : copy, board, budget);
    if (result) return result;
  }
  return null;
}

// Random full-grid layouts occasionally produce a genuinely hard sub-region (most
// often an awkward jigsaw shape) that thrashes backtracking. `maxNodes` bounds the
// search so a caller can give up and retry with a freshly generated board instead
// of hanging — see `createSuperPuzzle`, which does exactly that.
export function generateFullSolution(board, maxNodes = 5000000) {
  const budget = { nodes: 0, max: maxNodes, exceeded: false };
  const values = new Array(board.cellCount).fill(FULL_MASK);
  const solved = searchOne(values, board, budget);
  return solved ? valuesToGrid(solved, board) : null;
}

export function countSolutions(board, grid, limit = 2, nodeBudget = 60000) {
  const initial = valuesFromGrid(board, grid);
  let count = 0;
  let nodes = 0;
  let budgetExceeded = false;

  function search(values) {
    if (values === null || count >= limit || budgetExceeded) return;
    nodes++;
    if (nodes > nodeBudget) {
      budgetExceeded = true;
      return;
    }
    if (isSolved(values, board)) {
      count++;
      return;
    }
    const cell = pickBranchCell(values, board);
    for (const d of digitsOf(values[cell])) {
      const copy = values.slice();
      search(assign(copy, board, cell, d) === null ? null : copy);
      if (count >= limit || budgetExceeded) return;
    }
  }

  if (initial) search(initial);
  return { count, budgetExceeded };
}

const DIFFICULTY_KEEP_RATIO = {
  easy: 0.62,
  medium: 0.52,
  hard: 0.44,
  expert: 0.38,
};

function reduceToPuzzle(board, solution, difficulty) {
  const puzzle = solution.slice();
  const ratio = DIFFICULTY_KEEP_RATIO[difficulty] ?? DIFFICULTY_KEEP_RATIO.medium;
  const targetGivens = Math.round(board.cellCount * ratio);

  const order = shuffled([...Array(board.cellCount).keys()]);
  let givens = board.cellCount;

  for (const index of order) {
    if (givens <= targetGivens) break;
    const backup = puzzle[index];
    puzzle[index] = 0;
    const { count, budgetExceeded } = countSolutions(board, puzzle, 2);
    if (count === 1 && !budgetExceeded) {
      givens--;
    } else {
      puzzle[index] = backup;
    }
  }

  return { puzzle, givens };
}

// Builds a fresh 8-variant board and solves it, retrying with a brand new random
// layout (new jigsaw regions / cages / full grid) whenever a particular instance
// turns out to be pathologically slow. Cheap and robust: most random instances
// solve in milliseconds, so a handful of retries is enough in the rare bad case.
export function createSuperPuzzle(difficulty = 'medium', options = {}) {
  const maxAttempts = options.maxAttempts ?? 80;
  const nodeBudget = options.nodeBudget ?? 20000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let board;
    try {
      board = buildBoard();
    } catch {
      continue; // rare jigsaw-generation deadlock — just try a fresh layout
    }
    const solution = generateFullSolution(board, nodeBudget);
    if (!solution) continue;
    const { puzzle, givens } = reduceToPuzzle(board, solution, difficulty);
    const overlays = computeOverlays(board, solution);
    return { board, puzzle, solution, givens, attempts: attempt, overlays };
  }
  throw new Error('Не удалось сгенерировать Супер Судоку за разумное число попыток.');
}

function localNeighbors(r, c) {
  const out = [];
  if (c < 8) out.push({ dir: 'right', r, c: c + 1 });
  if (r < 8) out.push({ dir: 'down', r: r + 1, c });
  return out;
}

// Derives the purely-cosmetic/read-off overlays that need no generation-time
// constraint: consecutive bridges and greater/less signs are true by construction
// for whatever solution exists. Sum groups are a real constraint (see
// generateSumGroups/enforceSumGroup) — this just packages them for rendering.
export function computeOverlays(board, bySolution) {
  const consecutiveEdges = new Set();
  const comparisonSigns = new Map();
  const sumGroupsForRender = (board.sumConstraints || []).map(({ red, blues }) => ({
    blues,
    red,
    sum: bySolution[red],
  }));

  const grid = (rule) => board.grids.find((g) => g.rule === rule);

  const consecutiveGrid = grid('consecutive');
  if (consecutiveGrid) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const a = consecutiveGrid.cellIndex[r * 9 + c];
        for (const n of localNeighbors(r, c)) {
          const b = consecutiveGrid.cellIndex[n.r * 9 + n.c];
          if (Math.abs(bySolution[a] - bySolution[b]) === 1) {
            consecutiveEdges.add(`${a}:${b}`);
          }
        }
      }
    }
  }

  // Signs only make sense between cells in the same 3x3 box (reading a sign
  // across a box boundary reads as if it applies to the far side of the box,
  // which is confusing) — and are skipped entirely in the two boxes shared
  // with "standard" and "killer" so those grids' corners stay uncluttered.
  const EXCLUDED_GREATER_BOXES = new Set([2, 6]);
  const greaterGrid = grid('greater');
  if (greaterGrid) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const box = boxOfLocal(r, c);
        if (EXCLUDED_GREATER_BOXES.has(box)) continue;
        const a = greaterGrid.cellIndex[r * 9 + c];
        for (const n of localNeighbors(r, c)) {
          if (boxOfLocal(n.r, n.c) !== box) continue;
          const b = greaterGrid.cellIndex[n.r * 9 + n.c];
          comparisonSigns.set(`${a}:${b}`, bySolution[a] > bySolution[b] ? '>' : '<');
        }
      }
    }
  }

  return { consecutiveEdges, comparisonSigns, sumGroups: sumGroupsForRender };
}

// The lens reads the plain sudoku groups only. A grid's "box" group is already
// its own shape, so the jigsaw grid contributes its curved block here rather
// than a 3x3 square, and the X grid's two diagonals join in as groups of their
// own. Cages and the offset grid's position classes are real constraints for
// the solver but too indirect to read as a hint, so they stay out.
const LENS_GROUP_TYPES = new Set(['row', 'col', 'box', 'diagonal']);

// What one cell rules out: its row, column and block, plus every other cell
// already showing its digit — all within the grids that own the cell, so one on
// the seam between two puzzles covers both. Filled cells are included, so a
// digit sitting where this one cannot go is shown too. An empty cell has no
// digit to match, leaving just its row, column and block.
export function unavailableCellsForCell(board, grid, index) {
  const unavailable = new Set();
  for (const group of board.cellGroups[index]) {
    if (!LENS_GROUP_TYPES.has(group.type)) continue;
    for (const cell of group.cells) unavailable.add(cell);
  }

  const value = grid[index];
  if (value !== 0) {
    const owners = new Set(board.cellOwners[index].map((o) => o.gridId));
    for (const g of board.grids) {
      if (!owners.has(g.id)) continue;
      for (const cell of g.cellIndex) {
        if (grid[cell] === value) unavailable.add(cell);
      }
    }
  }

  unavailable.delete(index);
  return { unavailable, sources: new Set([index]) };
}

export { LOCAL_SIZE };
