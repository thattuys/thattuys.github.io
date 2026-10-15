// Run with:  node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./solver.js');

// ---------------------------------------------------------------- helpers

// Layouts are written on one line here, with "/" between rows.
const board = (layout) => S.parseBoard(layout.split('/').join('\n'));

// Small seeded random generator, so failures can be reproduced.
function rng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Own copies of the grid helpers, so the oracles below do not lean on the code under test.
function neighbours(w, h, i) {
  const out = [], r = Math.floor(i / w), c = i % w;
  if (r > 0) out.push(i - w);
  if (r < h - 1) out.push(i + w);
  if (c > 0) out.push(i - 1);
  if (c < w - 1) out.push(i + 1);
  return out;
}

function reach(b, open, from) {
  const seen = new Uint8Array(b.w * b.h), stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const i = stack.pop();
    for (const j of neighbours(b.w, b.h, i)) if (open[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
  }
  return seen;
}

// The board rules as the tests understand them, written out separately from the solver.
// Bits 0-2 of a cell are its kind and point cost. Bit 3 flips whether the node is a target:
// coloured nodes are targets unless flipped (ignored), greys only when flipped (wanted).
const cost = (code) => code & 7;
const flipped = (code) => (code & 8) !== 0;
const isTarget = (code) => code === S.START || (cost(code) >= 2) !== flipped(code);

// Exhaustive answer: try every subset of the reachable optional nodes (plain greys and ignored
// coloured nodes) and keep the cheapest that connects the start to every reachable target.
// Returns null when there are more optional nodes than maxOptional.
function bruteForce(b, maxOptional = 15) {
  const n = b.w * b.h, start = b.cells.indexOf(S.START);
  const reachable = reach(b, b.cells, start);
  const optional = [], required = [];
  let base = 0;
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue;
    const code = b.cells[i];
    if (!isTarget(code)) optional.push(i);
    else { required.push(i); if (code !== S.START) base += cost(code); }
  }
  if (optional.length > maxOptional) return null;
  let best = Infinity;
  const inSet = new Uint8Array(n);
  for (let mask = 0; mask < (1 << optional.length); mask++) {
    let extra = 0;
    for (let k = 0; k < optional.length; k++) if ((mask >> k) & 1) extra += cost(b.cells[optional[k]]);
    if (extra >= best) continue;
    inSet.fill(0);
    for (const i of required) inSet[i] = 1;
    for (let k = 0; k < optional.length; k++) if ((mask >> k) & 1) inSet[optional[k]] = 1;
    const seen = reach(b, inSet, start);
    if (required.every((i) => seen[i])) best = extra;
  }
  return base + best;
}

// The eight rotations and mirrors of a board. k = 0 is the board itself.
function transform(b, k) {
  const swap = (k & 1) === 1;
  const w = swap ? b.h : b.w, h = swap ? b.w : b.h;
  const cells = new Uint8Array(w * h);
  for (let r = 0; r < b.h; r++) {
    for (let c = 0; c < b.w; c++) {
      let r2 = swap ? c : r, c2 = swap ? r : c;
      if (k & 2) r2 = h - 1 - r2;
      if (k & 4) c2 = w - 1 - c2;
      cells[r2 * w + c2] = b.cells[r * b.w + c];
    }
  }
  return { w, h, cells };
}

// pMark is the chance that a node is marked: a grey as wanted, a coloured node as ignored.
function randomBoard(rand, w, h, pEmpty, pColour, pMark) {
  const cells = new Uint8Array(w * h);
  for (let i = 0; i < cells.length; i++) {
    if (rand() < pEmpty) continue;
    cells[i] = rand() < pColour ? 2 + Math.floor(rand() * 3) : S.GREY;
    if (pMark && rand() < pMark) cells[i] |= S.FLIP;
  }
  cells[Math.floor(rand() * cells.length)] = S.START;
  return { w, h, cells };
}

// Solve, insist on a proven answer, and check the route independently.
function exact(b, label) {
  const result = S.solve(b);
  assert.equal(result.status, 'optimal', label + ': status');
  const check = S.verify(b, result.chosen);
  assert.ok(check.ok, label + ': route invalid, ' + check.reason);
  assert.equal(check.cost, result.cost, label + ': reported cost does not match the route');
  return result;
}

const describe = (b) => '\n' + S.formatBoard(b) + '\n';

// ---------------------------------------------------------------- text format

test('text format round-trips', () => {
  const text = '2.1\n1.1\n11S';
  assert.equal(S.formatBoard(S.parseBoard(text)), text);
});

test('text format accepts Windows line endings, trailing spaces, a lower-case s and short lines', () => {
  const b = S.parseBoard('\r\n21  \r\n1s1\r\n\r\n');
  assert.equal(b.w, 3);
  assert.equal(b.h, 2);
  assert.equal(S.formatBoard(b), '21.\n1S1');
});

test('text format keeps wanted greys and ignored nodes, in either letter case', () => {
  const b = S.parseBoard('SwW\ngGb\nBoO');
  assert.deepEqual(Array.from(b.cells), [
    S.START, S.GREY | S.FLIP, S.GREY | S.FLIP,
    S.GREEN | S.FLIP, S.GREEN | S.FLIP, S.BLUE | S.FLIP,
    S.BLUE | S.FLIP, S.ORANGE | S.FLIP, S.ORANGE | S.FLIP,
  ]);
  assert.equal(S.formatBoard(b), 'Sww\nggb\nboo');
  // Layouts saved before marks existed read exactly as they did.
  assert.deepEqual(Array.from(S.parseBoard('S1234').cells), [S.START, 1, 2, 3, 4]);
});

test('a mark flips whether a node is a target, and never changes its cost', () => {
  assert.deepEqual([1, 2, 3, 4].map(S.isTarget), [false, true, true, true]);
  assert.deepEqual([1, 2, 3, 4].map((t) => S.isTarget(t | S.FLIP)), [true, false, false, false]);
  assert.deepEqual([1, 2, 3, 4].map((t) => S.tierOf(t | S.FLIP)), [1, 2, 3, 4]);
  assert.deepEqual([S.EMPTY, S.START].map(S.isNode), [false, false]);
  assert.deepEqual([S.EMPTY, S.START].map(S.isTarget), [false, false]);
});

test('text format reports where a bad character is', () => {
  assert.throws(() => S.parseBoard('S12\n1x1'), /Line 2, column 2: unexpected character "x"/);
});

test('text format insists on exactly one start', () => {
  assert.throws(() => S.parseBoard('112'), /no start tile/);
  assert.throws(() => S.parseBoard('S1\n1S'), /Line 2, column 2: a second start tile/);
  assert.throws(() => S.parseBoard('  \n'), /empty/);
});

test('text format rejects layouts wider than 15 columns', () => {
  assert.throws(() => S.parseBoard('S' + '1'.repeat(15)), /16 columns wide/);
});

test('a new board is empty with the start in the centre', () => {
  const b = S.createBoard(15, 15);
  assert.equal(b.cells[7 * 15 + 7], S.START);
  assert.equal(b.cells.filter((code) => code !== 0).length, 1);
});

test('fitToGrid puts a smaller layout in the 15x15 grid with its start on the centre cell', () => {
  // An 11x11 cross: a green at each end of the row, a blue on top and an orange at the bottom.
  const rows = [];
  for (let r = 0; r < 11; r++) {
    rows.push(r === 5 ? '21111S11112' : r === 0 ? '.....3.....' : r === 10 ? '.....4.....' : '.....1.....');
  }
  const small = S.parseBoard(rows.join('\n'));
  const big = S.fitToGrid(small, 15);
  assert.equal(big.w, 15);
  assert.equal(big.h, 15);
  assert.equal(big.cells[7 * 15 + 7], S.START);
  assert.equal(big.cells[2 * 15 + 7], S.BLUE);       // top of the cross lands on row 2
  assert.equal(big.cells[12 * 15 + 7], S.ORANGE);    // bottom on row 12
  assert.equal(big.cells[7 * 15 + 2], S.GREEN);      // left end on column 2
  assert.equal(big.cells[7 * 15 + 12], S.GREEN);     // right end on column 12
  assert.equal(big.cells[1 * 15 + 7], S.EMPTY);
  assert.equal(S.solve(small).cost, 27);             // 16 greys + 2 + 2 + 3 + 4
  assert.equal(S.solve(big).cost, 27);

  // An off-centre start is moved to the centre only as far as the layout still fits.
  const corner = S.fitToGrid(S.parseBoard('S1\n12'), 15);
  assert.equal(corner.cells[7 * 15 + 7], S.START);
  assert.throws(() => S.fitToGrid(S.parseBoard('S\n' + '1\n'.repeat(15)), 15), /does not fit/);
});

test('analyse counts the whole board and finds what cannot be reached', () => {
  const p = S.analyse(board('S12.3/1...4'));
  assert.deepEqual(p.counts, { nodes: 5, points: 11, tiers: [0, 2, 1, 1, 1], wanted: 0, ignored: 0 });
  assert.deepEqual(p.unreachable, [4, 9]);
});

test('analyse counts marks, and only reports unreachable nodes that are targets', () => {
  // Top row: start, wanted grey, green, gap, blue. Bottom row: grey, gaps, wanted grey, ignored blue.
  const p = S.analyse(board('Sw2.3/1..wb'));
  assert.deepEqual(p.counts, { nodes: 6, points: 11, tiers: [0, 3, 1, 2, 0], wanted: 2, ignored: 1 });
  assert.deepEqual(p.unreachable, [4, 8]);              // the blue and the far wanted grey, not the ignored blue
  assert.deepEqual(Array.from(p.required), [1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(p.weight), [0, 1, 2, 0, 0, 1, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------- hand-built boards

// Each expected cost was confirmed by exhaustive search. `guards` says what bug it would catch.
const FIXTURES = [
  { name: 'start only', layout: 'S', cost: 0, guards: 'an empty answer' },
  { name: 'no targets', layout: '111/1S1/111', cost: 0, guards: 'the slow path on a grey-filled board' },
  { name: 'all tiers', layout: 'S1213141', cost: 12, guards: 'buying a trailing grey' },
  { name: 'gap', layout: 'S1/.1/21', cost: 5, guards: 'a slot not cleared on an empty cell' },
  { name: 'row wrap', layout: '..............S/211111111111111', cost: 16, guards: 'the end of one row acting as left neighbour of the next' },
  { name: 'same-group join', layout: 'S2/22', cost: 6, guards: 'rejecting a 2x2 block' },
  { name: 'two live groups', layout: 'S.2/111', cost: 5, guards: 'finishing while another group is open' },
  { name: 'late join', layout: 'S.2/1.1/111', cost: 7, guards: 'groups that only meet lower down' },
  { name: 'loop', layout: 'S111/1..2/1111', cost: 5, guards: 'taking the long side' },
  { name: 'two arms', layout: '2.3/1.1/1S1', cost: 9, guards: 'branching from the start' },
  { name: 'coloured block', layout: 'S1./.22/.22', cost: 9, guards: 'a cycle of mandatory cells' },
  { name: 'adjacent targets', layout: 'S234', cost: 9, guards: 'targets that need no greys' },
  { name: 'start in a corner', layout: '2.1/1.1/11S', cost: 5, guards: 'a start in the last cell' },
  { name: 'nested arches', layout: '222222222/2.......2/2.22222.2/2.2...2.2/2.2.S.2.2/2.2.1.2.2/212111212', cost: 72, guards: 'a join that renames only one slot' },
  { name: 'eight groups', layout: 'S.2.2.2.2.2.2.2/2.2.2.2.2.2.2.2/212121212121212', cost: 53, guards: 'group numbers overflowing the key' },
  { name: 'eight groups mid-row', layout: '.......S.2.2.2./2.2.2.22.2.2.2./212121221212121', cost: 44, guards: 'the same, across the row boundary' },
  { name: 'dangling blob', layout: '11.S12/11111.', cost: 3, guards: 'buying useless greys' },
  { name: 'unreachable target', layout: 'S12.3', cost: 3, unreachable: [4], guards: 'counting a target that cannot be reached' },
  { name: 'greedy trap A', layout: 'S11/1.1/1.2/111/1../2..', cost: 10, greedy: 11, guards: 'greedy passing as exact' },
  { name: 'greedy trap B', layout: '21112/111.1/1.2S1', cost: 10, greedy: 11, guards: 'greedy passing as exact' },
];

for (const f of FIXTURES) {
  test('board: ' + f.name + ' (guards against ' + f.guards + ')', () => {
    const b = board(f.layout);
    const result = exact(b, f.name);
    assert.equal(result.cost, f.cost);
    assert.equal(bruteForce(b), f.cost, 'exhaustive search disagrees with the expected value');
    assert.deepEqual(result.unreachable, f.unreachable || []);
    if (f.greedy !== undefined) assert.equal(S.greedy(b).cost, f.greedy);

    // The answer must not depend on which way round the board is.
    for (let k = 1; k < 8; k++) {
      const turned = transform(b, k);
      assert.equal(exact(turned, f.name + ' turned ' + k).cost, f.cost, 'turned ' + k + describe(turned));
    }
  });
}

test('the route never includes a grey it could do without', () => {
  const b = board('11.S12/11111.');
  const result = exact(b, 'dangling blob');
  assert.equal(result.extras, 1);
  assert.deepEqual(Array.from(result.chosen), [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------- wanted greys and ignored nodes

// "w" is a grey the player wants, so it is a target. "g", "b", "o" are an ignored green, blue or
// orange: no longer a target, but still a node the route may pay to pass through.
// `include` and `avoid` are cell numbers the route must or must not hold.
const MARK_FIXTURES = [
  { name: 'a wanted grey next to the start is bought', layout: 'Sw', cost: 1, include: [1] },
  { name: 'a wanted grey off the route forces a detour', layout: 'S12/1.1/1w1', cost: 6, include: [7] },
  { name: 'a wanted grey decides which side of a loop is used', layout: '1111/S..2/1w11', cost: 6, include: [9], avoid: [0, 1, 2, 3] },
  { name: 'an ignored node nobody needs is skipped', layout: 'S1g', cost: 0, avoid: [1, 2] },
  { name: 'an ignored node is still a stepping stone when that is cheapest', layout: 'Sb2/1.1/111', cost: 5, include: [1] },
  { name: 'an ignored node is avoided when going round is cheaper', layout: '111/So2', cost: 5, avoid: [4] },
  { name: 'an ignored node costs its full price to pass through', layout: 'Sg2/1.1/111', cost: 4, include: [1] },
  { name: 'everything ignored', layout: 'Sg/bo', cost: 0, avoid: [1, 2, 3] },
  { name: 'a wanted grey behind an ignored node', layout: 'Sgw', cost: 3, include: [1, 2] },
  { name: 'an unreachable wanted grey is reported', layout: 'S1.w', cost: 0, unreachable: [3] },
  { name: 'an unreachable ignored node is not reported', layout: 'S1.g', cost: 0 },
];

for (const f of MARK_FIXTURES) {
  test('marks: ' + f.name, () => {
    const b = board(f.layout);
    const result = exact(b, f.name);
    assert.equal(result.cost, f.cost);
    assert.equal(bruteForce(b), f.cost, 'exhaustive search disagrees with the expected value');
    assert.deepEqual(result.unreachable, f.unreachable || []);
    for (const i of f.include || []) assert.equal(result.chosen[i], 1, 'cell ' + i + ' should be on the route');
    for (const i of f.avoid || []) assert.equal(result.chosen[i], 0, 'cell ' + i + ' should not be on the route');
    for (let k = 1; k < 8; k++) {
      const turned = transform(b, k);
      assert.equal(exact(turned, f.name + ' turned ' + k).cost, f.cost, 'turned ' + k + describe(turned));
    }
  });
}

test('marking a grey as wanted can only raise the cost, and ignoring a node can only lower it', () => {
  const rand = rng(5150);
  let wantedRaised = 0, ignoredLowered = 0;
  for (let k = 0; k < 300; k++) {
    const b = randomBoard(rand, 5, 5, 0.25, 0.3);
    const before = exact(b, 'before').cost;
    const nodes = [];
    for (let i = 0; i < b.cells.length; i++) if (S.isNode(b.cells[i])) nodes.push(i);
    if (!nodes.length) continue;
    const i = nodes[Math.floor(rand() * nodes.length)];
    const marked = { w: b.w, h: b.h, cells: Uint8Array.from(b.cells) };
    marked.cells[i] |= S.FLIP;
    const after = exact(marked, 'after').cost;
    if (b.cells[i] === S.GREY) {
      assert.ok(after >= before, 'wanting a grey made the route cheaper' + describe(marked));
      if (after > before) wantedRaised++;
    } else {
      assert.ok(after <= before, 'ignoring a node made the route dearer' + describe(marked));
      if (after < before) ignoredLowered++;
    }
  }
  assert.ok(wantedRaised > 10 && ignoredLowered > 10, 'the marks rarely changed anything: ' + wantedRaised + ', ' + ignoredLowered);
});

test('routeBreakdown reports greys bought and skipped, and ignored nodes passed through', () => {
  const stone = board('Sb2/1.1/111');
  assert.deepEqual(S.routeBreakdown(stone, S.solve(stone).chosen),
    { greysBought: 0, greysSkipped: 5, ignoredBought: 1, ignoredPoints: 3 });
  const loop = board('1111/S..2/1w11');
  assert.deepEqual(S.routeBreakdown(loop, S.solve(loop).chosen),
    { greysBought: 4, greysSkipped: 4, ignoredBought: 0, ignoredPoints: 0 });
  const round = board('111/So2');
  assert.deepEqual(S.routeBreakdown(round, S.solve(round).chosen),
    { greysBought: 3, greysSkipped: 0, ignoredBought: 0, ignoredPoints: 0 });
});

// ---------------------------------------------------------------- comparing layouts

test('compareLayouts ignores marks and the start, and counts each changed cell once', () => {
  const a = board('S12/3.4');
  assert.deepEqual(S.compareLayouts(a, a), { same: 4, differ: 0, nodes: 4 });
  // Wanting a grey and ignoring coloured nodes leaves the layout as it was.
  assert.deepEqual(S.compareLayouts(a, board('Swg/3.o')), { same: 4, differ: 0, nodes: 4 });
  // So does moving the start to an empty cell.
  assert.deepEqual(S.compareLayouts(a, board('.12/3S4')), { same: 4, differ: 0, nodes: 4 });
  // A grey turned green, a blue erased and a grey added: three changed cells.
  assert.deepEqual(S.compareLayouts(a, board('S22/.14')), { same: 2, differ: 3, nodes: 4 });
  assert.deepEqual(S.compareLayouts(board('S22/.14'), a), { same: 2, differ: 3, nodes: 4 });
  assert.throws(() => S.compareLayouts(a, board('S1')), /same size/);
});

test('matchLayout picks the candidate a board copies, allowing a few changes', () => {
  const grey = board('11111/11S11/11111');            // 14 greys
  const green = board('22222/22S22/22222');           // the same cells, all green
  const narrow = board('1111/1S11/1111');
  assert.equal(S.matchLayout(grey, [green, grey]), 1);
  // Two of 14 cells changed still matches (12 of 14 is 86%), three does not (11 of 14 is 79%).
  const two = board('11211/11S11/11.11'), three = board('12211/11S11/11.11');
  assert.equal(S.matchLayout(two, [green, grey]), 1);
  assert.equal(S.matchLayout(three, [green, grey]), -1);
  assert.equal(S.matchLayout(three, [green, grey], 0.75), 1);
  // The closest candidate wins, the earlier one on a tie, and other sizes are skipped.
  assert.equal(S.matchLayout(two, [grey, two]), 1);
  assert.equal(S.matchLayout(grey, [grey, grey]), 0);
  assert.equal(S.matchLayout(grey, [narrow, grey]), 1);
  assert.equal(S.matchLayout(narrow, [grey]), -1);
  // A board with no nodes matches nothing, not even another empty board.
  const empty = S.createBoard(5, 3);
  assert.equal(S.matchLayout(empty, [grey, S.createBoard(5, 3)]), -1);
});

// ---------------------------------------------------------------- exhaustive cross-checks

function crossCheck(label, seed, count, maxGreys, make, minCompared) {
  test('matches exhaustive search: ' + label, () => {
    const rand = rng(seed);
    let compared = 0;
    for (let k = 0; k < count; k++) {
      const b = make(rand);
      const truth = bruteForce(b, maxGreys);
      if (truth === null) continue;
      const result = exact(b, label + describe(b));
      assert.equal(result.cost, truth, label + ' board ' + k + describe(b));

      const quick = S.greedy(b);
      const check = S.verify(b, quick.chosen);
      assert.ok(check.ok, 'greedy route invalid, ' + check.reason + describe(b));
      assert.equal(check.cost, quick.cost);
      assert.ok(quick.cost >= truth, 'greedy beat the optimum' + describe(b));
      if (quick.status === 'optimal') assert.equal(quick.cost, truth, 'greedy claimed optimal wrongly' + describe(b));
      compared++;
    }
    assert.ok(compared >= minCompared, 'only ' + compared + ' boards were small enough to check');
  });
}

crossCheck('small boards, 3x3 to 6x6', 20261013, 2500, 13, (rand) => {
  const w = 3 + Math.floor(rand() * 4), h = 3 + Math.floor(rand() * 4);
  return randomBoard(rand, w, h, rand() * 0.5, 0.1 + rand() * 0.5);
}, 1500);
crossCheck('full-width strips, 15x2', 11, 400, 15, (rand) => randomBoard(rand, 15, 2, 0.1 + rand() * 0.3, 0.25 + rand() * 0.3), 250);
crossCheck('full-width strips, 15x3', 12, 400, 15, (rand) => randomBoard(rand, 15, 3, 0.2 + rand() * 0.3, 0.35 + rand() * 0.3), 250);
crossCheck('full-width strips, 15x4', 13, 300, 15, (rand) => randomBoard(rand, 15, 4, 0.3 + rand() * 0.25, 0.45 + rand() * 0.25), 150);

// The same again with wanted greys and ignored nodes scattered through the boards.
crossCheck('small boards with marks', 31, 2500, 13, (rand) => {
  const w = 3 + Math.floor(rand() * 4), h = 3 + Math.floor(rand() * 4);
  return randomBoard(rand, w, h, rand() * 0.5, 0.1 + rand() * 0.6, 0.1 + rand() * 0.4);
}, 1500);
crossCheck('full-width strips with marks, 15x2', 32, 400, 15, (rand) => randomBoard(rand, 15, 2, 0.1 + rand() * 0.3, 0.25 + rand() * 0.3, 0.3), 250);
crossCheck('full-width strips with marks, 15x3', 33, 400, 15, (rand) => randomBoard(rand, 15, 3, 0.2 + rand() * 0.3, 0.35 + rand() * 0.3, 0.3), 200);

// ---------------------------------------------------------------- full-size checks

// A maze with no loops has exactly one path between any two cells, so the cheapest route is
// simply every cell on a path from the start to a target. That gives an exact answer at 15x15.
function randomMaze(rand, marks) {
  const N = 15, R = 8, cells = new Uint8Array(N * N);
  const visited = new Uint8Array(R * R), stack = [0];
  visited[0] = 1;
  cells[0] = S.GREY;
  while (stack.length) {
    const cur = stack[stack.length - 1], a = Math.floor(cur / R), b = cur % R;
    const options = [];
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = a + da, y = b + db;
      if (x >= 0 && x < R && y >= 0 && y < R && !visited[x * R + y]) options.push([x, y]);
    }
    if (!options.length) { stack.pop(); continue; }
    const [x, y] = options[Math.floor(rand() * options.length)];
    visited[x * R + y] = 1;
    cells[2 * x * N + 2 * y] = S.GREY;           // the room
    cells[(a + x) * N + (b + y)] = S.GREY;       // the corridor to it
    stack.push(x * R + y);
  }
  const nodes = [];
  for (let i = 0; i < cells.length; i++) if (cells[i]) nodes.push(i);
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }
  cells[nodes[0]] = S.START;
  for (let k = 1; k <= 25; k++) cells[nodes[k]] = 2 + Math.floor(rand() * 3);
  if (marks) {
    for (let k = 1; k <= 8; k++) cells[nodes[k]] |= S.FLIP;          // ignore 8 of the coloured nodes
    for (let k = 26; k <= 37; k++) cells[nodes[k]] |= S.FLIP;        // want 12 of the greys
  }
  return { w: N, h: N, cells };
}

function mazeAnswer(b) {
  const n = b.w * b.h, start = b.cells.indexOf(S.START);
  const parent = new Int32Array(n).fill(-1), queue = [start], seen = new Uint8Array(n);
  seen[start] = 1;
  for (let q = 0; q < queue.length; q++) {
    for (const j of neighbours(b.w, b.h, queue[q])) {
      if (b.cells[j] && !seen[j]) { seen[j] = 1; parent[j] = queue[q]; queue.push(j); }
    }
  }
  const onPath = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (i === start || !b.cells[i] || !isTarget(b.cells[i])) continue;
    for (let x = i; x !== start && !onPath[x]; x = parent[x]) onPath[x] = 1;
  }
  let total = 0;
  for (let i = 0; i < n; i++) if (onPath[i]) total += cost(b.cells[i]);
  return total;
}

test('full-size mazes: the route is exactly the paths from the start to each target', () => {
  const rand = rng(404);
  for (let k = 0; k < 40; k++) {
    const b = randomMaze(rand);
    assert.equal(exact(b, 'maze ' + k).cost, mazeAnswer(b), 'maze ' + k + describe(b));
  }
});

test('full-size mazes with wanted greys and ignored nodes', () => {
  const rand = rng(405);
  for (let k = 0; k < 40; k++) {
    const b = randomMaze(rand, true);
    assert.equal(exact(b, 'marked maze ' + k).cost, mazeAnswer(b), 'marked maze ' + k + describe(b));
  }
});

// Boards shaped like the game's: a filled block with holes punched in it, centred on the start.
function gameLikeBoard(rand, size, fill, pMark) {
  const N = 15, cells = new Uint8Array(N * N), off = (N - size) >> 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (rand() >= fill) continue;
      const x = rand();
      const i = (r + off) * N + c + off;
      cells[i] = x < 0.7 ? S.GREY : x < 0.82 ? S.GREEN : x < 0.94 ? S.BLUE : S.ORANGE;
      if (pMark && rand() < pMark) cells[i] |= S.FLIP;
    }
  }
  cells[7 * N + 7] = S.START;
  return { w: N, h: N, cells };
}

test('full-size boards: the cost is the same under every rotation and mirror', () => {
  const rand = rng(88);
  let compared = 0;
  // The last column is the share of nodes carrying a wanted or ignored mark.
  for (const [size, fill, pMark] of [[11, 0.73, 0], [11, 0.73, 0], [11, 0.8, 0], [13, 0.69, 0], [13, 0.69, 0], [15, 0.6, 0],
    [11, 0.73, 0.15], [11, 0.8, 0.25], [13, 0.69, 0.15], [13, 0.69, 0.25]]) {
    const b = gameLikeBoard(rand, size, fill, pMark);
    const first = S.solve(b);
    if (first.status !== 'optimal') continue;       // too open to prove; the fallback has its own test
    assert.ok(S.verify(b, first.chosen).ok);
    for (let k = 1; k < 8; k++) {
      const turned = S.solve(transform(b, k));
      if (turned.status !== 'optimal') continue;
      assert.equal(turned.cost, first.cost, 'turned ' + k + describe(b));
    }
    compared++;
  }
  assert.ok(compared >= 7, 'only ' + compared + ' boards could be proven');
});

// ---------------------------------------------------------------- fallback and progress

test('with too small a state budget the result is a valid route marked unproven', () => {
  const b = board('222222222/2.......2/2.22222.2/2.2...2.2/2.2.S.2.2/2.2.1.2.2/212111212');
  const result = S.solve(b, { maxStates: 5 });
  assert.equal(result.status, 'unproven');
  const check = S.verify(b, result.chosen);
  assert.ok(check.ok, check.reason);
  assert.equal(check.cost, result.cost);
  assert.ok(result.cost >= 72);
});

test('a route with no greys is reported as optimal without a search', () => {
  const steps = S.solveSteps(board('111/1S2/111'));
  const first = steps.next();
  assert.equal(first.done, true);
  assert.equal(first.value.status, 'optimal');
  assert.equal(first.value.cost, 2);
});

test('solveSteps reports progress and ends with the same answer as solve', () => {
  const b = board('21112/111.1/1.2S1');
  const steps = S.solveSteps(b);
  let step = steps.next(), yields = 0, lastCell = 0;
  while (!step.done) {
    yields++;
    assert.ok(step.value.cell > lastCell);
    lastCell = step.value.cell;
    assert.equal(step.value.cells, 15);
    assert.ok(S.verify(b, step.value.provisional.chosen).ok);
    assert.equal(step.value.provisional.cost, 11);
    step = steps.next();
  }
  assert.ok(yields > 0);
  assert.equal(step.value.status, 'optimal');
  assert.equal(step.value.cost, S.solve(b).cost);
  assert.equal(step.value.extras, 4);
});

test('a route made only of targets is optimal without a search, wanted greys included', () => {
  const steps = S.solveSteps(board('Sww2/1111'));
  const first = steps.next();
  assert.equal(first.done, true);
  assert.equal(first.value.status, 'optimal');
  assert.equal(first.value.cost, 4);
  assert.equal(first.value.extras, 0);
});

test('boards the solver cannot represent are refused, not answered wrongly', () => {
  const wide = { w: 16, h: 1, cells: new Uint8Array(16) };
  wide.cells[0] = S.START;
  assert.throws(() => S.solve(wide), /wider than 15/);
  assert.throws(() => S.solve({ w: 2, h: 1, cells: new Uint8Array(2) }), /no start/);
});
