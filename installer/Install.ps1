#Requires -Version 5.1
param([switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'

function Read-SetupJson([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Assert-PlainPath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe installation path.' }
}

function Get-BundleFiles([string]$Root, [string]$Relative = '') {
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root $Relative) -Force) {
        Assert-PlainPath $item.FullName
        $name = ($Relative + '/' + $item.Name).TrimStart('/')
        if ($item.PSIsContainer) { Get-BundleFiles $Root $name }
        else { $name }
    }
}

function Assert-Payload([string]$Root, [switch]$Owned) {
    Assert-PlainPath $Root
    Assert-PlainPath (Join-Path $Root 'manifest.json')
    $manifest = Read-SetupJson (Join-Path $Root 'manifest.json')
    if ($manifest.version -cne '0.2.0' -or !$manifest.files -or $manifest.files.Count -lt 4) { throw 'Invalid installation manifest.' }
    $expected = @{}
    foreach ($file in $manifest.files) {
        $path = [string]$file.path
        if (!$path -or $path -match '[\\:]' -or $path.StartsWith('/') -or $path.EndsWith('/')) { throw 'Invalid installation manifest.' }
        foreach ($part in $path.Split('/')) {
            if (!$part -or $part -in @('.', '..') -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') { throw 'Invalid installation manifest.' }
        }
        if ($path -in @('manifest.json', 'install-receipt.json') -or $expected.ContainsKey($path) -or [string]$file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid installation manifest.' }
        $expected[$path] = $file.sha256
    }
    foreach ($required in @('Install.cmd', 'installer/Install.ps1', 'payload/node.exe', 'payload/app/dist/src/cli.js')) {
        if (!$expected.ContainsKey($required)) { throw 'Incomplete installation bundle.' }
    }
    $actual = @(Get-BundleFiles $Root | Where-Object { $_ -cne 'manifest.json' -and !($Owned -and $_ -ceq 'install-receipt.json') })
    if ($actual.Count -ne $expected.Count) { throw 'Installation inventory mismatch.' }
    foreach ($path in $actual) {
        if (!$expected.ContainsKey($path) -or (Get-FileHash -LiteralPath (Join-Path $Root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[$path]) { throw 'Installation checksum mismatch.' }
    }
}

function Install-Payload([string]$Bundle, [string]$Program) {
    Assert-Payload $Bundle
    if (Test-Path -LiteralPath $Program) { throw 'An existing program directory requires manual review.' }
    $parent = Split-Path -Parent $Program
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-PlainPath $parent
    New-Item -ItemType Directory -Path $Program | Out-Null
    foreach ($name in @('Install.cmd', 'installer', 'payload', 'manifest.json')) {
        Copy-Item -LiteralPath (Join-Path $Bundle $name) -Destination $Program -Recurse
    }
    Assert-Payload $Program
}

function ConvertTo-NativeArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '\\+$', '$0$0')
    return '"' + $escaped + '"'
}

function Invoke-Native([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 180) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $File
    $start.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $start.WorkingDirectory = Split-Path -Parent $File
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (!$process.Start()) { throw 'The setup command failed.' }
        $outBuffer = New-Object char[] 4096; $errBuffer = New-Object char[] 4096
        $out = $process.StandardOutput.ReadAsync($outBuffer, 0, 4096)
        $err = $process.StandardError.ReadAsync($errBuffer, 0, 4096)
        $stdout = New-Object Text.StringBuilder
        $errorLength = 0; $outDone = $false; $errDone = $false
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (!$process.HasExited -or !$outDone -or !$errDone) {
            if ($timer.Elapsed.TotalSeconds -gt $TimeoutSeconds) { if (!$process.HasExited) { $process.Kill() }; throw 'The setup command timed out.' }
            if (!$outDone -and $out.IsCompleted) {
                $count = $out.GetAwaiter().GetResult()
                if ($stdout.Length + $count -gt 65536) { if (!$process.HasExited) { $process.Kill() }; throw 'The setup command failed.' }
                if ($count) { $null = $stdout.Append($outBuffer, 0, $count); $out = $process.StandardOutput.ReadAsync($outBuffer, 0, 4096) } else { $outDone = $true }
            }
            if (!$errDone -and $err.IsCompleted) {
                $count = $err.GetAwaiter().GetResult(); $errorLength += $count
                if ($errorLength -gt 65536) { if (!$process.HasExited) { $process.Kill() }; throw 'The setup command failed.' }
                if ($count) { $err = $process.StandardError.ReadAsync($errBuffer, 0, 4096) } else { $errDone = $true }
            }
            if ('System.Windows.Forms.Application' -as [type]) { [Windows.Forms.Application]::DoEvents() }
            Start-Sleep -Milliseconds 10
        }
        if ($process.ExitCode -ne 0) { throw 'The setup command failed.' }
        return $stdout.ToString().Trim()
    } catch { if ($_.Exception.Message -eq 'The setup command timed out.') { throw }; throw 'The setup command failed.' }
    finally { try { if (!$process.HasExited) { $process.Kill() } } catch {}; $process.Dispose() }
}

function Invoke-SetupCli([string]$Root, [string[]]$Arguments) {
    Invoke-Native (Join-Path $Root 'payload/node.exe') (@((Join-Path $Root 'payload/app/dist/src/cli.js')) + $Arguments)
}

function Write-Receipt([string]$Program, $Receipt) {
    $path = Join-Path $Program 'install-receipt.json'
    [IO.File]::WriteAllText(($path + '.tmp'), ($Receipt | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath ($path + '.tmp') -Destination $path -Force
}

function Read-Receipt([string]$Program) {
    Assert-PlainPath $Program
    $path = Join-Path $Program 'install-receipt.json'
    Assert-PlainPath $path
    $receipt = Read-SetupJson $path
    if ($receipt.schemaVersion -ne 1 -or $receipt.version -cne '0.2.0' -or $receipt.stage -cnotin @('copied', 'initialized', 'complete') -or $receipt.autoSyncRequested -isnot [bool]) { throw 'The existing installation requires manual review.' }
    if ($receipt.stage -ne 'copied' -and (![IO.Path]::IsPathRooted($receipt.configPath) -or !(Test-Path -LiteralPath $receipt.configPath -PathType Leaf))) { throw 'The existing installation requires manual review.' }
    Assert-Payload $Program -Owned
    return $receipt
}

function Add-StartMenuShortcut([string]$Program) {
    $directory = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Assert-PlainPath $directory
    $shell = New-Object -ComObject WScript.Shell
    try {
        $path = Join-Path $directory 'I-m-Genius.lnk'
        if (Test-Path -LiteralPath $path) { Assert-PlainPath $path }
        $shortcut = $shell.CreateShortcut($path)
        if ((Test-Path -LiteralPath $path) -and ($shortcut.TargetPath -ne (Join-Path $Program 'Install.cmd') -or $shortcut.WorkingDirectory -ne $Program -or $shortcut.Arguments)) { throw 'The Start menu shortcut requires manual review.' }
        $shortcut.TargetPath = Join-Path $Program 'Install.cmd'
        $shortcut.WorkingDirectory = $Program
        $shortcut.Arguments = ''
        $shortcut.Description = 'Open I-m-Genius setup and journal'
        $shortcut.Save()
    } finally { if ($shortcut) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }; $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Invoke-Installation([string]$Bundle, [string]$Program, [string]$Data, [hashtable]$Options, [scriptblock]$Invoker = ${function:Invoke-SetupCli}) {
    $script:setupPhase = 'verification'
    if (Test-Path -LiteralPath $Program) {
        $receipt = Read-Receipt $Program
        if ($receipt.stage -eq 'copied') { throw 'Installation is incomplete. Review the private directory and client settings before reinstalling.' }
        if ($receipt.stage -eq 'complete' -and $Options.Auto) {
            $config = Read-SetupJson $receipt.configPath
            if ($config.mode -eq 'local') {
                $receipt.autoSyncRequested = $true; $receipt.stage = 'initialized'
                Write-Receipt $Program $receipt
            }
        }
    } else {
        Assert-Payload $Bundle
        if (!$Options.Sources -or @($Options.Sources | Where-Object { $_ -cnotin @('codex', 'claude') }).Count) { throw 'Select at least one supported client.' }
        if (Test-Path -LiteralPath $Data) {
            Assert-PlainPath $Data
            if (@(Get-ChildItem -LiteralPath $Data -Force).Count) { throw 'An existing private directory requires manual review.' }
        }
        $arguments = @('--config', (Join-Path $Data 'config.json'), '--repo', $Options.Repo, '--name', $Options.Name, '--email', $Options.Email)
        if ($Options.Mirror) { $arguments += @('--mirror', $Options.Mirror) }
        foreach ($source in $Options.Sources) { $arguments += @('--source', $source) }
        $script:setupPhase = 'preflight'
        $check = (& $Invoker $Bundle (@('setup-check') + $arguments)) | ConvertFrom-Json
        if ($check.ready -ne $true) { throw 'Setup checks did not pass.' }
        $script:setupPhase = 'program copy'
        Install-Payload $Bundle $Program
        $receipt = [pscustomobject]@{ schemaVersion = 1; version = '0.2.0'; stage = 'copied'; autoSyncRequested = [bool]$Options.Auto }
        Write-Receipt $Program $receipt
        $script:setupPhase = 'initialization'
        $result = (& $Invoker $Program (@('init') + $arguments)) | ConvertFrom-Json
        if (!$result.configPath -or ![IO.Path]::IsPathRooted($result.configPath)) { throw 'Initialization did not return a configuration path.' }
        $receipt | Add-Member -NotePropertyName configPath -NotePropertyValue $result.configPath
        $receipt.stage = 'initialized'
        Write-Receipt $Program $receipt
    }
    if ($receipt.stage -eq 'initialized') {
        if ($receipt.autoSyncRequested) {
            $config = Read-SetupJson $receipt.configPath
            if ($config.mode -eq 'local') {
                $script:setupPhase = 'upload authentication'
                try { $null = & $Invoker $Program @('enable-sync', '--config', $receipt.configPath, '--interactive-auth'); $receipt.stage = 'complete' }
                catch { return $receipt }
            } elseif ($config.mode -eq 'auto') { $receipt.stage = 'complete' }
            else { throw 'The configuration requires manual review.' }
        } else { $receipt.stage = 'complete' }
        Write-Receipt $Program $receipt
    }
    return $receipt
}

function Show-Installer {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $bundle = Split-Path -Parent $PSScriptRoot
    $program = Join-Path $env:LOCALAPPDATA 'Programs/I-m-Genius'
    $data = Join-Path $env:LOCALAPPDATA 'WhatIveDone'
    $form = New-Object Windows.Forms.Form
    $form.Text = 'I-m-Genius Setup 0.2.0'
    $form.ClientSize = New-Object Drawing.Size(650, 710)
    $form.StartPosition = 'CenterScreen'
    $form.Font = New-Object Drawing.Font('Segoe UI', 10)
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    function Label($text, $x, $y, $w, $h) {
        $c = New-Object Windows.Forms.Label; $c.Text = $text; $c.SetBounds($x, $y, $w, $h); $form.Controls.Add($c); return $c
    }
    function Field($title, $sample, $y) {
        $null = Label $title 22 $y 180 24
        $c = New-Object Windows.Forms.TextBox; $c.Text = $sample; $c.SetBounds(210, $y, 415, 27); $form.Controls.Add($c); return $c
    }
    $null = Label 'Private work journal for Codex and Claude Code' 22 18 600 28
    $repo = Field 'Primary HTTPS repo' '' 62
    $mirror = Field 'Mirror (optional)' '' 105
    $name = Field 'Git author name' '' 148
    $email = Field 'Git author email' '' 191
    $codex = New-Object Windows.Forms.CheckBox; $codex.Text = 'Codex'; $codex.SetBounds(22, 240, 130, 26); $form.Controls.Add($codex)
    $claude = New-Object Windows.Forms.CheckBox; $claude.Text = 'Claude Code'; $claude.SetBounds(210, 240, 190, 26); $form.Controls.Add($claude)
    $auto = New-Object Windows.Forms.CheckBox; $auto.Text = 'Enable automatic upload (opens Git authentication)'; $auto.SetBounds(22, 283, 600, 28); $form.Controls.Add($auto)
    $null = Label "Default: local journal only. Auto upload is optional.`r`nPublic rows: UTC time, category and status. Git name/email are public commit metadata. Raw prompts and conversations are not uploaded.`r`nNative clients still require their own hook trust approval." 22 329 602 100
    $status = Label 'Checking the verified bundle...' 22 442 602 80
    $install = New-Object Windows.Forms.Button; $install.Text = 'Install'; $install.SetBounds(22, 535, 170, 35); $form.Controls.Add($install)
    $open = New-Object Windows.Forms.Button; $open.Text = 'Open journal'; $open.SetBounds(210, 535, 170, 35); $open.Enabled = $false; $form.Controls.Add($open)
    $git = New-Object Windows.Forms.Button; $git.Text = 'Download Git'; $git.SetBounds(398, 535, 225, 35); $git.Visible = $false; $form.Controls.Add($git)
    $null = Label "Program: %LOCALAPPDATA%\Programs\I-m-Genius`r`nPrivate data: %LOCALAPPDATA%\WhatIveDone`r`nTo uninstall: run the permanent CLI uninstall command, then remove the program. Keep private data unless you choose to delete it." 22 588 602 110
    $script:setupReceipt = $null
    $script:setupGitAvailable = $false
    $script:setupLocalComplete = $false
    $script:setupCodexAvailable = $false; $script:setupClaudeAvailable = $false
    $script:setupBusy = $true; $script:setupBlocked = $false
    function Update-SetupControls {
        $usable = !$script:setupBusy -and !$script:setupBlocked
        $fresh = !$script:setupReceipt
        foreach ($control in @($repo, $mirror, $name, $email)) { $control.Enabled = $usable -and $fresh }
        $codex.Enabled = $usable -and $fresh -and $script:setupCodexAvailable
        $claude.Enabled = $usable -and $fresh -and $script:setupClaudeAvailable
        $auto.Enabled = $usable -and ($fresh -or $script:setupLocalComplete)
        $install.Enabled = $usable -and $(if ($fresh) { $script:setupGitAvailable -and ($codex.Checked -or $claude.Checked) } else { $script:setupReceipt.stage -eq 'initialized' -or ($script:setupLocalComplete -and $auto.Checked) })
        $open.Enabled = $usable -and !$fresh -and $script:setupReceipt.stage -ne 'copied'
        $git.Enabled = $usable; $form.ControlBox = !$script:setupBusy
    }
    Update-SetupControls
    $selectionChanged = {
        if ($script:setupBusy -or $script:setupBlocked) { return }
        if (!$script:setupReceipt) {
            $selected = $codex.Checked -or $claude.Checked
            Update-SetupControls
            if (!$selected) { $status.Text = 'Select at least one supported client before installing.' }
            elseif ($script:setupGitAvailable) { $status.Text = 'Ready. Review the fields, select clients, then install.' }
        }
    }
    $codex.Add_CheckedChanged($selectionChanged); $claude.Add_CheckedChanged($selectionChanged)
    $auto.Add_CheckedChanged({ if (!$script:setupBusy -and !$script:setupBlocked) { Update-SetupControls } })
    $git.Add_Click({ Start-Process 'https://git-scm.com/downloads/win' })
    $open.Add_Click({ if ($script:setupReceipt) { Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList @((ConvertTo-NativeArgument (Split-Path -Parent $script:setupReceipt.configPath))) } })
    $install.Add_Click({
        if ($script:setupBusy -or $script:setupBlocked) { return }
        $script:setupBusy = $true; Update-SetupControls
        try {
            $status.Text = 'Installing. Authentication may open in your browser. Please wait.'; $form.Refresh()
            $sources = @(); if ($codex.Checked) { $sources += 'codex' }; if ($claude.Checked) { $sources += 'claude' }
            $options = @{ Repo = $repo.Text.Trim(); Mirror = $mirror.Text.Trim(); Name = $name.Text.Trim(); Email = $email.Text.Trim(); Sources = $sources; Auto = $auto.Checked }
            $script:setupReceipt = Invoke-Installation $bundle $program $data $options
            $script:setupLocalComplete = $script:setupReceipt.stage -eq 'complete' -and !$script:setupReceipt.autoSyncRequested
            if ($script:setupLocalComplete) { $install.Text = 'Enable upload'; $status.Text = 'Local journal is active. Approve hooks in each selected native client. Select automatic upload and click Enable upload when ready.' }
            elseif ($script:setupReceipt.stage -eq 'complete') { $status.Text = 'Setup complete. The journal is ready. Approve hooks in each selected native client.' }
            else { $status.Text = 'Local journal is active. Upload authentication is pending. Click Retry upload when ready.'; $install.Text = 'Retry upload' }
            try { Add-StartMenuShortcut $program }
            catch { $status.Text += ' Start menu shortcut unavailable. Reopen %LOCALAPPDATA%\Programs\I-m-Genius\Install.cmd.' }
        } catch {
            $script:setupBlocked = Test-Path -LiteralPath $program
            $status.Text = "Setup is incomplete during $script:setupPhase. Existing data was preserved. Check Git, repository URL and native client hook conflicts before retrying."
        }
        finally { $script:setupBusy = $false; Update-SetupControls }
    })
    $form.Add_Shown({
        try {
            if (Test-Path -LiteralPath $program) {
                $script:setupReceipt = Read-Receipt $program
                if ($script:setupReceipt.stage -eq 'copied') { throw 'Incomplete installation.' }
                $install.Text = 'Retry upload'
                $saved = Read-SetupJson $script:setupReceipt.configPath
                $repo.Text = $saved.remoteUrl; $mirror.Text = $saved.mirrorUrl; $name.Text = $saved.authorName; $email.Text = $saved.authorEmail
                $auto.Checked = $script:setupReceipt.autoSyncRequested
                $script:setupLocalComplete = $script:setupReceipt.stage -eq 'complete' -and $saved.mode -eq 'local'
                if ($script:setupLocalComplete) { $auto.Checked = $false; $install.Text = 'Enable upload'; $status.Text = 'Local journal is active. To upload later, select automatic upload and click Enable upload.' }
                elseif ($script:setupReceipt.stage -eq 'complete') { $status.Text = 'Setup complete. Open your journal. Native clients require their own hook trust approval.' }
                else { $status.Text = 'Local journal is active. Upload authentication is pending. Click Retry upload when ready.' }
            } else {
                Assert-Payload $bundle
                $info = Invoke-SetupCli $bundle @('setup-info') | ConvertFrom-Json
                $script:setupCodexAvailable = $info.codexAvailable; $script:setupClaudeAvailable = $info.claudeAvailable
                $codex.Checked = $info.codexAvailable
                $claude.Checked = $info.claudeAvailable
                if ($info.authorName) { $name.Text = $info.authorName }; if ($info.authorEmail) { $email.Text = $info.authorEmail }
                $script:setupGitAvailable = $info.gitAvailable
                $git.Visible = !$info.gitAvailable
                if (!$info.codexAvailable -and !$info.claudeAvailable) { $status.Text = 'No supported client detected. Install Codex or Claude Code, then reopen setup.' }
                elseif ($info.gitAvailable) { $status.Text = 'Ready. Review the fields, select clients, then install.' }
                else { $status.Text = 'Git is missing from C:\Program Files\Git. Use Download Git, install it, then reopen this setup.' }
            }
        } catch { $script:setupBlocked = $true; $status.Text = 'Setup cannot continue: the bundle is invalid or the existing installation needs manual review.' }
        finally { $script:setupBusy = $false; Update-SetupControls }
    })
    $null = $form.ShowDialog()
    $form.Dispose()
}

if (!$LibraryOnly) { Show-Installer }
