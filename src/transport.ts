import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateWorklog, isWorklogAppend, type Config, type StoreState, type Snapshot, type PolicyResult, type Receipt, type Source, type CommitView } from './schema.js';
const GIT = 'C:/Program Files/Git/cmd/git.exe';
const OID = /^[a-f0-9]{40}$/;
const MESSAGE = 'worklog: append progress';
function fail(code = 'invalid_history'): never {
    throw new Error(code);
}
function destination(c: Config): void {
    for (const url of [c.remoteUrl, ...(c.mirrorUrl === undefined ? [] : [c.mirrorUrl])]) {
        let u: URL;
        try {
            u = new URL(url);
        }
        catch {
            fail('destination_changed');
        }
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash
            || /[\s\x00-\x1f\\?#]/.test(url) || u.href !== url)
            fail('destination_changed');
    }
    if (c.mirrorUrl === c.remoteUrl
        || !/^[-a-zA-Z0-9_]+$/.test(c.branch)
        || !isAbsolute(c.gitDir)
        || !isAbsolute(c.privateDir)
        || !c.authorName
        || !c.authorEmail
        || /[<>\r\n\x00]/.test(c.authorName + c.authorEmail))
        fail('destination_changed');
}
function target(c: Config, url: string): void {
    destination(c);
    if (typeof url !== 'string' || url !== c.remoteUrl && url !== c.mirrorUrl)
        fail('destination_changed');
}
function auditPath(c: Config, name: 'receipt' | 'send-manifest', url: string): string {
    return join(c.privateDir, `${name}${url === c.remoteUrl ? '' : '-mirror'}.json`);
}
function environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
        if (process.env[k])
            env[k] = process.env[k];
    env.PATH = `C:\\Program Files\\Git\\cmd;${process.env.SystemRoot || 'C:\\Windows'}\\System32`;
    return {
        ...env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_NO_REPLACE_OBJECTS: '1'
    };
}
function run(executable: string, args: string[], env = environment(), missingAllowed = false, discardOutput = false, xmlOutput = false): Promise<string> {
    return new Promise((accept, reject) => {
        execFile(executable, args, {
            env, shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', timeout: 60000
        }, (error, stdout) => {
            if (error) {
                if (missingAllowed && error.code === 1) {
                    accept('');
                    return;
                }
                reject(new Error('transport_failed'));
                return;
            }
            if (discardOutput) {
                accept('');
                return;
            }
            try {
                accept(new TextDecoder(xmlOutput && stdout[0] === 255 && stdout[1] === 254 ? 'utf-16le' : 'utf-8', { fatal: true, ignoreBOM: true }).decode(stdout));
            }
            catch {
                reject(new Error('invalid_content'));
            }
        });
    });
}
function git(c: Config, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const options = [
        '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
        `--git-dir=${join(c.gitDir, '.git')}`, `--work-tree=${c.gitDir}`,
        '-c', `core.hooksPath=${join(c.privateDir, 'empty')}`,
        '-c', 'core.attributesFile=NUL', '-c', 'core.autocrlf=false',
        '-c', 'core.safecrlf=false', '-c', 'commit.gpgSign=false',
        '-c', 'push.gpgSign=false', '-c', 'gc.auto=0',
        '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false'
    ];
    return run(GIT, [...options, ...args], { ...environment(), ...extraEnv });
}
async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return false;
        throw new Error('invalid_history');
    }
}
async function safeDirectory(path: string): Promise<void> {
    if ((await lstat(path)).isSymbolicLink() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
        fail();
}
async function repository(c: Config): Promise<void> {
    destination(c);
    await safeDirectory(join(c.privateDir, 'empty'));
    if ((await readdir(join(c.privateDir, 'empty'))).length)
        fail('extra_execution');
    await safeDirectory(c.gitDir);
    await safeDirectory(join(c.gitDir, '.git'));
    if (!(await lstat(join(c.gitDir, '.git'))).isDirectory())
        fail();
    for (const name of ['commondir', 'shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'info/attributes'])
        if (await exists(join(c.gitDir, '.git', name)))
            fail('extra_execution');
    await safeDirectory(join(c.gitDir, '.git', 'objects'));
    if ((await readdir(join(c.gitDir, '.git', 'objects', 'pack')).catch(() => [])).some(x => x.endsWith('.promisor')))
        fail('extra_execution');
    const config = await git(c, ['config', '--local', '--no-includes', '--null', '--list']);
    const allowed: Record<string, string> = {
        'core.repositoryformatversion': '0', 'core.filemode': 'false', 'core.bare': 'false', 'core.logallrefupdates': 'true', 'core.symlinks': 'false', 'core.ignorecase': 'true', 'remote.origin.url': c.remoteUrl
    };
    const seen = new Set<string>();
    for (const entry of config.split('\0').filter(Boolean)) {
        const i = entry.indexOf('\n');
        const key = entry.slice(0, i), value = entry.slice(i + 1);
        if (!(key in allowed) || allowed[key] !== value || seen.has(key))
            fail('extra_execution');
        seen.add(key);
    }
    if (!seen.has('remote.origin.url'))
        fail('destination_changed');
    if ((await git(c, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${c.branch}`)
        fail();
    const refs = (await git(c, ['for-each-ref', '--format=%(refname)'])).trim().split('\n').filter(Boolean);
    if (refs.some(x => x !== `refs/heads/${c.branch}`))
        fail();
}
export async function initializeLocalRepository(c: Config, assertOwned?: () => void): Promise<void> {
    destination(c);
    await mkdir(c.privateDir, { recursive: true });
    await mkdir(join(c.privateDir, 'empty'), { recursive: true });
    await safeDirectory(join(c.privateDir, 'empty'));
    if ((await readdir(join(c.privateDir, 'empty'))).length)
        fail('extra_execution');
    await mkdir(c.gitDir, { recursive: true });
    if ((await readdir(c.gitDir)).length)
        fail();
    await safeDirectory(c.gitDir);
    assertOwned?.();
    await git(c, ['init', '--object-format=sha1', `--initial-branch=${c.branch}`, `--template=${join(c.privateDir, 'empty')}`, c.gitDir]);
    assertOwned?.();
    await git(c, ['config', '--local', 'remote.origin.url', c.remoteUrl]);
    await repository(c);
}
export async function readLocalHeadOid(c: Config): Promise<string | null> {
    await repository(c);
    const refs = (await git(c, ['for-each-ref', '--format=%(objectname)', `refs/heads/${c.branch}`])).trim();
    if (!refs)
        return null;
    if (!OID.test(refs))
        fail();
    return refs;
}
async function head(c: Config): Promise<string> {
    const s = (await git(c, ['rev-parse', '--verify', `refs/heads/${c.branch}`])).trim();
    if (!OID.test(s))
        fail();
    return s;
}
async function audit(c: Config, target: string): Promise<CommitView[]> {
    if (!OID.test(target))
        fail();
    const ids = (await git(c, ['rev-list', '--reverse', target])).trim().split('\n');
    const commits: CommitView[] = [];
    let previous = '';
    for (const oid of ids) {
        if (!OID.test(oid))
            fail();
        const raw = await git(c, ['cat-file', 'commit', oid]);
        const match = /^tree ([a-f0-9]{40})\n(?:parent ([a-f0-9]{40})\n)?author ([^<>\n]+) <([^<>\n]+)> (\d+) \+0000\ncommitter ([^<>\n]+) <([^<>\n]+)> (\d+) \+0000\n\nworklog: append progress\n$/.exec(raw);
        if (!match)
            fail();
        if ((match[2] || '') !== (commits.at(-1)?.oid || ''))
            fail();
        if (match[3] !== c.authorName || match[4] !== c.authorEmail || match[6] !== c.authorName || match[7] !== c.authorEmail)
            fail('invalid_identity');
        const tree = await git(c, ['ls-tree', '-z', match[1]]);
        const entry = /^100644 blob ([a-f0-9]{40})\tWORKLOG.md\0$/.exec(tree);
        if (!entry)
            fail('invalid_content');
        const worklog = await git(c, ['cat-file', 'blob', entry[1]]);
        if (!validateWorklog(worklog) || !worklog || !isWorklogAppend(previous, worklog) || worklog === previous)
            fail('invalid_content');
        const patch = await git(c, ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-color', '-p', oid, '--', 'WORKLOG.md']);
        commits.push({
            oid, parents: match[2] ? [match[2]] : [], author: { name: match[3], email: match[4], time: new Date(Number(match[5]) * 1000).toISOString() }, committer: { name: match[6], email: match[7], time: new Date(Number(match[8]) * 1000).toISOString() }, message: MESSAGE, files: ['WORKLOG.md'], worklog, patch
        });
        previous = worklog;
    }
    return commits;
}
export async function commitWorklog(c: Config, expectedHash: string, assertOwned?: () => void): Promise<string> {
    await repository(c);
    const path = join(c.gitDir, 'WORKLOG.md');
    if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
        fail('invalid_content');
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || createHash('sha256').update(bytes).digest('hex') !== expectedHash || !text || !validateWorklog(text))
        fail('invalid_content');
    const refs = (await git(c, ['for-each-ref', '--format=%(objectname)'])).trim();
    if (refs) {
        const previous = (await audit(c, await head(c))).at(-1)!.worklog;
        if (!isWorklogAppend(previous, text) || text === previous)
            fail('invalid_content');
    }
    const staged = (await git(c, ['diff', '--cached', '--name-only'])).trim();
    if (staged && staged !== 'WORKLOG.md')
        fail('invalid_content');
    assertOwned?.();
    await git(c, ['add', '--', 'WORKLOG.md']);
    assertOwned?.();
    const date = `${Math.floor(Date.now() / 1000)} +0000`;
    await git(c, ['commit', '--no-verify', '--no-gpg-sign', '-m', MESSAGE], {
        GIT_AUTHOR_NAME: c.authorName, GIT_AUTHOR_EMAIL: c.authorEmail, GIT_COMMITTER_NAME: c.authorName, GIT_COMMITTER_EMAIL: c.authorEmail, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
    });
    const oid = await head(c);
    await audit(c, oid);
    return oid;
}
export async function readSnapshot(c: Config, state: StoreState, queuedCount: number): Promise<Snapshot> {
    await repository(c);
    const targetOid = await head(c);
    const all = await audit(c, targetOid);
    const index = state.remoteOid === null ? -1 : all.findIndex(x => x.oid === state.remoteOid);
    if (state.remoteOid !== null && index < 0)
        fail();
    return {
        capturedAt: new Date().toISOString(), baselineOid: state.remoteOid, baselineCheckedAt: state.remoteCheckedAt, targetOid, pushUrl: c.remoteUrl, targetRef: `refs/heads/${c.branch}`, commits: all.slice(index + 1), queuedCount
    };
}
export function checkSnapshot(c: Config, s: Snapshot): PolicyResult {
    try {
        target(c, s.pushUrl);
        if (s.targetRef !== `refs/heads/${c.branch}`)
            return { ok: false, code: 'destination_changed' };
        if (!OID.test(s.targetOid) || s.baselineOid !== null && !OID.test(s.baselineOid))
            return { ok: false, code: 'invalid_history' };
        let parent = s.baselineOid, previous = '';
        for (const v of s.commits) {
            if (!OID.test(v.oid) || v.message !== MESSAGE || JSON.stringify(v.parents) !== JSON.stringify(parent ? [parent] : []))
                return { ok: false, code: 'invalid_history' };
            if (v.author.name !== c.authorName || v.committer.name !== c.authorName || v.author.email !== c.authorEmail || v.committer.email !== c.authorEmail)
                return { ok: false, code: 'invalid_identity' };
            if (v.files.length !== 1 || v.files[0] !== 'WORKLOG.md' || !v.worklog || !validateWorklog(v.worklog) || !isWorklogAppend(previous, v.worklog))
                return { ok: false, code: 'invalid_content' };
            parent = v.oid;
            previous = v.worklog;
        }
        return parent === s.targetOid ? { ok: true } : { ok: false, code: 'invalid_history' };
    }
    catch {
        return { ok: false, code: 'destination_changed' };
    }
}
// Only standard native credential managers are restored from user/system configuration.
// They can contact authentication services independently of the fixed Git endpoint.
async function credentials(): Promise<string[]> {
    const env = environment();
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_SYSTEM;
    delete env.GIT_CONFIG_NOSYSTEM;
    const helpers: string[] = [];
    for (const scope of ['--system', '--global']) {
        const value = await run(GIT, ['config', scope, '--no-includes', '--get-all', 'credential.helper'], env, true);
        for (const helper of value.split('\n').slice(0, -1)) {
            if (!helper) {
                helpers.length = 0;
                continue;
            }
            if (!['manager', 'manager-core', 'wincred', 'osxkeychain'].includes(helper))
                fail('extra_execution');
            helpers.push(helper);
        }
    }
    return ['-c', 'credential.helper=', ...helpers.flatMap(x => ['-c', `credential.helper=${x}`])];
}
async function remote(c: Config, all: boolean, assertOwned: (() => void) | undefined, targetUrl: string): Promise<string | null> {
    target(c, targetUrl);
    await repository(c);
    const auth = await credentials();
    const receipt: Receipt = {
        operation: 'check_remote', pushUrl: targetUrl, targetRef: `refs/heads/${c.branch}`, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), result: 'network_error'
    };
    assertOwned?.();
    await writeFile(auditPath(c, 'send-manifest', targetUrl), JSON.stringify({
        operation: 'check_remote', pushUrl: targetUrl, targetRef: receipt.targetRef, credentialHelpers: auth.filter(x => x.startsWith('credential.helper=')), authenticationMayContactOtherServices: true
    }), { mode: 0o600 });
    try {
        assertOwned?.();
        const output = await git(c, [...auth, 'ls-remote', '--refs', targetUrl, ...(all ? [] : [receipt.targetRef])]);
        receipt.result = 'policy_blocked';
        if (!output.trim()) {
            receipt.result = 'ok';
            return null;
        }
        const lines = output.trim().split('\n');
        if (all || lines.length !== 1)
            fail();
        const match = /^([a-f0-9]{40})\t(.+)$/.exec(lines[0]);
        if (!match || match[2] !== receipt.targetRef)
            fail();
        try {
            await audit(c, match[1]);
        }
        catch {
            fail('invalid_history');
        }
        receipt.result = 'ok';
        return match[1];
    }
    finally {
        receipt.endedAt = new Date().toISOString();
        assertOwned?.();
        await writeFile(auditPath(c, 'receipt', targetUrl), JSON.stringify(receipt), { mode: 0o600 });
    }
}
export async function checkEmptyRemote(c: Config, assertOwned?: () => void, targetUrl = c.remoteUrl): Promise<void> {
    await remote(c, true, assertOwned, targetUrl);
}
export async function refreshRemote(c: Config, assertOwned?: () => void, targetUrl = c.remoteUrl): Promise<{
    oid: string | null;
    checkedAt: string;
}> {
    const oid = await remote(c, false, assertOwned, targetUrl);
    return { oid, checkedAt: new Date().toISOString() };
}
export async function pushSnapshot(c: Config, s: Snapshot, assertOwned?: () => void): Promise<Receipt> {
    target(c, s.pushUrl);
    await repository(c);
    if (!checkSnapshot(c, s).ok || await head(c) !== s.targetOid)
        fail();
    const actual = await audit(c, s.targetOid);
    const index = s.baselineOid === null ? -1 : actual.findIndex(x => x.oid === s.baselineOid);
    if (s.baselineOid !== null && index < 0 || JSON.stringify(actual.slice(index + 1)) !== JSON.stringify(s.commits))
        fail();
    if (s.baselineOid === null)
        await checkEmptyRemote(c, assertOwned, s.pushUrl);
    const baseline = await refreshRemote(c, assertOwned, s.pushUrl);
    if (baseline.oid !== s.baselineOid)
        fail();
    const receipt: Receipt = {
        operation: 'push', pushUrl: s.pushUrl, targetRef: `refs/heads/${c.branch}`, targetOid: s.targetOid, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), result: 'network_error'
    };
    const auth = await credentials();
    assertOwned?.();
    await writeFile(auditPath(c, 'send-manifest', s.pushUrl), JSON.stringify({
        pushUrl: s.pushUrl, targetRef: receipt.targetRef, targetOid: s.targetOid, commitOids: s.commits.map(x => x.oid), credentialHelpers: auth.filter(x => x.startsWith('credential.helper=')), authenticationMayContactOtherServices: true
    }), { mode: 0o600 });
    await repository(c);
    if (await head(c) !== s.targetOid)
        fail();
    assertOwned?.();
    try {
        await git(c, [...auth, 'push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-signed', '--recurse-submodules=no', s.pushUrl, `${s.targetOid}:${receipt.targetRef}`]);
        receipt.result = 'ok';
    }
    catch {
        receipt.result = 'network_error';
    }
    receipt.endedAt = new Date().toISOString();
    assertOwned?.();
    await writeFile(auditPath(c, 'receipt', s.pushUrl), JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
}
function cli(path: string): void {
    if (!isAbsolute(path) || /[\r\n\x00"]/.test(path) || !path.endsWith('.js'))
        fail('invalid_client');
}
async function claudeEntry(): Promise<{ executable: string; prefix: string[] }> {
    const root = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    try {
        if (!isAbsolute(root))
            fail('invalid_client');
        const entry = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).bin?.claude;
        if (entry !== 'cli.js' && entry !== 'bin/claude.exe')
            fail('invalid_client');
        const path = join(root, entry);
        if (!(await lstat(path)).isFile() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
            fail('invalid_client');
        return entry === 'cli.js' ? { executable: process.execPath, prefix: [path] } : { executable: path, prefix: [] };
    }
    catch {
        fail('invalid_client');
    }
}
async function codexEntry(): Promise<{ executable: string; prefix: string[] }> {
    try {
        const desktop = join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
        if (isAbsolute(desktop) && await exists(desktop)) {
            if (!(await lstat(desktop)).isFile() || resolve(await realpath(desktop)).toLowerCase() !== resolve(desktop).toLowerCase())
                fail('invalid_client');
            return { executable: desktop, prefix: [] };
        }
        const root = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex');
        if (!isAbsolute(root) || JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).bin?.codex !== 'bin/codex.js')
            fail('invalid_client');
        const entry = join(root, 'bin', 'codex.js');
        if (!(await lstat(entry)).isFile() || resolve(await realpath(entry)).toLowerCase() !== resolve(entry).toLowerCase())
            fail('invalid_client');
        return { executable: process.execPath, prefix: [entry] };
    } catch {
        fail('invalid_client');
    }
}
export async function registerClientMcp(source: Source, absoluteCli: string): Promise<void> {
    cli(absoluteCli);
    if (source === 'codex') {
        const entry = await codexEntry();
        await run(entry.executable, [...entry.prefix, 'mcp', 'add', 'whativedone', '--', process.execPath, absoluteCli, 'mcp'], environment(), false, true);
    }
    else if (source === 'claude') {
        const entry = await claudeEntry();
        await run(entry.executable, [...entry.prefix, 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'whativedone', '--', process.execPath, absoluteCli, 'mcp'], environment(), false, true);
    }
    else
        fail('invalid_client');
}
const STARTUP_LAUNCHER = String.raw`using System;
using System.Diagnostics;
using System.IO;
internal static class StartupLauncher {
    private static int Main(string[] paths) {
        try {
            if (paths.Length != 3) return 1;
            foreach (string path in paths)
                if (!Path.IsPathRooted(path) || path.IndexOfAny(new[] { '"', '\r', '\n', '\0' }) >= 0) return 1;
            var start = new ProcessStartInfo {
                FileName = paths[0], Arguments = "\"" + paths[1] + "\" sync --watch --config \"" + paths[2] + "\"",
                UseShellExecute = false, CreateNoWindow = true
            };
            using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        } catch { return 1; }
    }
}
`;
export async function manageStartup(operation: 'install' | 'remove' | 'start', absoluteCli: string, configPath?: string): Promise<void> {
    cli(absoluteCli);
    if (!configPath || [process.execPath, absoluteCli, configPath].some(path => !isAbsolute(path) || /[\x00-\x1f"]/.test(path)))
        fail('invalid_client');
    const scheduler = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'schtasks.exe');
    const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const name = `WhatIveDone-${createHash('sha256').update(resolve(configPath).toLowerCase()).digest('hex').slice(0, 16)}`;
    const privateDir = dirname(configPath);
    const launcher = join(privateDir, 'startup-launcher.exe');
    const source = join(privateDir, 'startup-launcher.cs');
    const launcherArguments = `"${process.execPath}" "${absoluteCli}" "${configPath}"`;
    const argumentsText = `"${absoluteCli}" sync --watch --config "${configPath}"`;
    const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const start = `$ErrorActionPreference = 'Stop'; $s = New-Object System.Diagnostics.ProcessStartInfo; $s.FileName = ${literal(process.execPath)}; $s.Arguments = ${literal(argumentsText)}; $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $p = [System.Diagnostics.Process]::Start($s); $p.WaitForExit(); exit $p.ExitCode`;
    const hiddenArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${start.replaceAll('"', '\\"')}"`;
    if (operation === 'install') {
        const user = process.env.USERNAME, domain = process.env.USERDOMAIN;
        if (!user || !domain || /[\x00-\x1f\\/:]/.test(user + domain))
            fail('invalid_client');
        const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
        const account = escape(`${domain}\\${user}`);
        const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><UserId>${account}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Watcher"><UserId>${account}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Watcher"><Exec><Command>${escape(launcher)}</Command><Arguments>${escape(launcherArguments)}</Arguments></Exec></Actions>
</Task>`;
        const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]);
        if (bytes.length > 16 * 1024)
            fail('invalid_client');
        await safeDirectory(privateDir);
        if (await exists(source)) {
            if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink() || await readFile(source, 'utf8') !== STARTUP_LAUNCHER)
                fail('startup_conflict');
        }
        else
            await writeFile(source, STARTUP_LAUNCHER, { mode: 0o600, flag: 'wx' });
        if (await exists(launcher) && (!(await lstat(launcher)).isFile() || (await lstat(launcher)).isSymbolicLink()))
            fail('startup_conflict');
        const framework = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
        await run(join(framework, 'csc.exe'), ['/noconfig', '/nologo', '/target:winexe', '/nostdlib', `/reference:${join(framework, 'mscorlib.dll')}`, `/reference:${join(framework, 'System.dll')}`, `/out:${launcher}`, source], environment(), false, true);
        const temporary = join(privateDir, `.startup-${randomBytes(8).toString('hex')}.xml`);
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
        try {
            await run(scheduler, ['/Create', '/TN', name, '/XML', temporary], environment(), false, true);
        }
        finally {
            await unlink(temporary);
        }
    }
    else if (operation === 'remove' || operation === 'start') {
        const xml = await run(scheduler, ['/Query', '/TN', name, '/XML'], environment(), false, false, true);
        const decode = (text: string) => text.replace(/&(amp|quot|apos|lt|gt);/g, (_, entity: string) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[entity]!);
        const command = /<Command>([^<]*)<\/Command>/.exec(xml);
        const args = /<Arguments>([^<]*)<\/Arguments>/.exec(xml);
        const executable = command && decode(command[1]).replace(/^"|"$/g, '');
        const argumentsValue = args && decode(args[1]);
        const owned = executable === launcher && argumentsValue === launcherArguments || executable === powershell && argumentsValue === hiddenArguments || executable === process.execPath && argumentsValue === argumentsText;
        if ((xml.match(/<Exec(?:\s|>)/g) || []).length !== 1 || /<ComHandler(?:\s|>)/.test(xml) || !owned)
            fail('startup_conflict');
        await run(scheduler, operation === 'start' ? ['/Run', '/TN', name] : ['/Delete', '/F', '/TN', name], environment(), false, true);
    }
    else
        fail('invalid_client');
}
export async function securePrivateDirectory(path: string): Promise<void> {
    if (!isAbsolute(path) || /[\r\n\x00]/.test(path))
        fail('invalid_client');
    const user = process.env.USERNAME;
    const domain = process.env.USERDOMAIN;
    if (!user || !domain || /[\r\n\x00:]/.test(user + domain))
        fail('invalid_client');
    await mkdir(path, { recursive: true, mode: 0o700 });
    await safeDirectory(path);
    await run(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'icacls.exe'), [path, '/reset'], environment(), false, true);
    await run(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `${domain}\\${user}:(OI)(CI)F`], environment(), false, true);
}
export async function removeClientMcp(source: Source): Promise<void> {
    if (source === 'codex') {
        const entry = await codexEntry();
        await run(entry.executable, [...entry.prefix, 'mcp', 'remove', 'whativedone'], environment(), false, true);
    }
    else if (source === 'claude') {
        const entry = await claudeEntry();
        await run(entry.executable, [...entry.prefix, 'mcp', 'remove', '--scope', 'user', 'whativedone'], environment(), false, true);
    }
    else
        fail('invalid_client');
}
