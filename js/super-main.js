import { GRID_DEFS, unavailableCellsForValueInGrid } from './supersudoku.js';

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
const NAMED_PALETTE = [
  'rgba(234,179,8,0.35)', 'rgba(156,163,175,0.40)', 'rgba(249,115,22,0.35)',
  'rgba(236,72,153,0.30)', 'rgba(163,230,53,0.40)', 'rgba(146,64,14,0.28)',
  'rgba(34,197,94,0.32)', '#ffffff', 'rgba(168,85,247,0.30)',
];
const SUM_BLUE_COLOR = 'rgba(59,130,246,0.40)'; // the addend cells
const SUM_RED_COLOR = 'rgba(220,38,38,0.40)'; // the sum cell — a colored field, not a revealed number
const DIAGONAL_LINE_COLOR = '#dc2626'; // thin line stroke for the X-sudoku diagonals
const HINT_OVERLAY_COLOR = 'rgba(90,95,110,0.55)'; // semi-transparent, keeps the base color visible
const BORDER_COLOR = '#4f46e5';

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
    // Only right/bottom are derived from box-sameness; left/top only ever
    // mark a true outer edge (no cell at all on that side) — the box-boundary
    // case is already captured symmetrically by the neighbor's own right/
    // bottom, and marking it again here would double the line's thickness.
    borders[g].right = isBoundary(g, coordIndex.get(`${r},${c + 1}`));
    borders[g].bottom = isBoundary(g, coordIndex.get(`${r + 1},${c}`));
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

  for (const grid of board.grids) {
    const cageColors = grid.rule === 'killer' ? colorCages(board.cagesByGrid[grid.id]) : null;

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const local = r * 9 + c;
        const g = grid.cellIndex[local];

        if (grid.rule === 'killer') {
          const cageId = board.cagesByGrid[grid.id].findIndex((cage) => cage.includes(local));
          bg[g] = NAMED_PALETTE[cageColors[cageId]];
        } else if (grid.rule === 'offset') {
          const posClass = (r % 3) * 3 + (c % 3);
          bg[g] = NAMED_PALETTE[posClass];
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
  for (const { blues, red } of overlays.sumGroups) {
    for (const cell of blues) bg[cell] = SUM_BLUE_COLOR;
    bg[red] = SUM_RED_COLOR;
  }

  return { borders: localBorders, cellBackground: bg, badges: badgeMap, diagonalLines, markers: markerMap };
}

function buildBoardDom(board) {
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
  for (let i = 0; i < board.cellCount; i++) {
    const [r, c] = board.cellCoords[i];
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

  // SVG overlay for X-sudoku diagonal lines (2 full diagonals across rows 18-26, cols 6-14)
  const xGrid = board.grids.find((g) => g.rule === 'x');
  if (xGrid) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'diagonal-overlay');
    svg.setAttribute('viewBox', `0 0 ${maxCol + 1} ${maxRow + 1}`);
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '2';

    // X-sudoku: rows 18-26, cols 6-14 (0-indexed)
    // Main diagonal: (6,18) to (14,26)
    const main = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    main.setAttribute('x1', '6');
    main.setAttribute('y1', '18');
    main.setAttribute('x2', '14');
    main.setAttribute('y2', '26');
    main.setAttribute('stroke', '#dc2626');
    main.setAttribute('stroke-width', '0.2');
    svg.appendChild(main);

    // Anti-diagonal: (14,18) to (6,26)
    const anti = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    anti.setAttribute('x1', '14');
    anti.setAttribute('y1', '18');
    anti.setAttribute('x2', '6');
    anti.setAttribute('y2', '26');
    anti.setAttribute('stroke', '#dc2626');
    anti.setAttribute('stroke-width', '0.2');
    svg.appendChild(anti);

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
    digitLens: null,
    digitLensCell: null,
    digitLensGridId: null,
    hintEnabled: hintToggleInput.checked,
    history: [],
    difficulty,
    finished: false,
  };

  buildBoardDom(board);
  const visuals = computeVisuals(board, overlays, solution);
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
        digitLens: state.digitLens,
        digitLensCell: state.digitLensCell,
        digitLensGridId: state.digitLensGridId,
        hintEnabled: state.hintEnabled,
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
    difficultySelect.value = state.difficulty;
    hintToggleInput.checked = !!state.hintEnabled;

    buildBoardDom(board);
    const visuals = computeVisuals(board, overlays, state.solution);
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
  const value = state.grid[index];
  if (state.hintEnabled && value !== 0) {
    // Toggle off only when clicking the exact same cell again — a different
    // cell with the same digit value re-targets the lens to ITS grid instead.
    if (state.digitLensCell === index) {
      state.digitLens = null;
      state.digitLensCell = null;
      state.digitLensGridId = null;
    } else {
      state.digitLens = value;
      state.digitLensCell = index;
      state.digitLensGridId = state.board.cellOwners[index][0].gridId;
    }
    state.selected = index;
    render();
    return;
  }
  state.selected = index;
  render();
}

function pushHistory(index) {
  state.history.push({ index, prevValue: state.grid[index], prevNotes: [...state.notes[index]] });
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
    }
  }

  if (state.hintEnabled && state.digitLens !== null) {
    state.digitLens = state.grid[index] || state.digitLens;
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
  state.selected = last.index;
  persistProgress();
  render();
}

function checkGameState() {
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

  // The hint lens is scoped to the single grid the clicked cell belongs to
  // (its row/col/box/etc. groups only), and marks every peer — filled or
  // empty — as unavailable, not just empty cells.
  let unavailable = new Set();
  let sources = new Set();
  if (state.hintEnabled && state.digitLens !== null && state.digitLensGridId) {
    const result = unavailableCellsForValueInGrid(state.board, state.grid, state.digitLens, state.digitLensGridId);
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
    // Hint dimming: semi-transparent gray overlay (X-sudoku diagonals are now SVG lines)
    el.style.backgroundImage = isDimmed
      ? `linear-gradient(${HINT_OVERLAY_COLOR}, ${HINT_OVERLAY_COLOR})`
      : 'none';

    // Real borders (not box-shadow) so lines are continuous: `right`/`bottom`
    // always draw (thick at a boundary, thin otherwise), while `left`/`top`
    // only ever draw at a grid's true outer edge — its neighbor on that side
    // already supplies the line otherwise, so drawing both would double it.
    const b = borders[i];
    el.style.borderRight = b.right ? `3px solid ${BORDER_COLOR}` : '1px solid var(--border)';
    el.style.borderBottom = b.bottom ? `3px solid ${BORDER_COLOR}` : '1px solid var(--border)';
    el.style.borderLeft = b.left ? `3px solid ${BORDER_COLOR}` : '0';
    el.style.borderTop = b.top ? `3px solid ${BORDER_COLOR}` : '0';
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
      if (!state.given[i] && value !== state.solution[i]) el.classList.add('error');
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

    if (state.hintEnabled && state.digitLens !== null) {
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
  if (!state.hintEnabled) state.digitLens = null;
  persistProgress();
  render();
});
playAgainBtn.addEventListener('click', () => {
  winModal.classList.remove('open');
  newGame(difficultySelect.value);
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
