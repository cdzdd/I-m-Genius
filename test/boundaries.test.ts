import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { handleCommandHook } from '../src/capture.js';
import { initializeLocalRepository } from '../src/transport.js';
import { processOnce, preview, enableSync } from '../src/publish.js';
import { runCli } from '../src/cli.js';
import type { Config } from '../src/schema.js';

// A source/import audit is a regression guard, not an OS sandbox or dependency audit.
function auditSource(name: string, text: string): { errors: string[]; imports: string[] } {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [], imports: string[] = [];
  const forbidden = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'require', 'eval', 'Function', 'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen']);
  const builtins = new Set(['fs/promises', 'path', 'crypto', 'async_hooks', 'os', 'url']);
  function visit(node: ts.Node): void {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      const elements = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const typeOnly = clause?.isTypeOnly || elements && ts.isNamedImports(elements) && elements.elements.length > 0 && elements.elements.every(x => x.isTypeOnly)
        || elements && ts.isNamedExports(elements) && elements.elements.length > 0 && elements.elements.every(x => x.isTypeOnly);
      if (typeOnly) return;
      if (name === 'src/capture.ts' && ts.isExportDeclaration(node)
        && (!elements || !ts.isNamedExports(elements) || elements.elements.some(x => !x.isTypeOnly && (x.name.text !== 'handleCommandHook' || (x.propertyName?.text ?? x.name.text) !== 'handleCommandHook')))) errors.push('capture exposes an additional public interface');
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        imports.push(specifier);
        const builtin = specifier.replace(/^node:/, '');
        if (builtin === 'child_process' ? name !== 'src/transport.ts' : !specifier.startsWith('.') && !specifier.startsWith('@modelcontextprotocol/sdk/') && !['proper-lockfile', 'smol-toml'].includes(specifier) && !builtins.has(builtin)) errors.push(`forbidden module: ${specifier}`);
      }
    }
    if (ts.isImportEqualsDeclaration(node) || node.kind === ts.SyntaxKind.ImportKeyword) errors.push('runtime module loading');
    if (ts.isIdentifier(node) && forbidden.has(node.text)) errors.push(`execution/network API: ${node.text}`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && forbidden.has(node.argumentExpression.text)) errors.push('computed execution/network API');
    if (name === 'src/capture.ts' && ts.isExportAssignment(node)) errors.push('capture exposes an additional public interface');
    if (name === 'src/capture.ts' && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(x => x.kind === ts.SyntaxKind.ExportKeyword)) {
      if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)
        && (!ts.isFunctionDeclaration(node) || node.name?.text !== 'handleCommandHook' || ts.getModifiers(node)?.some(x => x.kind === ts.SyntaxKind.DefaultKeyword))) errors.push('capture exposes an additional public interface');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { errors, imports };
}

test('source guard detects execution/network entry points and runtime imports, including aliases', () => {
  for (const source of [
    "import { request as r } from 'node:https'; r('x');",
    "export * from 'node:net';",
    "import cp from 'node:child_process'; cp.exec('x');",
    "import { createContext } from 'node:vm';",
    "const load = require; load('node:http');",
    "import('./helper.js');",
    "const f = globalThis.fetch; f('x');",
    "new WebSocket('x');", "eval('x');", "new Function('x');",
    "process.getBuiltinModule('child_process');",
  ]) assert.ok(auditSource('src/capture.ts', source).errors.length > 0, source);
  assert.deepEqual(auditSource('src/capture.ts', "import type { ChildProcess } from 'node:child_process'; export type { Socket } from 'node:net';").errors, []);
  assert.deepEqual(auditSource('src/transport.ts', "import { execFile } from 'node:child_process'; execFile('git', []);").errors, []);
});

test('capture guard rejects every extra value export but permits type-only exports', () => {
  for (const source of [
    'const raw = {}; export { raw };',
    'const raw = {}; export { raw as renamed };',
    'const raw = {}; export { raw as handleCommandHook };',
    'type Raw = {}; const raw = {}; export { type Raw, raw };',
    'const raw = {}; export default raw;',
    "export { raw } from './helper.js';",
    "export * from './helper.js';",
    'export const raw = {};',
    'export default function handleCommandHook() {}',
  ]) assert.ok(auditSource('src/capture.ts',source).errors.includes('capture exposes an additional public interface'),source);
  for (const source of [
    'export type Raw = {}; export interface Shape {}',
    'type Raw = {}; export type { Raw };',
    'type Raw = {}; export { type Raw };',
    'export async function handleCommandHook() {}',
    'async function handleCommandHook() {}; export { handleCommandHook };',
  ]) assert.deepEqual(auditSource('src/capture.ts',source).errors,[],source);
});

test('production source and executable package scripts have a closed audited import graph', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const files = (await readdir('src')).filter(x => /\.(?:[cm]?[jt]s)$/.test(x)).map(x => resolve('src', x));
  const runtime = new Set(files);
  for (const bin of Object.values(packageJson.bin) as string[]) {
    const source = resolve(bin.replace(/^dist\//, '').replace(/\.js$/, '.ts'));
    assert.ok(runtime.has(source), `unaudited executable: ${bin}`);
  }
  assert.deepEqual(packageJson.scripts, { build: 'tsc', test: 'npm run build && node --test dist/test/*.test.js' }, 'new executable scripts require audit coverage');
  const dependencies = new Set(Object.keys(packageJson.dependencies));
  for (const file of files) {
    const result = auditSource(relative(process.cwd(), file).replaceAll('\\', '/'), await readFile(file, 'utf8'));
    assert.deepEqual(result.errors, [], file);
    for (const imported of result.imports) {
      if (imported.startsWith('.')) assert.ok(runtime.has(resolve(dirname(file), imported.replace(/\.js$/, '.ts'))), `import outside audited source: ${file}: ${imported}`);
      else if (!imported.startsWith('node:')) {
        const packageName = imported.startsWith('@') ? imported.split('/').slice(0, 2).join('/') : imported.split('/')[0];
        assert.ok(dependencies.has(packageName), `undeclared runtime dependency: ${imported}`);
      }
    }
  }
});

const CANARY = 'PRIVATE_CANARY';
const git = promisify(execFile);
async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(path, entry.name)) : Promise.resolve([join(path, entry.name)])));
  return groups.flat();
}
test('sentinel stays out of capture persistence, real commit history, preview and fixed errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whativedone-boundary-'));
  const c: Config = { privateDir: join(root, 'private'), gitDir: join(root, 'repo'), remoteUrl: 'https://example.invalid/log.git', branch: 'main', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' };
  try {
    await initializeLocalRepository(c);
    const configPath = join(c.privateDir, 'config.json');
    await writeFile(configPath, JSON.stringify(c));
    async function hook(payload: object) {
      async function* input() { yield Buffer.from(JSON.stringify(payload)); }
      return handleCommandHook('codex', c, input());
    }
    const base = { session_id: CANARY, turn_id: CANARY, prompt: CANARY, cwd: CANARY, transcript_path: CANARY, last_assistant_message: CANARY };
    const startResult = await hook({ ...base, hook_event_name: 'UserPromptSubmit' }) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(startResult.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(JSON.stringify(startResult).includes(CANARY), false);
    const progress = { category: 'implementation', status: 'in_progress' };
    const post = { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__whativedone__classify_progress', tool_use_id: CANARY, tool_input: progress, tool_response: { structuredContent: progress } };
    assert.deepEqual(await hook(post), {});
    assert.deepEqual(await hook({ ...post, tool_use_id: CANARY + 'bad', tool_input: { ...progress, error: CANARY } }), { systemMessage: 'WhatIveDone: invalid_hook' });
    assert.deepEqual(await hook({ ...base, hook_event_name: 'Stop' }), {});
    for (const file of await walk(root)) assert.equal((await readFile(file)).includes(Buffer.from(CANARY)), false, file);
    assert.equal(await processOnce(c), 'local');
    const snapshot = await preview(c);
    assert.equal(snapshot.commits.length, 1);
    assert.match(snapshot.commits[0].worklog, /\| 实现 \| 进行中 \|/);
    assert.equal(JSON.stringify(snapshot).includes(CANARY), false);
    for (const commit of snapshot.commits) {
      const { stdout } = await git('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'show', '--format=fuller', '--binary', commit.oid], { windowsHide: true });
      assert.equal(stdout.includes(CANARY), false);
    }
    for (const file of await walk(root)) assert.equal((await readFile(file)).includes(Buffer.from(CANARY)), false, file);
    // Only remote execution is doubled; capture, local Git audit and receipt writes remain real.
    const native = childProcess.execFile;
    let remoteOid = '';
    (childProcess as any).execFile = (exe: string, args: string[], options: unknown, callback: any) => {
      if (args.includes('ls-remote')) {
        queueMicrotask(() => callback(null, Buffer.from(remoteOid ? `${remoteOid}\trefs/heads/main\n` : ''), Buffer.alloc(0)));
        return {};
      }
      if (args.includes('push')) {
        assert.equal(args.at(-1), `${snapshot.targetOid}:refs/heads/main`);
        remoteOid = snapshot.targetOid;
        queueMicrotask(() => callback(null, Buffer.alloc(0), Buffer.alloc(0)));
        return {};
      }
      return (native as any)(exe, args, options, callback);
    };
    syncBuiltinESMExports();
    try {
      await enableSync(c);
      assert.equal(await processOnce(c), 'synced');
    } finally { childProcess.execFile = native; syncBuiltinESMExports(); }
    const receipt = JSON.parse(await readFile(join(c.privateDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.result, 'ok');
    assert.equal(receipt.targetOid, snapshot.targetOid);
    for (const file of await walk(c.privateDir)) assert.equal((await readFile(file)).includes(Buffer.from(CANARY)), false, file);
    const output: string[] = [];
    assert.equal(await runCli(['preview', CANARY, '--config', configPath], undefined, value => output.push(value)), 1);
    assert.equal(output.join('').includes(CANARY), false);
    // Deliberately place private text in an actual commit: policy must reject before CLI prints a patch.
    await writeFile(join(c.gitDir, 'WORKLOG.md'), CANARY);
    await git('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'add', 'WORKLOG.md'], { windowsHide: true });
    await git('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, '-c', 'user.name=Logger', '-c', 'user.email=logger@example.invalid', '-c', `core.hooksPath=${join(c.privateDir, 'empty')}`, '-c', 'commit.gpgSign=false', 'commit', '-m', 'worklog: append progress'], { windowsHide: true });
    output.length = 0;
    assert.equal(await runCli(['preview', '--config', configPath], undefined, value => output.push(value)), 1);
    assert.deepEqual(output, ['{"errorCode":"invalid_history"}']);
    assert.deepEqual(await hook({ ...post, turn_id: CANARY + 'next', tool_use_id: CANARY + 'next' }), {});
    assert.equal(await processOnce(c), 'paused');
    for (const file of await walk(c.privateDir)) assert.equal((await readFile(file)).includes(Buffer.from(CANARY)), false, file);
  } finally { await rm(root, { recursive: true, force: true }); }
});
