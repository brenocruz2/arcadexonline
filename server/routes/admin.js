import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { sb, cfg, configured, requireRole, audit, getSettings, DEFAULT_SETTINGS, invalidateUserCache, logError } from '../lib/core.js';
import { snapshot, endSession, kickUser, disconnectUser } from '../lib/realtime.js';

const r = Router();
const adminOnly = requireRole('admin');
const staff = requireRole('admin', 'moderator');
r.use((_q, res, next) => configured ? next() : res.status(503).json({ error: 'Supabase não configurado' }));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { logError('admin', e, { path: req.path }); res.status(500).json({ error: 'Erro interno' }); });
const parse = (schema, body, res) => { const p = schema.safeParse(body); if (!p.success) { res.status(400).json({ error: 'Dados inválidos', details: p.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }); return null; } return p.data; };
const uuid = z.string().uuid();

r.get('/me', staff, wrap(async (req, res) => { await audit(req.user.id, 'admin.session', null, null, req.ip); res.json({ id: req.user.id, name: req.user.profile.display_name, role: req.user.profile.role }); }));

// ---------- Dashboard ----------
r.get('/dashboard', staff, wrap(async (_q, res) => {
  const c = async (t, f) => { let q = sb.from(t).select('*', { count: 'exact', head: true }); if (f) q = f(q); return (await q).count ?? 0; };
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [users, games, sessionsTotal, banned, openReports] = await Promise.all([c('profiles'), c('games'), c('game_sessions'), c('profiles', q => q.eq('banned', true)), c('reports', q => q.eq('status', 'open'))]);
  const { data: recent } = await sb.from('game_sessions').select('created_at,game_id').gte('created_at', since);
  const perDay = {}; const perGame = {};
  for (const s of recent || []) { const d = s.created_at.slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; perGame[s.game_id] = (perGame[s.game_id] || 0) + 1; }
  const { data: gm } = await sb.from('games').select('id,title,play_count').order('play_count', { ascending: false }).limit(5);
  const rt = snapshot();
  res.json({ users, games, sessionsTotal, banned, openReports, online: rt.online, connections: rt.connections, runningMatches: rt.matches, openRooms: rt.rooms.length, perDay, topGames: gm });
}));

// ---------- Jogos ----------
const gameSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/), title: z.string().min(1).max(80), platform: z.string().min(1).max(40),
  category: z.string().min(1).max(40), year: z.number().int().min(1970).max(2100).nullable().optional(),
  description: z.string().max(1000).nullable().optional(), cover_url: z.string().max(500).nullable().optional(),
  status: z.enum(['draft', 'published', 'disabled']), max_players: z.number().int().min(1).max(4),
  is_featured: z.boolean().optional(), emulator_core: z.string().regex(/^[a-z0-9_]{2,30}$/),
  emulator_files: z.record(z.string().max(200)).optional(), sort_order: z.number().int().optional(),
});
r.get('/games', adminOnly, wrap(async (_q, res) => { const { data } = await sb.from('games').select('*').order('sort_order').order('title'); res.json(data); }));
r.post('/games', adminOnly, wrap(async (req, res) => {
  const d = parse(gameSchema, req.body, res); if (!d) return;
  const { data, error } = await sb.from('games').insert(d).select().single();
  if (error) return res.status(400).json({ error: error.code === '23505' ? 'Slug já existe' : 'Erro ao salvar' });
  await audit(req.user.id, 'game.create', data.id, { title: d.title }, req.ip); res.json(data);
}));
r.put('/games/:id', adminOnly, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' });
  const d = parse(gameSchema.partial(), req.body, res); if (!d) return;
  const { data, error } = await sb.from('games').update(d).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Erro ao salvar' });
  await audit(req.user.id, 'game.update', req.params.id, d, req.ip); res.json(data);
}));
r.delete('/games/:id', adminOnly, wrap(async (req, res) => {
  const { data: g } = await sb.from('games').select('rom_path').eq('id', req.params.id).maybeSingle();
  const { count } = await sb.from('game_sessions').select('id', { count: 'exact', head: true }).eq('game_id', req.params.id).in('status', ['waiting', 'starting', 'running']);
  if (count) return res.status(409).json({ error: 'Há partidas ativas neste jogo. Encerre-as antes.' });
  const { error } = await sb.from('games').delete().eq('id', req.params.id);
  if (error) return res.status(409).json({ error: 'Jogo possui histórico de sessões; desative-o em vez de excluir.' });
  if (g?.rom_path) fs.rmSync(path.join(cfg.romDir, path.basename(g.rom_path)), { force: true });
  await audit(req.user.id, 'game.delete', req.params.id, null, req.ip); res.json({ ok: true });
}));
r.post('/games/reorder', adminOnly, wrap(async (req, res) => {
  const d = parse(z.object({ ids: z.array(uuid).max(500) }), req.body, res); if (!d) return;
  await Promise.all(d.ids.map((id, i) => sb.from('games').update({ sort_order: i }).eq('id', id)));
  await audit(req.user.id, 'game.reorder', null, { count: d.ids.length }, req.ip); res.json({ ok: true });
}));

const uploadTo = (dir, exts, maxMb) => multer({
  storage: multer.diskStorage({ destination: dir, filename: (_q, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: maxMb * 1048576, files: 1 },
  fileFilter: (_q, f, cb) => exts.includes(path.extname(f.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Tipo de arquivo não permitido')),
}).single('file');
const runUpload = (mw) => (req, res, next) => mw(req, res, e => e ? res.status(400).json({ error: e.message }) : req.file ? next() : res.status(400).json({ error: 'Arquivo ausente' }));
const coverUp = runUpload(uploadTo(path.join(cfg.uploadDir, 'covers'), ['.png', '.jpg', '.jpeg', '.webp'], 3));
const romUp = runUpload(uploadTo(cfg.romDir, ['.zip', '.7z', '.neo', '.bin', '.rom', '.chd'], 128));

r.post('/games/:id/cover', adminOnly, coverUp, wrap(async (req, res) => {
  const url = `/uploads/covers/${req.file.filename}`;
  const { error } = await sb.from('games').update({ cover_url: url }).eq('id', req.params.id);
  if (error) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Jogo inválido' }); }
  await audit(req.user.id, 'game.cover', req.params.id, { url }, req.ip); res.json({ cover_url: url });
}));
r.post('/games/:id/rom', adminOnly, romUp, wrap(async (req, res) => {
  const { data: old } = await sb.from('games').select('rom_path').eq('id', req.params.id).maybeSingle();
  const { error } = await sb.from('games').update({ rom_path: req.file.filename }).eq('id', req.params.id);
  if (error) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Jogo inválido' }); }
  if (old?.rom_path) fs.rmSync(path.join(cfg.romDir, path.basename(old.rom_path)), { force: true });
  await audit(req.user.id, 'game.rom', req.params.id, { file: req.file.originalname, size: req.file.size }, req.ip); res.json({ rom_path: req.file.filename });
}));

// ---------- Usuários ----------
r.get('/users', staff, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_,()]/g, ''); const page = Math.max(0, Number(req.query.page) || 0);
  let qb = sb.from('profiles').select('id,display_name,avatar_url,role,banned,banned_reason,online,last_seen,created_at', { count: 'exact' }).order('created_at', { ascending: false }).range(page * 25, page * 25 + 24);
  if (q) qb = qb.ilike('display_name', `%${q}%`);
  const { data, count } = await qb; res.json({ users: data, total: count });
}));
r.get('/users/:id', staff, wrap(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'ID inválido' });
  const [{ data: profile }, { data: access }, { data: matches }, { data: reports }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', req.params.id).single(),
    sb.from('access_logs').select('event,ip,user_agent,created_at').eq('user_id', req.params.id).order('created_at', { ascending: false }).limit(30),
    sb.from('session_members').select('player_slot,game_sessions(id,status,started_at,ended_at,end_reason,games(title))').eq('user_id', req.params.id).limit(30),
    sb.from('reports').select('id,reason,status,created_at').eq('reported_user', req.params.id).order('created_at', { ascending: false }).limit(20),
  ]);
  const { data: au } = await sb.auth.admin.getUserById(req.params.id);
  res.json({ profile, email: au?.user?.email, access, matches, reports });
}));
r.post('/users/:id/ban', staff, wrap(async (req, res) => {
  const d = parse(z.object({ banned: z.boolean(), reason: z.string().max(300).optional() }), req.body, res); if (!d) return;
  const { data: t } = await sb.from('profiles').select('role').eq('id', req.params.id).single();
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode bloquear a si mesmo' });
  if (t?.role === 'admin' && req.user.profile.role !== 'admin') return res.status(403).json({ error: 'Somente admin bloqueia admin' });
  await sb.from('profiles').update({ banned: d.banned, banned_reason: d.banned ? d.reason ?? null : null }).eq('id', req.params.id);
  invalidateUserCache(); if (d.banned) { kickUser(req.params.id); disconnectUser(req.params.id); }
  await audit(req.user.id, d.banned ? 'user.ban' : 'user.unban', req.params.id, d, req.ip); res.json({ ok: true });
}));
r.post('/users/:id/role', adminOnly, wrap(async (req, res) => {
  const d = parse(z.object({ role: z.enum(['user', 'moderator', 'admin']) }), req.body, res); if (!d) return;
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode alterar sua própria permissão' });
  await sb.from('profiles').update({ role: d.role }).eq('id', req.params.id); invalidateUserCache();
  await audit(req.user.id, 'user.role', req.params.id, d, req.ip); res.json({ ok: true });
}));
r.delete('/users/:id', adminOnly, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
  kickUser(req.params.id); disconnectUser(req.params.id);
  const { error } = await sb.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(400).json({ error: 'Falha ao remover conta' });
  invalidateUserCache(); await audit(req.user.id, 'user.delete', req.params.id, null, req.ip); res.json({ ok: true });
}));

// ---------- Denúncias ----------
r.get('/reports', staff, wrap(async (_q, res) => {
  const { data } = await sb.from('reports').select('id,reason,status,created_at,reporter,reported_user').order('created_at', { ascending: false }).limit(100);
  const ids = [...new Set((data || []).flatMap(x => [x.reporter, x.reported_user]))];
  const { data: ps } = ids.length ? await sb.from('profiles').select('id,display_name').in('id', ids) : { data: [] };
  const n = Object.fromEntries((ps || []).map(p => [p.id, p.display_name]));
  res.json((data || []).map(x => ({ ...x, reporter_name: n[x.reporter], reported_name: n[x.reported_user] })));
}));
r.post('/reports/:id/close', staff, wrap(async (req, res) => { await sb.from('reports').update({ status: 'closed' }).eq('id', req.params.id); await audit(req.user.id, 'report.close', req.params.id, null, req.ip); res.json({ ok: true }); }));

// ---------- Salas e partidas (tempo real) ----------
r.get('/rooms', staff, wrap(async (_q, res) => res.json(snapshot())));
r.post('/sessions/:id/end', staff, wrap(async (req, res) => { const ok = await endSession(req.params.id, 'ended_by_admin'); await audit(req.user.id, 'session.end', req.params.id, { found: ok }, req.ip); res.json({ ok }); }));
r.post('/rooms/kick', staff, wrap(async (req, res) => {
  const d = parse(z.object({ userId: uuid, gameId: uuid.optional() }), req.body, res); if (!d) return;
  kickUser(d.userId, d.gameId); await audit(req.user.id, 'room.kick', d.userId, d, req.ip); res.json({ ok: true });
}));

// ---------- Logs ----------
r.get('/errors', staff, wrap(async (_q, res) => { const { data } = await sb.from('error_logs').select('*').order('created_at', { ascending: false }).limit(100); res.json(data); }));
r.get('/audit', adminOnly, wrap(async (_q, res) => { const { data } = await sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200); res.json(data); }));

// ---------- Configurações ----------
const settingsSchema = z.object({
  platform_name: z.string().min(1).max(60), logo_url: z.string().max(500), announcement: z.string().max(300), maintenance: z.boolean(),
  maintenance_message: z.string().max(300), max_online_users: z.number().int().min(1).max(5000), max_concurrent_sessions: z.number().int().min(1).max(1000),
  max_spectators_per_session: z.number().int().min(0).max(500), challenge_ttl_seconds: z.number().int().min(10).max(300),
  reconnect_grace_seconds: z.number().int().min(5).max(300), max_session_minutes: z.number().int().min(5).max(720),
}).partial();
r.get('/settings', adminOnly, wrap(async (_q, res) => res.json(await getSettings(true))));
r.put('/settings', adminOnly, wrap(async (req, res) => {
  const d = parse(settingsSchema, req.body, res); if (!d) return;
  const rows = Object.entries(d).filter(([k]) => k in DEFAULT_SETTINGS).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (rows.length) await sb.from('settings').upsert(rows);
  await getSettings(true); await audit(req.user.id, 'settings.update', null, d, req.ip); res.json({ ok: true });
}));
r.post('/logo', adminOnly, coverUp, wrap(async (req, res) => {
  const url = `/uploads/covers/${req.file.filename}`;
  await sb.from('settings').upsert({ key: 'logo_url', value: url }); await getSettings(true);
  await audit(req.user.id, 'settings.logo', null, { url }, req.ip); res.json({ logo_url: url });
}));
r.get('/system', adminOnly, wrap(async (_q, res) => res.json({
  node: process.version, uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576), loadAvg: os.loadavg(), cpus: os.cpus().length,
  env: cfg.env, supabaseHost: new URL(cfg.supabaseUrl).host, romDir: cfg.romDir, maxConnections: cfg.maxConnections, origins: cfg.origins,
})));
export default r;
