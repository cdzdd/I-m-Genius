import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { deflateSync } from 'node:zlib';
import { appendRows, type Config } from '../src/schema.js';
import { initializeLocalRepository, readSnapshot, withAuditSession, checkSnapshot } from '../src/transport.js';
import { readState } from '../src/store.js';

async function fixture(count = 60) {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-batch-'));
    const c: Config = { privateDir: root, gitDir: join(root, 'repository'), remoteUrl: 'https://example.invalid/log.git', branch: 'main', authorName: 'Perf', authorEmail: 'perf@example.invalid', captureEnabled: true, mode: 'local' };
    await initializeLocalRepository(c);
    let text = '', stream = '';
    for (let index = 0; index < count; index++) {
        text = appendRows(text, [{ time: '2026-10-01T00:00:00.000Z', category: 'implementation', status: 'in_progress' }]);
        stream += `commit refs/heads/main\ncommitter Perf <perf@example.invalid> 1790812800 +0000\ndata 25\nworklog: append progress\n\nM 100644 inline WORKLOG.md\ndata ${Buffer.byteLength(text)}\n${text}\n`;
    }
    cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'fast-import', '--quiet'], { input: stream, windowsHide: true });
    cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'reset', '--hard'], { windowsHide: true });
    return c;
}

test('full audit batches object reads and returns the actual Git patch', async () => {
    const c = await fixture();
    const native = cp.spawn;
    let batches = 0;
    cp.spawn = ((exe: any, args: any, options: any) => {
        if (args.includes('cat-file')) batches++;
        return native(exe, args, options);
    }) as typeof cp.spawn;
    syncBuiltinESMExports();
    try {
        const snapshot = await readSnapshot(c, await readState(c.privateDir), 0);
        assert.equal(snapshot.commits.length, 60);
        assert.equal(batches, 1);
        const patch = cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-color', '-p', snapshot.targetOid, '--', 'WORKLOG.md'], { windowsHide: true, encoding: 'utf8' });
        assert.equal(snapshot.commits.at(-1)!.patch, patch);
        assert.deepEqual(checkSnapshot(c, snapshot), { ok: true });
        assert.throws(() => { snapshot.commits[0].worklog = 'PRIVATE_CANARY'; }, TypeError);
        const forged = { ...snapshot, commits: snapshot.commits.map((view, i) => i ? view : { ...view, worklog: 'PRIVATE_CANARY' }) };
        assert.deepEqual(checkSnapshot(c, forged), { ok: false, code: 'invalid_content' });
    } finally { cp.spawn = native; syncBuiltinESMExports(); }
});

test('batch reuse avoids object rereads but the next transaction rechecks object hashes', async () => {
    const c = await fixture(3);
    const native = cp.spawn;
    let requests = 0;
    cp.spawn = ((exe: any, args: any, options: any) => {
        const child = native(exe, args, options);
        if (args.includes('cat-file')) {
            const write = child.stdin!.write.bind(child.stdin);
            (child.stdin as any).write = (chunk: any, ...rest: any[]) => {
                requests += String(chunk).trim().split('\n').length;
                return (write as any)(chunk, ...rest);
            };
        }
        return child;
    }) as typeof cp.spawn;
    syncBuiltinESMExports();
    try {
        await withAuditSession(async () => {
            const state = await readState(c.privateDir);
            await readSnapshot(c, state, 0);
            assert.equal(requests, 9);
            await readSnapshot(c, state, 0);
            assert.equal(requests, 9);
        });
        const blob = cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'rev-parse', 'HEAD:WORKLOG.md'], { windowsHide: true, encoding: 'utf8' }).trim();
        const objectPath = join(c.gitDir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
        await mkdir(join(c.gitDir, '.git', 'objects', blob.slice(0, 2)), { recursive: true });
        const bytes = cp.execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, 'cat-file', 'blob', blob], { windowsHide: true });
        const original = deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
        await chmod(objectPath, 0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await writeFile(objectPath, deflateSync(Buffer.from('blob 7\0private')));
        await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0), /invalid_history/);
        await writeFile(objectPath, original);
    } finally { cp.spawn = native; syncBuiltinESMExports(); }
});
