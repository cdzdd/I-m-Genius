import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCommandHook } from '../src/capture.js';
import { readEvents, readState, writeState, readIntent, writeIntent, withWriterLock } from '../src/store.js';
import type { Config, Source } from '../src/schema.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import lockfile from 'proper-lockfile';
import { assertNativeHookOutput } from './native-hook-output.js';

async function fixture(action: (config: Config)=>Promise<void>) {
  const privateDir = await mkdtemp(join(tmpdir(), 'whativedone-capture-'));
  try { await action({ privateDir, gitDir: '', remoteUrl: '', branch: '', authorName: '', authorEmail: '', captureEnabled: true, mode: 'local' }); }
  finally { await rm(privateDir, { recursive: true, force: true }); }
}
async function hook(config: Config, payload: object, source: Source = 'codex') {
  async function* input() { yield Buffer.from(JSON.stringify(payload)); }
  const output = await handleCommandHook(source, config, input());
  const event = (payload as { hook_event_name: string }).hook_event_name;
  assertNativeHookOutput(event === 'Stop' || event === 'PostToolUse' ? event : 'UserPromptSubmit', output);
  return output;
}
const start = { hook_event_name: 'UserPromptSubmit', session_id: 'session', turn_id: 'turn', prompt: 'PRIVATE_CANARY', cwd: 'PRIVATE_CANARY', transcript_path: 'PRIVATE_CANARY', last_assistant_message: 'PRIVATE_CANARY' };
const guidance = 'For the WhatIveDone progress journal, call mcp__whativedone__classify_progress at meaningful progress milestones and before stopping. Send only category and status: category research, planning, implementation, verification, or debugging; status in_progress, waiting_input, blocked, or ai_reported_done. Use category none with status unknown for no meaningful progress. ai_reported_done means the AI reports completion; do not infer completion merely from stopping. The tool validates the classification; the native PostToolUse hook saves it.';
const startOutput = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: guidance } };
const invalidHook = { systemMessage: 'WhatIveDone: invalid_hook' };
test('version-pinned native output schemas reject internal outcomes and event-mismatched context', () => {
  for (const event of ['UserPromptSubmit', 'Stop', 'PostToolUse'] as const) {
    assertNativeHookOutput(event, {});
    assertNativeHookOutput(event, { systemMessage: 'fixed warning' });
    assert.throws(() => assertNativeHookOutput(event, { result: 'saved' }));
    assert.throws(() => assertNativeHookOutput(event, { errorCode: 'invalid_hook' }));
  }
  assert.throws(() => assertNativeHookOutput('UserPromptSubmit', { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'fixed' } }));
  assert.throws(() => assertNativeHookOutput('UserPromptSubmit', { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'fixed', extra: true } }));
  assert.throws(() => assertNativeHookOutput('Stop', { hookSpecificOutput: { hookEventName: 'Stop' } }));
});
test('start emits fixed native guidance for both sources and replays without private text', async()=>fixture(async config=>{
  for (const source of ['codex', 'claude'] as const) {
    const payload = {...start, prompt_id:'turn'};
    assert.deepEqual(await hook(config,payload,source),startOutput);
    const first = (await readEvents(config.privateDir)).find(event => event.source === source);
    const replay = await hook(config,{...payload,prompt:'different PRIVATE_CANARY'},source);
    assert.deepEqual(replay,startOutput);
    assert.deepEqual((await readEvents(config.privateDir)).find(event => event.source === source), first);
    assert.equal(JSON.stringify(replay).includes('PRIVATE_CANARY'),false);
  }
  assert.equal((await readEvents(config.privateDir)).length,2);
}));
test('projects_payload_before_downstream and rejects unsafe result wrappers', async()=>fixture(async config=>{
  assert.deepEqual(await hook(config, start), startOutput);
  const events = await readEvents(config.privateDir);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['eventId','kind','recordedAt','source','turnKey']);
  assert.match(events[0].eventId, /^[a-f0-9]{64}$/);
  assert.equal(events[0].kind, 'start');
  const post = { ...start, hook_event_name: 'PostToolUse', tool_name: 'mcp__whativedone__classify_progress', tool_use_id: 'call', tool_input: { category: 'implementation', status: 'in_progress' }, tool_response: { structuredContent: { category: 'implementation', status: 'in_progress' } } };
  assert.deepEqual(await hook(config, post), {});
  for (const tool_response of [{ isError: true, structuredContent: { category:'research', status:'in_progress' } }, { structuredContent:{ category:'research', status:'in_progress', extra:'PRIVATE_CANARY' } }, { structuredContent:{category:'research',status:'in_progress'}, content:[{type:'text',text:'{"category":"planning","status":"in_progress"}'}] }]) {
    assert.deepEqual(await hook(config, { ...post, tool_response }), invalidHook);
  }
  assert.equal((await readEvents(config.privateDir)).length, 2);
  for (const name of await readdir(config.privateDir)) if (name.endsWith('.json')) assert.equal((await readFile(join(config.privateDir,name),'utf8')).includes('PRIVATE_CANARY'), false);
  assert.equal(JSON.stringify(await readEvents(config.privateDir)).includes('PRIVATE_CANARY'), false);
}));
test('Claude native MCP content array records correlated enum progress and replays once', async()=>fixture(async config=>{
  const native = { ...start, turn_id:undefined, prompt_id:'PRIVATE_CANARY_prompt' };
  assert.deepEqual(await hook(config,native,'claude'),startOutput);
  const post = { ...native, hook_event_name:'PostToolUse', tool_name:'mcp__whativedone__classify_progress', tool_use_id:'PRIVATE_CANARY_call', tool_input:{category:'debugging',status:'in_progress'}, tool_response:[{type:'text',text:'{"category":"debugging","status":"in_progress"}'}] };
  assert.deepEqual(await hook(config,post,'claude'),{});
  const first = (await readEvents(config.privateDir)).find(event=>event.kind==='classification');
  assert.ok(first?.kind==='classification');
  assert.deepEqual(first.progress,{category:'debugging',status:'in_progress'});
  assert.deepEqual(await hook(config,post,'claude'),{});
  assert.deepEqual(await hook(config,{...native,hook_event_name:'Stop'},'claude'),{});
  const events = await readEvents(config.privateDir);
  assert.equal(events.length,3);
  assert.equal(new Set(events.map(event=>event.turnKey)).size,1);
  assert.deepEqual(events.find(event=>event.kind==='classification'),first);
  for (const name of await readdir(config.privateDir)) if (name.endsWith('.json')) assert.equal((await readFile(join(config.privateDir,name),'utf8')).includes('PRIVATE_CANARY'),false);
}));
test('Claude native array parsing rejects malformed, mismatched and failed classifications without broadening Codex', async()=>fixture(async config=>{
  const text = {type:'text',text:'{"category":"debugging","status":"in_progress"}'};
  const post = { ...start, prompt_id:'turn', hook_event_name:'PostToolUse', tool_name:'mcp__whativedone__classify_progress', tool_use_id:'call', tool_input:{category:'debugging',status:'in_progress'}, tool_response:[text] };
  assert.deepEqual(await hook(config,post,'codex'),invalidHook);
  const unsafe = [[],[text,text],[{type:'image',text:text.text}],[{type:'text',text:'PRIVATE_CANARY'}],[{type:'text',text:'{"category":"debugging","status":"in_progress","summary":"PRIVATE_CANARY"}'}],[{type:'text',text:'{"category":"debugging","status":"ai_reported_done"}'}],{isError:true,content:[text]}];
  for (const tool_response of unsafe) assert.deepEqual(await hook(config,{...post,tool_response},'claude'),invalidHook);
  assert.deepEqual(await hook(config,{...post,tool_use_id:undefined},'claude'),invalidHook);
  assert.deepEqual(await hook(config,{...post,prompt_id:undefined},'claude'),invalidHook);
  assert.deepEqual(await hook(config,{...post,tool_input:{category:'debugging',status:'in_progress',summary:'PRIVATE_CANARY'}},'claude'),invalidHook);
  assert.deepEqual(await readEvents(config.privateDir),[]);
  assert.deepEqual(await readdir(config.privateDir),[]);
}));
test('native_identity_and_replay isolates source and turns, preserves first timestamp, rejects missing native identity', async()=>fixture(async config=>{
  await hook(config,start);
  const first = (await readEvents(config.privateDir))[0];
  assert.deepEqual(await hook(config,start), startOutput);
  await hook(config,{...start,turn_id:'second'});
  await hook(config,{...start,prompt_id:'turn'},'claude');
  assert.equal(new Set((await readEvents(config.privateDir)).map(e=>e.turnKey)).size,3);
  assert.equal((await readEvents(config.privateDir)).find(e=>e.eventId===first.eventId)?.recordedAt,first.recordedAt);
  for (const session_id of [undefined, '', 1])
    assert.deepEqual(await hook(config,{...start,session_id}), invalidHook);
  for (const turn_id of [undefined, '', 1])
    assert.deepEqual(await hook(config,{...start,turn_id,tool_input:{turn_id:'model'}}), invalidHook);
  for (const prompt_id of [undefined, '', 1])
    assert.deepEqual(await hook(config,{...start,prompt_id},'claude'), invalidHook);
  assert.equal((await readEvents(config.privateDir)).length,3);
  let read = false;
  async function* input(){ read=true; yield Buffer.from('PRIVATE_CANARY'); }
  for (const source of ['codex','claude'] as const)
    assert.deepEqual(await handleCommandHook(source,{...config,captureEnabled:false},input()),{});
  assert.equal(read,false);
}));
test('concurrent replay and stop diagnostics stay local and successful JSON text classification is accepted', async()=>fixture(async config=>{
  const results=await Promise.all(Array.from({length:8},()=>hook(config,start)));
  for (const output of results) assert.deepEqual(output, startOutput);
  assert.equal((await readEvents(config.privateDir)).length,1);
  const stop={...start,hook_event_name:'Stop'};
  assert.deepEqual(await hook(config,stop),{});
  const firstStop = (await readEvents(config.privateDir)).find(event => event.kind === 'stop');
  assert.deepEqual(await hook(config,stop),{});
  assert.deepEqual((await readEvents(config.privateDir)).find(event => event.kind === 'stop'), firstStop);
  const post={...start,hook_event_name:'PostToolUse',tool_name:'mcp__whativedone__classify_progress',tool_use_id:'call',tool_input:{category:'none',status:'unknown'},tool_response:{content:[{type:'text',text:'{"category":"none","status":"unknown"}'}]}};
  assert.deepEqual(await hook(config,post),{});
  const events=await readEvents(config.privateDir);
  assert.equal(events.length,3);
  assert.deepEqual(events.find(event=>event.kind==='classification'),{...events.find(event=>event.kind==='classification'),progress:{category:'none',status:'unknown'}});
  assert.deepEqual(await hook(config,{...post,tool_use_id:undefined,tool_call_id:'unverified'}),invalidHook);
  assert.equal((await readEvents(config.privateDir)).length,3);
}));
test('ignored and malformed payloads return native-compatible output without persisting events', async()=>fixture(async config=>{
  for (const source of ['codex','claude'] as const) {
    assert.deepEqual(await hook(config,{...start,prompt_id:'turn',hook_event_name:'PostToolUse',tool_name:'other',tool_input:{secret:'PRIVATE_CANARY'}},source),{});
    assert.deepEqual(await hook(config,{...start,prompt_id:'turn',hook_event_name:'unsupported'},source),invalidHook);
    async function* malformed(){ yield Buffer.from('PRIVATE_CANARY'); }
    const output = await handleCommandHook(source,config,malformed());
    assertNativeHookOutput('UserPromptSubmit',output);
    assert.deepEqual(output,{systemMessage:'WhatIveDone: capture_failed'});
  }
  assert.deepEqual(await readEvents(config.privateDir),[]);
  assert.deepEqual(await readdir(config.privateDir),[]);
}));
test('outer writer lock persists state and intent without recursive locking or extra fields',async()=>fixture(async config=>{
  await hook(config,start);
  const event=(await readEvents(config.privateDir))[0];
  await withWriterLock(config.privateDir,async()=>{
    const state=await readState(config.privateDir);
    state.processedIds=[event.eventId];
    await writeState(config.privateDir,Object.assign(state,{extra:'PRIVATE_CANARY'}));
    await writeIntent(config.privateDir,{eventIds:[event.eventId],baseHead:null,beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),rows:[]});
  });
  assert.equal(JSON.stringify(await readState(config.privateDir)).includes('PRIVATE_CANARY'),false);
  assert.deepEqual((await readIntent(config.privateDir))?.eventIds,[event.eventId]);
}));
test('lock loss during temporary fsync prevents state rename and key publication',async t=>fixture(async config=>{
  const originalLock=lockfile.lock;
  let compromise:()=>void=()=>{};
  t.mock.method(lockfile,'lock',async (path:string,options:lockfile.LockOptions)=>{
    compromise=()=>options.onCompromised!(new Error('synthetic_lock_loss'));
    return originalLock(path,options);
  });
  const originalOpen=fs.open;
  t.mock.method(fs,'open',async (...args:Parameters<typeof fs.open>)=>{
    const file=await originalOpen(...args);
    if(String(args[0]).includes(config.privateDir)&&args[1]==='wx') {
      const sync=file.sync.bind(file);
      file.sync=async()=>{await sync(); await new Promise<void>(resolve=>setImmediate(resolve));compromise();};
    }
    return file;
  });
  syncBuiltinESMExports();
  try {
    const state=await readState(config.privateDir);
    await assert.rejects(withWriterLock(config.privateDir,()=>writeState(config.privateDir,state)));
    await assert.rejects(readFile(join(config.privateDir,'state.json')), {code:'ENOENT'});
    assert.deepEqual(await hook(config,start),{systemMessage:'WhatIveDone: capture_failed'});
    await assert.rejects(readFile(join(config.privateDir,'key')), {code:'ENOENT'});
  } finally {t.mock.restoreAll();syncBuiltinESMExports();}
}));
test('state read and write reject non-string and noncanonical remote check times',async()=>fixture(async config=>{
  const state=await readState(config.privateDir);
  for(const remoteCheckedAt of [0,'2026-10-09','2026-10-09T00:00:00Z','2026-10-09T08:00:00.000+08:00']) {
    const invalid={...state,remoteCheckedAt} as typeof state;
    await assert.rejects(writeState(config.privateDir,invalid));
    await fs.writeFile(join(config.privateDir,'state.json'),JSON.stringify(invalid));
    await assert.rejects(readState(config.privateDir));
  }
  await writeState(config.privateDir,{...state,remoteCheckedAt:'2026-10-09T00:00:00.000Z'});
  assert.equal((await readState(config.privateDir)).remoteCheckedAt,'2026-10-09T00:00:00.000Z');
}));
