'use strict';
// Testes da descoberta de skills fora do formato padrão e do motor de dependências. Rode com: node --test test/
// Nada toca a máquina: HOME e TMPDIR ficam numa pasta temporária, e python3, uv, pipx, brew e git são programas
// de mentira que só anotam como foram chamados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const BOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-')));
const HOME = path.join(BOX, 'home');
const TMP = path.join(BOX, 'tmp');
fs.mkdirSync(HOME);
fs.mkdirSync(TMP);
const REAL_PATH = process.env.PATH;
// HUB_FIXED_PATH: o hub não acrescenta ao PATH as pastas conhecidas (~/.local/bin, Homebrew…), onde poderia haver um uv de verdade
Object.assign(process.env, { HOME, USERPROFILE: HOME, HUB_CONFIG: path.join(HOME, 'hub-config'), TMPDIR: TMP, TMP, TEMP: TMP, HUB_UI_NO_OPEN: '1', HUB_NO_UPDATE: '1', HUB_FIXED_PATH: '1' });
delete process.env.XDG_CONFIG_HOME;
test.after(() => { process.env.PATH = REAL_PATH; fs.rmSync(BOX, { recursive: true, force: true }); });

const POSIX = process.platform !== 'win32';
const freshLib = () => { delete require.cache[require.resolve(SERVER)]; return require(SERVER); };
const lib = freshLib();
const write = (f, text, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mode) fs.chmodSync(f, mode); return f; };
let seq = 0;
const dir = (name) => { const d = path.join(BOX, `${name}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const tree = (d) => fs.readdirSync(d, { recursive: true }).map((x) => String(x).split(path.sep).join('/')).filter((x) => fs.statSync(path.join(d, x)).isFile()).sort();
const head = (name, extra = '') => `---\nname: ${name}\ndescription: descrição de ${name}\n${extra}---\n`;

// Programas de mentira num PATH que só tem eles (mais which, cat e cp, por link): nenhum python, uv, pipx, brew ou
// git de verdade é alcançável. O python3 responde ao que o hub pergunta (versão, pip, módulos) pelo facts.json e
// "instala" com o pip, falhando só no pacote badpkg. Cada um anota os argumentos em <nome>.calls.
const realBin = (name) => REAL_PATH.split(path.delimiter).map((d) => path.join(d, name)).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
function sandbox({ uv = false, pipx = false, brew = false, git = '', facts = {} } = {}) {
  const bin = dir('bin');
  for (const tool of ['which', 'cat', 'cp']) fs.symlinkSync(realBin(tool), path.join(bin, tool));
  // "uv tool list" é só consulta (o hub pergunta o que já está instalado): não conta como chamada
  const calls = (name) => { const f = path.join(bin, `${name}.calls`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l !== 'tool list' && l !== 'list --short').join('\n') : ''; };
  const stub = (name, body) => write(path.join(bin, name), `#!/bin/sh\n${body}\n`, 0o755);
  write(path.join(bin, 'facts.json'), JSON.stringify({ version: '3.12.4', venv: false, pip: true, mods: {}, dists: {}, ...facts }));
  stub('python3', `case "$*" in
  *"-m pip install"*) echo "$@" >> "${bin}/pip.calls"
    case "$*" in *badpkg*) echo "ERROR: No matching distribution found for badpkg" >&2; exit 1;; esac
    exit 0;;
esac
case "$HUB_PY_SRC" in
  *json.dumps*) cat "${bin}/facts.json";;
  *get_preferred_scheme*) echo "${bin}/userbin";;
esac
exit 0`);
  const note = (name, exit = 0) => stub(name, `echo "$@" >> "${bin}/${name}.calls"\nexit ${exit}`);
  if (uv) note('uv', uv === 'fail' ? 1 : 0);
  if (pipx) note('pipx');
  if (brew) note('brew');
  // git de mentira: "clona" copiando a pasta de exemplo e responde ao log com um commit fixo
  if (git) stub('git', `case "$1" in
  clone) for a; do last=$a; done; cp -R "${git}/." "$last"; exit 0;;
  -C) echo "abc1234|2026-01-02|abc1234abc1234abc1234abc1234abc1234abc12"; exit 0;;
esac
exit 0`);
  process.env.PATH = bin;
  return { bin, calls, lib: freshLib() };
}

// Repositório de exemplo no formato do graphify: pacote Python com a skill ao lado do código, uma variante por
// agente e as referências de cada variante em skills/<variante>/references.
function toolRepo() {
  const repo = dir('repo');
  write(path.join(repo, 'pyproject.toml'), `[build-system]
requires = ["setuptools"]

[project]
name = "toolx-cli"
requires-python = ">=3.11.5,<3.15"
dependencies = [
    "networkx>=3.4",
    # comentário com ] no meio
    "tomli>=2.0.1; python_version < '3.11'",
    "psycopg[binary]>=3",
]

[project.scripts]
toolx = "toolx.__main__:main"
toolx-mcp = "toolx.serve:main"

[project.optional-dependencies]
pdf = ["pypdf>=6"]
`);
  write(path.join(repo, 'README.md'), '# toolx\n\n```bash\nuv tool install toolx-cli      # instala a CLI (ou: pipx install toolx-cli)\ntoolx install\n```\n');
  const pkg = path.join(repo, 'toolx');
  write(path.join(pkg, '__init__.py'), '"""toolx."""\n');
  write(path.join(pkg, 'cli.py'), '"""Lazy\nimport of main to avoid a cycle.\n"""\nimport networkx\nimport requests\ntry:\n    import graspologic\nexcept ImportError:\n    graspologic = None\n');
  const body = (who) => `${head('toolx')}\n# /toolx (${who})\n\nVeja \`references/query.md\` para consultas.\n\n\`\`\`bash\nif command -v uv >/dev/null 2>&1; then\n    uv tool install --upgrade toolx-cli -q 2>&1 | tail -3\nelse\n    "$PYTHON" -m pip install toolx-cli -q 2>/dev/null \\\\\n      || "$PYTHON" -m pip install toolx-cli -q --break-system-packages 2>&1 | tail -3\nfi\ntoolx build .\n\`\`\`\n\n> Dica: defina GEMINI_API_KEY para usar o Gemini (\`pip install 'toolx-cli[gemini]'\`).\n`;
  write(path.join(pkg, 'skill.md'), body('claude'));
  write(path.join(pkg, 'skill-codex.md'), body('codex'));
  write(path.join(pkg, 'skill-copilot.md'), body('copilot'));
  write(path.join(pkg, 'skill-notes.md'), '# anotações internas, sem cabeçalho\n');
  write(path.join(pkg, 'skill-template.md'), head('outra-coisa') + 'modelo\n');
  write(path.join(pkg, 'skills', 'claude', 'references', 'query.md'), 'consulta (claude)\n');
  write(path.join(pkg, 'skills', 'codex', 'references', 'query.md'), 'consulta (codex)\n');
  return repo;
}

// ---------- Descoberta ----------
test('descoberta: skill.md em outra caixa numa pasta comum é instalado como SKILL.md, com a pasta inteira', () => {
  const repo = dir('repo');
  write(path.join(repo, 'skills', 'alpha', 'skill.md'), head('alpha') + 'corpo\n');
  write(path.join(repo, 'skills', 'alpha', 'scripts', 'run.py'), 'print(1)\n');
  write(path.join(repo, 'skills', 'alpha', 'skill-feedback.md'), 'documento qualquer\n');
  write(path.join(repo, 'skills', 'beta', 'SKILL.md'), head('beta'));
  const found = lib.findSkills(repo, repo, 'repo').sort((a, b) => (a.folder < b.folder ? -1 : 1));
  assert.deepEqual(found.map((s) => s.folder), ['alpha', 'beta']);
  const [alpha, beta] = found;
  assert.equal(alpha.file, 'skill.md');
  assert.equal(alpha.embedded, undefined);
  assert.equal(alpha.home, path.join(repo, 'skills', 'alpha'));
  // a listagem diz o nome real: num sistema de arquivos que ignora a caixa, só ela mostra a diferença
  assert.deepEqual(fs.readdirSync(alpha.dir).sort(), ['SKILL.md', 'scripts', 'skill-feedback.md']);
  assert.equal(alpha.name, 'alpha');
  // a skill no formato padrão continua vindo direto da pasta do repositório
  assert.equal(beta.dir, path.join(repo, 'skills', 'beta'));
  assert.equal(beta.file, undefined);
  const dest = path.join(dir('alvo'), 'alpha');
  lib.replaceSkillDir(alpha.dir, dest, 'acme/x\nabc · 2026-01-01\n', true);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['.hub-source', 'SKILL.md', 'scripts', 'skill-feedback.md']);
  lib.dropSources();
});

test('descoberta: skill embutida num pacote Python vira só o SKILL.md e as referências, com a variante de cada agente', () => {
  const repo = toolRepo();
  const found = lib.findSkills(repo, repo, 'toolx-repo');
  assert.equal(found.length, 1);
  const sk = found[0];
  assert.equal(sk.folder, 'toolx');
  assert.equal(sk.embedded, true);
  assert.equal(sk.home, path.join(repo, 'toolx'));
  // nada do código do pacote, nem os outros skill-*.md
  assert.deepEqual(tree(sk.dir), ['SKILL.md', 'references/query.md']);
  assert.match(fs.readFileSync(path.join(sk.dir, 'SKILL.md'), 'utf8'), /\(claude\)/);
  assert.equal(fs.readFileSync(path.join(sk.dir, 'references', 'query.md'), 'utf8'), 'consulta (claude)\n');
  // skill-notes.md (sem cabeçalho) e skill-template.md (outro nome) não são variantes
  assert.deepEqual(Object.keys(sk.variants).sort(), ['codex', 'copilot']);
  const codex = lib.skillDirFor(sk, 'codex');
  assert.match(fs.readFileSync(path.join(codex, 'SKILL.md'), 'utf8'), /\(codex\)/);
  assert.equal(fs.readFileSync(path.join(codex, 'references', 'query.md'), 'utf8'), 'consulta (codex)\n');
  // copilot tem arquivo próprio mas não tem referências próprias: usa as do claude
  const copilot = lib.skillDirFor(sk, 'copilot');
  assert.match(fs.readFileSync(path.join(copilot, 'SKILL.md'), 'utf8'), /\(copilot\)/);
  assert.equal(fs.readFileSync(path.join(copilot, 'references', 'query.md'), 'utf8'), 'consulta (claude)\n');
  // agentes sem variante própria recebem a padrão
  for (const t of ['claude', 'gemini', 'antigravity', 'agents']) assert.equal(lib.skillDirFor(sk, t), sk.dir, t);
  // procurar de novo no mesmo clone reaproveita a montagem
  assert.equal(lib.findSkills(repo, repo, 'toolx-repo')[0].dir, sk.dir);
  // o link direto para a pasta (ou para o arquivo) cai na mesma skill
  assert.equal(lib.skillAt(repo, path.join(repo, 'toolx'), 'toolx-repo').dir, sk.dir);
  assert.deepEqual(lib.parseSource('https://github.com/acme/toolx/blob/main/toolx/skill.md').sub, 'toolx');
  assert.deepEqual(lib.parseSource('https://github.com/acme/toolx/blob/main/toolx/skill-codex.md').sub, 'toolx');
  lib.dropSources();
});

test('descoberta: skill.md sem cabeçalho dentro de um pacote é documento, e skill-*.md soltos nunca viram skill', () => {
  const repo = dir('repo');
  write(path.join(repo, 'pkg', '__init__.py'), '');
  write(path.join(repo, 'pkg', 'skill.md'), '# notas sobre a habilidade do time\n');
  write(path.join(repo, 'docs', 'skill-conventions.md'), head('x'));
  write(path.join(repo, 'docs', 'SKILL-AUTHORING-STANDARD.md'), head('y'));
  assert.deepEqual(lib.findSkills(repo, repo, 'repo'), []);
});

test('descoberta: skill instalada com o arquivo em minúsculas continua aparecendo na lista', () => {
  const d = dir('instalada');
  write(path.join(d, 'skill.md'), head('minuscula'));
  assert.equal(lib.skillMeta(d).name, 'minuscula');
  assert.equal(lib.skillMeta(dir('vazia')), null);
});

// ---------- Leitura dos arquivos ----------
test('imports Python: texto de docstring não é import, try/except ImportError é opcional, TYPE_CHECKING fica de fora', () => {
  const src = `"""Módulo.

import of main to avoid a cycle.
    from helper import transform
"""
from __future__ import annotations
import os, sys
import networkx as nx, numpy
from rapidfuzz.fuzz import ratio
def f():
    '''
    import edges to every namespace
    '''
    import lazy_one
if TYPE_CHECKING:
    from typing_only import T
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
try:
    import graspologic
except Exception:
    graspologic = None
try:
    import must_have
finally:
    pass
# import comentado
x = "import dentro de string"
`;
  const got = Object.fromEntries(lib.pyImportsOf(src).map((i) => [i.mod, i.optional]));
  assert.deepEqual(got, { __future__: false, os: false, sys: false, networkx: false, numpy: false, rapidfuzz: false, lazy_one: false, tomllib: true, tomli: true, graspologic: true, must_have: false });
});

test('pyproject: nome, Python pedido, comandos e dependências, com colchetes e comentários dentro do array', () => {
  const p = lib.pyProject(fs.readFileSync(path.join(toolRepo(), 'pyproject.toml'), 'utf8'));
  assert.equal(p.name, 'toolx-cli');
  assert.equal(p.requires, '>=3.11.5,<3.15');
  assert.deepEqual(p.bins, ['toolx', 'toolx-mcp']);
  assert.deepEqual(p.deps, ['networkx>=3.4', "tomli>=2.0.1; python_version < '3.11'", 'psycopg[binary]>=3']);
  assert.deepEqual(p.extras, ['pypdf>=6']);
  const poetry = lib.pyProject('[tool.poetry]\nname = "velho"\n[tool.poetry.dependencies]\npython = "^3.9"\nrequests = "^2"\n[tool.poetry.scripts]\nvelho = "velho:main"\n');
  assert.deepEqual([poetry.name, poetry.deps, poetry.bins], ['velho', ['requests'], ['velho']]);
});

test('versões: requires-python e marcadores de ambiente do pip', () => {
  assert.equal(lib.pyVersionOk('3.14.7', '>=3.11.5,<3.15'), true);
  assert.equal(lib.pyVersionOk('3.9.6', '>=3.11.5,<3.15'), false);
  assert.equal(lib.pyVersionOk('3.15.0', '>=3.11.5,<3.15'), false);
  assert.equal(lib.pyVersionOk('3.11.4', '>=3.11.5'), false);
  assert.equal(lib.pyVersionOk('3.12.1', '~=3.12'), true);
  assert.equal(lib.pyVersionOk('3.12.1', '==3.12.*'), true);
  assert.equal(lib.pyVersionOk('', '>=3.11'), true, 'sem versão conhecida não há o que recusar');
  assert.equal(lib.pyVersionOk('3.9.6', ''), true);
  assert.equal(lib.markerOk('', '3.12.1'), true);
  assert.equal(lib.markerOk(" python_version < '3.11'", '3.12.1'), false);
  assert.equal(lib.markerOk('python_version >= "3.13"', '3.14.7'), true);
  assert.equal(lib.markerOk("python_version < '3.13' and python_version >= '3.10'", '3.12.1'), true);
  assert.equal(lib.markerOk("python_version < '3.11'", ''), null, 'sem Python conhecido não dá para decidir');
  assert.equal(lib.markerOk("implementation_name == 'cpython'", '3.12.1'), null);
  assert.equal(lib.markerOk(`sys_platform == '${process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'}'`, '3.12.1'), true);
  assert.equal(lib.markerOk("sys_platform == 'plan9'", '3.12.1'), false);
  assert.equal(lib.markerOk("sys_platform == 'plan9' or python_version >= '3.0'", '3.12.1'), true);
});

// ---------- Dedução de dependências ----------
test('dependências: a skill embutida pede só a ferramenta do pacote, sem palpites tirados do código', () => {
  const repo = toolRepo();
  const sk = lib.findSkills(repo, repo, 'toolx-repo')[0];
  const project = lib.projectOf(repo, sk.home);
  assert.deepEqual([project.type, project.name, project.bins, project.requires], ['py', 'toolx-cli', ['toolx', 'toolx-mcp'], '>=3.11.5,<3.15']);
  assert.match(project.cited, /^README\.md: uv tool install toolx-cli/);
  const inf = lib.inferDeps(sk.dir, 'toolx', { project, embedded: true, pyVersion: '3.12.4' });
  assert.deepEqual(inf.deps.map((d) => `${d.type}:${d.name}`), ['pytool:toolx-cli']);
  const tool = inf.deps[0];
  assert.deepEqual(tool.bins, ['toolx', 'toolx-mcp']);
  assert.equal(tool.requires, '>=3.11.5,<3.15');
  assert.equal(tool.optional, false);
  assert.equal(tool.label, 'toolx (ferramenta Python: toolx-cli)');
  // a linha de instalação que o hub assume não volta como "comando para você rodar"
  assert.deepEqual(inf.steps.filter((s) => s.kind === 'cmd'), []);
  assert.deepEqual(inf.envVars, ['GEMINI_API_KEY']);
  lib.dropSources();
});

test('dependências: sem o SKILL.md pedir, a ferramenta do pacote só entra se o README mandar instalar e a skill usar o comando', () => {
  const mk = (readme, skillBody) => {
    const repo = dir('repo');
    write(path.join(repo, 'pyproject.toml'), '[project]\nname = "acme-tool"\n[project.scripts]\nacme = "acme:main"\n');
    write(path.join(repo, 'README.md'), readme);
    write(path.join(repo, 'skills', 'acme', 'SKILL.md'), head('acme') + skillBody);
    const d = path.join(repo, 'skills', 'acme');
    return lib.inferDeps(d, 'acme', { project: lib.projectOf(repo, d), pyVersion: '3.12.4' }).deps.map((x) => `${x.type}:${x.name}`);
  };
  assert.deepEqual(mk('Instale com `pipx install acme-tool`.\n', '```bash\nacme run .\n```\n'), ['pytool:acme-tool']);
  assert.deepEqual(mk('Sem instruções de instalação.\n', '```bash\nacme run .\n```\n'), []);
  assert.deepEqual(mk('Instale com `pipx install acme-tool`.\n', 'Esta skill não chama o comando.\n'), []);
  // pacote de nome parecido no README não conta
  assert.deepEqual(mk('`pip install acme-tool-extras`\n', '```bash\nacme run .\n```\n'), []);
  // "pip install" do pacote do próprio projeto é a ferramenta, não um módulo para importar
  assert.deepEqual(mk('', '```bash\npip install acme-tool\nacme run .\n```\n'), ['pytool:acme-tool']);
});

test('dependências: manifesto manda, marcador é respeitado e import fora do manifesto ou com plano B é opcional', () => {
  const d = dir('skill');
  write(path.join(d, 'SKILL.md'), head('s') + '```bash\npip install "pandas>=2" -q && echo ok\nuvx ruff check .\n```\n');
  write(path.join(d, 'requirements.txt'), "requests>=2.31  # http\ntomli>=2; python_version < '3.11'\ncolorama; sys_platform == 'plan9'\nPyYAML\n");
  write(path.join(d, 'scripts', 'run.py'), '"""\nimport of nothing\n"""\nimport requests\nimport yaml\nimport helper\nimport surpresa\ntry:\n    import orjson\nexcept ImportError:\n    orjson = None\nfrom scripts import util\n');
  const deps = Object.fromEntries(lib.inferDeps(d, 's', { pyVersion: '3.12.4' }).deps.map((x) => [`${x.type}:${x.name}`, x]));
  assert.deepEqual(Object.keys(deps).sort(), ['bin:python3', 'bin:uv', 'py:orjson', 'py:pandas', 'py:requests', 'py:surpresa', 'py:yaml'].map((k) => (process.platform === 'win32' ? k.replace('python3', 'python') : k)).sort());
  assert.equal(deps['py:requests'].optional, false);
  assert.equal(deps['py:requests'].spec, 'requests>=2.31');
  assert.equal(deps['py:yaml'].pip, 'PyYAML');
  assert.equal(deps['py:yaml'].optional, false);
  assert.equal(deps['py:pandas'].spec, 'pandas>=2');
  assert.equal(deps['py:pandas'].optional, false);
  // importado mas fora do requirements.txt: não é instalado por palpite
  assert.equal(deps['py:surpresa'].optional, true);
  assert.match(deps['py:surpresa'].why, /fora do manifesto/);
  assert.equal(deps['py:orjson'].optional, true);
  // tomli (Python antigo), colorama (outro sistema) e helper (nome de arquivo do próprio projeto) nem aparecem
  assert.equal(deps['bin:uv'].optional, true);
});

test('dependências: sem manifesto, import comum é necessário e o do try/except é opcional', () => {
  const d = dir('skill');
  write(path.join(d, 'SKILL.md'), head('s'));
  write(path.join(d, 'scripts', 'a.py'), 'import pypdf\ntry:\n    import lxml\nexcept ImportError:\n    lxml = None\ntry:\n    import requests\nexcept ImportError:\n    print("instale com: uv pip install requests")\n    sys.exit(1)\nTEMPLATE = \'\'\'from sqlalchemy import create_engine\n\'\'\'\n');
  write(path.join(d, 'scripts', 'b.py'), 'import s\nmsg = "uv pip install algo"\n');
  const deps = Object.fromEntries(lib.inferDeps(d, 's', {}).deps.map((x) => [x.name, x.optional]));
  assert.equal(deps.pypdf, false);
  assert.equal(deps.lxml, true, 'o except segue em frente: o script funciona sem');
  assert.equal(deps.requests, false, 'o except encerra o script: é necessário');
  assert.equal('sqlalchemy' in deps, false, 'código dentro de um texto que o script gera não é import dele');
  assert.equal('uv' in deps, false, '"uv" numa mensagem do script não torna o uv uma dependência');
  // a skill que leva o nome da biblioteca que ensina continua precisando dela
  assert.equal(deps.s, false);
  // já uma pasta que é ela mesma um pacote Python se importa pelo próprio nome
  write(path.join(d, '__init__.py'), '');
  assert.equal('s' in Object.fromEntries(lib.inferDeps(d, 's', {}).deps.map((x) => [x.name, 1])), false);
});

test('dependências: comando quebrado em várias linhas e programas no meio de um pipe', () => {
  const d = dir('skill');
  write(path.join(d, 'SKILL.md'), head('s') + '```bash\nuv pip install \\\n    "torch>=2.0" \\\n    transformers\naws iam get-policy | \\\n  jq .Policy > p.json\nuv pip install "git+https://example.invalid/x.git"\n#!/usr/bin/env false\n```\n');
  write(path.join(d, 'scripts', 'run.py'), '#!/usr/bin/env -S uv run --script\nprint(1)\n');
  const inf = lib.inferDeps(d, 's', {});
  const deps = Object.fromEntries(inf.deps.map((x) => [`${x.type}:${x.name}`, x]));
  assert.equal(deps['py:torch'].spec, 'torch>=2.0');
  assert.equal(deps['py:transformers'].optional, false);
  assert.equal(deps['bin:jq'].optional, true);
  // script com shebang "uv run" precisa do uv de verdade
  assert.equal(deps['bin:uv'].optional, false);
  // o que o hub não instala (git, URL, pasta) fica à mostra como passo manual, em vez de sumir
  assert.deepEqual(inf.steps.filter((x) => x.kind === 'cmd').map((x) => x.cmd), ['uv pip install "git+https://example.invalid/x.git"']);
});

test('pip: o motivo da falha sai em uma frase', () => {
  assert.match(lib.pipWhy('ERROR: Could not find a version that satisfies the requirement of (from versions: none)\nERROR: No matching distribution found for of'), /não existe no PyPI/);
  assert.match(lib.pipWhy('ERROR: Ignored the following versions that require a different python version: 1.0 Requires-Python >=3.11'), /outra versão do Python/);
  assert.match(lib.pipWhy("error: command '/usr/bin/gcc' failed with exit code 1\nERROR: Failed building wheel for tree-sitter-dm"), /compilado/);
  assert.match(lib.pipWhy('NewConnectionError: Failed to establish a new connection: [Errno 8] nodename nor servname provided'), /sem conexão/);
  assert.match(lib.pipWhy('  × No solution found when resolving dependencies:\n  ╰─▶ Because pkg was not found in the package registry'), /não existe no PyPI/);
  assert.equal(lib.pipWhy('linha 1\n[notice] A new release of pip is available\nerro final esquisito'), 'erro final esquisito');
});

// ---------- Instalação (com programas de mentira) ----------
test('pip: um pacote ruim não derruba os outros; cada falha vem com o nome e o motivo', { skip: !POSIX }, async () => {
  const s = sandbox();
  const r = await s.lib.pipInstall(['bom-um', 'badpkg', 'bom-dois>=1.2']);
  assert.deepEqual(r.ok, ['bom-um', 'bom-dois>=1.2']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0][0], 'badpkg');
  assert.match(r.failed[0][1], /não existe no PyPI/);
  const calls = s.calls('pip').trim().split('\n');
  assert.equal(calls.length, 4, 'um lote e depois um por um');
  assert.match(calls[0], /--user --disable-pip-version-check|--disable-pip-version-check --quiet --user/);
  assert.match(calls[0], /bom-um badpkg bom-dois>=1\.2$/);
});

test('ferramenta Python: uv primeiro, só nomes do registro, e nada de instalar o uv sem ter sido anunciado', { skip: !POSIX }, async () => {
  // com uv no PATH: ambiente isolado, sempre com --upgrade (serve para instalar e para atualizar)
  let s = sandbox({ uv: true, pipx: true, brew: true });
  assert.deepEqual(await s.lib.installPyTool('toolx-cli', { requires: '>=3.11' }), { ok: true, via: 'uv' });
  assert.equal(s.calls('uv').trim(), 'tool install --upgrade toolx-cli');
  assert.equal(s.calls('pipx'), '');
  assert.equal(s.calls('pip'), '');
  // git, URL, pasta e opções nunca chegam a um instalador
  for (const bad of ['git+https://example.invalid/x.git', 'https://example.invalid/x.whl', '../pacote', '.', '..', '-e', '--index-url=http://x', 'a b', 'pkg @ https://example.invalid/x.whl', '']) {
    const r = await s.lib.installPyTool(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.why, /inválido/, bad);
  }
  assert.equal(s.calls('uv').trim().split('\n').length, 1);

  // uv falha → pipx
  s = sandbox({ uv: 'fail', pipx: true, brew: true });
  assert.deepEqual(await s.lib.installPyTool('toolx-cli'), { ok: true, via: 'pipx' });
  assert.equal(s.calls('pipx').trim(), 'install toolx-cli');
  assert.deepEqual(await s.lib.installPyTool('toolx-cli', { upgrade: true }), { ok: true, via: 'pipx' });
  assert.match(s.calls('pipx'), /upgrade toolx-cli/);

  // sem uv nem pipx: pip do usuário, se o Python atende o pacote
  s = sandbox({ brew: true, facts: { version: '3.12.4' } });
  assert.deepEqual(await s.lib.installPyTool('toolx-cli', { requires: '>=3.11.5,<3.15' }), { ok: true, via: 'pip, no seu usuário' });
  assert.match(s.calls('pip'), /--user toolx-cli/);
  assert.equal(s.calls('brew'), '');

  // Python velho demais para o pacote: não tenta o pip (falharia) e não traz o uv por conta própria
  s = sandbox({ brew: true, facts: { version: '3.9.6' } });
  const old = await s.lib.installPyTool('toolx-cli', { requires: '>=3.11.5,<3.15' });
  assert.equal(old.ok, false);
  assert.match(old.why, /pede Python >=3\.11\.5,<3\.15 e o desta máquina é 3\.9\.6/);
  assert.equal(old.hint, 'uv tool install toolx-cli');
  assert.equal(s.calls('pip'), '');
  assert.equal(s.calls('brew'), '', 'sem bootstrap pedido, o Homebrew não é chamado');
  // pacote que não existe: a falha do pip é o fim da linha (o uv não resolveria)
  const missing = await s.lib.installPyTool('badpkg');
  assert.equal(missing.ok, false);
  assert.match(missing.why, /pip: não existe no PyPI/);
  assert.equal(s.calls('brew'), '');
});

// ---------- De ponta a ponta: instalar e atualizar pelo mesmo caminho da interface e do terminal ----------
test('ponta a ponta: cada conta recebe a sua variante, a atualização troca só o que mudou e a ferramenta acompanha', { skip: !POSIX }, async () => {
  const repo = toolRepo();
  write(process.env.HUB_CONFIG, '[claude]\nlabel = Claude\ncommand = claude\n\n[codex]\nlabel = Codex\ncommand = codex\n');
  const s = sandbox({ uv: true, brew: true, git: repo });
  const hub = s.lib;
  const targets = hub.skillTargets().filter((t) => ['claude', 'codex'].includes(t.tool));
  assert.deepEqual(targets.map((t) => t.tool).sort(), ['claude', 'codex']);
  const dirOf = (tool) => path.join(targets.find((t) => t.tool === tool).dir, 'toolx');
  // instalação antiga, do tempo em que o hub copiava o pacote inteiro: a nova entra no lugar
  write(path.join(dirOf('claude'), 'skill.md'), head('toolx'));
  write(path.join(dirOf('claude'), 'cli.py'), 'import requests\n');
  write(path.join(dirOf('claude'), '.hub-source'), `acme/toolx\nold0000 · 2026-01-01\nsha256:${hub.dirHash(dirOf('claude'))}\n`);

  // conferir dependências a partir do repositório: a ferramenta, com os comandos e o Python que o pacote declara
  const check = await hub.checkDeps(['toolx'], { source: 'acme/toolx' });
  assert.deepEqual(check.deps.map((d) => [d.type, d.name, d.ok, d.how]), [['pytool', 'toolx-cli', false, 'pytool']]);
  assert.deepEqual(check.auto, ['toolx (ferramenta Python: toolx-cli)']);
  assert.equal(check.deps[0].needsUv, undefined);
  const done = await hub.installDeps(['toolx'], false, { source: 'acme/toolx' });
  assert.deepEqual(done.log, ['Python: ferramenta toolx-cli instalada (uv)']);
  assert.equal(s.calls('uv').trim(), 'tool install --upgrade toolx-cli');

  const r = await hub.installSkills({ source: 'acme/toolx', skills: ['toolx'], targets: targets.map((t) => t.dir) });
  assert.deepEqual(r.installed, ['toolx']);
  assert.deepEqual(tree(dirOf('claude')), ['.hub-source', 'SKILL.md', 'references/query.md']);
  assert.deepEqual(tree(dirOf('codex')), ['.hub-source', 'SKILL.md', 'references/query.md']);
  assert.match(fs.readFileSync(path.join(dirOf('claude'), 'SKILL.md'), 'utf8'), /\(claude\)/);
  assert.match(fs.readFileSync(path.join(dirOf('codex'), 'SKILL.md'), 'utf8'), /\(codex\)/);
  assert.equal(fs.readFileSync(path.join(dirOf('codex'), 'references', 'query.md'), 'utf8'), 'consulta (codex)\n');
  assert.match(fs.readFileSync(path.join(dirOf('codex'), '.hub-source'), 'utf8'), /^acme\/toolx\nabc1234 · 2026-01-02\nsha256:[0-9a-f]{32}\n$/);
  // instalou por cima de uma cópia que já existia (a do claude): a ferramenta foi atualizada junto
  assert.deepEqual(r.local, ['toolx: ferramenta toolx-cli na versão mais recente (uv)']);

  // nada mudou no repositório: nada é trocado e a ferramenta não é reinstalada
  const uvBefore = s.calls('uv');
  let up = await hub.updateSkill({ skill: 'toolx' });
  assert.deepEqual([up.updated, up.unchanged.length, up.modified, up.local], [[], 2, [], []]);
  assert.equal(s.calls('uv'), uvBefore);

  // só a variante do codex mudou: só a pasta do codex é trocada
  fs.appendFileSync(path.join(repo, 'toolx', 'skill-codex.md'), '\nlinha nova\n');
  up = await hub.updateSkill({ skill: 'toolx' });
  assert.equal(up.updated.length, 1);
  assert.match(up.updated[0], /codex/);
  assert.equal(up.unchanged.length, 1);
  assert.match(fs.readFileSync(path.join(dirOf('codex'), 'SKILL.md'), 'utf8'), /linha nova/);
  assert.doesNotMatch(fs.readFileSync(path.join(dirOf('claude'), 'SKILL.md'), 'utf8'), /linha nova/);
  assert.deepEqual(up.local, ['toolx: ferramenta toolx-cli na versão mais recente (uv)']);
  assert.equal(s.calls('brew'), '');

  // editada na máquina depois de instalada: continua protegida, como qualquer outra skill
  fs.appendFileSync(path.join(dirOf('claude'), 'SKILL.md'), '\nminha anotação\n');
  fs.appendFileSync(path.join(repo, 'toolx', 'skill.md'), '\noutra linha\n');
  up = await hub.updateSkill({ skill: 'toolx' });
  assert.equal(up.modified.length, 1);
  assert.match(fs.readFileSync(path.join(dirOf('claude'), 'SKILL.md'), 'utf8'), /minha anotação/);
  hub.dropSources();
});

test('ponta a ponta: sem uv, sem pipx e sem pip, a lista avisa antes como a ferramenta vai entrar', { skip: !POSIX }, async () => {
  const repo = toolRepo();
  const s = sandbox({ brew: true, git: repo, facts: { version: '3.9.6', pip: false } });
  const check = await s.lib.checkDeps(['toolx'], { source: 'acme/toolx' });
  const tool = check.deps.find((d) => d.type === 'pytool');
  assert.equal(tool.ok, false);
  if (process.platform === 'darwin') {
    // macOS com Homebrew: o hub instala o uv antes, e isso está escrito na dependência
    assert.equal(tool.how, 'pytool');
    assert.equal(tool.needsUv, true);
    assert.match(tool.note, /antes o hub instala o uv pelo Homebrew/);
    assert.match(tool.why, /antes o hub instala o uv pelo Homebrew/);
  } else {
    assert.equal(tool.how, 'manual');
    assert.match(check.manual[0].label, /^uv, para instalar toolx-cli/);
    assert.match(check.manual[0].url, /astral\.sh\/uv/);
  }
  assert.equal(s.calls('brew'), '', 'conferir não instala nada');
  s.lib.dropSources();
});

test('ponta a ponta: repositório sem skill diz o que ele é', { skip: !POSIX }, async () => {
  const plugin = dir('repo');
  write(path.join(plugin, 'commands', 'deploy.md'), '---\ndescription: deploy\n---\n');
  let s = sandbox({ git: plugin });
  await assert.rejects(s.lib.fetchSource('acme/plugin', { fresh: true }), /nenhuma skill \(SKILL\.md\) encontrada em acme\/plugin: .*parece trazer comandos ou agentes/);
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
  await assert.rejects(s.lib.fetchSource('acme/plugin', { fresh: true }), /é um plugin do Claude Code sem skills dentro/);
  const pkg = dir('repo');
  write(path.join(pkg, 'pyproject.toml'), '[project]\nname = "so-cli"\n[project.scripts]\nso = "so:main"\n');
  write(path.join(pkg, 'README.md'), '```\npipx install so-cli\n```\n');
  s = sandbox({ git: pkg });
  await assert.rejects(s.lib.fetchSource('acme/so-cli', { fresh: true }), /pacote Python \(so-cli\) sem skill dentro\. O README manda instalar com: pipx install so-cli/);
  const vazio = dir('repo');
  write(path.join(vazio, 'README.md'), '# lista de links\n');
  s = sandbox({ git: vazio });
  await assert.rejects(s.lib.fetchSource('acme/lista', { fresh: true }), /nenhuma skill \(SKILL\.md\) encontrada em acme\/lista$/);
});
