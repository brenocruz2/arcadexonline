import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { cfg, configured, logError } from './lib/core.js';
import { attachRealtime, stats } from './lib/realtime.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = process.env.PUBLIC_DIR || path.join(here, '..', 'public');
const adminDir = process.env.ADMIN_DIR || path.join(here, '..', 'admin');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://cdn.emulatorjs.org', "'unsafe-eval'", "'wasm-unsafe-eval'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https:'], workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", 'ws:', 'wss:', 'blob:', 'https://*.supabase.co', 'https://cdn.emulatorjs.org', ...cfg.origins],
    frameSrc: ["'self'", 'blob:'], objectSrc: ["'none'"],
  } },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: cfg.origins.length ? cfg.origins : false }));
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_q, res) => res.json({ service: 'arcadex-online-api', status: 'ok', supabase: configured ? 'configured' : 'missing-env', ...stats(), uptime: Math.round(process.uptime()) }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));
app.use('/api/admin', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (_q, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.use('/uploads', express.static(cfg.uploadDir, { maxAge: '7d', index: false, setHeaders: r => r.setHeader('X-Content-Type-Options', 'nosniff') }));
// Área administrativa: rota própria, sem nenhum link na página pública. A proteção real está na API (/api/admin).
app.use('/admin', (_q, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); }, express.static(adminDir, { setHeaders: (res, file) => { if (/\.(?:html|js|css)$/i.test(file)) res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); } }));
app.use(express.static(publicDir));
app.get(/^\/(?!api|admin|uploads|socket\.io).*/, (_q, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, _q, res, _n) => { logError('express', err); res.status(500).json({ error: 'Erro interno' }); });

const server = http.createServer(app);
if (configured) attachRealtime(server); else console.warn('⚠ SUPABASE_* ausente: API em modo limitado (veja .env.example)');
server.listen(cfg.port, '0.0.0.0', () => console.log(`ArcadeX Online em http://localhost:${cfg.port}`));
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => logError('unhandledRejection', e));
