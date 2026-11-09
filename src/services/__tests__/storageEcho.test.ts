/**
 * 扩展环境写入回声去重
 *
 * 一次 setMany 会同时产生本页 CustomEvent 与随后到达的 chrome.storage.onChanged。
 * 订阅者只该收到一次；跨页面写入没有本机登记，必须照常通知。
 * 现有 storage.service.test.ts 删掉了 window.chrome，只覆盖非扩展路径，这里补上另一半。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import type { StorageChanges } from '@/types/storage';

type NativeListener = (changes: StorageChanges, areaName: string) => void;
type Callback = (result?: unknown) => void;

let nativeListeners: Set<NativeListener>;
let stops: (() => void)[];

function emitNative(changes: StorageChanges): void {
    for (const listener of [...nativeListeners]) {
        listener(changes, 'local');
    }
}

beforeEach(() => {
    nativeListeners = new Set();
    stops = [];
    Object.defineProperty(window, 'browser', {
        value: undefined, configurable: true, writable: true
    });
    // Chrome 回调风格：promisifyCall 依赖末尾的 callback
    const local = {
        get: (_key: string | string[] | null, callback: Callback) => callback({}),
        set: (_items: Record<string, unknown>, callback: Callback) => callback(),
        remove: (_key: string | string[], callback: Callback) => callback()
    };
    Object.defineProperty(window, 'chrome', {
        value: {
            storage: {
                local,
                onChanged: {
                    addListener: (listener: NativeListener) => nativeListeners.add(listener),
                    removeListener: (listener: NativeListener) => nativeListeners.delete(listener)
                }
            },
            runtime: { lastError: null }
        },
        configurable: true,
        writable: true
    });
    browserApi.resetDetection();
});

afterEach(() => {
    for (const stop of stops) stop();
    browserApi.resetDetection();
    Object.defineProperty(window, 'chrome', {
        value: undefined, configurable: true, writable: true
    });
});

function subscribeKeys(): string[] {
    const seen: string[] = [];
    const stop = storageManager.subscribe(changes => {
        seen.push(Object.keys(changes).sort().join(','));
    });
    stops.push(stop);
    return seen;
}

describe('扩展环境写入回声', () => {
    it('本机写入只通知一次，原生 onChanged 回声被吃掉', async () => {
        const seen = subscribeKeys();

        await storageManager.set('echo_key', 1);
        expect(seen).toEqual(['echo_key']);

        emitNative({ echo_key: { newValue: 1 } });
        expect(seen).toEqual(['echo_key']);
    });

    it('回声消耗一次后，同键的后续跨页面写入仍会通知', async () => {
        const seen = subscribeKeys();

        await storageManager.set('echo_key', 1);
        emitNative({ echo_key: { newValue: 1 } });
        emitNative({ echo_key: { newValue: 2 } });

        expect(seen).toEqual(['echo_key', 'echo_key']);
    });

    it('没有本机登记的跨页面写入照常通知', async () => {
        const seen = subscribeKeys();

        emitNative({ foreign_key: { newValue: 'from-other-tab' } });

        expect(seen).toEqual(['foreign_key']);
    });

    it('删除操作的原生回声同样不重复通知', async () => {
        const seen = subscribeKeys();

        await storageManager.set('remove_key', 1);
        expect(seen).toEqual(['remove_key']);
        emitNative({ remove_key: { newValue: 1 } });

        await storageManager.remove('remove_key');
        expect(seen).toEqual(['remove_key', 'remove_key']);
        emitNative({ remove_key: { newValue: undefined } });
        expect(seen).toEqual(['remove_key', 'remove_key']);
    });
});
