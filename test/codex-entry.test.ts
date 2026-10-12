import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerClientMcp, removeClientMcp } from '../src/transport.js';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-codex-entry-'));
    const saved = { ...process.env };
    const calls: { exe: string; args: string[]; options: any }[] = [];
    process.env.APPDATA = root;
    process.env.LOCALAPPDATA = join(root, 'local');
    process.env.CODEX_HOME = join(root, 'codex-profile');
    t.mock.method(childProcess, 'execFile', (exe: string, args: string[], options: any, cb: any) => {
        calls.push({ exe, args, options });
        queueMicrotask(() => cb(null, Buffer.alloc(0), Buffer.alloc(0)));
        return {};
    });
    syncBuiltinESMExports();
    t.after(async () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        process.env = saved;
        assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
        await rm(root, { recursive: true, force: true });
    });
    const pkg = join(root, 'npm', 'node_modules', '@openai', 'codex');
    const desktop = join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const cli = join(root, 'server.js');
    await mkdir(join(pkg, 'bin'), { recursive: true });
    return { root, pkg, desktop, cli, calls };
}

// Missing desktop installations must still register through the documented npm install.
test('Codex MCP registers and removes through the standard npm package entry', async t => {
    const f = await fixture(t);
    const entry = join(f.pkg, 'bin', 'codex.js');
    await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    await writeFile(entry, 'fixture entry, never executed');
    await registerClientMcp('codex', f.cli);
    await removeClientMcp('codex');
    assert.deepEqual(f.calls.map(call => call.exe), [process.execPath, process.execPath]);
    assert.deepEqual(f.calls[0].args, [entry, 'mcp', 'add', 'whativedone', '--', process.execPath, f.cli, 'mcp']);
    assert.deepEqual(f.calls[1].args, [entry, 'mcp', 'remove', 'whativedone']);
    for (const call of f.calls) {
        assert.equal(call.options.env.CODEX_HOME, process.env.CODEX_HOME);
        assert.equal(call.options.shell, false);
        assert.equal(call.options.windowsHide, true);
    }
    await mkdir(dirname(f.desktop), { recursive: true });
    await writeFile(f.desktop, 'fixture executable, never executed');
    f.calls.length = 0;
    await registerClientMcp('codex', f.cli);
    assert.equal(f.calls[0].exe, f.desktop);
    assert.deepEqual(f.calls[0].args, ['mcp', 'add', 'whativedone', '--', process.execPath, f.cli, 'mcp']);
});

// Arbitrary package mappings, absent entry files and junctions must never execute a client.
test('Codex MCP rejects missing, unknown and redirected installed entries before execution', async t => {
    const f = await fixture(t);
    const entry = join(f.pkg, 'bin', 'codex.js');
    await writeFile(entry, 'fixture entry, never executed');
    for (const bin of ['../other.exe', 'other.js', 'bin/other.js', undefined]) {
        await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ bin: { codex: bin } }));
        await assert.rejects(registerClientMcp('codex', f.cli), /invalid_client/);
        await assert.rejects(removeClientMcp('codex'), /invalid_client/);
    }
    await writeFile(join(f.pkg, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
    await rm(entry);
    await assert.rejects(registerClientMcp('codex', f.cli), /invalid_client/);
    await rm(join(f.pkg, 'bin'), { recursive: true });
    const external = join(f.root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'codex.js'), 'external entry');
    await symlink(external, join(f.pkg, 'bin'), 'junction');
    await assert.rejects(removeClientMcp('codex'), /invalid_client/);
    await mkdir(dirname(dirname(f.desktop)), { recursive: true });
    await writeFile(join(external, 'codex.exe'), 'external executable');
    await symlink(external, dirname(f.desktop), 'junction');
    await assert.rejects(registerClientMcp('codex', f.cli), /invalid_client/);
    assert.equal(f.calls.length, 0);
});
