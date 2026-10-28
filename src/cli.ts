#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, access, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import lockfile from 'proper-lockfile';
import { type Config, type Source } from './schema.js';
import { handleCommandHook } from './capture.js';
import { runMcp } from './mcp.js';
import { readEvents, readState, writeState, withWriterLock, readRunHealth, writeRunHealth, readWatcherStatus, type RunHealth } from './store.js';
import { initializeLocalRepository, manageStartup, registerClientMcp, removeClientMcp, securePrivateDirectory, checkClientAvailable, setupInfo } from './transport.js';
import { processOnce, preview, previewTargets, enableSync } from './publish.js';
const absoluteCli = fileURLToPath(import.meta.url);
const defaultPath = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'WhatIveDone', 'config.json');
async function json(path: string, fallback?: any): Promise<any> {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
        if (fallback !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT')
            return fallback;
        throw new Error('invalid_config');
    }
}
async function save(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
}
export async function loadConfig(path: string): Promise<Config> {
    const c = await json(path);
    const keys = ['privateDir', 'gitDir', 'remoteUrl', 'branch', 'authorName', 'authorEmail'];
    if (!c || keys.some(k => typeof c[k] !== 'string') || !isAbsolute(c.privateDir) || !isAbsolute(c.gitDir) || typeof c.captureEnabled !== 'boolean' || !['local', 'auto'].includes(c.mode))
        throw new Error('invalid_config');
    if (!validRepoUrl(c.remoteUrl) || c.mirrorUrl !== undefined && (!validRepoUrl(c.mirrorUrl) || c.mirrorUrl === c.remoteUrl) || !/^[-a-zA-Z0-9_]+$/.test(c.branch) || !c.authorName || !c.authorEmail || /[<>\r\n\x00]/.test(c.authorName + c.authorEmail))
        throw new Error('invalid_config');
    return Object.fromEntries([...keys, 'captureEnabled', 'mode', ...(c.mirrorUrl === undefined ? [] : ['mirrorUrl'])].map(k => [k, c[k]])) as Config;
}
function validRepoUrl(value: unknown): boolean {
    if (typeof value !== 'string' || /[\s\x00-\x1f\\?#]/.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value;
    } catch { return false; }
}
function hookCommand(source: Source, configPath: string): string {
    const paths = [process.execPath, absoluteCli, configPath];
    if (paths.some(path => !isAbsolute(path) || /[$`%"'\r\n\x00&|<>!^]/.test(path)))
        throw new Error('unsupported_install_path');
    const quote = (path: string) => `'${path.replaceAll('\\', '/')}'`;
    return `powershell.exe -NoProfile -NonInteractive -Command "& ${quote(process.execPath)} ${quote(absoluteCli)} hook ${source} --config ${quote(configPath)}"`;
}
type InstalledSource = {
    source: Source;
    hookPath: string;
    mcpPath: string;
    blocks: Record<string, unknown>;
    server: unknown;
    status: 'configured_unverified';
};
async function sourcePaths(source: Source): Promise<{
    hooks: string;
    mcp: string;
}> {
    if (source === 'codex') {
        const home = process.env.CODEX_HOME || join(homedir(), '.codex');
        return { hooks: join(home, 'hooks.json'), mcp: join(home, 'config.toml') };
    }
    const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    try {
        await access(join(home, '.config.json'));
        throw new Error('invalid_client');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
    return { hooks: join(home, 'settings.json'), mcp: process.env.CLAUDE_CONFIG_DIR ? join(home, '.claude.json') : join(homedir(), '.claude.json') };
}
async function currentServer(source: Source, path: string): Promise<unknown> {
    if (source === 'claude')
        return (await json(path, {})).mcpServers?.whativedone;
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw new Error('invalid_client');
    }
    try {
        return (parseToml(text).mcp_servers as any)?.whativedone;
    }
    catch {
        throw new Error('invalid_client');
    }
}
async function prepareSource(source: Source, configPath: string) {
    const paths = await sourcePaths(source);
    const command = hookCommand(source, configPath);
    if (await currentServer(source, paths.mcp) !== undefined)
        throw new Error('client_conflict');
    await checkClientAvailable(source);
    const config = await json(paths.hooks, {});
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))
        throw new Error('invalid_client');
    const blocks: Record<string, unknown> = {};
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
        if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event]))
            throw new Error('invalid_client');
        blocks[event] = { ...(event === 'PostToolUse' ? { matcher: 'mcp__whativedone__classify_progress' } : {}), hooks: [{ type: 'command', command, ...(source === 'claude' ? { shell: 'powershell' } : {}) }] };
    }
    return { paths, config, blocks };
}
async function installSource(c: Config, source: Source, configPath: string): Promise<InstalledSource> {
    const { paths, config, blocks } = await prepareSource(source, configPath);
    // Backups can contain source-app configuration; keep them only in the protected directory.
    for (const [kind, path] of Object.entries(paths)) {
        try {
            await writeFile(join(c.privateDir, `${source}-${kind}-${randomBytes(6).toString('hex')}.backup`), await readFile(path), { mode: 0o600, flag: 'wx' });
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new Error('client_config_failed');
        }
    }
    await registerClientMcp(source, absoluteCli);
    const server = await currentServer(source, paths.mcp);
    if (!server)
        throw new Error('client_config_failed');
    const installed: InstalledSource = { source, hookPath: paths.hooks, mcpPath: paths.mcp, blocks, server, status: 'configured_unverified' };
    // Record MCP ownership before the subsequent hook write can fail.
    const ledger = await json(join(c.privateDir, 'integrations.json'), []);
    ledger.push(installed);
    await save(join(c.privateDir, 'integrations.json'), ledger);
    config.hooks ||= {};
    for (const [event, block] of Object.entries(blocks))
        config.hooks[event] = [...(config.hooks[event] || []), block];
    await mkdir(dirname(paths.hooks), { recursive: true });
    await save(paths.hooks, config);
    return installed;
}
async function setupCheck(options: Record<string, string>, sources: Source[], configPath: string): Promise<void> {
    if (!options['--repo'] || !options['--name'] || !options['--email'])
        throw new Error('invalid_arguments');
    if (!validRepoUrl(options['--repo']) || options['--mirror'] === options['--repo'] || /[<>\r\n\x00]/.test(options['--name'] + options['--email']))
        throw new Error('invalid_config');
    try {
        await access(configPath);
        throw new Error('already_initialized');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const privateDir = dirname(configPath);
    try {
        if ((await lstat(privateDir)).isSymbolicLink()) throw new Error('invalid_history');
        if ((await readdir(privateDir)).length) throw new Error('private_directory_not_empty');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const native of new Set(sources)) await prepareSource(native, configPath);
}
async function uninstall(c: Config, configPath: string): Promise<void> {
    const ledger: InstalledSource[] = await json(join(c.privateDir, 'integrations.json'), []);
    for (const item of ledger) {
        const paths = await sourcePaths(item.source);
        if (paths.mcp !== item.mcpPath || paths.hooks !== item.hookPath)
            throw new Error('client_conflict');
        const config = await json(item.hookPath, {});
        for (const [event, block] of Object.entries(item.blocks)) {
            if (Array.isArray(config.hooks?.[event]))
                config.hooks[event] = config.hooks[event].filter((value: unknown) => JSON.stringify(value) !== JSON.stringify(block));
        }
        await save(item.hookPath, config);
        if (JSON.stringify(await currentServer(item.source, paths.mcp)) === JSON.stringify(item.server))
            await removeClientMcp(item.source);
    }
    const startup = await json(join(c.privateDir, 'startup.json'), { installed: false });
    if (startup.installed)
        await manageStartup('remove', absoluteCli, configPath);
    await save(join(c.privateDir, 'integrations.json'), []);
    await save(join(c.privateDir, 'startup.json'), { installed: false });
}
export async function runCli(args: string[], input: AsyncIterable<Uint8Array> = process.stdin, output: (line: string) => void = console.log): Promise<number> {
    try {
        const command = args[0];
        if (command === 'mcp' && args.length === 1) {
            await runMcp();
            return 0;
        }
        const options: Record<string, string> = {};
        const sources: Source[] = [];
        let source: Source | undefined;
        let noStartup = false, watch = false, interactiveAuth = false;
        const setupCommand = command === 'init' || command === 'setup-check';
        if (!['setup-info', 'setup-check', 'init', 'hook', 'start', 'sync', 'preview', 'status', 'enable-sync', 'pause', 'resume', 'uninstall'].includes(command))
            throw new Error('invalid_arguments');
        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (command === 'hook' && i === 1 && ['codex', 'claude'].includes(arg)) {
                source = arg as Source;
                continue;
            }
            if (arg === '--no-startup') {
                if (command !== 'init' || noStartup) throw new Error('invalid_arguments');
                noStartup = true;
                continue;
            }
            if (arg === '--watch') {
                if (command !== 'sync' || watch) throw new Error('invalid_arguments');
                watch = true;
                continue;
            }
            if (arg === '--interactive-auth') {
                if (command !== 'enable-sync' || interactiveAuth) throw new Error('invalid_arguments');
                interactiveAuth = true;
                continue;
            }
            if (!['--config', '--repo', '--mirror', '--name', '--email', '--source'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--'))
                throw new Error('invalid_arguments');
            if (command === 'setup-info' || arg !== '--config' && !(setupCommand || command === 'enable-sync' && arg === '--mirror'))
                throw new Error('invalid_arguments');
            const value = args[++i];
            if (arg === '--source') {
                if (!['codex', 'claude'].includes(value))
                    throw new Error('invalid_arguments');
                sources.push(value as Source);
            }
            else {
                if (options[arg])
                    throw new Error('invalid_arguments');
                options[arg] = value;
            }
        }
        if (command === 'hook' && !source) throw new Error('invalid_arguments');
        if (options['--mirror'] !== undefined && !['init', 'setup-check', 'enable-sync'].includes(command))
            throw new Error('invalid_arguments');
        if (options['--mirror'] !== undefined && !validRepoUrl(options['--mirror']))
            throw new Error('invalid_config');
        if (command === 'setup-info') {
            output(JSON.stringify(await setupInfo()));
            return 0;
        }
        let configPath = resolve(options['--config'] || defaultPath());
        if (setupCommand) {
            await setupCheck(options, sources, configPath);
            if (command === 'setup-check') {
                output(JSON.stringify({ ready: true }));
                return 0;
            }
        }
        if (command === 'init') {
            let privateDir = dirname(configPath);
            await mkdir(privateDir, { recursive: true });
            if ((await lstat(privateDir)).isSymbolicLink())
                throw new Error('invalid_history');
            // MSIX can virtualize a normal directory without making it a symlink.
            privateDir = await realpath(privateDir);
            if ((await readdir(privateDir)).length)
                throw new Error('private_directory_not_empty');
            configPath = join(privateDir, basename(configPath));
            await securePrivateDirectory(privateDir);
            const c: Config = { privateDir, gitDir: join(privateDir, 'repository'), remoteUrl: options['--repo'], ...(options['--mirror'] === undefined ? {} : { mirrorUrl: options['--mirror'] }), branch: 'main', authorName: options['--name'], authorEmail: options['--email'], captureEnabled: true, mode: 'local' };
            await initializeLocalRepository(c);
            await save(configPath, c);
            for (const native of [...new Set(sources)])
                await installSource(c, native, configPath);
            if (!noStartup) {
                await manageStartup('install', absoluteCli, configPath);
                await save(join(privateDir, 'startup.json'), { installed: true });
                await manageStartup('start', absoluteCli, configPath);
            }
            output(JSON.stringify({ mode: 'local', configPath, sources: sources.map(source => ({ source, status: 'configured_unverified' })), boundary: 'Only fixed UTC/category/status rows and Git identity are public. Raw hook bodies are discarded. Native hook trust must be granted through the host. Auto enables future rule-based sends; credential helpers may contact authentication services.' }));
            return 0;
        }
        const c = await loadConfig(configPath);
        if (options['--mirror'] !== undefined) {
            if (options['--mirror'] === c.remoteUrl)
                throw new Error('invalid_config');
            c.mirrorUrl = options['--mirror'];
        }
        if (command === 'hook' && source)
            output(JSON.stringify(await handleCommandHook(source, c, input)));
        else if (command === 'start') {
            await manageStartup('start', absoluteCli, configPath);
            output('started');
        }
        else if (command === 'sync') {
            let release: (() => Promise<void>) | undefined;
            let compromised = false;
            if (watch) {
                const lockPath = join(c.privateDir, 'watcher');
                const deadline = Date.now() + 130000;
                let heartbeat: number | undefined;
                while (!release) {
                    try {
                        release = await lockfile.lock(lockPath, { realpath: false, stale: 120000, update: 10000, retries: 0, onCompromised: () => {
                                compromised = true;
                            } });
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
                        let current: number | undefined;
                        try {
                            current = (await lstat(`${lockPath}.lock`)).mtimeMs;
                        }
                        catch (statError) {
                            if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
                        }
                        // Only an advancing heartbeat establishes a live owner. A reboot can
                        // leave a recent lock whose normal stale window has not elapsed yet.
                        if (current !== undefined && heartbeat !== undefined && current > heartbeat) {
                            output('already_running');
                            return 0;
                        }
                        heartbeat = current;
                        if (Date.now() >= deadline) throw new Error('watcher_start_failed');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
            try {
                do {
                    if (compromised)
                        throw new Error('watcher_lock_lost');
                    const startedAt = new Date().toISOString();
                    const report = async (value: RunHealth) => {
                        try { await writeRunHealth(c.privateDir, value); }
                        catch { output('diagnostics_unavailable'); }
                    };
                    await report({ startedAt, completedAt: null, durationMs: null, result: 'processing' });
                    try {
                        const result = await processOnce(await loadConfig(configPath));
                        const completedAt = new Date().toISOString();
                        await report({ startedAt, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), result });
                        output(result);
                    } catch (error) {
                        const completedAt = new Date().toISOString();
                        await report({ startedAt, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), result: 'failed' });
                        throw error;
                    }
                    if (watch)
                        await new Promise(resolve => setTimeout(resolve, 60000));
                } while (watch);
            }
            finally {
                await release?.();
            }
        }
        else if (command === 'preview') {
            try {
                output(JSON.stringify(c.mirrorUrl ? await previewTargets(c) : await preview(c), null, 2));
            }
            catch (error) {
                if (error instanceof Error && error.message === 'empty_history')
                    output(JSON.stringify({ result: 'empty', queuedCount: (await readEvents(c.privateDir)).length }));
                else
                    throw error;
            }
        }
        else if (command === 'status') {
            const state = await readState(c.privateDir);
            const events = await readEvents(c.privateDir);
            let lastRun: RunHealth | null = null, runHealthError: 'unavailable' | null = null;
            try { lastRun = await readRunHealth(c.privateDir); }
            catch { runHealthError = 'unavailable'; }
            const mirror = state.mirror?.remoteUrl === c.mirrorUrl ? state.mirror : undefined;
            const targets = [{ url: c.remoteUrl, lastSentOid: state.remoteOid, lastCheckedAt: state.remoteCheckedAt, errorCode: state.primaryErrorCode || null }, ...(c.mirrorUrl ? [{ url: c.mirrorUrl, lastSentOid: mirror?.remoteOid || null, lastCheckedAt: mirror?.remoteCheckedAt || null, errorCode: mirror?.errorCode || (c.mode === 'auto' && !mirror ? 'destination_changed' : null) }] : [])];
            output(JSON.stringify({ mode: c.mode, captureEnabled: c.captureEnabled, target: c.remoteUrl, targets, branch: c.branch, queuedCount: events.length, oldestQueuedAt: events[0]?.recordedAt || null, watcher: await readWatcherStatus(c.privateDir), lastRun, runHealthError, unclassifiedCount: state.stoppedTurns.filter(key => !state.classifiedTurns.includes(key)).length, lastSentOid: state.remoteOid, errorCode: state.errorCode || null, sources: (await json(join(c.privateDir, 'integrations.json'), [])).map((item: InstalledSource) => ({ source: item.source, status: item.status })) }));
        }
        else if (command === 'enable-sync') {
            output(JSON.stringify({ target: c.remoteUrl, targets: [c.remoteUrl, ...(c.mirrorUrl ? [c.mirrorUrl] : [])].map(url => ({ url })), branch: c.branch, authorName: c.authorName, authorEmail: c.authorEmail, authorization: 'Future rule-based sends; this does not mean each entry was manually approved.' }));
            await enableSync(c, interactiveAuth);
            await save(configPath, c);
            output('auto');
        }
        else if (command === 'pause' || command === 'resume') {
            if (command === 'resume') {
                await withWriterLock(c.privateDir, async (check) => {
                    try {
                        await preview(c);
                    }
                    catch (error) {
                        if (!(error instanceof Error) || error.message !== 'empty_history')
                            throw error;
                    }
                    const state = await readState(c.privateDir);
                    if (state.errorCode || state.primaryErrorCode || state.mirror?.errorCode) {
                        if (state.errorCode) {
                            if (c.mode === 'auto') state.errorCode = 'revalidation_required';
                            else delete state.errorCode;
                        }
                        if (state.primaryErrorCode) {
                            if (c.mode === 'auto') state.primaryErrorCode = 'revalidation_required';
                            else delete state.primaryErrorCode;
                        }
                        if (state.mirror?.errorCode) {
                            if (c.mode === 'auto') state.mirror.errorCode = 'revalidation_required';
                            else delete state.mirror.errorCode;
                        }
                        check();
                        await writeState(c.privateDir, state);
                    }
                });
            }
            c.captureEnabled = command === 'resume';
            await save(configPath, c);
            output(command === 'pause' ? 'paused' : 'resumed');
        }
        else if (command === 'uninstall') {
            c.captureEnabled = false;
            await save(configPath, c);
            await uninstall(c, configPath);
            output('uninstalled');
        }
        else
            throw new Error('invalid_arguments');
        return 0;
    }
    catch (error) {
        const allowed = ['startup_conflict', 'watcher_lock_lost', 'watcher_start_failed', 'private_directory_not_empty', 'invalid_arguments', 'invalid_config', 'already_initialized', 'client_conflict', 'invalid_client', 'client_config_failed', 'unsupported_install_path', 'invalid_history', 'invalid_content', 'invalid_identity', 'destination_changed', 'extra_execution'];
        const message = error instanceof Error ? error.message : '';
        if (args[0] === 'hook') {
            output(JSON.stringify({ systemMessage: `WhatIveDone hook failed: ${allowed.includes(message) ? message : 'operation_failed'}` }));
            return 0;
        }
        output(JSON.stringify({ errorCode: allowed.includes(message) ? message : 'operation_failed' }));
        return 1;
    }
}
if (process.argv[1] && resolve(process.argv[1]) === absoluteCli)
    process.exitCode = await runCli(process.argv.slice(2));
