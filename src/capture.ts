import { readFile, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { PROGRESS_GUIDANCE, validateProgress, type Config, type Source, type Progress, type LocalEvent } from './schema.js';
import { enqueue, withWriterLock } from './store.js';
function progressFromResult(value: unknown): Progress | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const result = value as Record<string, unknown>;
    if (result.isError !== undefined && result.isError !== false)
        return null;
    const structured = result.structuredContent === undefined ? null : validateProgress(result.structuredContent);
    if (result.structuredContent !== undefined && !structured)
        return null;
    let text: Progress | null = null;
    if (result.content !== undefined) {
        if (!Array.isArray(result.content) || result.content.length !== 1)
            return null;
        const item = result.content[0];
        if (!item || item.type !== 'text' || typeof item.text !== 'string')
            return null;
        try {
            text = validateProgress(JSON.parse(item.text));
        }
        catch {
            return null;
        }
        if (!text)
            return null;
    }
    if (structured && text && (structured.category !== text.category || structured.status !== text.status))
        return null;
    return structured || text;
}
export async function handleCommandHook(source: Source, config: Config, stdin: AsyncIterable<Uint8Array>): Promise<object> {
    if (!config.captureEnabled)
        return {};
    try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of stdin) {
            size += chunk.byteLength;
            if (size > 1024 * 1024)
                throw new Error('invalid_hook');
            chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const session = payload.session_id, turn = payload[source === 'codex' ? 'turn_id' : 'prompt_id'];
        if (typeof session !== 'string' || !session || typeof turn !== 'string' || !turn)
            return { systemMessage: 'WhatIveDone: invalid_hook' };
        const name = payload.hook_event_name;
        const kind = name === 'UserPromptSubmit' ? 'start' : name === 'Stop' ? 'stop' : name === 'PostToolUse' ? 'classification' : null;
        if (!kind)
            return { systemMessage: 'WhatIveDone: invalid_hook' };
        let progress: Progress | null = null;
        let call = '';
        if (kind === 'classification') {
            if (payload.tool_name !== 'mcp__whativedone__classify_progress')
                return {};
            const nativeCall = payload.tool_use_id;
            if (typeof nativeCall !== 'string' || !nativeCall)
                return { systemMessage: 'WhatIveDone: invalid_hook' };
            call = nativeCall;
            // Claude Code passes MCP content blocks directly; Codex keeps the result envelope.
            const result = source === 'claude' && Array.isArray(payload.tool_response) ? { content: payload.tool_response } : payload.tool_response;
            progress = progressFromResult(result);
            const input = validateProgress(payload.tool_input);
            if (!progress || !input || input.category !== progress.category || input.status !== progress.status)
                return { systemMessage: 'WhatIveDone: invalid_hook' };
        }
        return await withWriterLock(config.privateDir, async (check) => {
            const path = join(config.privateDir, 'key');
            let key: Buffer;
            try {
                key = await readFile(path);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
                key = Buffer.from(randomBytes(32).toString('hex'));
                const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
                check();
                const file = await open(temp, 'wx', 0o600);
                try {
                    try {
                        await file.writeFile(key);
                        await file.sync();
                    }
                    finally {
                        await file.close();
                    }
                    check();
                    await link(temp, path);
                }
                finally {
                    await unlink(temp).catch(() => {
                    });
                }
            }
            if (!/^[a-f0-9]{64}$/.test(key.toString()))
                throw new Error('invalid_identity_key');
            const hash = (parts: string[]) => createHmac('sha256', key).update(JSON.stringify(parts)).digest('hex');
            const common = { eventId: hash([source, session, turn, kind, call]), turnKey: hash([source, session, turn]), source, recordedAt: new Date().toISOString() };
            const event: LocalEvent = kind === 'classification' ? { ...common, kind, progress: progress! } : { ...common, kind };
            await enqueue(config.privateDir, event);
            return kind === 'start'
                ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROGRESS_GUIDANCE } }
                : {};
        }, 'capture');
    }
    catch {
        return { systemMessage: 'WhatIveDone: capture_failed' };
    }
}
