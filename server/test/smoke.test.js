// Teste de integração: servidor real + Socket.IO real + banco em memória (test/fakeSb.js).
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const PORT = 18080, base = `http://localhost:${PORT}`;
const GAME = '10000000-0000-4000-8000-000000000001';
const id = n => `00000000-0000-4000-8000-00000000000${n}`;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✔', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = async (p, tk, opt = {}) => { const r = await fetch(base + p, { ...opt, headers: { ...(tk ? { Authorization: 'Bearer ' + tk } : {}), 'Content-Type': 'application/json' } }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const run = env => spawn('node', ['index.js'], { env: { ...process.env, PORT, NODE_ENV: 'test', ...env }, stdio: 'inherit' });
const sock = tk => new Promise((res, rej) => { const s = io(base, { auth: { token: tk }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', e => rej(new Error(e.message))); });
const ask = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const once = (s, ev) => new Promise(r => s.once(ev, r));

let srv = run({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' }); await sleep(1500);
console.log('\n[1] Sem Supabase configurado');
ok((await J('/health')).j.supabase === 'missing-env', '/health responde');
ok((await J('/api/admin/me')).s === 503, '/api/admin não expõe dados sem configuração');
ok((await fetch(base + '/admin/')).status === 200, '/admin servido em rota própria');
ok(!(await (await fetch(base + '/')).text()).toLowerCase().includes('admin'), 'HTML público não contém link/menu administrativo');
srv.kill(); await sleep(400);

srv = run({ ARCADEX_TEST_SB: new URL('./fakeSb.js', import.meta.url).href, SUPABASE_URL: 'http://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' }); await sleep(1500);
try {
  console.log('\n[2] Autorização no servidor (admin)');
  ok((await J('/api/admin/dashboard')).s === 401, 'admin sem token => 401');
  ok((await J('/api/admin/dashboard', 'tk-alice')).s === 403, 'usuário comum => 403');
  ok((await J('/api/admin/games', 'tk-mod')).s === 403, 'moderador não gerencia jogos => 403');
  ok((await J('/api/admin/dashboard', 'tk-root')).s === 200, 'admin acessa dashboard');
  ok((await J('/api/admin/dashboard', 'tk-evil')).s === 401, 'usuário bloqueado => 401');
  ok((await J('/api/admin/users', 'tk-mod')).s === 200, 'moderador lista usuários');
  const bad = await J('/api/admin/games', 'tk-root', { method: 'POST', body: JSON.stringify({ title: '' }) });
  ok(bad.s === 400, 'validação rejeita jogo inválido');
  const g = await J('/api/admin/games', 'tk-root', { method: 'POST', body: JSON.stringify({ slug: 'sf2', title: 'SF2', platform: 'CPS2', category: 'Luta', status: 'published', max_players: 2, emulator_core: 'fbneo' }) });
  ok(g.s === 200 && g.j.id, 'admin cadastra jogo');
  ok((await J('/api/v1/games')).j.length === 2, 'catálogo público lista jogos publicados');
  ok((await J(`/api/admin/games/${g.j.id}`, 'tk-root', { method: 'PUT', body: JSON.stringify({ status: 'disabled' }) })).s === 200, 'admin desativa jogo');
  ok((await J('/api/v1/games')).j.length === 1, 'jogo desativado some do catálogo');
  ok((await J('/api/admin/audit', 'tk-root')).j.some(a => a.action === 'game.create'), 'ação administrativa auditada');
  ok((await J(`/api/admin/users/${id(4)}/role`, 'tk-root', { method: 'POST', body: JSON.stringify({ role: 'user' }) })).s === 400, 'admin não altera a própria permissão');
  ok((await J('/api/v1/sessions/x/rom')).s === 401, 'ROM exige autenticação');

  console.log('\n[3] Tempo real: salas e desafios');
  await sock('tk-evil').then(() => ok(false, 'banido conectou'), e => ok(e.message === 'unauthorized', 'socket rejeita usuário bloqueado'));
  const A = await sock('tk-alice'), B = await sock('tk-bob'), Cc = await sock('tk-carol');
  ok(!(await ask(A, 'room:join', { gameId: 'x', role: 'player' })).ok, 'room:join valida parâmetros');
  const rj = await ask(A, 'room:join', { gameId: GAME, role: 'player' }); ok(rj.ok && rj.state.players.length === 1, 'alice entra na sala como jogadora');
  const st = once(A, 'room:state'); await ask(B, 'room:join', { gameId: GAME, role: 'player' }); ok((await st).players.length === 2, 'sala atualiza em tempo real para quem já está nela');
  await ask(Cc, 'room:join', { gameId: GAME, role: 'spectator' });
  const s2 = await ask(A, 'room:join', { gameId: GAME, role: 'player' }); ok(s2.state.spectators.length === 1 && s2.state.players.length === 2, 'espectador listado separadamente');
  ok((await ask(A, 'challenge:send', { gameId: GAME, toUserId: id(1) })).error, 'não desafia a si mesmo');
  ok((await ask(Cc, 'challenge:send', { gameId: GAME, toUserId: id(2) })).error, 'espectador não pode desafiar');
  const inc = once(B, 'challenge:incoming');
  const [c1, c2] = await Promise.all([ask(A, 'challenge:send', { gameId: GAME, toUserId: id(2) }), ask(A, 'challenge:send', { gameId: GAME, toUserId: id(2) })]);
  ok([c1, c2].filter(x => x.ok).length === 1, 'desafio duplicado simultâneo: apenas um é criado');
  const ch = await inc; ok(ch.from.name === 'alice', 'bob recebe notificação do desafio');
  const start = Promise.all([once(A, 'session:start'), once(B, 'session:start')]);
  ok((await ask(B, 'challenge:respond', { challengeId: ch.id, accept: true })).ok, 'bob aceita');
  const [sa, sb2] = await start; ok(sa.sessionId === sb2.sessionId, 'sessão criada e ambos direcionados à partida');
  ok((await ask(A, 'challenge:send', { gameId: GAME, toUserId: id(2) })).error, 'jogador em partida não recebe novo desafio');
  const ja = await ask(A, 'session:join', { sessionId: sa.sessionId }); const jb = await ask(B, 'session:join', { sessionId: sa.sessionId });
  ok(ja.slot === 1 && jb.slot === 2, 'slots de jogador atribuídos pelo servidor');
  ok((await ask(Cc, 'session:join', { sessionId: sa.sessionId, role: 'player' })).error, 'não-participante não entra como jogador');
  ok((await ask(Cc, 'session:join', { sessionId: sa.sessionId, role: 'spectator' })).ok, 'espectador entra para assistir');
  const inp = once(B, 'session:input'); A.emit('session:input', { mask: 5 }); const got = await inp; ok(got.slot === 1 && got.mask === 5, 'entrada do jogador 1 chega ao outro jogador com slot do servidor');
  const rt = await J('/api/admin/rooms', 'tk-root'); ok(rt.j.sessions.length === 1 && rt.j.sessions[0].spectators === 1, 'admin vê partida e espectadores');
  const ended = once(B, 'session:ended'); ok((await J(`/api/admin/sessions/${sa.sessionId}/end`, 'tk-root', { method: 'POST' })).j.ok, 'admin encerra sessão');
  ok((await ended).reason === 'ended_by_admin', 'jogadores são notificados do encerramento');
  ok((await J('/api/admin/rooms', 'tk-root')).j.sessions.length === 0, 'recursos da sessão liberados');
  ok((await J('/health')).j.matches === 0, 'contador de partidas zerado');

  console.log('\n[4] Recusa, expiração e desconexão');
  const inc2 = once(B, 'challenge:incoming'); await ask(A, 'challenge:send', { gameId: GAME, toUserId: id(2) }); const c3 = await inc2;
  await ask(B, 'challenge:respond', { challengeId: c3.id, accept: false });
  const inc3 = once(B, 'challenge:incoming'); ok((await ask(A, 'challenge:send', { gameId: GAME, toUserId: id(2) })).ok, 'após recusar, novo desafio é permitido'); await inc3;
  B.disconnect(); await sleep(400);
  ok((await J('/api/v1/stats')).j.online === 2, 'desconexão atualiza usuários online');
  const room = await ask(A, 'room:join', { gameId: GAME, role: 'player' }); ok(room.state.players.length === 1, 'desconectado sai da sala e desafio pendente é cancelado');
  console.log(`\n${n} verificações OK`);
} catch (e) { console.error('\n✘ FALHA:', e.message); process.exitCode = 1; } finally { srv.kill(); setTimeout(() => process.exit(), 200); }
