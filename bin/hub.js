#!/usr/bin/env node
'use strict';

// Sem sintaxe nova antes desta checagem: num Node antigo o aviso precisa aparecer.
var NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write('✗ o hub precisa do Node.js 18 ou mais novo (você está no v' + process.versions.node + '): https://nodejs.org\n');
  process.exit(1);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HUB_ROOT = path.resolve(fs.realpathSync(__dirname), '..');
const lib = require(path.join(HUB_ROOT, 'ui', 'server.js'));
const { HOME, IS_WIN, IS_MAC, IS_WSL } = lib;
const CONFIG = lib.CONFIG;
const STATE_FILE = path.join(path.dirname(CONFIG), 'last');
const TTY_IN = Boolean(process.stdin.isTTY);
const TTY_OUT = Boolean(process.stdout.isTTY);

const COLOR = !process.env.NO_COLOR && (TTY_OUT || Boolean(process.env.HUB_COLOR));
const E = (c) => (COLOR ? `\x1b[${c}m` : '');
const BLUE = E('38;5;39'), TEAL = E('38;5;44'), GREEN = E('38;5;48'), MINT = E('38;5;121');
const GRAY = E('38;5;245'), WHITE = E('97'), YEL = E('38;5;221'), RED = E('38;5;203');
const B = E('1'), N = E('0');
const GRAD = COLOR ? [39, 38, 44, 43, 49, 48, 84] : [];

function gradient(text) {
  if (!GRAD.length) return text;
  const ch = [...text];
  return B + ch.map((c, i) => `\x1b[38;5;${GRAD[Math.floor((i * GRAD.length) / ch.length)]}m${c}`).join('') + N;
}

const out = (s) => process.stdout.write(s);
const echo = (s = '') => process.stdout.write(s + '\n');
const warnErr = (s) => process.stderr.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad(text, w) {
  const ch = [...String(text)].slice(0, w);
  return ch.join('') + ' '.repeat(Math.max(0, w - ch.length));
}
const padEnd = (text, w) => String(text) + ' '.repeat(Math.max(0, w - [...String(text)].length));
const num2 = (n) => String(n).padStart(2);
const splitWords = (s) => String(s || '').split(/\s+/).filter(Boolean);

// Textos vindos de repositórios de terceiros: sem sequências de controle do terminal.
const plain = (s) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

function truncateDesc(desc, max) {
  if (desc.length <= max) return desc;
  let d = desc.slice(0, max - 1);
  const sp = d.lastIndexOf(' ');
  if (sp >= 0) d = d.slice(0, sp);
  return d + '…';
}

function shq(s) {
  if (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s)) return s;
  return IS_WIN ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveExe(cmd, o) {
  if (!cmd) return '';
  const p = o.pathMod;
  const exts = o.isWin ? String(o.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const tryBase = (b) => {
    if (o.isWin) {
      if (p.extname(b) && o.isFile(b)) return b;
      for (const e of exts) if (o.isFile(b + e)) return b + e;
      return '';
    }
    return o.isFile(b) ? b : '';
  };
  if (/[\\/]/.test(cmd) || (o.isWin && /^[A-Za-z]:/.test(cmd))) return tryBase(p.resolve(cmd));
  for (const d of String(o.PATH || '').split(o.isWin ? ';' : ':')) {
    if (!d) continue;
    if (o.skipWinSide && /^\/mnt\/[a-z]\//.test(d)) continue;
    const f = tryBase(p.join(d.replace(/^"(.*)"$/, '$1'), cmd));
    if (f) return f;
  }
  return '';
}
function isExecFile(f) {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (!IS_WIN) fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch { return false; }
}
const findExe = (cmd) => resolveExe(cmd, { isWin: IS_WIN, pathMod: path, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, isFile: isExecFile, skipWinSide: IS_WSL });

let ACC = [];
const byName = new Map();

function loadConfig() {
  ACC = [];
  byName.clear();
  let text;
  try { text = fs.readFileSync(CONFIG, 'utf8'); } catch { return; }
  const seen = new Map();
  const order = [];
  let cur = null;
  let n = 0;
  for (const raw of text.split('\n')) {
    n++;
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) {
      if (seen.has(m[1])) {
        warnErr(`aviso: conta "${m[1]}" repetida no config (linha ${n}): vale a primeira`);
        cur = null;
        continue;
      }
      cur = { name: m[1], label: m[1], command: '', args: '', envText: '', install: '', rawType: '' };
      seen.set(m[1], cur);
      order.push(cur);
      continue;
    }
    if (!cur || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === 'label') cur.label = value;
    else if (key === 'command') cur.command = lib.expandHome(value);
    else if (key === 'args') cur.args = value;
    else if (key === 'env') cur.envText = value;
    else if (key === 'install') cur.install = value;
    else if (key === 'type') cur.rawType = value;
    else warnErr(`aviso: chave desconhecida "${key}" (linha ${n})`);
  }
  for (const c of order) {
    if (!c.command) {
      warnErr(`aviso: conta "${c.name}" sem command no config: ignorada`);
      continue;
    }
    const env = {};
    const envList = [];
    for (const pair of splitWords(c.envText)) {
      const j = pair.indexOf('=');
      if (j <= 0) continue;
      env[pair.slice(0, j)] = pair.slice(j + 1);
      envList.push([pair.slice(0, j), lib.expandHome(pair.slice(j + 1))]);
    }
    const a = { name: c.name, label: c.label, command: c.command, args: c.args, install: c.install, env, envList };
    a.type = lib.effectiveType({ ...a, type: lib.TYPES.includes(c.rawType) ? c.rawType : lib.inferType(a) });
    ACC.push(a);
    byName.set(a.name, a);
  }
}

const installed = (a) => findExe(a.command) !== '';
const envVal = (a, key) => { let v = ''; for (const [k, x] of a.envList) if (k === key) v = x; return v; };
const accountEnv = (a) => Object.assign({}, process.env, Object.fromEntries(a.envList));
const isBedrock = (a) => a.type === 'bedrock';

function missing(names) {
  const list = names && names.length ? names : ACC.map((a) => a.name);
  const seen = new Set();
  const res = [];
  for (const n of list) {
    const a = byName.get(n);
    if (!a || installed(a) || seen.has(a.command)) continue;
    seen.add(a.command);
    res.push(a);
  }
  return res;
}

const IN = { buf: '', eof: false, wake: null, on: false, intr: false };
let CHILD = false; // uma CLI está aberta: o Ctrl+C é dela
let IGNORE_INT = false; // abrindo uma conta: Ctrl+C só cancela a pergunta
let CURSOR_HIDDEN = false;

function poke() { const w = IN.wake; IN.wake = null; if (w) w(); }
function inputOn(raw) {
  if (!IN.on) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { IN.buf += d; poke(); });
    process.stdin.on('end', () => { IN.eof = true; poke(); });
    process.stdin.on('error', () => { IN.eof = true; poke(); });
    IN.on = true;
  }
  if (TTY_IN) process.stdin.setRawMode(Boolean(raw));
  process.stdin.resume();
}
function inputOff() {
  if (!IN.on) return;
  process.stdin.pause();
  if (TTY_IN) { try { process.stdin.setRawMode(false); } catch {} }
}
function waitInput(ms) {
  return new Promise((res) => {
    let t = null;
    IN.wake = () => { if (t) clearTimeout(t); res(true); };
    if (ms != null) t = setTimeout(() => { IN.wake = null; res(false); }, ms);
  });
}
function takeChar() {
  const len = IN.buf.codePointAt(0) > 0xffff ? 2 : 1;
  const c = IN.buf.slice(0, len);
  IN.buf = IN.buf.slice(len);
  return c;
}
function cursor(mode) {
  if (!TTY_OUT) return;
  CURSOR_HIDDEN = mode === 'civis';
  out(CURSOR_HIDDEN ? '\x1b[?25l' : '\x1b[?25h');
}
function restoreTerminal() {
  if (TTY_OUT && CURSOR_HIDDEN) { process.stdout.write('\x1b[?25h'); CURSOR_HIDDEN = false; }
  if (TTY_IN && IN.on) { try { process.stdin.setRawMode(false); } catch {} }
}
function exitNow(code) { restoreTerminal(); process.exit(code); }
process.on('exit', restoreTerminal);
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e.code === 'EPIPE') process.exit(141); throw e; });
process.on('SIGINT', () => {
  if (CHILD) return;
  if (IGNORE_INT) { IN.intr = true; process.stderr.write('\n'); poke(); return; }
  exitNow(130);
});
process.on('SIGTERM', () => exitNow(143));
function ctrlC() {
  if (IGNORE_INT) return null;
  exitNow(130);
  return null;
}

async function readKey() {
  inputOn(true);
  while (!IN.buf) {
    if (IN.eof) return null;
    await waitInput();
  }
  let k = takeChar();
  if (k === '\x03') return ctrlC();
  if (k === '\x1b') {
    const until = Date.now() + 150;
    while (IN.buf.length < 2 && !IN.eof) {
      const left = until - Date.now();
      if (left <= 0) break;
      await waitInput(left);
    }
    k += IN.buf.slice(0, 2);
    IN.buf = IN.buf.slice(2);
  }
  if (k === '\r' || k === '\n') return '';
  return k;
}
async function readCharWithin(ms) {
  inputOn(true);
  const until = Date.now() + ms;
  while (!IN.buf) {
    if (IN.eof) return null;
    const left = until - Date.now();
    if (left <= 0) return null;
    await waitInput(left);
  }
  const c = takeChar();
  return c === '\x03' ? ctrlC() : c;
}
async function readLine(prompt, silent = false) {
  if (TTY_IN) process.stderr.write(prompt);
  inputOn(TTY_IN);
  IN.intr = false;
  if (!TTY_IN) {
    for (;;) {
      const i = IN.buf.indexOf('\n');
      if (i >= 0) {
        const line = IN.buf.slice(0, i).replace(/\r$/, '');
        IN.buf = IN.buf.slice(i + 1);
        return line;
      }
      if (IN.intr) { IN.intr = false; return null; }
      if (IN.eof) return null;
      await waitInput();
    }
  }
  let line = '';
  for (;;) {
    while (!IN.buf) {
      if (IN.eof) return null;
      if (IN.intr) { IN.intr = false; return null; }
      await waitInput();
    }
    const c = takeChar();
    if (c === '\x03') return ctrlC();
    if (c === '\r' || c === '\n') { process.stderr.write('\n'); return line; }
    if (c === '\x1b') {
      const until = Date.now() + 60;
      while (!IN.buf && Date.now() < until && !IN.eof) await waitInput(until - Date.now());
      if (IN.buf[0] === '[' || IN.buf[0] === 'O') { IN.buf = IN.buf.replace(/^[[O][0-9;]*[A-Za-z~]/, ''); continue; }
      process.stderr.write('\n');
      return null;
    }
    if (c === '\x7f' || c === '\b') {
      if (line) { line = [...line].slice(0, -1).join(''); if (!silent) process.stderr.write('\b \b'); }
      continue;
    }
    if (c === '\x15') { if (!silent) process.stderr.write('\b \b'.repeat([...line].length)); line = ''; continue; }
    if (c < ' ') continue;
    line += c;
    if (!silent) process.stderr.write(c);
  }
}
async function ask(q) {
  if (!TTY_IN) return false;
  const r = await readLine(`${q} [S/n] `);
  if (r === null) return false;
  const t = r.trim();
  return t === '' || /^[sSyY]/.test(t);
}
async function pause() {
  if (!TTY_IN) return;
  await readLine(`${GRAY}  Enter ou Esc para voltar ao menu${N}`, true);
  echo();
}
function clearScreen() { if (TTY_OUT) out('\x1b[H\x1b[2J'); }
// Redesenha por cima, sem limpar a tela: limpar a cada tecla faz a tela piscar.
// Nunca escreve mais linhas do que a altura do terminal: se passar, o terminal rola e
// cada redesenho empurra o topo (o mascote) para o histórico, duplicando-o no scroll.
const termRows = () => (TTY_OUT && process.stdout.rows) || 0;
function fitRows(s) {
  const rows = termRows();
  const lines = s.split('\n');
  if (!rows || lines.length <= rows) return s;
  // mantém visível a linha em foco: o prompt de comando ou o item selecionado
  let focus = lines.findIndex((l) => l.includes('▏'));
  if (focus < 0) focus = lines.findIndex((l) => l.includes('❯'));
  let start = 0;
  if (focus >= rows - 1) start = Math.min(focus - rows + 2, lines.length - rows);
  return lines.slice(start, start + rows).join('\n');
}
const paintText = (s) => '\x1b[H' + fitRows(s).replace(/\n/g, '\x1b[K\n') + '\x1b[K\x1b[J';
let LAST_PAINT = null;
const paint = (s) => { LAST_PAINT = s; out(paintText(s)); };
if (TTY_OUT) process.stdout.on('resize', () => { if (LAST_PAINT !== null) out(paintText(LAST_PAINT)); });

function spawnFail(file, e) {
  warnErr(`hub: não consegui executar "${file}": ${e.code === 'ENOENT' ? 'comando não encontrado' : e.message}`);
  return 127;
}
async function runChild(file, argv, env, extra = {}) {
  inputOff();
  CHILD = true;
  try {
    return await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn(file, argv, Object.assign({ stdio: 'inherit', env: env || process.env }, extra));
      } catch (e) { finish(spawnFail(file, e)); return; }
      child.on('error', (e) => finish(spawnFail(file, e)));
      child.on('exit', (code, sig) => finish(code != null ? code : 128 + ((sig && os.constants.signals[sig]) || 1)));
    });
  } finally { CHILD = false; }
}
// No Windows, os .cmd do npm passam pelo cmd.exe.
const runCli = (cmd, args, env) => { const [f, a, o] = lib.spawnArgs(cmd, args); return runChild(f, a, env, o); };
const runShellLine = (line, env) => { const [f, a, o] = lib.shellArgs(line); return runChild(f, a, env, o); };
// Roda uma linha de instalação mostrando a saída ao vivo e guardando o final dela: é o que o motor de
// instalação (lib.performInstall) lê para reconhecer falhas com conserto. O teclado continua no filho (senha do sudo).
async function teeExec(line) {
  const [f, a, o] = lib.shellArgs(line);
  inputOff();
  CHILD = true;
  try {
    return await new Promise((resolve) => {
      let so = '', se = '', done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const env = Object.assign({}, process.env, COLOR ? { FORCE_COLOR: '1', npm_config_color: 'always' } : {});
      let child;
      try { child = spawn(f, a, Object.assign({ stdio: ['inherit', 'pipe', 'pipe'], env }, o)); }
      catch (e) { finish({ ok: false, code: spawnFail(f, e), stdout: '', stderr: String(e.message) }); return; }
      child.stdout.on('data', (d) => { process.stdout.write(d); so = (so + d).slice(-65536); });
      child.stderr.on('data', (d) => { process.stderr.write(d); se = (se + d).slice(-65536); });
      child.on('error', (e) => finish({ ok: false, code: spawnFail(f, e), stdout: so, stderr: se + String(e.message) }));
      child.on('close', (code, sig) => {
        const c = code != null ? code : 128 + ((sig && os.constants.signals[sig]) || 1);
        finish({ ok: c === 0, code: c, stdout: so, stderr: se });
      });
    });
  } finally { CHILD = false; }
}
// Recados do motor de instalação, no formato do terminal.
const installSay = (text, kind) => echo(kind === 'cmd' ? `  ${TEAL}→${N} ${text}` : kind === 'warn' ? `  ${YEL}!${N} ${text}` : `  ${GRAY}${text}${N}`);
const installVia = (a, verb, info) => lib.performInstall(a, { verb, info, interactive: TTY_IN, exec: teeExec, say: installSay });

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
async function spinRun(msg, promise) {
  let i = 0;
  const frame = () => out(`\r  ${TEAL}${FRAMES[i++ % 10]}${N} ${msg}`);
  let t = null;
  if (TTY_OUT) { frame(); t = setInterval(frame, 80); }
  try { return await promise; } finally {
    if (t) clearInterval(t);
    if (TTY_OUT) out('\r\x1b[K');
  }
}
async function updateStep(msg, fn) {
  const r = await spinRun(`${msg}…`, Promise.resolve().then(fn));
  if (r && r.ok) { echo(`  ${GREEN}✓${N} ${msg}`); return true; }
  echo(`  ${RED}✗${N} ${msg}`);
  const lines = `${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`.split('\n').filter((l) => l.trim());
  for (const l of lines.slice(-5)) echo(`    ${GRAY}${l}${N}`);
  return false;
}
function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms); })])
    .finally(() => clearTimeout(t));
}

const mascotText = (face, m1, m2) => [
  `        ${MINT}●${N}`,
  `    ${TEAL}╭───┴───╮${N}   ${gradient('Agent Hub')}`,
  `    ${TEAL}│${N} ${WHITE}${B}${face}${N} ${TEAL}│${N}   ${m1}`,
  `    ${TEAL}╰─┬───┬─╯${N}   ${m2}`,
  `      ${BLUE}╵   ╵${N}`,
].join('\n') + '\n';
const mascot = (face, m1, m2) => out(mascotText(face, m1, m2));

function nameWidth() {
  let w = 12;
  for (const a of ACC) if ([...a.name].length > w) w = [...a.name].length;
  return w > 24 ? 24 : w;
}

async function installMissing(names = [], opts = {}) {
  for (const n of names) if (!byName.has(n)) { warnErr(`${RED}✗${N} conta desconhecida: ${n}`); return 1; }
  const miss = missing(names);
  const how = new Map();
  for (const a of miss) how.set(a, await lib.resolveInstall(a, null));
  const todo = miss.filter((a) => how.get(a).cmd);
  const manual = miss.filter((a) => !how.get(a).cmd);
  if (!ACC.length) {
    echo(`${YEL}!${N} nenhuma conta cadastrada: cadastre pela interface (${B}/ui${N} no menu)`);
    return 0;
  }
  if (!todo.length && !manual.length) {
    echo(`${GREEN}✓${N} todas as CLIs cadastradas já estão instaladas`);
    return 0;
  }
  for (const a of manual) echo(`${YEL}!${N} ${a.command} (${a.name}): ${how.get(a).note || `sem instalador conhecido: instale manualmente ou defina ${B}install = …${N} no config`}`);
  if (!todo.length) return 0;
  echo(`${B}Vou instalar:${N}`);
  for (const a of todo) {
    const h = how.get(a);
    echo(`  ${padEnd(a.command, 8)} ${GRAY}via ${h.label}: ${h.cmd}${N}`);
    if (h.note) echo(`  ${' '.repeat(8)} ${YEL}${h.note}${N}`);
  }
  if (!process.env.HUB_YES && !opts.yes && !(await ask('Continuar?'))) {
    echo('cancelado');
    return 1;
  }
  for (const a of todo) {
    echo(`${TEAL}→${N} ${B}${a.command}${N}`);
    // o motor escolhe o meio, conserta o que tem conserto (sobras do npm, cache, rede…) e tenta outro meio se este falhar
    const r = await installVia(a, 'instalar', null);
    if (!r.ok) { echo(`${RED}✗${N} não consegui instalar ${a.command}: ${r.brief}`); continue; }
    echo(`${GREEN}✓${N} ${a.command} instalado via ${r.how.label}${r.exe ? ` ${GRAY}(${lib.homeRel(r.exe)})${N}` : ''}: no primeiro uso, faça login dentro dele`);
  }
  return 0;
}

// Como a conta foi instalada, a partir do executável que este terminal enxerga no PATH.
const howInstalled = (a) => lib.resolveInstall(a, lib.installInfoFrom(a.command, findExe(a.command)));

async function versionOf(cmd) {
  const r = await lib.run(cmd, ['--version'], 10000);
  const m = String(r.stdout || '').match(/[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.-]*/);
  return m ? m[0] : '';
}

async function updateInstalled(names = []) {
  const todo = [];
  const seen = new Set();
  for (const a of ACC) {
    if (names.length && !names.includes(a.name)) continue;
    if (!installed(a) || seen.has(a.command)) continue;
    seen.add(a.command);
    todo.push(a);
  }
  if (!todo.length) {
    echo(`${YEL}!${N} nenhuma CLI cadastrada está instalada ainda: use ${B}/install${N}`);
    return 0;
  }
  echo(`${B}Atualizando para a versão mais recente:${N}`);
  for (const a of todo) {
    if (a.command === 'agy') {
      echo(`${TEAL}→${N} agy ${GRAY}(${(await versionOf('agy')) || 'versão desconhecida'})${N}  ${GRAY}se atualiza sozinho em segundo plano ao ser usado${N}`);
      continue;
    }
    // atualiza pelo mesmo meio em que a CLI foi instalada (npm, Homebrew, instalador oficial…)
    const h = await howInstalled(a);
    const before = await versionOf(a.command);
    echo(`${TEAL}→${N} ${a.command} ${GRAY}(${before || 'versão desconhecida'} · ${(lib.installInfoFrom(a.command, findExe(a.command)) || h).label}${h.path ? ` · ${lib.homeRel(h.path)}` : ''})${N}`);
    if (!h.cmd) { echo(`  ${YEL}!${N} ${h.note || `sem comando de atualização: defina ${B}install = …${N} no config`}`); continue; }
    // saída ao vivo: dá para ver o erro real e digitar a senha do sudo se precisar
    const r = await installVia(a, 'atualizar', lib.installInfoFrom(a.command, findExe(a.command)));
    if (r.ok) {
      const after = await versionOf(a.command);
      if (r.how.migrateFrom) echo(`  ${GREEN}✓${N} migrado para ${r.how.label}: ${before || '?'} → ${B}${after || '?'}${N}`);
      else if (before && before === after) echo(`  ${GREEN}✓${N} já estava na mais recente (${after})`);
      else echo(`  ${GREEN}✓${N} atualizado: ${before || '?'} → ${B}${after || '?'}${N}`);
    } else {
      echo(`  ${RED}✗${N} ${r.brief}`);
    }
  }
  return 0;
}

async function bedrockModelsUpdate(names = []) {
  for (const a of ACC) {
    if (names.length && !names.includes(a.name)) continue;
    if (!isBedrock(a)) continue;
    echo(`${TEAL}→${N} modelos do Bedrock de ${B}${a.label}${N}`);
    let r;
    try { r = await withTimeout(lib.bedrockApply(a.name), 90000); } catch (e) { r = e && e.timeout ? null : { error: e.message }; }
    if (!r) { echo(`  ${RED}✗${N} não consegui consultar a AWS`); continue; }
    if (r.error) { echo(`  ${RED}✗${N} ${r.error}`); continue; }
    for (const c of r.applied || []) echo(`  ${GREEN}✓${N} ${c}`);
    if (!(r.applied || []).length) echo(`  ${GREEN}✓${N} já estavam no mais recente ${GRAY}(${r.region} · ${r.file})${N}`);
    for (const x of r.rows || []) if (x.status === 'missing') echo(`  ${GRAY}○ ${x.family}: nenhum modelo disponível nesta conta/região${N}`);
    for (const x of r.rows || []) if (x.status === 'managed') echo(`  ${GRAY}○ ${x.key}: fixado pela organização em ${r.managedFile || 'managed-settings.json'}: o hub não altera${N}`);
  }
  return 0;
}

// Modelos fixados das demais ferramentas (Claude de assinatura, Codex, Gemini, Copilot): confere na fonte oficial
// de cada uma e troca só o que estava preso numa versão antiga. Bedrock fica com bedrockModelsUpdate.
async function modelsUpdate(names = []) {
  for (const a of ACC) {
    if (names.length && !names.includes(a.name)) continue;
    if (isBedrock(a) || !['claude', 'codex', 'gemini', 'copilot'].includes(a.type)) continue;
    let r;
    try { r = await withTimeout(lib.modelsApply(a.name), 60000); } catch (e) { r = e && e.timeout ? { error: 'a consulta demorou demais' } : { error: e.message }; }
    echo(`${TEAL}→${N} modelos de ${B}${a.label}${N}${r && r.source ? ` ${GRAY}(${r.source})${N}` : ''}`);
    if (!r || r.error) { echo(`  ${RED}✗${N} ${(r && r.error) || 'não consegui conferir'}`); continue; }
    for (const c of r.applied || []) echo(`  ${GREEN}✓${N} ${c} ${GRAY}· ${r.file}${N}`);
    const rows = r.rows || [];
    for (const x of rows) if (x.note && ['advice', 'managed', 'unknown'].includes(x.status)) echo(`  ${YEL}!${N} ${x.label}: ${x.note}`);
    if (!(r.applied || []).length && rows.some((x) => x.status === 'ok' || x.status === 'ahead')) echo(`  ${GREEN}✓${N} já estavam no mais recente ${GRAY}(${r.file})${N}`);
    else if (!(r.applied || []).length && rows.every((x) => x.status === 'auto')) echo(`  ${GRAY}○ nada fixado: acompanha a versão da CLI${N}`);
  }
  return 0;
}

const DEFAULT_DIR_LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', copilot: 'Copilot', agents: 'Pasta universal' };
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function skillTargets() {
  const res = [];
  for (const t of lib.skillTargets()) {
    const accs = t.accounts.filter((x) => byName.has(x.name));
    if (t.accounts.length && !accs.length) continue;
    let label, accts;
    if (accs.length) {
      label = accs.map((x) => byName.get(x.name).label).join(', ');
      accts = accs.map((x) => x.name);
    } else {
      label = `${DEFAULT_DIR_LABEL[t.tool] || t.tool} (padrão)`;
      // ~/.agents/skills é lida por Codex, Gemini CLI e Copilot (o Claude Code não lê)
      accts = t.tool === 'agents' ? ACC.filter((a) => ['codex', 'gemini', 'copilot'].includes(a.command)).map((a) => a.name) : [];
    }
    res.push({ dir: t.dir, display: t.display, tool: t.tool, label, accts, skills: t.skills });
  }
  return res;
}

function installedSkills(targets) {
  const map = new Map();
  targets.forEach((t, i) => {
    for (const s of t.skills) {
      const e = map.get(s.folder) || { name: plain(s.folder), desc: '', idx: [] };
      e.desc = e.desc || plain(String(s.description || '').replace(/\n/g, ' '));
      e.idx.push(i);
      map.set(s.folder, e);
    }
  });
  return [...map.values()];
}

// Forma oficial de cada CLI abrir já usando a skill; sempre lista, sem shell (o "$" do Codex seria expandido).
function skillPromptArgs(cmd, skill) {
  switch (cmd) {
    case 'claude': return ['--', `/${skill}`];
    // menção $nome só vale para [A-Za-z0-9_:-]
    case 'codex': return /^[A-Za-z0-9_:-]+$/.test(skill) ? ['--', `$${skill} use esta skill`] : ['--', `Use a skill ${skill}`];
    case 'gemini': return [`--prompt-interactive=/${skill}`];
    case 'copilot': case 'agy': return ['-i', `/${skill}`];
    default: return [`Use a skill ${skill}`];
  }
}

async function pick(title, foot, items) {
  let sel = 0;
  const n = items.length;
  cursor('civis');
  for (;;) {
    let o = `\n  ${GRAY}${B}${title}${N}\n\n`;
    items.forEach((it, i) => {
      const [l, ...more] = it;
      o += i === sel ? `  ${GREEN}${B}❯${N} ${TEAL}${num2(i + 1)}${N}  ${B}${l}${N}\n` : `    ${TEAL}${num2(i + 1)}${N}  ${l}\n`;
      for (const x of more) if (x) o += `        ${GRAY}${x}${N}\n`;
      o += '\n';
    });
    o += `  ${GRAY}${foot}${N}`;
    paint(o);
    const k = await readKey();
    if (k === null) return -1;
    if (k === '\x1b[A' || k === 'k') { if (sel > 0) sel--; }
    else if (k === '\x1b[B' || k === 'j') { if (sel < n - 1) sel++; }
    else if (k === '') return sel;
    else if (/^[1-9]$/.test(k)) {
      let s = k;
      if (n > 9) { const k2 = await readCharWithin(600); if (k2 && /^[0-9]$/.test(k2)) s += k2; }
      const i = Number(s);
      if (i <= n) return i - 1;
    } else if (k === '\x1b') return -1;
  }
}

let SKILL_DONE = '';
let SKILL_ACC_LABEL = '';
const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot CLI', agy: 'Antigravity' };

async function skillRun(skill, names) {
  const accs = [...new Set(names)].filter((n) => byName.has(n));
  if (!accs.length) {
    echo(`${YEL}!${N} nenhuma conta do hub usa a pasta onde ${B}${skill}${N} está: instale-a numa conta pelo /ui ou /skills`);
    return 1;
  }
  let acc = accs[0];
  if (accs.length > 1 && TTY_IN && TTY_OUT) {
    const opts = accs.map((n) => { const a = byName.get(n); return [a.label, `${TOOL_NAME[a.command] || a.command} · hub ${n}`]; });
    const p = await pick(`ABRIR ${skill.toUpperCase()} EM QUAL CONTA?`, 'escolha com ↑ ↓ e aperte Enter · ou o número · Esc volta', opts);
    if (p < 0) { SKILL_DONE = 'back'; return 0; }
    acc = accs[p];
    clearScreen();
  } else if (accs.length > 1) {
    out(`\n  ${B}Abrir ${skill} em qual conta?${N}\n`);
    accs.forEach((n, i) => out(`  ${TEAL}${num2(i + 1)}${N}  ${padEnd(n, 16)} ${GRAY}${byName.get(n).label}${N}\n`));
    const r = ((await readLine('  › ')) || '').trim();
    const k = /^[0-9]+$/.test(r) ? parseInt(r, 10) : 0;
    if (!(k >= 1 && k <= accs.length)) { echo('  cancelado'); return 0; }
    acc = accs[k - 1];
  }
  const a = byName.get(acc);
  echo(`${TEAL}→${N} abrindo ${B}${a.label}${N} com a skill ${B}${skill}${N}`);
  SKILL_ACC_LABEL = a.label;
  const code = await launch(acc, skillPromptArgs(a.command, skill));
  if (code === 0) SKILL_DONE = 'ok';
  return code;
}

async function skillInstallDeps(folders, source = '') {
  const opts = source ? { source } : {};
  let r;
  try { r = await lib.checkDeps(folders, opts); } catch (e) { r = { deps: [], steps: [], compat: {}, origin: {} }; out(`    ${YEL}!${N} não consegui conferir as dependências: ${e.message}\n`); }
  const steps = Array.isArray(r.steps) ? r.steps : [];
  for (const [f, text] of Object.entries(r.compat || {})) out(`    ${GRAY}${folders.length > 1 ? `${f}: ` : ''}compatibilidade declarada: ${plain(text).slice(0, 200)}${N}\n`);
  if (!r.deps.length) {
    const inferred = Object.values(r.origin || {}).includes('inferida');
    out(`    ${GRAY}${inferred ? 'nenhuma dependência encontrada nos arquivos da skill' : 'nenhuma dependência extra'}${N}\n`);
  } else {
    if (r.inferred) out(`    ${GRAY}deduzidas dos arquivos da skill (manifestos, scripts e SKILL.md)${N}\n`);
    for (const d of r.deps) {
      const why = d.inferred && d.evidence && d.evidence.length ? ` ${GRAY}· ${plain(d.evidence[0]).slice(0, 70)}${N}` : '';
      if (d.ok) out(`    ${GREEN}✓${N} ${d.label}${why}\n`);
      else if (d.optional) out(`    ${GRAY}○${N} ${d.label} ${GRAY}(opcional)${N}${why}\n`);
      else out(`    ${RED}✗${N} ${d.label}${why}\n`);
    }
  }
  if (steps.length) {
    out(`    ${B}Depois de instalar${N} ${GRAY}(o SKILL.md pede; o hub não faz sozinho)${N}\n`);
    for (const s of steps) out(`    ${YEL}·${N} ${folders.length > 1 ? `${s.skill}: ` : ''}${plain(s.title)}${s.cmd ? ` ${GRAY}→ ${plain(s.cmd)}${N}` : ''}${s.detail ? ` ${GRAY}(${plain(s.detail)})${N}` : ''}\n`);
  }
  if (!r.deps.length) return;
  const need = r.deps.filter((d) => !d.ok && !d.optional);
  for (const d of need.filter((x) => x.how === 'manual')) {
    const why = d.manual ? `${d.label}: ${d.manual}`
      : d.type === 'py' ? `${d.label} (precisa do pip: python3 -m ensurepip --user)`
        : d.type === 'npm' ? `${d.label} (precisa do Node.js/npm: https://nodejs.org)`
          : d.type === 'bin' && IS_MAC ? `${d.label} (instale o Homebrew em https://brew.sh e rode /skills de novo)`
            : `${d.label} (pelo gerenciador de pacotes do seu sistema${d.apt ? `, pacote parecido com ${d.apt}` : ''})`;
    out(`    ${YEL}!${N} instale à parte: ${why}\n`);
  }
  const viaLib = need.some((d) => ['pip', 'npm', 'brew'].includes(d.how));
  const sysArgs = Array.isArray(r.sysArgs) ? r.sysArgs : [];
  const npmArgs = Array.isArray(r.npmArgs) ? r.npmArgs : [];
  if (!sysArgs.length && !npmArgs.length && !viaLib) return;
  echo();
  if (!(await ask('  Instalar as dependências que faltam antes da skill?'))) {
    out(`  ${YEL}!${N} seguindo sem elas: a skill pode não funcionar por completo\n`);
    return;
  }
  // programas do sistema: apt, dnf, zypper, pacman, apk (com sudo) ou winget (sem sudo); saída ao vivo para a senha
  if (sysArgs.length) {
    out(`  ${TEAL}→${N} programas do sistema: ${B}${r.sysCommand}${N}\n`);
    const code = r.sysSudo ? await runCli('sudo', sysArgs, process.env) : await runCli(sysArgs[0], sysArgs.slice(1), process.env);
    if (code === 0) out(`  ${GREEN}✓${N} programas do sistema instalados\n`);
    else out(`  ${RED}✗${N} não consegui instalar os programas do sistema (código ${code})\n`);
    if (need.some((d) => d.how === 'needs-pip')) {
      // agora com pip, os módulos Python podem entrar pelo hub
      try { r = await lib.checkDeps(folders, opts); } catch { r = { deps: [] }; }
    }
  }
  // pacotes Node com npm global do root
  if (npmArgs.length) {
    out(`  ${TEAL}→${N} pacotes Node: ${B}${r.npmCommand}${N}\n`);
    if ((await runCli('sudo', npmArgs, process.env)) === 0) out(`  ${GREEN}✓${N} pacotes Node instalados\n`);
    else out(`  ${RED}✗${N} não consegui instalar os pacotes Node\n`);
  }
  if (viaLib || r.deps.some((d) => !d.ok && !d.optional && d.how === 'pip')) {
    let res;
    try { res = await spinRun('instalando as dependências…', lib.installDeps(folders, false, opts)); } catch (e) { res = { log: [`falhou: ${e.message}`] }; }
    for (const l of res.log || []) out(`  ${/falhou/.test(l) ? `${RED}✗` : `${GREEN}✓`}${N} ${l}\n`);
  }
}

async function skillsMenu() {
  const T = skillTargets();
  if (!T.length) {
    echo(`${YEL}!${N} cadastre uma conta primeiro (${B}/ui${N}): as skills ficam nas pastas das contas`);
    return 0;
  }
  const rows = installedSkills(T);
  const width = process.stdout.columns || process.stderr.columns || 100;
  const whereOf = (r) => r.idx.map((i) => T[i].label).join(' · ');
  const accsOf = (r) => r.idx.flatMap((i) => T[i].accts);
  let src;
  if (TTY_IN && TTY_OUT) {
    const items = rows.map((r) => [r.name, truncateDesc(r.desc, width - 12), `em: ${whereOf(r)}`]);
    items.push([`${GREEN}＋${N} Instalar uma skill nova`, 'cole um repositório do GitHub (ex.: cloudflare/security-audit-skill)']);
    const p = await pick(`SKILLS INSTALADAS · ${rows.length}`, 'escolha com ↑ ↓ e aperte Enter para abrir a CLI já usando a skill · ou o número · Esc volta', items);
    if (p < 0) { SKILL_DONE = 'back'; return 0; }
    if (p < rows.length) {
      clearScreen();
      return skillRun(rows[p].name, accsOf(rows[p]));
    }
    cursor('cnorm');
    out('\n');
    src = ((await readLine('  Repositório do GitHub (Esc cancela): ')) || '').trim();
    if (!src) { SKILL_DONE = 'back'; return 0; }
  } else {
    out(`\n  ${GRAY}${B}SKILLS INSTALADAS${N} ${GRAY}· ${rows.length}${N}\n\n`);
    if (!rows.length) out(`    ${GRAY}nenhuma ainda: cole um repositório do GitHub abaixo para instalar${N}\n`);
    rows.forEach((r, k) => {
      out(`  ${TEAL}${num2(k + 1)}${N}  ${B}${r.name}${N}\n`);
      if (r.desc) out(`      ${GRAY}${truncateDesc(r.desc, width - 8)}${N}\n`);
      out(`      ${GRAY}em:${N} ${whereOf(r)}\n\n`);
    });
    if (!TTY_IN) return 0;
    out(`  ${GRAY}# número: abre a CLI já usando a skill · cole um repositório do GitHub para instalar · Enter volta${N}\n`);
    src = ((await readLine('  › ')) || '').trim();
    if (!src) return 0;
    if (/^[0-9]+$/.test(src)) {
      const k = parseInt(src, 10) - 1;
      if (k < 0 || k >= rows.length) { echo(`${RED}✗${N} não há skill ${src}`); return 1; }
      return skillRun(rows[k].name, accsOf(rows[k]));
    }
  }
  return installSkillFrom(src, T);
}

async function installSkillFrom(src, T) {
  let parsed;
  try { parsed = lib.parseSource(src); } catch {
    echo(`${RED}✗${N} use o formato dono/repositório ou um link do GitHub`);
    return 1;
  }
  const repo = parsed.label;
  echo(`${TEAL}→${N} baixando ${B}${repo}${N}…`);
  try {
    let fetched;
    try { fetched = await lib.fetchSource(src, { fresh: true }); } catch (e) {
      if (/^não consegui baixar/.test(e.message)) echo(`${RED}✗${N} não consegui baixar ${repo} (o repositório existe e é público?)`);
      else if (/^nenhuma skill/.test(e.message)) echo(`${RED}✗${N} nenhuma skill (SKILL.md) encontrada em ${repo}${parsed.sub ? `/${parsed.sub}` : ''}`);
      else echo(`${RED}✗${N} ${e.message}`);
      return 1;
    }
    let found = [...fetched.skills].sort((x, y) => (x.dir < y.dir ? -1 : x.dir > y.dir ? 1 : 0));
    if (found.length > 1) {
      out(`\n  ${B}${found.length} skills em ${repo}:${N}\n`);
      found.forEach((s, i) => out(`  ${TEAL}${num2(i + 1)}${N}  ${plain(s.folder)}\n`));
      const typed = await readLine('  Quais instalar? (números separados por espaço · Enter = todas · Esc cancela): ');
      if (typed === null) { out('  cancelado\n'); lib.dropSources?.(); return; }
      const choice = typed;
      if (choice.trim()) {
        const chosen = [];
        for (const w of splitWords(choice)) {
          if (!/^[0-9]+$/.test(w)) continue;
          const i = parseInt(w, 10);
          if (i >= 1 && i <= found.length && !chosen.includes(found[i - 1])) chosen.push(found[i - 1]);
        }
        if (!chosen.length) { echo('  nenhuma escolha válida: cancelado'); return 0; }
        found = chosen;
      }
    }
    echo(`  encontrada(s): ${B}${found.map((s) => plain(s.folder) + ' ').join('')}${N}`);
    echo(`  versão:        ${fetched.commit} · ${fetched.date} ${GRAY}(a mais recente, baixada agora)${N}`);
    const licenses = [...new Set(found.map((s) => plain(String(s.license || '')).trim()).filter(Boolean))];
    if (licenses.length) echo(`  licença:       ${licenses.join(', ')} ${GRAY}(declarada no SKILL.md)${N}`);
    echo(`  instalar em:   ${T.map((t) => t.label).join(' · ')}`);
    const folders = found.map((s) => s.folder);
    echo();
    out(`  ${B}Dependências${N}\n`);
    await skillInstallDeps(folders, src);
    echo();
    if (!(await ask('  Instalar a skill?'))) { echo('cancelado'); return 0; }
    for (const f of folders.filter((x) => !SKILL_NAME_RE.test(x))) echo(`${YEL}!${N} nome inválido, pulando: ${f}`);
    const ok = folders.filter((x) => SKILL_NAME_RE.test(x));
    if (!ok.length) return 0;
    try {
      const r = await lib.installSkills({ source: src, skills: ok, targets: T.map((t) => t.dir) });
      for (const f of r.installed) echo(`${GREEN}✓${N} ${B}${f}${N} instalada em ${r.targets.length} pasta(s): reabra a CLI para carregar`);
    } catch (e) {
      echo(`${RED}✗${N} ${e.message}`);
      return 1;
    }
    return 0;
  } finally {
    lib.dropSources();
  }
}

// login: lê só status e datas, nunca tokens
const LOGIN_STATE = new Map();
const LOGIN_DAYS = new Map();
const LOGIN_CMD = { claude: ['auth', 'login'], codex: ['login'], copilot: ['login'] };
const LOGIN_DIRS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME'];

async function loginInfo(a) {
  let st;
  try { st = await lib.loginStatus(a, true); } catch { st = { state: 'unknown' }; }
  return { state: st.state === 'unknown' ? '' : st.state, days: typeof st.days === 'number' && st.state === 'ok' ? st.days : null };
}
async function refreshLogin(a) {
  const st = await loginInfo(a);
  LOGIN_STATE.set(a.name, st.state);
  if (st.days == null) LOGIN_DAYS.delete(a.name); else LOGIN_DAYS.set(a.name, st.days);
}
async function refreshLogins() {
  LOGIN_STATE.clear();
  LOGIN_DAYS.clear();
  await Promise.all(ACC.filter(installed).map(refreshLogin));
}

// Modelos novos no Bedrock só entram se o ID for fixado no settings.json: ao abrir a conta, o hub confere
// (no máximo uma vez por dia por conta) e avisa; a troca em si fica para /update ou o botão da interface.
const BEDROCK_HINT_FILE = path.join(path.dirname(CONFIG), 'bedrock-models.json');
async function bedrockModelsHint(a) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(BEDROCK_HINT_FILE, 'utf8')) || {}; } catch {}
  const hit = cache[a.name];
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000 && !process.env.HUB_BEDROCK_RECHECK) {
    if (hit.changes) echo(`${YEL}!${N} modelos novos no Bedrock para ${B}${a.label}${N}: ${hit.what} ${GRAY}· rode /update para fixar${N}`);
    return;
  }
  let r = null;
  try { r = await withTimeout(lib.bedrockCheck(a.name), 20000); } catch { return; }
  if (!r) return;
  const what = (r.rows || []).filter((x) => x.status === 'new' || x.status === 'update').map((x) => x.latestLabel || x.family).join(', ');
  cache[a.name] = { at: Date.now(), changes: r.changes || 0, what };
  try { fs.mkdirSync(path.dirname(BEDROCK_HINT_FILE), { recursive: true, mode: 0o700 }); fs.writeFileSync(BEDROCK_HINT_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 }); } catch {}
  if (r.changes) echo(`${YEL}!${N} modelos novos no Bedrock para ${B}${a.label}${N}: ${what} ${GRAY}· rode /update para fixar no ${r.file}${N}`);
}

async function awsReady(a, env) {
  if (!isBedrock(a)) return true;
  const accEnv = { ...lib.awsEnvOf({ command: a.command, env: Object.fromEntries(a.envList) }), ...Object.fromEntries(a.envList) };
  const profile = accEnv.AWS_PROFILE || '';
  if (!findExe('aws')) {
    echo(`${YEL}!${N} AWS CLI não instalado: não dá para conferir as credenciais de ${a.label}`);
    return true;
  }
  const who = await lib.run('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], 15000, accEnv);
  if (who.ok) {
    echo(`${GREEN}✓${N} credenciais AWS ok ${GRAY}(perfil ${profile || 'padrão'} · conta ${who.stdout})${N}`);
    await bedrockModelsHint(a);
    return true;
  }
  const sso = profile && ((await lib.run('aws', ['configure', 'get', 'sso_start_url', '--profile', profile], 10000, accEnv)).ok
    || (await lib.run('aws', ['configure', 'get', 'sso_session', '--profile', profile], 10000, accEnv)).ok);
  if (sso) {
    echo(`${YEL}!${N} O login do AWS SSO (perfil ${B}${profile}${N}) venceu: renovando…`);
    if ((await runCli('aws', ['sso', 'login', '--profile', profile], env)) === 0) {
      echo(`${GREEN}✓${N} login do AWS SSO renovado`);
      return true;
    }
    echo(`${RED}✗${N} não consegui renovar o login do AWS SSO`);
  } else {
    echo(`${YEL}!${N} As credenciais da AWS do perfil ${B}${profile || 'padrão'}${N} não funcionaram (vencidas ou inválidas).`);
    echo(`  ${GRAY}para trocar as chaves: /ui → Contas AWS → Ver chaves → Atualizar chaves${N}`);
  }
  return ask(`  Abrir ${a.label} mesmo assim?`);
}

let FLASH = '';
async function firstRunDetect() {
  if (ACC.length || !TTY_IN) return;
  let found;
  try { found = await lib.detectAccounts(); } catch { return; }
  found = found.filter((f) => !/\s/.test(f.dir));
  if (!found.length) return;
  clearScreen();
  echo();
  mascot('^ ◡ ^', `Achei ${found.length} conta(s) que você já usa nesta máquina!`, `${GRAY}elas já têm login: posso adicionar ao hub${N}`);
  echo();
  for (const f of found) echo(`  ${TEAL}●${N} ${padEnd(f.command, 8)} ${GRAY}${f.dir}${N}`);
  echo();
  if (!(await ask('  Adicionar ao hub?'))) return;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  // mesmo nome que a interface: ~/.claude-trabalho → claude-trabalho
  let text = '';
  for (const f of found) {
    const env = Object.entries(f.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    text += `\n[${f.name}]\ntype    = ${f.type}\nlabel   = ${f.label}\ncommand = ${f.command}\n${env ? `env     = ${env}` : ''}\n`;
  }
  fs.appendFileSync(CONFIG, text, { mode: 0o600 });
  if (!IS_WIN) fs.chmodSync(CONFIG, 0o600);
  loadConfig();
  FLASH = 'Contas adicionadas! Escolha uma para abrir.';
}

async function launch(name, extra = []) {
  const a = byName.get(name);
  if (!a) { warnErr(`conta desconhecida: ${name}`); return 1; }
  const cmd = a.command;
  if (!cmd) { warnErr(`"${name}" não tem command no config`); return 1; }
  if (!installed(a)) {
    echo(`${YEL}!${N} "${cmd}" não está instalado.`);
    if (lib.installCmd(a) && (await ask('Instalar agora?'))) await installMissing([name], { yes: true });
    if (!installed(a)) return 1;
  }
  const env = accountEnv(a);
  // o Codex recusa pasta de login inexistente
  for (const [k, v] of a.envList) if (LOGIN_DIRS.includes(k)) { try { fs.mkdirSync(v, { recursive: true }); } catch {} }
  IGNORE_INT = true;
  try {
    if (!(await awsReady(a, env))) return 1;
    const st = LOGIN_STATE.has(name) ? LOGIN_STATE.get(name) : (await loginInfo(a)).state;
    // contas Bedrock entram pelas credenciais da AWS (o SSO é renovado acima), nunca por "claude auth login"
    const lc = a.type === 'bedrock' ? null : LOGIN_CMD[cmd];
    if (st === 'blocked') {
      echo(`${YEL}!${N} O Google desativou o login com conta pessoal no Gemini CLI (18/06/2026).`);
      echo(`  ${GRAY}com sua conta Google, use o Antigravity: /ui → Nova conta → Antigravity (comando agy)${N}`);
      echo(`  ${GRAY}no Gemini CLI continuam valendo a chave da API do Gemini (~/.gemini/.env) ou uma conta Enterprise${N}`);
      if (!(await ask(`  Abrir ${a.label} mesmo assim?`))) return 1;
    }
    if (st === 'login' && lc && TTY_IN) {
      let cred = '';
      if (cmd === 'claude') cred = path.join(envVal(a, 'CLAUDE_CONFIG_DIR') || path.join(HOME, '.claude'), '.credentials.json');
      else if (cmd === 'codex') cred = path.join(envVal(a, 'CODEX_HOME') || path.join(HOME, '.codex'), 'auth.json');
      let first = true;
      try { if (cred && fs.statSync(cred).isFile()) first = false; } catch {}
      if (first) echo(`${TEAL}→${N} Primeiro acesso em ${B}${a.label}${N}: vamos fazer o login…`);
      else echo(`${YEL}!${N} Você precisa entrar de novo em ${B}${a.label}${N}: abrindo o login…`);
      cursor('cnorm');
      if ((await runCli(cmd, lc, env)) !== 0) echo(`${YEL}!${N} o login não foi concluído: abrindo mesmo assim`);
    }
    const args = splitWords(a.args).map(lib.expandHome);
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, `${name}\n`);
    } catch {}
    echo(`${TEAL}→${N} ${B}${a.label}${N}`);
    cursor('cnorm');
    return await runCli(cmd, [...args, ...extra], env);
  } finally {
    IGNORE_INT = false;
  }
}

async function openUi() {
  return runChild(process.execPath, [path.join(HUB_ROOT, 'ui', 'server.js')], Object.assign({}, process.env, { HUB_CONFIG: CONFIG }));
}

async function check() {
  const sys = await lib.systemDetails();
  out(`\n  ${B}Sistema${N}\n`);
  out(`  ${TEAL}●${N} ${sys.label} ${GRAY}· Node ${sys.node} · instala com ${sys.installWith}${N}\n`);
  for (const p of sys.places) out(`    ${GRAY}${padEnd(p.what, 34)}${N} ${p.where}\n`);
  out(`\n  ${B}Pré-requisitos${N}\n`);
  const why = { node: 'interface (/ui)', npm: 'instalar CLIs (i)', aws: 'contas Bedrock', git: 'atualizações do hub e skills' };
  const first = (r) => (String(r.stdout || '') || String(r.stderr || '')).split('\n')[0];
  const pre = await Promise.all(Object.keys(why).map(async (cmd) => (findExe(cmd) ? first(await lib.run(cmd, ['--version'], 10000)).slice(0, 40) : null)));
  Object.keys(why).forEach((cmd, i) => {
    if (pre[i] !== null) out(`  ${GREEN}✓${N} ${padEnd(cmd, 8)} ${GRAY}${pre[i]}${N}\n`);
    else out(`  ${RED}✗${N} ${padEnd(cmd, 8)} ${GRAY}não instalado: usado para ${why[cmd]}${N}\n`);
  });

  out(`\n  ${B}CLIs cadastradas${N}\n`);
  if (!ACC.length) {
    out(`  ${GRAY}nenhuma conta cadastrada ainda: use /ui para abrir a interface${N}\n`);
    return 0;
  }
  const nw = nameWidth();
  const hasAws = Boolean(findExe('aws'));
  const rows = await Promise.all(ACC.map(async (a) => {
    const inst = installed(a);
    const version = inst ? first(await lib.run(a.command, ['--version'], 15000)) : '';
    const how = await howInstalled(a);
    // contas Bedrock sem AWS_PROFILE no config usam o perfil do settings.json, do shell ou o "default"
    const profile = envVal(a, 'AWS_PROFILE') || (isBedrock(a) ? lib.awsEnvOf({ command: a.command, env: Object.fromEntries(a.envList) }).AWS_PROFILE || 'default' : '');
    let aws = null;
    if (profile && hasAws) aws = (await lib.run('aws', ['sts', 'get-caller-identity'], 20000, { ...Object.fromEntries(a.envList), AWS_PROFILE: profile })).ok;
    // duas instalações da mesma CLI: a que vem primeiro no PATH é a que roda, e a outra costuma ficar velha
    const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
    const all = inst ? await lib.whichAll(a.command) : [];
    const dups = all.filter((f, i) => i > 0 && real(f) !== real(all[0]) && all.findIndex((g) => real(g) === real(f)) === i);
    return { a, inst, version, profile, aws, how, dups };
  }));
  for (const { a, inst, version, profile, aws, how, dups } of rows) {
    if (inst) {
      out(`  ${GREEN}✓${N} ${padEnd(a.name, nw)} ${padEnd(a.command, 8)} ${GRAY}${version} · ${how.label}${how.path ? ` · ${lib.homeRel(how.path)}` : ''}${N}\n`);
      if (how.note) out(`    ${' '.repeat(nw)} ${YEL}${how.note}${N}\n`);
      if (dups.length) out(`    ${' '.repeat(nw)} ${YEL}há outra instalação que não é usada: ${dups.map(lib.homeRel).join(', ')}${N}\n`);
    } else out(`  ${RED}✗${N} ${padEnd(a.name, nw)} ${padEnd(a.command, 8)} ${GRAY}não instalado (${how.cmd ? `via ${how.label}: ${how.cmd}` : how.note || 'sem instalador conhecido'})${N}\n`);
    if (!profile) continue;
    if (!hasAws) out(`    ${' '.repeat(nw)} ${RED}aws CLI não instalado${N}\n`);
    else if (aws) out(`    ${' '.repeat(nw)} aws perfil "${profile}": ${GREEN}credenciais ok${N}\n`);
    else out(`    ${' '.repeat(nw)} aws perfil "${profile}": ${RED}credenciais falharam${N}\n`);
  }
  if (missing([]).length) out(`\n  ${YEL}dica:${N} use ${B}/install${N} no menu para instalar as CLIs que faltam\n`);
  return 0;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const git = (args, timeout = 20000) => lib.run('git', ['-C', HUB_ROOT, ...args], timeout, GIT_ENV);
const samePath = (a, b) => {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch {} return IS_WIN ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
};

function relinkHub() {
  if (IS_WIN) return { ok: true };
  const wrapper = path.join(HUB_ROOT, 'bin', 'hub');
  try { fs.chmodSync(wrapper, 0o755); } catch (e) { return { ok: false, stderr: e.message }; }
  const link = path.join(HOME, '.local', 'bin', 'hub');
  try {
    if (fs.lstatSync(link).isSymbolicLink() && samePath(link, wrapper)) {
      const tmp = `${link}.hub-new-${process.pid}`;
      fs.symlinkSync(wrapper, tmp);
      fs.renameSync(tmp, link);
    }
  } catch {}
  return { ok: true };
}

async function syntaxOk(file) {
  const r = await lib.run(process.execPath, ['--check', file], 30000);
  if (!r.ok) return r;
  const wrapper = path.join(path.dirname(file), 'hub');
  if (!IS_WIN && file === path.join(HUB_ROOT, 'bin', 'hub.js') && fs.existsSync(wrapper)) return lib.run('sh', ['-n', wrapper], 10000);
  return r;
}

async function checkUpdate() {
  if (process.env.HUB_NO_UPDATE || process.env.HUB_UPDATED) return;
  if (!TTY_IN || !TTY_OUT) return;
  if (!findExe('git')) return;
  // só o repositório do próprio hub, não um repositório pai (ex.: dotfiles)
  const top = await git(['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout || !samePath(top.stdout, HUB_ROOT)) return;
  if (!(await git(['rev-parse', '--abbrev-ref', '@{u}'])).ok) return;
  try {
    cursor('civis');
    clearScreen();
    echo();
    mascot('◕ ◡ ◕', 'Procurando atualizações…', `${GRAY}um instante${N}`);
    echo();
    // sem prompt de senha: falha na hora em vez de travar
    const f = await spinRun('conferindo o repositório do Agent Hub', git(['fetch', '--quiet'], 6000));
    if (!f.ok) return;
    const behind = Number((await git(['rev-list', '--count', 'HEAD..@{u}'])).stdout) || 0;
    if (behind <= 0) return;

    clearScreen();
    echo();
    mascot('^ ◡ ^', `${GREEN}${B}Tem novidade no Agent Hub!${N}`, `${GRAY}${behind} atualização(ões) disponível(is)${N}`);
    out(`\n  ${B}O que mudou${N}\n`);
    const log = (await git(['log', '--format=%s', 'HEAD..@{u}'])).stdout.split('\n').filter(Boolean).slice(0, 6);
    for (const l of log) out(`  ${TEAL}•${N} ${plain(l)}\n`);
    if (behind > 6) out(`  ${GRAY}… e mais ${behind - 6}${N}\n`);
    echo();
    if ((await git(['status', '--porcelain', '--untracked-files=no'])).stdout) {
      out(`  ${YEL}!${N} Você tem alterações locais no repositório, então não vou atualizar por cima.\n`);
      out(`    ${GRAY}para atualizar à mão: git -C ${shq(HUB_ROOT)} pull${N}\n\n`);
      cursor('cnorm');
      await pause();
      return;
    }
    if (!(await git(['merge-base', '--is-ancestor', 'HEAD', '@{u}'])).ok) {
      out(`  ${YEL}!${N} Seu repositório tem commits que o remoto não tem, então não dá para atualizar sozinho.\n`);
      out(`    ${GRAY}resolva à mão: git -C ${shq(HUB_ROOT)} pull --rebase${N}\n\n`);
      cursor('cnorm');
      await pause();
      return;
    }
    // a versão nova precisa compilar antes de substituir a atual
    let good = false;
    const shown = await git(['show', '@{u}:bin/hub.js']);
    if (shown.ok && shown.stdout) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-'));
      try {
        const tmp = path.join(dir, 'hub.js');
        fs.writeFileSync(tmp, shown.stdout + '\n');
        good = (await lib.run(process.execPath, ['--check', tmp], 30000)).ok;
      } finally { lib.rmSafe(dir); }
    }
    if (!good) {
      out(`  ${YEL}!${N} A versão nova do hub veio com erro; fico na atual por enquanto.\n\n`);
      cursor('cnorm');
      await pause();
      return;
    }
    cursor('cnorm');
    if (!(await ask('  Atualizar agora?'))) {
      FLASH = 'Atualização adiada: pergunto de novo na próxima vez.';
      return;
    }
    cursor('civis');
    echo();
    if (!(await updateStep('baixando as novidades', () => git(['pull', '--ff-only', '--quiet'], 60000)))) {
      cursor('cnorm');
      await pause();
      return;
    }
    await updateStep('aplicando', relinkHub);
    if (!IS_WIN && fs.existsSync(path.join(HUB_ROOT, 'scripts', 'post-update.sh'))) {
      await updateStep('rodando os ajustes da nova versão', () => lib.run('bash', ['-c', 'cd "$1" && bash scripts/post-update.sh', '_', HUB_ROOT], 10 * 60 * 1000));
    }
    if (!(await updateStep('conferindo o comando hub', () => syntaxOk(path.join(HUB_ROOT, 'bin', 'hub.js'))))) {
      await git(['reset', '--quiet', '--hard', 'ORIG_HEAD']);
      out(`  ${YEL}!${N} a versão nova veio com erro: voltei para a anterior\n`);
      cursor('cnorm');
      await pause();
      return;
    }
    const version = (await git(['log', '-1', '--format=%h · %cd', '--date=short'])).stdout;
    echo();
    mascot('◕ ◡ ◕', `${GREEN}${B}Atualizado!${N}`, `${GRAY}versão ${version}${N}`);
    await sleep(1400);
    cursor('cnorm');
    const code = await runChild(process.execPath, [path.join(HUB_ROOT, 'bin', 'hub.js')], Object.assign({}, process.env, { HUB_UPDATED: '1' }));
    return { reexec: code };
  } finally {
    cursor('cnorm');
  }
}

let FACE = '', MSG1 = '', MSG2 = '';
function mood() {
  const cmds = missing([]).map((a) => a.command);
  if (!ACC.length) {
    FACE = '^ ◡ ^';
    MSG1 = `Oi, eu sou o ${B}Hubi${N}! Vamos configurar suas contas?`;
    MSG2 = `${GRAY}Nenhuma conta ainda: digite ${N}${B}/ui${N}${GRAY} para abrir a interface.${N}`;
  } else if (cmds.length) {
    FACE = '• ~ •';
    MSG1 = `Faltam CLIs: ${YEL}${cmds.join(' ')}${N}`;
    MSG2 = `${GRAY}Digite ${N}${B}/install${N}${GRAY} para instalar todas as cadastradas.${N}`;
  } else {
    FACE = '◕ ◡ ◕';
    MSG1 = `Tudo pronto! ${GRAY}Escolha um agente.${N}`;
    MSG2 = `${GRAY}${ACC.length} conta(s) configurada(s).${N}`;
  }
  let need = '', blocked = '';
  for (const a of ACC) {
    const st = LOGIN_STATE.get(a.name);
    if (st === 'login') { need = a.name; break; }
    if (st === 'blocked' && !blocked) blocked = a.name;
  }
  if (!need && blocked) {
    FACE = '• ~ •';
    MSG1 = `${YEL}${byName.get(blocked).label}${N}: o Google bloqueou o login pessoal no Gemini CLI.`;
    MSG2 = `${GRAY}Use o Antigravity (comando agy) com a mesma conta Google: /ui → Nova conta.${N}`;
    need = blocked;
  } else if (need) {
    FACE = '• ~ •';
    const bed = byName.get(need).type === 'bedrock';
    MSG1 = bed ? `As credenciais AWS de ${YEL}${byName.get(need).label}${N} não funcionaram.` : `${YEL}${byName.get(need).label}${N} precisa de login.`;
    MSG2 = bed ? `${GRAY}Abra a conta: o hub renova o SSO ou explica como trocar as chaves.${N}` : `${GRAY}Abra a conta: o hub já começa pelo login.${N}`;
  }
  if (!need) {
    for (const a of ACC) {
      const d = LOGIN_DAYS.get(a.name);
      if (d != null && d <= 5) { MSG2 = `${YEL}O login de ${a.label} vence em ${d} dia(s).${N}`; break; }
    }
  }
  if (FLASH) MSG2 = `${MINT}${FLASH}${N}`;
  FLASH = '';
}

const ACTIONS = ['ui', 'check', 'install', 'update', 'skills', 'quit'];
const ACTION_CMD = { ui: '/ui', check: '/verify', install: '/install', update: '/update', skills: '/skills', quit: '/quit' };
const CMD_NAMES = ['/ui', '/verify', '/install', '/update', '/skills', '/quit'];
const CMD_ACTION = { '/ui': 'ui', '/verify': 'check', '/install': 'install', '/update': 'update', '/skills': 'skills', '/quit': 'quit', '/sair': 'quit' };
const ACTION_LABEL = {
  ui: 'Configurar contas e credenciais',
  check: 'Verificar CLIs instaladas',
  install: 'Instalar CLIs cadastradas',
  update: 'Atualizar CLIs instaladas',
  skills: 'Gerenciar skills',
  quit: 'Sair',
};

function resolveCmd(typed) {
  if (Object.prototype.hasOwnProperty.call(CMD_ACTION, typed)) return typed;
  const m = CMD_NAMES.filter((c) => c.startsWith(typed));
  return m.length === 1 ? m[0] : '';
}
function suggestCmd(typed) {
  const m = CMD_NAMES.filter((c) => c.startsWith(typed));
  return m.length === 1 ? m[0] : '';
}

let ITEMS = [];
let SEL = 0;
function buildItems() {
  ITEMS = [...ACC.map((a) => `acc:${a.name}`), ...ACTIONS.map((a) => `act:${a}`)];
}
function defaultSelection() {
  let last = '';
  try { last = fs.readFileSync(STATE_FILE, 'utf8').replace(/\n+$/, ''); } catch {}
  const miss = missing([]);
  SEL = 0;
  for (let i = 0; i < ITEMS.length; i++) {
    if ((!ACC.length && ITEMS[i] === 'act:ui')
      || (ACC.length && miss.length && ITEMS[i] === 'act:install')
      || (!miss.length && last && ITEMS[i] === `acc:${last}`)) {
      SEL = i;
      return;
    }
  }
}

function renderRaw(interactive, cmdMode, cmdBuf) {
  const nw = nameWidth();
  let o = '\n';
  o += mascotText(FACE, MSG1, MSG2);
  o += '\n';
  o += `  ${GRAY}${B}CONTAS${N}\n`;
  if (!ACC.length) o += `    ${GRAY}(nenhuma conta cadastrada)${N}\n`;
  ITEMS.forEach((item, i) => {
    const on = interactive && i === SEL;
    const ptr = on ? `${GREEN}${B}❯${N}` : ' ';
    const selOn = on ? B : '';
    if (item.startsWith('acc:')) {
      const a = byName.get(item.slice(4));
      const st = LOGIN_STATE.get(a.name);
      const status = !installed(a) ? `${YEL}○ não instalado${N}`
        : st === 'blocked' ? `${YEL}⚠ login bloqueado${N}`
          : st === 'login' ? `${YEL}⚠ ${a.type === 'bedrock' ? 'credenciais AWS' : 'fazer login'}${N}` : `${GREEN}● pronto${N}`;
      o += `  ${ptr} ${TEAL}${i + 1}${N}  ${selOn}${pad(a.name, nw + 1)}${N} ${pad(a.label, 30)} ${status}\n`;
    } else {
      if (item === 'act:ui') o += `\n  ${GRAY}${B}AÇÕES${N}\n`;
      const act = item.slice(4);
      o += `  ${ptr} ${TEAL}${pad(ACTION_CMD[act], 10)}${N} ${selOn}${ACTION_LABEL[act]}${N}\n`;
    }
  });
  let hints = `  ${GRAY}# /ui       abre a interface no navegador para cadastrar contas e credenciais${N}\n`;
  hints += `  ${GRAY}# /verify   verifica quais CLIs estão instaladas e se as credenciais AWS funcionam${N}\n`;
  hints += `  ${GRAY}# /install  instala as CLIs cadastradas que ainda faltam${N}\n`;
  hints += `  ${GRAY}# /update   atualiza as CLIs para a versão mais recente (novos modelos e recursos)${N}\n`;
  hints += `  ${GRAY}# /skills   lista as skills de cada conta e instala novas a partir do GitHub${N}\n`;
  // as dicas são o primeiro corte quando o terminal é baixo (ex.: painel da IDE)
  const rows = interactive ? termRows() : 0;
  if (!rows || o.split('\n').length + 10 <= rows) o += '\n' + hints;
  o += '\n';
  if (interactive && cmdMode) {
    const sug = suggestCmd(cmdBuf);
    o += `  ${GREEN}${B}›${N} ${B}${cmdBuf}${N}${GRAY}${sug.slice(cmdBuf.length)}${GREEN}▏${N}\n`;
    o += `  ${GRAY}Enter executa · Tab completa · Esc cancela${N}\n`;
  } else if (interactive) {
    o += `  ${GRAY}escolha com as setas ↑ ↓ e aperte Enter · ou digite o número da conta · ou / para comandos${N}\n`;
    o += `\n  ${GRAY}sistema: ${lib.systemInfo().label}${N}\n`;
  } else {
    o += `  ${GRAY}digite um comando (/ui, /verify, /install, /update, /skills, /quit) ou o número da conta${N}\n`;
  }
  return o;
}

function render(interactive, cmdMode = false, cmdBuf = '') {
  mood();
  const o = renderRaw(interactive, cmdMode, cmdBuf);
  if (interactive) paint(o.replace(/\n+$/, ''));
  else out(o);
}

async function runItem(item) {
  cursor('cnorm');
  clearScreen();
  if (item.startsWith('acc:')) {
    const name = item.slice(4);
    const a = byName.get(name);
    if ((await launch(name)) === 0) FLASH = `De volta! Você saiu de ${a.label}.`;
    else await pause();
    await refreshLogin(a);
  } else {
    switch (item.slice(4)) {
      case 'ui': {
        IGNORE_INT = true;
        const code = await openUi();
        if (code === 2) await pause();
        IGNORE_INT = false;
        loadConfig();
        await refreshLogins();
        buildItems();
        FLASH = 'Contas recarregadas da interface.';
        break;
      }
      case 'check': await check(); echo(); await pause(); break;
      case 'install': echo(); await installMissing([]); echo(); await pause(); break;
      case 'update': echo(); await updateInstalled([]); await bedrockModelsUpdate([]); await modelsUpdate([]); echo(); await pause(); break;
      case 'skills':
        SKILL_DONE = '';
        await skillsMenu();
        if (SKILL_DONE === 'ok') FLASH = `De volta! Você saiu de ${SKILL_ACC_LABEL}.`;
        else if (SKILL_DONE !== 'back') { echo(); await pause(); }
        break;
      case 'quit': return false;
    }
  }
  cursor('civis');
  return true;
}

function goodbye() {
  cursor('cnorm');
  out(`\n  ${TEAL}(^ ◡ ^)/${N}  até mais!\n\n`);
}

async function runCmd(typed) {
  const r = resolveCmd(typed);
  if (r) return runItem(`act:${CMD_ACTION[r]}`);
  FLASH = `Comando desconhecido: ${typed}: use /ui, /verify, /install, /update, /skills ou /quit`;
  return true;
}

const isPrint = (k) => k.length > 0 && [...k].length === 1 && !/[\x00-\x1f\x7f]/.test(k);

async function interactiveMenu() {
  await firstRunDetect();
  await refreshLogins();
  buildItems();
  defaultSelection();
  cursor('civis');
  let cmdMode = false;
  let buf = '';
  for (;;) {
    render(true, cmdMode, buf);
    const k = await readKey();
    if (k === null) break;
    if (cmdMode) {
      if (k === '') {
        cmdMode = false;
        const go = await runCmd(buf);
        buf = '';
        if (!go) break;
      } else if (k === '\t') {
        const s = suggestCmd(buf);
        if (s) buf = s;
      } else if (k === '\x7f' || k === '\b') {
        buf = buf.slice(0, -1);
        if (!buf) cmdMode = false;
      } else if (k[0] === '\x1b') {
        cmdMode = false;
        buf = '';
      } else if (isPrint(k)) buf += k;
      continue;
    }
    if (k === '\x1b[A' || k === 'k') { if (SEL > 0) SEL--; }
    else if (k === '\x1b[B' || k === 'j') { if (SEL < ITEMS.length - 1) SEL++; }
    else if (k === '') { if (!(await runItem(ITEMS[SEL]))) break; }
    else if (/^[1-9]$/.test(k)) {
      let p = k;
      if (ACC.length > 9) { const more = await readCharWithin(600); if (more && /^[0-9]$/.test(more)) p += more; }
      if (Number(p) <= ACC.length) {
        SEL = Number(p) - 1;
        if (!(await runItem(ITEMS[SEL]))) break;
      }
    } else if (k === '/') { cmdMode = true; buf = '/'; }
    else if (k === '\x1b') break;
    if (SEL >= ITEMS.length) SEL = ITEMS.length - 1;
  }
  goodbye();
}

async function lineMenu() {
  await refreshLogins();
  buildItems();
  for (;;) {
    render(false);
    const line = await readLine('› ');
    if (line === null) break;
    const choice = line.trim();
    if (choice.startsWith('/')) {
      if (!(await runCmd(choice))) break;
    } else if (/^[0-9]+$/.test(choice) && parseInt(choice, 10) >= 1 && parseInt(choice, 10) <= ACC.length) {
      await runItem(`acc:${ACC[parseInt(choice, 10) - 1].name}`);
    } else if (byName.has(choice)) {
      await runItem(`acc:${choice}`);
    } else if (choice) {
      FLASH = `Opção inválida: ${choice}`;
    }
  }
  goodbye();
}

function usage() {
  out(`uso: hub                abre o menu (setas + Enter, número da conta ou comandos com /)
     hub <conta> [args] abre uma conta direto (ex.: hub claude-aws --continue)
     hub skill <nome>   abre a CLI já usando a skill (ex.: hub skill xlsx)

comandos no menu:
  /ui        interface para cadastrar contas e credenciais
  /verify    verifica as CLIs instaladas
  /install   instala as CLIs cadastradas que faltam
  /update    atualiza as CLIs instaladas para a versão mais recente
  /skills    lista e instala skills (SKILL.md) a partir do GitHub
  /quit      sai

config: ${CONFIG}
`);
}

async function main(argv) {
  loadConfig();
  const [cmd = '', ...rest] = argv;
  switch (cmd) {
    case '': {
      const u = await checkUpdate();
      if (u && 'reexec' in u) return u.reexec;
      delete process.env.HUB_UPDATED;
      if (TTY_IN && TTY_OUT) await interactiveMenu(); else await lineMenu();
      return 0;
    }
    case '-h': case '--help': case 'help': usage(); return 0;
    case 'ui': return openUi();
    case 'install': return installMissing(rest);
    case 'update': await updateInstalled(rest); await bedrockModelsUpdate(rest); return modelsUpdate(rest);
    case 'skills': return skillsMenu();
    case 'skill': {
      const [skill, accName] = rest;
      if (!skill) { warnErr('uso: hub skill <nome> [conta]'); return 2; }
      const T = skillTargets();
      const row = installedSkills(T).find((r) => r.name === skill);
      if (!row) { warnErr(`${RED}✗${N} a skill "${skill}" não está instalada (veja /skills)`); return 1; }
      let accs = [...new Set(row.idx.flatMap((i) => T[i].accts))];
      if (accName) {
        if (!accs.includes(accName)) { warnErr(`${RED}✗${N} a conta "${accName}" não tem a skill "${skill}" (tem: ${accs.join(' ') || 'nenhuma'})`); return 1; }
        accs = [accName];
      }
      return skillRun(skill, accs);
    }
    case 'check': case 'doctor': return check();
    case 'list': for (const a of ACC) out(`${padEnd(a.name, 12)} ${a.label}\n`); return 0;
    case 'config': {
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
      const editor = splitWords(process.env.EDITOR || (IS_WIN ? 'notepad' : 'nano'));
      return runCli(editor[0], [...editor.slice(1), CONFIG], process.env);
    }
    default: return launch(cmd, rest);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    inputOff();
    restoreTerminal();
    process.exitCode = Number(code) || 0;
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  }, (e) => {
    restoreTerminal();
    warnErr(`hub: ${(e && e.stack) || e}`);
    process.exit(1);
  });
} else {
  module.exports = { resolveExe, skillPromptArgs, truncateDesc, resolveCmd, suggestCmd, paintText, splitWords, pad, padEnd, shq, gradient, loadConfig, skillTargets, installedSkills, getAccounts: () => ACC };
}
