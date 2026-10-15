// Checks on the game's boards in boards.js, which tools/fetch-boards.js generates.
// Run with:  node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./solver.js');
const D = require('./boards.js');

const SIZE = 15;
const CENTRE = (SIZE >> 1) * SIZE + (SIZE >> 1);

// What each board should hold. `span` is the side of the square its nodes fill. `all` is the
// cheapest route to every coloured node, and `oranges` the cheapest with every green and blue
// ignored, both proven by the exact solver when the data was fetched.
const EXPECTED = [
  { name: 'Nezekan', level: 12, span: 11, nodes: 88, points: 134, skills: 22, all: 108, oranges: 56 },
  { name: 'Zikel', level: 20, span: 11, nodes: 88, points: 134, skills: 22, all: 106, oranges: 56 },
  { name: 'Vaizel', level: 30, span: 11, nodes: 88, points: 134, skills: 22, all: 106, oranges: 56 },
  { name: 'Triniel', level: 40, span: 13, nodes: 116, points: 168, skills: 22, all: 128, oranges: 80 },
  { name: 'Azphel', level: 45, span: 15, nodes: 152, points: 232, skills: 0, all: 188, oranges: 110 },
];

const boardOf = (b) => S.parseBoard(b.layout.join('\n'));
const copyOf = (b) => ({ w: b.w, h: b.h, cells: Uint8Array.from(b.cells) });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Solve, insist on a proven answer, and check the route independently.
function exact(b, label) {
  const result = S.solve(b);
  assert.equal(result.status, 'optimal', label + ': status');
  const check = S.verify(b, result.chosen);
  assert.ok(check.ok, label + ': route invalid, ' + check.reason);
  assert.equal(check.cost, result.cost, label + ': reported cost does not match the route');
  return result;
}

test('boards.js names its source and lists the eight classes in order', () => {
  assert.equal(D.source, 'metabot.gg');
  assert.match(D.url, /^https:\/\/metabot\.gg\/.*\/$/);
  assert.match(D.build, /^\d+(\.\d+){3}$/);
  assert.match(D.fetched, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(D.classes.map((c) => c.id),
    ['gladiator', 'templar', 'assassin', 'ranger', 'sorcerer', 'spiritmaster', 'cleric', 'chanter']);
  for (const c of D.classes) assert.ok(typeof c.name === 'string' && c.name, c.id + ' has no name');
});

test('there are five boards, in level order', () => {
  assert.deepEqual(D.boards.map((b) => [b.name, b.level]), EXPECTED.map((e) => [e.name, e.level]));
});

for (const e of EXPECTED) {
  const source = D.boards.find((b) => b.name === e.name);

  test('board ' + e.name + ': the layout reads as a 15x15 board with the start in the centre', () => {
    assert.equal(source.layout.length, SIZE);
    for (const row of source.layout) assert.match(row, /^[.S1-4]{15}$/);
    const b = boardOf(source);
    assert.equal(b.w, SIZE);
    assert.equal(b.h, SIZE);
    assert.equal(b.cells[CENTRE], S.START);
    assert.equal(S.formatBoard(b), source.layout.join('\n'));
    const counts = S.analyse(b).counts;
    assert.equal(counts.nodes, e.nodes);
    assert.equal(counts.points, e.points);
    // The nodes fill a centred square of the expected size.
    let lo = SIZE, hi = -1;
    for (let i = 0; i < b.cells.length; i++) {
      if (!S.isNode(b.cells[i])) continue;
      lo = Math.min(lo, Math.floor(i / SIZE), i % SIZE);
      hi = Math.max(hi, Math.floor(i / SIZE), i % SIZE);
    }
    assert.equal(hi - lo + 1, e.span);
    assert.equal(lo + hi, SIZE - 1, 'the nodes are not centred');
  });

  test('board ' + e.name + ': every node has exactly one label, and only skill nodes vary by class', () => {
    const b = boardOf(source);
    for (let i = 0; i < b.cells.length; i++) {
      const stat = has(source.stats, i), skill = has(source.skills, i);
      if (!S.isNode(b.cells[i])) {
        assert.ok(!stat && !skill, 'cell ' + i + ' holds no node but has a label');
        continue;
      }
      assert.equal(Number(stat) + Number(skill), 1, 'cell ' + i + ' should have exactly one label');
      if (stat) assert.ok(typeof source.stats[i] === 'string' && source.stats[i].trim(), 'cell ' + i + ' has an empty stat');
      if (skill) {
        assert.ok(b.cells[i] === S.GREEN || b.cells[i] === S.BLUE, 'cell ' + i + ' is a skill node but not green or blue');
        assert.equal(source.skills[i].length, D.classes.length, 'cell ' + i + ' needs one skill per class');
        for (const label of source.skills[i]) assert.ok(typeof label === 'string' && label.trim(), 'cell ' + i + ' has an empty skill');
      }
    }
    assert.equal(Object.keys(source.skills).length, e.skills);
  });

  test('board ' + e.name + ': cheapest routes, to everything and to the oranges alone', () => {
    const b = boardOf(source);
    assert.equal(exact(b, e.name).cost, e.all);
    const oranges = copyOf(b);
    for (let i = 0; i < oranges.cells.length; i++) {
      if (oranges.cells[i] === S.GREEN || oranges.cells[i] === S.BLUE) oranges.cells[i] |= S.FLIP;
    }
    assert.equal(exact(oranges, e.name + ' with greens and blues ignored').cost, e.oranges);
  });
}

test('each game board is recognised as itself and as no other', () => {
  const boards = D.boards.map(boardOf);
  boards.forEach((b, k) => assert.equal(S.matchLayout(b, boards), k, D.boards[k].name));
  // Keep a wide margin below the 80% that matchLayout asks for.
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      const c = S.compareLayouts(boards[i], boards[j]);
      assert.ok(c.same / c.nodes <= 0.7, D.boards[i].name + ' and ' + D.boards[j].name + ' share ' + c.same + ' of ' + c.nodes + ' nodes');
    }
  }
});

test('a game board is still recognised with marks and a few painting slips', () => {
  const boards = D.boards.map(boardOf);
  const nezekan = boards[0];
  const nodes = [], empty = [];
  for (let i = 0; i < nezekan.cells.length; i++) {
    if (S.isNode(nezekan.cells[i])) nodes.push(i);
    else if (nezekan.cells[i] === S.EMPTY) empty.push(i);
  }

  const marked = copyOf(nezekan);
  for (const i of nodes) marked.cells[i] |= S.FLIP;
  assert.equal(S.matchLayout(marked, boards), 0);
  assert.equal(S.compareLayouts(marked, nezekan).differ, 0);

  // Four colours changed, four nodes erased and four added.
  const slipped = copyOf(nezekan);
  for (let k = 0; k < 4; k++) slipped.cells[nodes[k]] = (S.tierOf(nezekan.cells[nodes[k]]) % 4) + 1;
  for (let k = 4; k < 8; k++) slipped.cells[nodes[k]] = S.EMPTY;
  for (let k = 0; k < 4; k++) slipped.cells[empty[k]] = S.GREY;
  assert.equal(S.matchLayout(slipped, boards), 0);
  assert.equal(S.compareLayouts(slipped, nezekan).differ, 12);

  // The threshold itself: 71 of 88 nodes left is enough, 70 is not.
  const erased = (count) => {
    const b = copyOf(nezekan);
    for (let k = 0; k < count; k++) b.cells[nodes[k]] = S.EMPTY;
    return b;
  };
  assert.equal(S.compareLayouts(erased(17), nezekan).same, 71);
  assert.equal(S.matchLayout(erased(17), boards), 0);
  assert.equal(S.matchLayout(erased(18), boards), -1);
});
