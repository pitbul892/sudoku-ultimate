import { generatePuzzle, unavailableCellsForValue, boxIndex } from './sudoku.js';

const STORAGE_KEY = 'sudoku-ultimate-state-v1';

const boardEl = document.getElementById('board');
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
const checkBtn = document.getElementById('check');
const forceWinBtn = document.getElementById('force-win');

const MAX_MISTAKES = 10;

/** @type {{
 *  puzzle: number[], solution: number[], grid: number[], given: boolean[],
 *  notes: Set<number>[], selected: number|null, notesMode: boolean,
 *  seconds: number, running: boolean, digitLens: number|null,
 *  hintEnabled: boolean, history: {index:number, prevValue:number, prevNotes:number[]}[],
 *  difficulty: string, finished: boolean
 * }} */
let state = null;

let timerHandle = null;
let timerBase = 0; // state.seconds when the current run started
let timerStart = 0; // Date.now() at that moment

function emptyNotes() {
  return Array.from({ length: 81 }, () => new Set());
}

function newGame(difficulty) {
  hideModals();
  const { puzzle, solution } = generatePuzzle(difficulty);
  state = {
    puzzle,
    solution,
    grid: puzzle.slice(),
    given: puzzle.map((v) => v !== 0),
    notes: emptyNotes(),
    selected: null,
    notesMode: false,
    seconds: 0,
    running: true,
    digitLens: null,
    hintEnabled: hintToggleInput.checked,
    errorMode: errorToggleInput.checked,
    mistakes: 0,
    checking: false,
    history: [],
    difficulty,
    finished: false,
  };
  persist();
  render();
  startTimer();
}

function persist() {
  if (!state) return;
  const serializable = {
    ...state,
    notes: state.notes.map((s) => [...s]),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Storage may be unavailable (private mode, quota); game still works without persistence.
  }
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.grid)) return false;
    state = {
      ...parsed,
      notes: parsed.notes.map((arr) => new Set(arr)),
    };
    state.errorMode = state.errorMode ?? true;
    state.mistakes = state.mistakes ?? 0;
    difficultySelect.value = state.difficulty;
    hintToggleInput.checked = !!state.hintEnabled;
    errorToggleInput.checked = state.errorMode;
    return true;
  } catch {
    return false;
  }
}

function startTimer() {
  stopTimer();
  timerBase = state.seconds;
  timerStart = Date.now();
  timerHandle = setInterval(() => {
    if (!state || !state.running || state.finished) return;
    // Elapsed wall time rather than a count of ticks: a browser throttles timers
    // in a background tab, so counting ticks let the clock fall behind and look
    // stuck. Reading the clock makes every dropped tick correct itself.
    const seconds = timerBase + Math.round((Date.now() - timerStart) / 1000);
    if (seconds === state.seconds) return;
    state.seconds = seconds;
    updateTimerDisplay();
    persist();
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

function buildBoard() {
  boardEl.innerHTML = '';
  for (let i = 0; i < 81; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.index = String(i);
    const r = Math.floor(i / 9);
    const c = i % 9;
    if (c % 3 === 0) cell.classList.add('box-left');
    if (c === 8) cell.classList.add('box-right');
    if (r % 3 === 0) cell.classList.add('box-top');
    if (r === 8) cell.classList.add('box-bottom');
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
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

function onCellClick(index) {
  if (!state || state.finished) return;
  const value = state.grid[index];

  if (state.hintEnabled && value !== 0) {
    // Toggle the "unavailable cells" lens for this digit on/off.
    state.digitLens = state.digitLens === value ? null : value;
    state.selected = index;
    render();
    return;
  }

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
  if (state.history.length > 200) state.history.shift();
}

function onDigit(n) {
  if (!state || state.finished || state.selected === null) return;
  const index = state.selected;
  if (state.given[index]) return;

  state.checking = false;
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
        const cleared = clearNotesForPlacement(index, n);
        if (cleared.length) state.history[state.history.length - 1].clearedNotes = { cells: cleared, digit: n };
      }
    }
  }

  if (state.hintEnabled && state.digitLens !== null) {
    // Recompute lens against the new board state.
    state.digitLens = state.grid[index] || state.digitLens;
  }

  checkGameState();
  persist();
  render();
}

function onErase() {
  if (!state || state.finished || state.selected === null) return;
  const index = state.selected;
  if (state.given[index]) return;
  state.checking = false;
  pushHistory(index);
  state.grid[index] = 0;
  state.notes[index].clear();
  persist();
  render();
}

// Row, column and box of `index`: everywhere the placed digit is now illegal.
function clearNotesForPlacement(index, n) {
  const r = Math.floor(index / 9);
  const c = index % 9;
  const cleared = [];
  const strip = (i) => { if (i !== index && state.notes[i].delete(n)) cleared.push(i); };
  for (let k = 0; k < 9; k++) {
    strip(r * 9 + k);
    strip(k * 9 + c);
  }
  const br = Math.floor(r / 3) * 3;
  const bc = Math.floor(c / 3) * 3;
  for (let dr = 0; dr < 3; dr++) {
    for (let dc = 0; dc < 3; dc++) strip((br + dr) * 9 + bc + dc);
  }
  return cleared;
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
  persist();
  render();
}

function checkGameState() {
  if (state.errorMode && state.mistakes >= MAX_MISTAKES) {
    state.finished = true;
    state.running = false;
    stopTimer();
    persist();
    loseTimeEl.textContent = timerEl.textContent;
    loseModal.classList.add('open');
    return;
  }

  const solved = state.grid.every((v, i) => v === state.solution[i]);
  if (solved) {
    state.finished = true;
    state.running = false;
    stopTimer();
    persist();
    winTimeEl.textContent = timerEl.textContent;
    winModal.classList.add('open');
  }
}

function hideModals() {
  winModal.classList.remove('open');
  loseModal.classList.remove('open');
}

function render() {
  if (!state) return;
  mistakesStatEl.hidden = !state.errorMode;
  mistakesEl.textContent = `${state.mistakes} / ${MAX_MISTAKES}`;

  updateTimerDisplay();
  notesToggleBtn.classList.toggle('active', state.notesMode);

  let unavailable = new Set();
  let sources = new Set();
  if (state.hintEnabled && state.digitLens !== null) {
    const result = unavailableCellsForValue(state.grid, state.digitLens);
    unavailable = result.unavailable;
    sources = result.sources;
  }

  const selIndex = state.selected;
  const selRow = selIndex === null ? -1 : Math.floor(selIndex / 9);
  const selCol = selIndex === null ? -1 : selIndex % 9;
  const selBox = selIndex === null ? -1 : boxIndex(selRow, selCol);
  const selValue = selIndex === null ? 0 : state.grid[selIndex];

  const cells = boardEl.children;
  for (let i = 0; i < 81; i++) {
    const cellEl = cells[i];
    const r = Math.floor(i / 9);
    const c = i % 9;
    const value = state.grid[i];

    cellEl.className = 'cell';
    if (c % 3 === 0) cellEl.classList.add('box-left');
    if (c === 8) cellEl.classList.add('box-right');
    if (r % 3 === 0) cellEl.classList.add('box-top');
    if (r === 8) cellEl.classList.add('box-bottom');

    cellEl.innerHTML = '';

    if (value !== 0) {
      const span = document.createElement('span');
      span.className = 'value';
      span.textContent = String(value);
      cellEl.appendChild(span);
      if (state.given[i]) cellEl.classList.add('given');
      if (state.errorMode && !state.given[i] && value !== state.solution[i]) cellEl.classList.add('error');
    } else if (state.notes[i].size > 0) {
      const notesGrid = document.createElement('div');
      notesGrid.className = 'notes';
      for (let n = 1; n <= 9; n++) {
        const noteSpan = document.createElement('span');
        noteSpan.textContent = state.notes[i].has(n) ? String(n) : '';
        notesGrid.appendChild(noteSpan);
      }
      cellEl.appendChild(notesGrid);
    }

    if (selIndex !== null) {
      if (i === selIndex) cellEl.classList.add('selected');
      else if (r === selRow || c === selCol || boxIndex(r, c) === selBox) {
        cellEl.classList.add('peer');
      }
      if (selValue !== 0 && value === selValue) cellEl.classList.add('same-value');
    }

    // Empty cells the player still owes, shown on demand by the check button.
    if (state.checking && value === 0) cellEl.classList.add('check-empty');

    if (state.hintEnabled && state.digitLens !== null) {
      if (sources.has(i)) cellEl.classList.add('lens-source');
      else if (unavailable.has(i)) cellEl.classList.add('dimmed');
    }
  }

  const numButtons = numpadEl.children;
  for (let n = 1; n <= 9; n++) {
    const remaining = 9 - state.grid.filter((v) => v === n).length;
    numButtons[n - 1].classList.toggle('disabled', remaining <= 0);
  }
}

function onKeydown(e) {
  if (!state || state.finished) return;
  if (e.key >= '1' && e.key <= '9') {
    onDigit(Number(e.key));
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
    onErase();
    return;
  }
  if (state.selected === null) return;
  const r = Math.floor(state.selected / 9);
  const c = state.selected % 9;
  let nr = r, nc = c;
  if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
  else if (e.key === 'ArrowDown') nr = Math.min(8, r + 1);
  else if (e.key === 'ArrowLeft') nc = Math.max(0, c - 1);
  else if (e.key === 'ArrowRight') nc = Math.min(8, c + 1);
  else return;
  e.preventDefault();
  state.selected = nr * 9 + nc;
  render();
}

difficultySelect.addEventListener('change', () => {
  newGame(difficultySelect.value);
});

newGameBtn.addEventListener('click', () => {
  newGame(difficultySelect.value);
});

undoBtn.addEventListener('click', onUndo);
eraseBtn.addEventListener('click', onErase);

notesToggleBtn.addEventListener('click', () => {
  if (!state) return;
  state.notesMode = !state.notesMode;
  persist();
  render();
});

hintToggleInput.addEventListener('change', () => {
  if (!state) return;
  state.hintEnabled = hintToggleInput.checked;
  if (!state.hintEnabled) state.digitLens = null;
  persist();
  render();
});

playAgainBtn.addEventListener('click', () => {
  hideModals();
  newGame(difficultySelect.value);
});

tryAgainBtn.addEventListener('click', () => {
  hideModals();
  newGame(difficultySelect.value);
});

checkBtn.addEventListener('click', () => {
  if (!state || state.finished) return;
  // Transient: the next board change clears it, so it never goes stale.
  state.checking = true;
  render();
});

forceWinBtn.addEventListener('click', () => {
  if (!state) return;
  state.grid = state.solution.slice();
  state.checking = false;
  checkGameState();
  persist();
  render();
});

errorToggleInput.addEventListener('change', () => {
  if (!state) return;
  state.errorMode = errorToggleInput.checked;
  persist();
  render();
});

document.addEventListener('keydown', onKeydown);

buildBoard();
buildNumpad();

if (!loadPersisted()) {
  newGame(difficultySelect.value);
} else {
  render();
  if (!state.finished) startTimer();
}
