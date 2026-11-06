/**
 * 现场诊断环形缓冲（临时排查用，不参与任何业务逻辑）
 *
 * 新标签页一个浏览器里可能开着几十个：日志必须自带「哪个页面写的」，
 * 且要能跨页面汇总，所以存 sessionStorage 之外还另存一份到存储内核的固定键。
 * 导出：控制台执行 `copy(JSON.parse(sessionStorage.getItem('haha-diag-v1')))`
 */

import { storageManager } from '@/services/storage.service';

export type TraceKind =
    | 'write'
    | 'load'
    | 'load-skipped-stale'
    | 'external-change'
    | 'cloud-apply'
    | 'cloud-sync';

export interface TraceEntry {
    t: number;
    page: string;
    kind: TraceKind;
    [detail: string]: unknown;
}

/** 每个页面保留的条数：再多也读不完，且写入本身会拖慢操作 */
const MAX_ENTRIES = 200;

/** 每页一份存储键（带页标识后缀）：合并写同一个键会互相覆盖，跨页面也就看不到彼此的写入 */
const STORAGE_KEY_PREFIX = 'haha_diag_';

/** 单个值压缩成可对比的一小段：够看清 minimalMode 这类字段，又不会把站点全量塞进日志 */
export function compact(value: unknown, limit = 160): string {
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text === undefined) return 'undefined';
        return text.length > limit ? `${text.slice(0, limit)}…(${text.length})` : text;
    } catch {
        return '<不可序列化>';
    }
}

/** 快照按键压缩，供三方合并的 base/remote/local/merged 对比 */
export function compactSnapshot(snapshot: Record<string, unknown> | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(snapshot ?? {})) {
        out[key] = compact(value);
    }
    return out;
}

/** 页面标识：同一标签页内稳定，不同标签页不同 */
export const pageId: string = Math.random().toString(36).slice(2, 7);

function readLocal(): TraceEntry[] {
    try {
        const parsed = JSON.parse(sessionStorage.getItem('haha-diag-v1') || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** 同一标签页刷新前的事件也留着：新标签页页「开了一半就刷新」是常态 */
let buffered: TraceEntry[] = readLocal();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 落一份到存储内核：别的页面和「本页面已经关掉」的情形也读得到 */
function scheduleFlush(): void {
    if (flushTimer) {
        return;
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void storageManager.set(STORAGE_KEY_PREFIX + pageId, buffered).catch(() => {});
    }, 1000);
}

export function trace(kind: TraceKind, detail: Record<string, unknown>): void {
    const entry: TraceEntry = { t: Date.now(), page: pageId, kind, ...detail };
    buffered.push(entry);
    if (buffered.length > MAX_ENTRIES) {
        buffered = buffered.slice(-MAX_ENTRIES);
    }
    try {
        sessionStorage.setItem('haha-diag-v1', JSON.stringify(buffered));
    } catch {
        // sessionStorage 写不进去不影响排查：控制台还有这一行
    }
    console.debug('[haha-diag]', entry);
    scheduleFlush();
}
