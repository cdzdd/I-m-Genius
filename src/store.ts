import { mkdir, open, rename, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateProgress, toPublicRow, type LocalEvent, type StoreState, type Intent, type MirrorState } from './schema.js';
const keyPattern = /^[a-f0-9]{64}$/;
const ownership = new AsyncLocalStorage<() => void>();
function validEvent(event: LocalEvent): boolean {
    if (!event || !keyPattern.test(event.eventId) || !keyPattern.test(event.turnKey) || !['codex', 'claude'].includes(event.source) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.recordedAt) || !Number.isFinite(Date.parse(event.recordedAt)) || new Date(event.recordedAt).toISOString() !== event.recordedAt)
        return false;
    const keys = Object.keys(event).sort().join(',');
    return event.kind === 'classification' ? keys === 'eventId,kind,progress,recordedAt,source,turnKey' && !!validateProgress(event.progress) : ['start', 'stop'].includes(event.kind) && keys === 'eventId,kind,recordedAt,source,turnKey';
}
async function atomicWrite(path: string, value: string, check?: () => void): Promise<void> {
    const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
        await file.writeFile(value);
        await file.sync();
    }
    finally {
        await file.close();
    }
    try {
        check?.();
        await rename(temp, path);
    }
    catch {
        await unlink(temp).catch(() => {
        });
        throw new Error('store_write_failed');
    }
}
export async function withWriterLock<T>(privateDir: string, action: (check: () => void) => Promise<T>, domain: 'publisher' | 'capture' = 'publisher'): Promise<T> {
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(join(privateDir, domain), { realpath: false, stale: 120000, update: 10000, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 }, onCompromised: () => {
            compromised = true;
        } });
    const check = () => {
        if (compromised)
            throw new Error('writer_lock_lost');
    };
    try {
        check();
        const result = await ownership.run(check, () => action(check));
        check();
        return result;
    }
    finally {
        await release();
    }
}
export async function enqueue(privateDir: string, event: LocalEvent): Promise<'saved' | 'duplicate'> {
    if (!validEvent(event))
        throw new Error('invalid_event');
    const dir = join(privateDir, 'pending');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${event.eventId}.json`);
    try {
        await readFile(path);
        return 'duplicate';
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw new Error('store_read_failed');
    }
    ownership.getStore()?.();
    await atomicWrite(path, JSON.stringify(event), ownership.getStore());
    return 'saved';
}
export async function readEvents(privateDir: string): Promise<LocalEvent[]> {
    const dir = join(privateDir, 'pending');
    let names: string[];
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw new Error('store_read_failed');
    }
    const events: LocalEvent[] = [];
    for (const name of names.sort()) {
        if (name.endsWith('.tmp'))
            continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name))
            throw new Error('invalid_event');
        const event = JSON.parse(await readFile(join(dir, name), 'utf8')) as LocalEvent;
        if (!validEvent(event) || name !== `${event.eventId}.json`)
            throw new Error('invalid_event');
        events.push(event);
    }
    return events.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.eventId.localeCompare(b.eventId));
}
async function readJson<T>(privateDir: string, name: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(join(privateDir, name), 'utf8')) as T;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return fallback;
        throw new Error('store_read_failed');
    }
}
function ids(values: string[]): string[] {
    if (!Array.isArray(values) || !values.every(value => keyPattern.test(value)))
        throw new Error('invalid_store');
    return [...values];
}
function cleanState(state: StoreState): StoreState {
    const lastProgress: Record<string, import('./schema.js').Progress> = {};
    for (const [key, value] of Object.entries(state.lastProgress)) {
        const progress = validateProgress(value);
        if (!keyPattern.test(key) || !progress)
            throw new Error('invalid_store');
        lastProgress[key] = progress;
    }
    if (state.remoteOid !== null && (typeof state.remoteOid !== 'string' || !/^[a-f0-9]{40,64}$/.test(state.remoteOid)) || !validCheckedAt(state.remoteCheckedAt) || !validError(state.errorCode) || !validError(state.primaryErrorCode))
        throw new Error('invalid_store');
    let mirror: MirrorState | undefined;
    if (state.mirror !== undefined) {
        const value = state.mirror;
        let url: URL;
        try { url = new URL(value?.remoteUrl); } catch { throw new Error('invalid_store'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.remoteUrl !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value.remoteUrl || /[\s\x00-\x1f\\?#]/.test(value.remoteUrl) || value.remoteOid !== null && (typeof value.remoteOid !== 'string' || !/^[a-f0-9]{40}$/.test(value.remoteOid)) || !validCheckedAt(value.remoteCheckedAt) || !validError(value.errorCode))
            throw new Error('invalid_store');
        mirror = { remoteUrl: value.remoteUrl, remoteOid: value.remoteOid, remoteCheckedAt: value.remoteCheckedAt, ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }) };
    }
    return { processedIds: ids(state.processedIds), lastProgress, classifiedTurns: ids(state.classifiedTurns), stoppedTurns: ids(state.stoppedTurns), remoteOid: state.remoteOid, remoteCheckedAt: state.remoteCheckedAt, ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }), ...(state.primaryErrorCode === undefined ? {} : { primaryErrorCode: state.primaryErrorCode }), ...(mirror === undefined ? {} : { mirror }) };
}
function validCheckedAt(time: string | null): boolean {
    return time === null || typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
}
function validError(code: string | undefined): boolean {
    return code === undefined || typeof code === 'string' && /^[a-z_]{1,64}$/.test(code);
}
function cleanIntent(intent: Intent): Intent {
    if (!keyPattern.test(intent.beforeHash) || !keyPattern.test(intent.afterHash) || intent.baseHead !== null && !/^[a-f0-9]{40,64}$/.test(intent.baseHead) || intent.commitOid !== undefined && !/^[a-f0-9]{40,64}$/.test(intent.commitOid))
        throw new Error('invalid_store');
    const rows = intent.rows.map(row => {
        const clean = toPublicRow({ category: row.category, status: row.status }, row.time);
        if (!clean)
            throw new Error('invalid_store');
        return clean;
    });
    return { eventIds: ids(intent.eventIds), baseHead: intent.baseHead, beforeHash: intent.beforeHash, afterHash: intent.afterHash, rows, ...(intent.commitOid === undefined ? {} : { commitOid: intent.commitOid }) };
}
export async function readState(privateDir: string): Promise<StoreState> {
    return cleanState(await readJson(privateDir, 'state.json', { processedIds: [], lastProgress: {}, classifiedTurns: [], stoppedTurns: [], remoteOid: null, remoteCheckedAt: null }));
}
export async function writeState(privateDir: string, state: StoreState): Promise<void> {
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    ownership.getStore()?.();
    await atomicWrite(join(privateDir, 'state.json'), JSON.stringify(cleanState(state)), ownership.getStore());
}
export async function readIntent(privateDir: string): Promise<Intent | null> {
    const intent = await readJson<Intent | null>(privateDir, 'intent.json', null);
    return intent === null ? null : cleanIntent(intent);
}
export async function writeIntent(privateDir: string, intent: Intent): Promise<void> {
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    ownership.getStore()?.();
    await atomicWrite(join(privateDir, 'intent.json'), JSON.stringify(cleanIntent(intent)), ownership.getStore());
}
