import { Server } from 'socket.io';
import { sb, cfg, getSettings, userFromToken, logError } from './core.js';

const rooms = new Map();        // gameId -> { players: Map<userId,pub>, spectators: Map<userId,pub> }
const userSockets = new Map();  // userId -> Set<socketId>
const userRoom = new Map();     // userId -> { gameId, role }
const userSession = new Map();  // userId -> sessionId (partida ativa)
const sessions = new Map();     // sessionId -> { id, gameId, members:[{id,name,slot}], spectators:Set, startedAt, lostAt:Map }
const pendingIn = new Map();    // toUser -> challenge
const pendingOut = new Map();   // fromUser -> challenge
let io;
let statsTimer = null;

const pubUser = u => ({ id: u.id, name: u.profile.display_name, avatar: u.profile.avatar_url || null });
const room = gid => { if (!rooms.has(gid)) rooms.set(gid, { players: new Map(), spectators: new Map() }); return rooms.get(gid); };

function statusOf(id) {
  if (userSession.has(id)) return 'in_match';
  if (pendingIn.has(id)) return 'challenged';
  if (pendingOut.has(id)) return 'waiting';
  return 'available';
}
export function roomState(gid) {
  const r = room(gid);
  return {
    gameId: gid,
    players: [...r.players.values()].map(p => ({ ...p, status: statusOf(p.id) })),
    spectators: [...r.spectators.values()],
    matches: [...sessions.values()].filter(s => s.gameId === gid).map(s => ({ sessionId: s.id, players: s.members.map(m => m.name), spectators: s.spectators.size, startedAt: s.startedAt })),
  };
}
export function stats() {
  return {
    online: userSockets.size, matches: sessions.size,
    rooms: [...rooms.entries()].filter(([, r]) => r.players.size + r.spectators.size > 0).map(([gameId, r]) => ({ gameId, players: r.players.size, spectators: r.spectators.size })),
  };
}
const emitRoom = gid => io.to(`g:${gid}`).emit('room:state', roomState(gid));
function scheduleStats() { if (statsTimer) return; statsTimer = setTimeout(() => { statsTimer = null; io.emit('stats', stats()); }, 800); }
const toUser = (id, ev, payload) => io.to(`u:${id}`).emit(ev, payload);

export function snapshot() {
  return {
    ...stats(),
    connections: io?.engine?.clientsCount ?? 0,
    sessions: [...sessions.values()].map(s => ({ id: s.id, gameId: s.gameId, players: s.members, spectators: s.spectators.size, startedAt: s.startedAt })),
    rooms: [...rooms.entries()].filter(([, r]) => r.players.size + r.spectators.size > 0).map(([gameId, r]) => ({ gameId, players: [...r.players.values()], spectators: [...r.spectators.values()] })),
  };
}

function leaveRoom(userId) {
  const cur = userRoom.get(userId); if (!cur) return;
  const r = room(cur.gameId); r.players.delete(userId); r.spectators.delete(userId);
  userRoom.delete(userId);
  for (const sid of userSockets.get(userId) || []) io.sockets.sockets.get(sid)?.leave(`g:${cur.gameId}`);
  cancelPending(userId, 'cancelled');
  emitRoom(cur.gameId); scheduleStats();
}

async function cancelPending(userId, status) {
  for (const map of [pendingIn, pendingOut]) {
    const c = map.get(userId); if (!c) continue;
    pendingIn.delete(c.to_user); pendingOut.delete(c.from_user);
    await sb.from('challenges').update({ status, responded_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'pending');
    toUser(c.from_user, 'challenge:update', { id: c.id, status }); toUser(c.to_user, 'challenge:update', { id: c.id, status });
    if (userRoom.get(c.from_user)) emitRoom(userRoom.get(c.from_user).gameId);
  }
}

export async function endSession(id, reason = 'ended', failed = false) {
  const s = sessions.get(id);
  await sb.from('game_sessions').update({ status: failed ? 'failed' : 'ended', ended_at: new Date().toISOString(), end_reason: reason }).eq('id', id).in('status', ['waiting', 'starting', 'running']);
  io.to(`s:${id}`).emit('session:ended', { sessionId: id, reason });
  if (!s) return false;
  io.in(`s:${id}`).socketsLeave(`s:${id}`);
  for (const m of s.members) userSession.delete(m.id);
  sessions.delete(id);
  const touched = new Set([s.gameId]); touched.forEach(emitRoom); scheduleStats();
  return true;
}

export function kickUser(userId, gameId) {
  if (userSession.has(userId)) endSession(userSession.get(userId), 'kicked_by_admin');
  if (!gameId || userRoom.get(userId)?.gameId === gameId) { toUser(userId, 'kicked', { reason: 'Removido da sala por um administrador.' }); leaveRoom(userId); }
}
export function disconnectUser(userId) {
  for (const sid of userSockets.get(userId) || []) io.sockets.sockets.get(sid)?.disconnect(true);
}

export function attachRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: cfg.origins.length ? cfg.origins : false }, maxHttpBufferSize: 8e3, pingInterval: 10000, pingTimeout: 15000 });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      const st = await getSettings();
      if (st.maintenance && user.profile.role === 'user') return next(new Error('maintenance'));
      const limit = Math.min(st.max_online_users, cfg.maxConnections);
      if (!userSockets.has(user.id) && userSockets.size >= limit) return next(new Error('server_full'));
      if ((userSockets.get(user.id)?.size || 0) >= 3) return next(new Error('too_many_tabs'));
      socket.data.user = user; next();
    } catch (e) { logError('socket.auth', e); next(new Error('internal')); }
  });

  io.on('connection', socket => {
    const user = socket.data.user; const uid = user.id;
    if (!userSockets.has(uid)) { userSockets.set(uid, new Set()); sb.from('profiles').update({ online: true, last_seen: new Date().toISOString() }).eq('id', uid).then(() => {}); }
    userSockets.get(uid).add(socket.id);
    socket.join(`u:${uid}`);
    socket.emit('hello', { stats: stats(), activeSession: userSession.get(uid) || null });
    scheduleStats();

    // rate limit: 30 eventos/s (entrada de jogo tem limite próprio)
    let tokens = 30, last = Date.now(), inputCount = 0, inputWin = Date.now();
    const allow = () => { const n = Date.now(); tokens = Math.min(30, tokens + (n - last) / 1000 * 30); last = n; if (tokens < 1) return false; tokens--; return true; };
    const on = (ev, fn) => socket.on(ev, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ error: 'Muitas requisições' });
      try { reply((await fn(payload || {})) ?? { ok: true }); } catch (e) { if (e.user) reply({ error: e.message }); else { logError('socket.' + ev, e); reply({ error: 'Erro interno' }); } }
    });
    const fail = msg => { const e = new Error(msg); e.user = true; throw e; };
    const uuid = v => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) ? v : fail('Parâmetro inválido');

    on('room:join', async ({ gameId, role }) => {
      uuid(gameId); if (!['player', 'spectator'].includes(role)) fail('Papel inválido');
      const { data: game } = await sb.from('games').select('id,status,max_players').eq('id', gameId).maybeSingle();
      if (!game || game.status !== 'published') fail('Jogo indisponível');
      const cur = userRoom.get(uid);
      if (cur && (cur.gameId !== gameId)) { if (userSession.has(uid)) fail('Você está em uma partida em andamento'); leaveRoom(uid); }
      const r = room(gameId);
      if (role === 'player') { r.spectators.delete(uid); r.players.set(uid, pubUser(user)); } else { r.players.delete(uid); cancelPending(uid, 'cancelled'); r.spectators.set(uid, pubUser(user)); }
      userRoom.set(uid, { gameId, role });
      for (const sid of userSockets.get(uid)) io.sockets.sockets.get(sid)?.join(`g:${gameId}`);
      emitRoom(gameId); scheduleStats();
      return { ok: true, state: roomState(gameId) };
    });
    on('room:leave', async () => { leaveRoom(uid); });

    on('challenge:send', async ({ gameId, toUserId }) => {
      uuid(gameId); uuid(toUserId);
      const cur = userRoom.get(uid);
      if (!cur || cur.gameId !== gameId || cur.role !== 'player') fail('Entre na sala como jogador para desafiar');
      if (toUserId === uid) fail('Você não pode desafiar a si mesmo');
      if (!room(gameId).players.has(toUserId)) fail('Jogador não está mais disponível na sala');
      if (userSession.has(uid)) fail('Você já está em uma partida');
      if (userSession.has(toUserId)) fail('O jogador já está em uma partida');
      if (pendingOut.has(uid)) fail('Você já tem um desafio pendente');
      if (pendingIn.has(uid)) fail('Responda ao desafio recebido primeiro');
      if (pendingIn.has(toUserId)) fail('O jogador já recebeu outro desafio');
      if (pendingOut.has(toUserId)) fail('O jogador está aguardando resposta de outro desafio');
      const st = await getSettings();
      const row = { game_id: gameId, from_user: uid, to_user: toUserId, status: 'pending', expires_at: new Date(Date.now() + st.challenge_ttl_seconds * 1000).toISOString() };
      pendingIn.set(toUserId, row); pendingOut.set(uid, row); // reserva síncrona evita corrida entre dois cliques
      const { data, error } = await sb.from('challenges').insert(row).select().single();
      if (error) { pendingIn.delete(toUserId); pendingOut.delete(uid); fail('Desafio duplicado ou inválido'); }
      pendingIn.set(toUserId, data); pendingOut.set(uid, data);
      toUser(toUserId, 'challenge:incoming', { id: data.id, gameId, from: pubUser(user), expiresAt: data.expires_at });
      toUser(uid, 'challenge:sent', { id: data.id, gameId, to: room(gameId).players.get(toUserId), expiresAt: data.expires_at });
      emitRoom(gameId);
      return { ok: true, id: data.id };
    });
    on('challenge:cancel', async () => { await cancelPending(uid, 'cancelled'); });
    on('challenge:respond', async ({ challengeId, accept }) => {
      uuid(challengeId);
      const c = pendingIn.get(uid);
      if (!c || c.id !== challengeId) fail('Desafio não encontrado ou expirado');
      if (!accept) { await cancelPending(uid, 'declined'); return { ok: true }; }
      if (new Date(c.expires_at) < new Date()) { await cancelPending(uid, 'expired'); fail('Desafio expirado'); }
      if (userSession.has(uid) || userSession.has(c.from_user)) fail('Um dos jogadores já está em partida');
      const st = await getSettings();
      if (sessions.size >= st.max_concurrent_sessions) fail('Limite de partidas simultâneas atingido. Tente mais tarde.');
      const { data: game } = await sb.from('games').select('id,max_players,status').eq('id', c.game_id).maybeSingle();
      if (!game || game.status !== 'published') fail('Jogo indisponível');
      // transição atômica: só um aceite vence
      const { data: upd } = await sb.from('challenges').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'pending').select().maybeSingle();
      if (!upd) fail('Desafio não está mais pendente');
      pendingIn.delete(uid); pendingOut.delete(c.from_user);
      const { data: sess, error } = await sb.from('game_sessions').insert({ game_id: c.game_id, host_user_id: c.from_user, status: 'running', max_players: 2, started_at: new Date().toISOString(), challenge_id: c.id, worker_id: 'browser-local' }).select().single();
      if (error) { logError('session.create', error); fail('Falha ao criar a sessão'); }
      const members = [{ id: c.from_user, name: room(c.game_id).players.get(c.from_user)?.name, slot: 1 }, { id: uid, name: user.profile.display_name, slot: 2 }];
      await sb.from('session_members').insert(members.map(m => ({ session_id: sess.id, user_id: m.id, player_slot: m.slot })));
      await sb.from('challenges').update({ session_id: sess.id }).eq('id', c.id);
      sessions.set(sess.id, { id: sess.id, gameId: c.game_id, members, spectators: new Set(), startedAt: sess.started_at, lostAt: new Map() });
      members.forEach(m => userSession.set(m.id, sess.id));
      sb.from('games').select('play_count').eq('id', c.game_id).single().then(({ data }) => sb.from('games').update({ play_count: (data?.play_count || 0) + 1 }).eq('id', c.game_id)).then(() => {});
      members.forEach(m => toUser(m.id, 'session:start', { sessionId: sess.id, gameId: c.game_id }));
      toUser(c.from_user, 'challenge:update', { id: c.id, status: 'accepted' });
      emitRoom(c.game_id); scheduleStats();
      return { ok: true, sessionId: sess.id };
    });

    on('session:join', async ({ sessionId, role }) => {
      uuid(sessionId);
      const s = sessions.get(sessionId); if (!s) fail('Partida não encontrada ou já encerrada');
      const member = s.members.find(m => m.id === uid);
      if (member) { s.lostAt.delete(uid); socket.join(`s:${sessionId}`); socket.data.sessionId = sessionId; }
      else {
        if (role !== 'spectator') fail('Você não participa desta partida');
        const st = await getSettings();
        if (s.spectators.size >= st.max_spectators_per_session) fail('Limite de espectadores atingido');
        s.spectators.add(uid); socket.join(`s:${sessionId}`); socket.data.sessionId = sessionId;
      }
      emitRoom(s.gameId);
      io.to(`s:${sessionId}`).emit('session:state', { sessionId, members: s.members, spectators: s.spectators.size });
      return { ok: true, slot: member?.slot ?? null, members: s.members, gameId: s.gameId };
    });
    on('session:leave', async ({ sessionId }) => {
      const s = sessions.get(sessionId); if (!s) return;
      if (s.members.some(m => m.id === uid)) return endSession(sessionId, 'player_left');
      s.spectators.delete(uid); socket.leave(`s:${sessionId}`); emitRoom(s.gameId);
    });

    // Entrada de controle: relé validado (slot vem do servidor, nunca do cliente).
    socket.on('session:input', payload => {
      const n = Date.now(); if (n - inputWin > 1000) { inputWin = n; inputCount = 0; } if (++inputCount > 120) return;
      const s = sessions.get(socket.data.sessionId); const m = s?.members.find(x => x.id === uid); if (!m) return;
      if (!payload || typeof payload.mask !== 'number') return;
      socket.to(`s:${s.id}`).emit('session:input', { slot: m.slot, mask: payload.mask & 0xfff });
    });

    socket.on('disconnect', () => {
      const set = userSockets.get(uid); set?.delete(socket.id);
      const sid = socket.data.sessionId;
      if (!set || set.size === 0) {
        userSockets.delete(uid);
        sb.from('profiles').update({ online: false, last_seen: new Date().toISOString() }).eq('id', uid).then(() => {});
        const s = sessions.get(userSession.get(uid)); if (s) s.lostAt.set(uid, Date.now()); // janela de reconexão
        if (userRoom.get(uid)) leaveRoom(uid);
      }
      if (sid && sessions.get(sid)?.spectators.delete(uid)) emitRoom(sessions.get(sid).gameId);
      scheduleStats();
    });
  });

  // Recuperação de boot: nada em memória sobrevive a restart.
  sb.from('game_sessions').update({ status: 'ended', ended_at: new Date().toISOString(), end_reason: 'server_restart' }).in('status', ['waiting', 'starting', 'running']).then(() => {});
  sb.from('challenges').update({ status: 'expired' }).eq('status', 'pending').then(() => {});
  sb.from('profiles').update({ online: false }).eq('online', true).then(() => {});

  // Limpeza periódica: desafios expirados, desconexões, sessões abandonadas/longas.
  setInterval(async () => {
    try {
      const st = await getSettings(); const now = Date.now();
      for (const c of new Set([...pendingIn.values()])) if (new Date(c.expires_at).getTime() < now) await cancelPending(c.to_user, 'expired');
      for (const s of [...sessions.values()]) {
        const lost = [...s.lostAt.values()].some(t => now - t > st.reconnect_grace_seconds * 1000);
        if (lost) await endSession(s.id, 'disconnect');
        else if (now - new Date(s.startedAt).getTime() > st.max_session_minutes * 60000) await endSession(s.id, 'timeout');
      }
    } catch (e) { logError('cleanup', e); }
  }, 5000).unref();
  return io;
}
