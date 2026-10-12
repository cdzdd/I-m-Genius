import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCli, loadConfig } from '../src/cli.js';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { assertNativeHookOutput } from './native-hook-output.js';
import { readEvents, readState, writeState } from '../src/store.js';
import { initializeLocalRepository, commitWorklog } from '../src/transport.js';
import { appendRows, type Config } from '../src/schema.js';
import { createHash } from 'node:crypto';
// Real init/config/preview filesystem and Git; only user task registration is doubled.
test('init defaults local, fresh preview is empty, pause/resume persist, errors never expose input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-'));
    const path = join(root, 'private', 'config.json');
    const output: string[] = [];
    const native = childProcess.execFile;
    let taskXml = Buffer.alloc(0);
    const taskCalls: string[][] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('schtasks.exe')) {
            taskCalls.push(args);
            if (args.includes('/Create')) {
                void readFile(args[args.indexOf('/XML') + 1]).then(bytes => { taskXml = bytes; cb(null, Buffer.alloc(0), Buffer.alloc(0)); });
            } else queueMicrotask(() => cb(null, args.includes('/Query') ? taskXml : Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        if (exe.endsWith('icacls.exe')) {
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const run = (args: string[]) => runCli([...args, '--config', path], undefined, line => output.push(line));
        assert.equal(await run(['init', '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid']), 0);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).mode, 'local');
        assert.equal(JSON.parse(await readFile(path, 'utf8')).branch, 'main');
        assert.deepEqual(taskCalls.map(args => args[0]), ['/Create', '/Query', '/Run']);
        taskCalls.length = 0;
        assert.equal(await run(['start']), 0);
        assert.deepEqual(taskCalls.map(args => args[0]), ['/Query', '/Run']);
        taskCalls.length = 0;
        assert.equal(await runCli(['init', '--config', join(root, 'manual', 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--no-startup'], undefined, () => {}), 0);
        assert.deepEqual(taskCalls, []);
        output.length = 0;
        assert.equal(await run(['preview']), 0);
        assert.match(output.join(''), /empty/);
        await run(['pause']);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).captureEnabled, false);
        await run(['resume']);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).captureEnabled, true);
        output.length = 0;
        assert.equal(await run(['PRIVATE_CANARY']), 1);
        assert.equal(output.join('').includes('PRIVATE_CANARY'), false);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';

test('init canonicalizes a non-symbolic virtualized private directory before ACL and stores its physical config path', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'whativedone-cli-virtualized-'));
    const lexical = join(root, 'lexical');
    const physical = join(root, 'physical');
    await mkdir(lexical);
    await mkdir(physical);
    const nativeRealpath = fs.realpath;
    const nativeExec = childProcess.execFile;
    let aclPath = '';
    t.mock.method(fs, 'realpath', async (path: any, options?: any) => resolve(String(path)) === resolve(lexical) ? nativeRealpath(physical, options) : nativeRealpath(path, options));
    t.mock.method(childProcess, 'execFile', (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('icacls.exe')) {
            aclPath = args[0];
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (nativeExec as any)(exe, args, options, cb);
    });
    syncBuiltinESMExports();
    try {
        const lines: string[] = [];
        assert.equal(await runCli(['init', '--config', join(lexical, 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--no-startup'], undefined, line => lines.push(line)), 0);
        const canonical = await nativeRealpath(physical);
        assert.equal(resolve(aclPath), resolve(canonical));
        const config = JSON.parse(await readFile(join(canonical, 'config.json'), 'utf8'));
        assert.equal(config.privateDir, canonical);
        assert.equal(config.gitDir, join(canonical, 'repository'));
        assert.equal(JSON.parse(lines[0]).configPath, join(canonical, 'config.json'));
    } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await fs.rm(root, { recursive: true, force: true });
    }
});
test('init refuses a nonempty private directory before changing ACL or data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-existing-'));
    await writeFile(join(root, 'keep.txt'), 'keep');
    const lines: string[] = [];
    assert.equal(await runCli(['init', '--config', join(root, 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--no-startup'], undefined, line => lines.push(line)), 1);
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.match(lines.join(''), /private_directory_not_empty/);
});

test('init rejects a chosen directory junction before changing its target', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'whativedone-cli-junction-'));
    const target = join(root, 'target');
    const chosen = join(root, 'chosen');
    try {
        await mkdir(target);
        await fs.symlink(target, chosen, 'junction');
        const lines: string[] = [];
        assert.equal(await runCli(['init', '--config', join(chosen, 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--no-startup'], undefined, line => lines.push(line)), 1);
        assert.deepEqual(lines, ['{"errorCode":"invalid_history"}']);
        assert.deepEqual(await fs.readdir(target), []);
    } finally {
        await fs.rm(chosen, { recursive: true, force: true });
        await fs.rm(root, { recursive: true, force: true });
    }
});
test('source integration preserves user hooks, refuses existing server identity and uninstall preserves subsequent edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-source-'));
    const home = join(root, 'codex');
    await mkdir(home);
    const hookPath = join(home, 'hooks.json');
    await writeFile(hookPath, JSON.stringify({ custom: 'preserved', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-command' }] }] } }));
    const prior = process.env.CODEX_HOME;
    const priorLocal = process.env.LOCALAPPDATA;
    process.env.CODEX_HOME = home;
    process.env.LOCALAPPDATA = join(root, 'local');
    const desktop = join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    await mkdir(dirname(desktop), { recursive: true });
    await writeFile(desktop, 'fixture executable, never executed');
    const native = childProcess.execFile;
    let removed = false;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('icacls.exe')) {
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        if (args.includes('mcp')) {
            (async () => {
                if (args.includes('add'))
                    await writeFile(join(home, 'config.toml'), '[mcp_servers.whativedone]\ncommand = "node"\nargs = ["ours", "mcp"]\n');
                if (args.includes('remove'))
                    removed = true;
                cb(null, Buffer.alloc(0), Buffer.alloc(0));
            })();
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const configPath = join(root, 'private', 'config.json');
        const lines: string[] = [];
        assert.equal(await runCli(['init', '--config', configPath, '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--source', 'codex', '--no-startup'], undefined, line => lines.push(line)), 0);
        const hooks = JSON.parse(await readFile(hookPath, 'utf8'));
        assert.equal(hooks.hooks.Stop.length, 2);
        assert.match(hooks.hooks.PostToolUse[0].matcher, /^mcp__whativedone__classify_progress$/);
        assert.match(lines.join(''), /configured_unverified/);
        const wrapper = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
        for (const shell of ['powershell', 'cmd', 'bash']) {
            const executable = shell === 'bash' ? 'C:/Program Files/Git/bin/bash.exe' : shell === 'powershell' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : 'C:/Windows/System32/cmd.exe';
            const args = shell === 'bash' ? ['--noprofile', '--norc', '-c', wrapper] : shell === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', wrapper] : ['/d', '/s', '/c', '"' + wrapper + '"'];
            for (const event of ['UserPromptSubmit','Stop','PostToolUse'] as const) {
                const progress = { category:'implementation', status:'in_progress' };
                const result = spawnSync(executable.replaceAll('/', '\\'), args, { input: JSON.stringify({ hook_event_name: event, session_id: 's', turn_id: `${shell}-${event}`, prompt: 'PRIVATE_CANARY', tool_name: 'mcp__whativedone__classify_progress', tool_use_id: 'call', tool_input: progress, tool_response: {structuredContent:progress} }), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: shell === 'cmd' });
                assert.equal(result.status, 0, shell + result.stderr);
                const output = JSON.parse(result.stdout.trim());
                assertNativeHookOutput(event, output);
                if (event === 'UserPromptSubmit') {
                    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
                    assert.match(output.hookSpecificOutput.additionalContext, /mcp__whativedone__classify_progress/);
                } else assert.deepEqual(output,{});
                assert.equal(result.stdout.includes('PRIVATE_CANARY'), false);
            }
        }
        assert.equal((await readEvents(join(root, 'private'))).length,9);
        hooks.hooks.Stop.push({ hooks: [{ type: 'command', command: 'later-command' }] });
        await writeFile(hookPath, JSON.stringify(hooks));
        await writeFile(join(home, 'config.toml'), '[mcp_servers.whativedone]\ncommand = "user-replacement"\n');
        assert.equal(await runCli(['uninstall', '--config', configPath], undefined, () => {
        }), 0);
        const after = JSON.parse(await readFile(hookPath, 'utf8'));
        assert.equal(after.custom, 'preserved');
        assert.deepEqual(after.hooks.Stop.map((x: any) => x.hooks[0].command), ['user-command', 'later-command']);
        assert.equal(removed, false);
        const secondPath = join(root, 'second', 'config.json');
        assert.equal(await runCli(['init', '--config', secondPath, '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--source', 'codex', '--no-startup'], undefined, line => lines.push(line)), 1);
        assert.match(lines.at(-1)!, /client_conflict/);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
        if (prior === undefined)
            delete process.env.CODEX_HOME;
        else
            process.env.CODEX_HOME = prior;
        if (priorLocal === undefined)
            delete process.env.LOCALAPPDATA;
        else
            process.env.LOCALAPPDATA = priorLocal;
    }
});
test('Claude legacy global config fails closed before native mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-legacy-'));
    const home = join(root, 'claude');
    await mkdir(home);
    await writeFile(join(home, '.config.json'), '{}');
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    const native = childProcess.execFile;
    let registrations = 0;
    const output: string[] = [];
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('mcp'))
            registrations++;
        if (exe.endsWith('icacls.exe') || args.includes('mcp')) {
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await runCli(['init', '--config', join(root, 'private', 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--source', 'claude', '--no-startup'], undefined, line => output.push(line)), 1);
        assert.equal(registrations, 0);
        assert.match(output.join(''), /invalid_client/);
    }
    finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
        if (prior === undefined)
            delete process.env.CLAUDE_CONFIG_DIR;
        else
            process.env.CLAUDE_CONFIG_DIR = prior;
    }
});
test('status and enable-sync reject credential-bearing config before printing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-invalid-'));
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ privateDir: root, gitDir: join(root, 'repo'), remoteUrl: 'https://user:PRIVATE_CANARY@example.invalid/log.git', branch: 'worklog', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' }));
    for (const command of ['status', 'enable-sync']) {
        const lines: string[] = [];
        assert.equal(await runCli([command, '--config', path], undefined, line => lines.push(line)), 1);
        assert.equal(lines.join('').includes('PRIVATE_CANARY'), false);
    }
});
test('hook configuration and argument failures emit native-compatible advisory warnings without reading input', async () => {
    const root = await mkdtemp(join(tmpdir(),'whativedone-cli-hook-error-'));
    const path = join(root,'config.json');
    await writeFile(path,'PRIVATE_CANARY');
    let read = false;
    async function* input() { read = true; yield Buffer.from('PRIVATE_CANARY'); }
    for (const source of ['codex','claude']) {
        for (const configPath of [path,join(root,'missing.json')]) {
            const lines:string[]=[];
            assert.equal(await runCli(['hook',source,'--config',configPath],input(),line=>lines.push(line)),0);
            assert.equal(lines.length,1);
            const output = JSON.parse(lines[0]);
            assertNativeHookOutput('UserPromptSubmit',output);
            assert.deepEqual(output,{systemMessage:'WhatIveDone hook failed: invalid_config'});
            assert.equal(lines[0].includes('PRIVATE_CANARY'),false);
        }
    }
    const lines:string[]=[];
    assert.equal(await runCli(['hook','PRIVATE_CANARY','--config',path],input(),line=>lines.push(line)),0);
    assert.deepEqual(JSON.parse(lines[0]),{systemMessage:'WhatIveDone hook failed: invalid_arguments'});
    assertNativeHookOutput('Stop',JSON.parse(lines[0]));
    assert.equal(read,false);
});
import { fileURLToPath } from 'node:url';
test('a second watch process exits while first keeps the lifetime lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-watch-'));
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ privateDir: root, gitDir: join(root, 'repo'), remoteUrl: 'https://example.invalid/log.git', branch: 'worklog', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: false, mode: 'local' }));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const watcher = childProcess.spawn(process.execPath, [cli, 'sync', '--watch', '--config', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await new Promise<void>((resolve, reject) => {
            watcher.stdout.once('data', () => resolve());
            watcher.once('error', reject);
        });
        const other = spawnSync(process.execPath, [cli, 'sync', '--watch', '--config', path], { encoding: 'utf8', timeout: 3000, windowsHide: true });
        assert.equal(other.status, 0);
        assert.match(other.stdout, /already_running/);
    }
    finally {
        watcher.kill();
    }
});
test('uninstall refuses a changed source home before altering either home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-homes-'));
    const original = join(root, 'original'), replacement = join(root, 'replacement');
    await mkdir(original);
    await mkdir(replacement);
    const hookPath = join(original, 'hooks.json');
    await writeFile(hookPath, '{"hooks":{"Stop":[]}}');
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ privateDir: root, gitDir: join(root, 'repo'), remoteUrl: 'https://example.invalid/log.git', branch: 'worklog', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' }));
    await writeFile(join(root, 'integrations.json'), JSON.stringify([{ source: 'codex', hookPath, mcpPath: join(original, 'config.toml'), blocks: {}, server: { command: 'node' }, status: 'configured_unverified' }]));
    const prior = process.env.CODEX_HOME;
    process.env.CODEX_HOME = replacement;
    const lines: string[] = [];
    try {
        assert.equal(await runCli(['uninstall', '--config', configPath], undefined, line => lines.push(line)), 1);
        assert.match(lines.join(''), /client_conflict/);
        assert.equal(await readFile(hookPath, 'utf8'), '{"hooks":{"Stop":[]}}');
    }
    finally {
        if (prior === undefined)
            delete process.env.CODEX_HOME;
        else
            process.env.CODEX_HOME = prior;
    }
});

async function mirrorFixture(): Promise<{ c: Config; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-mirror-'));
    const c: Config = { privateDir: root, gitDir: join(root, 'repository'), remoteUrl: 'https://example.invalid/log.git', branch: 'main', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' };
    await initializeLocalRepository(c);
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify(c));
    return { c, path };
}

test('loadConfig preserves an optional mirror and rejects invalid or duplicate destinations without exposing them', async () => {
    const { c, path } = await mirrorFixture();
    await writeFile(path, JSON.stringify({ ...c, mirrorUrl: 'https://mirror.invalid/log.git', privateExtra: 'PRIVATE_CANARY' }));
    assert.equal((await loadConfig(path)).mirrorUrl, 'https://mirror.invalid/log.git');
    assert.equal(JSON.stringify(await loadConfig(path)).includes('PRIVATE_CANARY'), false);
    for (const mirrorUrl of [c.remoteUrl, 'https://user:PRIVATE_CANARY@mirror.invalid/log.git', 'https://mirror.invalid/log.git?q=PRIVATE_CANARY', 'https://mirror.invalid/log.git?', 'https://mirror.invalid/log.git#', 'https://MIRROR.invalid/log.git', 'http://mirror.invalid/log.git', 'https://mirror.invalid/log.git\n', null, 1]) {
        await writeFile(path, JSON.stringify({ ...c, mirrorUrl }));
        await assert.rejects(loadConfig(path), { message: 'invalid_config' });
        const lines: string[] = [];
        assert.equal(await runCli(['status', '--config', path], undefined, line => lines.push(line)), 1);
        assert.deepEqual(lines, ['{"errorCode":"invalid_config"}']);
    }
});

test('init saves a valid mirror while keeping a single local repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-cli-init-mirror-'));
    const path = join(root, 'private', 'config.json');
    const native = childProcess.execFile;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (exe.endsWith('icacls.exe')) {
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        assert.equal(await runCli(['init', '--config', path, '--repo', 'https://example.invalid/log.git', '--mirror', 'https://mirror.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid', '--no-startup'], undefined, () => {}), 0);
        const config = await loadConfig(path);
        assert.equal(config.mirrorUrl, 'https://mirror.invalid/log.git');
        assert.equal(config.mode, 'local');
        assert.equal(config.gitDir, join(dirname(path), 'repository'));
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('mirror flags reject duplicate, misplaced and credential values before network or destination disclosure', async () => {
    const { c, path } = await mirrorFixture();
    const before = await readFile(path, 'utf8');
    const native = childProcess.execFile;
    let remoteCalls = 0;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote') || args.includes('push')) {
            remoteCalls++;
            queueMicrotask(() => cb(new Error('network unexpected'), Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        for (const args of [
            ['enable-sync', '--mirror', c.remoteUrl],
            ['enable-sync', '--mirror', 'https://user:PRIVATE_CANARY@mirror.invalid/log.git'],
            ['enable-sync', '--mirror', 'https://mirror.invalid/log.git', '--mirror', 'https://other.invalid/log.git'],
            ['status', '--mirror', 'https://mirror.invalid/log.git'],
            ['resume', '--mirror', 'https://mirror.invalid/log.git']
        ]) {
            const lines: string[] = [];
            assert.equal(await runCli([...args, '--config', path], undefined, line => lines.push(line)), 1);
            assert.equal(lines.length, 1);
            assert.equal(lines[0].includes('PRIVATE_CANARY'), false);
            assert.ok(JSON.parse(lines[0]).errorCode);
        }
        assert.equal(remoteCalls, 0);
        assert.equal(await readFile(path, 'utf8'), before);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('failed mirror enablement leaves the saved config and target checkpoints unchanged', async () => {
    const { c, path } = await mirrorFixture();
    const state = await readState(c.privateDir);
    state.remoteCheckedAt = '2026-10-09T00:00:00.000Z';
    await writeState(c.privateDir, state);
    const configBefore = await readFile(path, 'utf8');
    const stateBefore = await readFile(join(c.privateDir, 'state.json'), 'utf8');
    const native = childProcess.execFile;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            const mirror = args.includes('https://mirror.invalid/log.git');
            queueMicrotask(() => cb(mirror ? new Error('PRIVATE_CANARY') : null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const lines: string[] = [];
        assert.equal(await runCli(['enable-sync', '--config', path, '--mirror', 'https://mirror.invalid/log.git'], undefined, line => lines.push(line)), 1);
        assert.equal(await readFile(path, 'utf8'), configBefore);
        assert.equal(await readFile(join(c.privateDir, 'state.json'), 'utf8'), stateBefore);
        assert.equal(lines.join('').includes('PRIVATE_CANARY'), false);
        assert.deepEqual(JSON.parse(lines[0]).targets, [{url:c.remoteUrl}, {url:'https://mirror.invalid/log.git'}]);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('status exposes separate mirror checkpoint and errors without losing primary compatibility', async () => {
    const { c, path } = await mirrorFixture();
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    await writeFile(path, JSON.stringify(c));
    const state = await readState(c.privateDir);
    state.remoteOid = 'a'.repeat(40);
    state.remoteCheckedAt = '2026-10-09T00:00:00.000Z';
    state.primaryErrorCode = 'auth_required';
    state.mirror = { remoteUrl: c.mirrorUrl, remoteOid: null, remoteCheckedAt: null, errorCode: 'network_error' };
    await writeState(c.privateDir, state);
    const lines: string[] = [];
    assert.equal(await runCli(['status', '--config', path], undefined, line => lines.push(line)), 0);
    const output = JSON.parse(lines[0]);
    assert.equal(output.target, c.remoteUrl);
    assert.equal(output.lastSentOid, 'a'.repeat(40));
    assert.equal(output.errorCode, null);
    assert.deepEqual(output.targets, [
        { url: c.remoteUrl, lastSentOid: 'a'.repeat(40), lastCheckedAt: '2026-10-09T00:00:00.000Z', errorCode: 'auth_required' },
        { url: c.mirrorUrl, lastSentOid: null, lastCheckedAt: null, errorCode: 'network_error' }
    ]);
});

test('resume revalidates local history and marks both target policy errors for retry', async () => {
    const { c, path } = await mirrorFixture();
    c.mode = 'auto';
    c.captureEnabled = false;
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    await writeFile(path, JSON.stringify(c));
    const state = await readState(c.privateDir);
    state.primaryErrorCode = 'invalid_history';
    state.mirror = { remoteUrl: c.mirrorUrl, remoteOid: null, remoteCheckedAt: '2026-10-09T00:00:00.000Z', errorCode: 'destination_changed' };
    await writeState(c.privateDir, state);
    assert.equal(await runCli(['resume', '--config', path], undefined, () => {}), 0);
    const after = await readState(c.privateDir);
    assert.equal(after.errorCode, undefined);
    assert.equal(after.primaryErrorCode, 'revalidation_required');
    assert.equal(after.mirror?.errorCode, 'revalidation_required');
    assert.equal((await loadConfig(path)).captureEnabled, true);
});

test('successful mirror enablement saves auto mode and previews both destinations from one local history', async () => {
    const { c, path } = await mirrorFixture();
    const log = appendRows('', [{time:'2026-10-09T00:00:00.000Z', category:'implementation', status:'in_progress'}]);
    await writeFile(join(c.gitDir, 'WORKLOG.md'), log);
    const oid = await commitWorklog(c, createHash('sha256').update(log).digest('hex'));
    const native = childProcess.execFile;
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        if (args.includes('ls-remote')) {
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        }
        return (native as any)(exe, args, options, cb);
    };
    syncBuiltinESMExports();
    try {
        const lines: string[] = [];
        assert.equal(await runCli(['enable-sync', '--config', path, '--mirror', 'https://mirror.invalid/log.git'], undefined, line => lines.push(line)), 0);
        assert.equal(lines.at(-1), 'auto');
        const saved = await loadConfig(path);
        assert.equal(saved.mode, 'auto');
        assert.equal(saved.mirrorUrl, 'https://mirror.invalid/log.git');
        const state = await readState(c.privateDir);
        assert.equal(state.mirror?.remoteUrl, 'https://mirror.invalid/log.git');
        lines.length = 0;
        assert.equal(await runCli(['preview', '--config', path], undefined, line => lines.push(line)), 0);
        const snapshots = JSON.parse(lines[0]);
        assert.equal(snapshots.length, 2);
        assert.deepEqual(snapshots.map((s:any) => s.pushUrl), [c.remoteUrl, 'https://mirror.invalid/log.git']);
        assert.deepEqual(snapshots.map((s:any) => s.targetOid), [oid, oid]);
        assert.deepEqual(snapshots.map((s:any) => s.commits.length), [1, 1]);
        assert.deepEqual(snapshots.map((s:any) => s.commits[0].worklog), [log, log]);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
    }
});

test('auto status never attributes an approved mirror checkpoint to an unapproved destination', async () => {
    const { c, path } = await mirrorFixture();
    c.mode = 'auto';
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    await writeFile(path, JSON.stringify(c));
    for (const mirror of [undefined, { remoteUrl: 'https://previous.invalid/log.git', remoteOid: 'b'.repeat(40), remoteCheckedAt: '2026-10-09T00:00:00.000Z' }]) {
        const state = await readState(c.privateDir);
        state.mirror = mirror;
        await writeState(c.privateDir, state);
        const lines: string[] = [];
        assert.equal(await runCli(['status', '--config', path], undefined, line => lines.push(line)), 0);
        assert.deepEqual(JSON.parse(lines[0]).targets[1], {url:c.mirrorUrl, lastSentOid:null, lastCheckedAt:null, errorCode:'destination_changed'});
    }
});

test('resume preserves an absent approved mirror binding instead of authorizing the configured candidate', async () => {
    const { c, path } = await mirrorFixture();
    c.mode = 'auto';
    c.mirrorUrl = 'https://mirror.invalid/log.git';
    c.captureEnabled = false;
    await writeFile(path, JSON.stringify(c));
    const state = await readState(c.privateDir);
    state.primaryErrorCode = 'network_error';
    await writeState(c.privateDir, state);
    assert.equal(await runCli(['resume', '--config', path], undefined, () => {}), 0);
    const after = await readState(c.privateDir);
    assert.equal(Object.hasOwn(after, 'mirror'), false);
    assert.equal(after.primaryErrorCode, 'revalidation_required');
    const lines: string[] = [];
    await runCli(['status', '--config', path], undefined, line => lines.push(line));
    assert.equal(JSON.parse(lines[0]).targets[1].errorCode, 'destination_changed');
});
