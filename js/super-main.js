import { GRID_DEFS, unavailableCellsForCell } from './supersudoku.js';

// Board/overlays/solution are only written once per game (large payload); the
// frequently-changing progress (grid, notes, timer, ...) is written separately
// and often, so we don't re-serialize hundreds of KB on every timer tick.
const STORAGE_KEY_BOARD = 'super-sudoku-board-v1';
const STORAGE_KEY_PROGRESS = 'super-sudoku-progress-v1';

// Flat per-grid background (each grid's own named color). "sum" and "x" have
// their default overridden per-cell for the blue/red triple cells / diagonal.
const GRID_COLORS = {
  standard: 'rgba(220,38,38,0.16)', // red
  sum: 'rgba(234,179,8,0.20)', // yellow
  consecutive: 'rgba(163,230,53,0.30)', // "салатовый" light green
  irregular: 'rgba(34,197,94,0.20)', // green
  offset: 'rgba(59,130,246,0.14)', // blue (per-cell override below)
  x: 'rgba(37,99,235,0.16)', // blue (per-cell override for the diagonal)
  killer: 'rgba(168,85,247,0.14)', // purple (per-cage override below)
  greater: 'rgba(236,72,153,0.16)', // pink
};
// The 9 named colors — yellow/gray/orange/pink/light-green/brown/green/white/
// purple — used both for the offset grid's position classes and (per its own
// rule) reused for the killer grid's cages, with adjacency-safe assignment so
// two touching cages never get the same color.
// Alpha is high enough that a cell still reads as its own colour where it is
// painted over the thick blue border, while leaving the border visible.
const NAMED_PALETTE = [
  'rgba(234,179,8,0.50)', 'rgba(156,163,175,0.55)', 'rgba(249,115,22,0.50)',
  'rgba(236,72,153,0.45)', 'rgba(163,230,53,0.55)', 'rgba(146,64,14,0.42)',
  'rgba(34,197,94,0.48)', 'rgba(255,255,255,0.55)', 'rgba(168,85,247,0.45)',
];
const SUM_BLUE_COLOR = 'rgba(59,130,246,0.55)'; // the addend cells
const SUM_RED_COLOR = 'rgba(220,38,38,0.55)'; // the sum cell — a colored field, not a revealed number
const DIAGONAL_LINE_COLOR = '#dc2626';
// Fill for the cells the diagonals run through. Only applied where the X grid
// owns the cell alone: in a box it shares with another grid this would read as
// that grid's own marking.
const X_DIAGONAL_CELL_COLOR = 'rgba(220,38,38,0.40)';
const HINT_OVERLAY_COLOR = 'rgba(90,95,110,0.55)'; // semi-transparent, keeps the base color visible
const BORDER_COLOR = '#4f46e5';
// Its own colour rather than --border, which is the light tint used for panel
// edges and is too faint to separate cells against a filled background.
const THIN_LINE_COLOR = '#b6bccf';
const MAX_MISTAKES = 5;
const THIN_W = 0.05;
const THICK_W = 0.12;
// Painted over the cell fills, bottom to top. The marker and content values are
// mirrored in super.css; .scell sets no z-index of its own, so a cell's children
// stack against these rather than inside the cell.
const LAYER_Z = {
  thin: 1,
  diagonal: 2,
  thick: 3,
  marker: 4,
  regionPatch: 5,
  content: 6,
};

const boardEl = document.getElementById('board');
const loadingEl = document.getElementById('loading');
const loadingTextEl = document.getElementById('loading-text');
const numpadEl = document.getElementById('numpad');
const timerEl = document.getElementById('timer');
const difficultySelect = document.getElementById('difficulty');
const newGameBtn = document.getElementById('new-game');
const undoBtn = document.getElementById('undo');
const eraseBtn = document.getElementById('erase');
const notesToggleBtn = document.getElementById('notes-toggle');
const hintToggleInput = document.getElementById('hint-toggle');
const winModal = document.getElementById('win-modal');
const winTimeEl = document.getElementById('win-time');
const playAgainBtn = document.getElementById('play-again');
const errorToggleInput = document.getElementById('error-toggle');
const mistakesStatEl = document.getElementById('mistakes-stat');
const mistakesEl = document.getElementById('mistakes');
const loseModal = document.getElementById('lose-modal');
const loseTimeEl = document.getElementById('lose-time');
const tryAgainBtn = document.getElementById('try-again');
const revealSolutionBtn = document.getElementById('reveal-solution');
const legendList = document.getElementById('legend-list');

GRID_DEFS.forEach((def, i) => {
  const li = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.background = GRID_COLORS[def.rule];
  li.appendChild(swatch);
  const text = document.createElement('span');
  text.innerHTML = `<strong>${i + 1}. ${def.name}</strong> — ${def.hint}`;
  li.appendChild(text);
  legendList.appendChild(li);
});

let worker = null;
let state = null;
let timerHandle = null;
let cellButtons = null; // global cell index -> button element
let borders = null; // global cell index -> {top,right,bottom,left}
let cellBackground = null; // global cell index -> css color
let badges = null; // global cell index -> small clue string (killer cage sum) or null
let diagonalLines = null; // global cell index -> 'main' | 'anti' | null (x-sudoku diagonal line)
let markers = null; // global cell index -> [{edge, type, char?}]

function emptyNotes(count) {
  return Array.from({ length: count }, () => new Set());
}

// Greedy graph coloring so no two cages that share a border ever get the same
// color: two cages are "adjacent" if any of their cells touch orthogonally.
function colorCages(cages) {
  const cellToCage = new Array(81).fill(-1);
  cages.forEach((cage, idx) => cage.forEach((cell) => { cellToCage[cell] = idx; }));

  const adjacency = cages.map(() => new Set());
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9);
    const c = i % 9;
    const cageA = cellToCage[i];
    const neighbors = [];
    if (c < 8) neighbors.push(i + 1);
    if (r < 8) neighbors.push(i + 9);
    for (const j of neighbors) {
      const cageB = cellToCage[j];
      if (cageB !== cageA) {
        adjacency[cageA].add(cageB);
        adjacency[cageB].add(cageA);
      }
    }
  }

  const colorOf = new Array(cages.length).fill(-1);
  for (let idx = 0; idx < cages.length; idx++) {
    const used = new Set([...adjacency[idx]].map((n) => colorOf[n]).filter((c) => c !== -1));
    let color = 0;
    while (used.has(color)) color++;
    colorOf[idx] = color % NAMED_PALETTE.length;
  }
  return colorOf;
}

function boxIdInGrid(board, grid, local) {
  if (grid.rule === 'irregular') return board.jigsawByGrid[grid.id][local];
  const r = Math.floor(local / 9);
  const c = local % 9;
  return Math.floor(r / 3) * 3 + Math.floor(c / 3);
}

// A shared cell's neighbor "outward" from one grid is often still inside the
// SAME box from the OTHER owning grid's perspective (the two grids touch by
// sharing a whole 3x3 box, not just the one corner point) — so a cell's own
// r===0/c===8/etc. is not reliable evidence of a true boundary there. This
// checks real adjacency instead: two cells need a border between them only if
// every grid that owns both of them disagrees about the box, and an edge is
// the board's true outer edge only when no cell exists on the other side at
// all. This is also what fixes the earlier "isolated single cell" bug: the
// exact point where two grids' corner boxes touch is fully interior to both
// grids' own box there, so neither side ever gets a line.
function computeBorders(board) {
  const count = board.cellCount;
  const coordIndex = new Map();
  board.cellCoords.forEach(([r, c], i) => coordIndex.set(`${r},${c}`, i));

  const isBoundary = (g, neighborIdx) => {
    if (neighborIdx === undefined) return true;
    let sharedOwner = false;
    for (const { gridId, local } of board.cellOwners[g]) {
      const ownerN = board.cellOwners[neighborIdx].find((o) => o.gridId === gridId);
      if (!ownerN) continue;
      sharedOwner = true;
      const grid = board.grids.find((gr) => gr.id === gridId);
      if (boxIdInGrid(board, grid, local) === boxIdInGrid(board, grid, ownerN.local)) return false;
    }
    return sharedOwner;
  };

  const borders = Array.from({ length: count }, () => ({ top: false, right: false, bottom: false, left: false }));
  for (let g = 0; g < count; g++) {
    const [r, c] = board.cellCoords[g];
    // Only draw borders between cells that actually exist, never into empty space
    // Right/bottom check if there's a boundary OR a neighboring cell
    const rightNeighbor = coordIndex.get(`${r},${c + 1}`);
    borders[g].right = rightNeighbor !== undefined && isBoundary(g, rightNeighbor);

    const bottomNeighbor = coordIndex.get(`${r + 1},${c}`);
    borders[g].bottom = bottomNeighbor !== undefined && isBoundary(g, bottomNeighbor);

    // Left/top: draw borders on outer edges of the game board (no neighbor means edge)
    borders[g].left = coordIndex.get(`${r},${c - 1}`) === undefined;
    borders[g].top = coordIndex.get(`${r - 1},${c}`) === undefined;
  }
  return borders;
}

function computeVisuals(board, overlays, solution) {
  const count = board.cellCount;
  const localBorders = computeBorders(board);
  const bg = new Array(count).fill(null);
  const badgeMap = new Array(count).fill(null);
  const markerMap = Array.from({ length: count }, () => []);
  // Which killer cage / sum group each cell belongs to, so the board can carry
  // a region's colour across the thick border between two of its cells.
  const groupOf = new Array(count).fill(null);

  for (const grid of board.grids) {
    const cageColors = grid.rule === 'killer' ? colorCages(board.cagesByGrid[grid.id]) : null;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const local = r * 9 + c;
        const g = grid.cellIndex[local];

        if (grid.rule === 'killer') {
          const cageId = board.cagesByGrid[grid.id].findIndex((cage) => cage.includes(local));
          bg[g] = NAMED_PALETTE[cageColors[cageId]];
          groupOf[g] = `${grid.id}:${cageId}`;
        } else if (grid.rule === 'offset') {
          const posClass = (r % 3) * 3 + (c % 3);
          bg[g] = NAMED_PALETTE[posClass];
        } else if (
          grid.rule === 'x'
          && (r === c || r + c === 8)
          && board.cellOwners[g].length === 1
        ) {
          bg[g] = X_DIAGONAL_CELL_COLOR;
        } else if (bg[g] === null) {
          bg[g] = GRID_COLORS[grid.rule];
        }
      }
    }

    if (grid.rule === 'killer') {
      for (const cage of board.cagesByGrid[grid.id]) {
        const first = cage.slice().sort((a, b) => a - b)[0];
        const sum = cage.reduce((acc, li) => acc + solution[grid.cellIndex[li]], 0);
        badgeMap[grid.cellIndex[first]] = String(sum);
      }
    }
  }

  // X-sudoku diagonals are now drawn as SVG lines in buildBoardDom, not cell fills.
  // So diagonalLines is no longer used; return empty array to keep interface stable.
  const diagonalLines = new Array(count).fill(null);

  for (const key of overlays.consecutiveEdges) {
    const [a, b] = key.split(':').map(Number);
    const [ra] = board.cellCoords[a];
    const [rb] = board.cellCoords[b];
    if (ra === rb) markerMap[a].push({ edge: 'right', type: 'bridge' });
    else markerMap[a].push({ edge: 'bottom', type: 'bridge' });
  }

  for (const [key, sign] of overlays.comparisonSigns) {
    const [a, b] = key.split(':').map(Number);
    const [ra] = board.cellCoords[a];
    const [rb] = board.cellCoords[b];
    if (ra === rb) markerMap[a].push({ edge: 'right', type: 'sign', char: sign });
    else markerMap[a].push({ edge: 'bottom', type: 'sign', char: sign });
  }

  // The sum rule: 2-4 blue addend cells plus one red cell whose own solved
  // digit equals their sum — colored fields only, no floating clue number.
  overlays.sumGroups.forEach(({ blues, red }, groupId) => {
    for (const cell of blues) {
      bg[cell] = SUM_BLUE_COLOR;
      groupOf[cell] = `sum:${groupId}`;
    }
    bg[red] = SUM_RED_COLOR;
    groupOf[red] = `sum:${groupId}`;
  });

  return { borders: localBorders, cellBackground: bg, badges: badgeMap, diagonalLines, markers: markerMap, groupOf };
}

function buildBoardDom(board, visuals) {
  boardEl.innerHTML = '';
  let maxRow = 0;
  let maxCol = 0;
  for (const [r, c] of board.cellCoords) {
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  boardEl.style.gridTemplateColumns = `repeat(${maxCol + 1}, minmax(0, 1fr))`;
  boardEl.style.gridTemplateRows = `repeat(${maxRow + 1}, minmax(0, 1fr))`;

  cellButtons = new Array(board.cellCount);
  const cellAt = new Map();
  for (let i = 0; i < board.cellCount; i++) {
    const [r, c] = board.cellCoords[i];
    cellAt.set(`${r},${c}`, i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell scell';
    btn.style.gridRow = String(r + 1);
    btn.style.gridColumn = String(c + 1);
    btn.dataset.index = String(i);
    btn.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(btn);
    cellButtons[i] = btn;
  }

  // Stacking order over the cell fills: thin lines, red diagonals, thick
  // borders, then the markers and region patches (see LAYER_Z).
  const makeOverlay = (className, zIndex) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', `0 0 ${maxCol + 1} ${maxRow + 1}`);
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = String(zIndex);
    return svg;
  };
  const thinSvg = makeOverlay('grid-overlay grid-overlay-thin', LAYER_Z.thin);
  const thickSvg = makeOverlay('grid-overlay grid-overlay-thick', LAYER_Z.thick);
  const patchSvg = makeOverlay('region-patch-overlay', LAYER_Z.regionPatch);

  const drawnLines = new Set(); // Track lines to avoid duplicates

  // The jigsaw grid's blocks don't follow the board-wide 3x3 lattice the other
  // grids share, so for edges inside it the region map decides the thick lines.
  const irregularGrid = board.grids.find((g) => g.rule === 'irregular');
  const regionAt = new Map();
  if (irregularGrid) {
    const regions = board.jigsawByGrid[irregularGrid.id];
    for (let i = 0; i < board.cellCount; i++) {
      const owner = board.cellOwners[i].find((o) => o.gridId === irregularGrid.id);
      if (!owner) continue;
      const [r, c] = board.cellCoords[i];
      regionAt.set(`${r},${c}`, regions[owner.local]);
    }
  }
  // null = edge isn't inside the jigsaw grid, so the caller keeps the lattice rule.
  const jigsawEdge = (aKey, bKey) => {
    const a = regionAt.get(aKey);
    const b = regionAt.get(bKey);
    if (a === undefined || b === undefined) return null;
    return a !== b;
  };

  const thinLines = [];
  const thickLines = [];
  const addLine = (x1, y1, x2, y2, isBoundary) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('stroke', isBoundary ? BORDER_COLOR : THIN_LINE_COLOR);
    line.setAttribute('stroke-width', isBoundary ? String(THICK_W) : String(THIN_W));
    // Thick borders are drawn one cell edge at a time, so butt ends leave the
    // half-width square at every corner unpainted. Square caps fill it.
    if (isBoundary) line.setAttribute('stroke-linecap', 'square');
    (isBoundary ? thickLines : thinLines).push(line);
  };

  // Where a killer cage or sum group spans a thick border, each side paints its
  // own half of that border strip in its fill, so the region reads as one block
  // across the border while the border still shows through. The strip stops
  // short of the perpendicular edges so it never covers a thin line.
  const groupOf = visuals.groupOf;
  const fill = visuals.cellBackground;
  const addRegionPatch = (a, b, vertical, r, c) => {
    if (!groupOf[a] || groupOf[a] !== groupOf[b]) return;
    const half = THICK_W / 2 + 0.01;
    const inset = THIN_W / 2 + 0.005;
    for (const [cell, side] of [[a, -1], [b, 1]]) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      if (vertical) {
        rect.setAttribute('x', String(side < 0 ? c + 1 - half : c + 1));
        rect.setAttribute('y', String(r + inset));
        rect.setAttribute('width', String(half));
        rect.setAttribute('height', String(1 - 2 * inset));
      } else {
        rect.setAttribute('x', String(c + inset));
        rect.setAttribute('y', String(side < 0 ? r + 1 - half : r + 1));
        rect.setAttribute('width', String(1 - 2 * inset));
        rect.setAttribute('height', String(half));
      }
      rect.setAttribute('fill', fill[cell]);
      patchSvg.appendChild(rect);
    }
  };

  for (let i = 0; i < board.cellCount; i++) {
    const [r, c] = board.cellCoords[i];

    // Right edge: line between this cell and the next, or the board's outer edge
    const rightCell = `${r},${c + 1}`;
    const lineKeyRight = `v${r},${c + 1}`;
    if (!drawnLines.has(lineKeyRight)) {
      const rightIdx = cellAt.get(rightCell);
      const jigRight = jigsawEdge(`${r},${c}`, rightCell);
      const isBoundary = rightIdx === undefined || (jigRight !== null ? jigRight : (c + 1) % 3 === 0);
      addLine(c + 1, r, c + 1, r + 1, isBoundary);
      if (isBoundary && rightIdx !== undefined) addRegionPatch(i, rightIdx, true, r, c);
      drawnLines.add(lineKeyRight);
    }

    // Bottom edge
    const bottomCell = `${r + 1},${c}`;
    const lineKeyBottom = `h${r + 1},${c}`;
    if (!drawnLines.has(lineKeyBottom)) {
      const bottomIdx = cellAt.get(bottomCell);
      const jigBottom = jigsawEdge(`${r},${c}`, bottomCell);
      const isBoundary = bottomIdx === undefined || (jigBottom !== null ? jigBottom : (r + 1) % 3 === 0);
      addLine(c, r + 1, c + 1, r + 1, isBoundary);
      if (isBoundary && bottomIdx !== undefined) addRegionPatch(i, bottomIdx, false, r, c);
      drawnLines.add(lineKeyBottom);
    }

    // Outer edges: the board's own perimeter
    if (!cellAt.has(`${r},${c - 1}`)) {
      const lineKey = `left${r},${c}`;
      if (!drawnLines.has(lineKey)) {
        addLine(c, r, c, r + 1, true);
        drawnLines.add(lineKey);
      }
    }

    if (!cellAt.has(`${r - 1},${c}`)) {
      const lineKey = `top${r},${c}`;
      if (!drawnLines.has(lineKey)) {
        addLine(c, r, c + 1, r, true);
        drawnLines.add(lineKey);
      }
    }
  }
  for (const line of thinLines) thinSvg.appendChild(line);
  for (const line of thickLines) thickSvg.appendChild(line);
  boardEl.appendChild(thinSvg);
  boardEl.appendChild(thickSvg);
  boardEl.appendChild(patchSvg);

  // SVG overlay for the X-sudoku diagonals
  const xGrid = board.grids.find((g) => g.rule === 'x');
  if (xGrid) {
    const svg = makeOverlay('diagonal-overlay', LAYER_Z.diagonal);

    // Derived from the grid's own cells rather than hardcoded: a cell at (r, c)
    // spans (c, r) to (c + 1, r + 1) here, so the far corner is maxCol + 1 /
    // maxRow + 1. Hardcoding stopped the line a whole cell short of it.
    let minR = Infinity;
    let maxR = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    for (let i = 0; i < board.cellCount; i++) {
      if (!board.cellOwners[i].some((o) => o.gridId === xGrid.id)) continue;
      const [r, c] = board.cellCoords[i];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    const x0 = minC;
    const y0 = minR;
    const x1 = maxC + 1;
    const y1 = maxR + 1;

    for (const [ax, ay, bx, by] of [[x0, y0, x1, y1], [x1, y0, x0, y1]]) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(ax));
      line.setAttribute('y1', String(ay));
      line.setAttribute('x2', String(bx));
      line.setAttribute('y2', String(by));
      line.setAttribute('stroke', DIAGONAL_LINE_COLOR);
      line.setAttribute('stroke-width', '0.06');
      line.setAttribute('stroke-linecap', 'square');
      svg.appendChild(line);
    }

    boardEl.appendChild(svg);
  }
}

function buildNumpad() {
  numpadEl.innerHTML = '';
  for (let n = 1; n <= 9; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'num-btn';
    btn.textContent = String(n);
    btn.addEventListener('click', () => onDigit(n));
    numpadEl.appendChild(btn);
  }
}

function setLoading(isLoading, text) {
  loadingEl.classList.toggle('open', isLoading);
  if (text) loadingTextEl.textContent = text;
  newGameBtn.disabled = isLoading;
  difficultySelect.disabled = isLoading;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('js/superworker.js', { type: 'module' });
  return worker;
}

function newGame(difficulty) {
  loseModal.classList.remove('open');
  setLoading(true, 'Генерация судоку… это может занять до 10 секунд.');
  stopTimer();
  const w = ensureWorker();
  const handle = (event) => {
    w.removeEventListener('message', handle);
    setLoading(false);
    if (!event.data.ok) {
      loadingTextEl.textContent = 'Не получилось сгенерировать. Попробуйте ещё раз.';
      setLoading(true);
      return;
    }
    startGameFromResult(event.data.result, difficulty);
  };
  w.addEventListener('message', handle);
  w.postMessage({ difficulty });
}

function startGameFromResult(result, difficulty) {
  const { board, puzzle, solution, overlays } = result;

  state = {
    board,
    overlays,
    puzzle,
    solution,
    grid: puzzle.slice(),
    given: puzzle.map((v) => v !== 0),
    notes: emptyNotes(board.cellCount),
    selected: null,
    notesMode: false,
    seconds: 0,
    running: true,
    lensCell: null,
    hintEnabled: hintToggleInput.checked,
    errorMode: errorToggleInput.checked,
    mistakes: 0,
    history: [],
    difficulty,
    finished: false,
  };

  const visuals = computeVisuals(board, overlays, solution);
  buildBoardDom(board, visuals);
  borders = visuals.borders;
  cellBackground = visuals.cellBackground;
  badges = visuals.badges;
  diagonalLines = visuals.diagonalLines;
  markers = visuals.markers;

  persistBoard();
  persistProgress();
  render();
  startTimer();
}

function persistBoard() {
  if (!state) return;
  try {
    localStorage.setItem(
      STORAGE_KEY_BOARD,
      JSON.stringify({
        board: state.board,
        overlays: {
          consecutiveEdges: [...state.overlays.consecutiveEdges],
          comparisonSigns: [...state.overlays.comparisonSigns],
          sumGroups: state.overlays.sumGroups,
        },
        puzzle: state.puzzle,
        solution: state.solution,
      })
    );
  } catch {
    // Persistence is a nicety; ignore storage failures (quota, private mode).
  }
}

function persistProgress() {
  if (!state) return;
  try {
    localStorage.setItem(
      STORAGE_KEY_PROGRESS,
      JSON.stringify({
        grid: state.grid,
        given: state.given,
        notes: state.notes.map((s) => [...s]),
        selected: state.selected,
        notesMode: state.notesMode,
        seconds: state.seconds,
        lensCell: state.lensCell,
        hintEnabled: state.hintEnabled,
        errorMode: state.errorMode,
        mistakes: state.mistakes,
        history: state.history,
        difficulty: state.difficulty,
        finished: state.finished,
      })
    );
  } catch {
    // Persistence is a nicety; ignore storage failures (quota, private mode).
  }
}

function loadPersisted() {
  try {
    const rawBoard = localStorage.getItem(STORAGE_KEY_BOARD);
    const rawProgress = localStorage.getItem(STORAGE_KEY_PROGRESS);
    if (!rawBoard || !rawProgress) return false;
    const boardData = JSON.parse(rawBoard);
    const progress = JSON.parse(rawProgress);
    if (!boardData || !Array.isArray(progress.grid)) return false;

    const board = boardData.board;
    const overlays = {
      consecutiveEdges: new Set(boardData.overlays.consecutiveEdges),
      comparisonSigns: new Map(boardData.overlays.comparisonSigns),
      sumGroups: boardData.overlays.sumGroups,
    };

    state = {
      board,
      overlays,
      puzzle: boardData.puzzle,
      solution: boardData.solution,
      ...progress,
      notes: progress.notes.map((arr) => new Set(arr)),
    };
    state.errorMode = state.errorMode ?? true;
    state.mistakes = state.mistakes ?? 0;
    difficultySelect.value = state.difficulty;
    hintToggleInput.checked = !!state.hintEnabled;
    errorToggleInput.checked = state.errorMode;

    const visuals = computeVisuals(board, overlays, state.solution);
    buildBoardDom(board, visuals);
    borders = visuals.borders;
    cellBackground = visuals.cellBackground;
    badges = visuals.badges;
    diagonalLines = visuals.diagonalLines;
    markers = visuals.markers;
    return true;
  } catch {
    return false;
  }
}

function startTimer() {
  stopTimer();
  timerHandle = setInterval(() => {
    if (!state || !state.running || state.finished) return;
    state.seconds++;
    updateTimerDisplay();
    persistProgress();
  }, 1000);
}
function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}
function updateTimerDisplay() {
  const m = Math.floor(state.seconds / 60).toString().padStart(2, '0');
  const s = (state.seconds % 60).toString().padStart(2, '0');
  timerEl.textContent = `${m}:${s}`;
}

function onCellClick(index) {
  if (!state || state.finished) return;
  // Toggle the "unavailable cells" lens for this cell on/off. An empty cell
  // gets one too: its row, column and block are what a digit placed there
  // would rule out.
  if (state.hintEnabled) state.lensCell = state.lensCell === index ? null : index;
  state.selected = index;
  render();
}

function pushHistory(index) {
  // clearedNotes: cells OTHER than `index` whose notes the placement strips, so
  // undo can put them back — they are not covered by prevNotes.
  state.history.push({
    index,
    prevValue: state.grid[index],
    prevNotes: [...state.notes[index]],
    clearedNotes: null,
  });
  if (state.history.length > 400) state.history.shift();
}

function onDigit(n) {
  if (!state || state.finished || state.selected === null) return;
  const index = state.selected;
  if (state.given[index]) return;

  pushHistory(index);

  if (state.notesMode) {
    const set = state.notes[index];
    if (set.has(n)) set.delete(n);
    else set.add(n);
    state.grid[index] = 0;
  } else {
    state.notes[index].clear();
    if (state.grid[index] === n) {
      state.grid[index] = 0;
    } else {
      state.grid[index] = n;
      const wrong = n !== state.solution[index];
      if (state.errorMode && wrong) state.mistakes += 1;
      // A digit rules itself out of its peers' notes. With the error mode on a
      // wrong digit is already flagged, so its notes are left alone rather than
      // stripped on a premise the game knows to be false.
      if (!(state.errorMode && wrong)) {
        const cleared = [];
        for (const peer of state.board.peers[index]) {
          if (state.notes[peer].delete(n)) cleared.push(peer);
        }
        if (cleared.length) state.history[state.history.length - 1].clearedNotes = { cells: cleared, digit: n };
      }
    }
  }

  checkGameState();
  persistProgress();
  render();
}

function onErase() {
  if (!state || state.finished || state.selected === null) return;
  const index = state.selected;
  if (state.given[index]) return;
  pushHistory(index);
  state.grid[index] = 0;
  state.notes[index].clear();
  persistProgress();
  render();
}

function onUndo() {
  if (!state || state.finished || state.history.length === 0) return;
  const last = state.history.pop();
  state.grid[last.index] = last.prevValue;
  state.notes[last.index] = new Set(last.prevNotes);
  if (last.clearedNotes) {
    for (const cell of last.clearedNotes.cells) state.notes[cell].add(last.clearedNotes.digit);
  }
  state.selected = last.index;
  persistProgress();
  render();
}

function checkGameState() {
  if (state.errorMode && state.mistakes >= MAX_MISTAKES) {
    state.finished = true;
    state.running = false;
    stopTimer();
    persistProgress();
    loseTimeEl.textContent = timerEl.textContent;
    loseModal.classList.add('open');
    return;
  }

  const solved = state.grid.every((v, i) => v === state.solution[i]);
  if (solved) {
    state.finished = true;
    state.running = false;
    stopTimer();
    persistProgress();
    winTimeEl.textContent = timerEl.textContent;
    winModal.classList.add('open');
  }
}

// Debug helper: fills every cell with the correct solved value so the puzzle's
// rules can be visually spot-checked, without triggering the win modal.
function onRevealSolution() {
  if (!state) return;
  state.grid = state.solution.slice();
  persistProgress();
  render();
}

function render() {
  if (!state || !cellButtons) return;
  updateTimerDisplay();
  notesToggleBtn.classList.toggle('active', state.notesMode);
  mistakesStatEl.hidden = !state.errorMode;
  mistakesEl.textContent = `${state.mistakes} / ${MAX_MISTAKES}`;

  // != null also absorbs a progress save written before the lens moved from
  // digit to cell, where this field is missing.
  const lensCell = state.hintEnabled && state.lensCell != null ? state.lensCell : null;

  let unavailable = new Set();
  let sources = new Set();
  if (lensCell !== null) {
    const result = unavailableCellsForCell(state.board, state.grid, lensCell);
    unavailable = result.unavailable;
    sources = result.sources;
  }

  const selIndex = state.selected;
  const peerSet = selIndex === null ? null : new Set(state.board.peers[selIndex]);
  const selValue = selIndex === null ? 0 : state.grid[selIndex];

  for (let i = 0; i < state.board.cellCount; i++) {
    const el = cellButtons[i];
    const value = state.grid[i];
    const isDimmed = unavailable.has(i);

    el.className = 'cell scell';
    el.style.backgroundColor = cellBackground[i];
    // Hint dimming: semi-transparent gray overlay
    el.style.backgroundImage = isDimmed
      ? `linear-gradient(${HINT_OVERLAY_COLOR}, ${HINT_OVERLAY_COLOR})`
      : 'none';

    // Grid lines are drawn via SVG overlay, not cell borders
    el.style.border = 'none';
    el.style.boxShadow = 'none';

    el.innerHTML = '';

    if (badges[i]) {
      const badge = document.createElement('span');
      badge.className = 'cage-badge';
      badge.textContent = badges[i];
      el.appendChild(badge);
    }

    if (value !== 0) {
      const span = document.createElement('span');
      span.className = 'value';
      span.textContent = String(value);
      el.appendChild(span);
      if (state.given[i]) el.classList.add('given');
      if (state.errorMode && !state.given[i] && value !== state.solution[i]) el.classList.add('error');
    } else if (state.notes[i].size > 0) {
      const notesGrid = document.createElement('div');
      notesGrid.className = 'notes';
      for (let n = 1; n <= 9; n++) {
        const s = document.createElement('span');
        s.textContent = state.notes[i].has(n) ? String(n) : '';
        notesGrid.appendChild(s);
      }
      el.appendChild(notesGrid);
    }

    for (const marker of markers[i]) {
      const m = document.createElement('span');
      m.className = `edge-marker marker-${marker.edge} ${marker.type}`;
      if (marker.type === 'sign') m.textContent = marker.char;
      el.appendChild(m);
    }

    if (selIndex !== null) {
      if (i === selIndex) el.classList.add('selected');
      else if (peerSet.has(i)) el.classList.add('peer');
      if (selValue !== 0 && value === selValue) el.classList.add('same-value');
    }

    if (lensCell !== null) {
      if (sources.has(i)) el.classList.add('lens-source');
      else if (isDimmed) el.classList.add('dimmed');
    }
  }

  // Unlike a single 9x9 grid, digits don't have a fixed "9 total" count across
  // 8 overlapping variants, so the numpad never greys out a finished digit here.
}

function onKeydown(e) {
  if (!state || state.finished) return;
  if (e.key >= '1' && e.key <= '9') {
    onDigit(Number(e.key));
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
    onErase();
  }
}

difficultySelect.addEventListener('change', () => newGame(difficultySelect.value));
newGameBtn.addEventListener('click', () => newGame(difficultySelect.value));
undoBtn.addEventListener('click', onUndo);
eraseBtn.addEventListener('click', onErase);
notesToggleBtn.addEventListener('click', () => {
  if (!state) return;
  state.notesMode = !state.notesMode;
  persistProgress();
  render();
});
hintToggleInput.addEventListener('change', () => {
  if (!state) return;
  state.hintEnabled = hintToggleInput.checked;
  if (!state.hintEnabled) state.lensCell = null;
  persistProgress();
  render();
});
playAgainBtn.addEventListener('click', () => {
  winModal.classList.remove('open');
  newGame(difficultySelect.value);
});
tryAgainBtn.addEventListener('click', () => {
  loseModal.classList.remove('open');
  newGame(difficultySelect.value);
});
errorToggleInput.addEventListener('change', () => {
  if (!state) return;
  state.errorMode = errorToggleInput.checked;
  persistProgress();
  render();
});
revealSolutionBtn.addEventListener('click', onRevealSolution);
document.addEventListener('keydown', onKeydown);

buildNumpad();

if (!loadPersisted()) {
  newGame(difficultySelect.value);
} else {
  render();
  if (!state.finished) startTimer();
}
