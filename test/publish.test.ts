import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeLocalRepository, commitWorklog } from '../src/transport.js';
import { enqueue, readEvents, readState, withWriterLock, writeIntent } from '../src/store.js';
import { handleCommandHook } from '../src/capture.js';
import { appendRows, type Config, type LocalEvent } from '../src/schema.js';
import { processOnce, preview, previewTargets } from '../src/publish.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-publish-'));
    const c: Config = { privateDir: join(root, 'private'), gitDir: join(root, 'repo'), remoteUrl: 'https://example.invalid/log.git', branch: 'worklog', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' };
    await initializeLocalRepository(c);
    return c;
}
function event(id: number, turn = 1, category: 'implementation' | 'none' = 'implementation'): LocalEvent {
    return { eventId: id.toString(16).padStart(64, '0'), turnKey: turn.toString(16).padStart(64, '0'), source: 'codex', recordedAt: `2026-10-09T00:00:${String(id).padStart(2, '0')}.000Z`, kind: 'classification', progress: category === 'none' ? { category, status: 'unknown' } : { category, status: 'in_progress' } };
}
test('local publishes actual commits and deduplicates per turn while preserving prior public progress', async () => {
    const c = await fixture();
    for (const e of [event(1), event(2, 1, 'none'), event(3), event(4, 2)])
        await enqueue(c.privateDir, e);
    assert.equal(await processOnce(c), 'local');
    const s = await preview(c);
    assert.equal(s.commits.length, 1);
    assert.equal(s.commits[0].worklog.split('| 实现 |').length - 1, 2);
    assert.match(s.commits[0].worklog, /\| 1 commit! smart! \|\n\| 2026-10-09 00:00:04 \| 实现 \| 进行中 \| 2 commit! smart! \|\n$/);
    assert.equal((await readEvents(c.privateDir)).length, 0);
    assert.equal(await processOnce(c), 'idle');
    assert.equal((await preview(c)).targetOid, s.targetOid);
});
test('recovers committed intent without duplicate commit or row', async () => {
    const c = await fixture();
    const e = event(1);
    await enqueue(c.privateDir, e);
    const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
    const after = appendRows('', [row]);
    await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead: null, beforeHash: hash(''), afterHash: hash(after), rows: [row] });
    await writeFile(join(c.gitDir, 'WORKLOG.md'), after);
    const oid = await commitWorklog(c, hash(after));
    await processOnce(c);
    assert.equal((await preview(c)).targetOid, oid);
    assert.deepEqual((await readState(c.privateDir)).processedIds, [e.eventId]);
    assert.equal((await readEvents(c.privateDir)).length, 0);
});
test('upgrade recovers a legacy ISO intent before file write and uses new display for later events', async () => {
    const c = await fixture();
    const before = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n| 2026-10-09T00:00:01.000Z | 实现 | 进行中 |\n';
    await writeFile(join(c.gitDir, 'WORKLOG.md'), before);
    const baseHead = await commitWorklog(c, hash(before));
    const e = event(2, 2);
    const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
    const after = before + '| 2026-10-09T00:00:02.000Z | 实现 | 进行中 |\n';
    await enqueue(c.privateDir, e);
    await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead, beforeHash: hash(before), afterHash: hash(after), rows: [row] });
    assert.equal(await processOnce(c), 'local');
    const recovered = await preview(c);
    assert.equal(recovered.commits.length, 2);
    assert.equal(recovered.commits[1].worklog, after);
    assert.deepEqual((await readState(c.privateDir)).processedIds, [e.eventId]);
    assert.equal((await readEvents(c.privateDir)).length, 0);
    assert.equal(await processOnce(c), 'idle');
    assert.equal((await preview(c)).targetOid, recovered.targetOid);
    await enqueue(c.privateDir, event(3, 3));
    assert.equal(await processOnce(c), 'local');
    const updated = await preview(c);
    assert.equal(updated.commits.length, 3);
    assert.equal(updated.commits[2].worklog, '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
        '| 2026-10-09T00:00:01.000Z | 实现 | 进行中 | 1 commit! smart! |\n' +
        '| 2026-10-09T00:00:02.000Z | 实现 | 进行中 | 2 commit! smart! |\n' +
        '| 2026-10-09 00:00:03 | 实现 | 进行中 | 3 commit! smart! |\n');
});

test('recovers old three-column display intent exactly before the next append migrates its rows', async () => {
    const c = await fixture();
    const before = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n| 2026-10-09 00:00:01 | 实现 | 进行中 |\n';
    await writeFile(join(c.gitDir, 'WORKLOG.md'), before);
    const baseHead = await commitWorklog(c, hash(before));
    const e = event(2, 2);
    const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
    const after = before + '| 2026-10-09 00:00:02 | 实现 | 进行中 |\n';
    await enqueue(c.privateDir, e);
    await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead, beforeHash: hash(before), afterHash: hash(after), rows: [row] });
    assert.equal(await processOnce(c), 'local');
    const recovered = await preview(c);
    assert.equal(recovered.commits[1].worklog, after);
    assert.equal(await processOnce(c), 'idle');
    assert.equal((await preview(c)).targetOid, recovered.targetOid);
    await enqueue(c.privateDir, event(3, 3));
    assert.equal(await processOnce(c), 'local');
    const updated = await preview(c);
    assert.equal(updated.commits.length, 3);
    assert.equal(updated.commits[0].worklog, before);
    assert.equal(updated.commits[1].worklog, after);
    assert.equal(updated.commits[2].worklog, '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
        '| 2026-10-09 00:00:01 | 实现 | 进行中 | 1 commit! smart! |\n' +
        '| 2026-10-09 00:00:02 | 实现 | 进行中 | 2 commit! smart! |\n' +
        '| 2026-10-09 00:00:03 | 实现 | 进行中 | 3 commit! smart! |\n');
    assert.equal((await readEvents(c.privateDir)).length, 0);
});

test('old bar intents recover approved bytes before write and the next append upgrades to badges', async () => {
    const plain = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n';
    const header = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n';
    const firstIso = '| 2026-10-09T00:00:01.000Z | 实现 | 进行中 |';
    const firstDisplay = '| 2026-10-09 00:00:01 | 实现 | 进行中 |';
    const cases = [
        { before: '', id: 1, after: header + firstDisplay + ' ■ 1 commit！ |\n', badges: header + firstDisplay + ' 1 commit! smart! |\n| 2026-10-09 00:00:02 | 实现 | 进行中 | 2 commit! smart! |\n' },
        { before: plain + firstIso + '\n', id: 2, after: header + firstIso + ' ■ 1 commit！ |\n| 2026-10-09 00:00:02 | 实现 | 进行中 | ■■ 2 commit！ |\n', badges: header + firstIso + ' 1 commit! smart! |\n| 2026-10-09 00:00:02 | 实现 | 进行中 | 2 commit! smart! |\n| 2026-10-09 00:00:03 | 实现 | 进行中 | 3 commit! smart! |\n' },
        { before: header + firstDisplay + ' ■ 1 commit！ |\n', id: 2, after: header + firstDisplay + ' ■ 1 commit！ |\n| 2026-10-09 00:00:02 | 实现 | 进行中 | ■■ 2 commit！ |\n', badges: header + firstDisplay + ' 1 commit! smart! |\n| 2026-10-09 00:00:02 | 实现 | 进行中 | 2 commit! smart! |\n| 2026-10-09 00:00:03 | 实现 | 进行中 | 3 commit! smart! |\n' }
    ];
    for (const { before, id, after, badges } of cases) {
        const c = await fixture();
        let baseHead: string | null = null;
        if (before) {
            await writeFile(join(c.gitDir, 'WORKLOG.md'), before);
            baseHead = await commitWorklog(c, hash(before));
        }
        const e = event(id, id);
        const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
        await enqueue(c.privateDir, e);
        await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead, beforeHash: hash(before), afterHash: hash(after), rows: [row] });
        assert.equal(await processOnce(c), 'local');
        const recovered = await preview(c);
        assert.equal(recovered.commits.at(-1)!.worklog, after);
        assert.deepEqual((await readState(c.privateDir)).processedIds, [e.eventId]);
        assert.equal((await readEvents(c.privateDir)).length, 0);
        assert.equal(await processOnce(c), 'idle');
        assert.equal((await preview(c)).targetOid, recovered.targetOid);
        await enqueue(c.privateDir, event(id + 1, id + 1));
        assert.equal(await processOnce(c), 'local');
        const updated = await preview(c);
        assert.equal(updated.commits.length, recovered.commits.length + 1);
        assert.equal(updated.commits.at(-2)!.worklog, after);
        assert.equal(updated.commits.at(-1)!.worklog, badges);
        if (before) assert.equal(updated.commits[0].worklog, before);
    }
});

test('badge intent with mismatched approved hash leaves the committed file and queue untouched', async () => {
    const c = await fixture();
    const header = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n';
    const before = header + '| 2026-10-09 00:00:01 | 实现 | 进行中 | 1 commit! smart! |\n';
    await writeFile(join(c.gitDir, 'WORKLOG.md'), before);
    const baseHead = await commitWorklog(c, hash(before));
    const e = event(2, 2);
    const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
    const mismatched = before + '| 2026-10-09 00:00:02 | 方案 | 进行中 | 2 commit! smart! |\n';
    await enqueue(c.privateDir, e);
    await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead, beforeHash: hash(before), afterHash: hash(mismatched), rows: [row] });
    assert.equal(await processOnce(c), 'paused');
    assert.equal((await readState(c.privateDir)).errorCode, 'invalid_content');
    assert.equal(await readFile(join(c.gitDir, 'WORKLOG.md'), 'utf8'), before);
    assert.equal((await readEvents(c.privateDir)).length, 1);
    assert.equal(JSON.parse(await readFile(join(c.privateDir, 'intent.json'), 'utf8')).afterHash, hash(mismatched));
});

test('legacy intent recovery still rejects content that does not match its durable hash', async () => {
    const c = await fixture();
    const e = event(1);
    const row = { time: e.recordedAt, category: 'implementation' as const, status: 'in_progress' as const };
    const mismatched = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n| 2026-10-09T00:00:01.000Z | 方案 | 进行中 |\n';
    await enqueue(c.privateDir, e);
    await writeIntent(c.privateDir, { eventIds: [e.eventId], baseHead: null, beforeHash: hash(''), afterHash: hash(mismatched), rows: [row] });
    assert.equal(await processOnce(c), 'paused');
    assert.equal((await readState(c.privateDir)).errorCode, 'invalid_content');
    await assert.rejects(readFile(join(c.gitDir, 'WORKLOG.md')), { code: 'ENOENT' });
    assert.equal((await readEvents(c.privateDir)).length, 1);
});

test('capture completes while publisher lock is held', async () => {
    const c = await fixture();
    await withWriterLock(c.privateDir, async () => {
        async function* input() {
            yield Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't' }));
        }
        const output = await handleCommandHook('codex', c, input()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
        assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
        assert.match(output.hookSpecificOutput.additionalContext, /mcp__whativedone__classify_progress/);
        assert.equal((await readEvents(c.privateDir)).length,1);
    });
});
test('classification rejects invalid and mismatched model input', async () => {
    const c = await fixture();
    for (const tool_input of [{ category: 'implementation', status: 'in_progress', secret: 'CANARY' }, { category: 'research', status: 'in_progress' }]) {
        async function* input() {
            yield Buffer.from(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', tool_use_id: 'c', tool_name: 'mcp__whativedone__classify_progress', tool_input, tool_response: { structuredContent: { category: 'implementation', status: 'in_progress' } } }));
        }
        assert.deepEqual(await handleCommandHook('codex', c, input()), { systemMessage: 'WhatIveDone: invalid_hook' });
    }
    assert.equal((await readEvents(c.privateDir)).length, 0);
});
test('preview does not treat corrupted configuration as an empty repo', async () => {
    const c = await fixture();
    await writeFile(join(c.gitDir, '.git', 'config'), '[include]\npath = arbitrary\n');
    await assert.rejects(preview(c));
});
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { enableSync } from '../src/publish.js';
test('local never executes network; auto recovers acknowledged-lost push without another commit and unknown remote pauses', async () => {
    const c = await fixture();
    const native = childProcess.execFile;
    let remote = '';
    let pushes = 0;
    let checks = 0;
    let loseAck = true;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            checks++;
            queueMicrotask(() => cb(null, Buffer.from(remote), Buffer.alloc(0)));
            return {};
        }
        if (args.includes('push')) {
            pushes++;
            remote = args.at(-1)!.split(':')[0] + '\trefs/heads/worklog\n';
            queueMicrotask(() => cb(loseAck ? new Error('network') : null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await enqueue(c.privateDir, event(1));
        assert.equal(await processOnce(c), 'local');
        assert.equal(checks, 0);
        assert.equal(pushes, 0);
        const oid = (await preview(c)).targetOid;
        remote = 'f'.repeat(40) + '\trefs/heads/other\n';
        await assert.rejects(enableSync(c));
        assert.equal(c.mode, 'local');
        remote = '';
        await enableSync(c);
        assert.equal(c.mode, 'auto');
        assert.equal(await processOnce(c), 'pending');
        assert.equal(pushes, 1);
        assert.equal(await processOnce(c), 'idle');
        assert.equal(pushes, 1);
        assert.equal((await preview(c)).targetOid, oid);
        assert.equal((await readState(c.privateDir)).remoteOid, oid);
        remote = 'f'.repeat(40) + '\trefs/heads/worklog\n';
        await enqueue(c.privateDir, event(2, 2));
        assert.equal(await processOnce(c), 'paused');
        assert.equal(pushes, 1);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
test('intent/file/checkpoint interruptions recover without extra rows or commits', async () => {
    for (const phase of ['intent', 'file', 'checkpoint']) {
        const c = await fixture();
        await enqueue(c.privateDir, event(1));
        await processOnce(c);
        const prefix = await readFile(join(c.gitDir, 'WORKLOG.md'), 'utf8');
        await enqueue(c.privateDir, event(2, 2));
        const nativeRename = fs.rename;
        let tripped = false;
        (fs as any).rename = async (from: string, to: string) => {
            if (!tripped && (phase === 'intent' && to.endsWith('intent.json') || phase === 'file' && to.endsWith('WORKLOG.md') || phase === 'checkpoint' && to.endsWith('state.json'))) {
                tripped = true;
                await nativeRename(from, to);
                throw new Error('interrupted');
            }
            return nativeRename(from, to);
        };
        syncBuiltinESMExports();
        try {
            assert.equal(await processOnce(c), 'pending');
        }
        finally {
            fs.rename = nativeRename;
            syncBuiltinESMExports();
        }
        await processOnce(c);
        const snapshot = await preview(c);
        assert.equal(snapshot.commits.length, 2);
        assert.equal(snapshot.commits[1].worklog.split('| 实现 |').length - 1, 2);
        assert.ok(snapshot.commits[1].worklog.startsWith(prefix));
        assert.equal((await readEvents(c.privateDir)).length, 0);
    }
});
test('late start does not erase classification, preview counts unprocessed queue without committing', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const first = (await preview(c)).targetOid;
    const { progress, ...late } = event(2) as Extract<LocalEvent, {
        kind: 'classification';
    }>;
    await enqueue(c.privateDir, { ...late, kind: 'start' });
    await enqueue(c.privateDir, event(3));
    const s = await preview(c);
    assert.equal(s.queuedCount, 2);
    assert.equal(s.targetOid, first);
    await processOnce(c);
    assert.equal((await preview(c)).targetOid, first);
    assert.equal((await readState(c.privateDir)).classifiedTurns.length, 1);
});
import { writeState } from '../src/store.js';
import { runCli } from '../src/cli.js';
test('unchanged fully synced ticks skip audit and network including replay and diagnostics', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const state = await readState(c.privateDir);
    state.remoteOid = (await preview(c)).targetOid;
    state.remoteCheckedAt = '2026-10-09T00:00:00.000Z';
    await writeState(c.privateDir, state);
    c.mode = 'auto';
    const native = childProcess.execFile;
    const costly: string[][] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.some(arg => ['rev-list', 'cat-file', 'ls-tree', 'diff-tree', 'ls-remote', 'push'].includes(arg)))
            costly.push(args);
        if (args.includes('ls-remote')) {
            queueMicrotask(() => cb(null, Buffer.from(`${state.remoteOid}\trefs/heads/worklog\n`), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await processOnce(c), 'idle');
        await enqueue(c.privateDir, event(1));
        assert.equal(await processOnce(c), 'idle');
        const { progress, ...diagnostic } = event(2) as Extract<LocalEvent, {
            kind: 'classification';
        }>;
        await enqueue(c.privateDir, { ...diagnostic, kind: 'stop' });
        assert.equal(await processOnce(c), 'idle');
        assert.equal(costly.length, 0);
        assert.equal((await readEvents(c.privateDir)).length, 0);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
test('local no-HEAD and diagnostics-only ticks execute no Git', async () => {
    const c = await fixture();
    const native = childProcess.execFile;
    let calls = 0;
    (childProcess as any).execFile = (...args: any[]) => {
        calls++;
        return (native as any)(...args);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await processOnce(c), 'idle');
        await enqueue(c.privateDir, event(1, 1, 'none'));
        assert.equal(await processOnce(c), 'idle');
        assert.equal(calls, 0);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
test('successful idle remote retry clears transient sync failure', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const oid = (await preview(c)).targetOid;
    const state = await readState(c.privateDir);
    state.errorCode = 'sync_failed';
    await writeState(c.privateDir, state);
    c.mode = 'auto';
    const native = childProcess.execFile;
    let networkChecks = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            networkChecks++;
            queueMicrotask(() => cb(null, Buffer.from(`${oid}\trefs/heads/worklog\n`), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await processOnce(c), 'idle');
        assert.equal((await readState(c.privateDir)).errorCode, undefined);
        assert.equal(networkChecks, 1);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
test('resume revalidates repaired local policy and still blocks invalid history', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const configPath = join(c.privateDir, 'config.json');
    await writeFile(configPath, JSON.stringify(c));
    const state = await readState(c.privateDir);
    state.errorCode = 'invalid_history';
    await writeState(c.privateDir, state);
    const gitConfig = join(c.gitDir, '.git', 'config');
    const original = await readFile(gitConfig, 'utf8');
    await writeFile(gitConfig, original + '\n[include]\npath = nope\n');
    const lines: string[] = [];
    assert.equal(await runCli(['resume', '--config', configPath], undefined, line => lines.push(line)), 1);
    assert.equal(await processOnce(c), 'paused');
    await writeFile(gitConfig, original);
    assert.equal(await runCli(['resume', '--config', configPath], undefined, line => lines.push(line)), 0);
    assert.equal(await processOnce(c), 'idle');
    assert.equal((await readState(c.privateDir)).errorCode, undefined);
});
test('auto resume cannot take idle shortcut until remote policy is revalidated', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const oid = (await preview(c)).targetOid;
    c.mode = 'auto';
    const configPath = join(c.privateDir, 'config.json');
    await writeFile(configPath, JSON.stringify(c));
    const state = await readState(c.privateDir);
    state.remoteOid = oid;
    state.remoteCheckedAt = '2026-10-09T00:00:00.000Z';
    state.errorCode = 'invalid_history';
    await writeState(c.privateDir, state);
    const native = childProcess.execFile;
    let remote = 'f'.repeat(40), checks = 0, pushes = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('push'))
            pushes++;
        if (args.includes('ls-remote')) {
            checks++;
            queueMicrotask(() => cb(null, Buffer.from(`${remote}\trefs/heads/worklog\n`), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await runCli(['resume', '--config', configPath], undefined, () => {
        }), 0);
        assert.equal(await processOnce(c), 'paused');
        assert.equal(checks, 1);
        assert.equal(pushes, 0);
        remote = oid;
        assert.equal(await runCli(['resume', '--config', configPath], undefined, () => {
        }), 0);
        assert.equal(await processOnce(c), 'idle');
        assert.equal(checks, 2);
        assert.equal((await readState(c.privateDir)).errorCode, undefined);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('dual destinations retry independently while local capture and the healthy destination continue', async () => {
    const c = await fixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    const native = childProcess.execFile;
    const remotes = new Map([[c.remoteUrl, ''], [c.mirrorUrl, '']]);
    const pushes: string[] = [];
    const checks: string[] = [];
    let offline = '';
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            const url = args.find(arg => remotes.has(arg))!;
            if (args.includes('ls-remote')) {
                checks.push(url);
                queueMicrotask(() => cb(url === offline ? new Error('offline') : null, Buffer.from(remotes.get(url)!), Buffer.alloc(0)));
            }
            else {
                pushes.push(url);
                remotes.set(url, args.at(-1)!.split(':')[0] + '\trefs/heads/worklog\n');
                queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            }
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await enqueue(c.privateDir, event(1));
        assert.equal(await processOnce(c), 'local');
        assert.equal(checks.length, 0);
        await enableSync(c);
        offline = c.remoteUrl;
        assert.equal(await processOnce(c), 'pending');
        assert.deepEqual(pushes, [c.mirrorUrl]);
        await enqueue(c.privateDir, event(2, 2));
        assert.equal(await processOnce(c), 'pending');
        assert.deepEqual(pushes, [c.mirrorUrl, c.mirrorUrl]);
        assert.equal((await readEvents(c.privateDir)).length, 0);
        const state = await readState(c.privateDir);
        assert.equal(state.errorCode, undefined);
        assert.equal(state.primaryErrorCode, 'sync_failed');
        assert.equal(state.mirror?.remoteOid, remotes.get(c.mirrorUrl)!.split('\t')[0]);
        const mirrorChecks = checks.filter(url => url === c.mirrorUrl).length;
        offline = '';
        assert.equal(await processOnce(c), 'synced');
        assert.deepEqual(pushes, [c.mirrorUrl, c.mirrorUrl, c.remoteUrl]);
        assert.equal(checks.filter(url => url === c.mirrorUrl).length, mirrorChecks);
        assert.equal(remotes.get(c.remoteUrl), remotes.get(c.mirrorUrl));
        assert.equal(await processOnce(c), 'idle');
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('a mirror conflict pauses only that destination and a changed mirror binding never sends', async () => {
    const c = await fixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    const native = childProcess.execFile;
    const remotes = new Map([[c.remoteUrl, ''], [c.mirrorUrl, '']]);
    const calls: string[] = [];
    let audits = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('rev-list'))
            audits++;
        if (args.includes('ls-remote') || args.includes('push')) {
            const url = args.find(arg => arg.startsWith('https://'))!;
            calls.push(url);
            if (args.includes('push'))
                remotes.set(url, args.at(-1)!.split(':')[0] + '\trefs/heads/worklog\n');
            queueMicrotask(() => cb(null, Buffer.from(args.includes('ls-remote') ? remotes.get(url) || '' : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await enqueue(c.privateDir, event(1));
        await processOnce(c);
        await enableSync(c);
        const firstMirror = c.mirrorUrl;
        remotes.set(firstMirror, 'f'.repeat(40) + '\trefs/heads/worklog\n');
        assert.equal(await processOnce(c), 'paused');
        assert.notEqual(remotes.get(c.remoteUrl), '');
        const mirrorCalls = calls.filter(url => url === firstMirror).length;
        const priorAudits = audits;
        assert.equal(await processOnce(c), 'paused');
        assert.equal(audits, priorAudits);
        await enqueue(c.privateDir, event(2, 2));
        assert.equal(await processOnce(c), 'paused');
        assert.equal(calls.filter(url => url === firstMirror).length, mirrorCalls);
        assert.equal((await readEvents(c.privateDir)).length, 0);
        c.mirrorUrl = 'https://changed.invalid/log.git';
        await enqueue(c.privateDir, event(3, 3));
        assert.equal(await processOnce(c), 'paused');
        assert.equal(calls.includes(c.mirrorUrl), false);
        const state = await readState(c.privateDir);
        assert.equal(state.errorCode, undefined);
        assert.equal(state.mirror?.remoteUrl, firstMirror);
        assert.equal(state.mirror?.errorCode, 'destination_changed');
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('lost mirror acknowledgement is recovered without repeating the healthy primary push', async () => {
    const c = await fixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    const native = childProcess.execFile;
    const remotes = new Map([[c.remoteUrl, ''], [c.mirrorUrl, '']]);
    const pushes: string[] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            const url = args.find(arg => remotes.has(arg))!;
            if (args.includes('push')) {
                pushes.push(url);
                remotes.set(url, args.at(-1)!.split(':')[0] + '\trefs/heads/worklog\n');
            }
            queueMicrotask(() => cb(args.includes('push') && url === c.mirrorUrl ? new Error('acknowledgement lost') : null, Buffer.from(args.includes('ls-remote') ? remotes.get(url)! : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await enqueue(c.privateDir, event(1));
        await processOnce(c);
        await enableSync(c);
        assert.equal(await processOnce(c), 'pending');
        assert.deepEqual(pushes, [c.remoteUrl, c.mirrorUrl]);
        assert.equal(await processOnce(c), 'idle');
        assert.deepEqual(pushes, [c.remoteUrl, c.mirrorUrl]);
        const state = await readState(c.privateDir);
        assert.equal(state.remoteOid, state.mirror?.remoteOid);
        assert.equal(state.mirror?.errorCode, undefined);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('enabling dual sync commits no checkpoints or mode when the second destination is not empty', async () => {
    const c = await fixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    const native = childProcess.execFile;
    let networkCalls = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            networkCalls++;
            const output = args.includes(c.mirrorUrl!) ? 'f'.repeat(40) + '\trefs/heads/worklog\n' : '';
            queueMicrotask(() => cb(null, Buffer.from(output), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const before = await readState(c.privateDir);
        await assert.rejects(enableSync(c));
        assert.equal(c.mode, 'local');
        assert.equal(networkCalls, 2);
        assert.deepEqual(await readState(c.privateDir), before);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('dual preview preserves the empty-history response', async () => {
    const c = await fixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    await assert.rejects(previewTargets(c), { message: 'empty_history' });
});

test('resume cannot authorize an unbound mirror; only enable establishes its approved binding', async () => {
    const c = await fixture();
    await enqueue(c.privateDir, event(1));
    await processOnce(c);
    const firstOid = (await preview(c)).targetOid;
    const state = await readState(c.privateDir);
    state.remoteOid = firstOid;
    state.remoteCheckedAt = '2026-10-09T00:00:00.000Z';
    await writeState(c.privateDir, state);
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    c.mode = 'auto';
    const configPath = join(c.privateDir, 'config.json');
    await writeFile(configPath, JSON.stringify(c));
    const native = childProcess.execFile;
    const remotes = new Map([[c.remoteUrl, firstOid + '\trefs/heads/worklog\n'], [c.mirrorUrl, '']]);
    const calls: string[] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            const url = args.find(arg => remotes.has(arg))!;
            calls.push(url);
            if (args.includes('push'))
                remotes.set(url, args.at(-1)!.split(':')[0] + '\trefs/heads/worklog\n');
            queueMicrotask(() => cb(null, Buffer.from(args.includes('ls-remote') ? remotes.get(url)! : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await enqueue(c.privateDir, event(2, 2));
        assert.equal(await processOnce(c), 'paused');
        assert.equal(calls.includes(c.mirrorUrl), false);
        assert.equal(await runCli(['resume', '--config', configPath], undefined, () => {}), 0);
        await enqueue(c.privateDir, event(3, 3));
        assert.equal(await processOnce(c), 'paused');
        assert.equal(calls.includes(c.mirrorUrl), false);
        assert.equal((await readState(c.privateDir)).mirror, undefined);
        assert.equal((await readEvents(c.privateDir)).length, 0);
        assert.equal((await readState(c.privateDir)).remoteOid, remotes.get(c.remoteUrl)!.split('\t')[0]);
        // Both doubled destinations are empty again for the explicit enable checks.
        remotes.set(c.remoteUrl, '');
        await enableSync(c);
        assert.equal((await readState(c.privateDir)).mirror?.remoteUrl, c.mirrorUrl);
        assert.equal(await processOnce(c), 'synced');
        assert.equal(calls.includes(c.mirrorUrl), true);
        assert.equal(remotes.get(c.remoteUrl), remotes.get(c.mirrorUrl));
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
