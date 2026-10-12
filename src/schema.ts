export type Source = 'codex' | 'claude';
export type Category = 'research' | 'planning' | 'implementation' | 'verification' | 'debugging' | 'none';
export type TaskStatus = 'in_progress' | 'waiting_input' | 'blocked' | 'ai_reported_done' | 'unknown';
export type Progress = { category: Category; status: TaskStatus };
export type PublicRow = { time: string; category: Exclude<Category, 'none'>; status: Exclude<TaskStatus, 'unknown'> };
export type LocalEvent = { eventId: string; turnKey: string; source: Source; recordedAt: string } & ({ kind: 'start' | 'stop' } | { kind: 'classification'; progress: Progress });
export type Config = { privateDir: string; gitDir: string; remoteUrl: string; mirrorUrl?: string; branch: string; authorName: string; authorEmail: string; captureEnabled: boolean; mode: 'local' | 'auto' };
export type GitIdentity = { name: string; email: string; time: string };
export type CommitView = { oid: string; parents: string[]; author: GitIdentity; committer: GitIdentity; message: string; files: string[]; worklog: string; patch: string };
export type Snapshot = { capturedAt: string; baselineOid: string | null; baselineCheckedAt: string | null; targetOid: string; pushUrl: string; targetRef: string; commits: CommitView[]; queuedCount: number };
export type PolicyResult = { ok: true } | { ok: false; code: 'invalid_history' | 'invalid_content' | 'invalid_identity' | 'destination_changed' | 'extra_execution' };
export type SyncResult = 'local' | 'idle' | 'synced' | 'pending' | 'paused';
export type Intent = { eventIds: string[]; baseHead: string | null; beforeHash: string; afterHash: string; rows: PublicRow[]; commitOid?: string };
export type MirrorState = { remoteUrl: string; remoteOid: string | null; remoteCheckedAt: string | null; errorCode?: string };
export type StoreState = { processedIds: string[]; lastProgress: Record<string, Progress>; classifiedTurns: string[]; stoppedTurns: string[]; remoteOid: string | null; remoteCheckedAt: string | null; errorCode?: string; primaryErrorCode?: string; mirror?: MirrorState };
export type Receipt = { operation: 'check_remote' | 'push'; pushUrl: string; targetRef: string; targetOid?: string; startedAt: string; endedAt: string; result: 'ok' | 'network_error' | 'auth_required' | 'policy_blocked' };

export const CATEGORY_LABELS = { research: '调研', planning: '方案', implementation: '实现', verification: '验证', debugging: '排障' } as const;
export const STATUS_LABELS = { in_progress: '进行中', waiting_input: '等待输入', blocked: '受阻', ai_reported_done: 'AI报告完成' } as const;
export const LEGACY_WORKLOG_HEADER = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 |\n| --- | --- | --- |\n';
export const WORKLOG_HEADER = '# Worklog\n\n| 时间（UTC） | 类别 | 状态 | 进度 |\n| --- | --- | --- | --- |\n';
export const PROGRESS_GUIDANCE = 'For the WhatIveDone progress journal, call mcp__whativedone__classify_progress at meaningful progress milestones and before stopping. Send only category and status: category research, planning, implementation, verification, or debugging; status in_progress, waiting_input, blocked, or ai_reported_done. Use category none with status unknown for no meaningful progress. ai_reported_done means the AI reports completion; do not infer completion merely from stopping. The tool validates the classification; the native PostToolUse hook saves it.';

export function validateProgress(input: unknown): Progress | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('category') || !keys.includes('status')) return null;
  const { category, status } = input as Record<string, unknown>;
  if (category === 'none' && status === 'unknown') return { category, status };
  if (typeof category !== 'string' || typeof status !== 'string' || !Object.hasOwn(CATEGORY_LABELS, category) || !Object.hasOwn(STATUS_LABELS, status)) return null;
  return { category, status } as Progress;
}

function validTime(time: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
}

export function toPublicRow(input: Progress, time: string): PublicRow | null {
  const progress = validateProgress(input);
  if (!progress || progress.category === 'none' || progress.status === 'unknown' || !validTime(time)) return null;
  return { time, category: progress.category, status: progress.status };
}

function nextDailyCount(counts: Map<string, number>, time: string): number {
  const date = time.slice(0, 10);
  const count = (counts.get(date) || 0) + 1;
  counts.set(date, count);
  return count;
}

const PROGRESS_LABELS = ['smart', 'clever', 'intelligent', 'brilliant', 'genius', 'true genius', 'super genius', 'absolute incredible genius'] as const;
const progressCell = (count: number, bars = false) => bars ? `${'■'.repeat(count)} ${count} commit！` : `${count} commit! ${PROGRESS_LABELS[Math.min(Math.floor((count - 1) / 20), PROGRESS_LABELS.length - 1)]}!`;

function usesBars(text: string): boolean {
  return text.startsWith(WORKLOG_HEADER) && text.slice(WORKLOG_HEADER.length).split('\n', 1)[0].includes(' | ■');
}

function formatProgress(text: string, bars = false): string {
  if (!text) return text;
  const fourColumns = text.startsWith(WORKLOG_HEADER);
  const counts = new Map<string, number>();
  return WORKLOG_HEADER + text.slice(fourColumns ? WORKLOG_HEADER.length : LEGACY_WORKLOG_HEADER.length).split('\n').slice(0, -1)
    .map(line => {
      const prefix = fourColumns ? line.slice(0, line.lastIndexOf(' | ') + 3) : `${line.slice(0, -1)}| `;
      return `${prefix}${progressCell(nextDailyCount(counts, line.slice(2, 12)), bars)} |\n`;
    }).join('');
}

export function appendRows(existing: string, rows: PublicRow[], format: 'current' | 'legacyBars' | 'legacyDisplay' | 'legacyIso' = 'current'): string {
  if (!validateWorklog(existing)) throw new Error('invalid_worklog');
  const progress = format === 'current' || format === 'legacyBars';
  if ((!progress && existing.startsWith(WORKLOG_HEADER)) || (format === 'legacyBars' && existing.startsWith(WORKLOG_HEADER) && existing !== WORKLOG_HEADER && !usesBars(existing))) throw new Error('invalid_worklog');
  const before = progress ? formatProgress(existing, format === 'legacyBars') : existing;
  const counts = new Map<string, number>();
  if (progress && before)
    for (const line of before.slice(WORKLOG_HEADER.length).split('\n').slice(0, -1)) nextDailyCount(counts, line.slice(2, 12));
  let suffix = '';
  for (const row of rows) {
    if (!row || Reflect.ownKeys(row).length !== 3 || !Object.hasOwn(row, 'time') || !Object.hasOwn(row, 'category') || !Object.hasOwn(row, 'status') || !toPublicRow({ category: row.category, status: row.status }, row.time)) throw new Error('invalid_row');
    const time = format === 'legacyIso' ? row.time : row.time.slice(0, 19).replace('T', ' ');
    const cell = progress ? ` ${progressCell(nextDailyCount(counts, row.time), format === 'legacyBars')} |` : '';
    suffix += `| ${time} | ${CATEGORY_LABELS[row.category]} | ${STATUS_LABELS[row.status]} |${cell}\n`;
  }
  return (before || (rows.length ? progress ? WORKLOG_HEADER : LEGACY_WORKLOG_HEADER : '')) + suffix;
}

export function validateWorklog(text: string): boolean {
  if (text === '') return true;
  const current = text.startsWith(WORKLOG_HEADER);
  const header = current ? WORKLOG_HEADER : LEGACY_WORKLOG_HEADER;
  if (!text.startsWith(header) || !text.endsWith('\n')) return false;
  const lines = text.slice(header.length).split('\n');
  lines.pop();
  const counts = new Map<string, number>();
  const bars = usesBars(text);
  return lines.every(line => {
    const match = (current ? /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/ : /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/).exec(line);
    if (!match) return false;
    const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(match[1]) ? match[1].replace(' ', 'T') + '.000Z' : match[1];
    return validTime(time) && (Object.values(CATEGORY_LABELS) as string[]).includes(match[2]) && (Object.values(STATUS_LABELS) as string[]).includes(match[3]) && (!current || match[4] === progressCell(nextDailyCount(counts, time), bars));
  });
}

export function upgradeWorklog(text: string): string {
  if (!validateWorklog(text)) throw new Error('invalid_worklog');
  return formatProgress(text);
}

export function isWorklogAppend(previous: string, next: string): boolean {
  return previous !== next && validateWorklog(previous) && validateWorklog(next) &&
    (next.startsWith(previous) || next.startsWith(formatProgress(previous)) || previous.startsWith(LEGACY_WORKLOG_HEADER) && next.startsWith(formatProgress(previous, true)));
}
