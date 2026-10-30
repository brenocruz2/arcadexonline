// Supabase em memória (apenas para testes): implementa o subconjunto usado pelo servidor.
import crypto from 'node:crypto';
const T = { profiles: [], games: [], game_sessions: [], session_members: [], challenges: [], settings: [], error_logs: [], audit_logs: [], access_logs: [], reports: [] };
export const db = T; export const tokens = {};
// Semente fixa: tokens "tk-<nome>" => usuário
const id = n => `00000000-0000-4000-8000-00000000000${n}`;
[['alice', 1, 'user'], ['bob', 2, 'user'], ['carol', 3, 'user'], ['root', 4, 'admin'], ['evil', 5, 'user'], ['mod', 6, 'moderator']].forEach(([n, i, role]) => {
  T.profiles.push({ id: id(i), display_name: n, avatar_url: null, role, banned: n === 'evil', online: false }); tokens['tk-' + n] = id(i); });
T.games.push({ id: '10000000-0000-4000-8000-000000000001', slug: 'kof', title: 'KOF', status: 'published', max_players: 2, platform: 'Neo Geo', category: 'Luta', sort_order: 0, play_count: 0, rom_path: null });
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.ret = false; }
  select(_c, o) { if (this.op !== 'select') this.ret = true; this.head = o?.head; this.count = o?.count; return this; }
  insert(r) { this.op = 'insert'; this.row = r; return this; } update(r) { this.op = 'update'; this.row = r; return this; } upsert(r) { this.op = 'upsert'; this.row = r; return this; } delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.f.push(r => r[k] === v); return this; } neq(k, v) { this.f.push(r => r[k] !== v); return this; } in(k, v) { this.f.push(r => v.includes(r[k])); return this; }
  gte(k, v) { this.f.push(r => r[k] >= v); return this; } ilike() { return this; } order() { return this; } limit() { return this; } range() { return this; }
  single() { this.one = 'single'; return this; } maybeSingle() { this.one = 'maybe'; return this; }
  run() {
    const rows = T[this.t]; const m = () => rows.filter(r => this.f.every(f => f(r)));
    let out;
    if (this.op === 'insert') {
      const arr = (Array.isArray(this.row) ? this.row : [this.row]).map(r => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), play_count: 0, ...r }));
      if (this.t === 'challenges' && arr.some(a => rows.some(r => r.status === 'pending' && r.game_id === a.game_id && r.from_user === a.from_user && r.to_user === a.to_user))) return { data: null, error: { code: '23505' } };
      rows.push(...arr); out = arr;
    } else if (this.op === 'update') { out = m(); out.forEach(r => Object.assign(r, this.row)); }
    else if (this.op === 'upsert') { const k = this.t === 'settings' ? 'key' : 'id'; for (const n of [].concat(this.row)) { const e = rows.find(r => r[k] === n[k]); e ? Object.assign(e, n) : rows.push(n); } out = []; }
    else if (this.op === 'delete') { out = m(); T[this.t] = rows.filter(r => !out.includes(r)); }
    else out = m();
    if (this.head) return { count: out.length, data: null, error: null };
    if (this.op !== 'select' && !this.ret) return { data: null, error: null };
    if (this.one) return { data: out[0] ?? null, error: null };
    return { data: out, error: null, count: out.length };
  }
  then(a, b) { return Promise.resolve(this.run()).then(a, b); }
}
export default {
  from: t => new Q(t),
  auth: { getUser: async tk => tokens[tk] ? { data: { user: { id: tokens[tk], email: tokens[tk] + '@t.dev' } }, error: null } : { data: null, error: { message: 'bad' } },
    admin: { deleteUser: async id => { T.profiles = T.profiles.filter(p => p.id !== id); return { error: null }; }, getUserById: async id => ({ data: { user: { email: id + '@t.dev' } } }) } },
};
