import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

export const cfg = {
  port: Number(process.env.PORT || 8080),
  env: process.env.NODE_ENV || 'development',
  origins: (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  supabaseUrl: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  romDir: path.resolve(process.env.ROM_DIR || './storage/roms'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './storage/uploads'),
  maxConnections: Number(process.env.MAX_CONNECTIONS || 300),
};
// No Fly.io, o caminho público /app/retroarch/cores/roms é um link para o volume persistente.
if (process.env.ROM_DIR === '/app/retroarch/cores/roms') {
  const persistentRomDir = '/app/storage/retroarch/cores/roms';
  const legacyRomDir = '/app/storage/roms';
  fs.mkdirSync(persistentRomDir, { recursive: true });

  // Migra ROMs antigas sem sobrescrever arquivos que já estejam no novo destino.
  if (fs.existsSync(legacyRomDir)) {
    for (const name of fs.readdirSync(legacyRomDir)) {
      const from = path.join(legacyRomDir, name);
      const to = path.join(persistentRomDir, name);
      if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    }
  }

  fs.mkdirSync(path.dirname(cfg.romDir), { recursive: true });
  if (fs.existsSync(cfg.romDir)) {
    const current = fs.lstatSync(cfg.romDir);
    if (!current.isSymbolicLink()) {
      for (const name of fs.readdirSync(cfg.romDir)) {
        const from = path.join(cfg.romDir, name);
        const to = path.join(persistentRomDir, name);
        if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      }
      fs.rmSync(cfg.romDir, { recursive: true, force: true });
      fs.symlinkSync(persistentRomDir, cfg.romDir, 'dir');
    }
  } else {
    fs.symlinkSync(persistentRomDir, cfg.romDir, 'dir');
  }
} else {
  fs.mkdirSync(cfg.romDir, { recursive: true });
}
fs.mkdirSync(path.join(cfg.uploadDir, 'covers'), { recursive: true });

export const configured = Boolean(cfg.supabaseUrl && cfg.anon && cfg.service);
// Gancho SOMENTE para testes automatizados (banco em memória). Nunca definir em produção.
const testMod = process.env.ARCADEX_TEST_SB && process.env.NODE_ENV !== 'production' ? (await import(process.env.ARCADEX_TEST_SB)).default : null;
export const sb = testMod ?? configured ? (testMod ?? createClient(cfg.supabaseUrl, cfg.service, { auth: { persistSession: false, autoRefreshToken: false } })) : null;

// ---------- Configurações da plataforma (tabela settings, cache 10s) ----------
export const DEFAULT_SETTINGS = {
  platform_name: 'ArcadeX Online', logo_url: '', announcement: '', maintenance: false,
  maintenance_message: 'Estamos em manutenção. Volte em instantes.',
  max_online_users: 200, max_concurrent_sessions: 25, max_spectators_per_session: 20,
  challenge_ttl_seconds: 30, reconnect_grace_seconds: 30, max_session_minutes: 120,
};
let cache = { at: 0, v: DEFAULT_SETTINGS };
export async function getSettings(force = false) {
  if (!sb) return DEFAULT_SETTINGS;
  if (!force && Date.now() - cache.at < 10000) return cache.v;
  const { data } = await sb.from('settings').select('key,value');
  const v = { ...DEFAULT_SETTINGS };
  for (const r of data || []) if (r.key in DEFAULT_SETTINGS) v[r.key] = r.value;
  cache = { at: Date.now(), v };
  return v;
}

// ---------- Logs ----------
export async function logError(source, err, meta = {}) {
  const message = String(err?.message || err).slice(0, 1000);
  console.error(`[${source}]`, message);
  try { await sb?.from('error_logs').insert({ source, message, meta }); } catch { /* evita loop */ }
}
export async function audit(adminId, action, target, details, ip) {
  try { await sb.from('audit_logs').insert({ admin_id: adminId, action, target: target ? String(target) : null, details: details ?? null, ip }); }
  catch (e) { console.error('audit fail', e.message); }
}
export async function accessLog(userId, event, req) {
  try { await sb.from('access_logs').insert({ user_id: userId, event, ip: req?.ip, user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 250) }); } catch { /* ignore */ }
}

// ---------- Autenticação validada no servidor ----------
const tokenCache = new Map();
export async function userFromToken(token) {
  if (!sb || !token) return null;
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.at < 20000) return hit.user;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile || profile.banned) return null;
  const user = { id: data.user.id, email: data.user.email, profile };
  tokenCache.set(token, { at: Date.now(), user });
  if (tokenCache.size > 2000) tokenCache.clear();
  return user;
}
export const invalidateUserCache = () => tokenCache.clear();
export const bearer = req => (req.headers.authorization || '').replace(/^Bearer /, '');

export function requireUser(req, res, next) {
  userFromToken(bearer(req)).then(u => { if (!u) return res.status(401).json({ error: 'Não autenticado' }); req.user = u; next(); })
    .catch(e => { logError('auth', e); res.status(500).json({ error: 'Erro interno' }); });
}
export const requireRole = (...roles) => (req, res, next) =>
  requireUser(req, res, () => roles.includes(req.user.profile.role) ? next() : res.status(403).json({ error: 'Permissão insuficiente' }));
