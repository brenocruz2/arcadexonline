const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m, k = '') => { const t = document.createElement('div'); t.className = 'toast ' + k; t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 4500); };
let sb, token, me, tab = 'dash', timer;

async function api(path, { method = 'GET', body, form } = {}) {
  const h = { Authorization: 'Bearer ' + token }; if (body) h['Content-Type'] = 'application/json';
  const r = await fetch('/api/admin' + path, { method, headers: h, body: form || (body ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.details ? j.error + ': ' + j.details.join('; ') : j.error || 'Erro ' + r.status); return j;
}
// Upload com barra de progresso (fetch não expõe progresso de envio; XHR sim).
function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append('file', file);
    const x = new XMLHttpRequest(); x.open('POST', '/api/admin' + path); x.setRequestHeader('Authorization', 'Bearer ' + token);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded, e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* ignora */ } x.status < 300 ? (onProgress(file.size, file.size, true), resolve(j)) : reject(new Error(j.error || 'Erro ' + x.status)); };
    x.onerror = () => reject(new Error('Falha de rede no envio')); x.ontimeout = () => reject(new Error('Tempo esgotado no envio')); x.timeout = 30 * 60 * 1000;
    x.send(fd);
  });
}
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const bar = (id, label) => `<div class="up" id="${id}" style="display:none;margin-top:10px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)"><span>${label}</span><span class="pc">0%</span></div><div style="height:10px;background:var(--bg2);border:1px solid var(--line);border-radius:99px;overflow:hidden"><div class="fill" style="height:100%;width:0;background:var(--grad);transition:width .15s"></div></div></div>`;
const setBar = (id, loaded, total, done) => { const el = $('#' + id); if (!el) return; el.style.display = 'block'; const p = Math.round(loaded / total * 100); el.querySelector('.fill').style.width = p + '%'; el.querySelector('.pc').textContent = done ? '100% ✔' : `${p}% (${mb(loaded)} / ${mb(total)})`; };
const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'ok'); return r; } catch (e) { toast(e.message, 'err'); } };

async function boot() {
  const cfg = await (await fetch('/api/v1/public-config')).json();
  sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession(); if (data.session) { token = data.session.access_token; return enter(); } login();
  sb.auth.onAuthStateChange((_e, s) => { if (s) token = s.access_token; });
}
function login(msg = '') {
  $('#app').innerHTML = `<div class="modal"><div class="box"><h2>Administração</h2><p>Acesso restrito.</p><label for="em">E-mail</label><input id="em" type="email" autocomplete="username" style="color:#eef1fa!important;opacity:1;visibility:visible"><label for="pw">Senha</label><div style="display:flex;gap:8px;align-items:stretch"><input id="pw" type="password" autocomplete="current-password" spellcheck="false" style="flex:1;min-width:0;color:#eef1fa!important;-webkit-text-fill-color:#eef1fa!important;caret-color:#5aa2ff!important;opacity:1;visibility:visible"><button class="btn" id="togglePw" type="button" aria-label="Mostrar senha" style="flex:none">Mostrar</button></div><p style="color:var(--bad);min-height:20px" id="m">${esc(msg)}</p><button class="btn primary" id="go" style="width:100%;justify-content:center">Entrar</button></div></div>`;
  const pw = $('#pw');
  $('#togglePw').onclick = () => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; $('#togglePw').textContent = show ? 'Ocultar' : 'Mostrar'; $('#togglePw').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha'); pw.focus(); };
  const go = async () => { const { data, error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: pw.value }); if (error) return $('#m').textContent = 'Credenciais inválidas'; token = data.session.access_token; enter(); };
  $('#go').onclick = go; $('#pw').onkeydown = e => e.key === 'Enter' && go();
}
async function enter() {
  try { me = await api('/me'); } catch (e) { await sb.auth.signOut(); return login('Sem permissão administrativa.'); }
  $('#app').innerHTML = `<div class="shell"><aside><h3 style="padding:6px 12px 14px">ARCADE<b style="color:var(--blue2)">X</b> Admin</h3><div id="nav"></div><p style="padding:12px;font-size:12px">${esc(me.name)} · ${me.role}</p><a id="so">Sair</a></aside><main id="main"></main></div>`;
  const isA = me.role === 'admin'; const tabs = [['dash', 'Dashboard'], ...(isA ? [['games', 'Jogos']] : []), ['users', 'Usuários'], ['rooms', 'Salas e partidas'], ['reports', 'Denúncias'], ['errors', 'Erros'], ...(isA ? [['assets', 'Núcleos e BIOS'], ['audit', 'Auditoria'], ['settings', 'Configurações']] : [])];
  $('#nav').innerHTML = tabs.map(([k, l]) => `<a data-t="${k}">${l}</a>`).join(''); $('#nav').querySelectorAll('a').forEach(a => a.onclick = () => show(a.dataset.t));
  $('#so').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  setInterval(async () => { const { data } = await sb.auth.getSession(); if (data.session) token = data.session.access_token; }, 60000);
  show('dash');
}
function show(t) { tab = t; clearInterval(timer); document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.t === t)); ({ dash, games, users, rooms, reports, errors, audit, settings, assets })[t](); }
const main = h => $('#main').innerHTML = h;
const table = (cols, rows) => `<div class="scroll"><table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${cols.length}">Sem registros.</td></tr>`}</tbody></table></div>`;
const dt = s => s ? new Date(s).toLocaleString('pt-BR') : '—';

async function dash() {
  const d = await act(() => api('/dashboard')); if (!d) return; const days = Object.entries(d.perDay).sort(); const mx = Math.max(1, ...days.map(x => x[1]));
  main(`<h2>Dashboard</h2><div class="k" style="margin-top:14px">${[['Usuários', d.users], ['Online agora', d.online], ['Conexões', d.connections], ['Jogos', d.games], ['Partidas em andamento', d.runningMatches], ['Salas abertas', d.openRooms], ['Sessões realizadas', d.sessionsTotal], ['Contas bloqueadas', d.banned], ['Denúncias abertas', d.openReports]].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
  <div class="cols3"><div class="panel"><h3>Sessões (7 dias)</h3><div class="bars" style="margin:14px 0 26px">${days.map(([k, v]) => `<div style="height:${v / mx * 100}%"><span>${k.slice(5)}<br>${v}</span></div>`).join('') || '<p>Sem dados.</p>'}</div></div><div class="panel"><h3>Jogos mais jogados</h3>${table(['Jogo', 'Partidas'], d.topGames.map(g => `<tr><td>${esc(g.title)}</td><td>${g.play_count}</td></tr>`))}</div></div>`);
  timer = setInterval(() => tab === 'dash' && dash(), 10000);
}

async function games() {
  const list = await act(() => api('/games')); if (!list) return;
  main(`<div style="display:flex;justify-content:space-between"><h2>Jogos</h2><button class="btn primary" id="nw">Novo jogo</button></div><div class="panel" style="margin-top:14px">${table(['Ordem', 'Capa', 'Título', 'Plataforma', 'Categoria', 'Máx.', 'ROM', 'Status', ''], list.map((g, i) => `<tr><td><button class="btn sm" data-up="${i}">↑</button><button class="btn sm" data-dn="${i}">↓</button></td><td>${g.cover_url ? `<img src="${esc(g.cover_url)}" height="40" alt="">` : '—'}</td><td><b>${esc(g.title)}</b>${g.is_featured ? ' ⭐' : ''}</td><td>${esc(g.platform)}</td><td>${esc(g.category)}</td><td>${g.max_players}</td><td>${g.rom_path ? 'OK' : '<span style="color:var(--warn)">falta</span>'}</td><td>${g.status}</td><td><button class="btn sm" data-ed="${g.id}">Editar</button> <button class="btn sm danger" data-rm="${g.id}">Excluir</button></td></tr>`))}</div>`);
  $('#nw').onclick = () => gameForm(); document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => gameForm(list.find(g => g.id === b.dataset.ed)));
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { if (confirm('Excluir este jogo e sua ROM?')) { await act(() => api('/games/' + b.dataset.rm, { method: 'DELETE' }), 'Jogo excluído'); games(); } });
  const mv = async (i, d) => { const ids = list.map(g => g.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await act(() => api('/games/reorder', { method: 'POST', body: { ids } })); games(); };
  document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => mv(+b.dataset.up, -1)); document.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => mv(+b.dataset.dn, 1));
}
async function gameForm(g = {}) {
  const biosAssets = await api('/assets/bios').catch(() => []);
  const v = (k, d = '') => esc(g[k] ?? d);
  $('#modal').innerHTML = `<div class="modal"><div class="box" style="width:min(640px,100%)"><h2>${g.id ? 'Editar' : 'Novo'} jogo</h2><div class="fg"><div><label>Título</label><input id="t" value="${v('title')}"></div><div><label>Slug (url)</label><input id="s" value="${v('slug')}" placeholder="kof-98"></div><div><label>Plataforma</label><input id="p" value="${v('platform', 'Neo Geo')}"></div><div><label>Categoria</label><input id="c" value="${v('category', 'Luta')}"></div><div><label>Ano</label><input id="y" type="number" value="${v('year')}"></div><div><label>Máx. jogadores (1-4)</label><input id="m" type="number" min="1" max="4" value="${v('max_players', 2)}"></div><div><label>Núcleo do emulador</label><input id="e" value="${v('emulator_core', 'fbneo')}"></div><div><label>Status</label><select id="st">${['published', 'draft', 'disabled'].map(s => `<option ${g.status === s || (!g.status && s === 'draft') ? 'selected' : ''} value="${s}">${{ published: 'Ativo (publicado)', draft: 'Rascunho', disabled: 'Desativado' }[s]}</option>`).join('')}</select></div>
  <div class="w"><label>Descrição</label><textarea id="d" rows="2">${v('description')}</textarea></div><div class="w"><label>Arquivos extras / BIOS associada (JSON)</label><input id="f" value='${esc(JSON.stringify(g.emulator_files || {}))}'></div><div class="w"><label>Associar BIOS enviada</label><select id="biosAsset"><option value="">Nenhuma BIOS selecionada</option>${biosAssets.map(x => { const v = 'bios/' + x.name; return `<option value="${esc(v)}" ${g.emulator_files?.bios === v ? 'selected' : ''}>${esc(x.name)}</option>`; }).join('')}</select><p class="meta">A associação registra o caminho no cadastro do jogo; a carga automática depende do suporte do núcleo/emulador.</p></div><div class="w"><label>URL da capa (ou envie arquivo abaixo)</label><input id="cu" value="${v('cover_url')}"></div>
  <div><label>Enviar capa (png/jpg/webp, 3MB)</label><input type="file" id="cf" accept="image/*"></div><div><label>Enviar ROM (zip/7z/neo, 128MB)</label><input type="file" id="rf"></div></div>${bar('pc', 'Capa')}${bar('pr', 'ROM')}
  <label><input type="checkbox" id="ft" style="width:auto" ${g.is_featured ? 'checked' : ''}> Destaque na página inicial</label><div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="sv">Salvar</button><button class="btn" id="cx">Cancelar</button></div></div></div>`;
  $('#cx').onclick = () => $('#modal').innerHTML = '';
  $('#sv').onclick = async () => {
    let files; try { files = JSON.parse($('#f').value || '{}'); } catch { return toast('JSON de arquivos inválido', 'err'); }
    const selectedBios = $('#biosAsset').value; if (selectedBios) files.bios = selectedBios; else delete files.bios;
    const body = { title: $('#t').value.trim(), slug: $('#s').value.trim(), platform: $('#p').value.trim(), category: $('#c').value.trim(), year: $('#y').value ? +$('#y').value : null, max_players: +$('#m').value, emulator_core: $('#e').value.trim(), status: $('#st').value, description: $('#d').value.trim() || null, cover_url: $('#cu').value.trim() || null, emulator_files: files, is_featured: $('#ft').checked };
    const saved = await act(() => api(g.id ? '/games/' + g.id : '/games', { method: g.id ? 'PUT' : 'POST', body })); if (!saved) return;
    $('#sv').disabled = true; $('#cx').disabled = true; let failed = false;
    for (const [id, ep, barId] of [['cf', 'cover', 'pc'], ['rf', 'rom', 'pr']]) {
      const f = $('#' + id).files[0]; if (!f) continue; setBar(barId, 0, f.size);
      try { await upload(`/games/${saved.id}/${ep}`, f, (l, t, d) => setBar(barId, l, t, d)); }
      catch (e) { failed = true; toast(`Falha no envio (${ep}): ${e.message}`, 'err'); }
    }
    $('#sv').disabled = false; $('#cx').disabled = false;
    if (failed) { games(); return; } // jogo foi salvo; reabra para reenviar o arquivo
    toast('Jogo salvo', 'ok'); $('#modal').innerHTML = ''; games();
  };
}

let uq = '', up = 0;
async function users() {
  const r = await act(() => api(`/users?q=${encodeURIComponent(uq)}&page=${up}`)); if (!r) return; const isA = me.role === 'admin';
  main(`<h2>Usuários (${r.total})</h2><div style="display:flex;gap:8px;margin:14px 0"><input id="q" placeholder="Pesquisar por nome" value="${esc(uq)}" style="max-width:320px"><button class="btn" id="sq">Buscar</button></div><div class="panel">${table(['Nome', 'Perm.', 'Status', 'Último acesso', ''], r.users.map(u => `<tr><td><b>${esc(u.display_name)}</b></td><td>${u.role}</td><td>${u.banned ? '<span style="color:var(--bad)">bloqueado</span>' : u.online ? '<span style="color:var(--ok)">online</span>' : 'offline'}</td><td>${dt(u.last_seen)}</td><td><button class="btn sm" data-v="${u.id}">Detalhes</button> <button class="btn sm" data-b="${u.id}" data-s="${u.banned}">${u.banned ? 'Desbloquear' : 'Bloquear'}</button>${isA ? ` <select data-r="${u.id}" style="width:auto;padding:5px">${['user', 'moderator', 'admin'].map(x => `<option ${u.role === x ? 'selected' : ''}>${x}</option>`).join('')}</select> <button class="btn sm danger" data-x="${u.id}">Remover</button>` : ''}</td></tr>`))}</div><div style="margin-top:10px;display:flex;gap:8px"><button class="btn sm" id="pv" ${up ? '' : 'disabled'}>Anterior</button><button class="btn sm" id="nx" ${(up + 1) * 25 >= r.total ? 'disabled' : ''}>Próxima</button></div>`);
  $('#sq').onclick = () => { uq = $('#q').value; up = 0; users(); }; $('#pv').onclick = () => { up--; users(); }; $('#nx').onclick = () => { up++; users(); };
  document.querySelectorAll('[data-b]').forEach(b => b.onclick = async () => { const ban = b.dataset.s !== 'true'; const reason = ban ? prompt('Motivo do bloqueio:') || '' : ''; await act(() => api(`/users/${b.dataset.b}/ban`, { method: 'POST', body: { banned: ban, reason } }), ban ? 'Bloqueado' : 'Desbloqueado'); users(); });
  document.querySelectorAll('[data-r]').forEach(s => s.onchange = async () => { await act(() => api(`/users/${s.dataset.r}/role`, { method: 'POST', body: { role: s.value } }), 'Permissão alterada'); users(); });
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => { if (confirm('Remover esta conta definitivamente?')) { await act(() => api('/users/' + b.dataset.x, { method: 'DELETE' }), 'Conta removida'); users(); } });
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => { const d = await act(() => api('/users/' + b.dataset.v)); if (!d) return;
    $('#modal').innerHTML = `<div class="modal"><div class="box" style="width:min(720px,100%)"><h2>${esc(d.profile.display_name)}</h2><p>${esc(d.email)} · cadastro ${dt(d.profile.created_at)}</p><h3 style="margin-top:12px">Acessos</h3>${table(['Evento', 'IP', 'Data'], d.access.map(a => `<tr><td>${a.event}</td><td>${esc(a.ip)}</td><td>${dt(a.created_at)}</td></tr>`))}<h3 style="margin-top:12px">Partidas</h3>${table(['Jogo', 'Início', 'Fim', 'Motivo'], d.matches.map(m => `<tr><td>${esc(m.game_sessions?.games?.title)}</td><td>${dt(m.game_sessions?.started_at)}</td><td>${dt(m.game_sessions?.ended_at)}</td><td>${esc(m.game_sessions?.end_reason)}</td></tr>`))}<h3 style="margin-top:12px">Denúncias recebidas</h3>${table(['Motivo', 'Status', 'Data'], d.reports.map(x => `<tr><td>${esc(x.reason)}</td><td>${x.status}</td><td>${dt(x.created_at)}</td></tr>`))}${me.role === 'admin' ? '<div class="panel" style="margin-top:14px"><h3>Segurança da conta</h3><label>Nova senha (mínimo 8 caracteres)</label><input id="newUserPassword" type="password" minlength="8" maxlength="72" autocomplete="new-password" placeholder="Digite a nova senha"><button class="btn primary" id="changeUserPassword" style="margin-top:10px">Alterar senha</button></div>' : ''}<button class="btn" id="cx" style="margin-top:14px">Fechar</button></div></div>`; const changePwBtn = $('#changeUserPassword'); if (changePwBtn) changePwBtn.onclick = async () => { const password = $('#newUserPassword').value; if (password.length < 8) return toast('A senha deve ter pelo menos 8 caracteres.', 'err'); if (!confirm('Confirma a alteração da senha deste usuário?')) return; const done = await act(() => api('/users/' + b.dataset.v + '/password', { method: 'POST', body: { password } }), 'Senha alterada com sucesso.'); if (done) $('#newUserPassword').value = ''; }; $('#cx').onclick = () => $('#modal').innerHTML = ''; });
}

async function assets() {
  const [cores, bios] = await Promise.all([
    act(() => api('/assets/core')),
    act(() => api('/assets/bios'))
  ]);
  if (!cores || !bios) return;
  const fmt = n => n ? (n / 1048576).toFixed(2) + ' MB' : '—';
  const rows = (kind, arr) => arr.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${fmt(x.size)}</td><td>${dt(x.updated_at)}</td><td><button class="btn sm danger" data-del-asset="${kind}" data-name="${esc(x.name)}">Excluir</button></td></tr>`).join('');
  main(`<h2>Núcleos de emulação e BIOS</h2>
    <p class="meta">Arquivos guardados no Supabase Storage privado, fora do disco temporário do Fly.io.</p>
    <div class="cols3" style="margin-top:14px">
      <div class="panel"><h3>Enviar núcleo</h3><p class="meta">Pacotes .zip ou arquivos .wasm, .data, .js, .mjs e .json (até 64 MB).</p><input id="coreFile" type="file" accept=".zip,.wasm,.data,.js,.mjs,.json"><button class="btn primary" id="uploadCore" style="margin-top:10px">Enviar núcleo</button></div>
      <div class="panel"><h3>Enviar BIOS</h3><p class="meta">Arquivos .zip, .bin, .rom e .bios (até 64 MB). Envie apenas arquivos que você tem direito de usar.</p><input id="biosFile" type="file" accept=".zip,.bin,.rom,.bios,.rom1,.rom2"><button class="btn primary" id="uploadBios" style="margin-top:10px">Enviar BIOS</button></div>
    </div>
    <div class="panel" style="margin-top:14px"><h3>Núcleos cadastrados (${cores.length})</h3>${table(['Arquivo','Tamanho','Atualizado',''], rows('core', cores))}</div>
    <div class="panel" style="margin-top:14px"><h3>BIOS cadastradas (${bios.length})</h3>${table(['Arquivo','Tamanho','Atualizado',''], rows('bios', bios))}</div>
    <p class="meta">Observação: o envio e o armazenamento ficam disponíveis nesta biblioteca. A seleção de um núcleo/BIOS no jogo e a execução de núcleos personalizados ainda dependem da compatibilidade do carregador EmulatorJS e não são ativadas automaticamente pelo upload.</p>`);
  const send = async (kind, id) => {
    const f = $('#' + id).files[0]; if (!f) return toast('Selecione um arquivo primeiro.', 'err');
    const fd = new FormData(); fd.append('file', f);
    const result = await act(() => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('POST', '/api/admin/assets/' + kind); x.setRequestHeader('Authorization', 'Bearer ' + token);
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(j) : reject(new Error(j.error || 'Falha no envio')); };
      x.onerror = () => reject(new Error('Falha de rede')); x.send(fd);
    }), 'Arquivo enviado para o Supabase Storage.');
    if (result) assets();
  };
  $('#uploadCore').onclick = () => send('core', 'coreFile');
  $('#uploadBios').onclick = () => send('bios', 'biosFile');
  document.querySelectorAll('[data-del-asset]').forEach(b => b.onclick = async () => {
    if (!confirm('Excluir este arquivo permanentemente?')) return;
    const result = await act(() => api('/assets/' + b.dataset.delAsset + '/' + encodeURIComponent(b.dataset.name), { method: 'DELETE' }), 'Arquivo excluído.');
    if (result) assets();
  });
}

async function rooms() {
  const draw = async () => { const r = await act(() => api('/rooms')); if (!r || tab !== 'rooms') return;
    main(`<h2>Salas e partidas</h2><div class="k" style="margin-top:14px"><div class="stat"><b>${r.connections}</b><span>Conexões</span></div><div class="stat"><b>${r.online}</b><span>Usuários online</span></div><div class="stat"><b>${r.matches}</b><span>Partidas ativas</span></div></div>
    <div class="panel"><h3>Partidas em andamento</h3>${table(['Sessão', 'Jogadores', 'Espect.', 'Início', ''], r.sessions.map(s => `<tr><td>${s.id.slice(0, 8)}</td><td>${s.players.map(p => esc(p.name)).join(' × ')}</td><td>${s.spectators}</td><td>${dt(s.startedAt)}</td><td><button class="btn sm danger" data-e="${s.id}">Encerrar</button></td></tr>`))}</div>
    <div class="panel" style="margin-top:14px"><h3>Salas abertas</h3>${table(['Sala (jogo)', 'Usuário', 'Papel', ''], r.rooms.flatMap(x => [...x.players.map(p => [x.gameId, p, 'jogador']), ...x.spectators.map(p => [x.gameId, p, 'espectador'])]).map(([g, p, role]) => `<tr><td>${g.slice(0, 8)}</td><td>${esc(p.name)}</td><td>${role}</td><td><button class="btn sm" data-k="${p.id}" data-g="${g}">Remover da sala</button></td></tr>`))}</div>`);
    document.querySelectorAll('[data-e]').forEach(b => b.onclick = async () => { await act(() => api(`/sessions/${b.dataset.e}/end`, { method: 'POST' }), 'Sessão encerrada'); draw(); });
    document.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => { await act(() => api('/rooms/kick', { method: 'POST', body: { userId: b.dataset.k, gameId: b.dataset.g } }), 'Usuário removido'); draw(); }); };
  await draw(); timer = setInterval(draw, 5000);
}
async function reports() {
  const r = await act(() => api('/reports')); if (!r) return;
  main(`<h2>Denúncias</h2><div class="panel" style="margin-top:14px">${table(['Data', 'Denunciante', 'Denunciado', 'Motivo', 'Status', ''], r.map(x => `<tr><td>${dt(x.created_at)}</td><td>${esc(x.reporter_name)}</td><td>${esc(x.reported_name)}</td><td>${esc(x.reason)}</td><td>${x.status}</td><td>${x.status === 'open' ? `<button class="btn sm" data-c="${x.id}">Concluir</button>` : ''}</td></tr>`))}</div>`);
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => { await act(() => api(`/reports/${b.dataset.c}/close`, { method: 'POST' })); reports(); });
}
async function errors() { const r = await act(() => api('/errors')); if (r) main(`<h2>Erros e falhas</h2><div class="panel" style="margin-top:14px">${table(['Data', 'Origem', 'Mensagem'], r.map(e => `<tr><td>${dt(e.created_at)}</td><td>${esc(e.source)}</td><td>${esc(e.message)}</td></tr>`))}</div>`); }
async function audit() { const r = await act(() => api('/audit')); if (r) main(`<h2>Auditoria</h2><div class="panel" style="margin-top:14px">${table(['Data', 'Ação', 'Alvo', 'Detalhes', 'IP'], r.map(e => `<tr><td>${dt(e.created_at)}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td style="max-width:320px;overflow:hidden;text-overflow:ellipsis">${esc(JSON.stringify(e.details))}</td><td>${esc(e.ip)}</td></tr>`))}</div>`); }

async function settings() {
  const [s, sys] = await Promise.all([act(() => api('/settings')), act(() => api('/system'))]); if (!s) return;
  const num = (k, l) => `<div><label>${l}</label><input data-n="${k}" type="number" value="${s[k]}"></div>`;
  main(`<h2>Configurações</h2><div class="cols3" style="margin-top:14px"><div class="panel"><h3>Plataforma</h3><label>Nome</label><input id="pn" value="${esc(s.platform_name)}"><label>Logo atual</label><p>${esc(s.logo_url) || 'nenhum'}</p><input type="file" id="lf" accept="image/*">${bar('lp', 'Logo')}<label>Mensagem de aviso (banner)</label><input id="an" value="${esc(s.announcement)}"><label><input type="checkbox" id="mt" style="width:auto" ${s.maintenance ? 'checked' : ''}> Modo manutenção (bloqueia usuários comuns)</label><label>Mensagem de manutenção</label><input id="mm" value="${esc(s.maintenance_message)}"></div>
  <div class="panel"><h3>Limites</h3>${num('max_online_users', 'Máx. usuários online')}${num('max_concurrent_sessions', 'Máx. partidas simultâneas')}${num('max_spectators_per_session', 'Máx. espectadores por partida')}${num('challenge_ttl_seconds', 'Validade do desafio (s)')}${num('reconnect_grace_seconds', 'Janela de reconexão (s)')}${num('max_session_minutes', 'Duração máxima da partida (min)')}</div>
  <div class="panel"><h3>Servidor e banco (somente leitura)</h3>${sys ? `<p>Node ${sys.node} · ${sys.cpus} CPUs · ${sys.memoryMB} MB RSS</p><p>Uptime: ${Math.round(sys.uptimeSec / 60)} min · Ambiente: ${esc(sys.env)}</p><p>Supabase: ${esc(sys.supabaseHost)}</p><p>ROM_DIR: ${esc(sys.romDir)}</p><p>MAX_CONNECTIONS (env): ${sys.maxConnections}</p><p>Origens: ${esc(sys.origins.join(', ') || 'mesma origem')}</p><p style="font-size:12px">Chaves e variáveis de servidor são definidas apenas no .env, nunca pelo navegador.</p>` : ''}</div></div><button class="btn primary" id="sv" style="margin-top:16px">Salvar configurações</button>`);
  $('#sv').onclick = async () => { const body = { platform_name: $('#pn').value, announcement: $('#an').value, maintenance: $('#mt').checked, maintenance_message: $('#mm').value }; document.querySelectorAll('[data-n]').forEach(i => body[i.dataset.n] = +i.value);
    const f = $('#lf').files[0]; if (f) { $('#lp').style.display = 'block'; const r = await act(() => upload('/logo', f, (l, t, d) => setBar('lp', l, t, d))); if (r) body.logo_url = r.logo_url; }
    await act(() => api('/settings', { method: 'PUT', body }), 'Configurações salvas'); settings(); };
}
boot();
