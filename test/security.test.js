'use strict';
// Testes das correções de segurança. Rode com: node --test test/
// Tudo acontece numa pasta temporária: HOME, config do hub e TMPDIR apontam para ela antes de carregar o hub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const BOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-')));
const HOME = path.join(BOX, 'home');
const TMP = path.join(BOX, 'tmp');
fs.mkdirSync(HOME);
fs.mkdirSync(TMP);
const REAL_PATH = process.env.PATH;
Object.assign(process.env, { HOME, USERPROFILE: HOME, HUB_CONFIG: path.join(HOME, 'hub-config'), TMPDIR: TMP, TMP, TEMP: TMP, HUB_UI_NO_OPEN: '1', HUB_NO_UPDATE: '1' });
delete process.env.XDG_CONFIG_HOME;
test.after(() => fs.rmSync(BOX, { recursive: true, force: true }));

const POSIX = process.platform !== 'win32';
const freshLib = () => { delete require.cache[require.resolve(SERVER)]; return require(SERVER); };
const lib = freshLib();
const write = (f, text, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mode) fs.chmodSync(f, mode); return f; };
let seq = 0;
const dir = (name) => { const d = path.join(BOX, `${name}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
// programa de mentira no PATH: anota os argumentos num arquivo e sai com o código pedido
function stubBin(name, exit = 0, extra = '') {
  const bin = dir('bin'), mark = path.join(bin, 'calls.txt');
  write(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${mark}"\n${extra}\nexit ${exit}\n`, 0o755);
  return { bin, mark, calls: () => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '') };
}

// ---------- Item 1: npm install automático na pasta da skill ----------
test('npm: só versões, tags e apelidos do registro contam como dependência do registro', () => {
  for (const ok of ['^1.2.3', '~1.2', '1.x', '>=1.0.0 <2.0.0', '^1.0.0 || ^2.0.0', '1.0.0 - 2.0.0', 'next', 'latest', '*', '', 'npm:lodash@^4', 'npm:@scope/pkg@1.x'])
    assert.equal(lib.npmRegistrySpec(ok), true, ok);
  for (const bad of ['git+ssh://git@example.invalid/x/y.git', 'git://x/y', 'https://x/y.tgz', 'file:../x', 'link:../x', 'user/repo', 'github:user/repo', 'workspace:*', '..\\x', 'npm:x@git+ssh://a/b', 7, null, {}])
    assert.equal(lib.npmRegistrySpec(bad), false, String(bad));
});

test('npm: .npmrc, workspaces e dependências de fora do registro bloqueiam o passo automático', () => {
  const mk = (pkg, npmrc) => { const d = dir('skill'); write(path.join(d, 'package.json'), JSON.stringify(pkg)); if (npmrc) write(path.join(d, '.npmrc'), npmrc); return d; };
  assert.equal(lib.npmLocalBlock(mk({ dependencies: { a: '^1.0.0', b: 'npm:c@2' }, peerDependencies: { p: '>=1' }, overrides: { a: { x: '1.2.3' }, y: '$y' } })), '');
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '^1.0.0' } }, 'git=${HOME}/.claude/skills/x/run.sh\n')), /\.npmrc/);
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '^1.0.0', evil: 'git+ssh://git@example.invalid/x/y.git' } })), /fora do registro do npm \(evil\)/);
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '1' }, optionalDependencies: { o: 'file:../o' } })), /\(o\)/);
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '1' }, peerDependencies: { p: 'user/repo' } })), /\(p\)/);
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '1' }, overrides: { a: { deep: 'https://x/y.tgz' } } })), /\(deep\)/);
  assert.match(lib.npmLocalBlock(mk({ dependencies: { a: '1' }, workspaces: ['pkgs/*'] })), /workspaces/);
});

test('npm: skill com .npmrc não chama o npm e sai como aviso; skill limpa instala como antes', { skip: !POSIX }, async () => {
  const npm = stubBin('npm');
  process.env.PATH = `${npm.bin}${path.delimiter}${REAL_PATH}`;
  try {
    const evil = dir('skill');
    write(path.join(evil, 'package.json'), JSON.stringify({ dependencies: { anything: 'git+ssh://git@example.invalid/x/y.git' } }));
    write(path.join(evil, '.npmrc'), `git=${evil}/run.sh\n`);
    write(path.join(evil, 'run.sh'), '#!/bin/sh\nexit 1\n', 0o755);
    const blocked = await lib.npmLocal(evil, 'skill-v');
    assert.equal(blocked.length, 1);
    // os dois consumidores (terminal e interface) marcam a linha como aviso por esta palavra
    assert.match(blocked[0], /falhou/);
    assert.match(blocked[0], /\.npmrc/);
    assert.equal(npm.calls(), '', 'o npm não pode ser chamado numa pasta com .npmrc');

    const git = dir('skill');
    write(path.join(git, 'package.json'), JSON.stringify({ dependencies: { anything: 'git+ssh://git@example.invalid/x/y.git' } }));
    assert.match((await lib.npmLocal(git, 'skill-g'))[0], /falhou.*fora do registro/);
    assert.equal(npm.calls(), '');

    const clean = dir('skill');
    write(path.join(clean, 'package.json'), JSON.stringify({ dependencies: { leftpad: '^1.0.0' } }));
    const done = await lib.npmLocal(clean, 'skill-ok');
    assert.match(done[0], /pacotes Node instalados/);
    assert.doesNotMatch(done[0], /falhou/);
    assert.match(npm.calls(), new RegExp(`install --prefix ${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --omit=dev --ignore-scripts`));
  } finally { process.env.PATH = REAL_PATH; }
});

test('npm: a prévia de dependências mostra o passo como manual quando o hub não vai instalar sozinho', () => {
  const blocked = dir('skill');
  write(path.join(blocked, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  write(path.join(blocked, 'package.json'), JSON.stringify({ dependencies: { a: '^1.0.0' } }));
  write(path.join(blocked, '.npmrc'), 'git=/x\n');
  const b = lib.inferDeps(blocked, 'x').steps.filter((s) => /Pacotes Node dos scripts/.test(s.title));
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'cmd');
  assert.match(b[0].detail, /não instala sozinho.*\.npmrc/);

  const clean = dir('skill');
  write(path.join(clean, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  write(path.join(clean, 'package.json'), JSON.stringify({ dependencies: { a: '^1.0.0' } }));
  const c = lib.inferDeps(clean, 'x').steps.filter((s) => /Pacotes Node dos scripts/.test(s.title));
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'auto');
  assert.match(c[0].detail, /sem scripts de pós-instalação/);
});

// ---------- Item 5: links dentro da skill ----------
test('links: link que sai da skill no destino não é copiado, nem direto nem por cadeia de links', { skip: !POSIX }, () => {
  // clone/x/y/foo é a skill; home/.aws/credentials é o arquivo do usuário que o repositório tenta alcançar
  const base = dir('links');
  const foo = path.join(base, 'clone', 'x', 'y', 'foo');
  const fakeHome = path.join(base, 'home');
  write(path.join(fakeHome, '.aws', 'credentials'), 'DUMMY-MARKER\n');
  write(path.join(foo, 'SKILL.md'), '# skill\n');
  write(path.join(foo, 'credentials'), 'inofensivo\n');
  write(path.join(foo, '.aws', 'credentials'), 'isca\n');
  fs.mkdirSync(path.join(foo, 'sub', 's2'), { recursive: true });
  fs.mkdirSync(path.join(base, 'clone', '.aws'));
  // 1) o caso da auditoria: no clone o link resolve para dentro da skill (por um link plantado acima dela)
  fs.symlinkSync('../x/y/foo/credentials', path.join(base, 'clone', '.aws', 'credentials'));
  fs.symlinkSync('../../../.aws/credentials', path.join(foo, 'creds'));
  // 2) cadeia: o texto parece ficar dentro da skill, mas sub/s2/up é um link e "up/.." sobe de verdade
  fs.symlinkSync('../..', path.join(foo, 'sub', 's2', 'up'));
  fs.symlinkSync('sub/s2/up/../../../.aws/credentials', path.join(foo, 'chain'));
  // 3) absoluto e quebrado
  fs.symlinkSync(path.join(fakeHome, '.aws', 'credentials'), path.join(foo, 'abs'));
  fs.symlinkSync('nao-existe', path.join(foo, 'broken'));
  // 4) legítimos: arquivo e pasta dentro da própria skill
  fs.symlinkSync('../SKILL.md', path.join(foo, 'sub', 'ok'));
  fs.symlinkSync('sub', path.join(foo, 'dirlink'));

  for (const l of ['creds', 'chain', 'abs', 'broken']) assert.equal(lib.linkStaysInside(foo, path.join(foo, l)), false, l);
  for (const l of ['sub/ok', 'dirlink', 'sub/s2/up']) assert.equal(lib.linkStaysInside(foo, path.join(foo, l)), true, l);

  const dest = path.join(fakeHome, '.claude', 'skills', 'foo');
  lib.replaceSkillDir(foo, dest, 'dono/repo\nabc1234 · 2026-01-01\n', true);
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  for (const l of ['creds', 'chain', 'abs', 'broken']) assert.equal(exists(path.join(dest, l)), false, `${l} não pode ser copiado`);
  assert.equal(fs.readlinkSync(path.join(dest, 'sub', 'ok')), '../SKILL.md');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'ok'), 'utf8'), '# skill\n');
  assert.equal(fs.readlinkSync(path.join(dest, 'dirlink')), 'sub');
  assert.equal(fs.readFileSync(path.join(dest, 'credentials'), 'utf8'), 'inofensivo\n');
  // nada dentro da skill instalada alcança o arquivo do usuário
  const leaks = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) { if (!fs.realpathSync(p).startsWith(dest)) leaks.push(p); } else if (e.isDirectory()) walk(p); } };
  walk(dest);
  assert.deepEqual(leaks, []);
});

// ---------- Item 6: hífen no fim do nome de pacote do sistema ----------
test('apt: "pacote-" (remoção no apt) nunca vira dependência nem pacote do sistema', () => {
  assert.equal(lib.sysPkgOk('openssh-server'), true);
  assert.equal(lib.sysPkgOk('openssh-server-'), false);
  const d = dir('skill');
  write(path.join(d, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\n```bash\nsudo apt install -y openssh-server- pandoc\nsudo apt-get install ufw-\n```\n');
  const deps = lib.inferDeps(d, 'x').deps;
  assert.equal(deps.some((x) => /-$/.test(String(x.apt || '')) || /-$/.test(String(x.name || ''))), false);
  assert.equal(deps.some((x) => x.apt === 'pandoc'), true, 'o pacote legítimo da mesma linha continua valendo');
  const apt = lib.SYS_PMS.find((pm) => pm.id === 'apt'), dnf = lib.SYS_PMS.find((pm) => pm.id === 'dnf');
  assert.equal(lib.sysPkgOf({ type: 'bin', name: 'x', apt: 'openssh-server-' }, apt), '');
  assert.equal(lib.sysPkgOf({ type: 'bin', name: 'x', apt: 'openssh-server-' }, dnf), '', 'vale também quando outro gerenciador herda o nome do apt');
  assert.equal(lib.sysPkgOf({ type: 'bin', name: 'x', apt: 'poppler-utils' }, apt), 'poppler-utils');
});

// ---------- Item 7: limpeza só das próprias sobras ----------
test('limpeza: pasta hub-skill-* de outro usuário não entra na lista nem é apagada', { skip: !POSIX }, async () => {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-'));
  write(path.join(clone, 'arquivo.txt'), 'x');
  const hubItem = async () => ((await lib.scanGarbage([])).tools.find((t) => t.tool === 'hub') || { items: [] }).items.find((i) => i.kind === 'glob' && i.files.includes(clone));
  const mine = await hubItem();
  assert.ok(mine, 'a sobra do próprio usuário continua listada');
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid() + 1; // como se a pasta fosse de outro usuário
  try {
    assert.equal(await hubItem(), undefined);
    await assert.rejects(lib.cleanGarbage({ tool: 'hub', items: [mine.id] }));
    assert.equal(fs.existsSync(path.join(clone, 'arquivo.txt')), true);
  } finally { process.getuid = realGetuid; }
  const r = await lib.cleanGarbage({ tool: 'hub', items: [mine.id] });
  assert.equal(r.results[0].ok, true);
  assert.equal(fs.existsSync(clone), false);
});

// ---------- Item 4: sucessor de modelo do Codex ----------
async function codexApply(configToml, models) {
  const home = dir('codex');
  const file = write(path.join(home, 'config.toml'), configToml);
  write(process.env.HUB_CONFIG, `[cx]\nlabel = Codex\ncommand = codex\nenv = CODEX_HOME=${home}\n`);
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ models }) });
  try { const r = await freshLib().modelsApply('cx'); return { r, text: fs.readFileSync(file, 'utf8') }; } finally { global.fetch = realFetch; }
}
test('codex: troca legítima muda só o valor e preserva recuo, aspas e comentário', async () => {
  const before = '# topo\n  model = \'gpt-old\'   # meu padrão\napproval_policy = "on-request"\n\n[profiles.p]\nmodel = "gpt-old"\n';
  const { r, text } = await codexApply(before, [{ slug: 'gpt-old', upgrade: { model: 'gpt-mid' } }, { slug: 'gpt-mid', upgrade: { model: 'gpt-new.1' } }, { slug: 'gpt-new.1', upgrade: null }]);
  assert.equal(text, before.replace("'gpt-old'   #", "'gpt-new.1'   #"));
  assert.deepEqual(r.applied, ['Modelo padrão: gpt-old → gpt-new.1']);
});
test('codex: sucessor com quebra de linha, padrão de substituição ou fora da lista não altera o config.toml', async () => {
  const before = 'model = "gpt-old"\napproval_policy = "on-request"\n';
  const inject = 'gpt-new"\nnotify = ["sh", "-c", "echo X"]\n[mcp_servers.evil]\ncommand = "sh"\nx = "';
  for (const models of [
    [{ slug: 'gpt-old', upgrade: { model: inject } }],
    [{ slug: 'gpt-old', upgrade: { model: inject } }, { slug: inject, upgrade: null }], // mesmo "listado", o nome é inválido
    [{ slug: 'gpt-old', upgrade: { model: "z$'" } }, { slug: "z$'" }],
    [{ slug: 'gpt-old', upgrade: { model: 'gpt-fantasma' } }],
    [{ slug: 'gpt-old', upgrade: { model: { x: 1 } } }],
  ]) {
    const { r, text } = await codexApply(before, models);
    assert.equal(text, before);
    assert.deepEqual(r.applied, []);
    assert.equal(r.rows[0].status, 'unknown');
    assert.match(r.rows[0].note, /sucessor fora do padrão/);
  }
});

// ---------- Item 2: abertura da interface ----------
test('interface: dono de uma conexão local pela tabela de sockets do Linux', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:128B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:128B 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 12 1 0000000000000000 20 4 30 10 -1',
    '   2: 0100007F:D431 0100007F:128B 01 00000000:00000000 00:00000000 00000000  1001        0 13 1 0000000000000000 20 4 30 10 -1',
    '   3: 0A00020F:D432 0100007F:128B 01 00000000:00000000 00:00000000 00000000  1002        0 14 1 0000000000000000 20 4 30 10 -1',
  ].join('\n');
  assert.equal(lib.peerUidFrom(table, 0xd431, 0x128b), 1001, 'o socket do cliente (porta de origem → porta do hub) dá o dono');
  assert.equal(lib.peerUidFrom(table, 0xd432, 0x128b), null, 'endereço que não é o local não conta');
  assert.equal(lib.peerUidFrom(table, 0xd433, 0x128b), null);
  assert.equal(lib.peerUidFrom('', 1, 2), null);
  const v6 = '   0: 0000000000000000FFFF00000100007F:D431 0000000000000000FFFF00000100007F:128B 01 00000000:00000000 00:00000000 00000000  1003        0 15 1 0000000000000000 20 4 30 10 -1';
  assert.equal(lib.peerUidFrom(v6, 0xd431, 0x128b), 1003, 'socket IPv4 mapeado em IPv6');
});

const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';
// Sobe a interface de verdade com um abridor de navegador de mentira no PATH e devolve o link que ele recebeu.
async function startUi(openerExit) {
  const opener = stubBin(OPENER, openerExit);
  const env = { ...process.env, PATH: `${opener.bin}${path.delimiter}${REAL_PATH}`, HUB_UI_PORT: '0' };
  delete env.HUB_UI_NO_OPEN;
  delete env.WSL_DISTRO_NAME;
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'tty.js'), SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const until = async (fn, what) => { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`tempo esgotado esperando ${what}\n${out}`); };
  const m = await until(() => opener.calls().match(/http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]+)/), 'o abridor ser chamado');
  const port = Number(m[1]);
  const post = (code, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/session', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
  const get = (p, token) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, headers: token ? { 'X-Hub-Token': token } : {} }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject); });
  return { child, code: m[2], port, post, get, until, output: () => out, stop: () => child.kill('SIGTERM') };
}

test('interface: o código abre a sessão uma vez; reapresentá-lo é recusado e registrado na atividade', { skip: !POSIX || /microsoft/i.test(os.release()) }, async () => {
  const ui = await startUi(0);
  try {
    assert.equal((await ui.post('0'.repeat(48))).status, 401, 'código inventado');
    const first = await ui.post(ui.code);
    assert.equal(first.status, 200);
    assert.match(first.body.token, /^[0-9a-f]{48}$/);
    assert.equal(await ui.get('/api/progress', first.body.token), 200, 'o token devolvido vale na API (e a conexão do próprio usuário passa)');
    assert.equal(await ui.get('/api/progress'), 401);
    const again = await ui.post(ui.code);
    assert.equal(again.status, 401);
    assert.match(again.body.error, /link expirado/, 'a mensagem para o navegador continua a mesma');
    assert.equal((await ui.post(ui.code, { Origin: 'http://evil.example' })).status, 403);
    await ui.until(() => /navegador autorizado pelo link de abertura/.test(ui.output()), 'o registro de autorização');
    await ui.until(() => /já usado foi apresentado de novo/.test(ui.output()), 'o registro de reapresentação');
  } finally { ui.stop(); }
});

test('interface: se o navegador não abre, o código do link deixa de valer na hora', { skip: !POSIX || /microsoft/i.test(os.release()) }, async () => {
  const ui = await startUi(1);
  try {
    await ui.until(() => /não consegui abrir o navegador/.test(ui.output()), 'o aviso de falha do abridor');
    assert.equal((await ui.post(ui.code)).status, 401);
    assert.doesNotMatch(ui.output(), /navegador autorizado/);
  } finally { ui.stop(); }
});

// ---------- Item 8: Windows não resolve programas pela pasta atual ----------
test('windows: where e cmd.exe saem da pasta do sistema, e o where não enxerga a pasta atual', { skip: !POSIX }, () => {
  // Simulação: plataforma trocada para win32 num processo à parte, com uma "pasta do sistema" de mentira cujo
  // where.exe devolve um .cmd na pasta de onde foi chamado (é assim que o where real trata a pasta atual).
  const sys = dir('winroot');
  const sys32 = path.join(sys, 'System32');
  write(path.join(sys32, 'where.exe'), '#!/bin/sh\necho "$(/bin/pwd -P)/$1.cmd"\n', 0o755);
  write(path.join(sys32, 'cmd.exe'), '', 0o755);
  const project = dir('projeto');
  write(path.join(project, 'claude.cmd'), '@echo PLANTED\r\n');
  const script = `Object.defineProperty(process, 'platform', { value: 'win32' });
    const lib = require(${JSON.stringify(SERVER)});
    process.stdout.write(JSON.stringify({ spawn: lib.spawnArgs('claude', ['--x']), shell: lib.shellArgs('echo oi') }));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: project, encoding: 'utf8', env: { ...process.env, SystemRoot: sys } });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  const cmdExe = path.join(sys32, 'cmd.exe');
  assert.equal(got.spawn[0], cmdExe, 'cmd.exe pelo caminho completo');
  assert.equal(got.shell[0], cmdExe);
  assert.ok(got.spawn[1][3].includes(path.join(fs.realpathSync(sys32), 'claude.cmd')), got.spawn[1][3]);
  assert.ok(!got.spawn[1][3].includes(fs.realpathSync(project)), 'o arquivo plantado na pasta do projeto não é o escolhido');
});

// ---------- Item 3: textos de repositórios no terminal ----------
test('terminal: plain() tira sequências de controle e os pontos de impressão do fluxo de skills passam por ele', () => {
  const hub = require(path.join(ROOT, 'bin', 'hub.js'));
  assert.equal(hub.plain('a\x1b[2J\x1b]0;titulo\x07b\x9b31mção'), 'a[2J]0;titulob31mção');
  assert.doesNotMatch(hub.plain('a\x1b[2J\x1b]0;t\x07b\x9bção\x00'), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.equal(hub.plain('instalação concluída: ~/.claude/skills/é'), 'instalação concluída: ~/.claude/skills/é');
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'hub.js'), 'utf8');
  // valores vindos do repositório (nome de pasta, caminho, linhas de log da biblioteca) nunca saem crus
  for (const raw of ['`${f}: `', '`${s.skill}: `', 'vem de ${sk.path}', 'sk.also.join(', 'pulando: ${f}`', '${N} ${l}`', '${N} ${l}\\n`'])
    assert.equal(src.includes(raw), false, `impressão sem plain(): ${raw}`);
});
