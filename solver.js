// Daevanion board model and solver.
//
// Plain script with no page code. In a browser it defines the global `BoardSolver`.
// Under Node the tests load it with require().
(function (root) {
  'use strict';

  // Cell codes. The low three bits say what the cell is, and for a node that number is also its
  // point cost.
  const EMPTY = 0, GREY = 1, GREEN = 2, BLUE = 3, ORANGE = 4, START = 5;

  // A node is a target by default if it is coloured, and not if it is grey. FLIP reverses that
  // for one node: a flipped grey is one the player wants, and a flipped coloured node is one the
  // player is ignoring. An ignored node can still be bought as a stepping stone, at its usual cost.
  const FLIP = 8;

  const tierOf = (code) => code & 7;                                   // 1-4 for a node
  const isNode = (code) => tierOf(code) >= GREY && tierOf(code) <= ORANGE;
  const isFlipped = (code) => (code & FLIP) !== 0;
  const isTarget = (code) => isNode(code) && (tierOf(code) !== GREY) !== isFlipped(code);

  // Letters for flipped nodes in the text format: a wanted grey, then an ignored green, blue, orange.
  const FLIPPED_CHARS = ['', 'w', 'g', 'b', 'o'];

  // The solver packs one base-9 digit per column into a Number, which stays exact up to 15 columns.
  const MAX_WIDTH = 15;
  const DEFAULT_MAX_STATES = 150000;

  // ---------------------------------------------------------------- board model

  function createBoard(w, h) {
    w = w || 15;
    h = h || 15;
    const cells = new Uint8Array(w * h);
    cells[(h >> 1) * w + (w >> 1)] = START;
    return { w, h, cells };
  }

  // Text format: one line per row. "." is empty, "S" the start, "1"-"4" a node of that cost.
  // "w" is a grey the player wants. "g", "b" and "o" are an ignored green, blue or orange.
  function parseBoard(text) {
    const lines = String(text).split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
    while (lines.length && lines[0] === '') lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) throw new Error('The layout is empty.');

    const h = lines.length;
    let w = 0;
    for (const line of lines) w = Math.max(w, line.length);
    if (w > MAX_WIDTH) {
      throw new Error('The layout is ' + w + ' columns wide. The most is ' + MAX_WIDTH + '.');
    }

    const cells = new Uint8Array(w * h);
    let start = -1;
    for (let r = 0; r < h; r++) {
      const line = lines[r];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        const where = 'Line ' + (r + 1) + ', column ' + (c + 1) + ': ';
        let code;
        if (ch === '.' || ch === ' ') code = EMPTY;
        else if (ch === 'S' || ch === 's') code = START;
        else if (ch >= '1' && ch <= '4') code = ch.charCodeAt(0) - 48;
        else {
          const tier = FLIPPED_CHARS.indexOf(ch.toLowerCase());
          if (tier < GREY) throw new Error(where + 'unexpected character "' + ch + '".');
          code = tier | FLIP;
        }
        if (code === START) {
          if (start >= 0) throw new Error(where + 'a second start tile (S). A board has exactly one.');
          start = r * w + c;
        }
        cells[r * w + c] = code;
      }
    }
    if (start < 0) throw new Error('The layout has no start tile (S).');
    return { w, h, cells };
  }

  function formatBoard(board) {
    const rows = [];
    for (let r = 0; r < board.h; r++) {
      let row = '';
      for (let c = 0; c < board.w; c++) {
        const code = board.cells[r * board.w + c];
        row += code === EMPTY ? '.' : code === START ? 'S'
          : isFlipped(code) ? FLIPPED_CHARS[tierOf(code)] : String(code);
      }
      rows.push(row);
    }
    return rows.join('\n');
  }

  // Place a layout inside a size x size board. Its start tile lands on the centre cell when the
  // layout fits that way, which is how the game's 11x11 and 13x13 boards sit in the 15x15 grid.
  function fitToGrid(board, size) {
    size = size || 15;
    if (board.w > size || board.h > size) {
      throw new Error('The layout is ' + board.w + 'x' + board.h + ', which does not fit the ' +
        size + 'x' + size + ' grid.');
    }
    const start = findStart(board);
    const centre = size >> 1;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const dr = clamp(centre - Math.floor(start / board.w), 0, size - board.h);
    const dc = clamp(centre - (start % board.w), 0, size - board.w);
    const cells = new Uint8Array(size * size);
    for (let r = 0; r < board.h; r++) {
      for (let c = 0; c < board.w; c++) {
        cells[(r + dr) * size + c + dc] = board.cells[r * board.w + c];
      }
    }
    return { w: size, h: size, cells };
  }

  function findStart(board) {
    let start = -1;
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] !== START) continue;
      if (start >= 0) throw new Error('The board has more than one start tile.');
      start = i;
    }
    if (start < 0) throw new Error('The board has no start tile.');
    return start;
  }

  // Up, down, left, right. Never diagonal.
  function neighbours(w, h, i) {
    const out = [];
    const c = i % w;
    if (i >= w) out.push(i - w);
    if (i < w * (h - 1)) out.push(i + w);
    if (c > 0) out.push(i - 1);
    if (c < w - 1) out.push(i + 1);
    return out;
  }

  // Every cell reachable from `from` through cells where `open` is truthy.
  function flood(w, h, open, from) {
    const seen = new Uint8Array(w * h);
    const stack = [from];
    seen[from] = 1;
    while (stack.length) {
      const i = stack.pop();
      for (const j of neighbours(w, h, i)) {
        if (open[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    return seen;
  }

  // Turn a board into the facts the solvers work from.
  //   node[i]      1 if the cell holds a node that can be reached from the start (start included)
  //   weight[i]    point cost of buying it (the start is free)
  //   required[i]  1 for the start and every reachable target: coloured nodes that are not
  //                ignored, and greys marked as wanted
  //   unreachable  targets cut off from the start; they are left out of the route
  //   counts       whole-board totals, for checking a layout against the game, plus how many
  //                greys are wanted and how many coloured nodes are ignored
  function analyse(board) {
    const w = board.w, h = board.h, cells = board.cells, n = w * h;
    if (w > MAX_WIDTH) throw new Error('Boards wider than ' + MAX_WIDTH + ' columns are not supported.');
    const start = findStart(board);
    const node = flood(w, h, cells, start);
    const weight = new Uint8Array(n);
    const required = new Uint8Array(n);
    const unreachable = [];
    const counts = { nodes: 0, points: 0, tiers: [0, 0, 0, 0, 0], wanted: 0, ignored: 0 };
    for (let i = 0; i < n; i++) {
      const code = cells[i];
      if (code === EMPTY) continue;
      if (code === START) { required[i] = 1; continue; }
      const tier = tierOf(code);
      counts.nodes++;
      counts.points += tier;
      counts.tiers[tier]++;
      if (isFlipped(code)) { if (tier === GREY) counts.wanted++; else counts.ignored++; }
      if (!node[i]) {
        if (isTarget(code)) unreachable.push(i);
        continue;
      }
      weight[i] = tier;
      if (isTarget(code)) required[i] = 1;
    }
    return { w, h, n, start, node, weight, required, unreachable, counts };
  }

  // ---------------------------------------------------------------- fast approximate route

  // Attach the nearest missing target by the cheapest path, repeat, then drop any optional node
  // that turned out not to be needed. Quick and usually within a few points of the best route,
  // but not guaranteed cheapest. It is the stand-in answer while the exact solver runs.
  function greedyRoute(p) {
    const w = p.w, h = p.h, n = p.n, node = p.node, weight = p.weight, required = p.required;
    const FAR = 1 << 30;
    const inTree = new Uint8Array(n);
    inTree[p.start] = 1;
    let missing = 0;
    for (let i = 0; i < n; i++) if (required[i] && i !== p.start) missing++;

    const bought = [];                 // optional nodes on the route, in the order they were added
    const dist = new Int32Array(n);
    const prev = new Int32Array(n);
    while (missing > 0) {
      // Cheapest-first search outwards from the whole tree. Stepping onto a required cell costs
      // nothing, because it has to be bought anyway. Any other node costs its points. Costs are
      // small whole numbers, so cells wait in one list per distance.
      dist.fill(FAR);
      const byDistance = [[]];
      for (let i = 0; i < n; i++) if (inTree[i]) { dist[i] = 0; byDistance[0].push(i); }
      let found = -1;
      for (let d = 0; d < byDistance.length && found < 0; d++) {
        const level = byDistance[d];
        if (!level) continue;
        for (let q = 0; q < level.length; q++) {   // `level` grows while it is scanned
          const u = level[q];
          if (dist[u] !== d) continue;             // reached more cheaply since it was queued
          if (required[u] && !inTree[u]) { found = u; break; }
          for (const v of neighbours(w, h, u)) {
            if (!node[v]) continue;
            const nd = d + (required[v] ? 0 : weight[v]);
            if (nd >= dist[v]) continue;
            dist[v] = nd;
            prev[v] = u;
            (byDistance[nd] || (byDistance[nd] = [])).push(v);
          }
        }
      }
      if (found < 0) throw new Error('A required cell could not be reached.');
      for (let x = found; !inTree[x]; x = prev[x]) {
        inTree[x] = 1;
        if (required[x]) missing--; else bought.push(x);
      }
    }

    // A later path can make an earlier optional node redundant.
    for (let k = bought.length - 1; k >= 0; k--) {
      const g = bought[k];
      inTree[g] = 0;
      const seen = flood(w, h, inTree, p.start);
      let connected = true;
      for (let i = 0; i < n; i++) if (required[i] && !seen[i]) { connected = false; break; }
      if (!connected) inTree[g] = 1;
    }

    let cost = 0, extras = 0;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      cost += weight[i];
      if (!required[i]) extras++;
    }
    // With no optional node bought, every cell on the route is mandatory, so nothing cheaper exists.
    return { status: extras === 0 ? 'optimal' : 'unproven', cost, extras, chosen: inTree, unreachable: p.unreachable };
  }

  function greedy(board) {
    return greedyRoute(analyse(board));
  }

  // ---------------------------------------------------------------- exact solver

  // Finds the cheapest connected set of nodes holding the start and every reachable target.
  // Everything else is optional: a grey costs 1 to pass through and an ignored node its own cost.
  //
  // Cells are visited in reading order. A state remembers, for each column, the most recently
  // visited cell in that column: either "not bought" (0) or the number of the connected group
  // it belongs to. That frontier is all the future needs to know about the past, because a cell
  // above it can never gain another neighbour. States with the same frontier keep only the
  // cheapest. Each state also carries a bitset of the cells it bought, which becomes the route.
  //
  // Written as a generator so the page can run it in short slices. Each `yield` reports progress
  // and hands back the greedy route as a provisional answer. The return value is the result:
  //   { status: 'optimal' | 'unproven', cost, extras, chosen, unreachable }
  // where `extras` counts the optional nodes the route buys.
  function* solveSteps(board, options) {
    const maxStates = (options && options.maxStates) || DEFAULT_MAX_STATES;
    const p = analyse(board);
    const fallback = greedyRoute(p);
    if (fallback.status === 'optimal') return fallback;

    const w = p.w, n = p.n, node = p.node, weight = p.weight, required = p.required;
    let lastRequired = 0;
    for (let i = 0; i < n; i++) if (required[i]) lastRequired = i;

    const FRESH = 9;                 // placeholder for a brand new group; renumber() replaces it
    const pow = [1];
    for (let j = 1; j < w; j++) pow.push(pow[j - 1] * 9);
    const remap = new Uint8Array(10);
    let key = 0;                     // set by renumber()

    // Number the groups 1, 2, 3... in order of first appearance, so the same frontier always
    // gets the same key. Returns how many groups there are and leaves the key in `key`.
    function renumber(buf) {
      remap.fill(0);
      let groups = 0;
      key = 0;
      for (let j = 0; j < w; j++) {
        const g = buf[j];
        if (g === 0) continue;
        let m = remap[g];
        if (m === 0) m = remap[g] = ++groups;
        buf[j] = m;
        key += m * pow[j];
      }
      if (groups > 8) throw new Error('More connected groups than the state key can hold.');
      return groups;
    }

    let best = null;                 // cheapest complete route found so far

    function keep(next, k, buf, cost) {
      if (best !== null && cost >= best.cost) return;
      const held = next.get(k);
      if (held === undefined) next.set(k, { buf, cost });
      else if (cost < held.cost) { held.buf = buf; held.cost = cost; }
    }

    function decode(route, status) {
      const chosen = new Uint8Array(n);
      let extras = 0;
      for (let i = 0; i < n; i++) {
        if (((route.buf[w + (i >> 3)] >> (i & 7)) & 1) === 0) continue;
        chosen[i] = 1;
        if (!required[i]) extras++;
      }
      return { status, cost: route.cost, extras, chosen, unreachable: p.unreachable };
    }

    // A state buffer is w group slots followed by the bitset of bought cells.
    let layer = new Map([[0, { buf: new Uint8Array(w + ((n + 7) >> 3)), cost: 0 }]]);

    for (let i = 0; i < n; i++) {
      const c = i % w;
      const canBuy = node[i] === 1;
      const mustBuy = required[i] === 1;
      const next = new Map();

      for (const [stateKey, state] of layer) {
        const slots = state.buf;
        const up = slots[c];
        const left = c > 0 ? slots[c - 1] : 0;   // column 0 has no left neighbour

        if (canBuy) {
          const buf = slots.slice();
          if (up !== 0 && left !== 0 && up !== left) {
            for (let j = 0; j < w; j++) if (buf[j] === up) buf[j] = left;   // the two groups become one
          }
          buf[c] = left !== 0 ? left : up !== 0 ? up : FRESH;
          buf[w + (i >> 3)] |= 1 << (i & 7);
          const groups = renumber(buf);
          const cost = state.cost + weight[i];
          if (i >= lastRequired && groups === 1) {
            // Every required cell is bought and everything bought is one group: a complete route.
            // Carrying it further could only add cost.
            if (best === null || cost < best.cost) best = { buf, cost };
          } else {
            keep(next, key, buf, cost);
          }
        }

        if (!mustBuy) {
          if (up === 0) {
            keep(next, stateKey, slots, state.cost);        // frontier unchanged
          } else {
            let shared = false;
            for (let j = 0; j < w; j++) if (j !== c && slots[j] === up) { shared = true; break; }
            // If the cell above was the last frontier cell of its group, that group can never
            // be joined to anything again, so the state is a dead end and is dropped.
            if (shared) {
              const buf = slots.slice();
              buf[c] = 0;
              renumber(buf);
              keep(next, key, buf, state.cost);
            }
          }
        }
      }

      layer = next;
      if (layer.size === 0) break;
      if (layer.size > maxStates) {
        // Too many possibilities to finish. Hand back the best route known, without the guarantee.
        if (best !== null && best.cost < fallback.cost) return decode(best, 'unproven');
        return fallback;
      }
      yield { cell: i + 1, cells: n, states: layer.size, provisional: fallback };
    }

    // Unreachable in practice: buying every reachable node is always a complete route.
    if (best === null) return fallback;
    return decode(best, 'optimal');
  }

  function solve(board, options) {
    const steps = solveSteps(board, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  // Independent check of a route: only reachable nodes, holds the start and every reachable
  // target, all in one piece. Returns { ok: true, cost } or { ok: false, reason }.
  function verify(board, chosen) {
    const p = analyse(board);
    if (!chosen || chosen.length !== p.n) return { ok: false, reason: 'the route is the wrong size' };
    let cost = 0;
    for (let i = 0; i < p.n; i++) {
      if (chosen[i] && !p.node[i]) return { ok: false, reason: 'cell ' + i + ' is not a reachable node' };
      if (p.required[i] && !chosen[i]) return { ok: false, reason: 'required cell ' + i + ' is missing' };
      if (chosen[i]) cost += p.weight[i];
    }
    const seen = flood(p.w, p.h, chosen, p.start);
    for (let i = 0; i < p.n; i++) {
      if (chosen[i] && !seen[i]) return { ok: false, reason: 'cell ' + i + ' is not connected to the start' };
    }
    return { ok: true, cost };
  }

  // What a route buys, in the terms the page reports: greys bought and skipped, and how many
  // ignored nodes it still passes through because going round them would cost more.
  function routeBreakdown(board, chosen) {
    const out = { greysBought: 0, greysSkipped: 0, ignoredBought: 0, ignoredPoints: 0 };
    for (let i = 0; i < board.cells.length; i++) {
      const code = board.cells[i];
      if (!isNode(code)) continue;
      const tier = tierOf(code);
      if (tier === GREY) {
        if (chosen[i]) out.greysBought++; else out.greysSkipped++;
      } else if (isFlipped(code) && chosen[i]) {
        out.ignoredBought++;
        out.ignoredPoints += tier;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- comparing layouts

  // How far two boards of the same size agree. `same` counts cells where both hold a node of the
  // same colour, `differ` counts cells where the colours differ or only one board has a node, and
  // `nodes` is the larger of the two node counts. Marks and the start tile are left out, so
  // wanting a grey or ignoring a node is not a change of layout.
  function compareLayouts(a, b) {
    if (a.w !== b.w || a.h !== b.h) throw new Error('Only boards of the same size can be compared.');
    let same = 0, differ = 0, nodesA = 0, nodesB = 0;
    for (let i = 0; i < a.cells.length; i++) {
      const x = isNode(a.cells[i]), y = isNode(b.cells[i]);
      if (x) nodesA++;
      if (y) nodesB++;
      if (x && y && tierOf(a.cells[i]) === tierOf(b.cells[i])) same++;
      else if (x || y) differ++;
    }
    return { same, differ, nodes: Math.max(nodesA, nodesB) };
  }

  // Which of `candidates` the board is a copy of, perhaps with a few changes: the index of the
  // candidate of the same size that agrees with it on the largest share of nodes, as long as that
  // share is at least `least`, and otherwise -1. Ties go to the earlier candidate. The game's
  // boards agree with each other on at most 59% of their nodes, so the default of 80% allows for
  // a handful of painting slips without mistaking one board for another.
  function matchLayout(board, candidates, least) {
    least = least || 0.8;
    let best = -1, bestShare = 0;
    for (let k = 0; k < candidates.length; k++) {
      const other = candidates[k];
      if (other.w !== board.w || other.h !== board.h) continue;
      const c = compareLayouts(board, other);
      const share = c.nodes ? c.same / c.nodes : 0;
      if (share >= least && share > bestShare) { best = k; bestShare = share; }
    }
    return best;
  }

  const api = {
    EMPTY, GREY, GREEN, BLUE, ORANGE, START, FLIP, MAX_WIDTH,
    tierOf, isNode, isFlipped, isTarget,
    createBoard, parseBoard, formatBoard, fitToGrid,
    analyse, greedy, solveSteps, solve, verify, routeBreakdown,
    compareLayouts, matchLayout,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
