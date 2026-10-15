// Refreshes boards.js, the game's Daevanion boards, from Metabot's board planner.
//
// Run with:  node tools/fetch-boards.js     (Node 18 or later, no packages)
// then:      node --test
//
// Metabot's planner page for each class carries every board as JSON inside the page's Next.js
// data. This reads all eight classes, checks that they agree wherever the page should be the same
// for every class, and writes one file in which the layout and the stat nodes are shared and only
// the skill nodes differ by class. At the first surprise it stops and leaves boards.js alone.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://metabot.gg/en/aion-2/daevanion/';
const OUT = path.join(__dirname, '..', 'boards.js');
const SIZE = 15;
const START_CELL = (SIZE >> 1) * SIZE + (SIZE >> 1);    // the centre cell, 112
const PAUSE_MS = 500;                                   // between page requests

// In the order of the game's own class numbers: their skill ids start 11 to 18.
const CLASSES = [
  { id: 'gladiator', name: 'Gladiator' },
  { id: 'templar', name: 'Templar' },
  { id: 'assassin', name: 'Assassin' },
  { id: 'ranger', name: 'Ranger' },
  { id: 'sorcerer', name: 'Sorcerer' },
  { id: 'spiritmaster', name: 'Spiritmaster' },
  { id: 'cleric', name: 'Cleric' },
  { id: 'chanter', name: 'Chanter' },
];

// Point cost of each grade. The cost is also the solver's cell code for the node.
const GRADE_COST = { Common: 1, Rare: 2, Legend: 3, Unique: 4 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' answered ' + res.status + ' ' + res.statusText);
  return res.text();
}

// Next.js sends the page's data as string chunks in self.__next_f.push([1,"..."]) calls. Each
// chunk is a JSON string literal, so decoding and joining them gives the data as plain text.
function flightText(html) {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) out += JSON.parse(m[1]);
  return out;
}

// The JSON array that opens at the first "[" after `key`, found by matching brackets. Brackets
// inside strings do not count.
function arrayAfter(text, key) {
  const at = text.indexOf(key);
  if (at < 0) throw new Error('the page has no ' + key + ' data');
  const open = text.indexOf('[', at);
  let depth = 0, inString = false, escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(open, i + 1));
    }
  }
  throw new Error('the ' + key + ' data never closes');
}

// The page says "Data read from the AION 2 global client (build 0.0.4387.0)". React can split that
// text in the HTML, so the decoded data is searched first.
function extractBuild(flight, html) {
  const re = /client \(build\D{0,40}?(\d+(?:\.\d+){3})/;
  const m = re.exec(flight) || re.exec(html);
  if (!m) throw new Error('the page does not say which game build its data came from');
  return m[1];
}

// Strict checks on one node, so that anything unexpected, such as an unresolved Next.js "$"
// reference standing in for a value, stops the run.
function checkNode(n, where) {
  const fail = (what) => { throw new Error(where + ': ' + what); };
  if (!n || typeof n !== 'object') fail('not a node');
  if (!Number.isInteger(n.row) || n.row < 1 || n.row > SIZE) fail('row ' + JSON.stringify(n.row) + ' is not 1 to 15');
  if (!Number.isInteger(n.col) || n.col < 1 || n.col > SIZE) fail('column ' + JSON.stringify(n.col) + ' is not 1 to 15');
  if (typeof n.label !== 'string' || !n.label.trim()) fail('no label');
  if (n.type === 'Start') {
    if (n.cost !== 0 || n.auto !== true) fail('the start should be free and owned from the outset');
    return;
  }
  if (n.auto !== false) fail('only the start should be owned from the outset');
  if (!Object.hasOwn(GRADE_COST, n.grade)) fail('unknown grade ' + JSON.stringify(n.grade));
  if (n.cost !== GRADE_COST[n.grade]) fail(n.grade + ' should cost ' + GRADE_COST[n.grade] + ', not ' + JSON.stringify(n.cost));
  if (n.type === 'Stat') {
    if (!Array.isArray(n.stats) || !n.stats.length) fail('a stat node with no stats');
    for (const s of n.stats) {
      if (!s || typeof s.stat !== 'string' || typeof s.value !== 'number') fail('a stat that is not a name and a number');
    }
    // The page shows a node with several stats on separate lines by splitting on ", ".
    if (n.label.split(', ').length !== n.stats.length) {
      fail('the label "' + n.label + '" does not list its ' + n.stats.length + ' stats one by one');
    }
  } else if (n.type === 'SkillLevel') {
    if (n.grade !== 'Rare' && n.grade !== 'Legend') fail('a skill node graded ' + n.grade);
    if (typeof n.skillName !== 'string' || !n.skillName) fail('a skill node with no skill');
    if (!Number.isInteger(n.skillLevels) || n.skillLevels < 1) fail('a skill node adding ' + JSON.stringify(n.skillLevels) + ' levels');
  } else {
    fail('unknown node type ' + JSON.stringify(n.type));
  }
}

const cellOf = (n) => (n.row - 1) * SIZE + (n.col - 1);

// Board b from every class page, merged into one board with per-class skill labels. Returns
// the board and the distinct unlock levels on its nodes, which the summary reports.
function combineBoard(pages, b) {
  const first = pages[0].boards[b];
  const name = first.name;
  const byClass = pages.map((page) => {
    const board = page.boards[b];
    const where = name + ' (' + page.cls.id + ')';
    if (typeof board.name !== 'string' || !Number.isInteger(board.needLevel) || !Array.isArray(board.nodes)) {
      throw new Error(where + ': the board is not a name, a level and a list of nodes');
    }
    if (board.needLevel !== first.needLevel) throw new Error(where + ': unlocks at a different level');
    const cells = new Map();
    for (const n of board.nodes) {
      const at = name + ' row ' + n.row + ' column ' + n.col + ' (' + page.cls.id + ')';
      checkNode(n, at);
      if (cells.has(cellOf(n))) throw new Error(at + ': two nodes on one cell');
      cells.set(cellOf(n), n);
    }
    return cells;
  });

  const base = byClass[0];
  for (let k = 1; k < pages.length; k++) {
    if (byClass[k].size !== base.size) {
      throw new Error(name + ': ' + pages[k].cls.id + ' has ' + byClass[k].size + ' nodes, ' + pages[0].cls.id + ' has ' + base.size);
    }
  }

  const rows = Array.from({ length: SIZE }, () => Array(SIZE).fill('.'));
  const stats = {}, skills = {};
  const levels = new Set();
  let starts = 0;
  for (const cell of [...base.keys()].sort((x, y) => x - y)) {
    const n = base.get(cell);
    const at = name + ' row ' + n.row + ' column ' + n.col;
    for (let k = 1; k < pages.length; k++) {
      const other = byClass[k].get(cell);
      const cls = pages[k].cls.id;
      if (!other) throw new Error(at + ': ' + cls + ' has no node here');
      if (other.type !== n.type || other.grade !== n.grade || other.cost !== n.cost) {
        throw new Error(at + ': ' + cls + ' has a ' + other.grade + ' ' + other.type + ', ' + pages[0].cls.id + ' a ' + n.grade + ' ' + n.type);
      }
      if (n.type === 'Stat' && other.label !== n.label) {
        throw new Error(at + ': ' + cls + ' gives "' + other.label + '", ' + pages[0].cls.id + ' gives "' + n.label + '"');
      }
    }
    levels.add(n.needLevel);
    const r = n.row - 1, c = n.col - 1;
    if (n.type === 'Start') {
      if (cell !== START_CELL) throw new Error(at + ': the start is not on the centre cell');
      starts++;
      rows[r][c] = 'S';
    } else {
      rows[r][c] = String(n.cost);
      if (n.type === 'Stat') stats[cell] = n.label;
      else skills[cell] = byClass.map((cells) => cells.get(cell).label);
    }
  }
  if (starts !== 1) throw new Error(name + ': ' + starts + ' start tiles, not 1');

  return {
    board: { name, level: first.needLevel, layout: rows.map((row) => row.join('')), stats, skills },
    levels: [...levels].sort((x, y) => x - y),
  };
}

function combine(pages) {
  const builds = new Set(pages.map((p) => p.build));
  if (builds.size !== 1) throw new Error('the pages come from different game builds: ' + [...builds].join(', '));
  const names = (page) => page.boards.map((b) => b && b.name).join(', ');
  for (const page of pages) {
    if (names(page) !== names(pages[0])) {
      throw new Error(page.cls.name + ' has the boards ' + names(page) + ', but ' + pages[0].cls.name + ' has ' + names(pages[0]));
    }
  }
  const merged = pages[0].boards.map((_, b) => combineBoard(pages, b));
  return {
    data: {
      source: 'metabot.gg',
      url: BASE,
      build: pages[0].build,
      fetched: new Date().toISOString().slice(0, 10),
      classes: CLASSES,
      boards: merged.map((m) => m.board),
    },
    levels: merged.map((m) => m.levels),
  };
}

// Written out by hand rather than with JSON.stringify, so that a game patch shows up as a short
// diff: one stat per line, one skill node per line, cells in order.
function renderModule(data) {
  const q = (s) => JSON.stringify(s);
  const out = [
    "// The game's Daevanion boards. Generated by tools/fetch-boards.js, so do not edit by hand.",
    '// Read from ' + data.url + '<class> (game build ' + data.build + ') on ' + data.fetched + '.',
    '// After a game patch, run  node tools/fetch-boards.js  and then  node --test.',
    '//',
    "//   layout  15 rows in the solver's text format, with the start on the centre cell",
    '//   stats   cell number (row * 15 + column, counting from 0) to what the node gives, the same',
    '//           for every class',
    '//   skills  cell number to the skill the node raises: one label per class, in the order of',
    '//           `classes`',
    '(function (root) {',
    "  'use strict';",
    '',
    '  const data = {',
    '    source: ' + q(data.source) + ',',
    '    url: ' + q(data.url) + ',',
    '    build: ' + q(data.build) + ',',
    '    fetched: ' + q(data.fetched) + ',',
    '    classes: [',
  ];
  for (const c of data.classes) out.push('      { id: ' + q(c.id) + ', name: ' + q(c.name) + ' },');
  out.push('    ],', '    boards: [');
  for (const b of data.boards) {
    out.push('      {', '        name: ' + q(b.name) + ',', '        level: ' + b.level + ',', '        layout: [');
    for (const row of b.layout) out.push('          ' + q(row) + ',');
    out.push('        ],', '        stats: {');
    for (const cell of Object.keys(b.stats)) out.push('          ' + cell + ': ' + q(b.stats[cell]) + ',');
    out.push('        },');
    const cells = Object.keys(b.skills);
    if (!cells.length) {
      out.push('        skills: {},');
    } else {
      out.push('        skills: {');
      for (const cell of cells) out.push('          ' + cell + ': [' + b.skills[cell].map(q).join(', ') + '],');
      out.push('        },');
    }
    out.push('      },');
  }
  out.push(
    '    ],',
    '  };',
    '',
    "  if (typeof module === 'object' && module.exports) module.exports = data;",
    '  else root.DaevanionBoards = data;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    '');
  return out.join('\n');
}

function readCurrent() {
  try {
    return require(OUT);
  } catch (e) {
    return null;
  }
}

// Everything but the date, so that a refresh with no game change leaves the file alone.
const sameData = (a, b) => JSON.stringify({ ...a, fetched: '' }) === JSON.stringify({ ...b, fetched: '' });

function summary(data, levels) {
  data.boards.forEach((b, k) => {
    const cells = b.layout.join('');
    const count = (ch) => cells.split(ch).length - 1;
    const tiers = [1, 2, 3, 4].map((t) => count(String(t)));
    const nodes = tiers.reduce((sum, v) => sum + v, 0);
    const points = tiers.reduce((sum, v, t) => sum + v * (t + 1), 0);
    const extra = levels[k].length === 1 && levels[k][0] === b.level ? '' : ', nodes unlock at levels ' + levels[k].join(', ');
    console.log('  ' + b.name.padEnd(8) + ' level ' + String(b.level).padStart(2) + ': ' + nodes + ' nodes, ' + points +
      ' points (grey ' + tiers[0] + ', green ' + tiers[1] + ', blue ' + tiers[2] + ', orange ' + tiers[3] + '), ' +
      Object.keys(b.skills).length + ' skill nodes' + extra);
  });
}

async function main() {
  const pages = [];
  for (const cls of CLASSES) {
    if (pages.length) await sleep(PAUSE_MS);
    const url = BASE + cls.id;
    console.log('Reading ' + url);
    const html = await fetchText(url);
    const flight = flightText(html);
    const boards = arrayAfter(flight, '"boards":[');
    if (!boards.length) throw new Error(url + ' lists no boards');
    pages.push({ cls, boards, build: extractBuild(flight, html) });
  }

  const { data, levels } = combine(pages);
  console.log('Game build ' + data.build + ', ' + data.boards.length + ' boards, ' + data.classes.length + ' classes:');
  summary(data, levels);

  const current = readCurrent();
  if (current && sameData(current, data)) {
    console.log('boards.js already holds this data. Nothing written.');
    return;
  }
  fs.writeFileSync(OUT, renderModule(data));
  console.log('Wrote ' + OUT);
}

main().catch((e) => {
  console.error('fetch-boards: ' + e.message);
  process.exitCode = 1;
});
