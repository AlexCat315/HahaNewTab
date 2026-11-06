/**
 * 现场诊断环形缓冲（临时排查用，不参与任何业务逻辑）
 *
 * 新标签页一个浏览器里可能开着几十个：日志必须自带「哪个页面写的」，
 * 且要能跨页面汇总，所以存 sessionStorage 之外还另存一份到存储内核的固定键。
 * 导出：控制台执行 `copy(JSON.parse(sessionStorage.getItem('haha-diag-v1')))`
 */

import { setKernelChangeListener, storageManager } from '@/services/storage.service';
import { STORAGE_KEYS } from '@/types/storage';

export type TraceKind =
    | 'write'
    | 'load'
    | 'load-skipped-stale'
    | 'external-change'
    | 'cloud-apply'
    | 'cloud-sync'
    | 'kernel-change'
    | 'dom';

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

/**
 * 从一份快照里挑出极简约开关
 *
 * 整块设置在日志里是压缩字符串，控制台折叠后看不见值；把这一项摊到顶层，
 * 「跳回去」的那一刻在纯文本日志里就能直接读。原始对象和压缩字符串都要认。
 */
export function pickMinimalMode(snapshot: unknown): unknown {
    if (!snapshot || typeof snapshot !== 'object') {
        return undefined;
    }
    const settings = (snapshot as Record<string, unknown>)[STORAGE_KEYS.LAYOUT_SETTINGS];
    if (settings && typeof settings === 'object') {
        return (settings as Record<string, unknown>).minimalMode;
    }
    if (typeof settings === 'string') {
        const matched = /"minimalMode":(true|false)/.exec(settings);
        return matched ? matched[1] === 'true' : undefined;
    }
    return undefined;
}

/** 每条记录自动带上极简约开关：不用先导出完整 JSON 也能看出值被改成了什么 */
function withMinimalSignal(entry: TraceEntry): TraceEntry {
    if (Object.keys(entry).some((field) => field.startsWith('minimalMode'))) {
        return entry;
    }
    for (const field of ['items', 'values', 'read', 'local', 'remote', 'merged', 'base']) {
        const value = pickMinimalMode(entry[field] as Record<string, unknown> | undefined);
        if (value !== undefined) {
            return { ...entry, minimalMode: value };
        }
    }
    return entry;
}

export function trace(kind: TraceKind, detail: Record<string, unknown>): void {
    const entry = withMinimalSignal({ t: Date.now(), page: pageId, kind, ...detail });
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

/**
 * 内核变更观察者：把「这一页收到了谁的写入」记进环形缓冲
 *
 * 布局/主题/搜索的 slice 不订阅外部变更，slice 层日志看不到别的标签页的整块回写，
 * 只能在这一层看到。source 为 native-other / storage 时即跨页面写入。
 */
setKernelChangeListener((report) => {
    const minimalMode = (report.signals as Record<string, unknown>)?.minimalMode;
    trace('kernel-change', {
        source: report.source,
        keys: report.keys,
        minimalMode,
        listenerCount: report.listenerCount,
        signals: report.signals,
    });
});

/**
 * 渲染层探针：`#app-root` 的 minimal-mode 类名每次变化都记一条
 *
 * 用来区分「数据被改回去」和「数据没变、只是画面跳回去」。
 * 类名变了但 storeValue 没变 ⇒ 渲染层问题。
 */
export function watchMinimalMode(getStoreValue: () => unknown): () => void {
    const root = document.getElementById('app-root');
    if (!root) {
        return () => {};
    }
    let previous = root.classList.contains('minimal-mode');
    const observer = new MutationObserver(() => {
        const next = root.classList.contains('minimal-mode');
        if (next === previous) {
            return;
        }
        previous = next;
        trace('dom', {
            minimalModeClass: next,
            storeValue: getStoreValue(),
        });
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
}
