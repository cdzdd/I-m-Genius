import { execFile, spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink, copyFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateWorklog, isWorklogAppend, WORKLOG_HEADER, LEGACY_WORKLOG_HEADER, type Config, type StoreState, type Snapshot, type PolicyResult, type Receipt, type Source, type CommitView } from './schema.js';
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
function gitOptions(c: Config): string[] {
    return [
        '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
        `--git-dir=${join(c.gitDir, '.git')}`, `--work-tree=${c.gitDir}`,
        '-c', `core.hooksPath=${join(c.privateDir, 'empty')}`,
        '-c', 'core.attributesFile=NUL', '-c', 'core.autocrlf=false',
        '-c', 'core.safecrlf=false', '-c', 'commit.gpgSign=false',
        '-c', 'push.gpgSign=false', '-c', 'gc.auto=0',
        '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false'
    ];
}
function git(c: Config, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    return run(GIT, [...gitOptions(c), ...args], { ...environment(), ...extraEnv });
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
// Trust is scoped to one publisher transaction, never persisted between runs.
const commitProofs = new WeakMap<CommitView, string>();
const auditKey = (c: Config) => JSON.stringify([resolve(c.gitDir), c.authorName, c.authorEmail]);
const auditSession = new AsyncLocalStorage<Map<string, Map<string, CommitView>>>();
export function withAuditSession<T>(action: () => Promise<T>): Promise<T> {
    return auditSession.run(new Map(), action);
}
async function withGitObjects<T>(c: Config, action: (read: (oids: string[], type: string, consume: (bytes: Buffer, index: number) => void) => Promise<void>) => Promise<T>): Promise<T> {
    const child = spawn(GIT, [...gitOptions(c), 'cat-file', '--batch'], { env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise<boolean>(accept => {
        child.once('error', () => accept(false));
        child.once('close', code => accept(code === 0));
    });
    child.stdin.on('error', () => {});
    child.stderr.resume(); // Native diagnostics never enter persisted errors or previews.
    const deadline = setTimeout(() => child.kill(), 60000);
    const output = child.stdout[Symbol.asyncIterator]();
    let buffered: Buffer = Buffer.alloc(0);
    async function fill(size: number): Promise<void> {
        while (buffered.length < size) {
            const chunk = await output.next();
            if (chunk.done) fail('transport_failed');
            buffered = buffered.length ? Buffer.concat([buffered, chunk.value]) : chunk.value;
        }
    }
    try {
        const result = await action(async (oids, type, consume) => {
            if (oids.some(oid => !OID.test(oid))) fail();
            if (oids.length) child.stdin.write(oids.join('\n') + '\n');
            for (let index = 0; index < oids.length; index++) {
                const oid = oids[index];
                let end: number;
                while ((end = buffered.indexOf(10)) < 0) {
                    if (buffered.length > 128) fail();
                    await fill(buffered.length + 1);
                }
                const header = /^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(buffered.subarray(0, end).toString('ascii'));
                if (!header || header[1] !== oid || header[2] !== type) fail();
                const size = Number(header[3]);
                if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) fail('invalid_content');
                buffered = buffered.subarray(end + 1);
                await fill(size + 1);
                if (buffered[size] !== 10) fail();
                const bytes = buffered.subarray(0, size);
                buffered = buffered.subarray(size + 1);
                if (createHash('sha1').update(`${type} ${size}\0`).update(bytes).digest('hex') !== oid) fail();
                consume(bytes, index);
            }
        });
        child.stdin.end();
        child.stdout.resume();
        if (!await closed) fail('transport_failed');
        return result;
    } finally {
        clearTimeout(deadline);
        child.stdout.destroy();
        child.stdin.destroy();
        child.stderr.destroy();
        child.kill();
        await closed;
    }
}
async function audit(c: Config, target: string): Promise<CommitView[]> {
    if (!OID.test(target)) fail();
    const key = auditKey(c);
    const cache = auditSession.getStore()?.get(key) || new Map<string, CommitView>();
    auditSession.getStore()?.set(key, cache);
    const ids = (await git(c, ['rev-list', '--reverse', target])).trim().split('\n');
    const commits: CommitView[] = new Array(ids.length);
    const fresh: CommitView[] = [];
    const decode = (bytes: Buffer): string => {
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return fail('invalid_content'); }
    };
    const pending: { index: number; tree: string; blob: string }[] = [];
    for (let index = 0; index < ids.length; index++) {
        const oid = ids[index];
        if (!OID.test(oid)) fail();
        const known = cache.get(oid);
        if (known) {
            if ((known.parents[0] || '') !== (index ? ids[index - 1] : '')) fail();
            commits[index] = known;
        } else pending.push({ index, tree: '', blob: '' });
    }
    if (pending.length) await withGitObjects(c, async read => {
        await read(pending.map(item => ids[item.index]), 'commit', (bytes, index) => {
            const item = pending[index];
            const parent = item.index ? ids[item.index - 1] : '';
            const match = /^tree ([a-f0-9]{40})\n(?:parent ([a-f0-9]{40})\n)?author ([^<>\n]+) <([^<>\n]+)> (\d+) \+0000\ncommitter ([^<>\n]+) <([^<>\n]+)> (\d+) \+0000\n\nworklog: append progress\n$/.exec(decode(bytes));
            if (!match || (match[2] || '') !== parent) fail();
            if (match[3] !== c.authorName || match[4] !== c.authorEmail || match[6] !== c.authorName || match[7] !== c.authorEmail) fail('invalid_identity');
            item.tree = match[1];
            const view: CommitView = {
                oid: ids[item.index], parents: parent ? [parent] : [], author: { name: match[3], email: match[4], time: new Date(Number(match[5]) * 1000).toISOString() }, committer: { name: match[6], email: match[7], time: new Date(Number(match[8]) * 1000).toISOString() }, message: MESSAGE, files: ['WORKLOG.md'], worklog: '', patch: ''
            };
            commits[item.index] = view;
            fresh.push(view);
        });
        const prefix = Buffer.from('100644 WORKLOG.md\0');
        await read(pending.map(item => item.tree), 'tree', (tree, index) => {
            if (tree.length !== prefix.length + 20 || !tree.subarray(0, prefix.length).equals(prefix)) fail('invalid_content');
            pending[index].blob = tree.subarray(prefix.length).toString('hex');
        });
        // Newest first lets old append-only worklogs share the latest string prefix.
        const newest = [...pending].reverse();
        await read(newest.map(item => item.blob), 'blob', (bytes, index) => {
            const item = newest[index], next = commits[item.index + 1];
            let worklog = decode(bytes);
            // A complete line prefix of an already validated file inherits its fixed fields and counts.
            const prefixOnly = next && worklog !== next.worklog && worklog.endsWith('\n') && (worklog.startsWith(WORKLOG_HEADER) || worklog.startsWith(LEGACY_WORKLOG_HEADER)) && next.worklog.startsWith(worklog);
            if (!worklog || (!prefixOnly && (next ? !isWorklogAppend(worklog, next.worklog) : !validateWorklog(worklog)))) fail('invalid_content');
            if (next?.worklog.startsWith(worklog)) worklog = next.worklog.slice(0, worklog.length);
            commits[item.index].worklog = worklog;
        });
    });
    const first = commits.length - fresh.length;
    if (first && fresh.length && !isWorklogAppend(commits[first - 1].worklog, fresh[0].worklog)) fail('invalid_content');
    if (fresh.length) {
        const patches = (await git(c, ['log', '--reverse', '--format=%x00%H%x00', '--root', '--no-ext-diff', '--no-textconv', '--no-color', '-p', target, ...(first ? [`^${commits[first - 1].oid}`] : []), '--', 'WORKLOG.md'])).split('\0');
        if (patches[0] !== '' || patches.length !== fresh.length * 2 + 1) fail();
        for (let index = 0; index < fresh.length; index++) {
            const view = fresh[index];
            if (patches[2 * index + 1] !== view.oid) fail();
            view.patch = patches[2 * index + 2].replace(/^\n+/, '').replace(/\n+$/, '\n');
            Object.freeze(view.parents); Object.freeze(view.author); Object.freeze(view.committer); Object.freeze(view.files); Object.freeze(view);
            cache.set(view.oid, view);
            commitProofs.set(view, key);
        }
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
            const verified = commitProofs.get(v) === auditKey(c);
            if (!verified && (v.files.length !== 1 || v.files[0] !== 'WORKLOG.md' || !v.worklog || !isWorklogAppend(previous, v.worklog)))
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
async function remote(c: Config, all: boolean, assertOwned: (() => void) | undefined, targetUrl: string, interactiveAuth = false): Promise<string | null> {
    target(c, targetUrl);
    await repository(c);
    const auth = await credentials();
    const receipt: Receipt = {
        operation: 'check_remote', pushUrl: targetUrl, targetRef: `refs/heads/${c.branch}`, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), result: 'network_error'
    };
    assertOwned?.();
    await writeFile(auditPath(c, 'send-manifest', targetUrl), JSON.stringify({
        operation: 'check_remote', pushUrl: targetUrl, targetRef: receipt.targetRef, credentialHelpers: auth.filter(x => x.startsWith('credential.helper=')), authenticationMayContactOtherServices: true, interactiveAuth
    }), { mode: 0o600 });
    try {
        assertOwned?.();
        const output = await git(c, [...auth, 'ls-remote', '--refs', targetUrl, ...(all ? [] : [receipt.targetRef])], interactiveAuth ? { GCM_INTERACTIVE: 'always' } : {});
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
        await writeFile(auditPath(c, 'receipt', targetUrl), JSON.stringify({ ...receipt, interactiveAuth }), { mode: 0o600 });
    }
}
export async function checkEmptyRemote(c: Config, assertOwned?: () => void, targetUrl = c.remoteUrl, interactiveAuth = false): Promise<void> {
    await remote(c, true, assertOwned, targetUrl, interactiveAuth);
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
    const outgoing = actual.slice(index + 1);
    if (s.baselineOid !== null && index < 0 || outgoing.length !== s.commits.length || outgoing.some((view, i) => view !== s.commits[i] && JSON.stringify(view) !== JSON.stringify(s.commits[i])))
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
        pushUrl: s.pushUrl, targetRef: receipt.targetRef, targetOid: s.targetOid, commitOids: s.commits.map(x => x.oid), credentialHelpers: auth.filter(x => x.startsWith('credential.helper=')), authenticationMayContactOtherServices: true, interactiveAuth: false
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
    await writeFile(auditPath(c, 'receipt', s.pushUrl), JSON.stringify({ ...receipt, interactiveAuth: false }), { mode: 0o600 });
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
export async function checkClientAvailable(source: Source): Promise<void> {
    if (source === 'codex') await codexEntry();
    else if (source === 'claude') await claudeEntry();
    else fail('invalid_client');
}
export async function setupInfo(): Promise<{ gitAvailable: boolean; codexAvailable: boolean; claudeAvailable: boolean; authorName: string; authorEmail: string }> {
    const available = async (source: Source) => {
        try { await checkClientAvailable(source); return true; }
        catch { return false; }
    };
    let gitAvailable = false, authorName = '', authorEmail = '';
    try {
        await run(GIT, ['--version']);
        gitAvailable = true;
        const env = environment();
        delete env.GIT_CONFIG_GLOBAL;
        delete env.GIT_CONFIG_SYSTEM;
        delete env.GIT_CONFIG_NOSYSTEM;
        const identity = async (key: string) => {
            let value = '';
            for (const scope of ['--system', '--global']) {
                const found = (await run(GIT, ['config', scope, '--no-includes', '--get', key], env, true)).trim();
                if (found) value = found;
            }
            return /[<>\r\n\x00]/.test(value) ? '' : value;
        };
        authorName = await identity('user.name');
        authorEmail = await identity('user.email');
    } catch { /* Detection and editable defaults remain usable when Git is absent. */ }
    return { gitAvailable, codexAvailable: await available('codex'), claudeAvailable: await available('claude'), authorName, authorEmail };
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
        const bundledSource = resolve(dirname(absoluteCli), '../..', 'startup-launcher.cs');
        const bundledLauncher = resolve(dirname(absoluteCli), '../..', 'startup-launcher.exe');
        const hasBundledSource = await exists(bundledSource), hasBundledLauncher = await exists(bundledLauncher);
        if (hasBundledSource !== hasBundledLauncher) fail('startup_conflict');
        if (hasBundledSource) {
            for (const path of [bundledSource, bundledLauncher]) {
                if (!(await lstat(path)).isFile() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
                    fail('startup_conflict');
            }
            if (await readFile(bundledSource, 'utf8') !== STARTUP_LAUNCHER) fail('startup_conflict');
        }
        if (await exists(source)) {
            if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink() || await readFile(source, 'utf8') !== STARTUP_LAUNCHER)
                fail('startup_conflict');
        }
        else
            await writeFile(source, STARTUP_LAUNCHER, { mode: 0o600, flag: 'wx' });
        if (await exists(launcher) && (!(await lstat(launcher)).isFile() || (await lstat(launcher)).isSymbolicLink()))
            fail('startup_conflict');
        if (hasBundledSource) {
            await copyFile(bundledSource, source);
            await copyFile(bundledLauncher, launcher);
        } else {
            const framework = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
            await run(join(framework, 'csc.exe'), ['/noconfig', '/nologo', '/target:winexe', '/nostdlib', `/reference:${join(framework, 'mscorlib.dll')}`, `/reference:${join(framework, 'System.dll')}`, `/out:${launcher}`, source], environment(), false, true);
        }
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
        const samePath = (actual: string | undefined | null, expected: string) => !!actual && isAbsolute(actual) && !/[\x00-\x1f"]/.test(actual) && resolve(actual).toLowerCase() === resolve(expected).toLowerCase();
        const gui = /^"([^"\x00-\x1f]+)" "([^"\x00-\x1f]+)" "([^"\x00-\x1f]+)"$/.exec(argumentsValue || '');
        const node = /^"([^"\x00-\x1f]+)" sync --watch --config "([^"\x00-\x1f]+)"$/.exec(argumentsValue || '');
        const owned = samePath(executable, launcher) && gui && [process.execPath, absoluteCli, configPath].every((path, index) => samePath(gui[index + 1], path))
            || samePath(executable, powershell) && argumentsValue === hiddenArguments
            || samePath(executable, process.execPath) && node && samePath(node[1], absoluteCli) && samePath(node[2], configPath);
        if ((xml.match(/<Exec(?:\s|>)/g) || []).length !== 1 || (xml.match(/<Command>/g) || []).length !== 1 || (xml.match(/<Arguments>/g) || []).length !== 1 || /<ComHandler(?:\s|>)/.test(xml) || !owned)
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
