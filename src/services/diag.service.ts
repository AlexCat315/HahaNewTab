/**
 * 现场诊断环形缓冲（仅开发 / 测试，不参与任何业务逻辑）
 *
 * - 生产构建里 `import.meta.env.PROD` 被常量折叠，整条采集链路会被 tree-shake 掉；
 * - 诊断键按页 id 散列到固定数量的槽，不再「每开一个新标签页永久多一个键」；
 * - 槽键从统一契约派生，门面统计用量时一并计入。
 * 控制台导出：`copy(JSON.parse(sessionStorage.getItem('haha-diag-v1')))`
 */

import { setKernelChangeListener, storageManager } from '@/services/storage.service';
import {
    isLargeKey,
    DIAG_CONTRACT,
    DIAG_STORAGE_KEYS
} from '@/services/storageSchema.service';
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

/** 生产构建关闭采集；开发与测试保持可排查 */
export const DIAGNOSTICS_ENABLED = !import.meta.env.PROD && DIAG_CONTRACT.enabledInProduction !== true;

/** 每个页面保留的条数：再多也读不完，且写入本身会拖慢操作 */
const MAX_ENTRIES = 200;
const SESSION_KEY = 'haha-diag-v1';

/** 单个值压缩成可对比的一小段：够看清 minimalMode 这类字段，又不会把站点全量塞进日志 */
export function compact(value: unknown, limit = 160): string {
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return '<不可序列化>';
    }
    if (text === undefined) return 'undefined';
    return text.length > limit ? `${text.slice(0, limit)}…(${text.length})` : text;
}

/**
 * 大对象只记摘要，不做 MB 级 JSON.stringify。
 * 壁纸 Base64 / 图标库 / 站点数据都是注册表标记过的 large 键。
 */
function summarizeLarge(value: unknown): string {
    if (typeof value === 'string') return `<large string ${value.length} chars>`;
    if (!value || typeof value !== 'object') return compact(value);
    const keys = Object.keys(value as Record<string, unknown>);
    return `<large ${keys.length} fields: ${keys.slice(0, 8).join(',')}>`;
}

/** 快照按键压缩，供三方合并的 base/remote/local/merged 对比 */
export function compactSnapshot(snapshot: Record<string, unknown> | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(snapshot ?? {})) {
        out[key] = isLargeKey(key) ? summarizeLarge(value) : compact(value);
    }
    return out;
}

/** 页面标识：同一标签页内稳定，不同标签页不同 */
export const pageId: string = Math.random().toString(36).slice(2, 7);

/** 页 id → 固定槽，避免动态键无限增长 */
function slotKey(): string {
    let hash = 0;
    for (let i = 0; i < pageId.length; i += 1) {
        hash = (hash * 31 + pageId.charCodeAt(i)) | 0;
    }
    return DIAG_STORAGE_KEYS[Math.abs(hash) % DIAG_STORAGE_KEYS.length];
}

function readLocal(): TraceEntry[] {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** 同一标签页刷新前的事件也留着：新标签页「开了一半就刷新」是常态 */
let buffered: TraceEntry[] = readLocal();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 落一份到固定槽：别的页面和「本页面已经关掉」的情形也读得到 */
function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void Promise.resolve(storageManager.set(slotKey(), buffered))
            .catch(() => {});
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
    if (!DIAGNOSTICS_ENABLED) return;

    const entry = withMinimalSignal({ t: Date.now(), page: pageId, kind, ...detail });
    buffered.push(entry);
    if (buffered.length > MAX_ENTRIES) {
        buffered = buffered.slice(-MAX_ENTRIES);
    }
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(buffered));
    } catch {
        // sessionStorage 写不进去不影响排查：控制台还有这一行
    }
    console.debug('[haha-diag]', entry);
    scheduleFlush();
}

/** 内核变更观察者：只在开发 / 测试里挂，生产不产生任何监听与写放大 */
if (DIAGNOSTICS_ENABLED) {
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
}

/**
 * 渲染层探针：`#app-root` 的 minimal-mode 类名每次变化都记一条
 * 用来区分「数据被改回去」和「数据没变、只是画面跳回去」。生产直接返回空清理函数。
 */
export function watchMinimalMode(getStoreValue: () => unknown): () => void {
    if (!DIAGNOSTICS_ENABLED) return () => {};
    const root = document.getElementById('app-root');
    if (!root) return () => {};

    let previous = root.classList.contains('minimal-mode');
    const observer = new MutationObserver(() => {
        const next = root.classList.contains('minimal-mode');
        if (next === previous) return;
        previous = next;
        trace('dom', {
            minimalModeClass: next,
            storeValue: getStoreValue(),
        });
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
}
