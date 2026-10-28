import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import lockfile from 'proper-lockfile';
import { runCli } from '../src/cli.js';
import { enqueue, readEvents, readRunHealth, readWatcherStatus, writeRunHealth, type RunHealth } from '../src/store.js';
import { initializeLocalRepository } from '../src/transport.js';
import type { Config } from '../src/schema.js';

async function fixture(): Promise<{ c: Config; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-health-'));
    const c: Config = { privateDir: root, gitDir: join(root, 'repository'), remoteUrl: 'https://example.invalid/log.git', branch: 'main', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' };
    await initializeLocalRepository(c);
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify(c));
    return { c, path };
}
async function status(path: string): Promise<any> {
    const lines: string[] = [];
    assert.equal(await runCli(['status', '--config', path], undefined, line => lines.push(line)), 0);
    return JSON.parse(lines[0]);
}

test('old profiles have empty diagnostics; fixed-field run records reject private or malformed additions', async () => {
    const { c, path } = await fixture();
    const before = await status(path);
    assert.equal(before.lastRun, null);
    assert.equal(before.oldestQueuedAt, null);
    assert.equal(before.runHealthError, null);
    assert.deepEqual(before.watcher, { state: 'stopped', heartbeatAt: null });
    const health: RunHealth = { startedAt: '2026-10-28T00:00:00.000Z', completedAt: '2026-10-28T00:00:01.000Z', durationMs: 1000, result: 'local' };
    await writeRunHealth(c.privateDir, health);
    assert.deepEqual(await readRunHealth(c.privateDir), health);
    for (const value of [
        { ...health, body: 'PRIVATE_CANARY' },
        { ...health, result: 'PRIVATE_CANARY' },
        { ...health, startedAt: 'PRIVATE_CANARY' },
        { ...health, completedAt: null },
        { ...health, durationMs: -1 },
        { ...health, durationMs: 1.5 },
        { ...health, result: 'processing' },
        { ...health, completedAt: '2026-10-27T00:00:00.000Z' },
    ]) await assert.rejects(writeRunHealth(c.privateDir, value as RunHealth), { message: 'invalid_run_health' });
    assert.equal((await readFile(join(c.privateDir, 'run-health.json'), 'utf8')).includes('PRIVATE_CANARY'), false);
    await writeFile(join(c.privateDir, 'run-health.json'), '{"body":"PRIVATE_CANARY"}');
    const after = await status(path);
    assert.equal(after.lastRun, null);
    assert.equal(after.runHealthError, 'unavailable');
    assert.equal(JSON.stringify(after).includes('PRIVATE_CANARY'), false);
});

test('watcher status distinguishes fresh heartbeat, stale lock and absent worker evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-heartbeat-'));
    const lock = join(root, 'watcher.lock');
    assert.deepEqual(await readWatcherStatus(root), { state: 'stopped', heartbeatAt: null });
    await mkdir(lock);
    assert.equal((await readWatcherStatus(root)).state, 'active');
    const old = new Date(Date.now() - 121000);
    await utimes(lock, old, old);
    assert.deepEqual(await readWatcherStatus(root), { state: 'stale', heartbeatAt: old.toISOString() });
});

test('a sync publishes processing diagnostics before Git work, then records completion and drains fixed-field events', async () => {
    const { c, path } = await fixture();
    await enqueue(c.privateDir, { eventId: 'a'.repeat(64), turnKey: 'b'.repeat(64), source: 'codex', recordedAt: '2026-10-28T00:00:00.000Z', kind: 'classification', progress: { category: 'verification', status: 'in_progress' } });
    assert.equal((await status(path)).oldestQueuedAt, '2026-10-28T00:00:00.000Z');
    const native = childProcess.execFile;
    let releaseGit!: () => void, seenGit!: () => void;
    const reachedGit = new Promise<void>(resolve => { seenGit = resolve; });
    let held = false;
    (childProcess as any).execFile = (...args: any[]) => {
        if (!held) {
            held = true;
            releaseGit = () => (native as any)(...args);
            seenGit();
            return {};
        }
        return (native as any)(...args);
    };
    syncBuiltinESMExports();
    const lines: string[] = [];
    const sync = runCli(['sync', '--config', path], undefined, line => lines.push(line));
    try {
        await reachedGit;
        const during = await status(path);
        assert.equal(during.lastRun.result, 'processing');
        assert.equal(during.lastRun.completedAt, null);
        releaseGit();
        assert.equal(await sync, 0);
        assert.deepEqual(lines, ['local']);
        assert.equal((await readEvents(c.privateDir)).length, 0);
        const after = await status(path);
        assert.equal(after.lastRun.result, 'local');
        assert.ok(after.lastRun.durationMs >= 0);
        assert.ok(after.lastRun.completedAt >= after.lastRun.startedAt);
        assert.equal(after.oldestQueuedAt, null);
        assert.match(await readFile(join(c.gitDir, 'WORKLOG.md'), 'utf8'), /验证/);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('unwritable diagnostics warn without losing progress or hiding the sync result', async () => {
    const { c, path } = await fixture();
    await mkdir(join(c.privateDir, 'run-health.json'));
    await enqueue(c.privateDir, { eventId: 'c'.repeat(64), turnKey: 'd'.repeat(64), source: 'claude', recordedAt: '2026-10-28T01:00:00.000Z', kind: 'classification', progress: { category: 'implementation', status: 'ai_reported_done' } });
    const lines: string[] = [];
    assert.equal(await runCli(['sync', '--config', path], undefined, line => lines.push(line)), 0);
    assert.equal(lines.at(-1), 'local');
    assert.ok(lines.includes('diagnostics_unavailable'));
    assert.equal((await readEvents(c.privateDir)).length, 0);
    assert.match(await readFile(join(c.gitDir, 'WORKLOG.md'), 'utf8'), /AI报告完成/);
    assert.equal((await status(path)).runHealthError, 'unavailable');
});

test('diagnostic warnings do not turn a failed core operation into success', async () => {
    const { c, path } = await fixture();
    await mkdir(join(c.privateDir, 'run-health.json'));
    const release = await lockfile.lock(join(c.privateDir, 'publisher'), { realpath: false });
    try {
        const lines: string[] = [];
        assert.equal(await runCli(['sync', '--config', path], undefined, line => lines.push(line)), 1);
        assert.ok(lines.includes('diagnostics_unavailable'));
        assert.deepEqual(JSON.parse(lines.at(-1)!), { errorCode: 'operation_failed' });
    } finally {
        await release();
    }
});
