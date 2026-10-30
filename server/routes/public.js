import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { sb, cfg, configured, getSettings, requireUser, accessLog } from '../lib/core.js';
import { stats } from '../lib/realtime.js';

const r = Router();
const needDb = (_q, res, next) => configured ? next() : res.status(503).json({ error: 'Servidor sem Supabase configurado (veja .env.example)' });
r.use(needDb);

const GAME_COLS = 'id,slug,title,platform,category,year,description,cover_url,max_players,is_featured,sort_order,play_count';

// Config pública: URL e chave ANON (pública por design). Nunca a service_role.
r.get('/public-config', async (_q, res) => {
  const s = await getSettings();
  res.json({ supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.anon, platformName: s.platform_name, logoUrl: s.logo_url, announcement: s.announcement, maintenance: s.maintenance, maintenanceMessage: s.maintenance_message });
});
r.get('/games', async (_q, res) => {
  const { data, error } = await sb.from('games').select(GAME_COLS).eq('status', 'published').order('sort_order').order('title');
  if (error) return res.status(500).json({ error: 'Falha ao carregar jogos' });
  res.json(data);
});
r.get('/stats', async (_q, res) => {
  const { count } = await sb.from('games').select('id', { count: 'exact', head: true }).eq('status', 'published');
  res.json({ ...stats(), games: count ?? 0 });
});

// Login registrado no servidor (histórico de acesso).
r.post('/session/login-event', requireUser, async (req, res) => { await accessLog(req.user.id, 'login', req); res.json({ ok: true, role: req.user.profile.role }); });

// Busca de usuários para amizade (somente nome/avatar, sem e-mail).
r.get('/users/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_,()]/g, '');
  if (q.length < 2) return res.json([]);
  const { data } = await sb.from('profiles').select('id,display_name,avatar_url,online').ilike('display_name', `%${q}%`).eq('banned', false).neq('id', req.user.id).limit(10);
  res.json(data || []);
});

// ROM só é entregue a quem participa (jogador/espectador) de uma sessão ativa do jogo.
r.get('/sessions/:id/rom', requireUser, async (req, res) => {
  const { data: s } = await sb.from('game_sessions').select('id,status,game_id').eq('id', req.params.id).maybeSingle();
  if (!s || s.status !== 'running') return res.status(404).json({ error: 'Sessão inexistente ou encerrada' });
  const { data: g } = await sb.from('games').select('rom_path,emulator_core,emulator_files,title').eq('id', s.game_id).single();
  if (!g?.rom_path) return res.status(404).json({ error: 'Jogo sem ROM cadastrada. O administrador precisa enviar o arquivo.' });
  const file = path.basename(g.rom_path); // bloqueia path traversal
  if (!fs.existsSync(path.join(cfg.romDir, file))) return res.status(404).json({ error: 'Arquivo da ROM não encontrado no servidor' });
  res.setHeader('X-Emulator-Core', g.emulator_core);
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(file, { root: cfg.romDir });
});
r.get('/sessions/:id/meta', requireUser, async (req, res) => {
  const { data: s } = await sb.from('game_sessions').select('id,status,game_id').eq('id', req.params.id).maybeSingle();
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada' });
  const { data: g } = await sb.from('games').select('title,emulator_core,rom_path,max_players').eq('id', s.game_id).single();
  res.json({ status: s.status, gameId: s.game_id, title: g.title, core: g.emulator_core, hasRom: Boolean(g.rom_path) });
});

// Denúncia (valida no servidor, além do RLS)
r.post('/reports', requireUser, async (req, res) => {
  const { reportedUser, reason } = req.body || {};
  if (typeof reason !== 'string' || reason.length < 3 || reason.length > 500 || !/^[0-9a-f-]{36}$/i.test(String(reportedUser))) return res.status(400).json({ error: 'Dados inválidos' });
  if (reportedUser === req.user.id) return res.status(400).json({ error: 'Não é possível denunciar a si mesmo' });
  const { error } = await sb.from('reports').insert({ reporter: req.user.id, reported_user: reportedUser, reason });
  if (error) return res.status(400).json({ error: 'Não foi possível registrar a denúncia' });
  res.json({ ok: true });
});
export default r;
