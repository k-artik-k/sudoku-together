// Shared by the browser (puzzle generation) and the Worker (solving/validation).
export const CLUES = { easy: 40, medium: 33, hard: 28, expert: 24 };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bx = i => (i / 27 | 0) * 3 + (i % 9 / 3 | 0);

// Counts solutions up to `limit`. When it stops at `limit`, g holds that solution.
export function solve(g, limit, rnd) {
  const R = Array(9).fill(0), C = Array(9).fill(0), B = Array(9).fill(0);
  g.forEach((v, i) => { if (v) { const b = 1 << v; R[i / 9 | 0] |= b; C[i % 9] |= b; B[bx(i)] |= b; } });
  let n = 0;
  (function rec() {
    let bi = -1, bm = 0, bc = 10;
    for (let i = 0; i < 81; i++) if (!g[i]) {
      const m = ~(R[i / 9 | 0] | C[i % 9] | B[bx(i)]) & 0x3fe;
      let c = 0; for (let x = m; x; x &= x - 1) c++;
      if (c < bc) { bc = c; bi = i; bm = m; if (c < 2) break; }
    }
    if (bi < 0) { n++; return n >= limit; }
    const vs = []; for (let v = 1; v < 10; v++) if (bm >> v & 1) vs.push(v);
    if (rnd) shuffle(vs);
    const r = bi / 9 | 0, c = bi % 9, x = bx(bi);
    for (const v of vs) {
      const b = 1 << v; g[bi] = v; R[r] |= b; C[c] |= b; B[x] |= b;
      if (rec()) return true;
      g[bi] = 0; R[r] &= ~b; C[c] &= ~b; B[x] &= ~b;
    }
    return false;
  })();
  return n;
}

export function generate(diff) {
  const sol = Array(81).fill(0);
  shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).forEach((v, i) => sol[i] = v);
  solve(sol, 1, true);
  const p = sol.slice(); let clues = 81;
  for (const i of shuffle([...Array(41).keys()])) {   // remove cells in 180-degree symmetric pairs
    if (clues <= CLUES[diff]) break;
    const j = 80 - i, a = p[i], b = p[j];
    p[i] = p[j] = 0;
    if (solve(p.slice(), 2) === 1) clues -= i === j ? 1 : 2; else { p[i] = a; p[j] = b; }
  }
  return { puzzle: p, solution: sol };
}
