import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { appendRows, LEGACY_WORKLOG_HEADER, WORKLOG_HEADER, toPublicRow, type Config, type LocalEvent, type StoreState, type Snapshot, type SyncResult, type Intent, type PublicRow } from './schema.js';
import { readState, writeState, readEvents, readIntent, writeIntent, withWriterLock } from './store.js';
import { readLocalHeadOid, readSnapshot, checkSnapshot, commitWorklog, checkEmptyRemote, refreshRemote, pushSnapshot } from './transport.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const policyCodes = ['invalid_history', 'invalid_content', 'invalid_identity', 'destination_changed', 'extra_execution'];
function applyEvents(state: StoreState, events: LocalEvent[]): PublicRow[] {
    const rows: PublicRow[] = [];
    for (const event of events) {
        if (state.processedIds.includes(event.eventId))
            continue;
        const key = event.turnKey;
        if (event.kind === 'classification') {
            const row = toPublicRow(event.progress, event.recordedAt);
            if (row) {
                const prior = state.lastProgress[key];
                if (!prior || prior.category !== row.category || prior.status !== row.status)
                    rows.push(row);
                state.lastProgress[key] = event.progress;
                if (!state.classifiedTurns.includes(key))
                    state.classifiedTurns.push(key);
            }
        }
        else if (event.kind === 'start' && !state.lastProgress[key]) {
            state.lastProgress[key] = { category: 'none', status: 'unknown' };
        }
        else if (event.kind === 'stop' && !state.stoppedTurns.includes(key))
            state.stoppedTurns.push(key);
        state.processedIds.push(event.eventId);
    }
    return rows;
}
async function worklog(c: Config): Promise<string> {
    try {
        return await readFile(join(c.gitDir, 'WORKLOG.md'), 'utf8');
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return '';
        throw new Error('invalid_content');
    }
}
async function checkpoint(c: Config, state: StoreState, events: LocalEvent[], check: () => void): Promise<void> {
    check();
    await writeState(c.privateDir, state);
    for (const event of events) {
        check();
        await unlink(join(c.privateDir, 'pending', `${event.eventId}.json`)).catch(e => {
            if (e.code !== 'ENOENT')
                throw e;
        });
    }
}
async function recover(c: Config, intent: Intent, state: StoreState, events: LocalEvent[], check: () => void): Promise<void> {
    const head = await readLocalHeadOid(c);
    if (head !== intent.baseHead) {
        const snapshot = await readSnapshot(c, { ...state, remoteOid: null }, events.length);
        const last = snapshot.commits.at(-1)!;
        if (last.oid !== head || (last.parents[0] || null) !== intent.baseHead || hash(last.worklog) !== intent.afterHash || intent.commitOid && intent.commitOid !== head)
            throw new Error('invalid_history');
        intent.commitOid = head!;
    }
    else {
        const before = await worklog(c);
        if (hash(before) !== intent.afterHash) {
            if (hash(before) !== intent.beforeHash)
                throw new Error('invalid_content');
            let after = appendRows(before, intent.rows);
            // An old bar intent must recover its exact approved bytes before badge migration.
            if (hash(after) !== intent.afterHash && (!before || before.startsWith(LEGACY_WORKLOG_HEADER) || before === WORKLOG_HEADER || before.includes(' | ■ ')))
                after = appendRows(before, intent.rows, 'legacyBars');
            // Old three-column intents likewise retain their approved serializer.
            if (hash(after) !== intent.afterHash && (!before || before.startsWith(LEGACY_WORKLOG_HEADER))) {
                for (const format of ['legacyDisplay', 'legacyIso'] as const) {
                    after = appendRows(before, intent.rows, format);
                    if (hash(after) === intent.afterHash)
                        break;
                }
            }
            if (hash(after) !== intent.afterHash)
                throw new Error('invalid_content');
            const temp = join(c.gitDir, `WORKLOG.${randomBytes(8).toString('hex')}.tmp`);
            check();
            await writeFile(temp, after, { flag: 'wx', mode: 0o600 });
            check();
            await rename(temp, join(c.gitDir, 'WORKLOG.md'));
        }
        check();
        intent.commitOid = await commitWorklog(c, intent.afterHash, check);
    }
    check();
    await writeIntent(c.privateDir, intent);
    const batch = events.filter(e => intent.eventIds.includes(e.eventId));
    if (intent.eventIds.some(id => !state.processedIds.includes(id) && !batch.some(e => e.eventId === id)))
        throw new Error('invalid_store');
    applyEvents(state, batch);
    await checkpoint(c, state, batch, check);
    check();
    await unlink(join(c.privateDir, 'intent.json'));
}
export async function preview(c: Config): Promise<Snapshot> {
    if (await readLocalHeadOid(c) === null)
        throw new Error('empty_history');
    const snapshot = await readSnapshot(c, await readState(c.privateDir), (await readEvents(c.privateDir)).length);
    const policy = checkSnapshot(c, snapshot);
    if (!policy.ok)
        throw new Error(policy.code);
    return snapshot;
}
type RemoteState = { remoteOid: string | null; remoteCheckedAt: string | null; errorCode?: string };
function targetSnapshot(full: Snapshot, remote: RemoteState, url: string): Snapshot {
    const index = remote.remoteOid === null ? -1 : full.commits.findIndex(commit => commit.oid === remote.remoteOid);
    if (remote.remoteOid !== null && index < 0)
        throw new Error('invalid_history');
    return { ...full, baselineOid: remote.remoteOid, baselineCheckedAt: remote.remoteCheckedAt, pushUrl: url, commits: full.commits.slice(index + 1) };
}
export async function previewTargets(c: Config): Promise<Snapshot[]> {
    if (await readLocalHeadOid(c) === null)
        throw new Error('empty_history');
    const state = await readState(c.privateDir);
    const full = await readSnapshot(c, { ...state, remoteOid: null }, (await readEvents(c.privateDir)).length);
    const snapshots = [targetSnapshot(full, state, c.remoteUrl)];
    if (c.mirrorUrl) {
        if (state.mirror && state.mirror.remoteUrl !== c.mirrorUrl || !state.mirror && c.mode === 'auto')
            throw new Error('destination_changed');
        snapshots.push(targetSnapshot(full, state.mirror || { remoteOid: null, remoteCheckedAt: null }, c.mirrorUrl));
    }
    for (const snapshot of snapshots) {
        const policy = checkSnapshot(c, snapshot);
        if (!policy.ok)
            throw new Error(policy.code);
    }
    return snapshots;
}
async function syncTarget(c: Config, full: Snapshot, target: RemoteState, url: string, check: () => void, revalidate: boolean): Promise<SyncResult> {
    if (target.errorCode && policyCodes.includes(target.errorCode))
        return 'paused';
    if (!revalidate && !target.errorCode && full.targetOid === target.remoteOid && target.remoteCheckedAt !== null)
        return 'idle';
    try {
        // Refresh each destination independently, including pushes whose acknowledgement was lost.
        const remote = await refreshRemote(c, check, url);
        target.remoteOid = remote.oid;
        target.remoteCheckedAt = remote.checkedAt;
        const snapshot = targetSnapshot(full, target, url);
        const policy = checkSnapshot(c, snapshot);
        if (!policy.ok)
            throw new Error(policy.code);
        if (!snapshot.commits.length) {
            delete target.errorCode;
            return 'idle';
        }
        const receipt = await pushSnapshot(c, snapshot, check);
        if (receipt.result !== 'ok')
            throw new Error('sync_failed');
        target.remoteOid = snapshot.targetOid;
        target.remoteCheckedAt = receipt.endedAt;
        delete target.errorCode;
        return 'synced';
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        target.errorCode = policyCodes.includes(message) ? message : 'sync_failed';
        return policyCodes.includes(message) ? 'paused' : 'pending';
    }
}
export async function processOnce(c: Config): Promise<SyncResult> {
    if (!c.captureEnabled)
        return 'paused';
    return withWriterLock(c.privateDir, async (check) => {
        const state = await readState(c.privateDir);
        if (state.errorCode && policyCodes.includes(state.errorCode))
            return 'paused';
        try {
            let events = await readEvents(c.privateDir);
            const intent = await readIntent(c.privateDir);
            if (intent)
                await recover(c, intent, state, events, check);
            events = await readEvents(c.privateDir);
            const next = structuredClone(state);
            const rows = applyEvents(next, events);
            if (rows.length) {
                const baseHead = await readLocalHeadOid(c);
                const before = await worklog(c);
                // Existing bytes must be the audited committed version before appending.
                if (baseHead) {
                    const snapshot = await readSnapshot(c, { ...state, remoteOid: null }, events.length);
                    if (snapshot.commits.at(-1)!.worklog !== before)
                        throw new Error('invalid_content');
                }
                else if (before !== '')
                    throw new Error('invalid_content');
                const transaction = { eventIds: events.map(e => e.eventId), baseHead, beforeHash: hash(before), afterHash: hash(appendRows(before, rows)), rows };
                check();
                await writeIntent(c.privateDir, transaction);
                await recover(c, transaction, state, events, check);
            }
            else {
                if (events.length)
                    await checkpoint(c, next, events, check);
                Object.assign(state, next);
            }
            if (c.mode === 'local')
                return rows.length || intent ? 'local' : 'idle';
            const currentOid = await readLocalHeadOid(c);
            if (currentOid === null)
                return 'idle';
            const revalidate = !!state.errorCode;
            const primary: RemoteState = { remoteOid: state.remoteOid, remoteCheckedAt: state.remoteCheckedAt, ...(state.primaryErrorCode ? { errorCode: state.primaryErrorCode } : {}) };
            if (c.mirrorUrl && state.mirror && state.mirror.remoteUrl !== c.mirrorUrl)
                state.mirror.errorCode = 'destination_changed';
            // Only enableSync may persist a new approved binding. Resume cannot approve configuration alone.
            const mirror = state.mirror || { remoteOid: null, remoteCheckedAt: null, errorCode: 'destination_changed' };
            const targets = [{ url: c.remoteUrl, remote: primary }, ...(c.mirrorUrl ? [{ url: c.mirrorUrl, remote: mirror }] : [])];
            // A known immutable HEAD already acknowledged by the remote needs no audit or network.
            // Errors deliberately disable this shortcut so retries and resume revalidate fully.
            if (!revalidate && targets.every(({ remote }) => remote.errorCode && policyCodes.includes(remote.errorCode) || !remote.errorCode && currentOid === remote.remoteOid && remote.remoteCheckedAt !== null)) {
                if (!targets.some(({ remote }) => remote.errorCode))
                    return 'idle';
                check();
                await writeState(c.privateDir, state);
                return 'paused';
            }
            // Audit local history once before either destination can receive the immutable HEAD.
            const full = await readSnapshot(c, { ...state, remoteOid: null }, (await readEvents(c.privateDir)).length);
            if (full.targetOid !== currentOid)
                throw new Error('invalid_history');
            const policy = checkSnapshot(c, full);
            if (!policy.ok)
                throw new Error(policy.code);
            delete state.errorCode;
            const results: SyncResult[] = [];
            for (const target of targets) {
                results.push(await syncTarget(c, full, target.remote, target.url, check, revalidate));
                state.remoteOid = primary.remoteOid;
                state.remoteCheckedAt = primary.remoteCheckedAt;
                if (primary.errorCode)
                    state.primaryErrorCode = primary.errorCode;
                else
                    delete state.primaryErrorCode;
                check();
                await writeState(c.privateDir, state);
            }
            if (results.includes('pending'))
                return 'pending';
            if (results.includes('paused'))
                return 'paused';
            return results.includes('synced') ? 'synced' : 'idle';
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            state.errorCode = policyCodes.includes(message) ? message : 'sync_failed';
            check();
            await writeState(c.privateDir, state);
            return policyCodes.includes(message) ? 'paused' : 'pending';
        }
    });
}
export async function enableSync(c: Config, interactiveAuth = false): Promise<void> {
    await withWriterLock(c.privateDir, async (check) => {
        await checkEmptyRemote(c, check, c.remoteUrl, interactiveAuth);
        if (c.mirrorUrl)
            await checkEmptyRemote(c, check, c.mirrorUrl, interactiveAuth);
        if (await readLocalHeadOid(c))
            await preview(c);
        const state = await readState(c.privateDir);
        state.remoteOid = null;
        state.remoteCheckedAt = new Date().toISOString();
        delete state.errorCode;
        delete state.primaryErrorCode;
        if (c.mirrorUrl)
            state.mirror = { remoteUrl: c.mirrorUrl, remoteOid: null, remoteCheckedAt: state.remoteCheckedAt };
        else
            delete state.mirror;
        check();
        await writeState(c.privateDir, state);
        c.mode = 'auto';
    });
}
export async function runPublisher(c: Config): Promise<void> {
    do {
        await processOnce(c);
        await new Promise(resolve => setTimeout(resolve, 60000));
    } while (true);
}
