import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendRows, isWorklogAppend, toPublicRow, upgradeWorklog, validateProgress, validateWorklog } from '../src/schema.js';

const valid = { category: 'implementation', status: 'in_progress' } as const;
const time = '2026-10-08T01:02:03.000Z';
test('MCP exposes strict classify_progress and never echoes rejected free text', async () => {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', "import {runMcp} from './dist/src/mcp.js'; await runMcp();"] });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0].name, 'classify_progress');
    assert.equal(list.tools[0].inputSchema.additionalProperties, false);
    const instructions = client.getInstructions();
    assert.match(instructions!, /WhatIveDone progress journal/);
    assert.match(instructions!, /meaningful progress milestones and before stopping/);
    assert.match(instructions!, /native PostToolUse hook saves it/);
    assert.match(list.tools[0].description!, /journal/);
    assert.match(list.tools[0].description!, /native PostToolUse hook/);
    const result = await client.callTool({ name: 'classify_progress', arguments: valid });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"category":"implementation","status":"in_progress"}' }]);
    const rejected = await client.callTool({ name: 'classify_progress', arguments: { ...valid, summary: 'PRIVATE_CANARY' } });
    assert.deepEqual(rejected.content, [{ type: 'text', text: 'invalid_progress' }]);
    assert.equal(rejected.isError, true);
  } finally { await client.close(); }
});
test('rejects_free_text and malformed DTOs without leaking supplied fields', () => {
  assert.deepEqual(validateProgress(valid), valid);
  for (const input of [{ ...valid, summary: 'PRIVATE_CANARY' }, null, [], {}, { ...valid, category: 'PRIVATE_CANARY' }, { ...valid, status: 'done' }]) assert.equal(validateProgress(input), null);
  assert.deepEqual(validateProgress({ category: 'none', status: 'unknown' }), { category: 'none', status: 'unknown' });
  assert.equal(validateProgress({ category: 'none', status: 'blocked' }), null);
  assert.equal(validateProgress({ category: 'research', status: 'unknown' }), null);
});
test('fixed_public_format accepts all five categories and four statuses', () => {
  for (const category of ['research', 'planning', 'implementation', 'verification', 'debugging'] as const)
    for (const status of ['in_progress', 'waiting_input', 'blocked', 'ai_reported_done'] as const)
      assert.deepEqual(toPublicRow({ category, status }, time), { time, category, status });
  assert.equal(toPublicRow({ category: 'none', status: 'in_progress' }, time), null);
  assert.equal(toPublicRow({ category: 'research', status: 'unknown' }, time), null);
  for (const invalid of ['2026-02-30T01:02:03.000Z', 'today', '2026-10-08T01:02:03+00:00', '2026-10-08 01:02:03']) assert.equal(toPublicRow(valid, invalid), null);
});
test('append-only canonical Markdown rejects malformed or free-text files', () => {
  const first = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n| 2026-10-08 01:02:03 | 实现 | 进行中 | 1 commit! smart! |\n';
  assert.equal(appendRows('', [{ time, ...valid }]), first);
  const next = appendRows(first, [{ time, category: 'verification', status: 'ai_reported_done' }]);
  assert.ok(next.startsWith(first));
  assert.equal(validateWorklog(next), true);
  assert.equal(validateWorklog(''), true);
  assert.equal(next, first + '| 2026-10-08 01:02:03 | 验证 | AI报告完成 | 2 commit! smart! |\n');
  for (const invalid of [first + 'PRIVATE_CANARY\n', first.replace('实现', 'none'), first.replace('进行中', 'unknown'), first.replace('2026-10-08', '2026-02-30')]) assert.equal(validateWorklog(invalid), false);
  assert.throws(() => appendRows('PRIVATE_CANARY', []), /invalid_worklog/);
  assert.throws(() => appendRows(first, [{ time, ...valid, summary: 'PRIVATE_CANARY' } as never]), /invalid_row/);
});
test('new UTC display omits milliseconds without changing ISO DTOs or historical rows', () => {
  const recordedAt = '2026-10-08T01:02:03.987Z';
  const row = toPublicRow(valid, recordedAt);
  assert.deepEqual(row, { time: recordedAt, ...valid });
  const historical = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n| 2026-10-07T23:59:59.123Z | 排障 | 进行中 |\n';
  assert.equal(validateWorklog(historical), true);
  const next = appendRows(historical, [row!]);
  assert.equal(next, '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-07T23:59:59.123Z | 排障 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 实现 | 进行中 | 1 commit! smart! |\n');
  assert.equal(validateWorklog(next), true);
  for (const invalid of ['2026-02-30 01:02:03', '2026-10-08 24:02:03', '2026-10-08 01:60:03', '2026-10-08 01:02:60', '2026-10-08 01:02:03.987', '2026-10-08 01:02:03Z', '2026-10-08 01:02:03 PRIVATE_CANARY'])
    assert.equal(validateWorklog(next.replace('2026-10-08 01:02:03', invalid)), false);
  for (const invalid of ['2026-02-30T23:59:59.123Z', '2026-10-07T23:59:59Z', '2026-10-07T23:59:59.123+00:00'])
    assert.equal(validateWorklog(historical.replace('2026-10-07T23:59:59.123Z', invalid)), false);
});
test('formatter maps every public category and status to the approved labels', () => {
  const result = appendRows('', [
    { time, category: 'research', status: 'in_progress' },
    { time, category: 'planning', status: 'waiting_input' },
    { time, category: 'implementation', status: 'blocked' },
    { time, category: 'verification', status: 'ai_reported_done' },
    { time, category: 'debugging', status: 'in_progress' },
  ]);
  assert.equal(result, '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-08 01:02:03 | 调研 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 | 2 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 实现 | 受阻 | 3 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 验证 | AI报告完成 | 4 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 排障 | 进行中 | 5 commit! smart! |\n');
  assert.equal(validateWorklog(result), true);
});
test('daily progress counts all appended rows by UTC date, including interleaved batches', () => {
  const first = appendRows('', [
    { time: '2026-10-08T23:59:59.999Z', ...valid },
    { time: '2026-10-09T00:00:00.000Z', ...valid },
  ]);
  const next = appendRows(first, [
    { time: '2026-10-08T23:59:59.999Z', ...valid },
    { time: '2026-10-09T00:00:01.000Z', ...valid },
    { time: '2026-10-10T00:00:00.000Z', ...valid },
  ]);
  assert.ok(next.startsWith(first));
  assert.equal(next, '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-08 23:59:59 | 实现 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-09 00:00:00 | 实现 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-08 23:59:59 | 实现 | 进行中 | 2 commit! smart! |\n' +
    '| 2026-10-09 00:00:01 | 实现 | 进行中 | 2 commit! smart! |\n' +
    '| 2026-10-10 00:00:00 | 实现 | 进行中 | 1 commit! smart! |\n');
});
test('daily badges upgrade after each complete twenty rows and clamp only the final adjective', () => {
  const day = appendRows('', Array.from({ length: 1000 }, () => ({ time, ...valid })));
  const cells = day.trimEnd().split('\n').slice(4).map(line => line.split('|')[4].trim());
  for (const [count, wanted] of [
    [1, 'smart'], [20, 'smart'], [21, 'clever'], [35, 'clever'], [40, 'clever'],
    [41, 'intelligent'], [60, 'intelligent'], [61, 'brilliant'], [80, 'brilliant'],
    [81, 'genius'], [100, 'genius'], [101, 'true genius'], [120, 'true genius'],
    [121, 'super genius'], [140, 'super genius'], [141, 'absolute incredible genius'],
    [160, 'absolute incredible genius'], [161, 'absolute incredible genius'], [1000, 'absolute incredible genius'],
  ] as const) assert.equal(cells[count - 1], `${count} commit! ${wanted}!`, `${count}`);
  assert.equal(validateWorklog(day), true);
  assert.equal(validateWorklog(day.replace('141 commit! absolute incredible genius!', '141 commit! absolute incredible  genius!')), false);
  assert.ok(!day.includes('■'));
});
test('badge cells must exactly match per-date counts and approved fixed phrases', () => {
  const first = appendRows('', [{ time, ...valid }]);
  for (const invalid of ['2 commit! smart!', '01 commit! smart!', '0 commit! smart!', '1 commit！ smart!', '1 commit! clever!', '1 commit! smart !', '1 commit!  smart!', '1 commit! PRIVATE_CANARY!', '1 commit! smart! PRIVATE_CANARY'])
    assert.equal(validateWorklog(first.replace('1 commit! smart!', invalid)), false, invalid);
  assert.equal(validateWorklog(first + '| 2026-10-08 01:02:03 | 实现 | 进行中 | 1 commit! smart! |\n'), false);
  assert.equal(validateWorklog(first + '| 2026-10-08 01:02:03 | 实现 | 进行中 | ■■ 2 commit！ |\n'), false);
});
test('upgrade preserves original cells and permits only its deterministic history transition', () => {
  const legacy = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n' +
    '| 2026-10-08T23:59:59.987Z | 排障 | 进行中 |\n' +
    '| 2026-10-09 00:00:01 | 实现 | AI报告完成 |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 |\n';
  const upgraded = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-08T23:59:59.987Z | 排障 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-09 00:00:01 | 实现 | AI报告完成 | 1 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 | 2 commit! smart! |\n';
  assert.equal(upgradeWorklog(legacy), upgraded);
  assert.equal(upgradeWorklog(upgraded), upgraded);
  assert.equal(upgradeWorklog(''), '');
  assert.throws(() => upgradeWorklog('PRIVATE_CANARY'), /invalid_worklog/);
  assert.equal(isWorklogAppend(legacy, upgraded), true);
  assert.equal(isWorklogAppend(legacy, upgraded + '| 2026-10-09 00:00:02 | 验证 | 进行中 | 2 commit! smart! |\n'), true);
  assert.equal(isWorklogAppend(legacy, legacy + '| 2026-10-09 00:00:02 | 验证 | 进行中 |\n'), true);
  assert.equal(isWorklogAppend(upgraded, legacy), false);
  assert.equal(isWorklogAppend(upgraded, upgraded), false);
  assert.equal(isWorklogAppend('', ''), false);
  assert.equal(isWorklogAppend(legacy, upgraded.replace('23:59:59.987Z', '23:59:59.000Z')), false);
  assert.equal(isWorklogAppend(legacy, upgraded.replace('排障', '实现')), false);
  assert.equal(isWorklogAppend('PRIVATE_CANARY', upgraded), false);
  assert.equal(isWorklogAppend(upgraded, upgraded + 'PRIVATE_CANARY\n'), false);
});
test('historical bars remain strictly audited and support only deterministic forward migrations', () => {
  const plain = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n' +
    '| 2026-10-08T23:59:59.987Z | 排障 | 进行中 |\n' +
    '| 2026-10-09 00:00:01 | 实现 | AI报告完成 |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 |\n';
  const bars = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-08T23:59:59.987Z | 排障 | 进行中 | ■ 1 commit！ |\n' +
    '| 2026-10-09 00:00:01 | 实现 | AI报告完成 | ■ 1 commit！ |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 | ■■ 2 commit！ |\n';
  const badges = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n' +
    '| 2026-10-08T23:59:59.987Z | 排障 | 进行中 | 1 commit! smart! |\n' +
    '| 2026-10-09 00:00:01 | 实现 | AI报告完成 | 1 commit! smart! |\n' +
    '| 2026-10-08 01:02:03 | 方案 | 等待输入 | 2 commit! smart! |\n';
  assert.equal(validateWorklog(bars), true);
  for (const invalid of ['■■ 1 commit！', '■ 2 commit！', '■ 01 commit！', '■ 0 commit！', '■ 1 commit!', '█ 1 commit！', '■ 1 PRIVATE_CANARY', '■ 1 commit！ PRIVATE_CANARY', '1 commit! smart!'])
    assert.equal(validateWorklog(bars.replace('■ 1 commit！', invalid)), false, invalid);
  assert.equal(upgradeWorklog(bars), badges);
  assert.equal(appendRows(plain, [], 'legacyBars'), bars);
  const oldAppend = appendRows(bars, [{ time, ...valid }], 'legacyBars');
  assert.equal(oldAppend, bars + '| 2026-10-08 01:02:03 | 实现 | 进行中 | ■■■ 3 commit！ |\n');
  assert.equal(isWorklogAppend(plain, bars), true);
  assert.equal(isWorklogAppend(plain, oldAppend), true);
  assert.equal(isWorklogAppend(bars, oldAppend), true);
  assert.equal(isWorklogAppend(bars, badges), true);
  assert.equal(isWorklogAppend(bars, badges + '| 2026-10-08 01:02:03 | 实现 | 进行中 | 3 commit! smart! |\n'), true);
  assert.equal(isWorklogAppend(badges, bars), false);
  assert.equal(isWorklogAppend(badges, plain), false);
  assert.equal(isWorklogAppend(bars, plain), false);
  assert.equal(isWorklogAppend(bars, badges.replace('23:59:59.987Z', '23:59:59.000Z')), false);
  assert.equal(isWorklogAppend(bars, badges.replace('排障', '实现')), false);
  for (const mode of ['legacyBars', 'legacyDisplay', 'legacyIso'] as const)
    assert.throws(() => appendRows(badges, [{ time, ...valid }], mode), /invalid_worklog/);
  const emptyHeader = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n';
  assert.equal(appendRows(emptyHeader, [{ time, ...valid }], 'legacyBars'), emptyHeader + '| 2026-10-08 01:02:03 | 实现 | 进行中 | ■ 1 commit！ |\n');
  assert.equal(appendRows(emptyHeader, [{ time, ...valid }]), emptyHeader + '| 2026-10-08 01:02:03 | 实现 | 进行中 | 1 commit! smart! |\n');
});
