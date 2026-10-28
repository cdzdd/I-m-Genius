import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initializeLocalRepository, commitWorklog, readSnapshot, checkSnapshot, checkEmptyRemote, refreshRemote, pushSnapshot, registerClientMcp, manageStartup } from '../src/transport.js';
import { type Config } from '../src/schema.js';
import { readState } from '../src/store.js';
// Legacy fixtures keep the old history audit meaningful after the display upgrade.
const WORKLOG_HEADER = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n';
const row = '| 2026-10-09T00:00:00.000Z | 实现 | 进行中 |\n';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-transport-'));
    const config: Config = {
        privateDir: join(root, 'private'), gitDir: join(root, 'repo'), remoteUrl: 'https://example.invalid/log.git', branch: 'worklog', authorName: 'WhatIveDone', authorEmail: 'worklog@example.invalid', captureEnabled: true, mode: 'local'
    };
    await initializeLocalRepository(config);
    return config;
}
function git(c: Config, ...args: string[]) {
    return execFileSync('C:/Program Files/Git/cmd/git.exe', ['-C', c.gitDir, ...args], { encoding: 'utf8', windowsHide: true, env: {
            ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: c.authorName, GIT_AUTHOR_EMAIL: c.authorEmail, GIT_COMMITTER_NAME: c.authorName, GIT_COMMITTER_EMAIL: c.authorEmail, GIT_AUTHOR_DATE: '1791504000 +0000', GIT_COMMITTER_DATE: '1791504000 +0000'
        } }).trim();
}
async function append(c: Config, s = WORKLOG_HEADER + row) {
    await writeFile(join(c.gitDir, 'WORKLOG.md'), s);
    return commitWorklog(c, hash(s));
}
test('snapshot is actual offline history including patches and baseline time', async () => {
    const c = await fixture();
    const a = await append(c);
    const b = await append(c, WORKLOG_HEADER + row + row);
    const state = await readState(c.privateDir);
    const s = await readSnapshot(c, state, 3);
    assert.equal(s.targetOid, b);
    assert.equal(s.commits.length, 2);
    assert.equal(s.commits[0].oid, a);
    assert.deepEqual(s.commits[1].parents, [a]);
    assert.match(s.commits[0].patch, /\+\| 2026/);
    assert.equal(s.baselineCheckedAt, null);
    assert.equal(s.queuedCount, 3);
    assert.deepEqual(checkSnapshot(c, s), { ok: true });
});
const progressHeader = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n';
const legacySecond = '| 2026-10-09 00:00:01 | 验证 | AI报告完成 |\n';
const upgradedRows = '| 2026-10-09T00:00:00.000Z | 实现 | 进行中 | ■ 1 commit！ |\n'
    + '| 2026-10-09 00:00:01 | 验证 | AI报告完成 | ■■ 2 commit！ |\n';
const nextDay = '| 2026-10-10 00:00:00 | 实现 | 进行中 | ■ 1 commit！ |\n';
// Rejecting every header change would block the exact approved display migration.
test('native history and preview allow only deterministic legacy progress upgrade plus append', async () => {
    const c = await fixture();
    const first = await append(c);
    const second = await append(c, WORKLOG_HEADER + row + legacySecond);
    const next = progressHeader + upgradedRows + nextDay;
    const third = await append(c, next);
    const state = await readState(c.privateDir);
    const snapshot = await readSnapshot(c, state, 0);
    assert.equal(snapshot.targetOid, third);
    assert.deepEqual(snapshot.commits.map(x => x.oid), [first, second, third]);
    assert.equal(snapshot.commits[1].worklog, WORKLOG_HEADER + row + legacySecond);
    assert.equal(snapshot.commits[2].worklog, next);
    assert.match(snapshot.commits[2].patch, /\+\| 时间（UTC） \| 类别 \| 状态 \| 进度 \|/);
    assert.deepEqual(checkSnapshot(c, snapshot), { ok: true });
    const pending = await readSnapshot(c, { ...state, remoteOid: second }, 0);
    assert.deepEqual(checkSnapshot(c, pending), { ok: true });
});
const badgeRows = '| 2026-10-09T00:00:00.000Z | 实现 | 进行中 | 1 commit! smart! |\n'
    + '| 2026-10-09 00:00:01 | 验证 | AI报告完成 | 2 commit! smart! |\n';
const badgeNextDay = '| 2026-10-10 00:00:00 | 实现 | 进行中 | 1 commit! smart! |\n';
test('native history keeps old plain and bar commits while allowing exact badge upgrade', async () => {
    const c = await fixture();
    const first = await append(c);
    const plain = WORKLOG_HEADER + row + legacySecond;
    const second = await append(c, plain);
    const bars = progressHeader + upgradedRows;
    const third = await append(c, bars);
    const badges = progressHeader + badgeRows + badgeNextDay;
    const fourth = await append(c, badges);
    const state = await readState(c.privateDir);
    const snapshot = await readSnapshot(c, state, 0);
    assert.deepEqual(snapshot.commits.map(commit => commit.oid), [first, second, third, fourth]);
    assert.equal(snapshot.commits[1].worklog, plain);
    assert.equal(snapshot.commits[2].worklog, bars);
    assert.equal(snapshot.commits[3].worklog, badges);
    assert.deepEqual(checkSnapshot(c, snapshot), { ok: true });
    const pending = await readSnapshot(c, { ...state, remoteOid: third }, 0);
    assert.equal(pending.commits.length, 1);
    assert.deepEqual(checkSnapshot(c, pending), { ok: true });
});
// A display upgrade must never authorize changing or deleting earlier public facts.
test('commit audit and preview reject rewritten history and invalid progress migrations', async () => {
    const approved = progressHeader + upgradedRows;
    const cases = [
        { name: 'time', before: WORKLOG_HEADER + row + legacySecond, after: approved.replace('T00:00:00.000Z', 'T00:01:00.000Z') + nextDay },
        { name: 'status', before: WORKLOG_HEADER + row + legacySecond, after: approved.replace('实现 | 进行中', '实现 | 受阻') + nextDay },
        { name: 'drop', before: WORKLOG_HEADER + row + legacySecond, after: progressHeader + '| 2026-10-09 00:00:01 | 验证 | AI报告完成 | ■ 1 commit！ |\n' + nextDay },
        { name: 'count', before: WORKLOG_HEADER + row + legacySecond, after: approved.replace('■ 1 commit！', '■■ 2 commit！') + nextDay },
        { name: 'downgrade', before: approved, after: WORKLOG_HEADER + row + legacySecond + '| 2026-10-10 00:00:00 | 实现 | 进行中 |\n' }
    ];
    for (const { name, before, after } of cases) {
        const c = await fixture();
        const base = await append(c, before);
        const clean = await readSnapshot(c, await readState(c.privateDir), 0);
        await writeFile(join(c.gitDir, 'WORKLOG.md'), after);
        await assert.rejects(commitWorklog(c, hash(after)), /invalid_content/, name);
        const injected = { ...clean.commits[0], oid: 'f'.repeat(40), parents: [base], worklog: after };
        assert.deepEqual(checkSnapshot(c, { ...clean, targetOid: injected.oid, commits: [...clean.commits, injected] }), { ok: false, code: 'invalid_content' }, name);
        git(c, 'add', 'WORKLOG.md');
        git(c, 'commit', '-m', 'worklog: append progress');
        await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0), /invalid_content/, name);
    }
});
test('commit audit and preview reject changed facts and noncanonical badges or downgrades', async () => {
    const bars = progressHeader + upgradedRows;
    const badges = progressHeader + badgeRows;
    const cases = [
        { name: 'time', before: bars, after: badges.replace('T00:00:00.000Z', 'T00:01:00.000Z') + badgeNextDay },
        { name: 'status', before: bars, after: badges.replace('实现 | 进行中', '实现 | 受阻') + badgeNextDay },
        { name: 'drop', before: bars, after: progressHeader + '| 2026-10-09 00:00:01 | 验证 | AI报告完成 | 1 commit! smart! |\n' + badgeNextDay },
        { name: 'count', before: bars, after: badges.replace('2 commit! smart!', '3 commit! smart!') + badgeNextDay },
        { name: 'tier', before: bars, after: badges.replace('2 commit! smart!', '2 commit! clever!') + badgeNextDay },
        { name: 'mixed', before: bars, after: badges.replace('2 commit! smart!', '■■ 2 commit！') + badgeNextDay },
        { name: 'bar downgrade', before: badges, after: bars + nextDay },
        { name: 'plain downgrade', before: badges, after: WORKLOG_HEADER + row + legacySecond + '| 2026-10-10 00:00:00 | 实现 | 进行中 |\n' }
    ];
    for (const { name, before, after } of cases) {
        const c = await fixture();
        const base = await append(c, before);
        const clean = await readSnapshot(c, await readState(c.privateDir), 0);
        await writeFile(join(c.gitDir, 'WORKLOG.md'), after);
        await assert.rejects(commitWorklog(c, hash(after)), /invalid_content/, name);
        const injected = { ...clean.commits[0], oid: 'f'.repeat(40), parents: [base], worklog: after };
        assert.deepEqual(checkSnapshot(c, { ...clean, targetOid: injected.oid, commits: [...clean.commits, injected] }), { ok: false, code: 'invalid_content' }, name);
        git(c, 'add', 'WORKLOG.md');
        git(c, 'commit', '-m', 'worklog: append progress');
        await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0), /invalid_content/, name);
    }
});
test('hidden middle secret rejected despite clean HEAD', async () => {
    const c = await fixture();
    await append(c);
    await writeFile(join(c.gitDir, 'PRIVATE_CANARY'), 'secret');
    git(c, 'add', '.');
    git(c, 'commit', '-m', 'worklog: append progress');
    git(c, 'rm', 'PRIVATE_CANARY');
    git(c, 'commit', '-m', 'worklog: append progress');
    await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
});
test('hash mismatch never commits', async () => {
    const c = await fixture();
    await writeFile(join(c.gitDir, 'WORKLOG.md'), WORKLOG_HEADER + row);
    await assert.rejects(commitWorklog(c, '0'.repeat(64)));
    assert.equal(git(c, 'status', '--porcelain'), '?? WORKLOG.md');
});
test('rejects changed destination, arbitrary local configuration and alternate objects', async () => {
    for (const args of [['remote.origin.pushurl', 'https://evil.invalid/x'], ['url.https://evil.invalid/.insteadOf', 'https://'], ['core.hooksPath', 'elsewhere']]) {
        const c = await fixture();
        await append(c);
        git(c, 'config', ...args);
        await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
    }
    const c = await fixture();
    await append(c);
    await mkdir(join(c.gitDir, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(c.gitDir, '.git', 'objects', 'info', 'alternates'), 'elsewhere');
    await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
});
test('invalid URLs and client/startup arguments fail before effects', async () => {
    const c = await fixture();
    for (const remoteUrl of ['http://example.invalid/x', 'https://user:pass@example.invalid/x', 'https://example.invalid/x?secret'])
        await assert.rejects(checkEmptyRemote({ ...c, remoteUrl }));
    await assert.rejects(registerClientMcp('codex', 'relative.js'));
    await assert.rejects(manageStartup('install', 'relative.js'));
});
test('all fixed network APIs reject unsafe repository before network', async () => {
    const c = await fixture();
    await append(c);
    const s = await readSnapshot(c, await readState(c.privateDir), 0);
    git(c, 'config', 'remote.origin.pushurl', 'https://evil.invalid/x');
    await assert.rejects(refreshRemote(c));
    await assert.rejects(pushSnapshot(c, s));
});
// A caller cannot send a valid snapshot to an undeclared third repository.
test('dual target APIs reject undeclared and unsafe mirror destinations before network', async () => {
    const primary = await fixture();
    await append(primary);
    const c: Config = { ...primary, mirrorUrl: 'https://example.invalid/mirror.git' };
    const snapshot = await readSnapshot(c, await readState(c.privateDir), 0);
    const native = childProcess.execFile;
    let networkCalls = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            networkCalls++;
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const undeclared = 'https://example.invalid/undeclared.git';
        assert.deepEqual(checkSnapshot(c, { ...snapshot, pushUrl: undeclared }), { ok: false, code: 'destination_changed' });
        await assert.rejects(checkEmptyRemote(c, undefined, undeclared), /destination_changed/);
        await assert.rejects(refreshRemote(c, undefined, undeclared), /destination_changed/);
        await assert.rejects(pushSnapshot(c, { ...snapshot, pushUrl: undeclared }), /destination_changed/);
        assert.deepEqual(checkSnapshot(primary, { ...snapshot, pushUrl: undefined as any }), { ok: false, code: 'destination_changed' });
        await assert.rejects(pushSnapshot(primary, { ...snapshot, pushUrl: undefined as any }), /destination_changed/);
        for (const mirrorUrl of [c.remoteUrl, 'http://example.invalid/mirror', 'https://user:secret@example.invalid/mirror', 'https://example.invalid/mirror?secret', 'https://example.invalid/mirror#fragment', 'https://example.invalid/mirror?', 'https://example.invalid/mirror#']) {
            await assert.rejects(checkEmptyRemote({ ...c, mirrorUrl }, undefined, mirrorUrl), /destination_changed/);
        }
        assert.equal(networkCalls, 0);
        await assert.rejects(readFile(join(c.privateDir, 'send-manifest.json')), /ENOENT/);
        await assert.rejects(readFile(join(c.privateDir, 'send-manifest-mirror.json')), /ENOENT/);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
// Wrong URL reuse would silently update only one repository and overwrite its audit files.
test('declared mirror receives the same immutable OID with independent receipt and manifest', async () => {
    const primary = await fixture();
    const oid = await append(primary);
    const c: Config = { ...primary, mirrorUrl: 'https://example.invalid/mirror.git' };
    const snapshot = await readSnapshot(c, await readState(c.privateDir), 0);
    const native = childProcess.execFile;
    const remoteHeads = new Map<string, string>();
    const pushes: string[][] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            const url = args[args.indexOf('--refs') + 1];
            const head = remoteHeads.get(url);
            queueMicrotask(() => cb(null, Buffer.from(head ? `${head}\trefs/heads/worklog\n` : ''), Buffer.alloc(0)));
            return {};
        }
        if (args.includes('push')) {
            const push = args.slice(args.indexOf('push'));
            pushes.push(push);
            remoteHeads.set(push.at(-2)!, push.at(-1)!.split(':')[0]);
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.deepEqual(checkSnapshot(c, { ...snapshot, pushUrl: c.mirrorUrl! }), { ok: true });
        assert.equal((await pushSnapshot(c, snapshot)).result, 'ok');
        const primaryManifest = await readFile(join(c.privateDir, 'send-manifest.json'), 'utf8');
        const primaryReceipt = await readFile(join(c.privateDir, 'receipt.json'), 'utf8');
        assert.equal((await pushSnapshot(c, { ...snapshot, pushUrl: c.mirrorUrl! })).result, 'ok');
        assert.deepEqual(pushes, [c.remoteUrl, c.mirrorUrl].map(url => ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no', url, `${oid}:refs/heads/worklog`]));
        assert.equal(await readFile(join(c.privateDir, 'send-manifest.json'), 'utf8'), primaryManifest);
        assert.equal(await readFile(join(c.privateDir, 'receipt.json'), 'utf8'), primaryReceipt);
        const mirrorManifest = JSON.parse(await readFile(join(c.privateDir, 'send-manifest-mirror.json'), 'utf8'));
        const mirrorReceipt = JSON.parse(await readFile(join(c.privateDir, 'receipt-mirror.json'), 'utf8'));
        assert.equal(mirrorManifest.pushUrl, c.mirrorUrl);
        assert.equal(mirrorManifest.targetOid, oid);
        assert.equal(mirrorReceipt.pushUrl, c.mirrorUrl);
        assert.equal(mirrorReceipt.targetOid, oid);
        assert.equal(mirrorReceipt.result, 'ok');
        assert.equal((await refreshRemote(c, undefined, c.mirrorUrl)).oid, oid);
        assert.equal(git(c, 'config', '--get', 'remote.origin.url'), c.remoteUrl);
        assert.equal(git(c, 'remote'), 'origin');
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
// A populated mirror with unknown history must never authorize a force or overwrite.
test('mirror foreign history is blocked without pushing or touching primary audit files', async () => {
    const primary = await fixture();
    await append(primary);
    const c: Config = { ...primary, mirrorUrl: 'https://example.invalid/mirror.git' };
    const snapshot = await readSnapshot(c, await readState(c.privateDir), 0);
    const native = childProcess.execFile;
    let pushCount = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            if (args.includes('push')) pushCount++;
            const url = args[args.indexOf('--refs') + 1];
            queueMicrotask(() => cb(null, Buffer.from(url === c.mirrorUrl ? `${'f'.repeat(40)}\trefs/heads/worklog\n` : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await assert.rejects(refreshRemote(c, undefined, c.mirrorUrl), /invalid_history/);
        await assert.rejects(pushSnapshot(c, { ...snapshot, pushUrl: c.mirrorUrl! }), /invalid_history/);
        assert.equal(pushCount, 0);
        await assert.rejects(readFile(join(c.privateDir, 'receipt.json')), /ENOENT/);
        const receipt = JSON.parse(await readFile(join(c.privateDir, 'receipt-mirror.json'), 'utf8'));
        assert.equal(receipt.pushUrl, c.mirrorUrl);
        assert.equal(receipt.result, 'policy_blocked');
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
// Removing the per-object audit would permit these histories with a harmless current file.
test('rejects message identity merge executable and malformed historical content', async () => {
    for (const kind of ['message', 'identity', 'merge', 'mode', 'content']) {
        const c = await fixture();
        const first = await append(c);
        await writeFile(join(c.gitDir, 'WORKLOG.md'), WORKLOG_HEADER + row + row);
        git(c, 'add', 'WORKLOG.md');
        if (kind === 'mode')
            git(c, 'update-index', '--chmod=+x', 'WORKLOG.md');
        if (kind === 'content') {
            await writeFile(join(c.gitDir, 'WORKLOG.md'), WORKLOG_HEADER + 'PRIVATE_CANARY\n');
            git(c, 'add', 'WORKLOG.md');
        }
        git(c, 'commit', '-m', kind === 'message' ? 'PRIVATE_CANARY' : 'worklog: append progress', ...(kind === 'identity' ? ['--author', 'Other <other@example.invalid>'] : []));
        if (kind === 'merge') {
            const tree = git(c, 'rev-parse', 'HEAD^{tree}');
            const other = git(c, 'commit-tree', git(c, 'rev-parse', first + '^{tree}'), '-p', first, '-m', 'worklog: append progress');
            const merged = git(c, 'commit-tree', tree, '-p', 'HEAD', '-p', other, '-m', 'worklog: append progress');
            git(c, 'update-ref', 'refs/heads/worklog', merged);
            assert.equal(git(c, 'rev-list', '--parents', '-n', '1', merged).split(' ').length, 3);
        }
        await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
    }
});
// The real native Git child must ignore ambient repo/index/trace injection.
test('native git ignores dangerous inherited environment', async () => {
    const c = await fixture();
    const saved = { ...process.env };
    try {
        for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'])
            process.env[key] = 'PRIVATE_CANARY';
        const oid = await append(c);
        assert.equal((await readSnapshot(c, await readState(c.privateDir), 0)).targetOid, oid);
    }
    finally {
        process.env = saved;
    }
});
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
test('network uses immutable one-ref push and initial remote rejects any ref; startup carries config', async () => {
    const c = await fixture();
    await append(c);
    const s = await readSnapshot(c, await readState(c.privateDir), 0);
    const native = childProcess.execFile;
    const calls: {
        args: string[];
        options: any;
    }[] = [];
    let remoteText = '';
    (childProcess as any).execFile = (exe: string, args: string[], options: any, callback: any) => {
        if (args.includes('ls-remote') || args.includes('push') || exe.endsWith('schtasks.exe') || args.includes('mcp')) {
            calls.push({ args, options });
            queueMicrotask(() => callback(null, Buffer.from(args.includes('ls-remote') ? remoteText : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, callback);
    };
    syncBuiltinESMExports();
    try {
        await checkEmptyRemote(c);
        assert.equal(JSON.parse(await readFile(join(c.privateDir, 'receipt.json'), 'utf8')).operation, 'check_remote');
        assert.equal((await refreshRemote(c)).oid, null);
        const receipt = await pushSnapshot(c, s);
        assert.equal(receipt.result, 'ok');
        const push = calls.find(x => x.args.includes('push'))!;
        assert.deepEqual(push.args.slice(push.args.indexOf('push')), ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no', c.remoteUrl, `${s.targetOid}:refs/heads/worklog`]);
        assert.equal(push.options.shell, false);
        assert.equal(push.options.windowsHide, true);
        assert.ok(push.args.includes('http.followRedirects=false'));
        assert.ok(push.args.includes('protocol.allow=never'));
        remoteText = 'a'.repeat(40) + '\trefs/heads/other\n';
        await assert.rejects(pushSnapshot(c, s));
        const localAppData = process.env.LOCALAPPDATA;
        try {
            process.env.LOCALAPPDATA = join(c.privateDir, 'fake-local-appdata');
            const desktop = join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
            await mkdir(join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), { recursive: true });
            await writeFile(desktop, 'fixture executable, never executed');
            await registerClientMcp('codex', join(c.privateDir, 'cli.js'));
        } finally {
            if (localAppData === undefined)
                delete process.env.LOCALAPPDATA;
            else
                process.env.LOCALAPPDATA = localAppData;
        }
        const appdata = process.env.APPDATA;
        try {
            process.env.APPDATA = join(c.privateDir, 'fake-appdata');
            const pkg = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
            await mkdir(pkg, { recursive: true });
            await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.92', bin: { claude: 'cli.js' } }));
            await writeFile(join(pkg, 'cli.js'), 'fake entry, never executed');
            await registerClientMcp('claude', join(c.privateDir, 'cli.js'));
        } finally {
            if (appdata === undefined)
                delete process.env.APPDATA;
            else
                process.env.APPDATA = appdata;
        }
        await (manageStartup as any)('install', join(c.privateDir, 'cli.js'), join(c.privateDir, 'config.json'));
        assert.ok(calls.at(-1)!.args.includes('/XML'));
        await assert.rejects(manageStartup('remove', join(c.privateDir, 'cli.js')));
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
test('invalid UTF8 hidden in raw blob cannot be sent', async () => {
    const c = await fixture();
    await append(c);
    const bytes = Buffer.from(WORKLOG_HEADER + row);
    const at = bytes.indexOf(Buffer.from('实现'));
    bytes[at] = 0xff;
    await writeFile(join(c.gitDir, 'WORKLOG.md'), bytes);
    git(c, 'add', 'WORKLOG.md');
    git(c, 'commit', '-m', 'worklog: append progress');
    await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
});
test('writer ownership checked before commit side effect', async () => {
    const c = await fixture();
    await writeFile(join(c.gitDir, 'WORKLOG.md'), WORKLOG_HEADER + row);
    await assert.rejects(commitWorklog(c, hash(WORKLOG_HEADER + row), () => {
        throw new Error('writer_lock_lost');
    }), /writer_lock_lost/);
    assert.equal(git(c, 'status', '--porcelain'), '?? WORKLOG.md');
});
test('rejects unknown baseline and tampered preview', async () => {
    const c = await fixture();
    await append(c);
    const state = await readState(c.privateDir);
    await assert.rejects(readSnapshot(c, { ...state, remoteOid: 'f'.repeat(40) }, 0));
    const s = structuredClone(await readSnapshot(c, state, 0));
    s.commits[0].worklog = WORKLOG_HEADER + row + row;
    await assert.rejects(pushSnapshot(c, s));
});
test('UTF8 BOM is rejected rather than hidden from blob audit', async () => {
    const c = await fixture();
    await writeFile(join(c.gitDir, 'WORKLOG.md'), '\ufeff' + WORKLOG_HEADER + row);
    git(c, 'add', 'WORKLOG.md');
    git(c, 'commit', '-m', 'worklog: append progress');
    await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0));
});
test('controlled empty template and hook directory cannot become executable input', async () => {
    const c = await fixture();
    await append(c);
    await writeFile(join(c.privateDir, 'empty', 'pre-push'), 'PRIVATE_CANARY');
    await assert.rejects(readSnapshot(c, await readState(c.privateDir), 0), /extra_execution/);
});
test('startup refuses replacement and only removes matching owned action', async () => {
    const c = await fixture();
    const cli = join(c.privateDir, 'cli.js'), path = join(c.privateDir, 'config.json');
    const native = childProcess.execFile;
    const calls: string[][] = [];
    let xml = '<Task><Actions><Exec><Command>other.exe</Command><Arguments>other</Arguments></Exec></Actions></Task>';
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('schtasks.exe')) {
            calls.push(args);
            queueMicrotask(() => cb(null, Buffer.from(args.includes('/Query') ? xml : ''), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        await manageStartup('install', cli, path);
        assert.equal(calls[0].includes('/F'), false);
        assert.match(calls[0][calls[0].indexOf('/TN') + 1], /^WhatIveDone-[a-f0-9]{16}$/);
        await assert.rejects(manageStartup('remove', cli, path));
        assert.equal(calls.some(args => args.includes('/Delete')), false);
        const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
        xml = `<Task><Actions><Exec><Command>${escape(process.execPath)}</Command><Arguments>${escape('"' + cli + '" sync --watch --config "' + path + '"')}</Arguments></Exec></Actions></Task>`;
        await manageStartup('remove', cli, path);
        assert.equal(calls.at(-1)!.includes('/Delete'), true);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
import { securePrivateDirectory } from '../src/transport.js';
test('private ACL resets explicit grants before disabling inheritance', async () => {
    const c = await fixture();
    const native = childProcess.execFile;
    const calls: string[][] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('icacls.exe')) {
            calls.push(args);
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const path = join(c.privateDir, 'acl');
        await securePrivateDirectory(path);
        assert.deepEqual(calls[0], [path, '/reset']);
        assert.ok(calls[1].includes('/inheritance:r'));
        assert.ok(calls[1].includes('/grant:r'));
        assert.equal(calls.flat().includes('/T'), false);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
