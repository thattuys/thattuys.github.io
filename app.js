// Page logic for the Daevanion board solver: painting, route display and saving.
// All the board maths lives in solver.js.
(function () {
  'use strict';

  const S = window.BoardSolver;
  const SIZE = 15;
  const CENTRE = (SIZE >> 1) * SIZE + (SIZE >> 1);
  const KEY_CURRENT = 'boardsolver.v1.current';
  const KEY_SAVED = 'boardsolver.v1.saved';
  const SLICE_MS = 25;                 // how long the solver may hold the page at a time
  const PROVISIONAL_AFTER_MS = 200;    // show the quick route if the exact one takes longer than this
  // After this, settle for the quick route. The page stays responsive throughout, so the limit is
  // generous: the largest real board with every skill node ignored takes a second or two.
  const TIME_LIMIT_MS = 20000;
  const UNDO_LIMIT = 200;

  const $ = (id) => document.getElementById(id);
  const gridEl = $('grid'), statusEl = $('status'), greysEl = $('greys'), marksEl = $('marks'), warningEl = $('warning');
  const totalsEl = $('totals'), tiersEl = $('tiers');
  const savedEl = $('saved'), storageNoteEl = $('storageNote');
  const textEl = $('text'), textErrorEl = $('textError');
  const undoBtn = $('undo'), removeBtn = $('remove'), copyBtn = $('copy');
  const brushBtns = Array.from(document.querySelectorAll('.brush'));

  // ---------------------------------------------------------------- storage

  // localStorage can be blocked or full, and browsers scope it differently for local files,
  // so every use is guarded and the layout text box is the durable backup.
  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
    },
  };

  function readSaved() {
    try {
      const saved = JSON.parse(store.get(KEY_SAVED) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch (e) {
      return {};
    }
  }

  // Any layout text becomes a full 15x15 board, with a smaller layout centred on its start.
  const boardFromText = (text) => S.fitToGrid(S.parseBoard(text), SIZE);

  function restoreBoard() {
    const text = store.get(KEY_CURRENT);
    if (!text) return null;
    try { return boardFromText(text); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- state

  let board = restoreBoard() || S.createBoard(SIZE, SIZE);
  let facts = S.analyse(board);        // totals and unreachable cells for the current board
  let route = null;                    // the result on show, or null while there is none
  let provisional = false;             // true while `route` is the quick route and the search is still running
  let progress = '';                   // how far the search has got, for the status line
  let brush = '1';                     // a paint brush '0'-'5' (cell code), or the marks 'want' and 'ignore'
  let stroke = null;                   // the drag in progress
  let solveToken = 0;                  // bumping it cancels a running solve
  let currentName = '';
  const undoStack = [];
  const cellEls = [];
  const isCut = new Uint8Array(SIZE * SIZE);

  // ---------------------------------------------------------------- rendering

  function buildGrid() {
    for (let i = 0; i < SIZE * SIZE; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      gridEl.appendChild(cell);
      cellEls.push(cell);
    }
  }

  function renderCell(i) {
    const code = board.cells[i];
    const tier = S.tierOf(code);
    let cls = 'cell';
    if (code === S.START) {
      cls += route && route.chosen[i] ? ' start on' : ' start';
    } else if (S.isNode(code)) {
      cls += ' t' + tier;
      if (S.isFlipped(code)) cls += tier === S.GREY ? ' want' : ' ignored';
      // A node off the route fades if it was optional. A target off the route is one that
      // cannot be reached, and that gets the red outline instead.
      if (route) cls += route.chosen[i] ? ' on' : S.isTarget(code) ? '' : ' off';
    } else if (i === CENTRE) {
      cls += ' centre';
    }
    if (isCut[i]) cls += ' cut';
    const label = code === S.START ? '★' : S.isNode(code) ? String(tier) : '';
    const cell = cellEls[i];
    if (cell.className !== cls) cell.className = cls;
    if (cell.textContent !== label) cell.textContent = label;
  }

  function renderCells() {
    for (let i = 0; i < cellEls.length; i++) renderCell(i);
  }

  const points = (n) => n + (n === 1 ? ' point' : ' points');

  function renderPanel() {
    const counts = facts.counts;
    // Targets are the coloured nodes not being ignored, plus the greys marked as wanted.
    const targets = counts.tiers[2] + counts.tiers[3] + counts.tiers[4] - counts.ignored + counts.wanted;

    let status;
    if (targets === 0) status = 'Paint a coloured node, or mark a grey as wanted, to get a route.';
    else if (!route) status = 'Checking…' + progress;
    else if (provisional) status = 'Best so far: ' + points(route.cost) + '. Still checking for a cheaper route' + progress + '.';
    else if (route.status === 'optimal') status = 'Cheapest route: ' + points(route.cost);
    else status = 'Best route found: ' + points(route.cost) + '. This layout is too open to prove it is the cheapest.';
    statusEl.textContent = status;

    const parts = route && targets > 0 ? S.routeBreakdown(board, route.chosen) : null;
    greysEl.textContent = parts ? 'Greys: ' + parts.greysBought + ' bought, ' + parts.greysSkipped + ' skipped' : '';

    const marks = [];
    if (counts.wanted) marks.push('Wanted greys: ' + counts.wanted);
    if (counts.ignored) {
      // An ignored node is still a way through, and sometimes the cheapest one.
      const stones = parts && parts.ignoredBought
        ? ', with ' + parts.ignoredBought + ' still on the route for ' + points(parts.ignoredPoints)
        : '';
      marks.push('Ignored nodes: ' + counts.ignored + stones);
    }
    marksEl.hidden = marks.length === 0;
    marksEl.textContent = marks.join(' · ');

    const cut = facts.unreachable.length;
    warningEl.hidden = cut === 0;
    warningEl.textContent = cut === 0 ? '' : (cut === 1
      ? '1 target cannot be reached from the start and is left out. It is outlined in red.'
      : cut + ' targets cannot be reached from the start and are left out. They are outlined in red.');

    totalsEl.textContent = counts.nodes + (counts.nodes === 1 ? ' node, ' : ' nodes, ') + points(counts.points);
    tiersEl.textContent = 'Grey ' + counts.tiers[1] + ' · Green ' + counts.tiers[2] +
      ' · Blue ' + counts.tiers[3] + ' · Orange ' + counts.tiers[4];

    undoBtn.disabled = undoStack.length === 0;
    removeBtn.disabled = !savedEl.value;
  }

  function render() {
    renderCells();
    renderPanel();
  }

  // ---------------------------------------------------------------- solving

  function show(result, isProvisional) {
    route = result;
    provisional = isProvisional;
    render();
  }

  // Runs the exact search in short slices so the page stays responsive. Any newer call cancels
  // this one. The quick route stands in if the search is slow, and replaces it if it gives up.
  function startSolve() {
    const token = ++solveToken;
    const started = performance.now();
    const steps = S.solveSteps(board);
    let latest = null;
    progress = '';

    function slice() {
      if (token !== solveToken) return;
      const sliceEnd = performance.now() + SLICE_MS;
      for (;;) {
        let step;
        try {
          step = steps.next();
        } catch (e) {
          route = null;
          render();
          statusEl.textContent = 'Could not solve this board: ' + e.message;
          return;
        }
        if (step.done) { progress = ''; show(step.value, false); return; }
        latest = step.value;
        const now = performance.now();
        if (now - started > TIME_LIMIT_MS) {
          progress = '';
          show(Object.assign({}, latest.provisional, { status: 'unproven' }), false);
          return;
        }
        if (now >= sliceEnd) break;
      }
      // Real boards finish within a few slices. Only a search that drags on gets a progress
      // figure and the quick route as a stand-in, so short ones do not flicker.
      if (performance.now() - started > PROVISIONAL_AFTER_MS) {
        progress = ' (' + Math.floor(100 * latest.cell / latest.cells) + '%)';
        if (!route) show(latest.provisional, true);
        else renderPanel();
      }
      setTimeout(slice, 0);
    }
    slice();
  }

  // Call after any change to the board: refresh the facts, save, and solve again.
  function commit() {
    facts = S.analyse(board);
    isCut.fill(0);
    for (const i of facts.unreachable) isCut[i] = 1;
    const text = S.formatBoard(board);
    store.set(KEY_CURRENT, text);
    if (document.activeElement !== textEl) textEl.value = text;
    route = null;
    provisional = false;
    render();
    startSolve();
  }

  // ---------------------------------------------------------------- editing

  function pushUndo(text) {
    undoStack.push(text);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    if (stroke || !undoStack.length) return;
    board = boardFromText(undoStack.pop());
    commit();
  }

  function replaceBoard(next) {
    pushUndo(S.formatBoard(board));
    board = next;
    commit();
  }

  function setBrush(key) {
    brush = key;
    for (const btn of brushBtns) btn.setAttribute('aria-pressed', String(btn.dataset.brush === key));
  }

  // Returns true if the cell changed. The start can be moved but never removed or painted over.
  function setCell(i, code) {
    const cells = board.cells;
    if (code === S.START) {
      if (cells[i] === S.START) return false;
      cells[cells.indexOf(S.START)] = S.EMPTY;
    } else {
      if (cells[i] === S.START) return false;
      // Painting a node its own colour changes nothing, so a mark on it survives.
      const same = code === S.EMPTY ? cells[i] === S.EMPTY : S.isNode(cells[i]) && S.tierOf(cells[i]) === code;
      if (same) return false;
    }
    cells[i] = code;
    return true;
  }

  // A mark only applies where it means something: "want" to greys, "ignore" to coloured nodes.
  function takesMark(code, kind) {
    return S.isNode(code) && (S.tierOf(code) === S.GREY) === (kind === 'want');
  }

  function hasMark(i, kind) {
    const code = board.cells[i];
    return takesMark(code, kind) && S.isFlipped(code);
  }

  // Put a mark on a node or take it off. Returns true if the cell changed.
  function setMark(i, kind, on) {
    const code = board.cells[i];
    if (!takesMark(code, kind) || S.isFlipped(code) === on) return false;
    board.cells[i] = code ^ S.FLIP;
    return true;
  }

  // The cell under the pointer, or -1 outside the grid. Worked out from the position because a
  // captured pointer keeps reporting the element the drag started on.
  function cellAt(e) {
    const rect = gridEl.getBoundingClientRect();
    const size = cellEls[0].getBoundingClientRect().width;
    const gap = (rect.width - SIZE * size) / (SIZE - 1);
    const c = Math.floor((e.clientX - rect.left + gap / 2) / (size + gap));
    const r = Math.floor((e.clientY - rect.top + gap / 2) / (size + gap));
    return c < 0 || c >= SIZE || r < 0 || r >= SIZE ? -1 : r * SIZE + c;
  }

  // Cells from `from` (excluded) to `to` (included), stepping one side at a time. A fast drag
  // skips cells between pointer events, and this fills them in as a connected run.
  function lineBetween(from, to) {
    let r = Math.floor(from / SIZE), c = from % SIZE;
    const r1 = Math.floor(to / SIZE), c1 = to % SIZE;
    const dr = Math.abs(r1 - r), dc = Math.abs(c1 - c);
    const sr = r < r1 ? 1 : -1, sc = c < c1 ? 1 : -1;
    const out = [];
    let err = dc - dr;
    for (let guard = 0; guard < 4 * SIZE && (r !== r1 || c !== c1); guard++) {
      const e2 = 2 * err;
      if (e2 >= -dr && c !== c1) { err -= dr; c += sc; out.push(r * SIZE + c); }
      if (e2 <= dc && r !== r1) { err += dc; r += sr; out.push(r * SIZE + c); }
    }
    return out;
  }

  function paint(i) {
    const changed = stroke.mark ? setMark(i, stroke.mark, stroke.on) : setCell(i, stroke.code);
    if (!changed) return;
    if (!stroke.changed) {
      // First change of this drag: the route on show no longer matches the board.
      stroke.changed = true;
      solveToken++;
      route = null;
      progress = '';
      isCut.fill(0);
      render();
    } else if (stroke.code === S.START) {
      renderCells();          // the old start cell changed too
    } else {
      renderCell(i);
    }
  }

  function beginStroke(e) {
    if (stroke || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    if (document.activeElement === textEl) textEl.blur();   // painting takes over from text editing
    // The right button undoes what the brush does: it erases a node for a paint brush, and
    // takes the mark off for a mark brush.
    const right = e.button === 2;
    const marking = brush === 'want' || brush === 'ignore';
    // Starting a mark stroke on a node that already carries that mark takes marks off instead,
    // so a second click undoes the first. Touch screens have no right button to do it with.
    const first = cellAt(e);
    const unmark = marking && first >= 0 && hasMark(first, brush);
    stroke = {
      mark: marking ? brush : null,
      on: !right && !unmark,
      code: marking ? -1 : right ? S.EMPTY : Number(brush),
      pointerId: e.pointerId,
      last: -1,
      before: S.formatBoard(board),
      changed: false,
    };
    try { gridEl.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
    extendStroke(e);
  }

  function extendStroke(e) {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    const i = cellAt(e);
    if (i < 0) { stroke.last = -1; return; }       // left the grid: do not draw a line back in
    if (i === stroke.last) return;
    // Placing the start is a single click, so a drag does not sweep it across the board.
    if (stroke.code === S.START && stroke.last >= 0) return;
    const path = stroke.last < 0 ? [i] : lineBetween(stroke.last, i);
    stroke.last = i;
    for (const j of path) paint(j);
  }

  function endStroke(e) {
    if (!stroke || (e && e.pointerId !== stroke.pointerId)) return;
    const done = stroke;
    stroke = null;
    try { gridEl.releasePointerCapture(done.pointerId); } catch (err) { /* already released */ }
    if (!done.changed) return;
    pushUndo(done.before);
    commit();
  }

  // ---------------------------------------------------------------- saved boards and text

  function refreshSaved() {
    const names = Object.keys(readSaved()).sort((a, b) => a.localeCompare(b));
    savedEl.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = names.length ? 'Load a saved board…' : 'No saved boards yet';
    savedEl.appendChild(first);
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      savedEl.appendChild(option);
    }
    savedEl.value = names.includes(currentName) ? currentName : '';
    removeBtn.disabled = !savedEl.value;
  }

  function writeSaved(saved) {
    const ok = store.set(KEY_SAVED, JSON.stringify(saved));
    storageNoteEl.hidden = ok;
    storageNoteEl.textContent = ok ? '' : 'This browser would not store the board. Copy the layout text to keep it.';
    return ok;
  }

  function saveAs() {
    const typed = window.prompt('Name for this board', currentName);
    if (typed === null) return;
    const name = typed.trim();
    if (!name) return;
    const saved = readSaved();
    saved[name] = S.formatBoard(board);
    if (writeSaved(saved)) currentName = name;
    refreshSaved();
  }

  function removeSaved() {
    const name = savedEl.value;
    if (!name || !window.confirm('Delete the saved board "' + name + '"?')) return;
    const saved = readSaved();
    delete saved[name];
    writeSaved(saved);
    if (currentName === name) currentName = '';
    refreshSaved();
  }

  function loadSaved() {
    const name = savedEl.value;
    removeBtn.disabled = !name;
    if (!name) return;
    const text = readSaved()[name];
    try {
      const next = boardFromText(text);
      currentName = name;
      replaceBoard(next);
    } catch (e) {
      storageNoteEl.hidden = false;
      storageNoteEl.textContent = 'The saved board "' + name + '" could not be read: ' + e.message;
    }
  }

  function loadText() {
    try {
      const next = boardFromText(textEl.value);
      textErrorEl.hidden = true;
      textEl.blur();                 // so the box shows the board as it now stands
      replaceBoard(next);
    } catch (e) {
      textErrorEl.hidden = false;
      textErrorEl.textContent = e.message;
    }
  }

  function copyText() {
    const done = () => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    };
    const byHand = () => {
      textEl.focus();
      textEl.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* the text is selected for Ctrl+C */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(textEl.value).then(done, byHand);
    else byHand();
  }

  // ---------------------------------------------------------------- wiring

  gridEl.addEventListener('pointerdown', beginStroke);
  gridEl.addEventListener('pointermove', extendStroke);
  gridEl.addEventListener('pointerup', endStroke);
  gridEl.addEventListener('pointercancel', endStroke);
  gridEl.addEventListener('lostpointercapture', endStroke);
  gridEl.addEventListener('contextmenu', (e) => e.preventDefault());   // the right button is a tool here

  for (const btn of brushBtns) btn.addEventListener('click', () => setBrush(btn.dataset.brush));
  undoBtn.addEventListener('click', undo);
  $('clear').addEventListener('click', () => {
    if (window.confirm('Clear the whole board?')) replaceBoard(S.createBoard(SIZE, SIZE));
  });
  $('saveAs').addEventListener('click', saveAs);
  removeBtn.addEventListener('click', removeSaved);
  savedEl.addEventListener('change', loadSaved);
  $('loadText').addEventListener('click', loadText);
  copyBtn.addEventListener('click', copyText);

  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'z') {
      if (typing) return;            // leave the text box its own undo
      e.preventDefault();
      undo();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (key >= '1' && key <= '4') setBrush(key);
    else if (key === 's') setBrush(String(S.START));
    else if (key === 'e' || key === '0') setBrush(String(S.EMPTY));
    else if (key === 'w') setBrush('want');
    else if (key === 'i') setBrush('ignore');
  });

  buildGrid();
  setBrush(brush);
  refreshSaved();
  commit();
})();
