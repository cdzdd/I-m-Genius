import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const script = resolve('installer/Install.ps1');
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-installer-'));
    const bundle = join(root, 'bundle');
    const files: Record<string, string> = { 'payload/node.exe': 'fake-node', 'payload/app/dist/src/cli.js': 'fake-cli' };
    for (const [path, body] of Object.entries(files)) {
        await mkdir(resolve(bundle, path, '..'), { recursive: true });
        await writeFile(join(bundle, path), body);
    }
    await mkdir(join(bundle, 'installer'));
    await copyFile(script, join(bundle, 'installer/Install.ps1'));
    await writeFile(join(bundle, 'Install.cmd'), '@echo off');
    files['Install.cmd'] = '@echo off';
    files['installer/Install.ps1'] = await readFile(script, 'utf8');
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ version: '0.2.0', files: Object.entries(files).map(([path, body]) => ({ path, sha256: createHash('sha256').update(body).digest('hex') })) }));
    return { root, bundle, program: join(root, 'program'), data: join(root, 'private') };
}
function ps(body: string) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); . ${q(script)} -LibraryOnly; ${body}; exit 0`], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PSModulePath: join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
}
test('installer validates exact payload, copies to a fresh target, and refuses unknown directories', async () => {
    const f = await fixture();
    try {
        ps(`Install-Payload ${q(f.bundle)} ${q(f.program)}; try { Install-Payload ${q(f.bundle)} ${q(f.program)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw } }`);
        assert.equal(await readFile(join(f.program, 'payload/app/dist/src/cli.js'), 'utf8'), 'fake-cli');
        await writeFile(join(f.bundle, 'payload/extra'), 'extra');
        assert.equal(ps(`try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`), 'rejected');
        await rm(join(f.bundle, 'payload/extra'));
        await writeFile(join(f.bundle, 'payload/node.exe'), 'tampered');
        assert.equal(ps(`try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`), 'rejected');
        await writeFile(join(f.bundle, 'payload/node.exe'), 'fake-node');
        await writeFile(join(f.bundle, 'Install.cmd'), 'tampered entry');
        assert.equal(ps(`try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`), 'rejected');
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('installer rejects traversal, duplicate entries, and reparse points before executing', async () => {
    const f = await fixture();
    try {
        const manifest = JSON.parse(await readFile(join(f.bundle, 'manifest.json'), 'utf8'));
        for (const path of ['../outside', '/absolute', 'app\\escape', 'app/a:ads', 'app/CON', 'app/a.']) {
            await writeFile(join(f.bundle, 'manifest.json'), JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], path }, manifest.files[1]] }));
            assert.equal(ps(`try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`), 'rejected');
        }
        await writeFile(join(f.bundle, 'manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
        assert.equal(ps(`try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`), 'rejected');
        await writeFile(join(f.bundle, 'manifest.json'), JSON.stringify(manifest));
        await mkdir(f.data);
        ps(`New-Item -ItemType Junction -Path ${q(join(f.bundle, 'payload/link'))} -Target ${q(f.data)} -Force | Out-Null; try { Assert-Payload ${q(f.bundle)}; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; 'rejected' }`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('native argv roundtrips spaces, quotes, metacharacters and trailing backslashes without a shell', () => {
    const args = ['', 'a b', 'a"b', 'a\\', 'a b\\', 'a\\"b', 'x & y $(canary)', '中文'];
    const output = ps(`$r=Invoke-Native ${q(process.execPath)} @('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--',${args.map(q).join(',')}); $r`);
    assert.deepEqual(JSON.parse(output), args);
    assert.deepEqual(JSON.parse(ps(`Invoke-Native ${q(process.execPath)} @('-e','process.stdout.write(JSON.stringify({configPath:"C:/用户/日志/config.json",authorName:"测试作者"}))')`)), { configPath: 'C:/用户/日志/config.json', authorName: '测试作者' });
    assert.equal(ps(`try { Invoke-Native ${q(process.execPath)} @('-e','process.stderr.write("SECRET_CANARY");process.exit(1)'); throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; $_.Exception.Message }`), 'The setup command failed.');
    assert.equal(ps(`try { Invoke-Native ${q(process.execPath)} @('-e','process.stderr.write("x".repeat(1000000))'); throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; $_.Exception.Message }`), 'The setup command failed.');
    assert.equal(ps(`try { Invoke-Native ${q(process.execPath)} @('-e','setTimeout(()=>{},10000)') 1; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') { throw }; $_.Exception.Message }`), 'The setup command timed out.');
});
test('orchestration preflights first, uses canonical init path, records local failure and never repeats init', async () => {
    const f = await fixture();
    try {
        const canonical = join(f.root, 'canonical.json');
        await writeFile(canonical, JSON.stringify({ mode: 'local' }));
        const body = `$calls=New-Object System.Collections.Generic.List[string]; $invoke={ param($root,$arguments) $calls.Add(($arguments -join '|')); switch ($arguments[0]) { 'setup-check' { '{"ready":true}' } 'init' { ${q(JSON.stringify({ configPath: canonical, mode: 'local' }))} } 'enable-sync' { throw 'SECRET_CANARY' } } }; $options=@{ Repo='https://example.invalid/r.git'; Mirror=''; Name='A Name'; Email='a@example.invalid'; Sources=@('codex'); Auto=$true }; $r=Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} $options $invoke; $r=Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} $options $invoke; $calls | ConvertTo-Json -Compress`;
        const calls: string[] = JSON.parse(ps(body));
        assert.equal(calls.filter(c => c.startsWith('init|')).length, 1);
        assert.equal(calls[0].startsWith('setup-check|'), true);
        assert.equal(calls.filter(c => c.startsWith('enable-sync|')).length, 2);
        assert.equal(calls.some(c => c === `enable-sync|--config|${canonical}|--interactive-auth`), true);
        const receipt = JSON.parse(await readFile(join(f.program, 'install-receipt.json'), 'utf8'));
        assert.equal(receipt.stage, 'initialized');
        assert.equal(receipt.configPath, canonical);
        assert.equal(JSON.stringify(receipt).includes('SECRET_CANARY'), false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('failed preflight preserves existing data and never initializes; failed init stays incomplete', async () => {
    const f = await fixture();
    try {
        await mkdir(f.data);
        await writeFile(join(f.data, 'keep'), 'original');
        ps(`$invoke={throw 'preflight failed'}; try { Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} @{} $invoke; throw 'accepted' } catch { if ($_.Exception.Message -eq 'accepted') {throw} }`);
        assert.equal(await readFile(join(f.data, 'keep'), 'utf8'), 'original');
        await assert.rejects(stat(f.program), { code: 'ENOENT' });
        await rm(f.data, { recursive: true });
        ps(`$invoke={param($root,$arguments) if ($arguments[0] -eq 'setup-check') {'{"ready":true}'} else {throw 'init failed'}}; try { Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} @{Repo='r'; Name='n'; Email='e'; Sources=@('codex'); Auto=$false} $invoke; throw 'accepted' } catch {if ($_.Exception.Message -eq 'accepted') {throw}}`);
        assert.equal(JSON.parse(await readFile(join(f.program, 'install-receipt.json'), 'utf8')).stage, 'copied');
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('local setup finishes without authentication, initializes only at the permanent location, and reruns without init', async () => {
    const f = await fixture();
    try {
        const canonical = join(f.root, 'canonical.json');
        await writeFile(canonical, '{"mode":"local"}');
        const output = ps(`$calls=New-Object System.Collections.Generic.List[string]; $invoke={param($root,$arguments) $calls.Add($arguments[0]); if ($arguments[0] -eq 'setup-check') {'{"ready":true}'} elseif ($arguments[0] -eq 'init' -and $root -eq ${q(f.program)}) {${q(JSON.stringify({ configPath: canonical }))}} else {throw 'unexpected command'}}; $options=@{Repo='https://example.invalid/r.git';Name='Name';Email='a@example.invalid';Sources=@('codex');Auto=$false}; $r=Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} $options $invoke; $r=Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} $options $invoke; $calls | ConvertTo-Json -Compress`);
        assert.deepEqual(JSON.parse(output), ['setup-check', 'init']);
        const receipt = JSON.parse(await readFile(join(f.program, 'install-receipt.json'), 'utf8'));
        assert.equal(receipt.stage, 'complete');
        assert.equal(receipt.autoSyncRequested, false);
        const enable = ps(`$invoke={param($root,$arguments) if ($arguments[0] -ne 'enable-sync' -or $arguments[2] -ne ${q(canonical)} -or $arguments[3] -ne '--interactive-auth') {throw 'unexpected command'}; 'auto'}; $r=Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} @{Auto=$true} $invoke; $r | ConvertTo-Json -Compress`);
        assert.equal(JSON.parse(enable).stage, 'complete');
        assert.equal(JSON.parse(enable).autoSyncRequested, true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('fresh setup requires at least one supported native client before preflight or copying', async () => {
    const f = await fixture();
    try {
        const result = ps(`$invoke={throw 'should not execute'}; foreach ($options in @(@{},@{Sources=@()},@{Sources=@('unknown')})) { try { Invoke-Installation ${q(f.bundle)} ${q(f.program)} ${q(f.data)} $options $invoke; throw 'accepted' } catch {if ($_.Exception.Message -eq 'accepted') {throw}; $_.Exception.Message} }`);
        assert.deepEqual(result.split(/\r?\n/), Array(3).fill('Select at least one supported client.'));
        await assert.rejects(stat(f.program), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('UTF8 receipts preserve canonical Unicode paths and saved configuration identity on reruns', async () => {
    const f = await fixture();
    try {
        const canonical = join(f.root, '用户-日志.json');
        await writeFile(canonical, JSON.stringify({ mode: 'local', authorName: '测试作者', remoteUrl: 'https://example.invalid/r.git' }));
        const result = ps(`Install-Payload ${q(f.bundle)} ${q(f.program)}; Write-Receipt ${q(f.program)} ([pscustomobject]@{schemaVersion=1;version='0.2.0';stage='complete';autoSyncRequested=$false;configPath=${q(canonical)}}); $r=Read-Receipt ${q(f.program)}; @($r.configPath,(Read-SetupJson $r.configPath).authorName) | ConvertTo-Json -Compress`);
        assert.deepEqual(JSON.parse(result), [canonical, '测试作者']);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('Start menu shortcut uses only the permanent entry and current-user directory', async () => {
    const f = await fixture();
    try {
        const roaming = join(f.root, 'roaming');
        const result = ps(`$env:APPDATA=${q(roaming)}; Install-Payload ${q(f.bundle)} ${q(f.program)}; Add-StartMenuShortcut ${q(f.program)}; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut((Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/I-m-Genius.lnk')); @($link.TargetPath,$link.WorkingDirectory,$link.Arguments) | ConvertTo-Json -Compress`);
        assert.deepEqual(JSON.parse(result), [join(f.program, 'Install.cmd'), f.program, '']);
        assert.equal(ps(`$env:APPDATA=${q(roaming)}; $shell=New-Object -ComObject WScript.Shell; $path=Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/I-m-Genius.lnk'; $link=$shell.CreateShortcut($path); $link.TargetPath=Join-Path $env:WINDIR 'notepad.exe'; $link.Save(); try { Add-StartMenuShortcut ${q(f.program)}; throw 'accepted' } catch {if ($_.Exception.Message -eq 'accepted') {throw}; $_.Exception.Message}`), 'The Start menu shortcut requires manual review.');
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('WinForms gates detection and nested events, restores preflight retries, and blocks incomplete copies', async () => {
    const f = await fixture();
    try {
        const harness = `
        . ${q(join(f.bundle, 'installer/Install.ps1'))} -LibraryOnly
        Add-Type -AssemblyName System.Windows.Forms
        $env:LOCALAPPDATA=${q(join(f.root, 'local'))}; $env:APPDATA=${q(join(f.root, 'roaming'))}
        $guiImage=${q(process.env.WHATIVEDONE_INSTALLER_UI_IMAGE || '')}
        $script:guiResult=@{infoCalls=0;detectionGated=$true;busyGated=$true;stableStatus=$true;nestedCalls=0;retryRestored=$false;recovered=$false;uploadRetried=$false;copyBlocked=$false}
        function Gui-Controls {
            $script:guiForm=[Windows.Forms.Application]::OpenForms[0]
            $script:guiFields=@($guiForm.Controls | Where-Object {$_ -is [Windows.Forms.TextBox]})
            $script:guiChecks=@($guiForm.Controls | Where-Object {$_ -is [Windows.Forms.CheckBox]})
            $script:guiAction=@($guiForm.Controls | Where-Object {$_ -is [Windows.Forms.Button] -and $_.Top -eq 535 -and $_.Left -eq 22})[0]
            $script:guiStatus=@($guiForm.Controls | Where-Object {$_.Top -eq 442})[0]
        }
        function Force-GuiClick { $method=$guiAction.GetType().GetMethod('OnClick',[Reflection.BindingFlags]'Instance,NonPublic'); $null=$method.Invoke($guiAction,@([EventArgs]::Empty)) }
        function Invoke-SetupCli {
            $guiResult.infoCalls++
            Gui-Controls
            $guiResult.detectionGated=$guiResult.detectionGated -and !$guiAction.Enabled -and !@($guiFields+$guiChecks | Where-Object {$_.Enabled}).Count
            Force-GuiClick
            '{"gitAvailable":true,"codexAvailable":true,"claudeAvailable":false,"authorName":"","authorEmail":""}'
        }
        function Add-StartMenuShortcut {}
        function Invoke-Installation {
            param($Bundle,$Program,$Data,$Options)
            if ($script:guiInside) { $guiResult.nestedCalls++; throw 'Nested operation.' }
            $script:guiInside=$true; $script:guiCalls++
            try {
                Gui-Controls
                $guiResult.busyGated=$guiResult.busyGated -and !$guiAction.Enabled -and !@($guiFields+$guiChecks | Where-Object {$_.Enabled}).Count -and !$guiForm.ControlBox
                $before=$guiStatus.Text
                foreach ($check in $guiChecks) { $check.Checked=!$check.Checked; $check.Checked=!$check.Checked }
                [Windows.Forms.Application]::DoEvents()
                $guiResult.stableStatus=$guiResult.stableStatus -and $guiStatus.Text -eq $before -and !$guiAction.Enabled
                Force-GuiClick
                if ($script:guiScenario -eq 'copied') { $script:setupPhase='program copy'; New-Item -ItemType Directory -Path $Program -Force | Out-Null; throw 'Failed after copy.' }
                if ($guiCalls -eq 1) { $script:setupPhase='preflight'; throw 'Invalid preflight fields.' }
                [pscustomobject]@{stage='complete';autoSyncRequested=($guiCalls -gt 2);configPath=${q(join(f.root, 'fake-config.json'))}}
            } finally {$script:guiInside=$false}
        }
        foreach ($scenario in @('recover','copied')) {
            $script:guiScenario=$scenario; $script:guiCalls=0; $script:guiInside=$false
            $timer=New-Object Windows.Forms.Timer; $timer.Interval=100
            $timer.Add_Tick({
                $timer.Stop(); Gui-Controls
                $guiAction.PerformClick()
                if ($guiScenario -eq 'recover') {
                    $guiResult.retryRestored=$guiAction.Enabled -and !@($guiFields | Where-Object {!$_.Enabled}).Count
                    if ($guiImage) {
                        $bitmap=New-Object Drawing.Bitmap($guiForm.Width,$guiForm.Height)
                        $guiForm.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$guiForm.Width,$guiForm.Height)))
                        $bitmap.Save($guiImage,[Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()
                    }
                    foreach ($field in $guiFields) { $field.Text='corrected' }
                    $guiAction.PerformClick()
                    $guiResult.recovered=$guiCalls -eq 2 -and $guiAction.Text -eq 'Enable upload'
                    $autoCheck=@($guiChecks | Where-Object {$_.Text.StartsWith('Enable automatic')})[0]
                    $autoCheck.Checked=$true; $guiAction.PerformClick()
                    $guiResult.uploadRetried=$guiCalls -eq 3
                } else {
                    foreach ($check in $guiChecks) {$check.Checked=!$check.Checked}
                    Force-GuiClick
                    $guiResult.copyBlocked=$guiCalls -eq 1 -and !$guiAction.Enabled -and !@($guiFields+$guiChecks | Where-Object {$_.Enabled}).Count
                }
                $guiForm.Close()
            })
            $timer.Start(); Show-Installer; $timer.Dispose()
        }
        $guiResult | ConvertTo-Json -Compress`;
        const result = JSON.parse(ps(harness));
        assert.deepEqual(result, { infoCalls: 2, detectionGated: true, busyGated: true, stableStatus: true, nestedCalls: 0, retryRestored: true, recovered: true, uploadRetried: true, copyBlocked: true });
    } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('double-click entry isolates PowerShell 5 modules from an inherited PowerShell 7 environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-entry-'));
    try {
        await mkdir(join(root, 'installer'));
        await copyFile(resolve('Install.cmd'), join(root, 'Install.cmd'));
        await writeFile(join(root, 'installer/Install.ps1'), '[pscustomobject]@{modulePath=$env:PSModulePath;version=$PSVersionTable.PSVersion.ToString();apartment=[Threading.Thread]::CurrentThread.ApartmentState.ToString()} | ConvertTo-Json -Compress');
        const result = spawnSync(join(process.env.SystemRoot!, 'System32/cmd.exe'), ['/d', '/c', 'Install.cmd'], { cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, PSModulePath: join(root, 'incompatible-powershell7-modules') } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const info = JSON.parse(result.stdout.trim());
        assert.equal(info.modulePath.split(';').includes(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules')), true);
        assert.equal(info.modulePath.includes('incompatible-powershell7-modules'), false);
        assert.equal(info.version.startsWith('5.1.'), true);
        assert.equal(info.apartment, 'STA');
    } finally { await rm(root, { recursive: true, force: true }); }
});
