import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const script = resolve('scripts/build-windows.ps1');
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function powershell(body: string) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; . ${literal(script)} -LibraryOnly; ${body}`], { windowsHide: true });
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(...(entry.isDirectory() ? await files(root, path) : [path]));
  }
  return result.sort();
}
test('Windows packaging copies only reviewed application files, never project data or tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whativedone-package-'));
  try {
    const source = join(root, 'source'), target = join(root, 'app');
    const modules = ['capture','cli','mcp','publish','schema','store','transport'];
    const allowed = ['package.json','package-lock.json','tsconfig.json','README.md','README.zh-CN.md','PRIVACY.md','LICENSE','THIRD_PARTY_NOTICES.md','licenses/codex/LICENSE', ...modules.flatMap(name => [`src/${name}.ts`, `dist/src/${name}.js`])];
    const rejected = ['config.json','.git/secret','private/key','test/secret.ts','dist/test/secret.js','src/.env','.superpowers/report.md'];
    for (const path of [...allowed, ...rejected]) {
      await mkdir(join(source, path, '..'), { recursive: true });
      await writeFile(join(source, path), rejected.includes(path) ? 'PRIVATE_CANARY' : path);
    }
    await powershell(`Copy-AppPayload -ProjectRoot ${literal(source)} -Destination ${literal(target)}`);
    assert.deepEqual(await files(target), allowed.sort());
    for (const path of await files(target)) assert.equal((await readFile(join(target,path),'utf8')).includes('PRIVATE_CANARY'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bundle manifest hashes both installer entries and runtime payload with canonical relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whativedone-manifest-'));
  try {
    const names = ['Install.cmd','installer/Install.ps1','payload/node.exe','payload/app/dist/src/cli.js'];
    for (const path of names) { await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),path); }
    await powershell(`Write-InstallerManifest -BundleRoot ${literal(root)} -Version '0.2.0'`);
    const manifest = JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
    assert.equal(manifest.version, '0.2.0');
    assert.deepEqual(manifest.files.map((f: {path:string}) => f.path).sort(), names.sort());
    for (const f of manifest.files) assert.equal(f.sha256, createHash('sha256').update(f.path).digest('hex'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('a modified Node download is rejected before extraction or dependency installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whativedone-node-hash-'));
  try {
    const archive = join(root,'node.zip'); await writeFile(archive,'PRIVATE_CANARY');
    const result = await powershell(`try { Assert-NodeArchive -Archive ${literal(archive)}; throw 'incorrectly_accepted' } catch { if ($_.Exception.Message -ne 'node_archive_hash_mismatch') { throw }; 'rejected' }`);
    assert.equal(result.stdout.trim(),'rejected');
  } finally { await rm(root,{recursive:true,force:true}); }
});
