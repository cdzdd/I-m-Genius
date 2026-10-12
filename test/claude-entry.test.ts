import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerClientMcp, removeClientMcp } from '../src/transport.js';

test('Claude MCP uses the installed packaged entry and preserves scope, server argv and profile environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-claude-entry-'));
    const saved = { ...process.env };
    const native = childProcess.execFile;
    const calls: { exe: string; args: string[]; options: any }[] = [];
    const pkg = join(root, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    process.env.APPDATA = root;
    process.env.CODEX_HOME = join(root, 'codex-profile');
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-profile');
    (childProcess as any).execFile = (exe: string, args: string[], options: any, cb: any) => {
        calls.push({ exe, args, options });
        queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
        return {};
    };
    syncBuiltinESMExports();
    try {
        const cli = join(root, 'server.js');
        for (const entry of ['cli.js', 'bin/claude.exe']) {
            await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: entry === 'cli.js' ? '2.1.92' : '2.1.295', bin: { claude: entry } }));
            await writeFile(join(pkg, entry), 'fake entry, never executed');
            calls.length = 0;
            await registerClientMcp('claude', cli);
            await removeClientMcp('claude');
            const prefix = entry === 'cli.js' ? [join(pkg, 'cli.js')] : [];
            assert.equal(calls[0].exe, entry === 'cli.js' ? process.execPath : join(pkg, 'bin', 'claude.exe'));
            assert.equal(calls[1].exe, calls[0].exe);
            assert.deepEqual(calls[0].args, [...prefix, 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'whativedone', '--', process.execPath, cli, 'mcp']);
            assert.deepEqual(calls[1].args, [...prefix, 'mcp', 'remove', '--scope', 'user', 'whativedone']);
            for (const call of calls) {
                assert.equal(call.options.env.CODEX_HOME, process.env.CODEX_HOME);
                assert.equal(call.options.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
                assert.equal(call.options.shell, false);
                assert.equal(call.options.windowsHide, true);
            }
        }
        for (const bin of ['../other.exe', 'bin/../../other.exe', join(root, 'other.exe'), 'other.js', 'bin/other.exe', undefined]) {
            await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: bin } }));
            calls.length = 0;
            await assert.rejects(registerClientMcp('claude', cli), /invalid_client/);
            await assert.rejects(removeClientMcp('claude'), /invalid_client/);
            assert.equal(calls.length, 0);
        }
        await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
        await rm(join(pkg, 'bin', 'claude.exe'));
        calls.length = 0;
        await assert.rejects(removeClientMcp('claude'), /invalid_client/);
        assert.equal(calls.length, 0);
        await rm(join(pkg, 'bin'), { recursive: true });
        await mkdir(join(root, 'external'));
        await writeFile(join(root, 'external', 'claude.exe'), 'external executable');
        await symlink(join(root, 'external'), join(pkg, 'bin'), 'junction');
        await assert.rejects(removeClientMcp('claude'), /invalid_client/);
        assert.equal(calls.length, 0);
    } finally {
        childProcess.execFile = native;
        syncBuiltinESMExports();
        process.env = saved;
        await rm(root, { recursive: true, force: true });
    }
});
