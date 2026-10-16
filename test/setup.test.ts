import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { runCli, loadConfig } from '../src/cli.js';
import { initializeLocalRepository, commitWorklog, readSnapshot, pushSnapshot, manageStartup } from '../src/transport.js';
import { appendRows, type Config } from '../src/schema.js';
import { readState } from '../src/store.js';

async function isolated(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-setup-'));
    const keys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
    const old = keys.map(key => process.env[key]);
    for (const key of keys) process.env[key] = join(root, key);
    try { await run(root); }
    finally {
        keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; });
        await rm(root, { recursive: true, force: true });
    }
}
async function codex() {
    const path = join(process.env.LOCALAPPDATA!, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture, never executed');
}
const options = (root: string) => ['--config', join(root, 'private', 'config.json'), '--repo', 'https://example.invalid/log.git', '--name', 'Logger', '--email', 'logger@example.invalid'];
async function invoke(args: string[]) {
    const lines: string[] = [];
    const code = await runCli(args, undefined, line => lines.push(line));
    return { code, lines };
}

test('setup-info is read-only, uses only fixed Git and reports absent clients with editable identity', async t => {
    await isolated(async root => {
        const calls: string[][] = [];
        t.mock.method(childProcess, 'execFile', (exe: string, args: string[], opts: any, cb: any) => {
            assert.equal(exe, 'C:/Program Files/Git/cmd/git.exe');
            assert.equal(args.includes('--no-includes') || args.includes('--version'), true);
            calls.push(args);
            const value = args.includes('user.name') ? 'Fixture User\n' : args.includes('user.email') ? 'fixture@example.invalid\n' : 'git version fixture\n';
            queueMicrotask(() => cb(null, Buffer.from(value), Buffer.alloc(0)));
            return {};
        });
        syncBuiltinESMExports();
        try {
            const result = await invoke(['setup-info']);
            assert.equal(result.code, 0);
            assert.deepEqual(JSON.parse(result.lines[0]), { gitAvailable: true, codexAvailable: false, claudeAvailable: false, authorName: 'Fixture User', authorEmail: 'fixture@example.invalid' });
            assert.equal(calls.some(args => args.includes('credential.helper')), false);
            assert.deepEqual(await readdir(root), []);
        } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
});

test('setup-info handles missing Git and does not probe arbitrary PATH clients', async t => {
    await isolated(async root => {
        t.mock.method(childProcess, 'execFile', (exe: string, args: string[], opts: any, cb: any) => {
            assert.equal(exe, 'C:/Program Files/Git/cmd/git.exe');
            queueMicrotask(() => cb(new Error('PRIVATE_CANARY'), Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        });
        syncBuiltinESMExports();
        try {
            const result = await invoke(['setup-info']);
            assert.equal(result.code, 0);
            assert.deepEqual(JSON.parse(result.lines[0]), { gitAvailable: false, codexAvailable: false, claudeAvailable: false, authorName: '', authorEmail: '' });
            assert.deepEqual(await readdir(root), []);
        } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
});

test('init preflights the missing second client before any first-client or private-directory mutation', async t => {
    await isolated(async root => {
        await codex();
        await mkdir(process.env.CODEX_HOME!);
        const hook = join(process.env.CODEX_HOME!, 'hooks.json');
        await writeFile(hook, '{"hooks":{"Stop":[]}}');
        let executions = 0;
        t.mock.method(childProcess, 'execFile', (...args: any[]) => { executions++; throw new Error('unexpected execution'); });
        syncBuiltinESMExports();
        try {
            const result = await invoke(['init', ...options(root), '--source', 'codex', '--source', 'claude', '--no-startup']);
            assert.deepEqual(result, { code: 1, lines: ['{"errorCode":"invalid_client"}'] });
            assert.equal(await readFile(hook, 'utf8'), '{"hooks":{"Stop":[]}}');
            await assert.rejects(access(join(root, 'private')));
            assert.equal(executions, 0);
        } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
});

test('setup-check and init reject existing MCP registration before creating data', async () => {
    await isolated(async root => {
        await codex();
        await mkdir(process.env.CODEX_HOME!);
        const path = join(process.env.CODEX_HOME!, 'config.toml');
        const original = '[mcp_servers.whativedone]\ncommand = "user-owned"\n';
        await writeFile(path, original);
        for (const command of ['setup-check', 'init']) {
            const result = await invoke([command, ...options(root), '--source', 'codex', ...(command === 'init' ? ['--no-startup'] : [])]);
            assert.deepEqual(result, { code: 1, lines: ['{"errorCode":"client_conflict"}'] });
            await assert.rejects(access(join(root, 'private')));
            assert.equal(await readFile(path, 'utf8'), original);
        }
    });
});

test('setup-check validates selected clients and arguments without creating any data', async () => {
    await isolated(async root => {
        await codex();
        const before = await readdir(root);
        const result = await invoke(['setup-check', ...options(root), '--mirror', 'https://mirror.invalid/log.git', '--source', 'codex']);
        assert.deepEqual(result, { code: 0, lines: ['{"ready":true}'] });
        assert.deepEqual(await readdir(root), before);
        await assert.rejects(access(join(root, 'private')));
    });
});

test('preflight rejects private contents and invalid identity before writes', async () => {
    await isolated(async root => {
        for (const command of ['setup-check', 'init']) {
            const args = options(root);
            args[args.indexOf('--email') + 1] = 'PRIVATE_CANARY\n';
            const result = await invoke([command, ...args]);
            assert.deepEqual(result, { code: 1, lines: ['{"errorCode":"invalid_config"}'] });
            await assert.rejects(access(join(root, 'private')));
        }
        await mkdir(join(root, 'private'));
        await writeFile(join(root, 'private', 'keep'), 'keep');
        assert.deepEqual(await invoke(['setup-check', ...options(root)]), { code: 1, lines: ['{"errorCode":"private_directory_not_empty"}'] });
        assert.deepEqual(await readdir(join(root, 'private')), ['keep']);
    });
});

test('unsupported flags fail before reading config and never start a watcher', async () => {
    await isolated(async root => {
        for (const args of [['sync', '--interactive-auth'], ['sync', '--watch', '--interactive-auth'], ['setup-info', '--config', 'missing'], ['setup-check', ...options(root), '--no-startup'], ['status', '--repo', 'https://example.invalid/log.git'], ['enable-sync', '--interactive-auth', '--interactive-auth'], ['init', ...options(root), '--watch']]) {
            assert.deepEqual(await invoke(args), { code: 1, lines: ['{"errorCode":"invalid_arguments"}'] });
        }
    });
});

test('interactive enablement permits only remote credential-helper prompts and records the mode', async t => {
    await isolated(async root => {
        const privateDir = join(root, 'private');
        const c: Config = { privateDir, gitDir: join(privateDir, 'repository'), remoteUrl: 'https://example.invalid/log.git', mirrorUrl: 'https://mirror.invalid/log.git', branch: 'main', authorName: 'Logger', authorEmail: 'logger@example.invalid', captureEnabled: true, mode: 'local' };
        await initializeLocalRepository(c);
        const path = join(privateDir, 'config.json');
        await writeFile(path, JSON.stringify(c));
        const native = childProcess.execFile;
        const remoteModes: string[] = [];
        let pushes = 0;
        t.mock.method(childProcess, 'execFile', (exe: string, args: string[], opts: any, cb: any) => {
            if (args.includes('ls-remote')) {
                remoteModes.push(opts.env.GCM_INTERACTIVE);
                assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
                assert.ok(args.includes('credential.helper=manager'));
                queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
                return {};
            }
            assert.equal(opts.env.GCM_INTERACTIVE, 'never');
            if (args.includes('push')) {
                pushes++;
                queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
                return {};
            }
            if (args.includes('credential.helper')) {
                queueMicrotask(() => cb(null, Buffer.from(args.includes('--global') ? 'manager\n' : ''), Buffer.alloc(0)));
                return {};
            }
            return (native as any)(exe, args, opts, cb);
        });
        syncBuiltinESMExports();
        try {
            for (const interactive of [false, true]) {
                const result = await invoke(['enable-sync', '--config', path, ...(interactive ? ['--interactive-auth'] : [])]);
                assert.equal(result.code, 0, result.lines.join('\n'));
                assert.equal(result.lines.at(-1), 'auto');
                for (const suffix of ['', '-mirror']) {
                    assert.equal(JSON.parse(await readFile(join(privateDir, `send-manifest${suffix}.json`), 'utf8')).interactiveAuth, interactive);
                    assert.equal(JSON.parse(await readFile(join(privateDir, `receipt${suffix}.json`), 'utf8')).interactiveAuth, interactive);
                }
            }
            const log = appendRows('', [{ time: '2026-10-15T00:00:00.000Z', category: 'implementation', status: 'in_progress' }]);
            await writeFile(join(c.gitDir, 'WORKLOG.md'), log);
            await commitWorklog(c, createHash('sha256').update(log).digest('hex'));
            await pushSnapshot(c, await readSnapshot(c, await readState(privateDir), 0));
            assert.equal(pushes, 1);
            assert.deepEqual(remoteModes, ['never', 'never', 'always', 'always', 'never', 'never']);
            assert.equal(JSON.parse(await readFile(join(privateDir, 'send-manifest.json'), 'utf8')).interactiveAuth, false);
            assert.equal(JSON.parse(await readFile(join(privateDir, 'receipt.json'), 'utf8')).interactiveAuth, false);
            assert.equal((await loadConfig(path)).mode, 'auto');
        } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
});

test('bundled launcher installs without a compiler and rejects a partial or tampered bundle', async t => {
    await isolated(async root => {
        const app = join(root, 'app');
        const cli = join(app, 'dist', 'src', 'cli.js');
        await mkdir(dirname(cli), { recursive: true });
        const source = /const STARTUP_LAUNCHER = String.raw`([\s\S]*?)`;/u.exec(await readFile('src/transport.ts', 'utf8'))![1].replace(/\r\n?/g, '\n');
        const executable = Buffer.from('fixture compiler output, never executed');
        const sourcePath = join(app, 'startup-launcher.cs');
        const executablePath = join(app, 'startup-launcher.exe');
        let registrations = 0;
        t.mock.method(childProcess, 'execFile', (exe: string, args: string[], opts: any, cb: any) => {
            assert.equal(exe.endsWith('schtasks.exe'), true, 'bundled installation must not invoke a compiler or launcher');
            assert.equal(args[0], '/Create');
            registrations++;
            queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
            return {};
        });
        syncBuiltinESMExports();
        try {
            await writeFile(sourcePath, source);
            await writeFile(executablePath, executable);
            const privateDir = join(root, 'valid');
            await mkdir(privateDir);
            await manageStartup('install', cli, join(privateDir, 'config.json'));
            assert.equal(registrations, 1);
            assert.equal(await readFile(join(privateDir, 'startup-launcher.cs'), 'utf8'), source);
            assert.deepEqual(await readFile(join(privateDir, 'startup-launcher.exe')), executable);
            for (const mode of ['tampered', 'half-pair']) {
                const privateDir = join(root, mode);
                await mkdir(privateDir);
                if (mode === 'tampered') await writeFile(sourcePath, 'untrusted code');
                else { await writeFile(sourcePath, source); await rm(executablePath); }
                await assert.rejects(manageStartup('install', cli, join(privateDir, 'config.json')), { message: 'startup_conflict' });
                assert.deepEqual(await readdir(privateDir), []);
                assert.equal(registrations, 1);
            }
        } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
});
