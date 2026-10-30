// Configuração e leitura de controles: teclado + Gamepad API (USB/Bluetooth).
export const ACTIONS = [['up', 'Cima'], ['down', 'Baixo'], ['left', 'Esquerda'], ['right', 'Direita'], ['a', 'Botão A'], ['b', 'Botão B'], ['c', 'Botão C'], ['d', 'Botão D'], ['start', 'Start'], ['select', 'Select']];
export const DEFAULTS = {
  keyboard: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyZ', b: 'KeyX', c: 'KeyC', d: 'KeyV', start: 'Enter', select: 'ShiftRight' },
  gamepad: { up: 'b12', down: 'b13', left: 'b14', right: 'b15', a: 'b0', b: 'b1', c: 'b2', d: 'b3', start: 'b9', select: 'b8' },
};
const LS = 'arcadex.controls.v1';
const merge = c => ({ keyboard: { ...DEFAULTS.keyboard, ...(c?.keyboard || {}) }, gamepad: { ...DEFAULTS.gamepad, ...(c?.gamepad || {}) } });
export const loadLocal = () => { try { return merge(JSON.parse(localStorage.getItem(LS))); } catch { return merge(); } };
export const saveLocal = c => { try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* storage cheio/bloqueado */ } };
export async function loadRemote(sb, userId) {
  const { data } = await sb.from('controller_configs').select('config').eq('user_id', userId).maybeSingle();
  if (data?.config) { const c = merge(data.config); saveLocal(c); return c; }
  return null;
}
export async function saveRemote(sb, userId, cfg) {
  const { error } = await sb.from('controller_configs').upsert({ user_id: userId, config: cfg, updated_at: new Date().toISOString() });
  if (error) throw error; return true;
}
export const keyLabel = c => c ? c.replace('Key', '').replace('Digit', '').replace('Arrow', '↔').replace('ArrowUp', '↑') : '—';
export const padLabel = c => c ? (c.startsWith('b') ? 'Botão ' + c.slice(1) : c.startsWith('a') ? 'Eixo ' + c.slice(1) : c) : '—';
export const listGamepads = () => [...(navigator.getGamepads?.() || [])].filter(Boolean);

// Aguarda a próxima tecla (Esc cancela) ou botão/eixo do gamepad.
export function captureKey() {
  return new Promise(res => {
    const h = e => { e.preventDefault(); e.stopPropagation(); removeEventListener('keydown', h, true); res(e.code === 'Escape' ? null : e.code); };
    addEventListener('keydown', h, true);
  });
}
export function capturePad(timeoutMs = 8000) {
  return new Promise(res => {
    const start = Date.now(); const base = listGamepads().map(g => g.buttons.map(b => b.pressed));
    const tick = () => {
      const pads = listGamepads();
      for (const [gi, g] of pads.entries()) {
        for (let i = 0; i < g.buttons.length; i++) if (g.buttons[i].pressed && !(base[gi]?.[i])) return res('b' + i);
        for (let a = 0; a < g.axes.length; a++) if (Math.abs(g.axes[a]) > 0.8) return res(`a${a}${g.axes[a] > 0 ? '+' : '-'}`);
      }
      if (Date.now() - start > timeoutMs) return res(null);
      requestAnimationFrame(tick);
    }; tick();
  });
}

// Lê o estado dos controles do usuário como máscara de bits (bit i = ACTIONS[i]).
export class InputReader {
  constructor(cfg) { this.cfg = cfg; this.keys = new Set(); this.last = 0; this.onChange = null; this.raf = 0;
    this.kd = e => { if (Object.values(this.cfg.keyboard).includes(e.code)) { e.preventDefault(); this.keys.add(e.code); } };
    this.ku = e => this.keys.delete(e.code); }
  start() { addEventListener('keydown', this.kd); addEventListener('keyup', this.ku); const loop = () => { const m = this.read(); if (m !== this.last) { this.last = m; this.onChange?.(m); } this.raf = requestAnimationFrame(loop); }; loop(); }
  stop() { removeEventListener('keydown', this.kd); removeEventListener('keyup', this.ku); cancelAnimationFrame(this.raf); }
  read() {
    let m = 0; const pads = listGamepads();
    ACTIONS.forEach(([k], i) => {
      let on = this.keys.has(this.cfg.keyboard[k]);
      const p = this.cfg.gamepad[k];
      if (!on && p) for (const g of pads) {
        if (p[0] === 'b') on = Boolean(g.buttons[+p.slice(1)]?.pressed);
        else if (p[0] === 'a') { const v = g.axes[+p.slice(1, -1)] ?? 0; on = p.endsWith('+') ? v > 0.6 : v < -0.6; }
        if (on) break;
      }
      if (on) m |= 1 << i;
    });
    return m;
  }
}

// Converte a configuração do usuário para o formato EJS_defaultControls do EmulatorJS (jogador 1).
// Índices RetroPad: 0 B,1 Y,2 SELECT,3 START,4 UP,5 DOWN,6 LEFT,7 RIGHT,8 A,9 X. Neo Geo (FBNeo): A→B, B→A, C→Y, D→X.
const RETRO = { up: 4, down: 5, left: 6, right: 7, a: 0, b: 8, c: 1, d: 9, start: 3, select: 2 };
const keyName = c => ({ ArrowUp: 'up arrow', ArrowDown: 'down arrow', ArrowLeft: 'left arrow', ArrowRight: 'right arrow', Enter: 'enter', ShiftRight: 'shift', ShiftLeft: 'shift', Space: 'space' }[c] || c.replace(/^Key|^Digit/, '').toLowerCase());
const padName = c => ({ b12: 'DPAD_UP', b13: 'DPAD_DOWN', b14: 'DPAD_LEFT', b15: 'DPAD_RIGHT' }[c] || (c?.[0] === 'b' ? 'BUTTON_' + (+c.slice(1) + 1) : ''));
export function toEmulatorJS(cfg) {
  const p1 = {}; for (const [k, idx] of Object.entries(RETRO)) p1[idx] = { value: keyName(cfg.keyboard[k]), value2: padName(cfg.gamepad[k]) };
  return { 0: p1 };
}
