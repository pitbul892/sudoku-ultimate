import { GRID_DEFS, unavailableCellsForValue } from './supersudoku.js';

// Board/overlays/solution are only written once per game (large payload); the
// frequently-changing progress (grid, notes, timer, ...) is written separately
// and often, so we don't re-serialize hundreds of KB on every timer tick.
const STORAGE_KEY_BOARD = 'super-sudoku-board-v1';
const STORAGE_KEY_PROGRESS = 'super-sudoku-progress-v1';

const GRID_COLORS = {
  standard: 'rgba(99,102,241,0.16)',
  sum: 'rgba(245,158,11,0.16)',
  consecutive: 'rgba(236,72,153,0.16)',
  irregular: 'rgba(16,185,129,0.16)',
  offset: 'rgba(59,130,246,0.16)',
  x: 'rgba(239,68,68,0.14)',
  killer: 'rgba(168,85,247,0.16)',
  greater: 'rgba(20,184,166,0.16)',
};
const REGION_PALETTE = [
  'rgba(16,185,129,0.22)', 'rgba(52,211,153,0.22)', 'rgba(110,231,183,0.22)',
  'rgba(6,182,212,0.20)', 'rgba(45,212,191,0.20)', 'rgba(132,204,22,0.20)',
  'rgba(163,230,53,0.20)', 'rgba(74,222,128,0.22)', 'rgba(34,197,94,0.20)',
];
const CAGE_PALETTE = [
  'rgba(168,85,247,0.24)', 'rgba(192,132,252,0.22)', 'rgba(217,70,239,0.20)',
  'rgba(232,121,249,0.20)', 'rgba(196,181,253,0.24)', 'rgba(147,51,234,0.20)',
  'rgba(233,213,255,0.26)', 'rgba(126,34,206,0.18)',
];
// One color per "position class" (r%3, c%3) — cells sharing a color must also
// contain 1-9, the extra constraint the offset/disjoint-groups variant adds.
const OFFSET_PALETTE = [
  'rgba(239,68,68,0.28)', 'rgba(249,115,22,0.28)', 'rgba(234,179,8,0.30)',
  'rgba(132,204,22,0.28)', 'rgba(20,184,166,0.28)', 'rgba(59,130,246,0.26)',
  'rgba(99,102,241,0.28)', 'rgba(217,70,239,0.26)', 'rgba(244,63,94,0.24)',
];
const BORDER_COLOR = 'rgba(79,70,229,0.75)';

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
const legendList = document.getElementById('legend-list');

for (const def of GRID_DEFS) {
  const li = document.createElement('li');
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.background = GRID_COLORS[def.rule];
  li.appendChild(swatch);
  const text = document.createElement('span');
  text.innerHTML = `<strong>${def.name}</strong> — ${def.hint}`;
  li.appendChild(text);
  legendList.appendChild(li);
}

let worker = null;
let state = null;
let timerHandle = null;
let cellButtons = null; // global cell index -> button element
let borders = null; // global cell index -> {top,right,bottom,left}
let cellBackground = null; // global cell index -> css color
let markers = null; // global cell index -> [{edge, type, char?}]
let badges = null; // global cell index -> text badge (sum)

function emptyNotes(count) {
  return Array.from({ length: count }, () => new Set());
}

function computeVisuals(board, overlays) {
  const count = board.cellCount;
  const localBorders = Array.from({ length: count }, () => ({ top: false, right: false, bottom: false, left: false }));
  const bg = new Array(count).fill(null);
  const markerMap = Array.from({ length: count }, () => []);
  const badgeMap = new Array(count).fill(null);

  for (const grid of board.grids) {
    const boxId = (r, c) => {
      if (grid.rule === 'irregular') return board.jigsawByGrid[grid.id][r * 9 + c];
      return Math.floor(r / 3) * 3 + Math.floor(c / 3);
    };
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const local = r * 9 + c;
        const g = grid.cellIndex[local];
        if (r === 0) localBorders[g].top = true;
        if (c === 0) localBorders[g].left = true;
        if (r === 8) localBorders[g].bottom = true;
        if (c === 8) localBorders[g].right = true;
        if (c < 8) {
          const gRight = grid.cellIndex[r * 9 + (c + 1)];
          if (boxId(r, c) !== boxId(r, c + 1)) {
            localBorders[g].right = true;
            localBorders[gRight].left = true;
          }
        }
        if (r < 8) {
          const gDown = grid.cellIndex[(r + 1) * 9 + c];
          if (boxId(r, c) !== boxId(r + 1, c)) {
            localBorders[g].bottom = true;
            localBorders[gDown].top = true;
          }
        }

        if (grid.rule === 'irregular') {
          bg[g] = REGION_PALETTE[board.jigsawByGrid[grid.id][local] % REGION_PALETTE.length];
        } else if (grid.rule === 'killer') {
          const cageId = board.cagesByGrid[grid.id].findIndex((cage) => cage.includes(local));
          bg[g] = CAGE_PALETTE[cageId % CAGE_PALETTE.length];
        } else if (grid.rule === 'x' && (r === c || r + c === 8)) {
          bg[g] = 'rgba(239,68,68,0.38)';
        } else if (grid.rule === 'offset') {
          const posClass = (r % 3) * 3 + (c % 3);
          bg[g] = OFFSET_PALETTE[posClass];
        } else if (bg[g] === null) {
          bg[g] = GRID_COLORS[grid.rule];
        }
      }
    }
  }

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
    else markerMap[a].push({ edge: 'bottom', type: 'sign', char: sign === '>' ? '∧' : '∨' });
  }

  for (const { cells, sum } of overlays.sumGroups) {
    badgeMap[cells[0]] = String(sum);
  }
  for (const grid of board.grids) {
    if (grid.rule !== 'killer') continue;
    for (const cage of board.cagesByGrid[grid.id]) {
      const first = cage.slice().sort((a, b) => a - b)[0];
      const g = grid.cellIndex[first];
      const sum = cage.reduce((acc, li) => acc + state.solution[grid.cellIndex[li]], 0);
      badgeMap[g] = String(sum);
    }
  }

  return { borders: localBorders, cellBackground: bg, markers: markerMap, badges: badgeMap };
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
    hintEnabled: hintToggleInput.checked,
    history: [],
    difficulty,
    finished: false,
  };

  buildBoardDom(board);
  const visuals = computeVisuals(board, overlays);
  borders = visuals.borders;
  cellBackground = visuals.cellBackground;
  markers = visuals.markers;
  badges = visuals.badges;

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
    const visuals = computeVisuals(board, overlays);
    borders = visuals.borders;
    cellBackground = visuals.cellBackground;
    markers = visuals.markers;
    badges = visuals.badges;
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
    state.digitLens = state.digitLens === value ? null : value;
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

function render() {
  if (!state || !cellButtons) return;
  updateTimerDisplay();
  notesToggleBtn.classList.toggle('active', state.notesMode);

  let unavailable = new Set();
  let sources = new Set();
  if (state.hintEnabled && state.digitLens !== null) {
    const result = unavailableCellsForValue(state.board, state.grid, state.digitLens);
    unavailable = result.unavailable;
    sources = result.sources;
  }

  const selIndex = state.selected;
  const peerSet = selIndex === null ? null : new Set(state.board.peers[selIndex]);
  const selValue = selIndex === null ? 0 : state.grid[selIndex];

  for (let i = 0; i < state.board.cellCount; i++) {
    const el = cellButtons[i];
    const value = state.grid[i];

    el.className = 'cell scell';
    el.style.background = cellBackground[i];
    const b = borders[i];
    const parts = [];
    if (b.top) parts.push(`inset 0 2px 0 0 ${BORDER_COLOR}`);
    if (b.left) parts.push(`inset 2px 0 0 0 ${BORDER_COLOR}`);
    if (b.right) parts.push(`inset -2px 0 0 0 ${BORDER_COLOR}`);
    if (b.bottom) parts.push(`inset 0 -2px 0 0 ${BORDER_COLOR}`);
    // Shared cells keep their real per-grid color (offset group, cage, jigsaw
    // region, ...) instead of being flattened to one "shared" color — a ring
    // on top is enough to flag that the cell belongs to two puzzles at once.
    if (state.board.cellOwners[i].length > 1) parts.push('inset 0 0 0 2px #eab308');
    el.style.boxShadow = parts.join(', ');

    el.innerHTML = '';

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

    if (badges[i]) {
      const badge = document.createElement('span');
      badge.className = 'cage-badge';
      badge.textContent = badges[i];
      el.appendChild(badge);
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
      else if (unavailable.has(i)) el.classList.add('dimmed');
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
document.addEventListener('keydown', onKeydown);

buildNumpad();

if (!loadPersisted()) {
  newGame(difficultySelect.value);
} else {
  render();
  if (!state.finished) startTimer();
}
