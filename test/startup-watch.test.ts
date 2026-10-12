import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { manageStartup } from '../src/transport.js';

type Registration = { executable: string; args: string[]; options: any; xmlPath: string; xml: string; parsed?: { command: string; arguments: string } };
async function fixture(t: TestContext, failure = false) {
    const root = await mkdtemp(join(tmpdir(), "whativedone-startup-路径 & ' $-"));
    const registrations: Registration[] = [];
    let taskXml = '';
    const savedUser = process.env.USERNAME, savedDomain = process.env.USERDOMAIN;
    const nativeExecFile = childProcess.execFile;
    process.env.USERNAME = 'Watcher&User';
    process.env.USERDOMAIN = 'TEST-DOMAIN';
    t.mock.method(childProcess, 'execFile', (executable: string, args: string[], options: any, cb: any) => {
        if (executable.endsWith('csc.exe')) return (nativeExecFile as any)(executable, args, options, cb);
        assert.equal(executable, join(process.env.SystemRoot || 'C:/Windows', 'System32', 'schtasks.exe'));
        if (args.includes('/Query') || args.includes('/Delete') || args.includes('/Run')) {
            registrations.push({ executable, args, options, xmlPath: '', xml: taskXml });
            queueMicrotask(() => cb(null, Buffer.from(args.includes('/Query') ? taskXml : ''), Buffer.alloc(0)));
            return {};
        }
        const xmlPath = args.includes('/XML') ? args[args.indexOf('/XML') + 1] : '';
        void (xmlPath ? readFile(xmlPath) : Promise.resolve(Buffer.alloc(0))).then(bytes => {
            const xml = bytes.subarray(2).toString('utf16le');
            let parsed: Registration['parsed'];
            if (xmlPath) {
                assert.deepEqual([...bytes.subarray(0, 2)], [255, 254]);
                const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $doc = New-Object System.Xml.XmlDocument; $doc.Load($env:WHATIVEDONE_TEST_XML); $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable); $ns.AddNamespace("t", "http://schemas.microsoft.com/windows/2004/02/mit/task"); @{ command = $doc.SelectSingleNode("/t:Task/t:Actions/t:Exec/t:Command", $ns).InnerText; arguments = $doc.SelectSingleNode("/t:Task/t:Actions/t:Exec/t:Arguments", $ns).InnerText } | ConvertTo-Json -Compress';
                parsed = JSON.parse(execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, WHATIVEDONE_TEST_XML: xmlPath } }).trim());
            }
            registrations.push({ executable, args, options, xmlPath, xml, parsed });
            taskXml = xml;
            cb(failure ? Object.assign(new Error('PRIVATE_CANARY'), { code: 1 }) : null, Buffer.alloc(0), Buffer.alloc(0));
        }).catch(error => cb(error, Buffer.alloc(0), Buffer.alloc(0)));
        return {};
    });
    syncBuiltinESMExports();
    t.after(async () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        if (savedUser === undefined) delete process.env.USERNAME;
        else process.env.USERNAME = savedUser;
        if (savedDomain === undefined) delete process.env.USERDOMAIN;
        else process.env.USERDOMAIN = savedDomain;
        assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
        await rm(root, { recursive: true, force: true });
    });
    return { root, cliPath: join(root, 'cli.js'), configPath: join(root, 'config.json'), registrations, setTaskXml: (xml: string) => { taskXml = xml; } };
}

// An omitted time limit/battery policy would stop the watcher despite a valid logon trigger.
test('startup registers a per-user watcher without runtime or battery termination', async t => {
    const f = await fixture(t);
    await manageStartup('install', f.cliPath, f.configPath);
    assert.equal(f.registrations.length, 1);
    const registration = f.registrations[0];
    assert.ok(registration.args.includes('/XML'), 'startup must supply explicit task settings');
    assert.equal(registration.args.includes('/F'), false);
    assert.equal(registration.args.includes('/TR'), false);
    assert.match(registration.args[registration.args.indexOf('/TN') + 1], /^WhatIveDone-[a-f0-9]{16}$/);
    assert.equal(dirname(registration.xmlPath), f.root);
    assert.ok(Buffer.byteLength(registration.xml) < 16 * 1024);
    assert.match(registration.xml, /<LogonTrigger><Enabled>true<\/Enabled><ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit><UserId>TEST-DOMAIN\\Watcher&amp;User<\/UserId><\/LogonTrigger>/);
    assert.match(registration.xml, /<Principal id="Watcher"><UserId>TEST-DOMAIN\\Watcher&amp;User<\/UserId><LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel><\/Principal>/);
    for (const element of [
        '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '<Hidden>true</Hidden>',
        '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
    ]) assert.ok(registration.xml.includes(element), element);
    assert.match(registration.xml, /<Actions Context="Watcher"><Exec><Command>/);
    const command = /<Command>([^<]*)<\/Command>/.exec(registration.xml)![1];
    assert.equal(command.replaceAll('&amp;', '&').replaceAll('&apos;', "'"), join(f.root, 'startup-launcher.exe'));
    const argumentsText = /<Arguments>([^<]*)<\/Arguments>/.exec(registration.xml)![1];
    assert.deepEqual(registration.parsed, { command: join(f.root, 'startup-launcher.exe'), arguments: `"${process.execPath}" "${f.cliPath}" "${f.configPath}"` });
    const executable = await readFile(join(f.root, 'startup-launcher.exe'));
    const peOffset = executable.readUInt32LE(0x3c);
    assert.equal(executable.readUInt32LE(peOffset), 0x00004550);
    assert.equal(executable.readUInt16LE(peOffset + 4 + 20 + 68), 2, 'launcher must use the GUI subsystem and allocate no parent console');
    assert.equal(registration.options.shell, false);
    assert.equal(registration.options.windowsHide, true);
    assert.deepEqual((await readdir(f.root)).sort(), ['startup-launcher.cs', 'startup-launcher.exe']);
});

// Wrong Windows/PowerShell quoting would launch the wrong argv; detaching would lose the child exit code.
test('hidden startup action passes literal paths and waits for the child exit code', async t => {
    const f = await fixture(t);
    const output = join(f.root, 'argv.json');
    await writeFile(f.cliPath, `console.log('fixture status'); process.stdin.resume(); require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); process.exit(7);`);
    await manageStartup('install', f.cliPath, f.configPath);
    const action = f.registrations[0].parsed!;
    const launch = '$s = New-Object System.Diagnostics.ProcessStartInfo; $s.FileName = $env:WHATIVEDONE_TEST_COMMAND; $s.Arguments = $env:WHATIVEDONE_TEST_ARGUMENTS; $s.UseShellExecute = $true; $s.WindowStyle = "Hidden"; $p = [System.Diagnostics.Process]::Start($s); $p.WaitForExit(); exit $p.ExitCode';
    assert.throws(() => execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', launch], {
        windowsHide: true, timeout: 10000, env: { ...process.env, WHATIVEDONE_TEST_COMMAND: action.command, WHATIVEDONE_TEST_ARGUMENTS: action.arguments }
    }), (error: any) => { assert.equal(error.status, 7, String(error.stderr)); return true; });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['sync', '--watch', '--config', f.configPath]);
});

// A failed process start must remain a scheduler failure rather than exit with a null child status.
test('hidden startup action reports a process start failure as nonzero', async t => {
    const f = await fixture(t);
    await manageStartup('install', f.cliPath, f.configPath);
    const action = f.registrations[0].parsed!;
    const argumentsText = action.arguments.replace(process.execPath, join(f.root, 'missing-node.exe'));
    const launch = '$s = New-Object System.Diagnostics.ProcessStartInfo; $s.FileName = $env:WHATIVEDONE_TEST_COMMAND; $s.Arguments = $env:WHATIVEDONE_TEST_ARGUMENTS; $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $s.RedirectStandardError = $true; $p = [System.Diagnostics.Process]::Start($s); $null = $p.StandardError.ReadToEnd(); $p.WaitForExit(); exit $p.ExitCode';
    assert.throws(() => execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', launch], {
        windowsHide: true, timeout: 10000, env: { ...process.env, WHATIVEDONE_TEST_COMMAND: action.command, WHATIVEDONE_TEST_ARGUMENTS: argumentsText }
    }), (error: any) => error.status === 1);
});

// A different PowerShell command must not be deleted merely because it has the owned task name.
test('startup removes its exact hidden action and refuses an edited wrapper', async t => {
    const f = await fixture(t);
    await manageStartup('install', f.cliPath, f.configPath);
    const original = f.registrations[0].xml;
    f.setTaskXml(original.replace('startup-launcher.exe', 'other.exe'));
    await assert.rejects(manageStartup('remove', f.cliPath, f.configPath), { message: 'startup_conflict' });
    assert.equal(f.registrations.some(x => x.args.includes('/Delete')), false);
    f.setTaskXml(original);
    await manageStartup('remove', f.cliPath, f.configPath);
    assert.equal(f.registrations.at(-1)!.args.includes('/Delete'), true);
});

// Registration alone waits until the next logon; start must run only the owned action.
test('startup starts its exact hidden action and refuses edited or extra actions', async t => {
    const f = await fixture(t);
    await manageStartup('install', f.cliPath, f.configPath);
    const original = f.registrations[0].xml;
    for (const changed of [original.replace('startup-launcher.exe', 'other.exe'), original.replace('config.json', 'other-config.json'), original.replace('</Actions>', '<Exec><Command>other.exe</Command></Exec></Actions>')]) {
        f.setTaskXml(changed);
        await assert.rejects(manageStartup('start', f.cliPath, f.configPath), { message: 'startup_conflict' });
        assert.equal(f.registrations.some(x => x.args.includes('/Run')), false);
    }
    f.setTaskXml(original);
    await manageStartup('start', f.cliPath, f.configPath);
    assert.deepEqual(f.registrations.at(-1)!.args, ['/Run', '/TN', f.registrations[0].args[f.registrations[0].args.indexOf('/TN') + 1]]);
});

// A rejected OS registration must not leave task XML or expose native error output.
test('failed startup registration removes its private task definition and returns a fixed error', async t => {
    const f = await fixture(t, true);
    await assert.rejects(manageStartup('install', f.cliPath, f.configPath), { message: 'transport_failed' });
    assert.ok(f.registrations[0].xmlPath, 'registration must use private XML');
    assert.deepEqual((await readdir(f.root)).sort(), ['startup-launcher.cs', 'startup-launcher.exe']);
});

test('startup refuses an unknown existing launcher source before compiling or registering', async t => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'startup-launcher.cs'), 'PRIVATE_CANARY');
    await assert.rejects(manageStartup('install', f.cliPath, f.configPath), { message: 'startup_conflict' });
    assert.deepEqual(f.registrations, []);
    assert.equal(await readFile(join(f.root, 'startup-launcher.cs'), 'utf8'), 'PRIVATE_CANARY');
    assert.deepEqual(await readdir(f.root), ['startup-launcher.cs']);
});
