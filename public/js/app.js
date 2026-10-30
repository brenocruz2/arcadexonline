import * as C from './controls.js';

// ---------- util ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = { home: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>', pad: '<rect x="2" y="7" width="20" height="11" rx="5"/><path d="M7 10v5M4.5 12.5h5M16 11h.01M18.5 14h.01"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>', play: '<polygon points="6 4 20 12 6 20"/>', eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>', sword: '<path d="M14 4l6-2-2 6L8 18l-4 1 1-4z"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5 7-5s7 1.5 7 5M17 4a3.5 3.5 0 0 1 0 7M22 20c0-2.5-2-4-5-4.6"/>', out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', bolt: '<path d="M13 2L3 14h8l-1 8 10-12h-8z"/>' };
const ic = n => `<svg class="i" viewBox="0 0 24 24">${P[n] || ''}</svg>`;
const toast = (msg, kind = '') => { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 4500); };
const initials = n => (n || '?').slice(0, 2).toUpperCase();
const avatar = (u, cls = '') => `<span class="avatar ${cls}">${u?.avatar ? `<img src="${esc(u.avatar)}" alt="">` : initials(u?.name || u?.display_name)}</span>`;
const api = async (path, opts = {}) => { const h = { 'Content-Type': 'application/json' }; if (S.token) h.Authorization = 'Bearer ' + S.token; const r = await fetch('/api/v1' + path, { ...opts, headers: h }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Erro ' + r.status); return j; };
const ask = (ev, data) => new Promise((res, rej) => { if (!S.socket?.connected) return rej(new Error('Sem conexão em tempo real')); S.socket.timeout(8000).emit(ev, data, (err, r) => err ? rej(new Error('Tempo esgotado')) : r?.error ? rej(new Error(r.error)) : res(r)); });

// ---------- estado ----------
const S = { sb: null, cfg: null, session: null, token: null, profile: null, socket: null, games: [], stats: { online: 0, rooms: [], matches: 0 }, room: null, controls: C.loadLocal(), challenge: null, play: null, filters: { q: '', cat: '', plat: '' } };
const authed = () => Boolean(S.session);

// ---------- boot ----------
async function boot() {
  try { await boot2(); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="panel" style="margin-top:40px"><h2>Não foi possível carregar</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Tentar de novo</button></div>`; }
}
async function boot2() {
  S.cfg = await (await fetch('/api/v1/public-config')).json().catch(() => null);
  if (!S.cfg?.supabaseUrl) { $('#view').innerHTML = '<div class="panel" style="margin-top:40px"><h2>Servidor não configurado</h2><p>Defina SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no .env do servidor (veja o README).</p></div>'; return; }
  applyBrand();
  S.sb = supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  // IMPORTANTE: o callback não pode chamar métodos do Supabase de forma síncrona/await (deadlock do SDK). Trabalho pesado vai para setTimeout.
  S.sb.auth.onAuthStateChange((ev, sess) => {
    S.session = sess; S.token = sess?.access_token || null;
    if (ev === 'PASSWORD_RECOVERY') return setTimeout(recoveryModal, 0);
    if (ev === 'TOKEN_REFRESHED') { if (S.socket) S.socket.auth = { token: S.token }; return; }
    if (ev === 'SIGNED_IN' && sess && S.booted && S.profile?.id !== sess.user.id) return void setTimeout(onLogin, 0);
    if (ev === 'SIGNED_OUT') setTimeout(() => { S.profile = null; S.socket?.disconnect(); S.socket = null; renderAuth(); route(); }, 0);
  });
  const { data } = await S.sb.auth.getSession(); S.session = data.session; S.token = data.session?.access_token || null;
  await loadGames(); if (S.token) await onLogin(); else renderAuth();
  S.booted = true;
  setInterval(refreshPublicStats, 15000); refreshPublicStats();
  addEventListener('hashchange', route); route();
}
function applyBrand() {
  const c = S.cfg; document.title = c.platformName;
  $('#mark').innerHTML = c.logoUrl ? `<img src="${esc(c.logoUrl)}" style="height:34px;border-radius:8px" alt="">` : ic('bolt');
  const ban = $('#banner'); ban.className = c.maintenance ? 'banner m' : c.announcement ? 'banner' : 'hidden'; ban.textContent = c.maintenance ? c.maintenanceMessage : c.announcement;
}
async function onLogin() {
  try { const r = await api('/session/login-event', { method: 'POST' }); S.role = r.role; } catch (e) { await S.sb.auth.signOut({ scope: 'local' }); S.session = null; S.token = null; renderAuth(); route(); return; }
  const { data } = await S.sb.from('profiles').select('*').eq('id', S.session.user.id).single(); S.profile = data;
  C.loadRemote(S.sb, S.session.user.id).then(c => { if (c) { S.controls = c; } }).catch(() => {});
  connectSocket(); renderAuth(); route();
}
async function loadGames() { try { S.games = await api('/games'); } catch (e) { toast(e.message, 'err'); } }
async function refreshPublicStats() { try { const s = await api('/stats'); if (!S.socket?.connected) setStats(s); } catch { /* ignora */ } }
function setStats(s) { S.stats = { ...S.stats, ...s }; $('#onlineN').textContent = S.stats.online; if (['', '#/', '#'].includes(location.hash)) updateHomeStats(); }

// ---------- tempo real ----------
function connectSocket() {
  S.socket?.disconnect();
  const s = S.socket = io({ auth: { token: S.token }, reconnection: true, reconnectionDelayMax: 5000 });
  s.on('connect_error', e => { if (e.message === 'maintenance') toast('Plataforma em manutenção.', 'err'); else if (e.message === 'server_full') toast('Servidor lotado. Tente novamente em instantes.', 'err'); else if (e.message === 'too_many_tabs') toast('Muitas abas abertas.', 'err'); else if (e.message === 'unauthorized') S.sb.auth.refreshSession(); });
  s.on('hello', async h => { setStats(h.stats); if (S.room) { try { await ask('room:join', { gameId: S.room.gameId, role: S.room.role }); } catch { /* sala pode ter fechado */ } } if (h.activeSession && !location.hash.startsWith('#/play/')) location.hash = '#/play/' + h.activeSession; });
  s.on('stats', setStats);
  s.on('room:state', st => { if (S.room && st.gameId === S.room.gameId) { S.room.state = st; if (location.hash.startsWith('#/room/')) renderRoom(); } });
  s.on('challenge:incoming', c => { S.challenge = { ...c, dir: 'in' }; challengeModal(); });
  s.on('challenge:sent', c => { S.challenge = { ...c, dir: 'out' }; challengeModal(); });
  s.on('challenge:update', u => {
    if (S.challenge?.id !== u.id) return;
    const msg = { declined: 'Desafio recusado.', expired: 'O desafio expirou.', cancelled: 'Desafio cancelado.', accepted: 'Desafio aceito! Iniciando…' }[u.status];
    if (msg) toast(msg, u.status === 'accepted' ? 'ok' : ''); S.challenge = null; $('#modal').innerHTML = '';
  });
  s.on('session:start', ({ sessionId }) => { S.challenge = null; $('#modal').innerHTML = ''; location.hash = '#/play/' + sessionId; });
  s.on('kicked', k => { toast(k.reason, 'err'); S.room = null; location.hash = '#/'; });
}
let ticker;
function challengeModal() {
  const c = S.challenge; if (!c) return; clearInterval(ticker);
  const incoming = c.dir === 'in'; const who = incoming ? c.from : c.to;
  const draw = () => { const left = Math.max(0, Math.round((new Date(c.expiresAt) - Date.now()) / 1000));
    $('#modal').innerHTML = `<div class="modal"><div class="box" style="text-align:center">${avatar(who, 'lg')}<h2 style="margin-top:12px">${incoming ? esc(who?.name) + ' desafiou você!' : 'Aguardando ' + esc(who?.name)}</h2><p>${left}s para ${incoming ? 'responder' : 'a resposta'}</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">${incoming ? '<button class="btn primary" id="acc">Aceitar</button><button class="btn danger" id="dec">Recusar</button>' : '<button class="btn danger" id="cnl">Cancelar desafio</button>'}</div></div></div>`;
    if (incoming) { $('#acc').onclick = () => respond(true); $('#dec').onclick = () => respond(false); } else $('#cnl').onclick = () => ask('challenge:cancel').catch(e => toast(e.message, 'err'));
    if (left <= 0) clearInterval(ticker); };
  draw(); ticker = setInterval(() => S.challenge ? draw() : clearInterval(ticker), 1000);
}
async function respond(accept) { try { await ask('challenge:respond', { challengeId: S.challenge.id, accept }); if (!accept) { S.challenge = null; $('#modal').innerHTML = ''; } } catch (e) { toast(e.message, 'err'); S.challenge = null; $('#modal').innerHTML = ''; } }

// ---------- auth UI ----------
function renderAuth() {
  const a = $('#authArea');
  a.innerHTML = authed() ? `<span style="display:flex;gap:8px;align-items:center"><a href="#/profile" style="display:flex;align-items:center;gap:8px;color:var(--text)">${avatar(S.profile)}<span class="hid-m">${esc(S.profile?.display_name)}</span></a><button class="btn sm" id="out" title="Sair">${ic('out')}</button></span>` : '<button class="btn primary" id="in">Entrar</button>';
  if (authed()) $('#out').onclick = async () => { await S.sb.auth.signOut(); location.hash = '#/'; }; else $('#in').onclick = () => authModal();
  const items = [['#/', 'home', 'Início'], ['#/controls', 'pad', 'Controles'], ['#/profile', 'user', 'Perfil']];
  const cur = location.hash || '#/';
  $('#menu').innerHTML = items.map(([h, , l]) => `<a href="${h}" class="${cur === h ? 'on' : ''}">${l}</a>`).join('');
  $('#mnav').innerHTML = items.map(([h, i, l]) => `<a href="${h}">${ic(i)}<br>${l}</a>`).join('');
}
function authModal(mode = 'login') {
  const m = $('#modal');
  const f = { login: ['Entrar', 'Entrar'], register: ['Criar conta', 'Criar conta'], forgot: ['Recuperar senha', 'Enviar link'] }[mode];
  m.innerHTML = `<div class="modal"><div class="box"><div class="tabs"><button class="btn ${mode === 'login' ? 'primary' : ''}" data-m="login">Entrar</button><button class="btn ${mode === 'register' ? 'primary' : ''}" data-m="register">Criar conta</button></div>
  <h2>${f[0]}</h2>${mode === 'register' ? '<label>Nome de jogador</label><input id="dn" maxlength="16" placeholder="3 a 16 letras/números">' : ''}
  <label>E-mail</label><input id="em" type="email" autocomplete="email">${mode !== 'forgot' ? '<label>Senha</label><input id="pw" type="password" minlength="8" autocomplete="current-password">' : ''}
  <p id="msg" style="color:var(--bad);min-height:20px"></p><button class="btn primary" id="go" style="width:100%;justify-content:center">${f[1]}</button>
  <p style="text-align:center;margin-top:12px">${mode === 'login' ? '<a href="#" data-m="forgot">Esqueci minha senha</a>' : '<a href="#" data-m="login">Voltar</a>'}</p><p style="text-align:center"><a href="#" id="x">Fechar</a></p></div></div>`;
  m.querySelectorAll('[data-m]').forEach(b => b.onclick = e => { e.preventDefault(); authModal(b.dataset.m); }); $('#x').onclick = e => { e.preventDefault(); m.innerHTML = ''; };
  $('#go').onclick = async () => {
    const msg = $('#msg'); msg.style.color = 'var(--bad)'; const email = $('#em').value.trim(), pw = $('#pw')?.value; $('#go').disabled = true;
    try {
      if (mode === 'login') { const { error } = await S.sb.auth.signInWithPassword({ email, password: pw }); if (error) throw error; m.innerHTML = ''; }
      else if (mode === 'register') {
        const dn = $('#dn').value.trim(); if (!/^[A-Za-z0-9_-]{3,16}$/.test(dn)) throw new Error('Nome: 3 a 16 caracteres (letras, números, _ ou -)'); if ((pw || '').length < 8) throw new Error('Senha com no mínimo 8 caracteres');
        const { data, error } = await S.sb.auth.signUp({ email, password: pw, options: { data: { display_name: dn } } }); if (error) throw error;
        if (!data.session) { msg.style.color = 'var(--ok)'; msg.textContent = 'Conta criada! Confirme o e-mail enviado para entrar.'; } else m.innerHTML = '';
      } else { const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' }); if (error) throw error; msg.style.color = 'var(--ok)'; msg.textContent = 'Se o e-mail existir, enviamos o link de recuperação.'; }
    } catch (e) { msg.textContent = e.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos' : e.message; } $('#go').disabled = false;
  };
}
function recoveryModal() {
  $('#modal').innerHTML = `<div class="modal"><div class="box"><h2>Nova senha</h2><label>Nova senha (mín. 8)</label><input id="np" type="password" minlength="8"><p id="msg" style="color:var(--bad)"></p><button class="btn primary" id="go">Salvar</button></div></div>`;
  $('#go').onclick = async () => { const { error } = await S.sb.auth.updateUser({ password: $('#np').value }); if (error) return $('#msg').textContent = error.message; toast('Senha atualizada!', 'ok'); $('#modal').innerHTML = ''; history.replaceState(null, '', '/'); };
}

// ---------- roteamento ----------
function route() {
  renderAuth(); const h = location.hash || '#/'; const v = $('#view');
  if (S.play && !h.startsWith('#/play/')) leavePlay();
  if (S.room && !h.startsWith('#/room/') && !h.startsWith('#/play/')) { ask('room:leave').catch(() => {}); S.room = null; }
  if (h.startsWith('#/room/')) return enterRoom(h.split('/')[2]);
  if (h.startsWith('#/play/')) return viewPlay(h.split('/')[2]);
  if (h === '#/profile') return viewProfile();
  if (h === '#/controls') return viewControls();
  viewHome();
}
const needLogin = () => { $('#view').innerHTML = `<div class="panel" style="margin-top:40px;text-align:center"><h2>Entre para continuar</h2><p>Esta área exige uma conta.</p><button class="btn primary" id="l">Entrar / Criar conta</button></div>`; $('#l').onclick = () => authModal(); };
const roomCount = gid => S.stats.rooms.find(r => r.gameId === gid) || { players: 0, spectators: 0 };

// ---------- início ----------
function viewHome() {
  const feats = S.games.filter(g => g.is_featured); const hero = feats[0] || [...S.games].sort((a, b) => b.play_count - a.play_count)[0];
  const cats = [...new Set(S.games.map(g => g.category))], plats = [...new Set(S.games.map(g => g.platform))];
  $('#view').innerHTML = `<section class="hero"><div><span class="eyebrow">PLATAFORMA ARCADE MULTIPLAYER</span><h1>Desafie jogadores <span>de verdade</span>, em tempo real.</h1><p>Entre na sala do seu jogo favorito, escolha um adversário e jogue — ou assista às partidas ao vivo.</p>
  <div class="stats"><div class="stat"><b id="sOn">0</b><span>Jogadores online</span></div><div class="stat"><b id="sRo">0</b><span>Salas ativas</span></div><div class="stat"><b id="sMa">0</b><span>Partidas ao vivo</span></div></div>
  <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn primary" href="#catalogo" id="goCat">${ic('play')} Ver jogos</a><a class="btn" href="#/controls">${ic('pad')} Configurar controles</a></div></div>
  ${hero ? `<div class="feat" data-g="${hero.id}">${hero.cover_url ? `<img src="${esc(hero.cover_url)}" alt="">` : '<div class="cv"></div>'}<div class="ov"><span class="eyebrow">EM DESTAQUE</span><h2>${esc(hero.title)}</h2><p>${esc(hero.platform)} · ${esc(hero.category)}</p></div></div>` : '<div class="feat" style="display:grid;place-items:center"><p>Nenhum jogo publicado ainda.</p></div>'}</section>
  <div class="sec" id="catalogo"><h2>Catálogo</h2><div class="filters"><input id="q" placeholder="Pesquisar jogo…" value="${esc(S.filters.q)}"><select id="cat"><option value="">Todas as categorias</option>${cats.map(c => `<option ${S.filters.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select><select id="plat"><option value="">Todas as plataformas</option>${plats.map(c => `<option ${S.filters.plat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div>
  <div class="grid" id="grid"></div>`;
  $('#q').oninput = e => { S.filters.q = e.target.value; drawGrid(); }; $('#cat').onchange = e => { S.filters.cat = e.target.value; drawGrid(); }; $('#plat').onchange = e => { S.filters.plat = e.target.value; drawGrid(); };
  $('.feat[data-g]')?.addEventListener('click', e => location.hash = '#/room/' + e.currentTarget.dataset.g);
  $('#goCat')?.addEventListener('click', e => { e.preventDefault(); $('#catalogo').scrollIntoView({ behavior: 'smooth' }); });
  drawGrid(); updateHomeStats();
}
function updateHomeStats() { if (!$('#sOn')) return; $('#sOn').textContent = S.stats.online; $('#sRo').textContent = S.stats.rooms.length; $('#sMa').textContent = S.stats.matches; drawGrid(true); }
function drawGrid() {
  const g = $('#grid'); if (!g) return; const { q, cat, plat } = S.filters;
  const list = S.games.filter(x => (!q || x.title.toLowerCase().includes(q.toLowerCase())) && (!cat || x.category === cat) && (!plat || x.platform === plat));
  g.innerHTML = list.length ? list.map(x => { const rc = roomCount(x.id); return `<article class="card" data-g="${x.id}"><div class="cv">${x.cover_url ? `<img loading="lazy" src="${esc(x.cover_url)}" alt="">` : ''}<span>${esc(x.title)}</span></div><div class="b"><h3>${esc(x.title)}</h3><div class="meta"><span class="tag">${esc(x.platform)}</span><span class="tag v">${esc(x.category)}</span></div><div class="meta"><span class="${rc.players ? 'live' : ''}">${ic('users')} ${rc.players} na sala</span><span>${ic('eye')} ${rc.spectators}</span></div></div></article>`; }).join('') : '<p>Nenhum jogo encontrado.</p>';
  g.querySelectorAll('.card').forEach(c => c.onclick = () => location.hash = '#/room/' + c.dataset.g);
}

// ---------- sala ----------
async function enterRoom(id) {
  if (!authed()) return needLogin();
  const game = S.games.find(g => g.id === id); if (!game) { $('#view').innerHTML = '<p>Jogo não encontrado.</p>'; return; }
  if (!S.room || S.room.gameId !== id) { S.room = { gameId: id, game, role: null, state: null, selected: null }; }
  renderRoom();
}
async function joinAs(role) { try { const r = await ask('room:join', { gameId: S.room.gameId, role }); S.room.role = role; S.room.state = r.state; S.room.selected = null; renderRoom(); } catch (e) { toast(e.message, 'err'); } }
async function renderRoom() {
  const R = S.room; if (!R || !location.hash.startsWith('#/room/')) return; const g = R.game, st = R.state;
  const sel = st?.players.find(p => p.id === R.selected); const me = S.profile?.id;
  const row = (p, click) => `<div class="row ${click ? 'click' : ''} ${R.selected === p.id ? 'sel' : ''}" data-u="${p.id}">${avatar(p)}<div class="n"><b>${esc(p.name)}${p.id === me ? ' (você)' : ''}</b></div>${p.status ? `<span class="st ${p.status}">${{ available: 'Disponível', in_match: 'Em partida', challenged: 'Desafiado', waiting: 'Aguardando' }[p.status]}</span>` : ''}</div>`;
  $('#view').innerHTML = `<div class="sec"><div><span class="eyebrow">SALA · ${esc(g.platform)} · ${esc(g.category)}</span><h2>${esc(g.title)}</h2></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="jp" ${R.role === 'player' ? 'disabled' : ''}>${ic('play')} ${R.role === 'player' ? 'Você está jogando' : 'Entrar na partida'}</button><button class="btn" id="js" ${R.role === 'spectator' ? 'disabled' : ''}>${ic('eye')} ${R.role === 'spectator' ? 'Assistindo' : 'Assistir'}</button></div></div>
  <div class="cols"><div class="panel"><h3>Jogadores disponíveis (${st?.players.length || 0})</h3><p>${R.role === 'player' ? 'Clique em um jogador para desafiá-lo.' : 'Entre como jogador para desafiar.'}</p><div id="pl">${st?.players.map(p => row(p, p.id !== me)).join('') || '<p>Entre na sala para ver os jogadores.</p>'}</div>
  ${sel ? `<div class="panel" style="margin-top:12px;background:var(--panel2)"><div class="row">${avatar(sel)}<div class="n"><b>${esc(sel.name)}</b><span class="st ${sel.status}">${sel.status === 'available' ? 'Disponível' : 'Indisponível'}</span></div></div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary" id="ch" ${sel.status !== 'available' ? 'disabled' : ''}>${ic('sword')} DESAFIAR</button><button class="btn sm" id="rp">Denunciar</button></div></div>` : ''}</div>
  <div><div class="panel"><h3>Partidas em andamento</h3>${st?.matches.length ? st.matches.map(m => `<div class="row"><div class="n"><b>${m.players.map(esc).join(' × ')}</b><span class="meta">${m.spectators} assistindo</span></div><button class="btn sm" data-w="${m.sessionId}">${ic('eye')} Assistir</button></div>`).join('') : '<p>Nenhuma partida agora.</p>'}</div>
  <div class="panel" style="margin-top:14px"><h3>Espectadores (${st?.spectators.length || 0})</h3>${st?.spectators.map(p => row(p, false)).join('') || '<p>Ninguém assistindo.</p>'}</div>
  <div class="panel" style="margin-top:14px"><h3>Seus desafios neste jogo</h3><div id="hist"><p>Carregando…</p></div></div></div></div>`;
  $('#jp').onclick = () => joinAs('player'); $('#js').onclick = () => joinAs('spectator');
  $('#pl').querySelectorAll('[data-u]').forEach(e => e.onclick = () => { if (e.dataset.u !== me) { R.selected = e.dataset.u; renderRoom(); } });
  $('#ch')?.addEventListener('click', () => ask('challenge:send', { gameId: R.gameId, toUserId: R.selected }).catch(e => toast(e.message, 'err')));
  $('#rp')?.addEventListener('click', () => { const reason = prompt(`Motivo da denúncia contra ${sel.name}:`); if (reason) api('/reports', { method: 'POST', body: JSON.stringify({ reportedUser: sel.id, reason }) }).then(() => toast('Denúncia enviada.', 'ok')).catch(e => toast(e.message, 'err')); });
  document.querySelectorAll('[data-w]').forEach(b => b.onclick = () => location.hash = '#/play/' + b.dataset.w + '?w=1');
  if (!R.histLoaded || R.histAt !== st?.players.length) { R.histLoaded = true; R.histAt = st?.players.length; loadHist(); } else if (R.histHtml) $('#hist').innerHTML = R.histHtml;
}
async function loadHist() {
  const { data } = await S.sb.from('challenges').select('id,from_user,to_user,status,created_at').eq('game_id', S.room.gameId).order('created_at', { ascending: false }).limit(8);
  const ids = [...new Set((data || []).flatMap(c => [c.from_user, c.to_user]))]; const { data: ps } = ids.length ? await S.sb.from('profiles').select('id,display_name').in('id', ids) : { data: [] };
  const n = Object.fromEntries((ps || []).map(p => [p.id, p.display_name])); const lab = { pending: 'pendente', accepted: 'aceito', declined: 'recusado', expired: 'expirado', cancelled: 'cancelado' };
  const h = data?.length ? data.map(c => `<div class="row"><div class="n">${esc(n[c.from_user])} → ${esc(n[c.to_user])}<div class="meta">${new Date(c.created_at).toLocaleString('pt-BR')}</div></div><span class="st">${lab[c.status]}</span></div>`).join('') : '<p>Nenhum desafio ainda.</p>';
  if (S.room) S.room.histHtml = h; $('#hist') && ($('#hist').innerHTML = h);
}

// ---------- partida ----------
async function viewPlay(sessionId) {
  if (!authed()) return needLogin();
  const spectate = location.hash.includes('w=1'); sessionId = sessionId.split('?')[0];
  $('#view').innerHTML = `<div class="sec"><div><span class="eyebrow">${spectate ? 'ASSISTINDO' : 'PARTIDA'}</span><h2 id="pt">Carregando…</h2></div><button class="btn danger" id="lv">Sair da partida</button></div><div class="cols"><div><div class="emu"><div id="game"></div></div><p id="mode" class="meta"></p></div><div><div class="panel"><h3>Participantes</h3><div id="pp"></div><p id="sp"></p></div><div class="panel" style="margin-top:14px"><h3>Seus controles</h3><div class="pad" id="pad">${C.ACTIONS.map(([, l]) => `<i>${l}</i>`).join('')}</div><p id="gpn"></p></div></div></div>`;
  let meta; try { meta = await api(`/sessions/${sessionId}/meta`); const j = await ask('session:join', { sessionId, role: spectate ? 'spectator' : 'player' }); S.play = { sessionId, slot: j.slot, spectate }; $('#pp').innerHTML = j.members.map(m => `<div class="row"><b>P${m.slot}</b> ${esc(m.name)}</div>`).join(''); }
  catch (e) { toast(e.message, 'err'); location.hash = '#/'; return; }
  $('#pt').textContent = meta.title;
  $('#lv').onclick = async () => { await ask('session:leave', { sessionId }).catch(() => {}); S.play = null; location.hash = '#/'; };
  S.socket.off('session:state').on('session:state', s => { $('#pp').innerHTML = s.members.map(m => `<div class="row"><b>P${m.slot}</b> ${esc(m.name)}</div>`).join(''); $('#sp').textContent = s.spectators + ' espectador(es)'; });
  S.socket.off('session:ended').on('session:ended', e => { toast('Partida encerrada: ' + ({ player_left: 'um jogador saiu', disconnect: 'desconexão', timeout: 'tempo máximo', ended_by_admin: 'encerrada pelo administrador', kicked_by_admin: 'removido pelo administrador' }[e.reason] || e.reason), ''); leavePlay(); location.hash = '#/'; });
  const paint = (el, m) => el.querySelectorAll('i').forEach((i, k) => i.classList.toggle('on', Boolean(m & (1 << k))));
  S.socket.off('session:input').on('session:input', ({ slot, mask }) => { if (spectate) $('#mode').textContent = `Entrada do jogador ${slot}: ${mask.toString(2).padStart(10, '0')}`; });
  if (!spectate) { const rd = new C.InputReader(S.controls); rd.onChange = m => { paint($('#pad'), m); S.socket.emit('session:input', { mask: m }); }; rd.start(); S.play.reader = rd; }
  const gp = () => { const n = C.listGamepads(); $('#gpn') && ($('#gpn').textContent = n.length ? 'Controle: ' + n.map(x => x.id.slice(0, 32)).join(', ') : 'Nenhum controle USB/Bluetooth detectado (teclado ativo).'); }; gp(); S.play.gpInt = setInterval(gp, 2000);
  if (spectate) { $('#game').innerHTML = '<div style="display:grid;place-items:center;height:100%;padding:20px;text-align:center"><p>Modo espectador. Transmissão de vídeo da partida requer o worker de emulação (veja docs/EMULATION.md). Aqui você acompanha participantes e entradas em tempo real.</p></div>'; return; }
  loadEmulator(sessionId, meta);
}
async function loadEmulator(sessionId, meta) {
  const mode = $('#mode');
  if (!meta.hasRom) { $('#game').innerHTML = '<div style="display:grid;place-items:center;height:100%;padding:20px;text-align:center"><p>Este jogo ainda não tem ROM cadastrada. O administrador deve enviar o arquivo em /admin.</p></div>'; return; }
  try {
    const r = await fetch(`/api/v1/sessions/${sessionId}/rom`, { headers: { Authorization: 'Bearer ' + S.token } }); if (!r.ok) throw new Error((await r.json()).error);
    const url = URL.createObjectURL(await r.blob());
    Object.assign(window, { EJS_player: '#game', EJS_core: meta.core, EJS_gameUrl: url, EJS_pathtodata: 'https://cdn.emulatorjs.org/stable/data/', EJS_defaultControls: C.toEmulatorJS(S.controls), EJS_startOnLoaded: true, EJS_gameName: meta.title });
    const sc = document.createElement('script'); sc.src = 'https://cdn.emulatorjs.org/stable/data/loader.js'; sc.id = 'ejs'; document.body.append(sc);
    mode.textContent = 'Emulação local no seu navegador (EmulatorJS/FBNeo). Sincronização de estado entre jogadores requer worker — veja docs/EMULATION.md.';
  } catch (e) { toast(e.message, 'err'); $('#game').innerHTML = `<p style="padding:20px">${esc(e.message)}</p>`; }
}
function leavePlay() { const p = S.play; if (!p) return; p.reader?.stop(); clearInterval(p.gpInt); S.play = null; $('#ejs')?.remove(); ['EJS_player', 'EJS_core', 'EJS_gameUrl', 'EJS_defaultControls'].forEach(k => delete window[k]); S.socket?.off('session:input'); }

// ---------- perfil ----------
async function viewProfile() {
  if (!authed()) return needLogin(); const p = S.profile;
  $('#view').innerHTML = `<div class="sec"><h2>Meu perfil</h2></div><div class="cols3"><div class="panel"><div style="display:flex;gap:14px;align-items:center">${avatar(p, 'lg')}<div><b>${esc(p.display_name)}</b><br><span class="pill"><span class="dot"></span>Online</span></div></div>
  <label>Nome de jogador</label><input id="pn" maxlength="16" value="${esc(p.display_name)}"><label>Sobre mim</label><textarea id="pb" rows="3" maxlength="200">${esc(p.bio || '')}</textarea><label>Foto de perfil</label><input type="file" id="pf" accept="image/png,image/jpeg,image/webp"><p id="pm" style="min-height:20px"></p><button class="btn primary" id="ps">Salvar perfil</button></div>
  <div class="panel"><h3>Amigos</h3><div style="display:flex;gap:8px;margin:8px 0"><input id="fs" placeholder="Buscar jogador pelo nome"><button class="btn" id="fb">${ic('search')}</button></div><div id="fr"></div><div id="fl"><p>Carregando…</p></div></div>
  <div class="panel"><h3>Histórico de partidas</h3><div id="hs"><p>Carregando…</p></div></div></div>`;
  let avatarData = null;
  $('#pf').onchange = async e => { const f = e.target.files[0]; if (!f) return; if (f.size > 4e6) return toast('Imagem muito grande (máx. 4MB)', 'err'); avatarData = await resizeImg(f, 128); toast('Foto pronta. Clique em Salvar.', 'ok'); };
  $('#ps').onclick = async () => { const name = $('#pn').value.trim(); if (!/^[A-Za-z0-9_-]{3,16}$/.test(name)) return $('#pm').textContent = 'Nome: 3 a 16 caracteres (letras, números, _ ou -)'; const upd = { display_name: name, bio: $('#pb').value.trim() || null }; if (avatarData) upd.avatar_url = avatarData;
    const { data, error } = await S.sb.from('profiles').update(upd).eq('id', p.id).select().single(); if (error) return $('#pm').textContent = error.code === '23505' ? 'Esse nome já está em uso' : 'Erro ao salvar'; S.profile = data; renderAuth(); toast('Perfil salvo!', 'ok'); };
  $('#fb').onclick = async () => { const r = await api('/users/search?q=' + encodeURIComponent($('#fs').value)).catch(() => []); $('#fr').innerHTML = r.map(u => `<div class="row">${avatar(u)}<div class="n"><b>${esc(u.display_name)}</b></div><button class="btn sm" data-add="${u.id}">Adicionar</button></div>`).join('') || '<p>Nenhum resultado.</p>'; $('#fr').querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { const { error } = await S.sb.from('friendships').insert({ requester: p.id, addressee: b.dataset.add }); toast(error ? 'Solicitação já existe' : 'Solicitação enviada', error ? 'err' : 'ok'); b.disabled = true; loadFriends(); }); };
  loadFriends(); loadMatches();
}
async function resizeImg(file, size) { const img = await createImageBitmap(file); const c = document.createElement('canvas'); c.width = c.height = size; const s = Math.min(img.width, img.height); c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size); return c.toDataURL('image/jpeg', .8); }
async function loadFriends() {
  const me = S.profile.id; const { data } = await S.sb.from('friendships').select('*'); const ids = [...new Set((data || []).flatMap(f => [f.requester, f.addressee]))].filter(i => i !== me);
  const { data: ps } = ids.length ? await S.sb.from('profiles').select('id,display_name,avatar_url,online').in('id', ids) : { data: [] }; const m = Object.fromEntries((ps || []).map(p => [p.id, p]));
  const item = (f, btns) => { const o = m[f.requester === me ? f.addressee : f.requester]; return `<div class="row">${avatar(o)}<div class="n"><b>${esc(o?.display_name)}</b><span class="meta"><span class="dot ${o?.online ? '' : 'off'}"></span>${o?.online ? 'Online' : 'Offline'}</span></div>${btns}</div>`; };
  const inc = (data || []).filter(f => f.status === 'pending' && f.addressee === me), out = (data || []).filter(f => f.status === 'pending' && f.requester === me), acc = (data || []).filter(f => f.status === 'accepted');
  $('#fl').innerHTML = (inc.length ? '<p><b>Solicitações recebidas</b></p>' + inc.map(f => item(f, `<button class="btn sm primary" data-ok="${f.id}">Aceitar</button><button class="btn sm" data-no="${f.id}">Recusar</button>`)).join('') : '') + (out.length ? '<p><b>Enviadas</b></p>' + out.map(f => item(f, `<button class="btn sm" data-no="${f.id}">Cancelar</button>`)).join('') : '') + '<p><b>Amigos</b></p>' + (acc.map(f => item(f, `<button class="btn sm" data-no="${f.id}">Remover</button>`)).join('') || '<p>Nenhum amigo ainda.</p>');
  $('#fl').querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { await S.sb.from('friendships').update({ status: 'accepted' }).eq('id', b.dataset.ok); loadFriends(); });
  $('#fl').querySelectorAll('[data-no]').forEach(b => b.onclick = async () => { await S.sb.from('friendships').delete().eq('id', b.dataset.no); loadFriends(); });
}
async function loadMatches() {
  const { data } = await S.sb.from('session_members').select('player_slot,game_sessions(id,status,started_at,ended_at,end_reason,games(title))').order('joined_at', { ascending: false }).limit(15);
  $('#hs').innerHTML = data?.length ? data.map(r => { const s = r.game_sessions; return `<div class="row"><div class="n"><b>${esc(s?.games?.title)}</b><div class="meta">${new Date(s.started_at).toLocaleString('pt-BR')} · P${r.player_slot}</div></div><span class="st ${s.status === 'running' ? 'in_match' : ''}">${s.status === 'running' ? 'em andamento' : 'encerrada'}</span></div>`; }).join('') : '<p>Você ainda não jogou nenhuma partida.</p>';
}

// ---------- controles ----------
function viewControls() {
  const cfg = S.controls; const pads = C.listGamepads();
  $('#view').innerHTML = `<div class="sec"><div><span class="eyebrow">CONTROLES</span><h2>Configurar joystick</h2></div><div style="display:flex;gap:8px"><button class="btn" id="rs">Restaurar padrão</button><button class="btn primary" id="sv">Salvar</button></div></div>
  <div class="cols"><div class="panel"><div class="ctl"><span class="h">FUNÇÃO</span><span class="h">TECLADO</span><span class="h">JOYSTICK / BLUETOOTH</span>${C.ACTIONS.map(([k, l]) => `<b>${l}</b><button class="btn keybtn" data-k="${k}" data-t="keyboard">${esc(C.keyLabel(cfg.keyboard[k]))}</button><button class="btn keybtn" data-k="${k}" data-t="gamepad">${esc(C.padLabel(cfg.gamepad[k]))}</button>`).join('')}</div><p>Clique em um botão e pressione a tecla (Esc cancela) ou o botão do controle (8s).</p></div>
  <div><div class="panel"><h3>Controles detectados</h3><div id="gl">${pads.length ? pads.map(g => `<div class="row"><div class="n"><b>${esc(g.id.slice(0, 40))}</b><span class="meta">${g.buttons.length} botões · ${g.axes.length} eixos</span></div></div>`).join('') : '<p>Nenhum controle. Conecte um USB/Bluetooth e pressione qualquer botão.</p>'}</div></div><div class="panel" style="margin-top:14px"><h3>Teste ao vivo</h3><div class="pad" id="pad">${C.ACTIONS.map(([, l]) => `<i>${l}</i>`).join('')}</div></div></div></div>`;
  const rd = new C.InputReader(cfg); rd.onChange = m => document.querySelectorAll('#pad i').forEach((i, k) => i.classList.toggle('on', Boolean(m & (1 << k)))); rd.start();
  const stop = () => { rd.stop(); removeEventListener('hashchange', stop); removeEventListener('gamepadconnected', refresh); removeEventListener('gamepaddisconnected', refresh); }; addEventListener('hashchange', stop);
  const refresh = () => { if (location.hash === '#/controls') viewControls(); }; addEventListener('gamepadconnected', refresh); addEventListener('gamepaddisconnected', refresh);
  document.querySelectorAll('.keybtn').forEach(b => b.onclick = async () => {
    b.classList.add('listen'); b.textContent = b.dataset.t === 'keyboard' ? 'Pressione uma tecla…' : 'Pressione um botão…';
    const v = b.dataset.t === 'keyboard' ? await C.captureKey() : await C.capturePad(); if (v) cfg[b.dataset.t][b.dataset.k] = v;
    b.classList.remove('listen'); b.textContent = b.dataset.t === 'keyboard' ? C.keyLabel(cfg.keyboard[b.dataset.k]) : C.padLabel(cfg.gamepad[b.dataset.k]); C.saveLocal(cfg);
  });
  $('#rs').onclick = () => { S.controls = JSON.parse(JSON.stringify(C.DEFAULTS)); C.saveLocal(S.controls); stop(); viewControls(); };
  $('#sv').onclick = async () => { C.saveLocal(cfg); if (!authed()) return toast('Salvo neste navegador. Entre na conta para sincronizar em outros computadores.', ''); try { await C.saveRemote(S.sb, S.profile.id, cfg); toast('Controles salvos na sua conta!', 'ok'); } catch { toast('Falha ao salvar na conta (cópia local mantida)', 'err'); } };
}
boot();
