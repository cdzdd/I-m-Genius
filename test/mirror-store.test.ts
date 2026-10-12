import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readState, writeState } from '../src/store.js';
import type { StoreState } from '../src/schema.js';

test('mirror state survives projection while unrecognized private fields never persist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-mirror-store-'));
    const state = await readState(root);
    Object.assign(state, { primaryErrorCode: 'auth_required', privateExtra: 'PRIVATE_CANARY', mirror: { remoteUrl: 'https://mirror.invalid/log.git', remoteOid: 'a'.repeat(40), remoteCheckedAt: '2026-10-09T00:00:00.000Z', errorCode: 'network_error', rawExtra: 'PRIVATE_CANARY' } });
    await writeState(root, state);
    const persisted = await readFile(join(root, 'state.json'), 'utf8');
    assert.equal(persisted.includes('PRIVATE_CANARY'), false);
    const after = await readState(root);
    assert.equal(after.primaryErrorCode, 'auth_required');
    assert.deepEqual(after.mirror, { remoteUrl: 'https://mirror.invalid/log.git', remoteOid: 'a'.repeat(40), remoteCheckedAt: '2026-10-09T00:00:00.000Z', errorCode: 'network_error' });
    const legacy = await readState(await mkdtemp(join(tmpdir(), 'whativedone-legacy-store-')));
    assert.equal(Object.hasOwn(legacy, 'mirror'), false);
});

test('mirror persistence rejects malformed URL, oid, date and error metadata on read and write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whativedone-mirror-store-invalid-'));
    const base = await readState(root);
    const mirror = { remoteUrl: 'https://mirror.invalid/log.git', remoteOid: null, remoteCheckedAt: null };
    const invalid: unknown[] = [
        { ...mirror, remoteUrl: 'https://user:PRIVATE_CANARY@mirror.invalid/log.git' },
        { ...mirror, remoteUrl: 'https://MIRROR.invalid/log.git' },
        { ...mirror, remoteUrl: 'https://mirror.invalid/log.git?q=PRIVATE_CANARY' },
        { ...mirror, remoteUrl: 'https://mirror.invalid/log.git?' },
        { ...mirror, remoteUrl: 'https://mirror.invalid/log.git#' },
        { ...mirror, remoteOid: 'a'.repeat(64) },
        { ...mirror, remoteOid: 'A'.repeat(40) },
        { ...mirror, remoteCheckedAt: '2026-02-30T00:00:00.000Z' },
        { ...mirror, remoteCheckedAt: '2026-10-09 00:00:00' },
        { ...mirror, errorCode: 'PRIVATE_CANARY' },
        null,
        []
    ];
    for (const value of invalid) {
        const state = { ...base, mirror: value } as StoreState;
        await assert.rejects(writeState(root, state), { message: 'invalid_store' });
        await writeFile(join(root, 'state.json'), JSON.stringify(state));
        await assert.rejects(readState(root), { message: 'invalid_store' });
    }
    await assert.rejects(writeState(root, { ...base, primaryErrorCode: 'PRIVATE_CANARY' }), { message: 'invalid_store' });
});
