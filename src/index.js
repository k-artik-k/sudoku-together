import { DurableObject } from 'cloudflare:workers';
import { solve, CLUES } from '../public/sudoku.js';

// Static files come from ./public (assets). Only /ws reaches this Worker.
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const code = (u.searchParams.get('room') || '').toUpperCase();
    if (u.pathname === '/ws' && req.headers.get('Upgrade') === 'websocket' && /^[A-Z]{4}$/.test(code))
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);   // one Durable Object per room code
    return new Response('Not found', { status: 404 });
  },
};

const DAY = 864e5;
const okPuzzle = p => Array.isArray(p) && p.length === 81 && p.every(v => Number.isInteger(v) && v >= 0 && v <= 9);
const solved = p => { if (!okPuzzle(p)) return null; const s = p.slice(); return solve(s, 1, false) === 1 ? s : null; };
const fresh = (diff, puzzle, solution) => ({ puzzle, solution, values: puzzle.slice(), owners: Array(81).fill(-1), diff, gid: crypto.randomUUID(), t0: Date.now(), done: 0 });

export class Room extends DurableObject {
  socks = new Map();   // player id -> live websocket
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.r = (await ctx.storage.get('r')) || null; });
  }
  fetch(req) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.attach(server, new URL(req.url).searchParams.get('room').toUpperCase());
    return new Response(null, { status: 101, webSocket: client });
  }
  save() { this.ctx.storage.put('r', this.r); this.ctx.storage.setAlarm(Date.now() + DAY); }
  async alarm() {   // idle cleanup: drop rooms nobody is in for a day
    if (this.socks.size) return this.ctx.storage.setAlarm(Date.now() + DAY);
    this.r = null; await this.ctx.storage.deleteAll();
  }
  snap(you) {
    const r = this.r;
    return JSON.stringify({
      t: 's', you, code: r.code, max: r.max, diff: r.diff, gid: r.gid, puzzle: r.puzzle, values: r.values, owners: r.owners,
      wrong: r.values.map((v, i) => v && !r.puzzle[i] && v !== r.solution[i] ? i : -1).filter(i => i >= 0),
      players: r.players.map(p => ({ slot: p.slot, name: p.name, on: this.socks.has(p.id), sel: p.sel })),
      t0: r.t0, done: r.done, now: Date.now(),
    });
  }
  bc() { for (const p of this.r.players) { const w = this.socks.get(p.id); if (w) try { w.send(this.snap(p.slot)); } catch {} } }

  attach(ws, code) {
    let me = null;
    const say = o => ws.send(JSON.stringify(o));
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      let r = this.r;
      if (m.t === 'ping') return say({ t: 'p' });

      if (m.t === 'create') {
        if (r) return say({ t: 'e', m: 'taken', taken: 1 });   // code collision: client retries with a new one
        const sol = solved(m.puzzle);
        if (!sol) return say({ t: 'e', m: 'Bad puzzle' });
        r = this.r = { ...fresh(CLUES[m.diff] ? m.diff : 'easy', m.puzzle, sol), code, max: [2, 3, 4].includes(+m.max) ? +m.max : 4, players: [] };
        m.t = 'join';
      }
      if (m.t === 'join') {
        if (!r) return say({ t: 'e', m: 'Room not found', gone: 1 });
        r.players = r.players.filter(p => this.socks.has(p.id) || Date.now() - (p.seen || 0) < 6e5);   // free seats offline 10+ min
        me = r.players.find(p => p.id === m.pid);
        if (!me) {
          if (r.players.length >= r.max) return say({ t: 'e', m: 'Room is full' });
          const slot = [0, 1, 2, 3].find(s => !r.players.some(p => p.slot === s));
          const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 18) || 'Player ' + (slot + 1);
          me = { id: crypto.randomUUID(), slot, name, sel: -1 };
          r.players.push(me);
        }
        const old = this.socks.get(me.id); if (old && old !== ws) try { old.close(); } catch {}
        this.socks.set(me.id, ws);
        say({ t: 'j', pid: me.id, code: r.code, name: me.name });
        this.save(); return this.bc();
      }

      if (!r || !me) return;
      const c = m.c | 0, ok = c >= 0 && c < 81;
      if (m.t === 'sel') { me.sel = ok ? c : -1; return this.bc(); }
      else if (m.t === 'set' && ok && !r.puzzle[c] && !r.done) {
        const v = m.v | 0; if (v < 0 || v > 9) return;
        r.values[c] = v; r.owners[c] = v ? me.slot : -1;
      } else if (m.t === 'hint' && !r.done) {
        const open = r.values.map((v, i) => !r.puzzle[i] && v !== r.solution[i] ? i : -1).filter(i => i >= 0);
        if (!open.length) return;
        const t = open.includes(c) ? c : open[Math.random() * open.length | 0];
        r.values[t] = r.solution[t]; r.owners[t] = me.slot;
      } else if (m.t === 'new') {
        const sol = solved(m.puzzle);
        if (!sol) return say({ t: 'e', m: 'Bad puzzle' });
        Object.assign(r, fresh(CLUES[m.diff] ? m.diff : r.diff, m.puzzle, sol));
      } else if (m.t === 'leave') {
        r.players = r.players.filter(p => p !== me); this.socks.delete(me.id); me = null;
        if (!r.players.length) { this.r = null; this.ctx.storage.deleteAll(); return; }
        this.save(); return this.bc();
      } else return;
      if (!r.done && r.values.every((v, i) => v === r.solution[i])) r.done = Date.now();
      this.save(); this.bc();
    });
    ws.addEventListener('close', () => {
      if (me && this.socks.get(me.id) === ws) { this.socks.delete(me.id); me.seen = Date.now(); this.save(); this.bc(); }
    });
    ws.addEventListener('error', () => {});
  }
}
