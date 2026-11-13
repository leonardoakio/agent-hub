#!/usr/bin/env node
// Escuta só em 127.0.0.1 e exige o token gerado a cada execução.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_WSL = !IS_WIN && (Boolean(process.env.WSL_DISTRO_NAME) || (() => { try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; } })());
// WSL: CLIs do lado Windows (/mnt/c) não recebem o env de cada conta; não contam como instaladas.
const winSide = (p) => IS_WSL && /^\/mnt\/[a-z]\//.test(p);
const winQuote = (a) => (/^[A-Za-z0-9_\-.:\\/=@+,]+$/.test(String(a)) ? String(a) : `"${String(a).replace(/"/g, '""')}"`);
const whereCache = new Map();
function whereWin(cmd) {
  if (/[\\/]/.test(cmd)) return cmd;
  if (!whereCache.has(cmd)) {
    const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
    whereCache.set(cmd, r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean)[0] : '');
  }
  return whereCache.get(cmd) || cmd;
}
// Windows: os .cmd do npm precisam do cmd.exe (o Node recusa executá-los direto).
function spawnArgs(cmd, args) {
  if (!IS_WIN) return [cmd, args, {}];
  const full = whereWin(cmd);
  if (/\.(cmd|bat)$/i.test(full)) return ['cmd.exe', ['/d', '/s', '/c', `"${[full, ...args].map(winQuote).join(' ')}"`], { windowsVerbatimArguments: true }];
  return [full, args, {}];
}
const shellArgs = (line) => (IS_WIN ? ['cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }] : ['bash', ['-c', line], {}]);
const PATH_SEP = path.delimiter;

// Repositório de onde este hub foi clonado (remote origin): mostrado no topo da interface, sem nome fixo no código.
let repoCache;
function repoInfo() {
  if (repoCache !== undefined) return repoCache;
  repoCache = null;
  try {
    const r = spawnSync('git', ['-C', path.join(__dirname, '..'), 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true });
    const m = (r.stdout || '').trim().match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (r.status === 0 && m) repoCache = { name: `${m[2]}/${m[3]}`, url: `https://${m[1]}/${m[2]}/${m[3]}` };
  } catch {}
  return repoCache;
}
let sysCache = null;
function systemInfo() {
  if (sysCache) return sysCache;
  const arch = { x64: 'x64', arm64: 'ARM64', ia32: 'x86' }[os.arch()] || os.arch();
  const osRelease = () => { try { return (fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || ''; } catch { return ''; } };
  let kind, name;
  if (IS_WIN) {
    kind = 'windows';
    name = `Windows ${Number(os.release().split('.')[2] || 0) >= 22000 ? '11' : '10'}`;
  } else if (IS_MAC) {
    kind = 'macos';
    const v = (spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout || '').trim();
    name = v ? `macOS ${v}` : 'macOS';
  } else {
    kind = IS_WSL ? 'wsl' : 'linux';
    const distro = osRelease() || `Linux ${os.release()}`;
    name = IS_WSL ? `${distro} no WSL` : distro;
  }
  sysCache = {
    kind, name, arch, label: `${name} · ${arch}`, node: process.version,
    shell: IS_WIN ? 'cmd.exe' : 'bash',
    sysDeps: IS_MAC ? 'Homebrew (brew)' : IS_WIN ? 'instalação manual' : 'apt (se houver)',
  };
  return sysCache;
}

async function systemDetails() {
  const g = await run('npm', ['config', 'get', 'prefix'], 10000);
  const prefix = g.ok ? g.stdout.trim() : '';
  const accounts = readAccounts();
  const bedrock = accounts.filter((a) => a.type === 'bedrock').map((a) => ({
    account: a.label, file: path.join(a.env.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude'), 'settings.json'),
  }));
  const agyBin = IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe') : path.join(HOME, '.local', 'bin', 'agy');
  return {
    ...systemInfo(),
    places: [
      { what: 'Configuração do hub (contas)', where: CONFIG },
      { what: 'Comando hub', where: path.join(HOME, '.local', 'bin', IS_WIN ? 'hub.cmd' : 'hub') },
      { what: 'Chaves das contas AWS', where: AWS_CREDENTIALS },
      { what: 'Região e perfis AWS', where: AWS_CONFIG },
      ...bedrock.map((b) => ({ what: `Modelos do Bedrock · ${b.account}`, where: b.file })),
      { what: 'CLIs instaladas pelo npm', where: prefix ? npmModDir(prefix) : 'npm não encontrado' },
      { what: 'Antigravity (agy)', where: agyBin },
      ...skillTargets().map((t) => ({ what: `Skills · ${t.accounts.map((a) => a.label).join(', ') || t.tool}`, where: t.dir })),
    ].map((x) => ({ ...x, where: homeRel(x.where) })),
    installWith: IS_WIN ? 'cmd.exe e PowerShell, pelo mesmo meio em que cada CLI já foi instalada' : 'bash, pelo mesmo meio em que cada CLI já foi instalada (npm, Homebrew, instalador oficial…)',
  };
}
const CONFIG =
  process.env.HUB_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'hub', 'config');
const PORT = (() => {
  const p = Number(process.env.HUB_UI_PORT || 4747);
  return Number.isInteger(p) && p >= 0 && p <= 65535 ? p : 4747;
})();
const TOKEN = crypto.randomBytes(24).toString('hex');
const INDEX = path.join(__dirname, 'index.html');
const FIELDS = ['type', 'label', 'command', 'args', 'install'];
const API_VERSION = 1;
const TYPES = ['claude', 'bedrock', 'codex', 'gemini', 'antigravity', 'copilot', 'custom'];
// Meios pelos quais cada CLI pode ter sido instalada. O hub descobre qual foi usado olhando onde o
// executável está e atualiza pelo mesmo meio, em vez de assumir npm para tudo.
const PS1 = (line) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "${line}"`;
const INSTALL_WAYS = {
  claude: {
    npm: '@anthropic-ai/claude-code',
    brew: { cask: 'claude-code' },
    native: { install: IS_WIN ? PS1('irm https://claude.ai/install.ps1 | iex') : 'curl -fsSL https://claude.ai/install.sh | bash', update: 'claude update' },
    winget: 'Anthropic.ClaudeCode',
  },
  codex: { npm: '@openai/codex', brew: { cask: 'codex' }, winget: 'OpenAI.Codex', binary: 'https://github.com/openai/codex/releases' },
  gemini: { npm: '@google/gemini-cli', brew: { formula: 'gemini-cli' } },
  copilot: {
    npm: '@github/copilot',
    brew: { cask: 'copilot-cli' },
    native: IS_WIN ? null : { install: 'curl -fsSL https://gh.io/copilot-install | bash' },
    winget: 'GitHub.Copilot',
  },
  agy: { native: { install: IS_WIN ? PS1('irm https://antigravity.google/cli/install.ps1 | iex') : 'curl -fsSL https://antigravity.google/cli/install.sh | bash' } },
};
const METHOD_LABEL = {
  npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', brew: 'Homebrew', native: 'instalador oficial',
  winget: 'winget', scoop: 'Scoop', binary: 'binário avulso', config: 'comando do config',
};
const PKG_METHODS = ['npm', 'pnpm', 'yarn', 'bun'];
// Instalação padrão para quem ainda não tem a CLI: npm continua sendo o primeiro, mas sem npm na máquina vale o instalador oficial.
const DEFAULT_INSTALL = Object.fromEntries(Object.keys(INSTALL_WAYS).map((c) => [c, wayCmd(c, INSTALL_WAYS[c].npm ? 'npm' : 'native', 'install')]));
// O agy se atualiza sozinho; rodar o script de novo não faz nada.
const SELF_UPDATING = { agy: 'O Antigravity se atualiza sozinho em segundo plano ao ser usado.' };
const NODE_MIN = { copilot: 22 };

// Comando que instala (verb = 'install') ou atualiza (verb = 'update') a CLI por um meio. Vazio quando o meio não tem comando.
function wayCmd(cmd, method, verb) {
  const ways = INSTALL_WAYS[cmd];
  if (!ways) return '';
  if (PKG_METHODS.includes(method)) {
    // pnpm, Yarn e Bun instalam o mesmo pacote do npm
    const pkg = ways.npm;
    if (!pkg) return '';
    return { npm: `npm install -g ${pkg}@latest`, pnpm: `pnpm add -g ${pkg}@latest`, yarn: `yarn global add ${pkg}@latest`, bun: `bun add -g ${pkg}@latest` }[method];
  }
  const way = ways[method];
  if (!way) return '';
  if (method === 'brew') return way.cask ? `brew ${verb === 'update' ? 'upgrade' : 'install'} --cask ${way.cask}` : `brew ${verb === 'update' ? 'upgrade' : 'install'} ${way.formula}`;
  if (method === 'native') return (verb === 'update' && way.update) || way.install || '';
  if (method === 'winget') return `winget ${verb === 'update' ? 'upgrade' : 'install'} --id ${way} -e`;
  return '';
}

// Deduz o meio de instalação pelo caminho do executável (e pelo que ele aponta).
function classifyInstall(cmd, exe) {
  let real = exe;
  try { real = fs.realpathSync(exe); } catch {}
  const s = `${exe}\n${real}`.replace(/\\/g, '/');
  const home = HOME.replace(/\\/g, '/');
  if (/\/(Cellar|Caskroom)\//.test(s)) return { method: 'brew', real };
  if (/\/(\.pnpm|pnpm)\//.test(s)) return { method: 'pnpm', real };
  if (/\/\.bun\//.test(s)) return { method: 'bun', real };
  if (/\/(\.yarn|yarn\/global)\//.test(s)) return { method: 'yarn', real };
  if (/\/node_modules\//.test(s) || /\/\.volta\//.test(s) || fs.existsSync(path.join(path.dirname(exe), 'node_modules'))) return { method: 'npm', real };
  if (/\/winget\//i.test(s)) return { method: 'winget', real };
  if (/\/scoop\//i.test(s)) return { method: 'scoop', real };
  if (cmd === 'agy') return { method: 'native', real };
  if (cmd === 'claude' && (s.includes(`${home}/.local/share/claude/`) || /\/\.local\/bin\/claude(\.exe)?$/i.test(s))) return { method: 'native', real };
  if (cmd === 'copilot' && /\/(\.local|usr\/local)\/bin\/copilot(\.exe)?$/i.test(s)) return { method: 'native', real };
  return { method: 'binary', real };
}

let npmPrefixCache;
function npmPrefix() {
  if (npmPrefixCache === undefined) {
    npmPrefixCache = (async () => {
      const g = (await which('npm')) ? await run('npm', ['config', 'get', 'prefix'], 10000) : { ok: false };
      return g.ok ? g.stdout.trim() : '';
    })().catch(() => '');
  }
  return npmPrefixCache;
}
// O npm global do sistema (/usr, /usr/local) costuma ser do root: aí o install -g só funciona com sudo ou mudando o prefixo.
async function npmNeedsSudo() {
  if (IS_WIN) return false;
  const prefix = await npmPrefix();
  if (!prefix) return false;
  const dir = npmModDir(prefix);
  const target = fs.existsSync(dir) ? dir : fs.existsSync(path.join(prefix, 'lib')) ? path.join(prefix, 'lib') : prefix;
  try { fs.accessSync(target, fs.constants.W_OK); return false; } catch { return true; }
}
const NPM_PREFIX_HINT = 'ou mude o prefixo do npm para a sua pasta: npm config set prefix ~/.npm-global (e coloque ~/.npm-global/bin no PATH)';

// Onde a CLI está e por que meio foi instalada. null quando não está instalada.
function installInfoFrom(cmd, exe) {
  if (!exe) return null;
  const { method, real } = classifyInstall(cmd, exe);
  return { path: exe, real, method, label: METHOD_LABEL[method] || method };
}
async function installInfo(cmd) {
  return installInfoFrom(cmd, (await whichAll(cmd))[0]);
}
async function installInfos(accounts) {
  const cmds = [...new Set(['claude', 'codex', 'gemini', 'agy', 'copilot', ...accounts.map((a) => a.command)])];
  const result = {};
  await Promise.all(cmds.map(async (c) => { result[c] = await installInfo(c); }));
  return result;
}

// Decide como instalar ou atualizar uma conta: o campo install do config vale sempre; senão, o meio detectado;
// senão, o meio padrão disponível na máquina. info pode vir pré-calculado (null = não instalada).
async function resolveInstall(a, info) {
  if (a.install) return { cmd: a.install, method: 'config', label: METHOD_LABEL.config, verb: 'install', needsSudo: false, note: '' };
  const ways = INSTALL_WAYS[a.command];
  if (!ways) return { cmd: '', method: '', label: '', verb: 'install', needsSudo: false, note: `sem instalador conhecido para ${a.command}: defina install = … no config` };
  if (info === undefined) info = await installInfo(a.command);
  const res = { cmd: '', method: '', label: '', verb: info ? 'update' : 'install', needsSudo: false, note: '', path: info ? info.path : '' };
  if (!info) {
    // npm primeiro; mas se o npm global for do root e houver outro meio na máquina, ele passa a ser a última opção
    const order = [['npm', 'npm'], ['native', IS_WIN ? 'powershell' : 'curl'], ['brew', 'brew'], ['winget', 'winget']];
    if (ways.npm && (await npmNeedsSudo())) order.push(order.shift());
    let pick = '';
    for (const [m, tool] of order) if (ways[m] && (await which(tool))) { pick = m; break; }
    if (!pick) pick = ways.npm ? 'npm' : 'native';
    res.method = pick;
    res.cmd = wayCmd(a.command, pick, 'install');
  } else {
    res.method = info.method;
    res.cmd = wayCmd(a.command, info.method, 'update');
    if (!res.cmd) {
      const site = typeof ways.binary === 'string' ? ways.binary : '';
      res.note = info.method === 'binary'
        ? `instalada como binário avulso em ${homeRel(info.path)}: baixe a versão nova${site ? ` em ${site}` : ''} e substitua o arquivo`
        : `instalada via ${METHOD_LABEL[info.method] || info.method} em ${homeRel(info.path)}: atualize por lá ou defina install = … no config`;
    }
  }
  res.label = METHOD_LABEL[res.method] || res.method;
  if (res.method === 'npm' && res.cmd && (await npmNeedsSudo())) {
    res.needsSudo = true;
    res.cmd = `sudo ${res.cmd}`;
    res.note = `o npm global (${await npmPrefix()}) é do root: precisa de sudo, ${NPM_PREFIX_HINT}`;
  }
  return res;
}
// Compatibilidade: comando "estático" (config ou padrão), sem olhar a máquina.
const installCmd = (a) => a.install || DEFAULT_INSTALL[a.command] || '';

// O Claude Code liga o Bedrock por CLAUDE_CODE_USE_BEDROCK vinda de qualquer lugar: do env da conta no hub,
// do settings.json da pasta de login ou do próprio shell. O hub precisa enxergar as três fontes.
const onFlag = (v) => v === '1' || String(v).toLowerCase() === 'true';
function claudeSettingsEnv(a) {
  const dir = a.env && a.env.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
  const env = readJson(path.join(dir, 'settings.json'))?.env;
  return isObj(env) ? Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)])) : {};
}
// De onde vem o Bedrock desta conta: 'config' (env do hub), 'settings' (settings.json), 'shell' (ambiente) ou '' (não usa).
function bedrockSource(a) {
  if (a.command !== 'claude' && a.command !== 'claude.cmd' && !/[\\/]claude(\.exe|\.cmd)?$/i.test(String(a.command || ''))) return '';
  if (a.env && a.env.CLAUDE_CODE_USE_BEDROCK != null) return onFlag(a.env.CLAUDE_CODE_USE_BEDROCK) ? 'config' : '';
  const s = claudeSettingsEnv(a);
  if (s.CLAUDE_CODE_USE_BEDROCK != null) return onFlag(s.CLAUDE_CODE_USE_BEDROCK) ? 'settings' : '';
  return onFlag(process.env.CLAUDE_CODE_USE_BEDROCK) ? 'shell' : '';
}
// Variáveis AWS que valem para a conta, na mesma ordem de prioridade do Claude Code.
const awsEnvOf = (a) => Object.fromEntries(Object.entries({ ...process.env, ...claudeSettingsEnv(a), ...a.env }).filter(([k]) => /^AWS_/.test(k)).map(([k, v]) => [k, expandHome(v)]));
// Tipo real da conta: "claude" só é assinatura se nada liga o Bedrock.
const effectiveType = (a) => (a.type === 'claude' && bedrockSource(a) ? 'bedrock' : a.type);
function inferType(a) {
  if (a.command === 'claude') return bedrockSource(a) ? 'bedrock' : 'claude';
  if (['codex', 'gemini', 'copilot'].includes(a.command)) return a.command;
  if (a.command === 'agy') return 'antigravity';
  return 'custom';
}

// Comentários e chaves desconhecidas ficam em `extra` para sobreviver a um save pela interface.
function parseConfig(text) {
  const accounts = [];
  const header = [];
  const names = new Set();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#' || line[0] === ';') {
      (cur ? cur.extra : header).push(line);
      continue;
    }
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      cur = { name: section[1], label: section[1], type: '', command: '', args: '', install: '', env: {} };
      Object.defineProperty(cur, 'extra', { value: [], writable: true });
      if (names.has(cur.name)) continue; // repetida: vale a primeira, como no terminal
      names.add(cur.name);
      accounts.push(cur);
      continue;
    }
    const i = line.indexOf('=');
    if (!cur || i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!FIELDS.includes(key) && key !== 'env' && key !== 'type') {
      cur.extra.push(line);
      continue;
    }
    if (key === 'env') {
      for (const pair of value.split(/\s+/).filter(Boolean)) {
        const j = pair.indexOf('=');
        if (j > 0) cur.env[pair.slice(0, j)] = pair.slice(j + 1);
      }
    } else if (FIELDS.includes(key)) {
      cur[key] = value;
    }
  }
  for (const a of accounts) {
    if (!TYPES.includes(a.type)) a.type = inferType(a);
    a.type = effectiveType(a);
    a.bedrockFrom = a.type === 'bedrock' ? bedrockSource(a) || 'config' : '';
  }
  Object.defineProperty(accounts, 'header', { value: header });
  return accounts;
}

const DEFAULT_HEADER = [
  '# Configuração do hub: editada pela interface (/ui no hub) ou à mão.',
  '# Nenhuma credencial fica aqui: só qual CLI, pasta de login e perfil AWS cada conta usa.',
];

function serializeConfig(accounts, header = DEFAULT_HEADER, extras = new Map()) {
  const out = [...(header.length ? header : DEFAULT_HEADER), ''];
  for (const a of accounts) {
    out.push(`[${a.name}]`, `type    = ${a.type}`, `label   = ${a.label}`, `command = ${a.command}`);
    if (a.args) out.push(`args    = ${a.args}`);
    if (a.install) out.push(`install = ${a.install}`);
    const env = Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join(' ');
    if (env) out.push(`env     = ${env}`);
    out.push(...(extras.get(a.name) || []));
    out.push('');
  }
  return out.join('\n');
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new Error('formato inválido');
  const seen = new Set();
  return accounts.map((a, idx) => {
    const where = `conta ${idx + 1}`;
    const name = String(a.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name))
      throw new Error(`${where}: identificador "${name}" inválido (use letras minúsculas, números, - ou _)`);
    if (seen.has(name)) throw new Error(`identificador repetido: ${name}`);
    if (['ui', 'install', 'update', 'skills', 'skill', 'list', 'check', 'doctor', 'config', 'help'].includes(name))
      throw new Error(`"${name}" é um comando do próprio hub (hub ${name}); escolha outro nome`);
    seen.add(name);
    const label = String(a.label || '').trim() || name;
    if (/[\r\n]/.test(label) || label.length > 80) throw new Error(`${name}: nome de exibição inválido`);
    const command = String(a.command || '').trim();
    if (!/^[A-Za-z0-9._~/\\:-]+$/.test(command)) throw new Error(`${name}: comando inválido`);
    const args = String(a.args || '').trim();
    if (/[\r\n]/.test(args)) throw new Error(`${name}: argumentos não podem ter quebra de linha`);
    const install = String(a.install || '').trim();
    if (/[\r\n]/.test(install)) throw new Error(`${name}: comando de instalação não pode ter quebra de linha`);
    const env = {};
    for (const [k, v] of Object.entries(a.env || {})) {
      if (v == null) continue;
      const val = String(v).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${name}: variável inválida "${k}"`);
      if (!val) continue;
      if (/\s/.test(val)) throw new Error(`${name}: o valor de ${k} não pode ter espaços`);
      if ((k === 'AWS_PROFILE' && !/^[A-Za-z0-9_.@+-]{1,64}$/.test(val)) || (k === 'AWS_REGION' && !/^[a-z0-9-]{4,32}$/.test(val)))
        throw new Error(`${name}: valor inválido em ${k}`);
      if (DIR_KEYS.includes(k) && unsafeDir(expandHome(val), k === 'GEMINI_CLI_HOME'))
        throw new Error(`${name}: ${k} precisa ser uma pasta própria da conta, como ~/.${k === 'GEMINI_CLI_HOME' ? 'gemini-trabalho' : 'claude-trabalho'}`);
      env[k] = val;
    }
    const type = TYPES.includes(a.type) ? a.type : inferType({ command, env });
    return { name, label, type, command, args, install, env };
  });
}

function readAccounts() {
  return fs.existsSync(CONFIG) ? parseConfig(fs.readFileSync(CONFIG, 'utf8')) : [];
}

// Grava ao lado do arquivo real: um config que é link (dotfiles) continua sendo link.
// Mantém a permissão do original (settings.json e config podem ter chaves em env).
function writeReal(file, data, mode) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  let keep = mode;
  if (keep == null) { try { keep = fs.statSync(real).mode & 0o777; } catch {} }
  const tmp = `${real}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { flag: 'wx', mode: fileMode(keep) ?? 0o666 });
  try {
    if (fileMode(keep)) fs.chmodSync(tmp, keep);
    renameSafe(tmp, real);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function writeAccounts(accounts) {
  const prev = readAccounts();
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  if (fs.existsSync(CONFIG)) { fs.copyFileSync(CONFIG, CONFIG + '.bak'); if (!IS_WIN) fs.chmodSync(CONFIG + '.bak', 0o600); }
  writeReal(CONFIG, serializeConfig(accounts, prev.header || [], new Map(prev.map((a) => [a.name, a.extra]))), 0o600);
}

// No config da AWS só [default] e [profile X] são perfis ([sso-session X], [services X] não).
function iniSections(file, isConfig = false) {
  if (!fs.existsSync(file)) return {};
  const sections = {};
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(.+?)\]$/);
    if (m) {
      let name = m[1].trim();
      if (isConfig) {
        const p = name.match(/^profile\s+(.+)$/);
        if (p) name = p[1].trim();
        else if (name !== 'default') { cur = null; continue; }
      }
      cur = sections[name] = sections[name] || {};
      continue;
    }
    const i = line.indexOf('=');
    if (cur && i > 0) cur[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return sections;
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AWS_CREDENTIALS = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(HOME, '.aws', 'credentials');
const AWS_CONFIG = process.env.AWS_CONFIG_FILE || path.join(HOME, '.aws', 'config');

// Grava direto no arquivo: via `aws configure set` o segredo apareceria no `ps`.
// null remove a chave: um session token antigo invalidaria chaves permanentes novas.
function setCredentialKeys(profile, values) {
  const lines = fs.existsSync(AWS_CREDENTIALS) ? fs.readFileSync(AWS_CREDENTIALS, 'utf8').split(/\r?\n/) : [];
  const out = [];
  const pending = new Map(Object.entries(values));
  let section = null;
  const flush = () => {
    for (const [k, v] of pending) if (v != null) out.push(`${k} = ${v}`);
    pending.clear();
  };
  for (const line of lines) {
    const m = line.trim().match(/^\[(.+?)\]$/);
    if (m) {
      if (section === profile) flush();
      section = m[1].trim();
      out.push(line);
      continue;
    }
    const i = line.indexOf('=');
    const key = i > 0 ? line.slice(0, i).trim() : '';
    if (section === profile && pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      if (v != null) out.push(`${key} = ${v}`);
      continue;
    }
    out.push(line);
  }
  if (section === profile) flush();
  if ([...pending.values()].some((v) => v != null)) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
    out.push(`[${profile}]`);
    flush();
  }
  const mode = fs.existsSync(AWS_CREDENTIALS) ? fs.statSync(AWS_CREDENTIALS).mode & 0o777 : 0o600;
  writeReal(AWS_CREDENTIALS, out.join('\n') + '\n', mode);
}

// A chave completa nunca sai do servidor.
function mask(value, keepStart, keepEnd) {
  if (!value) return '';
  if (value.length <= keepStart + keepEnd) return '*'.repeat(value.length);
  return value.slice(0, keepStart) + '*'.repeat(12) + value.slice(-keepEnd);
}

function awsProfiles() {
  const creds = iniSections(AWS_CREDENTIALS);
  const conf = iniSections(AWS_CONFIG, true);
  const names = [...new Set([...Object.keys(creds), ...Object.keys(conf)])].sort();
  return names.map((name) => {
    const c = creds[name] || {};
    const keyId = c.aws_access_key_id || '';
    return {
      name,
      region: (conf[name] && conf[name].region) || '',
      hasKeys: Boolean(keyId),
      accessKey: mask(keyId, 4, 4),
      secretKey: mask(c.aws_secret_access_key || '', 0, 4),
      temporary: keyId.startsWith('ASIA') || Boolean(c.aws_session_token),
      sso: Boolean(conf[name] && (conf[name].sso_start_url || conf[name].sso_session)),
      inCredentials: Boolean(creds[name]),
      inConfig: Boolean(conf[name]),
      role: Boolean(conf[name] && conf[name].role_arn),
    };
  });
}

function run(cmd, args, timeout = 20000, env, spec) {
  const [file, argv, extra] = spec || spawnArgs(cmd, args);
  return new Promise((resolve) => {
    const full = env && env[FULL_ENV] ? Object.fromEntries(Object.entries(env)) : env ? { ...process.env, ...env } : process.env;
    execFile(file, argv, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...extra, env: full }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() }),
    );
  });
}
const FULL_ENV = Symbol('full-env');
const fullEnv = () => ({ ...process.env, [FULL_ENV]: true });
const runShell = (line, timeout, env) => run('', [], timeout, env, shellArgs(line));

async function whichAll(cmd) {
  const r = IS_WIN ? await run('where', [cmd], 5000, undefined, ['where', [cmd], {}]) : await run('which', ['-a', cmd], 5000);
  return r.ok ? r.stdout.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !winSide(x)) : [];
}
const which = async (cmd) => (await whichAll(cmd)).length > 0;

// No Windows, "python3" costuma ser o atalho da Microsoft Store.
let pyCmd = null;
async function python() {
  if (pyCmd !== null) return pyCmd;
  for (const c of IS_WIN ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]) {
    if ((await run(c[0], [...c.slice(1), '-c', 'import sys; sys.exit(sys.version_info < (3, 6))'], 10000)).ok) return (pyCmd = c);
  }
  return (pyCmd = []);
}
const pyRun = async (args, timeout = 15000) => { const p = await python(); return p.length ? run(p[0], [...p.slice(1), ...args], timeout) : { ok: false, stdout: '', stderr: 'Python 3 não encontrado' }; };

// Windows: antivírus e indexador seguram arquivos por um instante.
function retrying(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}
const renameSafe = (a, b) => retrying(() => fs.renameSync(a, b));
const rmSafe = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const fileMode = (m) => (IS_WIN ? undefined : m);

async function saveAwsProfile(body) {
  const name = String(body.name || '').trim();
  const keyId = String(body.accessKeyId || '').trim();
  const secret = String(body.secretAccessKey || '').trim();
  const token = String(body.sessionToken || '').trim();
  const region = String(body.region || '').trim();
  if (!PROFILE_RE.test(name)) throw new Error('nome de perfil inválido');
  if (!/^[A-Z0-9]{16,128}$/.test(keyId)) throw new Error('Access Key ID inválido');
  if (!secret || /\s/.test(secret)) throw new Error('Secret Access Key inválido');
  if (token && !/^[A-Za-z0-9+/=]+$/.test(token)) throw new Error('Session Token inválido');
  if (region && !/^[a-z0-9-]{4,32}$/.test(region)) throw new Error('região inválida');
  setCredentialKeys(name, { aws_access_key_id: keyId, aws_secret_access_key: secret, aws_session_token: token || null });
  if (region) {
    const r = await run('aws', ['configure', 'set', 'region', region, '--profile', name]);
    if (!r.ok) throw new Error(`chaves gravadas, mas falhou ao gravar a região: ${r.stderr || 'aws CLI indisponível'}`);
  }
}

function removeIniSection(file, header) {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let skipping = false, removed = false;
  const out = [];
  for (const line of lines) {
    const m = line.trim().match(/^\[(.+?)\]$/);
    if (m) {
      skipping = m[1].trim().replace(/\s+/g, ' ') === header;
      if (skipping) {
        removed = true;
        // comentários colados logo acima da seção são dela
        while (out.length && /^\s*[#;]/.test(out[out.length - 1])) out.pop();
      }
    }
    if (!skipping) out.push(line);
  }
  if (!removed) return false;
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  writeReal(file, text ? text + '\n' : '', fs.statSync(file).mode & 0o777);
  return true;
}

function removeAwsProfile(body) {
  const name = String(body.name || '').trim();
  if (!PROFILE_RE.test(name)) throw new Error('nome de perfil inválido');
  if (!awsProfiles().some((p) => p.name === name)) throw new Error(`o perfil "${name}" não existe mais`);
  const files = [];
  if (removeIniSection(AWS_CREDENTIALS, name)) files.push(AWS_CREDENTIALS.replace(HOME, '~'));
  if (removeIniSection(AWS_CONFIG, name === 'default' ? 'default' : `profile ${name}`)) files.push(AWS_CONFIG.replace(HOME, '~'));
  let accounts = [];
  if (body.removeAccounts) {
    const all = readAccounts();
    accounts = all.filter((a) => a.env.AWS_PROFILE === name).map((a) => a.name);
    if (accounts.length) writeAccounts(all.filter((a) => !accounts.includes(a.name)));
  }
  return { name, files, accounts };
}

async function testAwsProfile(name) {
  if (!PROFILE_RE.test(String(name))) throw new Error('nome de perfil inválido');
  const r = await run('aws', ['sts', 'get-caller-identity', '--profile', name, '--output', 'json']);
  if (!r.ok) return { ok: false, message: r.stderr.split('\n').pop() || 'falhou' };
  const id = JSON.parse(r.stdout);
  return { ok: true, account: id.Account, arn: id.Arn };
}

async function installed(accounts) {
  const infos = await installInfos(accounts);
  const result = { aws: await which('aws') };
  for (const [c, info] of Object.entries(infos)) result[c] = Boolean(info);
  return result;
}

const SKILL_HOME = {
  claude: ['CLAUDE_CONFIG_DIR', '.claude'], bedrock: ['CLAUDE_CONFIG_DIR', '.claude'],
  codex: ['CODEX_HOME', '.codex'], copilot: ['COPILOT_HOME', '.copilot'], gemini: ['GEMINI_CLI_HOME', '.gemini'],
  antigravity: ['', path.join('.gemini', 'antigravity-cli')],
};
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, HOME);
// A limpeza apaga subpastas destas pastas: a pasta inicial, a raiz ou caminhos relativos não servem.
const DIR_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME'];
// Caminho real (links, nomes curtos do Windows, firmlinks do macOS), mesmo que o final ainda não exista.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}
const samePath = (p) => { const r = realish(p); return IS_WIN || IS_MAC ? r.toLowerCase() : r; };
function unsafeDir(p, homeOk = false) {
  if (!path.isAbsolute(p)) return true;
  const r = samePath(p), h = samePath(HOME);
  if (r === path.parse(r).root) return true;
  if (r === h) return !homeOk;
  return h.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
// Arquivos de repositórios baixados: um link poderia apontar para um arquivo local.
const safeRead = (f) => { try { return fs.lstatSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
function fmValue(fm, key) {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return '';
  const first = lines[i].slice(key.length + 1).trim();
  if (!/^[>|][-+]?$/.test(first)) return first.replace(/^["']|["']$/g, '');
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l && !/^\s/.test(l)) break; body.push(l.trim()); }
  return body.join(first[0] === '|' ? '\n' : ' ').trim();
}

const SKILL_LOCK = path.join(HOME, '.agents', '.skill-lock.json');
function readSkillLock() {
  try { return JSON.parse(fs.readFileSync(SKILL_LOCK, 'utf8')); } catch { return {}; }
}

function skillMeta(dir) {
  const text = safeRead(path.join(dir, 'SKILL.md'));
  if (text == null) return null;
  const fm = (text.replace(/\r\n/g, '\n').match(/^---\s*\n([\s\S]*?)\n---/) || [])[1] || '';
  const get = (k) => fmValue(fm, k);
  let source = '', version = '', origin = '';
  [source = '', version = ''] = (safeRead(path.join(dir, '.hub-source')) || '').trim().split('\n'); origin = source ? 'hub' : '';
  const folder = path.basename(dir);
  const lock = readSkillLock().skills?.[folder];
  if (!source && lock?.source && (!lock.sourceType || lock.sourceType === 'github')) { source = lock.source; origin = 'npx skills'; version = version || (lock.updatedAt ? `instalada em ${lock.updatedAt.slice(0, 10)}` : ''); }
  let linked = false;
  try { linked = fs.lstatSync(dir).isSymbolicLink(); } catch {}
  return { name: get('name') || folder, description: get('description'), license: get('license'), compatibility: get('compatibility'), source, version, origin, linked };
}

function skillTargets() {
  const map = new Map();
  for (const a of readAccounts()) {
    const spec = SKILL_HOME[a.type];
    if (!spec) continue;
    let base = spec[0] && a.env[spec[0]] ? expandHome(a.env[spec[0]]) : path.join(HOME, spec[1]);
    if (a.type === 'gemini' && a.env.GEMINI_CLI_HOME) base = path.join(base, '.gemini'); // GEMINI_CLI_HOME é a pasta mãe
    const dir = path.join(base, 'skills');
    const t = map.get(dir) || { dir, display: dir.replace(HOME, '~'), tool: a.type === 'bedrock' ? 'claude' : a.type, accounts: [], skills: [] };
    t.accounts.push({ name: a.name, label: a.label, type: a.type });
    map.set(dir, t);
  }
  for (const [tool, folder] of [['claude', '.claude'], ['codex', '.codex'], ['gemini', '.gemini'], ['antigravity', path.join('.gemini', 'antigravity-cli')], ['copilot', '.copilot'], ['agents', '.agents']]) {
    const dir = path.join(HOME, folder, 'skills');
    if (!map.has(dir) && fs.existsSync(dir)) map.set(dir, { dir, display: dir.replace(HOME, '~'), tool, accounts: [], skills: [] });
  }
  for (const t of map.values()) {
    if (!fs.existsSync(t.dir)) continue;
    for (const entry of fs.readdirSync(t.dir, { withFileTypes: true })) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.')) continue;
      const meta = skillMeta(path.join(t.dir, entry.name));
      if (meta) t.skills.push({ ...meta, folder: entry.name });
    }
    t.skills.sort((x, y) => x.folder.localeCompare(y.folder));
  }
  return [...map.values()];
}

// Só GitHub, por segurança.
function parseSource(src) {
  const text = String(src || '').trim().replace(/^https?:\/\//, '').replace(/^(www\.)?github\.com\//, '').replace(/[#?].*$/, '');
  const m = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([A-Za-z0-9_.-]+)(?:\/(.*))?)?\/?$/);
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) throw new Error('use o formato dono/repositório ou um link do GitHub, ex.: cloudflare/security-audit-skill');
  const sub = (m[4] || '').replace(/\/?SKILL\.md$/, '').replace(/\/$/, '');
  if (sub.split(/[\\/]/).includes('..')) throw new Error('caminho inválido');
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, label: `${m[1]}/${m[2]}`, branch: m[3] || '', sub };
}

const dropSource = (entry) => { if (entry) fs.rmSync(entry.dir, { recursive: true, force: true }); };
// Outra requisição pode ainda estar lendo o clone antigo: apaga só depois.
const retired = new Set();
function retireSource(entry) {
  retired.add(entry);
  setTimeout(() => { retired.delete(entry); dropSource(entry); }, 10 * 60 * 1000).unref();
}

const sourceCache = new Map();
async function fetchSource(src, { fresh = false } = {}) {
  const { url, label, branch, sub } = parseSource(src);
  const key = `${label}#${branch}`;
  const cached = sourceCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < 10 * 60 * 1000 && fs.existsSync(cached.dir)) return { label, ...filterSub(cached, sub) };
  if (cached) { retireSource(cached); sourceCache.delete(key); }
  if (!(await which('git'))) throw new Error(`git não está instalado: as skills vêm do GitHub por ele (${IS_WIN ? 'winget install --id Git.Git -e' : IS_MAC ? 'xcode-select --install' : 'sudo apt install git'})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-'));
  const r = await run('git', ['clone', '--depth', '1', '--quiet', ...(branch ? ['--branch', branch] : []), url, dir], 120000,
    { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'true' });
  if (!r.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    const why = /could not read Username|Authentication failed|not found/i.test(r.stderr) ? 'repositório não encontrado ou privado'
      : /Could not resolve host|unable to access|Failed to connect|timed out/i.test(r.stderr) ? 'sem conexão com o GitHub (rede ou proxy)'
        : r.code === null || /timed out/i.test(String(r.code)) ? 'demorou demais (rede lenta?)' : r.stderr.split('\n').filter(Boolean).pop();
    throw new Error(`não consegui baixar ${label}${branch ? ` (${branch})` : ''}: ${why || 'repositório não encontrado'}`);
  }
  const skills = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    const meta = skillMeta(d);
    if (meta && d !== dir) { skills.push({ ...meta, dir: d, folder: path.basename(d) }); return; }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !['.git', 'node_modules'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  if (!skills.length && skillMeta(dir)) skills.push({ ...skillMeta(dir), dir, folder: parseSource(src).label.split('/')[1] });
  if (!skills.length) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`nenhuma skill (SKILL.md) encontrada em ${label}`); }
  const countFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) =>
    e.name === '.git' ? n : n + (e.isDirectory() ? countFiles(path.join(d, e.name)) : 1), 0);
  for (const sk of skills) sk.files = countFiles(sk.dir);
  const head = await run('git', ['-C', dir, 'log', '-1', '--format=%h|%cd', '--date=short']);
  const [commit = '', date = ''] = head.stdout.split('|');
  const entry = { dir, skills, commit, date, at: Date.now() };
  sourceCache.set(key, entry);
  const out = filterSub(entry, sub);
  if (!out.skills.length) throw new Error(`nenhuma skill (SKILL.md) em ${label}/${sub}`);
  return { label, ...out };
}

function filterSub(entry, sub) {
  if (!sub) return entry;
  const root = path.join(entry.dir, sub);
  return { ...entry, skills: entry.skills.filter((sk) => sk.dir === root || sk.dir.startsWith(root + path.sep)) };
}

// O trecho exibido tem até 1600 caracteres: cortar antes deixa as regex lineares em READMEs enormes.
function cleanMarkdown(md) {
  return md.slice(0, 8000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/<[^<>]+>/g, '')
    .replace(/\[\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function readmeExcerpt(src, folders) {
  const limit = (t) => (t.length > 1600 ? t.slice(0, 1600).replace(/\s+\S*$/, '') + ' …' : t);
  for (const sk of src.skills.filter((x) => folders.includes(x.folder))) {
    const own = safeRead(path.join(sk.dir, 'README.md'));
    if (own != null) return { from: `${sk.folder}/README.md`, text: limit(cleanMarkdown(own)) };
  }
  const md = safeRead(path.join(src.dir, 'README.md'))?.slice(0, 200000);
  if (md == null) return null;
  for (const f of folders) {
    const m = md.match(new RegExp(`^(#{2,4})\\s+[^\\n]*\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`, 'm'));
    if (m && m[2].trim()) return { from: `README.md · seção ${f}`, text: limit(cleanMarkdown(m[2])) };
  }
  if (src.skills.length === 1) return { from: 'README.md · introdução', text: limit(cleanMarkdown(md.replace(/^#\s[^\n]*\n/, ''))) };
  // várias skills pedidas: a introdução do repositório diz mais do que a documentação de uma skill qualquer
  const sk = folders.length === 1 ? src.skills.find((x) => x.folder === folders[0]) : null;
  if (sk) {
    const body = (safeRead(path.join(sk.dir, 'SKILL.md')) || '').replace(/^---[\s\S]*?\n---\s*\n/, '');
    return { from: `${sk.folder}/SKILL.md (documentação da skill)`, text: limit(cleanMarkdown(body)) };
  }
  return { from: 'README.md · introdução', text: limit(cleanMarkdown(md.replace(/^#\s[^\n]*\n/, ''))) };
}

// Pacotes npm podem ter escopo (@org/pacote); nomes só viram argumentos de execFile, nunca shell.
const DEP_NAME_RE = /^(@[A-Za-z0-9._-]{1,64}\/)?[A-Za-z0-9._-]{1,64}$/;
const PY_MOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// ---- Inferência de dependências de uma skill desconhecida, pelos arquivos dela ----
// Módulos da biblioteca padrão do Python (não são dependências).
const PY_STDLIB = new Set(('__future__ _thread abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib numbers operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing typing_extensions unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo ' +
  'setuptools pkg_resources pip wheel ntpath nt').split(' '));
// Módulo importado → pacote no pip, quando os nomes diferem.
const PY_IMPORT_PKG = {
  PIL: 'pillow', yaml: 'PyYAML', cv2: 'opencv-python', bs4: 'beautifulsoup4', sklearn: 'scikit-learn', skimage: 'scikit-image',
  docx: 'python-docx', pptx: 'python-pptx', dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'PyJWT', Crypto: 'pycryptodome',
  nacl: 'pynacl', serial: 'pyserial', usb: 'pyusb', magic: 'python-magic', fitz: 'PyMuPDF', pymupdf: 'PyMuPDF', websocket: 'websocket-client',
  attr: 'attrs', OpenSSL: 'pyopenssl', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient', markdown: 'Markdown', pdfminer: 'pdfminer.six',
  wx: 'wxPython', gi: '', google: '', tests: '', test: '',
};
const PY_PKG_IMPORT = Object.fromEntries(Object.entries(PY_IMPORT_PKG).filter(([, v]) => v).map(([k, v]) => [v.toLowerCase(), k]));
// Pacote do sistema → programa que fica no PATH (para conferir se já está instalado).
const PKG_BIN = {
  poppler: 'pdftoppm', 'poppler-utils': 'pdftoppm', libreoffice: 'soffice', 'libreoffice-fresh': 'soffice', ripgrep: 'rg', imagemagick: 'magick',
  'tesseract-ocr': 'tesseract', graphviz: 'dot', nodejs: 'node', 'python3-pip': 'pip3', 'build-essential': 'gcc', coreutils: '', 'ca-certificates': '', 'libmagic1': '',
};
const PKG_LABEL = { pillow: 'Pillow', pyyaml: 'PyYAML' };
const INFER_MAX_FILES = 400, INFER_MAX_BYTES = 512 * 1024;
const SETUP_CMD_RE = /^(?:sudo\s+)?(?:(?:python3?|py)\s+-m\s+pip|pip3?|uv\s+pip|uv\s+(?:sync|tool\s+install|add)|npm|npx|pnpm|yarn|bun|brew|apt(?:-get)?|dnf|pacman|winget|choco|cargo|go|gem|playwright|poetry)\b/i;
const ENV_VAR_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|TOKEN|SECRET|ACCESS_KEY|CLIENT_ID|CLIENT_SECRET|PASSWORD|WEBHOOK))\b/g;

const pipName = (spec) => String(spec).trim().replace(/^-e\s+/, '').replace(/\[.*$/, '').replace(/[<>=!~;@ ].*$/, '').replace(/\s.*$/, '').trim();
const pipLabel = (pkg) => `Python: ${PKG_LABEL[pkg.toLowerCase()] || pkg}`;
const importOf = (pkg) => PY_PKG_IMPORT[pkg.toLowerCase()] || pkg.toLowerCase().replace(/-/g, '_');

// Arquivos regulares da skill (sem seguir links; limite de quantidade e tamanho).
function skillFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6 || out.length >= INFER_MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= INFER_MAX_FILES) return;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.venv') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.isFile()) out.push(f);
    }
  };
  walk(dir, 0);
  return out;
}
const readSmall = (f) => { try { const st = fs.lstatSync(f); return st.isFile() && st.size <= INFER_MAX_BYTES ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };

// Blocos de código do SKILL.md (bash e afins), linha a linha, sem o prompt "$ ".
function codeLines(md) {
  const lines = [];
  for (const m of md.matchAll(/\`\`\`([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)\`\`\`/g)) {
    if (m[1] && !/^(bash|sh|shell|zsh|console|terminal|cmd|powershell|ps1|text|)$/i.test(m[1])) continue;
    for (const raw of m[2].split('\n')) {
      const l = raw.replace(/^\s*(?:\$|>|PS>)\s+/, '').trim();
      if (l && !l.startsWith('#')) lines.push(l);
    }
  }
  // comandos de instalação em código inline (`brew install x`)
  const noBlocks = md.replace(/\`\`\`[\s\S]*?\`\`\`/g, '');
  for (const m of noBlocks.matchAll(/\`([^\`\n]{4,160})\`/g)) if (SETUP_CMD_RE.test(m[1]) && /\binstall\b/.test(m[1])) lines.push(m[1].trim());
  return lines;
}

// Dependências e passos deduzidos dos arquivos de uma skill. Cada item traz a evidência (de onde veio).
function inferDeps(dir, folder) {
  const deps = new Map(), steps = [], envVars = new Set();
  const rel = (f) => path.relative(dir, f).split(path.sep).join('/');
  const add = (d, evidence) => {
    const key = `${d.type}:${d.name}`;
    const prev = deps.get(key);
    if (prev) { if (evidence && !prev.evidence.includes(evidence)) prev.evidence.push(evidence); if (!d.optional) prev.optional = false; return prev; }
    const item = { ...d, inferred: true, evidence: evidence ? [evidence] : [], optional: Boolean(d.optional) };
    deps.set(key, item);
    return item;
  };
  const addPip = (spec, evidence, optional = false) => {
    const pkg = pipName(spec);
    if (!pkg || !DEP_NAME_RE.test(pkg) || pkg.startsWith('-')) return;
    const mod = importOf(pkg);
    if (!PY_MOD_RE.test(mod)) return;
    add({ type: 'py', name: mod, pip: pkg, label: pipLabel(pkg), why: 'usado pelos scripts da skill', optional }, evidence);
  };
  const addSysPkg = (pkg, pm, evidence) => {
    if (!DEP_NAME_RE.test(pkg)) return;
    if (pm === 'brew' && /^--/.test(pkg)) return;
    const bin = PKG_BIN[pkg] !== undefined ? PKG_BIN[pkg] : pkg;
    if (!bin) return;
    const d = add({ type: 'bin', name: bin, label: pkg === bin ? pkg : `${pkg} (${bin})`, why: 'programa citado no SKILL.md' }, evidence);
    if (pm === 'brew') d.brew = d.brew || pkg;
    if (pm === 'apt') d.apt = d.apt || pkg;
    if (pm === 'winget') d.winget = d.winget || pkg;
  };
  const files = skillFiles(dir);
  const names = new Set(files.map((f) => path.basename(f).replace(/\.[^.]+$/, '')));
  for (const f of files) { let d = path.dirname(rel(f)); while (d && d !== '.') { names.add(path.basename(d)); d = path.dirname(d); } }
  const localModule = (m) => names.has(m) || /^(utils|helpers|common|config|scripts|lib|src|core|main|app)$/.test(m);

  const md = readSmall(path.join(dir, 'SKILL.md')) || '';
  // 1) manifestos
  for (const f of files) {
    const r = rel(f), base = path.basename(f);
    if (/^requirements[^/]*\.txt$/.test(base) || base === 'requirements.in') {
      for (const line of (readSmall(f) || '').split('\n')) {
        const l = line.replace(/#.*$/, '').trim();
        if (!l || l.startsWith('-')) continue;
        addPip(l, r);
      }
    } else if (base === 'pyproject.toml') {
      const t = readSmall(f) || '';
      const m = t.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (m) for (const q of m[1].matchAll(/["']([^"']+)["']/g)) addPip(q[1], r);
    } else if (base === 'Pipfile') {
      const t = readSmall(f) || '';
      const sec = (t.match(/^\[packages\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m) || [])[1] || '';
      for (const line of sec.split('\n')) { const k = line.split('=')[0].trim(); if (k) addPip(k, r); }
    } else if (base === 'package.json' && !r.includes('/node_modules/')) {
      let pkg = null;
      try { pkg = JSON.parse(readSmall(f) || ''); } catch {}
      const list = Object.keys({ ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) });
      if (list.length) steps.push({ kind: 'cmd', title: `Pacotes Node dos scripts (${list.slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''})`, detail: `rode npm install na pasta ${path.dirname(r) === '.' ? 'da skill' : `${folder}/${path.dirname(r)}`} depois de instalar`, cmd: 'npm install', evidence: r });
    }
  }
  // 2) scripts: imports Python, requires Node e shebangs
  const pyImports = new Map(), nodeReqs = new Map(), shebangs = new Set();
  for (const f of files) {
    if (!/\.(py|js|cjs|mjs|ts|sh|bash)$/.test(f)) continue;
    const s = readSmall(f);
    if (s == null) continue;
    const r = rel(f);
    const sb = s.match(/^#![^\n]*/);
    if (sb) { const w = sb[0].replace(/^#!\s*\S*\/(?:env\s+(?:-S\s+)?)?/, '').split(/\s/)[0]; if (w) shebangs.add(w.replace(/\d+(\.\d+)*$/, (v) => (w.startsWith('python') ? '3' : ''))); }
    if (/\.py$/.test(f)) {
      for (const m of s.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w]*)[\w.]*[ \t]+import|import[ \t]+([A-Za-z_][\w]*))/gm)) {
        const mod = m[1] || m[2];
        if (PY_STDLIB.has(mod) || localModule(mod) || PY_IMPORT_PKG[mod] === '') continue;
        if (!pyImports.has(mod)) pyImports.set(mod, r);
      }
    } else if (/\.(js|cjs|mjs|ts)$/.test(f)) {
      for (const m of s.matchAll(/(?:require\(\s*|from\s+|import\s+)['"]([^'"./][^'"]*)['"]/g)) {
        const mod = m[1].replace(/^node:/, '').split('/').slice(0, m[1].startsWith('@') ? 2 : 1).join('/');
        if (require('module').builtinModules.includes(mod) || !DEP_NAME_RE.test(mod)) continue;
        if (!nodeReqs.has(mod)) nodeReqs.set(mod, r);
      }
    }
  }
  for (const [mod, r] of pyImports) {
    const pkg = PY_IMPORT_PKG[mod] || mod;
    add({ type: 'py', name: mod, pip: pkg, label: pipLabel(pkg), why: 'importado pelos scripts da skill' }, `${r} importa ${mod}`);
  }
  // 3) comandos de instalação citados no SKILL.md
  const consumed = new Set();
  for (const line of codeLines(md)) {
    let m;
    if ((m = line.match(/^(?:sudo\s+)?(?:(?:python3?|py)\s+-m\s+pip|pip3?|uv\s+pip)\s+install\s+(.+)$/i))) {
      const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith('-') && a !== 'install' && !/^(\.|\/|~)/.test(a) && !/\.txt$/.test(a));
      if (/-r\s+\S+/.test(m[1]) && !args.length) { consumed.add(line); continue; } // requirements.txt já foi lido
      for (const a of args) addPip(a, `SKILL.md: ${line.slice(0, 80)}`);
      if (args.length) consumed.add(line);
    } else if ((m = line.match(/^(?:sudo\s+)?(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(?:-g|--global)\s+(.+)$/i)) || (m = line.match(/^(?:sudo\s+)?(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(.+?)\s+(?:-g|--global)\s*$/i))) {
      for (const a of m[1].split(/\s+/).filter((a) => a && !a.startsWith('-'))) {
        const name = a.replace(/@(latest|next|[\d^~][^\s]*)$/, '');
        if (DEP_NAME_RE.test(name)) { add({ type: 'npm', name, npm: name, label: `Node: ${name}`, why: 'ferramenta de linha de comando pedida pelo SKILL.md' }, `SKILL.md: ${line.slice(0, 80)}`); consumed.add(line); }
      }
    } else if ((m = line.match(/^(?:sudo\s+)?brew\s+install\s+(.+)$/i))) {
      for (const a of m[1].split(/\s+/).filter((a) => a && !a.startsWith('-'))) addSysPkg(a, 'brew', `SKILL.md: ${line.slice(0, 80)}`);
      consumed.add(line);
    } else if ((m = line.match(/^(?:sudo\s+)?apt(?:-get)?\s+install\s+(.+)$/i))) {
      for (const a of m[1].split(/\s+/).filter((a) => a && !a.startsWith('-'))) addSysPkg(a, 'apt', `SKILL.md: ${line.slice(0, 80)}`);
      consumed.add(line);
    } else if ((m = line.match(/^winget\s+install\s+(?:.*--id\s+)?(\S+)/i))) {
      addSysPkg(m[1], 'winget', `SKILL.md: ${line.slice(0, 80)}`);
      consumed.add(line);
    }
  }
  // 4) programas usados pelos shebangs
  if (shebangs.has('python3') || shebangs.has('python') || pyImports.size) add({ type: 'bin', name: IS_WIN ? 'python' : 'python3', label: 'Python 3', why: 'os scripts da skill são em Python', manual: 'https://www.python.org/downloads/', apt: 'python3', brew: 'python', winget: 'Python.Python.3.13', pacman: 'python' }, 'scripts .py');
  if (shebangs.has('node') || nodeReqs.size) add({ type: 'bin', name: 'node', label: 'Node.js', why: 'os scripts da skill são em Node', manual: 'https://nodejs.org', apt: 'nodejs', brew: 'node', winget: 'OpenJS.NodeJS.LTS', pacman: 'nodejs' }, 'scripts .js');
  // 5) passos que o hub não faz sozinho: outros comandos de setup e variáveis de ambiente
  const seenCmd = new Set();
  for (const line of codeLines(md)) {
    if (consumed.has(line) || seenCmd.has(line) || !SETUP_CMD_RE.test(line)) continue;
    if (!/\b(install|add|sync|init|login|auth|setup)\b/i.test(line) || /\b(run|test|start|exec|build)\b/i.test(line.split(/\s+/)[1] || '')) continue;
    seenCmd.add(line);
    if (steps.length < 8) steps.push({ kind: 'cmd', title: 'Comando pedido pelo SKILL.md', detail: '', cmd: line.slice(0, 160), evidence: 'SKILL.md' });
  }
  for (const m of md.matchAll(ENV_VAR_RE)) if (!/^(YOUR|MY|EXAMPLE|SOME|XXX|FOO)_/.test(m[1])) envVars.add(m[1]);
  for (const v of [...envVars].slice(0, 6)) steps.push({ kind: 'env', title: `Variável de ambiente ${v}`, detail: 'o SKILL.md faz referência a ela: defina no ambiente da conta antes de usar', cmd: '', evidence: 'SKILL.md' });
  if (nodeReqs.size && !files.some((f) => path.basename(f) === 'package.json')) {
    const list = [...nodeReqs.keys()];
    steps.push({ kind: 'cmd', title: `Pacotes Node usados pelos scripts (${list.slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''})`, detail: 'não há package.json na skill: instale-os na pasta da skill se os scripts falharem', cmd: `npm install ${list.slice(0, 8).join(' ')}`, evidence: [...nodeReqs.values()][0] });
  }
  for (const d of deps.values()) { d.why = d.evidence.length ? `${d.why} · ${d.evidence.slice(0, 2).join('; ')}` : d.why; d.evidence = d.evidence.slice(0, 4); }
  return { deps: [...deps.values()], steps, envVars: [...envVars] };
}

// Item do catálogo que contém a skill, se houver.
function catalogItemOf(folder) {
  const c = currentSynced(SYNCED.catalog).data || {};
  for (const id of c.order || []) { const it = c.items && c.items[id]; if (it && Array.isArray(it.skills) && it.skills.includes(folder)) return it; }
  return null;
}
const sameRepo = (a, b) => { try { return parseSource(a).label.toLowerCase() === parseSource(b).label.toLowerCase(); } catch { return false; } };

// Onde está a pasta de cada skill: no clone (source) ou já instalada (installed).
async function skillDirs(folders, opts) {
  const out = new Map();
  if (opts.source) {
    const src = await fetchSource(opts.source);
    for (const f of folders) { const sk = src.skills.find((x) => x.folder === f); if (sk) out.set(f, { dir: sk.dir, label: src.label, compatibility: sk.compatibility || '' }); }
  } else if (opts.installed) {
    for (const t of skillTargets()) for (const sk of t.skills) {
      if (!folders.includes(sk.folder) || out.has(sk.folder)) continue;
      let dir = path.join(t.dir, sk.folder);
      try { dir = fs.realpathSync(dir); } catch {}
      out.set(sk.folder, { dir, label: sk.source || '', compatibility: sk.compatibility || '' });
    }
  }
  return out;
}

// Dependências das skills pedidas. Curadoria (skill-deps.json) só vale quando a skill é a do catálogo (mesmo repositório);
// para qualquer outro repositório, o hub deduz pelos arquivos da própria skill.
async function depsFor(folders, opts = {}) {
  const seen = new Map();
  const all = currentDeps();
  const dirs = await skillDirs(folders, opts);
  const steps = [], compat = {}, origin = {};
  for (const f of folders) {
    const where = dirs.get(f);
    const cat = catalogItemOf(f);
    const curated = cat && (!where || !where.label || sameRepo(cat.source, where.label));
    let list = [];
    if (curated) { list = Array.isArray(all[f]) ? all[f] : []; origin[f] = 'catalogo'; }
    else if (where) {
      const inf = inferDeps(where.dir, f);
      list = inf.deps; origin[f] = 'inferida';
      for (const s of inf.steps) steps.push({ ...s, skill: f });
    } else origin[f] = 'desconhecida';
    if (where && where.compatibility) compat[f] = where.compatibility;
    for (const d of list) {
      const key = `${d.type}:${d.name}`;
      const prev = seen.get(key);
      if (prev) { prev.skills.push(f); if (!d.optional) prev.optional = false; continue; }
      seen.set(key, { ...d, key, skills: [f], optional: Boolean(d.optional) });
    }
  }
  return { deps: [...seen.values()], steps, compat, origin };
}

// Gerenciadores de pacotes do sistema (Linux): o primeiro encontrado vale. "key" é a chave do pacote em skill-deps.json;
// "py" dá o nome provável do pacote de um módulo Python quando o JSON não traz um explícito.
const SYS_PMS = [
  { id: 'apt', bin: 'apt-get', key: 'apt', args: (p) => ['apt', 'install', '-y', ...p], pipPkg: 'python3-pip', py: (pip) => `python3-${pip.toLowerCase()}`, fallbackKey: 'apt' },
  { id: 'dnf', bin: 'dnf', key: 'dnf', args: (p) => ['dnf', 'install', '-y', ...p], pipPkg: 'python3-pip', py: (pip) => `python3-${pip.toLowerCase()}`, fallbackKey: 'apt' },
  { id: 'zypper', bin: 'zypper', key: 'zypper', args: (p) => ['zypper', '--non-interactive', 'install', ...p], pipPkg: 'python3-pip', py: (pip) => `python3-${pip}`, fallbackKey: 'apt' },
  { id: 'pacman', bin: 'pacman', key: 'pacman', args: (p) => ['pacman', '-S', '--needed', '--noconfirm', ...p], pipPkg: 'python-pip', py: (pip) => `python-${pip.toLowerCase()}`, fallbackKey: '' },
  { id: 'apk', bin: 'apk', key: 'apk', args: (p) => ['apk', 'add', ...p], pipPkg: 'py3-pip', py: (pip) => `py3-${pip.toLowerCase()}`, fallbackKey: '' },
];
async function systemPm() {
  if (IS_MAC || IS_WIN) return null;
  for (const pm of SYS_PMS) if (await which(pm.bin)) return pm;
  return null;
}
const sysPkgOf = (d, pm) => (d[pm.key] || (pm.fallbackKey && d.type === 'bin' ? d[pm.fallbackKey] : '') || (d.type === 'py' && d.apt && d.pip ? pm.py(d.pip) : '') || '');
const MANUAL_URL = { node: 'https://nodejs.org', pip: 'https://pip.pypa.io/en/stable/installation/', brew: 'https://brew.sh' };

// how de cada dependência que falta:
//   pip | npm | brew  → o hub instala sozinho, sem sudo
//   sys               → gerenciador do sistema (apt, dnf, zypper, pacman, apk): precisa de sudo, sai em sysCommand
//   needs-pip         → módulo Python sem pip na máquina: o pip entra em sysCommand e a skill deve ser instalada de novo depois
//   npm-sudo          → pacote Node com npm global do root: sai em npmCommand
//   winget            → programa no Windows: sai em sysCommand (sem sudo, pode abrir o UAC)
//   manual            → só à parte, com link em manual[]
async function checkDeps(folders, opts = {}) {
  const { deps, steps, compat, origin } = await depsFor(folders, opts);
  const [npmRoot, hasPip, pm, hasBrew, hasWinget, hasNpm] = await Promise.all([
    run('npm', ['root', '-g'], 10000).then((r) => (r.ok ? r.stdout : '')),
    pyRun(['-m', 'pip', '--version'], 10000).then((r) => r.ok),
    systemPm(),
    IS_MAC ? which('brew') : false,
    IS_WIN ? which('winget') : false,
    which('npm'),
  ]);
  const npmSudo = hasNpm && (await npmNeedsSudo());
  await Promise.all(deps.map(async (d) => {
    if (!DEP_NAME_RE.test(d.name) || (d.type === 'py' && !PY_MOD_RE.test(d.name))) { d.ok = false; d.how = 'manual'; return; }
    if (d.type === 'bin') d.ok = await which(d.name);
    else if (d.type === 'py') d.ok = (await pyRun(['-c', `import ${d.name}`])).ok;
    else if (d.type === 'npm') d.ok = Boolean(npmRoot) && fs.existsSync(path.join(npmRoot, d.name, 'package.json'));
    if (d.ok) { d.how = ''; return; }
    const sysPkg = pm ? sysPkgOf(d, pm) : '';
    if (d.type === 'py') {
      if (hasPip) d.how = 'pip';
      else if (pm) { d.how = sysPkg ? 'sys' : 'needs-pip'; d.pkg = sysPkg; }
      else if (IS_WIN && hasWinget) { d.how = 'winget'; d.pkg = 'Python.Python.3.13'; d.note = 'instala o Python com pip; depois instale a skill de novo'; }
      else { d.how = 'manual'; d.manual = d.manual || MANUAL_URL.pip; }
    } else if (d.type === 'npm') {
      if (!hasNpm) { d.how = 'manual'; d.manual = MANUAL_URL.node; }
      else d.how = npmSudo ? 'npm-sudo' : 'npm';
    } else if (IS_MAC) {
      d.how = d.brew && hasBrew ? 'brew' : 'manual';
      if (d.how === 'manual') d.manual = d.manual || (d.brew ? MANUAL_URL.brew : '');
    } else if (IS_WIN) {
      if (d.winget && hasWinget) { d.how = 'winget'; d.pkg = d.winget; } else d.how = 'manual';
    } else if (pm && sysPkg) { d.how = 'sys'; d.pkg = sysPkg; }
    else d.how = 'manual';
  }));
  const need = deps.filter((d) => !d.ok && !d.optional);
  const sysPkgs = [...new Set(need.filter((d) => d.how === 'sys' || d.how === 'winget').map((d) => d.pkg))];
  if (pm && need.some((d) => d.how === 'needs-pip')) sysPkgs.push(pm.pipPkg);
  const sysArgs = !sysPkgs.length ? [] : pm ? pm.args(sysPkgs) : IS_WIN ? ['winget', 'install', '-e', ...sysPkgs.flatMap((id) => ['--id', id])] : [];
  const sysSudo = Boolean(pm) && sysArgs.length > 0;
  const npmPkgs = [...new Set(need.filter((d) => d.how === 'npm-sudo').map((d) => d.npm))].filter((x) => DEP_NAME_RE.test(x));
  const npmArgs = npmPkgs.length ? ['npm', 'install', '-g', ...npmPkgs] : [];
  const sysCommand = sysArgs.length ? `${sysSudo ? 'sudo ' : ''}${sysArgs.join(' ')}` : '';
  return {
    deps,
    steps, compat, origin,
    inferred: deps.some((d) => d.inferred),
    allOk: need.length === 0,
    auto: need.filter((d) => ['pip', 'npm', 'brew'].includes(d.how)).map((d) => d.label),
    sysCommand, sysArgs, sysSudo, sysPm: pm ? pm.id : IS_WIN && hasWinget ? 'winget' : '',
    npmCommand: npmArgs.length ? `sudo ${npmArgs.join(' ')}` : '', npmArgs,
    aptCommand: sysCommand, // nome antigo, mantido para quem já consumia a API
    manual: need.filter((d) => d.how === 'manual').map((d) => ({ label: d.label, url: d.manual || '', pkg: d.apt || d.brew || '' })),
    hasPip,
  };
}

async function installDeps(folders, includeOptional = false, opts = {}) {
  const before = await checkDeps(folders, opts);
  const want = before.deps.filter((d) => !d.ok && (includeOptional || !d.optional));
  const pip = before.hasPip ? [...new Set(want.filter((d) => d.how === 'pip').map((d) => d.pip))].filter((x) => DEP_NAME_RE.test(x)) : [];
  const npm = [...new Set(want.filter((d) => d.how === 'npm').map((d) => d.npm))].filter((x) => DEP_NAME_RE.test(x));
  const brew = [...new Set(want.filter((d) => d.how === 'brew' && !d.brewCask).map((d) => d.brew))].filter((x) => DEP_NAME_RE.test(x));
  const casks = [...new Set(want.filter((d) => d.how === 'brew' && d.brewCask).map((d) => d.brew))].filter((x) => DEP_NAME_RE.test(x));
  const log = [];
  const tail = (r, fallback) => r.stderr.split('\n').filter(Boolean).pop() || fallback;
  for (const [list, args, what] of [[brew, ['install'], 'Homebrew'], [casks, ['install', '--cask'], 'Homebrew (apps)']]) {
    if (!list.length) continue;
    const r = await run('brew', [...args, ...list], 30 * 60 * 1000, { HOMEBREW_NO_AUTO_UPDATE: '1' });
    log.push(r.ok ? `${what}: ${list.join(', ')} instalados` : `${what}: falhou (${tail(r, 'brew indisponível')})`);
  }
  if (pip.length) {
    const venv = (await pyRun(['-c', 'import sys; sys.exit(sys.prefix == sys.base_prefix)'], 10000)).ok;
    let r = await pyRun(['-m', 'pip', 'install', ...(venv ? [] : ['--user']), '--quiet', ...pip], 10 * 60 * 1000);
    // PEP 668: Python do sistema recusa pip --user sem esta flag.
    if (!r.ok && !venv && /externally-managed/i.test(r.stderr)) {
      log.push('Python do sistema é gerenciado (PEP 668): instalando só no seu usuário com --break-system-packages');
      r = await pyRun(['-m', 'pip', 'install', '--user', '--quiet', '--break-system-packages', ...pip], 10 * 60 * 1000);
    }
    log.push(r.ok ? `Python: ${pip.join(', ')} instalados` : `Python: falhou (${r.stderr.split('\n').filter(Boolean).pop() || 'pip indisponível'})`);
  }
  if (npm.length) {
    const r = await run('npm', ['install', '-g', '--silent', ...npm], 10 * 60 * 1000);
    const last = r.stderr.split('\n').filter(Boolean).pop() || 'npm indisponível';
    log.push(r.ok ? `Node: ${npm.join(', ')} instalados` : `Node: falhou (${/EACCES|EPERM/.test(r.stderr) ? `sem permissão no npm global: rode no terminal sudo npm install -g ${npm.join(' ')}` : last})`);
  }
  return { log, ...(await checkDeps(folders, opts)) };
}

function dirEqual(a, b) {
  const list = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === '.hub-source' || e.name === INSTR_SKILL_MARK) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else out.push(`${e.isSymbolicLink() ? 'l' : e.isFile() ? 'f' : 'x'}:${path.relative(root, f)}`);
      }
    };
    walk(root);
    return out.sort();
  };
  // Nunca lê através de um link: um link para /dev/zero ou um FIFO travaria o servidor.
  const same = (e) => {
    const [kind, rel] = [e[0], e.slice(2)];
    if (kind === 'l') return fs.readlinkSync(path.join(a, rel)) === fs.readlinkSync(path.join(b, rel));
    return kind === 'f' && fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel)));
  };
  try {
    const fa = list(a), fb = list(b);
    if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
    return fa.every(same);
  } catch { return false; }
}

function insideDir(root, p) {
  let r = root;
  try { r = fs.realpathSync(root); } catch {}
  const rel = path.relative(r, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function writeSourceLine(dir, line) {
  const f = path.join(dir, '.hub-source');
  try { fs.unlinkSync(f); } catch {}
  fs.writeFileSync(f, line, { flag: 'wx' });
}

// Se o destino for um link (npx skills), atualiza a pasta original e mantém o link.
// Link para uma pasta de trabalho do usuário fora das pastas de skills não é sobrescrito.
function replaceSkillDir(srcDir, dest, sourceLine, fromRepo = false) {
  let real = dest;
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) {
      if (fs.existsSync(dest)) real = fs.realpathSync(dest);
      else fs.unlinkSync(dest);
    }
  } catch {}
  if (real !== dest) {
    const roots = [path.join(HOME, '.agents', 'skills'), ...skillTargets().map((t) => t.dir)];
    if (!roots.some((r) => path.dirname(real) === (() => { try { return fs.realpathSync(r); } catch { return r; } })()))
      throw new Error(`${path.basename(dest)} é um link para ${real.replace(HOME, '~')}, uma pasta sua. Atualize por lá ou apague o link antes`);
  }
  const parent = path.dirname(real), base = path.basename(real);
  fs.mkdirSync(parent, { recursive: true });
  const fresh = path.join(parent, `.${base}.hub-new-${process.pid}`);
  const old = path.join(parent, `.${base}.hub-old-${process.pid}`);
  rmSafe(fresh);
  // Links só podem apontar para dentro da própria skill: um repositório não alcança arquivos do usuário.
  const filter = (f) => {
    if (path.relative(srcDir, f).split(path.sep).includes('.git')) return false;
    if (fromRepo && ['.hub-source', INSTR_SKILL_MARK].includes(path.basename(f))) return false;
    let st;
    try { st = fs.lstatSync(f); } catch { return false; }
    if (!st.isSymbolicLink()) return true;
    try { return !path.isAbsolute(fs.readlinkSync(f)) && insideDir(srcDir, fs.realpathSync(f)); } catch { return false; }
  };
  try { fs.cpSync(srcDir, fresh, { recursive: true, verbatimSymlinks: true, filter }); }
  catch (e) {
    // Windows sem modo de desenvolvedor não cria links: copia o conteúdo
    if (e.code !== 'EPERM') throw e;
    rmSafe(fresh);
    fs.cpSync(srcDir, fresh, { recursive: true, dereference: true, filter });
  }
  if (sourceLine) writeSourceLine(fresh, sourceLine);
  const existed = fs.existsSync(real);
  if (existed) renameSafe(real, old);
  try {
    renameSafe(fresh, real);
  } catch (e) {
    if (existed) renameSafe(old, real);
    rmSafe(fresh);
    throw e;
  }
  if (existed) rmSafe(old);
  return real;
}

async function touchSkillLock(folder, src, relPath) {
  const lock = readSkillLock();
  if (!lock.skills?.[folder]) return;
  const tree = await run('git', ['-C', src.dir, 'rev-parse', `HEAD:${relPath}`]);
  if (tree.ok) lock.skills[folder].skillFolderHash = tree.stdout;
  lock.skills[folder].updatedAt = new Date().toISOString();
  writeReal(SKILL_LOCK, JSON.stringify(lock, null, 2));
}

async function updateSkill(body) {
  const folder = String(body.skill || '');
  if (!SKILL_NAME_RE.test(folder)) throw new Error('nome de skill inválido');
  const holders = skillTargets().filter((t) => t.skills.some((x) => x.folder === folder));
  if (!holders.length) throw new Error('skill não encontrada');
  const known = holders.flatMap((t) => t.skills).find((x) => x.folder === folder && x.source);
  const sourceArg = String(body.source || known?.source || '');
  if (!sourceArg) throw new Error('origem desconhecida');
  const src = await fetchSource(sourceArg, { fresh: true });
  const sk = src.skills.find((x) => x.folder === folder);
  if (!sk) throw new Error(`não encontrei a skill "${folder}" em ${src.label}`);
  const relPath = path.relative(src.dir, sk.dir);
  // Skills do npx skills já têm a origem no lock; não gravamos nada dentro delas.
  let npxDir = readSkillLock().skills?.[folder] ? path.join(HOME, '.agents', 'skills') : null;
  try { if (npxDir) npxDir = fs.realpathSync(npxDir); } catch {}
  const sourceLine = `${src.label}\n${src.commit} · ${src.date}\n`;
  const seen = new Set(), updated = [], unchanged = [];
  for (const t of holders) {
    const dest = path.join(t.dir, folder);
    let real = dest;
    try { real = fs.realpathSync(dest); } catch {}
    if (seen.has(real)) { continue; }
    seen.add(real);
    const line = npxDir && path.dirname(real) === npxDir ? null : sourceLine;
    if (dirEqual(sk.dir, real)) {
      unchanged.push(t.display);
      if (line && !lexists(path.join(real, '.hub-source')) && body.source) writeSourceLine(real, line);
    } else {
      replaceSkillDir(sk.dir, dest, line, true);
      updated.push(t.display);
    }
  }
  if (updated.length) await touchSkillLock(folder, src, relPath);
  return { skill: folder, source: src.label, commit: src.commit, date: src.date, updated, unchanged };
}

function copySkill(body) {
  const folder = String(body.skill || '');
  if (!SKILL_NAME_RE.test(folder)) throw new Error('nome de skill inválido');
  const all = skillTargets();
  const from = all.find((t) => t.skills.some((x) => x.folder === folder));
  if (!from) throw new Error('skill não encontrada');
  const srcDir = fs.realpathSync(path.join(from.dir, folder));
  const targets = all.filter((t) => asList(body.targets).includes(t.dir) && !t.skills.some((x) => x.folder === folder));
  if (!targets.length) throw new Error('escolha pelo menos uma conta');
  for (const t of targets) replaceSkillDir(srcDir, path.join(t.dir, folder), null);
  return targets.map((t) => t.display);
}

async function installSkills(body) {
  const src = await fetchSource(body.source, { fresh: true });
  const wanted = new Set(asList(body.skills).map(String));
  const targets = skillTargets().filter((t) => asList(body.targets).includes(t.dir));
  if (!targets.length) throw new Error('escolha pelo menos um agente');
  const chosen = src.skills.filter((sk) => wanted.has(sk.folder));
  if (!chosen.length) throw new Error('escolha pelo menos uma skill');
  for (const sk of chosen) {
    if (!SKILL_NAME_RE.test(sk.folder)) throw new Error(`nome de skill inválido: ${sk.folder}`);
    for (const t of targets) {
      replaceSkillDir(sk.dir, path.join(t.dir, sk.folder), `${src.label}\n${src.commit} · ${src.date}\n`, true);
    }
  }
  return { installed: chosen.map((sk) => sk.folder), targets: targets.map((t) => t.display), commit: src.commit, date: src.date };
}

function removeSkill(body) {
  const folder = String(body.skill || '');
  if (!SKILL_NAME_RE.test(folder)) throw new Error('nome de skill inválido');
  const all = skillTargets();
  const targets = all.filter((t) => asList(body.targets).includes(t.dir) && t.skills.some((x) => x.folder === folder));
  if (!targets.length) throw new Error('a skill não está nessas contas');
  const removedReal = [];
  for (const t of targets) {
    const p = path.join(t.dir, folder);
    let isLink = false;
    try { isLink = fs.lstatSync(p).isSymbolicLink(); } catch {}
    if (!isLink) { try { removedReal.push(fs.realpathSync(p)); } catch {} }
    fs.rmSync(p, { recursive: true, force: true });
  }
  // Links de outras contas que apontavam para a pasta apagada ficariam quebrados.
  for (const t of all) {
    const p = path.join(t.dir, folder);
    try { if (fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  const agentsDir = path.join(HOME, '.agents', 'skills', folder);
  if (removedReal.includes(agentsDir)) {
    const lock = readSkillLock();
    if (lock.skills?.[folder]) {
      delete lock.skills[folder];
      writeReal(SKILL_LOCK, JSON.stringify(lock, null, 2));
    }
  }
  return targets.length;
}

const asList = (v) => (Array.isArray(v) ? v : []);

async function installAccount(name, verb = 'instalar') {
  const account = readAccounts().find((a) => a.name === name);
  if (!account) throw new Error('conta não encontrada');
  if (verb === 'atualizar' && SELF_UPDATING[account.command]) throw new Error(SELF_UPDATING[account.command]);
  const how = await resolveInstall(account);
  if (!how.cmd) throw new Error(how.note || `não há comando de instalação para "${account.command}"`);
  // a interface não tem como pedir a senha do sudo: a pessoa roda no terminal
  if (how.needsSudo) throw new Error(`${how.note}. Rode no terminal: ${how.cmd}`);
  const min = NODE_MIN[account.command];
  if (min && (PKG_METHODS.includes(how.method) || how.method === 'config') && Number(process.versions.node.split('.')[0]) < min) {
    throw new Error(`${account.command} precisa do Node.js ${min} ou mais novo (você está no v${process.versions.node}). ` +
      `Com nvm: nvm install ${min} && nvm alias default ${min}, depois abra o hub de novo.`);
  }
  const r = await runShell(how.cmd, 10 * 60 * 1000);
  if (r.ok) {
    if (!(await which(account.command))) {
      const dir = how.method === 'native' ? homeRel(path.join(HOME, '.local', 'bin')) : how.method === 'npm' ? homeRel(npmBinDir((await npmPrefix()) || '')) : '';
      throw new Error(`${account.command} foi ${verb === 'atualizar' ? 'atualizado' : 'instalado'} via ${how.label}, mas não está no PATH${dir ? ` (procure em ${dir})` : ''}: abra um terminal novo ou adicione a pasta ao PATH e abra o hub de novo.`);
    }
    return how;
  }
  const output = (r.stdout + '\n' + r.stderr).trim().split('\n').slice(-8).join('\n');
  const hint = /EACCES|EPERM|permission denied|Permission denied/.test(output) ? ` Sem permissão de escrita: rode no terminal com sudo (${how.cmd}) ${NPM_PREFIX_HINT}.` : '';
  throw new Error(`falha ao ${verb} ${account.command} via ${how.label} (${how.cmd}): ${output}${hint}`);
}

async function versions(installedMap) {
  const result = {};
  await Promise.all(
    Object.keys(installedMap).filter((c) => installedMap[c] && c !== 'aws').map(async (c) => {
      const r = await run(c, ['--version'], 8000);
      const m = (r.stdout || r.stderr).match(/\d+\.\d+\.\d+[\w.-]*/);
      if (m) result[c] = m[0];
    }),
  );
  return result;
}

const SYNC_EVERY = 30 * 60 * 1000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Upsert: chaves novas entram, existentes são atualizadas, só locais ficam; listas são substituídas.
function upsertMerge(base, incoming) {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) out[k] = isObj(v) && isObj(base[k]) ? upsertMerge(base[k], v) : v;
  return out;
}

const SYNCED = {
  models: { file: 'agent-models.json', valid: (m) => isObj(m) && isObj(m.families) && isObj(m.agents) && typeof m.checkedAt === 'string' },
  catalog: {
    file: 'skill-catalog.json',
    valid: (m) => isObj(m) && isObj(m.items) && Array.isArray(m.order) && typeof m.checkedAt === 'string',
    merge: (cur, rem, merged) => ({ ...merged, order: [...rem.order, ...(cur.order || []).filter((id) => !rem.order.includes(id) && merged.items[id])] }),
  },
  deps: { file: 'skill-deps.json', valid: (m) => isObj(m) && typeof m.checkedAt === 'string' },
};
for (const [name, def] of Object.entries(SYNCED)) {
  def.name = name;
  def.bundled = path.join(__dirname, def.file);
  def.local = path.join(path.dirname(CONFIG), def.file);
  def.meta = { fetchedAt: null, lastCheck: 0, lastError: '' };
}

// Catálogo e dependências são curadoria do hub: vale sempre a versão que vem com ele.
function currentSynced(def) {
  const local = def.name === 'models' ? readJson(def.local) : null, bundled = readJson(def.bundled);
  if (!def.valid(local)) return { data: bundled, origin: 'embutida' };
  if (!def.valid(bundled)) return { data: local, origin: 'local' };
  const data = JSON.parse(JSON.stringify(bundled));
  for (const [f, fam] of Object.entries(local.families || {})) {
    if (!Object.hasOwn(data.families, f) || !isObj(fam)) continue;
    if (Array.isArray(fam.models) && fam.models.length) data.families[f].models = fam.models;
    if (f === 'gemini' && typeof fam.extra === 'string') data.families[f].extra = fam.extra;
  }
  data.checkedAt = local.checkedAt > bundled.checkedAt ? local.checkedAt : bundled.checkedAt;
  return { data, origin: 'local' };
}

function stripBlocks(h) {
  const low = h.toLowerCase();
  let out = '', i = 0, s = low.indexOf('<script'), t = low.indexOf('<style');
  for (;;) {
    if (s !== -1 && s < i) s = low.indexOf('<script', i);
    if (t !== -1 && t < i) t = low.indexOf('<style', i);
    const a = s === -1 ? t : t === -1 ? s : Math.min(s, t);
    if (a === -1) return out + h.slice(i);
    out += h.slice(i, a);
    const close = a === s ? '</script>' : '</style>';
    const e = low.indexOf(close, a);
    if (e === -1) return out;
    i = e + close.length;
  }
}
const htmlText = (h) => stripBlocks(h).replace(/<[^<>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const uniq = (a) => [...new Set(a)];
const verNewer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const OFFICIAL = {
  claude: { url: 'https://code.claude.com/docs/en/model-config', read(t) {
    const best = {};
    for (const m of t.matchAll(/\b(Opus|Sonnet|Haiku|Fable) (\d+(?:\.\d+)?)\b/g)) if (!best[m[1]] || verNewer(m[2], best[m[1]])) best[m[1]] = m[2];
    return ['Opus', 'Sonnet', 'Haiku', 'Fable'].filter((f) => best[f]).map((f) => `${f} ${best[f]}`);
  } },
  codex: { url: 'https://learn.chatgpt.com/docs/models', read: (t) =>
    uniq([...t.matchAll(/codex -m (gpt-[0-9.]+-[a-z]+)/g)].map((m) => m[1].replace(/^gpt-/, 'GPT-').replace(/-([a-z]+)$/, (_, n) => ` ${cap(n)}`))) },
  gemini: { url: 'https://geminicli.com/docs/cli/model/', read: (t) =>
    uniq([...t.matchAll(/gemini-\d+(?:\.\d+)?-(?:pro|flash)(?:-preview)?/g)].map((m) => m[0].replace(/^gemini-/, 'Gemini ').replace(/-preview$/, '').replace(/-(pro|flash)$/, (_, n) => ` ${cap(n)}`))).sort().reverse() },
  // fica o que algum plano pessoal tem e não está marcado para sair (*)
  antigravity: { url: 'https://antigravity.google/docs/models.md', read(t) {
    const rows = [...t.matchAll(/\|\s*\[?((?:Gemini|Claude)[^|\]]*?)\]?(?:\([^)]*\))?\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/g)];
    return uniq(rows.filter((r) => {
      const raw = r[1].trim();
      const leaving = /\\\*$/.test(raw) && !/\\\*\\\*$/.test(raw);
      return !leaving && [r[2], r[3], r[4]].some((c) => c.includes('✅'));
    }).map((r) => r[1].replace(/\\\*/g, '').replace(/\s*\(thinking\)/i, '').trim()));
  } },
  copilot: { url: 'https://docs.github.com/en/copilot/reference/ai-models/supported-models', read(t) {
    const navEnd = t.indexOf('Model retirement history'), end = t.lastIndexOf('Model retirement history');
    const part = end > navEnd ? t.slice(navEnd + 1, end) : t;
    return uniq([...part.matchAll(/\b(GPT-\d[\d.]*(?: (?:Astra|Sol|Terra|Luna|mini|nano))?|Claude (?:Opus|Sonnet|Haiku|Fable) \d[\d.]*|Gemini \d[\d.]* (?:Pro|Flash|Argon|Carbon)|Grok \d[\d.]*|Kimi K\d+|MAI-Code[\w.-]*)\b/g)].map((m) => m[1].replace(/\.$/, '')));
  } },
};
const latestOnly = (list) => {
  const best = new Map();
  for (const m of list) { const [, name, v] = m.match(/^(.*?)[ -]?([\d.]+)?$/) || [m, m, '']; const k = name.replace(/[ -]$/, ''); if (!best.has(k) || (v && verNewer(v, best.get(k).v))) best.set(k, { m, v: v || '' }); }
  return [...best.values()].map((x) => x.m);
};

async function readCapped(res, max) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > max) throw new Error('grande');
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchOfficialModels() {
  const pages = await Promise.all(Object.entries(OFFICIAL).map(async ([k, src]) => {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'agent-hub' } });
      if (!res.ok) return [k, null, `${src.url} respondeu ${res.status}`];
      const list = src.read(htmlText(await readCapped(res, 5 * 1024 * 1024)));
      return [k, list.length ? list : null, list.length ? '' : `não encontrei modelos em ${src.url} (a página mudou?)`];
    } catch (e) { return [k, null, e.name === 'TimeoutError' ? 'sem resposta' : e.message === 'grande' ? `${src.url} veio grande demais` : 'sem conexão']; }
  }));
  const got = Object.fromEntries(pages.map(([k, list]) => [k, list]));
  const errors = pages.filter(([, , err]) => err).map(([, , err]) => err);
  if (!Object.values(got).some(Boolean)) throw new Error(errors[0] || 'sem conexão');
  const families = {};
  if (got.claude) families.claude = { models: got.claude };
  if (got.codex) families.gpt = { models: got.codex };
  // Com conta Google pessoal o Gemini é pelo Antigravity; a lista do Gemini CLI é reserva.
  const agyGemini = (got.antigravity || []).filter((m) => m.startsWith('Gemini'));
  if (agyGemini.length || got.gemini) families.gemini = { models: agyGemini.length ? agyGemini : got.gemini };
  if (got.copilot) {
    const geminiExtra = got.copilot.filter((m) => m.startsWith('Gemini') && !(families.gemini?.models || []).includes(m));
    families.outros = { models: latestOnly(got.copilot.filter((m) => /^(Grok|Kimi|MAI)/.test(m))) };
    const notes = [geminiExtra.length ? `No Copilot também: ${geminiExtra.join(', ')}` : '', 'No Gemini CLI só com chave de API ou Enterprise'];
    families.gemini = { ...(families.gemini || {}), extra: notes.filter(Boolean).join(' · ') };
  }
  const allOk = Object.values(got).every(Boolean);
  return { remote: { checkedAt: new Date().toISOString().slice(0, 10), families }, partial: allOk ? '' : errors.join(' · ') };
}

async function refreshSynced(def, force) {
  if (def.name !== 'models') return false; // catálogo e dependências são curadoria do hub
  if (!force && Date.now() - def.meta.lastCheck < SYNC_EVERY) return false;
  def.meta.lastCheck = Date.now();
  try {
    const { remote, partial } = await fetchOfficialModels();
    const current = currentSynced(def).data || {};
    let merged = upsertMerge(current, remote);
    if (def.merge) merged = def.merge(current, remote, merged);
    def.meta.fetchedAt = new Date().toISOString();
    def.meta.lastError = partial ? `parcial: ${partial}` : '';
    // só a data mudou: não regrava
    const prev = readJson(def.local);
    if (prev && sameJson({ ...merged, checkedAt: prev.checkedAt }, prev)) return false;
    fs.mkdirSync(path.dirname(def.local), { recursive: true });
    fs.writeFileSync(def.local + '.tmp', JSON.stringify(merged, null, 2) + '\n');
    fs.renameSync(def.local + '.tmp', def.local);
    if (TTY) event('ok', `lista de modelos atualizada a partir das páginas oficiais ${C.gray(`(${merged.checkedAt})`)}`);
    return true;
  } catch (e) {
    def.meta.lastError = e.name === 'TimeoutError' ? 'sem resposta' : e.message === 'fetch failed' ? 'sem conexão' : e.message;
    def.meta.lastCheck = Date.now() - SYNC_EVERY + 2 * 60 * 1000; // falhou: tenta de novo em 2 min
    return false;
  }
}
const refreshAll = (force = false) => Promise.all(Object.values(SYNCED).map((d) => refreshSynced(d, force)));

function syncedState(def) {
  const { data, origin } = currentSynced(def);
  return { ...data, _meta: { origin, fetchedAt: def.meta.fetchedAt, lastError: def.meta.lastError, localFile: def.local.replace(HOME, '~') } };
}
function catalogState() {
  const c = syncedState(SYNCED.catalog);
  return { checkedAt: c.checkedAt, _meta: c._meta, items: (c.order || []).filter((id) => c.items[id]).map((id) => ({ id, ...c.items[id] })) };
}
const currentDeps = () => currentSynced(SYNCED.deps).data || {};

const LOGIN_TTL = 5 * 60 * 1000;
const loginCache = new Map();
const envDir = (a, key, fallback) => (a.env[key] ? expandHome(a.env[key]) : path.join(HOME, fallback));

function claudeRelogin(dir) {
  // Data em que a renovação automática para e o login volta a ser obrigatório.
  const c = readJson(path.join(dir, '.credentials.json'))?.claudeAiOauth;
  const d = c?.refreshTokenExpiresAt ? new Date(c.refreshTokenExpiresAt) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

// Codex: a saída de `login status` nunca é mostrada (no modo chave de API traz parte da chave);
// e-mail e plano vêm só do payload do id_token, e nenhum token sai do servidor.
const CODEX_PLANS = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
async function codexLogin(a) {
  const home = envDir(a, 'CODEX_HOME', '.codex');
  const env = fullEnv();
  if (a.env.CODEX_HOME) env.CODEX_HOME = home; else delete env.CODEX_HOME;
  if (!fs.existsSync(home)) return { state: 'login', note: 'nunca usado nesta pasta' };
  const rr = await run('codex', ['login', 'status'], 15000, env);
  const r = { ok: rr.ok, text: `${rr.stdout}\n${rr.stderr}` };
  if (!r.ok || /not logged in/i.test(r.text)) return { state: 'login', note: 'sem login' };
  const mode = /using chatgpt/i.test(r.text) ? 'chatgpt' : /^\s*api key/im.test(r.text) ? 'apikey' : 'other';
  if (mode === 'apikey') return { state: 'ok', who: 'chave de API da OpenAI' };
  if (mode !== 'chatgpt') return { state: 'ok' };
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
    const payload = JSON.parse(Buffer.from(String(auth.tokens?.id_token || '').split('.')[1] || '', 'base64url').toString('utf8'));
    const plan = payload['https://api.openai.com/auth']?.chatgpt_plan_type || '';
    return { state: 'ok', who: payload.email || payload['https://api.openai.com/profile']?.email || '', plan: CODEX_PLANS[plan] || plan };
  } catch {
    return { state: 'ok', note: 'login do ChatGPT' };
  }
}

// Desde 18/06/2026 o Google recusa o login pessoal (oauth-personal) no Gemini CLI; vale chave de API, Vertex ou Enterprise.
function geminiLogin(a) {
  const root = a.env.GEMINI_CLI_HOME ? path.join(expandHome(a.env.GEMINI_CLI_HOME), '.gemini') : path.join(HOME, '.gemini');
  const settings = readJson(path.join(root, 'settings.json')) || {};
  const envOf = (k) => a.env[k] || process.env[k] || '';
  const dotenvHas = (k) => [path.join(root, '.env'), path.join(a.env.GEMINI_CLI_HOME ? expandHome(a.env.GEMINI_CLI_HOME) : HOME, '.env')]
    .some((f) => { try { return new RegExp(`^\\s*(export\\s+)?${k}\\s*=\\s*\\S`, 'm').test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
  const has = (k) => Boolean(envOf(k)) || dotenvHas(k);
  let mode = settings.security?.auth?.selectedType || '';
  if (!mode) mode = has('GOOGLE_GENAI_USE_VERTEXAI') ? 'vertex-ai' : has('GEMINI_API_KEY') ? 'gemini-api-key' : fs.existsSync(path.join(root, 'oauth_creds.json')) ? 'oauth-personal' : '';
  const email = readJson(path.join(root, 'google_accounts.json'))?.active || '';
  if (mode === 'gemini-api-key') return has('GEMINI_API_KEY') ? { state: 'ok', who: 'chave de API do Gemini' } : { state: 'login', note: 'falta a chave GEMINI_API_KEY' };
  if (mode === 'vertex-ai') return { state: 'ok', who: 'Vertex AI (Google Cloud)' };
  if (mode === 'oauth-personal') {
    if (has('GOOGLE_CLOUD_PROJECT') || has('GOOGLE_CLOUD_PROJECT_ID')) return { state: 'ok', who: email, plan: 'Code Assist (projeto do Google Cloud)' };
    return { state: 'blocked', who: email, note: 'o Google desativou o login com conta pessoal no Gemini CLI em 18/06/2026' };
  }
  if (mode) return { state: 'ok', who: mode };
  return { state: 'login', note: 'sem login' };
}

// Copilot: os tokens ficam no chaveiro e nunca são lidos.
function copilotLogin(a) {
  const tokenEnv = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].find((k) => a.env[k] || process.env[k]);
  const home = envDir(a, 'COPILOT_HOME', '.copilot');
  const cfg = readJson(path.join(home, 'config.json')) || {};
  const user = cfg.lastLoggedInUser || (Array.isArray(cfg.loggedInUsers) ? cfg.loggedInUsers[0] : null);
  const who = user?.login ? `@${user.login}${user.host && !/^(https:\/\/)?github\.com\/?$/.test(user.host) ? ` (${user.host})` : ''}` : '';
  if (tokenEnv) return { state: 'ok', who: who || 'token do GitHub', note: `usa o token de ${tokenEnv}` };
  if (who) return { state: 'ok', who };
  return { state: 'login', note: fs.existsSync(home) ? 'sem login do GitHub' : 'nunca usado nesta pasta' };
}

// Bedrock: a conta logada é a identidade da AWS (sts get-caller-identity não altera nada).
async function bedrockLogin(a) {
  const env = awsEnvOf(a);
  const profile = env.AWS_PROFILE || 'default';
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || iniSections(AWS_CONFIG, true)[profile]?.region || '';
  if (!(await which('aws'))) return { state: 'unknown', note: 'AWS CLI não instalado' };
  const r = await run('aws', ['sts', 'get-caller-identity', '--profile', profile, '--output', 'json', ...(region ? ['--region', region] : [])], 15000, env);
  const aws = { profile, region };
  if (!r.ok) {
    const sso = /sso|token.*expired|expired.*token/i.test(r.stderr);
    return { state: 'login', aws, note: sso ? 'a sessão do AWS SSO venceu' : /could not be found|not found/i.test(r.stderr) ? `perfil "${profile}" não encontrado` : 'credenciais AWS inválidas ou vencidas' };
  }
  try {
    const id = JSON.parse(r.stdout);
    return { state: 'ok', aws: { ...aws, account: id.Account, arn: id.Arn } };
  } catch { return { state: 'unknown', aws }; }
}

async function loginStatus(a, force = false) {
  const hit = loginCache.get(a.name);
  if (!force && hit && Date.now() - hit.at < LOGIN_TTL) return hit.status;
  let st = { state: 'unknown' };
  try {
    if (a.type === 'bedrock') {
      st = await bedrockLogin(a);
    } else if (a.command === 'claude') {
      const dir = envDir(a, 'CLAUDE_CONFIG_DIR', '.claude');
      const env = fullEnv();
      if (a.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = dir; else delete env.CLAUDE_CONFIG_DIR;
      // no macOS o login fica no Keychain, não em arquivo
      const r = await run('claude', ['auth', 'status', '--json'], 15000, env);
      let j = null;
      try { j = JSON.parse(r.stdout || ''); } catch {}
      if (!j || typeof j.loggedIn !== 'boolean') st = { state: 'unknown', note: 'não consegui consultar o login do Claude Code' };
      else if (j.loggedIn && j.apiProvider && !/^(firstparty|anthropic|claude\.ai)$/i.test(String(j.apiProvider))) {
        // provedor de terceiros (Bedrock, Vertex, Foundry): não há login da Anthropic a vencer
        const prov = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' }[String(j.apiProvider).toLowerCase()] || String(j.apiProvider);
        st = { state: 'ok', who: '', plan: '', note: `via ${prov}` };
      } else st = j.loggedIn ? { state: 'ok', who: j.email || '', plan: j.subscriptionType || '', relogin: claudeRelogin(dir) || j.loginExpiresAt || null } : { state: 'login', note: 'sessão encerrada' };
    } else if (a.command === 'codex') {
      st = await codexLogin(a);
    } else if (a.command === 'gemini') {
      st = geminiLogin(a);
    } else if (a.command === 'copilot') {
      st = copilotLogin(a);
    } else if (a.command === 'agy') {
      st = fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli'))
        ? { state: 'unknown', note: 'o Antigravity não informa a conta fora dele: o e-mail aparece na barra de status do agy' }
        : { state: 'unknown', note: 'nunca aberto: na primeira vez ele abre o login do Google no navegador' };
    }
  } catch { st = { state: 'unknown' }; }
  if (st.relogin) {
    const days = Math.ceil((new Date(st.relogin) - Date.now()) / 86400000);
    st.days = days;
    if (days <= 0) st = { ...st, state: 'login', note: 'o login venceu' };
  }
  loginCache.set(a.name, { at: Date.now(), status: st });
  return st;
}

const CLEAN_TOOLS = {
  claude: {
    title: 'Claude Code', pkg: '@anthropic-ai/claude-code', native: { bin: '.local/bin/claude', under: '.local/share/claude' },
    data: [
      ['.claude', 'login, histórico de conversas, ajustes e skills'],
      ['.claude.json', 'preferências e estado do Claude Code'],
      ['.local/state/claude', 'travas do instalador'],
      ['.cache/claude', 'arquivos temporários do instalador'],
    ],
    orphan: /^\.claude-[^/]+$/, orphanWhat: 'login e histórico de uma conta Claude separada',
    keychain: 'o login fica em ~/.claude/.credentials.json (Linux) ou no Keychain (macOS)',
  },
  codex: {
    title: 'Codex', pkg: '@openai/codex', native: { bin: '.local/bin/codex', under: '.codex/packages', extra: ['.local/bin/codex-code-mode-host'] },
    data: [['.codex', 'login (auth.json), histórico, sessões e config.toml']],
    orphan: /^\.codex-[^/]+$/, orphanWhat: 'login e histórico de uma conta Codex separada',
    keychain: 'se o login estiver no chaveiro do sistema ("Codex Auth"), ele não é apagado. Rode codex logout antes',
  },
  gemini: {
    title: 'Gemini CLI', pkg: '@google/gemini-cli',
    // ~/.gemini também guarda dados do Antigravity e arquivos que os dois leem
    data: ['settings.json', 'projects.json', 'state.json', 'state.json.bak', 'trustedFolders.json', 'installation_id', 'policy_integrity.json',
      'oauth_creds.json', 'google_accounts.json', 'gemini-credentials.json', 'mcp-oauth-tokens.json', 'mcp-oauth-tokens-v2.json', 'a2a-oauth-tokens.json',
      'extension_integrity.json', 'extension-enablement.json', 'keybindings.json', 'extensions', 'tmp', 'history', 'commands', 'policies', 'agents',
      'acknowledgments', 'bin'].map((f) => [path.join('.gemini', f), f === 'oauth_creds.json' || f === 'google_accounts.json' ? 'login do Google' : 'dados do Gemini CLI']),
    dataGlob: { dir: '.gemini', re: /^projects\.json\..+\.tmp$/ },
    keep: 'Ficam em ~/.gemini: skills/, GEMINI.md, AGENTS.md e as pastas do Antigravity (lidos também pelo Antigravity).',
    orphan: /^\.gemini-[^/]+$/, orphanWhat: 'login e histórico de uma conta Gemini separada',
    keychain: 'chaves salvas no chaveiro ("gemini-cli-oauth", "gemini-cli-api-key") não são apagadas',
  },
  copilot: {
    title: 'GitHub Copilot CLI', pkg: '@github/copilot',
    data: [['.copilot', 'ajustes, sessões, histórico e skills'], ['.cache/copilot', 'cache']],
    orphan: /^\.copilot-[^/]+$/, orphanWhat: 'ajustes e sessões de uma conta Copilot separada',
    keychain: 'o token no chaveiro ("copilot-cli") não é apagado. Rode copilot logout antes; o token também continua válido no GitHub',
  },
  agy: {
    title: 'Antigravity CLI', native: { bin: '.local/bin/agy', plain: true },
    data: [['.gemini/antigravity-cli', 'ajustes, conversas e skills do Antigravity CLI'], ['.cache/antigravity', 'arquivos temporários do instalador']],
    keep: 'Ficam: ~/.gemini/config e ~/.gemini/antigravity (usados também pelo app Antigravity) e a linha "# Added by Antigravity CLI installer" no seu .bashrc/.zshrc (só garante ~/.local/bin no PATH).',
    keychain: 'o login fica no chaveiro do sistema e não é apagado. Rode /logout dentro do agy antes',
  },
};

// Algum arquivo de inicialização do shell cita este caminho (ex.: alias claude=~/.claude/local/claude)?
function rcMentions(fragment) {
  for (const f of ['.bashrc', '.zshrc', '.bash_profile', '.profile', '.zprofile', path.join('.config', 'fish', 'config.fish')]) {
    try { if (fs.readFileSync(path.join(HOME, f), 'utf8').includes(fragment)) return true; } catch {}
  }
  return false;
}
function dirSize(p) {
  let total = 0;
  const walk = (x) => {
    let st;
    try { st = fs.lstatSync(x); } catch { return; }
    total += st.size;
    if (st.isDirectory()) { try { for (const e of fs.readdirSync(x)) walk(path.join(x, e)); } catch {} }
  };
  walk(p);
  return total;
}
const du = (p) => (IS_WIN ? Promise.resolve(dirSize(p)) : run('du', ['-sk', p], 30000).then((r) => (r.ok ? Number(r.stdout.split(/\s/)[0]) * 1024 : dirSize(p))));
const homeRel = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
// Caminho pronto para colar no shell (comandos exibidos ao usuário).
const shPath = (p) => {
  const q = (x) => (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`);
  const r = homeRel(p);
  return r.startsWith('~/') ? '~/' + q(r.slice(2)) : q(r);
};
const npmModDir = (prefix) => (IS_WIN ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'));
const npmBinOf = (prefix) => (IS_WIN ? path.join(prefix, 'npm.cmd') : path.join(prefix, 'bin', 'npm'));
const npmBinDir = (prefix) => (IS_WIN ? prefix : path.join(prefix, 'bin'));
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function usedDirs(accounts) {
  const keys = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME'];
  return new Set(accounts.flatMap((a) => keys.filter((k) => a.env[k]).map((k) => samePath(expandHome(a.env[k])))));
}

async function npmInstalls(pkg) {
  const prefixes = new Set();
  const nvm = IS_WIN ? (process.env.NVM_HOME || '') : path.join(process.env.NVM_DIR || path.join(HOME, '.nvm'), 'versions', 'node');
  const add = (p) => { try { prefixes.add(fs.realpathSync(p)); } catch {} };
  try { if (nvm) for (const v of fs.readdirSync(nvm)) if (/^v\d/.test(v)) add(path.join(nvm, v)); } catch {}
  const g = await run('npm', ['config', 'get', 'prefix'], 10000);
  if (g.ok && g.stdout) add(g.stdout.trim());
  for (const p of IS_WIN ? [path.join(process.env.APPDATA || '', 'npm')] : ['/usr', '/usr/local', '/opt/homebrew']) add(p);
  const nvmReal = (() => { try { return nvm ? fs.realpathSync(nvm) : ''; } catch { return nvm; } })();
  const out = [];
  for (const prefix of prefixes) {
    const dir = path.join(npmModDir(prefix), pkg);
    if (!fs.existsSync(dir)) continue;
    let writable = true;
    try { fs.accessSync(path.dirname(dir), fs.constants.W_OK); } catch { writable = false; }
    const admin = IS_WIN ? 'como administrador: ' : 'sudo ';
    const node = nvmReal && prefix.startsWith(nvmReal) ? `Node ${path.basename(prefix)} (nvm)` : writable ? `npm global em ${homeRel(prefix)}` : `Node do sistema em ${prefix} (precisa de ${IS_WIN ? 'administrador' : 'sudo'})`;
    const npmBin = npmBinOf(prefix);
    const hasNpm = fs.existsSync(npmBin);
    out.push({ id: `npm:${prefix}`, kind: 'npm', label: `npm · ${node}`, prefix, writable: writable && hasNpm,
      command: hasNpm ? `${writable ? '' : admin}${winQuote(npmBin)} uninstall -g ${pkg}` : `${writable ? '' : admin}${IS_WIN ? `rmdir /s /q ${winQuote(dir)}` : `rm -rf ${shPath(dir)}`}` });
  }
  return out;
}

async function toolInventory(accounts) {
  const used = usedDirs(accounts);
  const tools = [];
  for (const [cmd, t] of Object.entries(CLEAN_TOOLS)) {
    const usedBy = accounts.filter((a) => a.command === cmd).map((a) => ({ name: a.name, label: a.label }));
    const installs = t.pkg ? await npmInstalls(t.pkg) : [];
    if (t.native) {
      const bin = !IS_WIN ? path.join(HOME, t.native.bin)
        : cmd === 'agy' ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
        : path.join(HOME, t.native.bin + '.exe');
      if (lexists(bin)) {
        let real = bin;
        try { real = fs.realpathSync(bin); } catch {}
        const ours = t.native.plain || (t.native.under && real.startsWith(path.join(HOME, t.native.under)));
        const paths = [bin, ...(t.native.extra || []).map((x) => path.join(HOME, x)), ...(t.native.under && !t.native.plain ? [path.join(HOME, t.native.under)] : [])].filter(lexists);
        if (ours) installs.push({ id: 'native', kind: 'native', label: `instalador oficial · ${homeRel(bin)}`, paths,
          command: IS_WIN ? paths.map((x) => `del /f /q ${winQuote(x)}`).join(' & ') : `rm -rf ${paths.map(shPath).join(' ')}` });
      }
    }
    const found = await whichAll(cmd);
    const known = (p) => installs.some((i) => (i.prefix && (p.startsWith(npmModDir(i.prefix)) || (IS_WIN && path.dirname(p).toLowerCase() === i.prefix.toLowerCase())))
      || (i.paths || []).some((x) => p === x || p.startsWith(x + path.sep)));
    const seenReal = new Set();
    for (const p of found) {
      let real = p;
      try { real = fs.realpathSync(p); } catch {}
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      if (!known(real) && !installs.some((i) => i.id === `other:${p}`)) {
        const brew = IS_MAC && /\/(Cellar|Caskroom|homebrew)\//.test(real);
        installs.push({ id: `other:${p}`, kind: 'manual', label: `${brew ? 'Homebrew' : 'outro instalador'} · ${homeRel(p)}`,
          command: brew ? `brew uninstall ${{ claude: '--cask claude-code', codex: '--cask codex', gemini: 'gemini-cli', copilot: '--cask copilot-cli', agy: '--cask antigravity-cli' }[cmd]}` : `remova pelo instalador que você usou (${homeRel(p)})` });
      }
    }
    const data = [];
    const addData = async (rel, what) => {
      const p = path.join(HOME, rel);
      if (!lexists(p) || used.has(path.resolve(p))) return;
      data.push({ id: `data:${rel}`, path: homeRel(p), abs: p, what, size: await du(p) });
    };
    for (const [rel, what] of t.data) await addData(rel, what);
    if (t.dataGlob) { try { for (const f of fs.readdirSync(path.join(HOME, t.dataGlob.dir))) if (t.dataGlob.re.test(f)) await addData(path.join(t.dataGlob.dir, f), 'dados do Gemini CLI'); } catch {} }
    if (cmd === 'claude' && !installs.some((i) => i.kind === 'native') && fs.existsSync(path.join(HOME, '.local/share/claude'))) {
      await addData('.local/share/claude', 'restos de uma instalação nativa antiga (nenhum comando usa)');
    }
    const orphans = [];
    if (t.orphan) {
      for (const e of fs.readdirSync(HOME)) {
        if (!t.orphan.test(e)) continue;
        const p = path.join(HOME, e);
        if (used.has(samePath(p)) || !fs.lstatSync(p).isDirectory()) continue;
        orphans.push({ id: `orphan:${e}`, path: homeRel(p), abs: p, what: t.orphanWhat, size: await du(p) });
      }
    }
    tools.push({ command: cmd, title: t.title, usedBy, installs, data, orphans, keep: t.keep || '', keychain: t.keychain || '' });
  }
  return tools;
}

// ── lixo de cada IA: o que pode sair com a ferramenta instalada e logada ──
// Regras (dados): tool → entradas. base = pasta de dados da conta; kind: dir | files (com idade mínima) | glob.
// risky = não apagar com a ferramenta aberta. Vereditos conferidos nas docs e no código de cada CLI.
const GARBAGE_RULES = {
  claude: [
    { rel: 'debug', kind: 'dir', what: 'logs de depuração', why: 'só servem para investigar problemas; o Claude Code apaga depois de 30 dias' },
    { rel: 'cache', kind: 'dir', what: 'cache (changelog, catálogo de modelos)', why: 'baixado de novo quando precisa' },
    { rel: 'downloads', kind: 'dir', what: 'downloads do instalador', why: 'arquivos temporários de atualização', risky: true },
    { rel: 'todos', kind: 'dir', what: 'pasta antiga (todos)', why: 'o Claude Code não usa mais' },
    { rel: 'statsig', kind: 'dir', what: 'pasta antiga (statsig)', why: 'o Claude Code não usa mais' },
    { rel: 'logs', kind: 'dir', what: 'pasta antiga (logs)', why: 'o Claude Code não usa mais' },
    { rel: 'image-cache', kind: 'dir', what: 'pasta antiga (image-cache)', why: 'o Claude Code não usa mais' },
    { rel: 'shell-snapshots', kind: 'dir', what: 'snapshots do shell', why: 'cada sessão cria o seu e apaga ao sair; sobram só os de sessões que caíram', risky: true },
    { rel: 'paste-cache', kind: 'files', days: 'claude', what: 'textos colados antigos', why: 'o Claude Code apaga depois de 30 dias' },
    { rel: 'file-history', kind: 'per-session', what: 'histórico de edições de sessões vencidas', why: 'usado pelo /rewind; só de sessões cuja conversa já venceu ou não existe mais' },
    { rel: 'session-env', kind: 'per-session', what: 'dados de sessões vencidas', why: 'metadados de sessões cuja conversa já venceu ou não existe mais' },
    { rel: 'projects', kind: 'sessions', what: 'conversas antigas', why: 'o próprio Claude Code apaga transcrições depois do prazo (cleanupPeriodDays); a memória automática fica. Conversas do Claude Desktop e do Cowork não têm prazo e o hub não as distingue: se você usa, deixe desmarcado', keepRecent: true, defaultOff: true },
  ],
  codex: [
    { rel: 'log', kind: 'dir', what: 'logs', why: 'o Codex recria e já limpa sozinho (10 dias)' },
    { rel: 'tmp', kind: 'dir', what: 'arquivos temporários', why: 'sobras de processos que já terminaram', risky: true },
    { rel: 'cache', kind: 'dir', what: 'cache (catálogo de plugins, animações)', why: 'baixado de novo quando precisa' },
    { rel: 'shell_snapshots', kind: 'dir', what: 'snapshots do shell', why: 'o Codex apaga sozinho depois de 3 dias', risky: true },
    { rel: 'packages/app-server-daemon/releases', kind: 'releases', current: 'packages/app-server-daemon/current', keepFiles: ['packages/app-server-daemon/selection-history', 'packages/app-server-daemon/auto-update-version'], what: 'versões antigas do daemon', why: 'o Codex guarda só a atual e a anterior; estas são mais velhas' },
    { rel: 'packages/standalone/releases', kind: 'releases', current: 'packages/standalone/current', keepFiles: ['packages/standalone/selection-history', 'packages/standalone/auto-update-version'], what: 'versões antigas do Codex', why: 'só a versão em uso (current) é necessária' },
    { rel: '.', kind: 'sqlite-old', what: 'bancos de dados de versões antigas', why: 'o Codex migrou para um banco novo e não lê mais estes' },
  ],
  gemini: [
    { rel: 'tmp', kind: 'files', days: 30, what: 'sessões e arquivos temporários com mais de 30 dias', why: 'o Gemini CLI apaga sessões depois de 30 dias (sessionRetention); as recentes ficam para o --resume', keepRecent: true },
    { rel: '.', kind: 'glob', re: /^projects\.json\.[0-9a-f-]{8,}\.tmp$/, what: 'arquivos temporários órfãos', why: 'sobras de gravações interrompidas do projects.json' },
  ],
  copilot: [
    { rel: 'logs', kind: 'dir', what: 'logs', why: 'o Copilot recria e já limpa sozinho (7 dias)' },
    { rel: 'crash-reports', kind: 'dir', what: 'relatórios de travamento', why: 'só servem para diagnóstico' },
    { rel: 'crash-context', kind: 'dir', what: 'contexto de travamentos', why: 'só serve para diagnóstico' },
    { rel: 'pkg', kind: 'dir', what: 'pasta antiga de atualizações', why: 'usada por versões antigas do Copilot' },
  ],
  agy: [
    { rel: 'logs', kind: 'dir', what: 'logs', why: 'recriados a cada execução' },
    { rel: '.', kind: 'glob', re: /^cli\.log$/, what: 'log do agy', why: 'recriado a cada execução' },
    { rel: 'updater', kind: 'glob', re: /^update\.lock$/, what: 'trava do atualizador', why: 'sobra de uma atualização interrompida', risky: true },
  ],
  aws: [
    { rel: 'cli/cache', kind: 'dir', what: 'credenciais temporárias em cache', why: 'a AWS gera de novo na próxima chamada (é o que a documentação manda apagar para renovar)' },
  ],
};
const GARBAGE_EXTRA = {
  claude: [
    { abs: () => (IS_WIN ? '' : path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'claude', 'staging')), what: 'downloads do instalador nativo', why: 'usados só durante uma atualização', risky: true },
    { abs: () => (IS_WIN ? '' : path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'claude', 'locks')), what: 'travas do instalador', why: 'sobras de instalações que já terminaram', risky: true },
    { abs: () => path.join(HOME, '.claude', 'local'), what: 'instalação local antiga (npm)', why: 'formato antigo; nenhum comando nem alias usa', unlessRunsFrom: true, unlessAliased: true },
  ],
  copilot: [
    { abs: () => process.env.COPILOT_CACHE_HOME || (IS_MAC ? path.join(HOME, 'Library', 'Caches', 'copilot') : IS_WIN ? path.join(process.env.LOCALAPPDATA || '', 'copilot') : path.join(HOME, '.cache', 'copilot')), what: 'cache e atualizações baixadas', why: 'recriado sozinho; o Copilot volta à versão instalada até a próxima atualização automática', risky: true },
  ],
  gemini: [
    { abs: () => (IS_MAC ? '' : path.join(HOME, '.cache', '.gemini')), what: 'pasta de sandbox', why: 'só é usada no macOS com sandbox; aqui é sobra' },
  ],
  agy: [
    { abs: () => path.join(HOME, '.cache', 'antigravity', 'staging'), what: 'downloads do instalador', why: 'sobra de uma instalação interrompida', risky: true },
  ],
};
const GARBAGE_BASE = {
  claude: (a) => claudeDir(a), bedrock: (a) => claudeDir(a), codex: (a) => codexDir(a),
  gemini: (a) => geminiDir(a), copilot: (a) => copilotDir(a), antigravity: () => path.join(HOME, '.gemini', 'antigravity-cli'),
};
const GARBAGE_TOOL = { claude: 'claude', bedrock: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', antigravity: 'agy' };
const GARBAGE_TITLE = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI', agy: 'Antigravity CLI', aws: 'AWS CLI (Bedrock)', hub: 'Agent Hub' };
const gid = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);

async function isRunning(cmd) {
  if (IS_WIN) { const r = await run('tasklist', ['/FI', `IMAGENAME eq ${cmd}.exe`, '/NH'], 10000, undefined, ['tasklist', ['/FI', `IMAGENAME eq ${cmd}.exe`, '/NH'], {}]); return r.ok && new RegExp(`^${cmd}\\.exe`, 'im').test(r.stdout); }
  const r = await run('pgrep', ['-x', cmd], 5000);
  return r.ok && r.stdout.trim().length > 0;
}

// Arquivos mais velhos que N dias dentro de uma pasta (não segue links).
// Prazo do próprio Claude Code (cleanupPeriodDays no settings.json da conta; padrão 30, mínimo 1).
function claudeRetention(base) {
  const v = Number(readJson(path.join(base, 'settings.json'))?.cleanupPeriodDays);
  return Number.isFinite(v) && v >= 1 ? v : 30;
}
// Sessões do Claude Code vencidas: a transcrição <sessão>.jsonl manda; a pasta <sessão>/ (subagentes, resultados) vai junto.
// memory/ nunca entra. Pastas de sessão sem transcrição só saem se tudo nelas for velho.
function oldSessions(projects, days) {
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  let projs = [];
  try { projs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()); } catch { return out; }
  for (const pr of projs) {
    const dir = path.join(projects, pr.name);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const mt = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return Infinity; } };
    const sessions = new Set();
    for (const e of entries) {
      const m = e.name.match(/^([0-9a-f-]{36})(?:\.jsonl|\.orphaned-.*\.jsonl|\.jsonl\.superseded-.*)?$/);
      if (m) sessions.add(m[1]);
    }
    for (const sid of sessions) {
      const files = entries.filter((e) => e.isFile() && e.name.startsWith(sid)).map((e) => path.join(dir, e.name));
      const sdir = path.join(dir, sid);
      const hasDir = entries.some((e) => e.name === sid && e.isDirectory() && !e.isSymbolicLink());
      const main = path.join(dir, `${sid}.jsonl`);
      let newest = fs.existsSync(main) ? mt(main) : 0;
      if (!fs.existsSync(main)) { for (const f of files) newest = Math.max(newest, mt(f)); if (hasDir) newest = Math.max(newest, newestIn(sdir)); }
      if (!newest || newest >= cutoff) continue;
      for (const f of files) { try { out.push({ p: f, size: fs.statSync(f).size }); } catch {} }
      if (hasDir) out.push({ p: sdir, size: dirSize(sdir) });
    }
  }
  return out;
}
// Sessões com transcrição ainda dentro do prazo (em qualquer projeto).
function liveSessions(projects, cutoff) {
  const live = new Set();
  let projs = [];
  try { projs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return live; }
  for (const pr of projs) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(projects, pr.name)); } catch { continue; }
    for (const n of entries) {
      const m = n.match(/^([0-9a-f-]{36})\.jsonl$/);
      if (!m) continue;
      try { if (fs.statSync(path.join(projects, pr.name, n)).mtimeMs >= cutoff) live.add(m[1]); } catch {}
    }
  }
  return live;
}
function newestIn(dir) {
  let newest = 0;
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) walk(p); else { try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {} } } };
  walk(dir);
  return newest;
}
function oldFiles(dir, days, skip = []) {
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p); }
      else { try { const st = fs.statSync(p); if (st.mtimeMs < cutoff) out.push({ p, size: st.size }); } catch {} }
    }
  };
  walk(dir);
  return out;
}

// Só limpa pastas que são da ferramenta: oculta (.claude-x) ou com um arquivo dela.
const TOOL_MARKS = {
  claude: ['.claude.json', '.credentials.json', 'settings.json', 'projects', 'history.jsonl'],
  codex: ['auth.json', 'config.toml', 'sessions', 'history.jsonl'],
  copilot: ['config.json', 'session-state'],
};
const toolDir = (base, tool) => path.basename(base).startsWith('.') || (TOOL_MARKS[tool] || []).some((m) => lexists(path.join(base, m)));

async function scanGarbage(accounts) {
  const byTool = new Map();
  const add = (tool, item) => { if (!byTool.has(tool)) byTool.set(tool, []); if (!byTool.get(tool).some((x) => x.id === item.id)) byTool.get(tool).push(item); };
  const running = {};
  for (const t of ['claude', 'codex', 'gemini', 'copilot', 'agy']) running[t] = await isRunning(t);
  const bases = new Map();
  for (const a of accounts) {
    const f = GARBAGE_BASE[a.type];
    if (!f) continue;
    const b = f(a), tool = GARBAGE_TOOL[a.type];
    if (!unsafeDir(b) && toolDir(b, tool) && ![...bases.keys()].some((x) => samePath(x) === samePath(b))) bases.set(b, tool);
  }
  for (const [tool, folder] of [['claude', '.claude'], ['codex', '.codex'], ['gemini', '.gemini'], ['copilot', '.copilot'], ['agy', path.join('.gemini', 'antigravity-cli')]]) {
    const d = path.join(HOME, folder);
    if (![...bases.keys()].some((b) => samePath(b) === samePath(d)) && fs.existsSync(d)) bases.set(d, tool);
  }
  for (const [base, tool] of bases) {
    for (const r of GARBAGE_RULES[tool] || []) {
      const p = path.join(base, r.rel);
      if (r.rel !== '.' && lexists(p) && fs.lstatSync(p).isSymbolicLink()) continue;
      if (r.kind === 'dir') {
        if (!lexists(p)) continue;
        const size = await du(p);
        if (!size) continue;
        add(tool, { id: gid(p), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size, kind: 'dir', risky: Boolean(r.risky) && running[tool] });
      } else if (r.kind === 'files') {
        if (!fs.existsSync(p)) continue;
        const days = r.days === 'claude' ? claudeRetention(base) : r.days;
        const files = oldFiles(p, days, r.skip || []);
        if (!files.length) continue;
        add(tool, { id: gid(p + '|old'), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size: files.reduce((n, f) => n + f.size, 0), count: files.length, days, skip: r.skip || [], kind: 'old', keepRecent: Boolean(r.keepRecent) });
      } else if (r.kind === 'per-session') {
        if (!fs.existsSync(p)) continue;
        const days = claudeRetention(base);
        const cutoff = Date.now() - days * 86400000;
        const live = liveSessions(path.join(base, 'projects'), cutoff);
        let entries = [];
        try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch {}
        const old = [];
        for (const e of entries) {
          if (e.isSymbolicLink()) continue;
          const sid = (e.name.match(/^([0-9a-f-]{36})/) || [])[1];
          if (!sid || live.has(sid)) continue;
          const x = path.join(p, e.name);
          const newest = e.isDirectory() ? newestIn(x) : (() => { try { return fs.statSync(x).mtimeMs; } catch { return Infinity; } })();
          if (newest && newest < cutoff) old.push({ p: x, size: e.isDirectory() ? dirSize(x) : (() => { try { return fs.statSync(x).size; } catch { return 0; } })() });
        }
        if (!old.length) continue;
        add(tool, { id: gid(p + '|per-session'), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size: old.reduce((n, f) => n + f.size, 0), count: old.length, days, kind: 'glob', files: old.map((f) => f.p) });
      } else if (r.kind === 'sessions') {
        if (!fs.existsSync(p)) continue;
        const days = claudeRetention(base);
        const old = oldSessions(p, days);
        if (!old.length) continue;
        add(tool, { id: gid(p + '|sessions'), tool, path: p, display: homeRel(p), what: `${r.what} (mais de ${days} dias)`, why: r.why, size: old.reduce((n, f) => n + f.size, 0), count: old.length, days, kind: 'glob', files: old.map((f) => f.p), keepRecent: true, defaultOff: true });
      } else if (r.kind === 'sqlite-old') {
        let names = [];
        try { names = fs.readdirSync(p).filter((n) => /^(state|logs)(_\d+)?\.sqlite(-wal|-shm)?$/.test(n)); } catch {}
        const latest = {};
        for (const n of names) { const m = n.match(/^(state|logs)(?:_(\d+))?\.sqlite/); const v = Number(m[2] || 0); if (!(m[1] in latest) || v > latest[m[1]]) latest[m[1]] = v; }
        const old = names.filter((n) => { const m = n.match(/^(state|logs)(?:_(\d+))?\.sqlite/); return Number(m[2] || 0) < latest[m[1]]; });
        if (!old.length) continue;
        const files = old.map((n) => path.join(p, n));
        add(tool, { id: gid(p + '|sqlite-old'), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size: files.reduce((n, f) => { try { return n + fs.lstatSync(f).size; } catch { return n; } }, 0), count: files.length, kind: 'glob', files, names: old, risky: running[tool] });
      } else if (r.kind === 'glob') {
        let names = [];
        try { names = fs.readdirSync(p).filter((n) => r.re.test(n)); } catch {}
        if (!names.length) continue;
        const files = names.map((n) => path.join(p, n));
        add(tool, { id: gid(p + '|' + r.re.source), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size: files.reduce((n, f) => { try { return n + fs.lstatSync(f).size; } catch { return n; } }, 0), count: files.length, kind: 'glob', files, names, risky: Boolean(r.risky) && running[tool] });
      } else if (r.kind === 'releases') {
        let cur = '';
        try { cur = fs.realpathSync(path.join(base, r.current)); } catch {}
        const keep = new Set();
        for (const f of r.keepFiles || []) { try { for (const l of fs.readFileSync(path.join(base, f), 'utf8').split('\n')) if (l.trim()) keep.add(l.trim()); } catch {} }
        let names = [];
        try { names = fs.readdirSync(p); } catch {}
        const old = names.map((n) => path.join(p, n)).filter((x) => { try { return fs.lstatSync(x).isDirectory() && fs.realpathSync(x) !== cur && ![...keep].some((k) => { const b = path.basename(x); return b === k || k.startsWith(b) || b.startsWith(k) || k.endsWith(b); }); } catch { return false; } });
        if (!old.length || !cur) continue;
        let size = 0;
        for (const x of old) size += await du(x);
        // no Linux/macOS um binário antigo pode ser apagado mesmo em uso; o Windows trava o arquivo
        add(tool, { id: gid(p + '|releases'), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size, count: old.length, kind: 'glob', files: old, names: old.map((x) => path.basename(x)), risky: IS_WIN && running[tool] });
      }
    }
  }
  const which = {};
  for (const tool of ['claude', 'codex', 'gemini', 'copilot', 'agy', 'aws']) which[tool] = (await whichAll(tool))[0] || '';
  if ((accounts.some((a) => a.type === 'bedrock') || which.aws) && fs.existsSync(path.join(HOME, '.aws'))) {
    const base = path.dirname(AWS_CONFIG);
    for (const r of GARBAGE_RULES.aws) {
      const p = path.join(base, r.rel);
      if (!lexists(p) || fs.lstatSync(p).isSymbolicLink()) continue;
      const size = await du(p);
      if (size) add('aws', { id: gid(p), tool: 'aws', path: p, display: homeRel(p), what: r.what, why: r.why, size, kind: 'dir' });
    }
  }
  for (const [tool, rules] of Object.entries(GARBAGE_EXTRA)) {
    if (![...bases.values()].includes(tool)) continue;
    for (const r of rules) {
      const p = r.abs();
      if (!p || !lexists(p) || fs.lstatSync(p).isSymbolicLink()) continue;
      if (r.unlessRunsFrom && which[tool]) { let real = which[tool]; try { real = fs.realpathSync(real); } catch {} if (real.startsWith(p + path.sep)) continue; }
      if (r.unlessAliased && rcMentions(homeRel(p).replace(/^~/, ''))) continue;
      const size = await du(p);
      if (!size) continue;
      add(tool, { id: gid(p), tool, path: p, display: homeRel(p), what: r.what, why: r.why, size, kind: 'dir', risky: Boolean(r.risky) && running[tool] });
    }
  }
  // instalações que nunca rodam: restos do instalador nativo e cópias do npm que perdem no PATH
  const native = path.join(HOME, '.local', 'share', 'claude');
  if (fs.existsSync(native)) {
    let cur = '';
    try { cur = fs.realpathSync(path.join(HOME, '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude')); } catch {}
    const versions = path.join(native, 'versions');
    let names = [];
    try { names = fs.readdirSync(versions); } catch {}
    const byVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    const newest = new Set(names.filter((n) => /^\d+\.\d+/.test(n)).sort(byVer).slice(0, 2));
    const old = names.filter((n) => !newest.has(n)).map((n) => path.join(versions, n)).filter((x) => { try { return fs.realpathSync(x) !== cur; } catch { return false; } });
    const launcher = path.join(HOME, '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
    const anyUses = (await whichAll('claude')).some((w) => { try { return fs.realpathSync(w).startsWith(native + path.sep); } catch { return false; } });
    if (lexists(launcher) && !cur.startsWith(native)) {
      // lançador próprio (script ou link para outro lugar): o instalador guarda todas as versões para ele; não mexe
    } else if (!lexists(launcher) && !anyUses) {
      const size = await du(native);
      if (size) add('claude', { id: gid(native), tool: 'claude', path: native, display: homeRel(native), what: 'instalação nativa antiga', why: `sem lançador em ${homeRel(launcher)} e nenhum comando claude aponta para cá (o em uso é ${which.claude ? homeRel(which.claude) : 'outro'})`, size, kind: 'dir' });
    } else if (cur.startsWith(native) && old.length) {
      let size = 0;
      for (const x of old) size += await du(x);
      add('claude', { id: gid(versions + '|old'), tool: 'claude', path: versions, display: homeRel(versions), what: 'versões antigas do instalador nativo', why: 'o instalador guarda a versão em uso e as 2 mais novas; estas são mais velhas', size, count: old.length, kind: 'glob', files: old, names: old.map((x) => path.basename(x)), risky: running.claude });
    }
  }
  {
    const binDir = path.join(HOME, '.local', 'bin');
    let names = [];
    try { names = fs.readdirSync(binDir).filter((n) => /^claude\.old\.\d+\.\d+$/.test(n)); } catch {}
    const files = names.map((n) => path.join(binDir, n)).filter((f) => { try { return Date.now() - fs.statSync(f).mtimeMs > 30 * 86400000; } catch { return false; } });
    if (files.length) add('claude', { id: gid(binDir + '|claude.old'), tool: 'claude', path: binDir, display: homeRel(binDir), what: 'cópias antigas do comando claude', why: 'o atualizador guarda por 30 dias e depois descarta', size: files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0), count: files.length, kind: 'glob', files, names: files.map((f) => path.basename(f)) });
  }
  for (const [tool, pkg] of [['claude', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['gemini', '@google/gemini-cli'], ['copilot', '@github/copilot']]) {
    const installs = await npmInstalls(pkg);
    if (installs.length < 2 || !which[tool]) continue;
    let real = which[tool];
    try { real = fs.realpathSync(real); } catch {}
    for (const i of installs) {
      const dir = path.join(npmModDir(i.prefix), pkg);
      if (real.startsWith(dir)) continue;
      let ver = '';
      try { ver = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { continue; }
      const size = await du(dir);
      add(tool, { id: gid(dir), tool, path: dir, display: homeRel(dir), what: `cópia duplicada do npm${ver ? ` (v${ver})` : ''}`, why: `nunca roda: o ${tool} em uso vem de ${homeRel(path.dirname(real))}`, size, kind: i.writable ? 'dir' : 'sudo', command: i.command });
    }
  }
  // restos do próprio hub
  const tmp = os.tmpdir();
  const live = new Set([...sourceCache.values(), ...retired].map((e) => e.dir));
  let clones = [];
  try { clones = fs.readdirSync(tmp).filter((n) => n.startsWith('hub-skill-')).map((n) => path.join(tmp, n)).filter((p) => !live.has(p) && fs.lstatSync(p).isDirectory()); } catch {}
  if (clones.length) {
    let size = 0;
    for (const c of clones) size += await du(c);
    add('hub', { id: gid(tmp + '|hub-skill'), tool: 'hub', path: tmp, display: homeRel(tmp), what: 'clones temporários de skills', why: 'sobras de execuções antigas da interface', size, count: clones.length, kind: 'glob', files: clones, names: clones.map((x) => path.basename(x)) });
  }
  for (const t of skillTargets()) {
    let names = [];
    try { names = fs.readdirSync(t.dir).filter((n) => /^\..+\.hub-(new|old)-\d+$/.test(n)); } catch {}
    if (!names.length) continue;
    const files = names.map((n) => path.join(t.dir, n));
    let size = 0;
    for (const f of files) size += await du(f);
    add('hub', { id: gid(t.dir + '|swap'), tool: 'hub', path: t.dir, display: t.display, what: 'trocas de skill interrompidas', why: 'pastas de uma atualização que não terminou', size, count: files.length, kind: 'glob', files, names });
  }
  const tools = [...byTool.entries()].map(([tool, items]) => ({ tool, title: GARBAGE_TITLE[tool], items: items.sort((a, b) => b.size - a.size), total: items.reduce((n, i) => n + i.size, 0) }))
    .sort((a, b) => (a.tool === 'hub') - (b.tool === 'hub') || b.total - a.total);
  return { tools, total: tools.reduce((n, t) => n + t.total, 0), running };
}

async function cleanGarbage(body) {
  const scan = await scanGarbage(readAccounts());
  const tool = scan.tools.find((t) => t.tool === String(body.tool || ''));
  if (!tool) throw new Error('nada para limpar');
  const want = new Set(asList(body.items).map(String));
  const results = [];
  let freed = 0;
  for (const it of tool.items.filter((x) => want.has(x.id))) {
    if (it.kind === 'sudo') { results.push({ label: it.display, ok: false, msg: `precisa de sudo. Rode: ${it.command}` }); continue; }
    if (it.risky) { results.push({ label: it.display, ok: false, msg: `feche o ${tool.title} antes` }); continue; }
    try {
      if (it.kind === 'dir') { rmSafe(it.path); }
      else if (it.kind === 'glob') { for (const f of it.files) rmSafe(f); }
      else if (it.kind === 'old') { for (const f of oldFiles(it.path, it.days, it.skip || [])) { try { fs.unlinkSync(f.p); } catch {} } }
      freed += it.size;
      results.push({ label: `${it.what} · ${it.display}`, ok: true, msg: 'apagado' });
    } catch (e) { results.push({ label: it.display, ok: false, msg: e.message }); }
  }
  if (!results.length) throw new Error('nada selecionado');
  return { tool: tool.tool, title: tool.title, results, freed };
}

async function cleanupTool(body) {
  const accounts = readAccounts();
  const inv = (await toolInventory(accounts)).find((t) => t.command === String(body.tool || ''));
  if (!inv) throw new Error('ferramenta desconhecida');
  const want = new Set(Array.isArray(body.items) ? body.items.map(String) : []);
  const inUse = inv.usedBy.length > 0;
  const results = [];
  // CLI e dados só sem conta no hub; pastas órfãs (sem conta) sempre podem sair.
  for (const i of inv.installs.filter((x) => want.has(x.id))) {
    if (inUse) { results.push({ label: i.label, ok: false, msg: 'em uso por uma conta do hub' }); continue; }
    if (i.kind === 'npm') {
      if (!i.writable) { results.push({ label: i.label, ok: false, msg: `precisa de sudo. Rode: ${i.command}` }); continue; }
      const r = await run(npmBinOf(i.prefix), ['uninstall', '-g', CLEAN_TOOLS[inv.command].pkg], 5 * 60 * 1000,
        { [IS_WIN ? 'Path' : 'PATH']: `${npmBinDir(i.prefix)}${PATH_SEP}${process.env.PATH || process.env.Path || ''}` });
      results.push({ label: i.label, ok: r.ok, msg: r.ok ? 'desinstalado' : (r.stderr.split('\n').filter(Boolean).pop() || 'falhou') });
    } else if (i.kind === 'native') {
      try { for (const p of i.paths) rmSafe(p); results.push({ label: i.label, ok: true, msg: 'removido' }); }
      catch (e) { results.push({ label: i.label, ok: false, msg: e.message }); }
    } else {
      results.push({ label: i.label, ok: false, msg: `remova à mão: ${i.command}` });
    }
  }
  for (const d of [...inv.data, ...inv.orphans].filter((x) => want.has(x.id))) {
    if (inUse && d.id.startsWith('data:')) { results.push({ label: d.path, ok: false, msg: 'em uso por uma conta do hub' }); continue; }
    const p = d.abs;
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); else rmSafe(p);
      results.push({ label: d.path, ok: true, msg: 'apagado' });
    } catch (e) { results.push({ label: d.path, ok: false, msg: e.message }); }
  }
  if (!results.length) throw new Error('nada selecionado');
  return { tool: inv.command, results };
}

// Cada instrução do hub fica entre marcadores; o resto do arquivo nunca é alterado.
const claudeDir = (a) => (a.env.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude'));
const codexDir = (a) => (a.env.CODEX_HOME ? expandHome(a.env.CODEX_HOME) : path.join(HOME, '.codex'));
const geminiDir = (a) => path.join(a.env.GEMINI_CLI_HOME ? expandHome(a.env.GEMINI_CLI_HOME) : HOME, '.gemini');
const copilotDir = (a) => (a.env.COPILOT_HOME ? expandHome(a.env.COPILOT_HOME) : path.join(HOME, '.copilot'));
const nonEmpty = (f) => { try { return fs.readFileSync(f, 'utf8').trim().length > 0; } catch { return false; } };
const INSTR_FILE = {
  claude: (a) => path.join(claudeDir(a), 'CLAUDE.md'),
  bedrock: (a) => path.join(claudeDir(a), 'CLAUDE.md'),
  // um AGENTS.override.md com conteúdo faz o Codex ignorar o AGENTS.md
  codex: (a) => { const o = path.join(codexDir(a), 'AGENTS.override.md'); return nonEmpty(o) ? o : path.join(codexDir(a), 'AGENTS.md'); },
  // o Gemini CLI usa o 1º nome de context.fileName
  gemini: (a) => {
    const fn = readJson(path.join(geminiDir(a), 'settings.json'))?.context?.fileName;
    const name = (Array.isArray(fn) ? fn[0] : fn) || 'GEMINI.md';
    return path.join(geminiDir(a), /^[\w.-]+$/.test(name) && !/^\.+$/.test(name) ? name : 'GEMINI.md');
  },
  // ~/.gemini/GEMINI.md também é lido pelo Gemini CLI; ~/.gemini/config/AGENTS.md só pelo Antigravity
  antigravity: () => path.join(HOME, '.gemini', 'config', 'AGENTS.md'),
  copilot: (a) => path.join(copilotDir(a), 'copilot-instructions.md'),
};
const INSTR_LIMIT = { antigravity: 24000 }; // o Antigravity trunca arquivos maiores
const INSTR_DEFAULTS = [
  ['claude', path.join(HOME, '.claude', 'CLAUDE.md')], ['codex', path.join(HOME, '.codex', 'AGENTS.md')],
  ['gemini', path.join(HOME, '.gemini', 'GEMINI.md')], ['antigravity', path.join(HOME, '.gemini', 'config', 'AGENTS.md')],
  ['copilot', path.join(HOME, '.copilot', 'copilot-instructions.md')],
];
function extraInstrFiles(tool, a) {
  const md = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)); } catch { return []; } };
  if (tool === 'claude') return md(path.join(claudeDir(a), 'rules'), /\.md$/);
  if (tool === 'copilot') return md(path.join(copilotDir(a), 'instructions'), /\.instructions\.md$/);
  if (tool === 'antigravity') return [...md(path.join(HOME, '.gemini', 'config', 'rules'), /\.md$/), path.join(HOME, '.gemini', 'config', 'GEMINI.md')];
  return [];
}
const INSTR_BLOCK_RE = /<!-- agent-hub:begin ([a-z0-9-]+) \| ([^\n]*?) -->\n([\s\S]*?)\n<!-- agent-hub:end \1 -->\n?/g;
const slugify = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function instrTargets() {
  const map = new Map();
  for (const a of readAccounts()) {
    const f = INSTR_FILE[a.type];
    if (!f) continue;
    const file = f(a);
    const t = map.get(file) || { id: file, file, display: homeRel(file), tool: a.type === 'bedrock' ? 'claude' : a.type, accounts: [] };
    t.accounts.push({ name: a.name, label: a.label, type: a.type });
    map.set(file, t);
  }
  // arquivo padrão só para ferramentas sem conta (com conta, vale o arquivo que ela realmente lê)
  const withAccount = new Set([...map.values()].map((t) => t.tool));
  for (const [tool, file] of INSTR_DEFAULTS) {
    if (!withAccount.has(tool) && !map.has(file) && fs.existsSync(path.dirname(file))) map.set(file, { id: file, file, display: homeRel(file), tool, accounts: [] });
  }
  return [...map.values()];
}
function instrExtras(targets) {
  const seen = new Set(targets.map((t) => t.file));
  const out = [];
  for (const t of targets) {
    const acc = t.accounts[0] ? readAccounts().find((x) => x.name === t.accounts[0].name) : { env: {} };
    for (const f of extraInstrFiles(t.tool, acc || { env: {} })) {
      if (seen.has(f) || !fs.existsSync(f)) continue;
      seen.add(f);
      out.push({ file: f, tool: t.tool, accounts: t.accounts });
    }
  }
  return out;
}

function readInstrFile(file) {
  let text = '', crlf = false, bom = false;
  try {
    let raw = fs.readFileSync(file, 'utf8');
    bom = raw.charCodeAt(0) === 0xfeff;
    if (bom) raw = raw.slice(1);
    crlf = /\r\n/.test(raw);
    text = raw.replace(/\r\n/g, '\n');
  } catch {}
  const blocks = [];
  for (const m of text.matchAll(INSTR_BLOCK_RE)) blocks.push({ slug: m[1], title: m[2].trim(), content: m[3] });
  const rest = text.replace(INSTR_BLOCK_RE, '').trim();
  return { text, blocks, rest, crlf, bom };
}

// Pasta de skills de um destino de instrução: a conta manda; sem conta, a pasta padrão da ferramenta.
function instrSkillsDir(t) {
  const a = t.accounts[0] ? readAccounts().find((x) => x.name === t.accounts[0].name) : null;
  const type = a ? a.type : t.tool;
  const spec = SKILL_HOME[type];
  if (!spec) return '';
  let base = spec[0] && a && a.env[spec[0]] ? expandHome(a.env[spec[0]]) : path.join(HOME, spec[1]);
  if (type === 'gemini' && a && a.env.GEMINI_CLI_HOME) base = path.join(base, '.gemini');
  return path.join(base, 'skills');
}
const INSTR_SKILL_MARK = '.hub-instruction';
function readInstrSkill(dir) {
  try {
    const [slug, title = ''] = fs.readFileSync(path.join(dir, INSTR_SKILL_MARK), 'utf8').split('\n');
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
    return { slug: slug.trim(), title: title.trim(), content: body };
  } catch { return null; }
}
// Skill no padrão SKILL.md (Agent Skills): vira /nome no Claude, Gemini, Copilot e Antigravity, e $nome no Codex.
function writeInstrSkill(skillsDir, slug, title, content) {
  const dir = path.join(skillsDir, slug);
  const cur = readInstrSkill(dir);
  if (!cur && lexists(dir)) throw new Error(`já existe uma skill "${slug}" em ${homeRel(skillsDir)} que não é do hub. Use outro nome`);
  const desc = title.replace(/"/g, '\\"');
  const md = `---\nname: ${slug}\ndescription: "${desc}"\n---\n${content.replace(/\s+$/, '')}\n`;
  if (cur && cur.title === title && cur.content === md.replace(/^---\n[\s\S]*?\n---\n/, '')) return false;
  fs.mkdirSync(dir, { recursive: true });
  writeReal(path.join(dir, 'SKILL.md'), md);
  writeReal(path.join(dir, INSTR_SKILL_MARK), `${slug}\n${title}\n`);
  return true;
}
function removeInstrSkill(skillsDir, slug) {
  const dir = path.join(skillsDir, slug);
  if (!readInstrSkill(dir)) return false;
  rmSafe(dir);
  return true;
}

function instructionsState() {
  const targets = instrTargets();
  const items = new Map();
  const existing = [];
  for (const t of targets) {
    const { blocks, rest } = readInstrFile(t.file);
    for (const b of blocks) {
      const it = items.get(b.slug) || { slug: b.slug, title: b.title, content: b.content, files: [] };
      it.files.push(t.id);
      items.set(b.slug, it);
    }
    if (rest) existing.push({ file: t.id, display: t.display, tool: t.tool, accounts: t.accounts, text: rest.slice(0, 20000), size: Buffer.byteLength(rest), truncated: rest.length > 20000 });
    const sd = instrSkillsDir(t);
    let names = [];
    try { names = fs.readdirSync(sd); } catch {}
    for (const n of names) {
      const sk = readInstrSkill(path.join(sd, n));
      if (!sk || sk.slug !== n) continue;
      const it = items.get(sk.slug) || { slug: sk.slug, title: sk.title, content: sk.content, files: [], skills: [] };
      it.skills = it.skills || [];
      it.skills.push(t.id);
      items.set(sk.slug, it);
    }
  }
  for (const it of items.values()) it.skills = it.skills || [];
  for (const x of instrExtras(targets)) {
    const text = readInstrFile(x.file).text.trim();
    if (text) existing.push({ file: x.file, display: homeRel(x.file), tool: x.tool, accounts: x.accounts, text: text.slice(0, 20000), size: Buffer.byteLength(text), truncated: text.length > 20000 });
  }
  return { targets: targets.map(({ file, ...t }) => ({ ...t, exists: fs.existsSync(file), skillsDir: homeRel(instrSkillsDir(t)) })), items: [...items.values()].sort((a, b) => a.title.localeCompare(b.title)), existing };
}

function writeInstrFile(file, slug, title, content) {
  const { text, crlf, bom } = readInstrFile(file);
  let next = text.replace(INSTR_BLOCK_RE, (m, s) => (s === slug ? '' : m));
  if (content != null) {
    const block = `<!-- agent-hub:begin ${slug} | ${title} -->\n${content.replace(/\s+$/, '')}\n<!-- agent-hub:end ${slug} -->\n`;
    next = next.replace(/\s*$/, '');
    next = (next ? `${next}\n\n` : '') + block;
  } else {
    next = next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
    if (!next.trim()) next = '';
  }
  if (next === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  // mantém CRLF e BOM do arquivo original
  writeReal(file, (bom ? '\ufeff' : '') + (crlf ? next.replace(/\n/g, '\r\n') : next));
  return true;
}

function saveInstruction(body) {
  const title = String(body.title || '').trim();
  const content = String(body.content || '').replace(/\r\n/g, '\n');
  if (!title || title.length > 80 || /[\n|]|-->/.test(title)) throw new Error('dê um nome curto à instrução (até 80 caracteres, sem "|")');
  if (!content.trim()) throw new Error('cole o texto da instrução');
  if (content.length > 50000) throw new Error('instrução grande demais (máx. 50 mil caracteres)');
  if (/<!-- agent-hub:(begin|end)/.test(content)) throw new Error('o texto não pode conter marcadores do agent-hub');
  const slug = body.slug ? String(body.slug) : slugify(title);
  if (!/^[a-z0-9-]{1,48}$/.test(slug)) throw new Error('nome inválido');
  const targets = instrTargets();
  const want = new Set(asList(body.targets).map(String));
  if (!targets.some((t) => want.has(t.id))) throw new Error('escolha pelo menos uma LLM');
  if (!body.slug && instructionsState().items.some((i) => i.slug === slug)) throw new Error(`já existe uma instrução "${title}". Edite a existente ou use outro nome`);
  const mode = ['file', 'skill', 'both'].includes(body.mode) ? body.mode : 'skill';
  const changed = [];
  for (const t of targets.filter((x) => want.has(x.id) && mode !== 'skill' && INSTR_LIMIT[x.tool])) {
    const others = readInstrFile(t.file).text.replace(INSTR_BLOCK_RE, (m, s2) => (s2 === slug ? '' : m));
    if (Buffer.byteLength(others) + Buffer.byteLength(content) + 120 > INSTR_LIMIT[t.tool]) throw new Error(`o Antigravity só lê até 24 KB por arquivo (${t.display}). Encurte a instrução ou tire esse destino`);
  }
  for (const t of targets) {
    const has = readInstrFile(t.file).blocks.some((b) => b.slug === slug);
    const wantFile = want.has(t.id) && mode !== 'skill';
    if (wantFile) { if (writeInstrFile(t.file, slug, title, content)) changed.push(t.display); }
    else if (has && writeInstrFile(t.file, slug, title, null)) changed.push(`${t.display} (removida)`);
    const sd = instrSkillsDir(t);
    if (!sd) continue;
    const wantSkill = want.has(t.id) && mode !== 'file';
    if (wantSkill) { if (writeInstrSkill(sd, slug, title, content)) changed.push(`${homeRel(path.join(sd, slug))} (comando /${slug})`); }
    else if (removeInstrSkill(sd, slug)) changed.push(`${homeRel(path.join(sd, slug))} (comando removido)`);
  }
  return { slug, title, mode, changed };
}

function removeInstruction(body) {
  const slug = String(body.slug || '');
  if (!/^[a-z0-9-]{1,48}$/.test(slug)) throw new Error('instrução inválida');
  const changed = [];
  for (const t of instrTargets()) {
    if (writeInstrFile(t.file, slug, '', null)) changed.push(t.display);
    const sd = instrSkillsDir(t);
    if (sd && removeInstrSkill(sd, slug)) changed.push(`${homeRel(path.join(sd, slug))} (comando)`);
  }
  if (!changed.length) throw new Error('instrução não encontrada');
  return { slug, changed };
}

// Sem fixar, o Claude Code no Bedrock usa padrões antigos (ex.: sonnet → Sonnet 4.5);
// os IDs ficam em <CLAUDE_CONFIG_DIR>/settings.json → env (code.claude.com/docs/en/amazon-bedrock).
const BEDROCK_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const BEDROCK_KEY = (f) => `ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`;
const BEDROCK_ID_RE = /^(?:(global|us|eu|apac|jp|au|us-gov)\.)?anthropic\.claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=-\d{8}|-v\d|$)/;
// Prefixo de região que o próprio Claude Code usa (us-*→us, eu-*→eu, ap-*→apac, resto→global).
const bedrockPrefix = (region, env) => env.ANTHROPIC_BEDROCK_REGION_PREFIX
  || (/^us-gov-/.test(region) ? 'us-gov' : /^us-/.test(region) ? 'us' : /^eu-/.test(region) ? 'eu' : /^ap-/.test(region) ? 'apac' : 'global');
const parseBedrockId = (id) => {
  const m = String(id || '').match(BEDROCK_ID_RE);
  return m ? { prefix: m[1] || '', family: m[2], major: Number(m[3]), minor: Number(m[4] || 0) } : null;
};
const newer = (a, b) => a.major !== b.major ? a.major > b.major : a.minor > b.minor;
const bedrockLabel = (p) => `${p.family[0].toUpperCase()}${p.family.slice(1)} ${p.major}${p.minor ? `.${p.minor}` : ''}`;

function bedrockAccount(name) {
  const a = readAccounts().find((x) => x.name === name);
  if (!a || a.type !== 'bedrock') throw new Error('conta Bedrock não encontrada');
  const aws = awsEnvOf(a);
  const profile = aws.AWS_PROFILE || 'default';
  const region = aws.AWS_REGION || aws.AWS_DEFAULT_REGION || iniSections(AWS_CONFIG, true)[profile]?.region || 'us-east-1';
  const dir = a.env.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
  return { a, profile, region, file: path.join(dir, 'settings.json') };
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${homeRel(file)} não é um JSON válido. Corrija o arquivo antes (o hub não sobrescreve)`); }
}

// Configuração gerenciada pela organização: tem prioridade sobre o settings.json do usuário e o hub não a altera.
// code.claude.com/docs/en/settings → caminhos por sistema operacional.
const MANAGED_SETTINGS = IS_WIN ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')
  : IS_MAC ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
const managedEnv = () => { const e = readJson(MANAGED_SETTINGS)?.env; return isObj(e) ? e : {}; };

async function bedrockCheck(name) {
  const { a, profile, region, file } = bedrockAccount(name);
  if (!(await which('aws'))) throw new Error('AWS CLI não instalado');
  const env = awsEnvOf(a);
  // variáveis do Claude que valem para a conta: env do hub > settings.json > shell
  const effective = { ...process.env, ...claudeSettingsEnv(a), ...a.env };
  const aws = (args) => run('aws', [...args, '--region', region, '--profile', profile, '--output', 'json'], 30000, env);
  const [prof, fm] = await Promise.all([
    aws(['bedrock', 'list-inference-profiles', '--type-equals', 'SYSTEM_DEFINED']),
    aws(['bedrock', 'list-foundation-models', '--by-provider', 'anthropic']),
  ]);
  if (!prof.ok) {
    const why = prof.stderr.split('\n').filter(Boolean).pop() || 'falhou';
    throw new Error(/AccessDenied|not authorized/i.test(why)
      ? `o perfil "${profile}" não tem permissão bedrock:ListInferenceProfiles em ${region}`
      : /expired|ExpiredToken|sso/i.test(why) ? `as credenciais do perfil "${profile}" venceram. Renove (aws sso login ou Atualizar chaves)` : why);
  }
  const legacy = new Set();
  try { for (const m of JSON.parse(fm.stdout).modelSummaries || []) if (m.modelLifecycle?.status === 'LEGACY') legacy.add(m.modelId); } catch {}
  const want = bedrockPrefix(region, effective);
  // perfis ativos por família, já sem os LEGACY
  const avail = {};
  for (const p of JSON.parse(prof.stdout).inferenceProfileSummaries || []) {
    if (p.status && p.status !== 'ACTIVE') continue;
    const id = p.inferenceProfileId, parsed = parseBedrockId(id);
    if (!parsed || parsed.major < 4) continue;
    if (legacy.has(id.replace(/^[a-z-]+\.(?=anthropic\.)/, ''))) continue;
    (avail[parsed.family] = avail[parsed.family] || []).push({ id, p: parsed });
  }
  const settings = readSettings(file);
  const pinned = isObj(settings.env) ? settings.env : {};
  const managed = managedEnv();
  // O que vale hoje para o Claude Code: gerenciado pela organização > settings.json da conta > shell.
  const currentOf = (key) => (managed[key] != null ? [String(managed[key]), 'managed'] : pinned[key] != null ? [String(pinned[key]), 'settings'] : process.env[key] ? [process.env[key], 'shell'] : ['', '']);
  // Versão mais nova da família; entre os perfis dessa versão, mantém o prefixo que a pessoa já usa (global., us., eu.…),
  // senão o da região, senão global. Trocar global por regional muda roteamento e cota: só se não houver escolha.
  const pick = (family, currentPrefix) => {
    const list = avail[family] || [];
    if (!list.length) return null;
    let top = list[0];
    for (const c of list) if (newer(c.p, top.p)) top = c;
    const same = list.filter((c) => !newer(top.p, c.p) && !newer(c.p, top.p));
    const rank = (c) => (currentPrefix && c.p.prefix === currentPrefix ? 3 : c.p.prefix === want ? 2 : c.p.prefix === 'global' ? 1 : 0);
    return same.sort((x, y) => rank(y) - rank(x))[0];
  };
  const best = {};
  const rows = BEDROCK_FAMILIES.map((f) => {
    const [current, source] = currentOf(BEDROCK_KEY(f));
    const cp = parseBedrockId(current);
    const latest = pick(f, cp ? cp.prefix : '');
    best[f] = latest;
    const status = !latest ? 'missing' : source === 'managed' ? 'managed' : !current ? 'new' : current === latest.id ? 'ok'
      : cp && newer(cp, latest.p) ? 'ahead' : current.startsWith('arn:') ? 'custom' : 'update';
    return { family: f, key: BEDROCK_KEY(f), current, currentLabel: cp ? bedrockLabel(cp) : '', source, latest: latest?.id || '', latestLabel: latest ? bedrockLabel(latest.p) : '', status };
  });
  const mainId = a.env.ANTHROPIC_MODEL || '';
  const mp = parseBedrockId(mainId);
  const main = mp && best[mp.family] && newer(best[mp.family].p, mp)
    ? { current: mainId, currentLabel: bedrockLabel(mp), latest: best[mp.family].id, latestLabel: bedrockLabel(best[mp.family].p) } : null;
  return {
    name, profile, region, prefix: want, file: homeRel(file), managedFile: rows.some((r) => r.source === 'managed') ? MANAGED_SETTINGS : '',
    rows, main, changes: rows.filter((r) => r.status === 'new' || r.status === 'update').length + (main ? 1 : 0),
  };
}

async function bedrockApply(name, { includeMain = true } = {}) {
  const check = await bedrockCheck(name);
  const { file } = bedrockAccount(name);
  const settings = readSettings(file);
  const changed = [];
  settings.env = isObj(settings.env) ? settings.env : {};
  for (const r of check.rows.filter((x) => x.status === 'new' || x.status === 'update')) {
    settings.env[r.key] = r.latest;
    changed.push(`${r.key}: ${r.current || '(vazio)'} → ${r.latest}`);
  }
  if (changed.length) {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    writeReal(file, JSON.stringify(settings, null, 2) + '\n');
  }
  if (includeMain && check.main) {
    const all = readAccounts();
    const acc = all.find((x) => x.name === name);
    acc.env.ANTHROPIC_MODEL = check.main.latest;
    writeAccounts(all);
    changed.push(`ANTHROPIC_MODEL (hub): ${check.main.current} → ${check.main.latest}`);
  }
  return { ...(await bedrockCheck(name)), applied: changed };
}

// ---- Modelos de cada ferramenta: o que está fixado na configuração local x o mais recente na fonte oficial ----
// Claude (assinatura/API): página de modelos da Anthropic. Claude via Bedrock: a própria conta AWS (bedrockCheck).
// Codex: models.json do repositório openai/codex. Gemini CLI: models.ts do repositório google-gemini/gemini-cli.
// Copilot CLI: tabela de modelos do repositório github/docs (só aviso: o hub não grava o settings.json do Copilot).
const MODEL_SOURCES = {
  claude: { url: 'https://platform.claude.com/docs/en/about-claude/models/overview.md', label: 'documentação oficial da Anthropic' },
  codex: { url: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json', label: 'repositório oficial openai/codex' },
  gemini: { url: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/models.ts', label: 'repositório oficial google-gemini/gemini-cli' },
  copilot: { url: 'https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/model-supported-clients.yml', label: 'documentação oficial do GitHub (github/docs)' },
};
const officialCache = new Map();
async function fetchOfficial(tool) {
  const src = MODEL_SOURCES[tool];
  const hit = officialCache.get(tool);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.text;
  let text = '';
  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'agent-hub' } });
    if (res.ok) text = await res.text();
  } catch {}
  // redes com proxy ou certificado próprio: o curl do sistema costuma já estar configurado
  if (!text && (await which('curl'))) { const r = await run('curl', ['-fsSL', '--max-time', '20', src.url], 25000); if (r.ok) text = r.stdout; }
  if (!text) throw new Error(`não consegui consultar a ${src.label} (sem rede?)`);
  officialCache.set(tool, { at: Date.now(), text });
  return text;
}
const modelNewer = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : (a[1] || 0) > (b[1] || 0));
const saveWithBak = (file, text) => { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); writeReal(file, text); };
const modelRow = (key, label, current, latest, status, note = '') => ({ key, label, current, latest, status, note });

// Claude de assinatura ou chave de API: apelidos (opus, sonnet, fable…) acompanham o cliente; só ID completo fica velho.
const CLAUDE_ID_RE = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?(\[[^\]]*\])?$/;
async function claudeModels(a) {
  const dir = a.env.CLAUDE_CONFIG_DIR ? expandHome(a.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
  const file = path.join(dir, 'settings.json');
  const settings = readSettings(file);
  const env = isObj(settings.env) ? settings.env : {};
  const managed = readJson(MANAGED_SETTINGS) || {};
  const menv = isObj(managed.env) ? managed.env : {};
  const slots = [['model', 'Modelo padrão', settings.model, managed.model, 'top'],
    ['ANTHROPIC_MODEL', 'ANTHROPIC_MODEL', env.ANTHROPIC_MODEL, menv.ANTHROPIC_MODEL, 'env'],
    ...BEDROCK_FAMILIES.map((f) => [BEDROCK_KEY(f), `Apelido ${f}`, env[BEDROCK_KEY(f)], menv[BEDROCK_KEY(f)], 'env'])];
  const pinned = slots.filter(([, , v, m]) => CLAUDE_ID_RE.test(String(m != null ? m : v || '')));
  let latest = {};
  if (pinned.length) {
    const text = await fetchOfficial('claude');
    for (const m of text.matchAll(/\bclaude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/g)) {
      const v = [Number(m[2]), Number(m[3] || 0)];
      if (!latest[m[1]] || modelNewer(v, latest[m[1]].v)) latest[m[1]] = { id: m[0], v };
    }
  }
  const rows = [];
  for (const [key, label, value, man, where] of slots) {
    const cur = String(man != null ? man : value || '');
    if (!cur) { if (key === 'model') rows.push(modelRow(key, label, '', '', 'auto', 'padrão do Claude Code: acompanha a versão do cliente')); continue; }
    const m = cur.match(CLAUDE_ID_RE);
    if (!m) { rows.push(modelRow(key, label, cur, '', 'auto', /^claude-/.test(cur) ? 'ID fora do padrão atual: o hub não altera' : `apelido "${cur}": acompanha o modelo mais recente da família`)); continue; }
    const best = latest[m[1]];
    const v = [Number(m[2]), Number(m[3] || 0)];
    const next = best && modelNewer(best.v, v) ? best.id + (m[5] || '') : '';
    const row = modelRow(key, label, cur, next || cur, man != null ? 'managed' : next ? 'update' : 'ok', man != null ? `fixado pela organização em ${MANAGED_SETTINGS}` : '');
    row.where = where;
    rows.push(row);
  }
  return { tool: 'claude', file, source: MODEL_SOURCES.claude.label, rows, apply: (todo) => {
    const s = readSettings(file);
    s.env = isObj(s.env) ? s.env : {};
    for (const r of todo) { if (r.where === 'top') s.model = r.latest; else s.env[r.key] = r.latest; }
    if (!Object.keys(s.env).length) delete s.env;
    saveWithBak(file, JSON.stringify(s, null, 2) + '\n');
  } };
}

// Codex: a linha model = "…" do topo do config.toml. O models.json oficial diz para qual modelo cada um migra.
async function codexModels(a) {
  const file = path.join(a.env.CODEX_HOME ? expandHome(a.env.CODEX_HOME) : path.join(HOME, '.codex'), 'config.toml');
  const text = safeRead(file) || '';
  const lines = text.split('\n');
  let at = -1, cur = '';
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break; // só o topo: perfis ([profiles.x]) são escolha de quem os criou
    const m = lines[i].match(/^\s*model\s*=\s*(["'])([^"']+)\1/);
    if (m) { at = i; cur = m[2]; break; }
  }
  if (!cur) return { tool: 'codex', file, source: MODEL_SOURCES.codex.label, rows: [modelRow('model', 'Modelo padrão', '', '', 'auto', 'sem modelo fixado: o Codex usa o padrão da versão instalada')], apply: () => {} };
  let list = [];
  try { list = JSON.parse(await fetchOfficial('codex')).models || []; } catch (e) { if (/não consegui/.test(e.message)) throw e; throw new Error('a lista oficial de modelos do Codex veio em formato inesperado'); }
  const by = new Map(list.map((m) => [m.slug, m]));
  let next = cur, known = by.has(cur);
  for (let i = 0; i < 6 && by.get(next)?.upgrade?.model && by.get(next).upgrade.model !== next; i++) next = by.get(next).upgrade.model;
  const row = !known ? modelRow('model', 'Modelo padrão', cur, '', 'unknown', 'não está na lista oficial do Codex: o hub não altera')
    : modelRow('model', 'Modelo padrão', cur, next, next !== cur ? 'update' : 'ok', next !== cur ? `a OpenAI indica ${by.get(next)?.display_name || next} como sucessor` : '');
  return { tool: 'codex', file, source: MODEL_SOURCES.codex.label, rows: [row], apply: (todo) => {
    if (!todo.length || at < 0) return;
    const fresh = (safeRead(file) || '').split('\n');
    if (!new RegExp(`^\\s*model\\s*=\\s*(["'])${cur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`).test(fresh[at] || '')) throw new Error('o config.toml do Codex mudou durante a atualização: tente de novo');
    fresh[at] = fresh[at].replace(cur, todo[0].latest);
    saveWithBak(file, fresh.join('\n'));
  } };
}

// Gemini CLI: model.name no settings.json. Apelidos (auto, pro, flash…) acompanham o cliente.
const GEMINI_ID_RE = /^gemini-(\d+)(?:\.(\d+))?-(pro|flash-lite|flash)(-.+)?$/;
async function geminiModels(a) {
  const file = path.join(geminiDir(a), 'settings.json');
  const raw = safeRead(file);
  let settings = null;
  if (raw != null) { try { settings = JSON.parse(raw); } catch {} }
  const src = MODEL_SOURCES.gemini.label;
  if (raw != null && !settings) return { tool: 'gemini', file, source: src, rows: [modelRow('model.name', 'Modelo padrão', '', '', 'unknown', 'o settings.json tem comentários ou erro de sintaxe: o hub não altera')], apply: () => {} };
  const cur = String((isObj(settings?.model) ? settings.model.name : typeof settings?.model === 'string' ? settings.model : '') || '');
  if (!cur) return { tool: 'gemini', file, source: src, rows: [modelRow('model.name', 'Modelo padrão', '', '', 'auto', 'sem modelo fixado: o Gemini CLI escolhe sozinho (auto)')], apply: () => {} };
  const m = cur.match(GEMINI_ID_RE);
  if (!m) return { tool: 'gemini', file, source: src, rows: [modelRow('model.name', 'Modelo padrão', cur, '', 'auto', /^gemini-/.test(cur) ? 'ID fora do padrão: o hub não altera' : `apelido "${cur}": acompanha o modelo mais recente`)], apply: () => {} };
  const text = await fetchOfficial('gemini');
  let best = null;
  for (const q of text.matchAll(/'(gemini-[0-9][a-z0-9.-]*)'/g)) {
    const g = q[1].match(GEMINI_ID_RE);
    if (!g || g[4] || g[3] !== m[3]) continue; // só versões estáveis da mesma linha (pro, flash, flash-lite)
    const v = [Number(g[1]), Number(g[2] || 0)];
    if (!best || modelNewer(v, best.v)) best = { id: q[1], v };
  }
  const v = [Number(m[1]), Number(m[2] || 0)];
  const next = best && modelNewer(best.v, v) ? best.id : '';
  const row = modelRow('model.name', 'Modelo padrão', cur, next || cur, next ? 'update' : best && modelNewer(v, best.v) ? 'ahead' : 'ok', next ? '' : m[4] ? 'versão de prévia: mantida' : '');
  return { tool: 'gemini', file, source: src, rows: [row], apply: (todo) => {
    if (!todo.length) return;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObj(s.model)) s.model.name = todo[0].latest; else s.model = { name: todo[0].latest };
    saveWithBak(file, JSON.stringify(s, null, 2) + '\n');
  } };
}

// Copilot CLI: o settings.json aceita comentários e os IDs não são publicados em formato de máquina,
// então o hub só avisa quando há versão mais nova da mesma linha; a troca é pelo /model do próprio Copilot.
async function copilotModels(a) {
  const file = path.join(a.env.COPILOT_HOME ? expandHome(a.env.COPILOT_HOME) : path.join(HOME, '.copilot'), 'settings.json');
  const raw = safeRead(file) || '';
  const src = MODEL_SOURCES.copilot.label;
  const cur = (raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
  if (!cur) return { tool: 'copilot', file, source: src, rows: [modelRow('model', 'Modelo padrão', '', '', 'auto', 'sem modelo fixado: o Copilot usa o padrão do seu plano')], apply: () => {} };
  const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/\s+/g, '-');
  const shape = (s) => { const m = s.match(/^(.*?)(\d+(?:\.\d+)?)(.*)$/); return m ? { line: `${m[1]}#${m[3]}`, v: m[2].split('.').map(Number) } : null; };
  const names = [];
  let name = '';
  for (const l of (await fetchOfficial('copilot')).split('\n')) {
    const n = l.match(/^- name:\s*['"]?(.+?)['"]?\s*$/);
    if (n) { name = n[1]; continue; }
    if (name && /^\s+cli:\s*true\b/.test(l)) { names.push(name); name = ''; }
  }
  const mine = shape(slug(cur));
  let best = null;
  for (const n of names) {
    if (/preview/i.test(n)) continue;
    const s = shape(slug(n));
    if (mine && s && s.line === mine.line && modelNewer(s.v, mine.v) && (!best || modelNewer(s.v, best.v))) best = { name: n, v: s.v };
  }
  const row = best ? modelRow('model', 'Modelo padrão', cur, best.name, 'advice', `há versão mais nova: ${best.name}. Troque com /model dentro do Copilot`)
    : modelRow('model', 'Modelo padrão', cur, cur, mine ? 'ok' : 'unknown', mine ? '' : 'não reconhecido na lista oficial');
  return { tool: 'copilot', file, source: src, rows: [row], apply: () => {} };
}

const MODEL_CHECKERS = { claude: claudeModels, codex: codexModels, gemini: geminiModels, copilot: copilotModels };
async function modelsProbe(name) {
  const a = readAccounts().find((x) => x.name === name);
  if (!a) throw new Error('conta não encontrada');
  if (a.type === 'bedrock') return { a, bedrock: true };
  const fn = MODEL_CHECKERS[a.type];
  if (!fn) return { a, none: true };
  return { a, r: await fn(a) };
}
// Situação dos modelos de uma conta, no mesmo formato para todas as ferramentas.
async function modelsCheck(name) {
  const p = await modelsProbe(name);
  if (p.none) return { name, tool: p.a.type, file: '', source: '', rows: [], changes: 0, note: 'esta ferramenta escolhe o modelo dentro dela: não há o que fixar' };
  if (p.bedrock) {
    const b = await bedrockCheck(name);
    const rows = b.rows.map((x) => modelRow(x.key, x.family, x.current, x.latest, x.status, x.status === 'managed' ? `fixado pela organização em ${b.managedFile}` : ''));
    if (b.main) rows.push(modelRow('ANTHROPIC_MODEL', 'principal (config do hub)', b.main.current, b.main.latest, 'update'));
    return { name, tool: 'bedrock', file: b.file, source: `sua conta AWS (Bedrock em ${b.region})`, rows, changes: b.changes };
  }
  const { r } = p;
  return { name, tool: r.tool, file: homeRel(r.file), source: r.source, rows: r.rows, changes: r.rows.filter((x) => x.status === 'update').length };
}
// Fixa os modelos mais recentes na configuração local da conta. Só mexe nas chaves de modelo; guarda uma cópia .bak.
async function modelsApply(name) {
  const p = await modelsProbe(name);
  if (p.none) return { ...(await modelsCheck(name)), applied: [] };
  if (p.bedrock) { const b = await bedrockApply(name); return { ...(await modelsCheck(name)), applied: b.applied }; }
  const todo = p.r.rows.filter((x) => x.status === 'update');
  if (todo.length) p.r.apply(todo);
  return { ...(await modelsCheck(name)), applied: todo.map((x) => `${x.label}: ${x.current} → ${x.latest}`) };
}

const RESERVED_NAMES = ['ui', 'install', 'update', 'skills', 'skill', 'list', 'check', 'doctor', 'config', 'help'];
function nextFreeName(base, taken) {
  if (!taken.has(base) && !RESERVED_NAMES.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
async function detectAccounts() {
  const accounts = readAccounts();
  const used = new Set(accounts.map((a) => {
    const key = { claude: 'CLAUDE_CONFIG_DIR', bedrock: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', copilot: 'COPILOT_HOME', gemini: 'GEMINI_CLI_HOME' }[a.type];
    const def = { claude: '.claude', bedrock: '.claude', codex: '.codex', copilot: '.copilot', gemini: '.gemini', antigravity: path.join('.gemini', 'antigravity-cli') }[a.type];
    return def ? path.resolve(key && a.env[key] ? expandHome(a.env[key]) : path.join(HOME, def)) : '';
  }));
  const taken = new Set(accounts.map((a) => a.name));
  const found = [];
  const add = (type, dir, envKey, isDefault) => {
    if (used.has(path.resolve(dir))) return;
    const base = { claude: 'claude', codex: 'codex', gemini: 'gemini', copilot: 'copilot', antigravity: 'agy' }[type];
    const stem = path.basename(dir).replace(/^\./, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || base;
    const name = isDefault ? nextFreeName(base, taken) : nextFreeName(stem, taken);
    taken.add(name);
    const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', antigravity: 'Antigravity' }[type] + (name === base ? '' : ` ${name.replace(`${base}-`, '')}`);
    found.push({ type, name, label, command: base === 'agy' ? 'agy' : type, args: '', install: '', env: isDefault || !envKey ? {} : { [envKey]: dir.replace(HOME, '~') }, dir: dir.replace(HOME, '~') });
  };
  const entries = fs.readdirSync(HOME, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  // Bedrock não guarda credenciais na pasta do Claude
  for (const d of entries.filter((e) => e === '.claude' || e.startsWith('.claude-'))) {
    // no macOS o login fica no Keychain: a pasta usada já indica a conta
    if (!['.credentials.json', 'history.jsonl', 'projects', 'settings.json'].some((f) => fs.existsSync(path.join(HOME, d, f)))) continue;
    const probe = { command: 'claude', env: d === '.claude' ? {} : { CLAUDE_CONFIG_DIR: path.join(HOME, d) } };
    const from = bedrockSource(probe);
    const before = found.length;
    add('claude', path.join(HOME, d), 'CLAUDE_CONFIG_DIR', d === '.claude');
    if (!from || found.length === before) continue; // pasta já cadastrada, ou Claude de assinatura
    const f = found[found.length - 1];
    const aws = awsEnvOf(probe);
    f.type = 'bedrock';
    f.label = f.label.replace(/^Claude/, 'Claude via AWS');
    f.env = { ...f.env, CLAUDE_CODE_USE_BEDROCK: '1', ...(aws.AWS_PROFILE ? { AWS_PROFILE: aws.AWS_PROFILE } : {}), ...(aws.AWS_REGION ? { AWS_REGION: aws.AWS_REGION } : {}) };
    f.bedrockFrom = from;
  }
  for (const d of entries.filter((e) => e === '.codex' || e.startsWith('.codex-'))) {
    if (fs.existsSync(path.join(HOME, d, 'auth.json'))) add('codex', path.join(HOME, d), 'CODEX_HOME', d === '.codex');
  }
  if (fs.existsSync(path.join(HOME, '.gemini', 'oauth_creds.json'))) add('gemini', path.join(HOME, '.gemini'), 'GEMINI_CLI_HOME', true);
  for (const d of entries.filter((e) => e.startsWith('.gemini-'))) {
    if (fs.existsSync(path.join(HOME, d, '.gemini', 'oauth_creds.json'))) add('gemini', path.join(HOME, d), 'GEMINI_CLI_HOME', false);
  }
  for (const d of entries.filter((e) => e === '.copilot' || e.startsWith('.copilot-'))) add('copilot', path.join(HOME, d), 'COPILOT_HOME', d === '.copilot');
  if (fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli'))) add('antigravity', path.join(HOME, '.gemini', 'antigravity-cli'), '', true);
  for (const f of found) f.login = await loginStatus({ ...f, env: Object.fromEntries(Object.entries(f.env).map(([k, v]) => [k, v])) }, true);
  return found;
}

// Variáveis com cara de segredo vão mascaradas para a página; ao salvar, a máscara volta a ser o valor do config.
const SECRET_ENV = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|CREDENTIALS?)$/;
const maskEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_ENV.test(k) ? mask(v, 0, 4) : v]));
function unmaskEnv(list) {
  if (!Array.isArray(list)) return list;
  const prev = readAccounts();
  return list.map((a) => {
    if (!a || typeof a.env !== 'object' || !a.env) return a;
    const env = { ...a.env };
    for (const [k, v] of Object.entries(env)) {
      if (!SECRET_ENV.test(k) || !String(v).includes('*')) continue;
      const own = prev.find((p) => p.name === a.name && p.env[k] != null && mask(p.env[k], 0, 4) === v);
      const hits = own ? [own] : prev.filter((p) => p.env[k] != null && mask(p.env[k], 0, 4) === v);
      if (hits.length === 1) env[k] = hits[0].env[k];
      else throw new Error(`${a.name}: digite de novo o valor de ${k}`);
    }
    return { ...a, env };
  });
}

async function state() {
  const accounts = readAccounts();
  const infos = await installInfos(accounts);
  const inst = { aws: await which('aws') };
  for (const [c, info] of Object.entries(infos)) inst[c] = Boolean(info);
  await Promise.all(accounts.map(async (a) => {
    const how = await resolveInstall(a, infos[a.command] || null);
    a.installCmd = how.cmd;
    a.installMethod = inst[a.command] ? how.label : '';
    a.installPath = how.path ? homeRel(how.path) : '';
    a.installNote = how.note;
    a.installNeedsSudo = how.needsSudo;
    a.login = inst[a.command] ? await loginStatus(a) : null;
  }));
  return {
    apiVersion: API_VERSION,
    system: systemInfo(),
    repo: repoInfo(),
    configPath: CONFIG.replace(HOME, '~'),
    accounts: accounts.map((a) => ({ ...a, env: maskEnv(a.env) })),
    awsProfiles: awsProfiles(),
    skillTargets: skillTargets(),
    agentModels: syncedState(SYNCED.models),
    instructions: instructionsState(),
    skillCatalog: catalogState(),
    installed: inst,
    versions: await versions(inst),
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('requisição grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('aborted', () => reject(new Error('requisição interrompida')));
    req.on('end', () => {
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
  });
}

function tokenOk(req) {
  const got = Buffer.from(String(req.headers['x-hub-token'] || ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let connected = false;
const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  // Bloqueia DNS rebinding: só aceita o host local exato.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'host' });
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return send(res, 403, { error: 'origem' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(INDEX, 'utf8');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    const csp = `default-src 'none'; script-src ${hashes.join(' ')}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
  }
  // O navegador é aberto com um código de uso único: a linha de comando do xdg-open/open fica visível a outros usuários da máquina.
  if (req.method === 'POST' && url.pathname === '/api/session') {
    let body = {};
    try { body = await readBody(req); } catch {}
    const code = String(body.code || '');
    if (!openCodes.has(code)) return send(res, 401, { error: 'link expirado. Abra de novo com /ui no terminal' });
    openCodes.delete(code);
    return send(res, 200, { token: TOKEN });
  }
  const icons = {
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    '/favicon.png': ['favicon.png', 'image/png'],
    '/favicon.ico': ['favicon.png', 'image/png'],
    '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  };
  if (req.method === 'GET' && icons[url.pathname]) {
    const [file, type] = icons[url.pathname];
    return send(res, 200, fs.readFileSync(path.join(__dirname, file)), type);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'não encontrado' });
  if (!tokenOk(req)) return send(res, 401, { error: 'token inválido. Abra a URL exibida no terminal' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/detect') {
      return send(res, 200, { found: await detectAccounts() });
    }
    if (req.method === 'POST' && url.pathname === '/api/login/refresh') {
      loginCache.clear();
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/sync/refresh') {
      await refreshAll(true);
      return send(res, 200, await state());
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      refreshAll();
      if (TTY && !connected) { connected = true; event('ok', 'navegador conectado'); }
      return send(res, 200, await state());
    }
    if (req.method === 'PUT' && url.pathname === '/api/accounts') {
      const body = await readBody(req);
      const accounts = validateAccounts(unmaskEnv(body.accounts));
      writeAccounts(accounts);
      loginCache.clear();
      if (TTY) event('ok', `contas salvas ${C.gray(`(${accounts.length}) em ${CONFIG.replace(HOME, '~')}`)}`);
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/aws/profiles') {
      const body = await readBody(req);
      await saveAwsProfile(body);
      if (TTY) event('ok', `perfil AWS ${C.bold(String(body.name))} salvo ${C.gray('em ~/.aws')}`);
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/aws/profiles/remove') {
      const body = await readBody(req);
      const r = removeAwsProfile(body);
      if (TTY) event('ok', `perfil AWS ${C.bold(r.name)} removido ${C.gray(`(${r.files.join(', ')}${r.accounts.length ? ` · contas: ${r.accounts.join(', ')}` : ''})`)}`);
      return send(res, 200, { ...(await state()), lastAwsRemove: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/bedrock/models') {
      const body = await readBody(req);
      return send(res, 200, await bedrockCheck(String(body.name || '')));
    }
    if (req.method === 'POST' && url.pathname === '/api/bedrock/models/apply') {
      const body = await readBody(req);
      const r = await bedrockApply(String(body.name || ''), { includeMain: body.includeMain !== false });
      if (TTY) event('ok', `modelos do Bedrock de ${C.bold(r.name)}: ${r.applied.length ? `${r.applied.length} atualizado(s)` : 'já estavam em dia'}`);
      return send(res, 200, { ...(await state()), lastBedrock: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/instructions/save') {
      const body = await readBody(req);
      const r = saveInstruction(body);
      if (TTY) event('ok', `instrução ${C.bold(r.title)} ${r.changed.length ? `gravada em ${r.changed.length} arquivo(s)` : 'sem mudanças'}`);
      return send(res, 200, { ...(await state()), lastInstruction: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/instructions/remove') {
      const body = await readBody(req);
      const r = removeInstruction(body);
      if (TTY) event('ok', `instrução ${C.bold(r.slug)} removida de ${r.changed.length} arquivo(s)`);
      return send(res, 200, { ...(await state()), lastInstruction: r });
    }
    if (req.method === 'GET' && url.pathname === '/api/system') {
      return send(res, 200, await systemDetails());
    }
    if (req.method === 'GET' && url.pathname === '/api/garbage') {
      return send(res, 200, await scanGarbage(readAccounts()));
    }
    if (req.method === 'POST' && url.pathname === '/api/garbage/clean') {
      const body = await readBody(req);
      if (TTY) event('wait', `limpando o lixo de ${C.bold(String(body.tool))}…`);
      const r = await cleanGarbage(body);
      if (TTY) event(r.results.every((x) => x.ok) ? 'ok' : 'bad', `lixo de ${C.bold(r.title)}: ${r.results.filter((x) => x.ok).length} de ${r.results.length} itens apagados`);
      return send(res, 200, { ...r, garbage: await scanGarbage(readAccounts()) });
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      return send(res, 200, { tools: await toolInventory(readAccounts()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/tools/clean') {
      const body = await readBody(req);
      if (TTY) event('wait', `limpando ${C.bold(String(body.tool))}…`);
      const r = await cleanupTool(body);
      if (TTY) event(r.results.every((x) => x.ok) ? 'ok' : 'bad', `limpeza de ${C.bold(r.tool)}: ${r.results.filter((x) => x.ok).length} de ${r.results.length} itens`);
      loginCache.clear();
      return send(res, 200, { ...(await state()), lastClean: r, tools: await toolInventory(readAccounts()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/install') {
      const body = await readBody(req);
      if (TTY) event('wait', `instalando a CLI de ${C.bold(String(body.name))}…`);
      try { await installAccount(String(body.name || '')); } catch (e) { if (TTY) event('bad', e.message.split('\n')[0]); throw e; }
      if (TTY) event('ok', `CLI de ${C.bold(String(body.name))} instalada`);
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/update') {
      const body = await readBody(req);
      if (TTY) event('wait', `atualizando a CLI de ${C.bold(String(body.name))}…`);
      try { await installAccount(String(body.name || ''), 'atualizar'); } catch (e) { if (TTY) event('bad', e.message.split('\n')[0]); throw e; }
      if (TTY) event('ok', `CLI de ${C.bold(String(body.name))} atualizada`);
      // atualizar o cliente não basta: os modelos fixados na configuração local também precisam acompanhar
      let lastModels;
      try { lastModels = await modelsApply(String(body.name || '')); } catch (e) { lastModels = { error: e.message, applied: [], rows: [] }; }
      if (TTY && lastModels.applied.length) event('ok', `modelos de ${C.bold(String(body.name))}: ${lastModels.applied.join(' · ')}`);
      if (TTY && lastModels.error) event('bad', `modelos de ${C.bold(String(body.name))}: ${lastModels.error}`);
      return send(res, 200, { ...(await state()), lastModels });
    }
    if (req.method === 'POST' && url.pathname === '/api/models/apply') {
      // só os modelos fixados da conta, sem reinstalar a CLI (contas que dividem a mesma CLI com outra já atualizada)
      const body = await readBody(req);
      let lastModels;
      try { lastModels = await modelsApply(String(body.name || '')); } catch (e) { lastModels = { error: e.message, applied: [], rows: [] }; }
      if (TTY && lastModels.applied.length) event('ok', `modelos de ${C.bold(String(body.name))}: ${lastModels.applied.join(' · ')}`);
      if (TTY && lastModels.error) event('bad', `modelos de ${C.bold(String(body.name))}: ${lastModels.error}`);
      return send(res, 200, { ...(await state()), lastModels });
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/deps') {
      const body = await readBody(req);
      return send(res, 200, await checkDeps((body.skills || []).map(String), { source: body.source ? String(body.source) : '', installed: Boolean(body.installed) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/deps/install') {
      const body = await readBody(req);
      if (TTY) event('wait', `instalando dependências de ${C.bold((body.skills || []).join(', '))}…`);
      const r = await installDeps((body.skills || []).map(String), Boolean(body.optional), { source: body.source ? String(body.source) : '', installed: Boolean(body.installed) });
      if (TTY) r.log.forEach((l) => event(/falhou/.test(l) ? 'bad' : 'ok', l));
      return send(res, 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/preview') {
      const body = await readBody(req);
      if (TTY) event('wait', `buscando skills em ${C.bold(String(body.source))}…`);
      const src = await fetchSource(body.source, { fresh: true });
      if (TTY) event('ok', `${src.skills.length} skill(s) encontrada(s) em ${C.bold(src.label)}`);
      const folders = (body.skills || []).length ? (body.skills || []).map(String) : src.skills.map((x) => x.folder);
      const licenseOf = (dir) => {
        for (const d of [dir, src.dir]) for (const f of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
          const text = safeRead(path.join(d, f));
          if (text != null) {
            const first = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
            if (/^MIT/i.test(first)) return 'MIT';
            if (/Apache License/i.test(first)) return 'Apache 2.0';
            if (/Mozilla Public License/i.test(first)) return 'MPL 2.0';
            return first.slice(0, 40);
          }
        }
        return '';
      };
      const firstSkill = src.skills.find((x) => folders.includes(x.folder));
      return send(res, 200, { source: src.label, commit: src.commit, date: src.date, checkedAt: new Date().toISOString(),
        license: firstSkill ? licenseOf(firstSkill.dir) : '',
        readme: folders.length ? readmeExcerpt(src, folders) : null,
        skills: src.skills.map(({ name, description, folder, files, license, compatibility }) => ({ name, description, folder, files, license: license || '', compatibility: compatibility || '' })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/install') {
      const body = await readBody(req);
      const r = await installSkills(body);
      if (TTY) event('ok', `skill ${C.bold(r.installed.join(', '))} instalada em ${r.targets.length} agente(s) ${C.gray(`(versão ${r.commit} · ${r.date})`)}`);
      return send(res, 200, { ...(await state()), lastInstall: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/update') {
      const body = await readBody(req);
      if (TTY) event('wait', `procurando atualização de ${C.bold(String(body.skill))}…`);
      const r = await updateSkill(body);
      if (TTY) event('ok', r.updated.length ? `skill ${C.bold(r.skill)} atualizada ${C.gray(`(${r.commit})`)}` : `skill ${C.bold(r.skill)} já está na versão mais recente`);
      return send(res, 200, { ...(await state()), lastUpdate: r });
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/copy') {
      const body = await readBody(req);
      const to = copySkill(body);
      if (TTY) event('ok', `skill ${C.bold(String(body.skill))} copiada para ${to.length} conta(s)`);
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/skills/remove') {
      const body = await readBody(req);
      const n = removeSkill(body);
      if (TTY) event('ok', `skill ${C.bold(String(body.skill))} removida de ${n} agente(s)`);
      return send(res, 200, await state());
    }
    if (req.method === 'POST' && url.pathname === '/api/aws/test') {
      const body = await readBody(req);
      const r = await testAwsProfile(body.name);
      if (TTY) event(r.ok ? 'ok' : 'bad', `teste de conexão ${C.bold(String(body.name))}: ${r.ok ? `ok ${C.gray(`(conta ${r.account})`)}` : 'falhou'}`);
      return send(res, 200, r);
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (t) => (TTY ? `\x1b[${code}m${t}\x1b[0m` : String(t));
const C = {
  blue: c('38;5;39'), teal: c('38;5;44'), green: c('38;5;48'), mint: c('38;5;121'), gray: c('38;5;245'),
  yellow: c('38;5;221'), red: c('38;5;203'), bold: c('1'), white: c('97;1'),
};
const GRAD = [39, 38, 44, 43, 49, 48, 84];
const gradient = (t) => (TTY ? [...t].map((ch, i) => `\x1b[38;5;${GRAD[Math.floor((i * GRAD.length) / t.length)]};1m${ch}`).join('') + '\x1b[0m' : t);
const link = (text, url) => (TTY ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);
const now = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let baseUrl = '', tokenUrl = '';

// Só as cores do próprio hub passam: nomes e erros podem vir de repositórios ou da página.
function event(kind, msg) {
  const mark = { ok: C.green('✓'), bad: C.red('✗'), info: C.teal('•'), wait: C.yellow('…') }[kind] || '•';
  console.log(`  ${C.gray(now())}  ${mark} ${String(msg).replace(/\x1b(?!\[[0-9;]*m)|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, '')}`);
}

const openCodes = new Set();
function openBrowser() {
  if (process.env.HUB_UI_NO_OPEN) return;
  const code = crypto.randomBytes(24).toString('hex');
  openCodes.add(code);
  setTimeout(() => openCodes.delete(code), 5 * 60 * 1000).unref();
  const fullUrl = `${baseUrl}#c=${code}`;
  const [opener, args, opts] = IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', fullUrl], {}]
    : IS_MAC ? ['open', [fullUrl], {}]
    : IS_WSL ? (fs.existsSync('/usr/bin/wslview') ? ['wslview', [fullUrl], {}] : ['cmd.exe', ['/c', 'start', '""', fullUrl.replace(/&/g, '^&')], { cwd: '/mnt/c' }])
    : ['xdg-open', [fullUrl], {}];
  const fail = () => { if (TTY) event('info', `não consegui abrir o navegador. Abra este endereço: ${tokenUrl}`); };
  const child = spawn(opener, args, { stdio: 'ignore', detached: true, windowsHide: true, ...opts });
  child.on('error', fail).on('exit', (code) => { if (code && !IS_WIN) fail(); });
  child.unref();
}

function screen(port) {
  const base = `http://127.0.0.1:${port}/`;
  if (TTY) process.stdout.write('\x1b[H\x1b[2J');
  const face = C.white('◕ ◡ ◕');
  console.log(`
        ${C.mint('●')}
    ${C.teal('╭───┴───╮')}   ${gradient('Agent Hub')} ${C.gray('· interface')}
    ${C.teal('│')} ${face} ${C.teal('│')}   ${C.green('●')} Executando em ${C.bold(link(base, tokenUrl))}
    ${C.teal('╰─┬───┬─╯')}   ${C.gray(`${IS_MAC ? '⌘+clique' : 'Ctrl+clique'} no link abre · botão direito → copiar endereço do link`)}
      ${C.blue('╵   ╵')}

  ${C.bold('o')}  ${C.gray('abrir no navegador de novo')}     ${C.bold('Enter')} ${C.gray('ou')} ${C.bold('q')}  ${C.gray('fechar e voltar ao menu')}
  ${C.gray('# config: ' + CONFIG.replace(HOME, '~'))}

  ${C.gray('ATIVIDADE')}`);
}

function shutdown() {
  if (TTY) process.stdin.setRawMode?.(false);
  for (const entry of [...sourceCache.values(), ...retired]) dropSource(entry);
  console.log(`\n  ${C.teal('(^ ◡ ^)/')} interface fechada ${C.gray('· voltando ao menu')}\n`);
  server.close();
  process.exit(0);
}

function listenKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === 'q' || k === 'Q' || k === '\r' || k === '\n' || k === '\x03' || k === '\x1b') shutdown();
    else if (k === 'o' || k === 'O') { openBrowser(); event('info', 'abrindo o navegador…'); }
  });
}
if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', () => { for (const entry of [...sourceCache.values(), ...retired]) dropSource(entry); server.close(); process.exit(0); });
}

const PORT_TRIES = 20;
function start(port, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
      if (attempt + 1 < PORT_TRIES && port > 0 && port < 65535) return start(port + 1, attempt + 1);
      if (port !== 0) return start(0, PORT_TRIES);
    }
    console.error(`não consegui abrir a interface: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const used = server.address().port;
    baseUrl = `http://127.0.0.1:${used}/`;
    tokenUrl = `${baseUrl}#t=${TOKEN}`;
    if (TTY) {
      screen(used);
      listenKeys();
      if (used !== PORT) event('info', `porta ${PORT} ocupada, usando a ${C.bold(used)}`);
      event('wait', 'aguardando o navegador conectar…');
    } else {
      console.log(`Interface: ${tokenUrl}\nConfig: ${CONFIG}`);
    }
    openBrowser();
  });
}

if (require.main !== module) {
  // usado pelo terminal: mesma lógica, sem abrir o servidor
  module.exports = {
    HOME, CONFIG, IS_WIN, IS_MAC, IS_WSL, systemInfo, systemDetails, repoInfo, TYPES, DEFAULT_INSTALL, SELF_UPDATING, NODE_MIN, installCmd,
    INSTALL_WAYS, METHOD_LABEL, PKG_METHODS, wayCmd, classifyInstall, installInfo, installInfoFrom, installInfos, resolveInstall, npmNeedsSudo, npmPrefix, SYS_PMS, sysPkgOf,
    run, runShell, shellArgs, which, whichAll, python, pyRun, expandHome, homeRel, spawnArgs, winQuote, fullEnv, renameSafe, rmSafe,
    readAccounts, writeAccounts, validateAccounts, parseConfig, inferType, effectiveType, bedrockSource, claudeSettingsEnv, awsEnvOf,
    awsProfiles, iniSections, AWS_CONFIG, AWS_CREDENTIALS,
    loginStatus, codexLogin, geminiLogin, copilotLogin, claudeRelogin, detectAccounts,
    skillTargets, skillMeta, fetchSource, parseSource, installSkills, updateSkill, copySkill, removeSkill, checkDeps, installDeps, readSkillLock,
    inferDeps, depsFor, catalogItemOf, codeLines,
    bedrockCheck, bedrockApply, modelsCheck, modelsApply, MODEL_SOURCES, toolInventory, versions, installed,
    instrTargets, instructionsState, saveInstruction, removeInstruction, scanGarbage, cleanGarbage,
    dropSources: () => { for (const entry of [...sourceCache.values(), ...retired]) dropSource(entry); sourceCache.clear(); retired.clear(); },
  };
} else if (process.argv[2] === 'bedrock-models') {
  (async () => {
    try {
      const r = process.argv.includes('--apply') ? await bedrockApply(process.argv[3]) : await bedrockCheck(process.argv[3]);
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exit(0);
    } catch (e) { process.stdout.write(JSON.stringify({ error: e.message }) + '\n'); process.exit(1); }
  })();
} else {
  refreshAll();
  start(PORT);
}
