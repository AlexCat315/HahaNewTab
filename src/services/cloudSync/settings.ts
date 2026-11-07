/**
 * 云同步账号设置：token / gistId / 自动同步开关 / 用户信息的唯一主人
 *
 * 重构前它有两个主人——`CloudSyncService` 的私有字段和 store 的若干 ref，
 * 靠手写的 `syncStateFromService()` 在对账；跨标签页传播又要再补一条
 * `applyExternalSettings()`。几份代码描述同一份状态，漏掉任何一条接线
 * 就是界面上「明明连上了却像没连」这类问题。
 *
 * 现在的形状：
 *   - 只有这个模块读写这四项存储键，别人要么 `get()` 要么 `watch()`；
 *   - 写入走 `save(patch)`，只写真的变了的那几项；
 *   - 别的页面写进来时走 `applyExternal(changes)`，同样只更新内存、不回写，
 *     否则两个页面会互相触发；
 *   - 订阅者（store 的镜像、服务层的判断）拿到的是同一份快照，不会再各自漂移。
 *
 * 「上次同步时间」不在这里：它跟着 base 快照同一批写入，属于同步账本的内容。
 * OAuth App 的 Client ID 内置在代码里，不属于账号状态，断开连接也不会动它。
 */

import { STORAGE_KEYS } from '@/types/storage';
import type { StorageChanges, StorageValue } from '@/types/storage';
import type {
    CloudAccountSettings,
    CloudSettingsStorage
} from '@/types/cloudSync.types';

/** 空设置：尚未连接任何账号 */
export function emptySettings(): CloudAccountSettings {
    return {
        token: null,
        gistId: null,
        autoSync: false,
        userInfo: null
    };
}

/** 这几项设置各自的存储键；本模块是这张表的唯一出处 */
const SETTING_FIELDS: readonly { key: string; field: keyof CloudAccountSettings }[] = [
    { key: STORAGE_KEYS.CLOUD_TOKEN, field: 'token' },
    { key: STORAGE_KEYS.CLOUD_GIST_ID, field: 'gistId' },
    { key: STORAGE_KEYS.CLOUD_AUTO_SYNC, field: 'autoSync' },
    { key: STORAGE_KEYS.CLOUD_USER_INFO, field: 'userInfo' }
];

/** 云同步设置涉及的全部存储键（诊断与订阅过滤用） */
export const CLOUD_SETTING_KEYS: readonly string[] = SETTING_FIELDS.map(({ key }) => key);

const FIELD_BY_KEY = new Map(SETTING_FIELDS.map(({ key, field }) => [key, field]));
const KEY_BY_FIELD = new Map(SETTING_FIELDS.map(({ field, key }) => [field, key]));

/** 设置里哪些项真的换了；凭据换了的含义与「只是缓存动了」完全不同 */
export interface SettingsDelta {
    /** 凭据变了：Gist、用户信息必须跟着新账号走 */
    authChanged: boolean;
    /** 任何一项变了 */
    changed: boolean;
    /** 变的这一项来自同一浏览器的其他页面，而不是本机 */
    fromOtherPage: boolean;
}

/** 换账号时必须一起清掉的派生字段：留着上一个账号的 Gist，会拿着对的 Token 去读别人的片段 */
const DERIVED_ON_AUTH_CHANGE: readonly (keyof CloudAccountSettings)[] = ['gistId', 'userInfo'];

function sameValue(left: unknown, right: unknown): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function withField(
    settings: CloudAccountSettings,
    field: keyof CloudAccountSettings,
    value: unknown
): CloudAccountSettings {
    return { ...settings, [field]: value };
}

/** 存储里的缺省值与脏值收敛成设置类型，避免 null / undefined 混进状态 */
function normalize(key: string, value: unknown): unknown {
    if (key === STORAGE_KEYS.CLOUD_AUTO_SYNC) {
        // 只有真的 true 才算开启：这个开关会决定要不要往云端写数据，不能靠猜
        return value === true;
    }
    return value === undefined ? null : value;
}

function describe(next: CloudAccountSettings, previous: CloudAccountSettings): SettingsDelta {
    const changed = (Object.keys(next) as (keyof CloudAccountSettings)[])
        .some(field => !sameValue(next[field], previous[field]));
    const authChanged = next.token !== previous.token;
    return { changed, authChanged, fromOtherPage: false };
}

const NOTHING_CHANGED: SettingsDelta = { changed: false, authChanged: false, fromOtherPage: false };

export class CloudSettings {
    private readonly storage: CloudSettingsStorage;
    private current: CloudAccountSettings = emptySettings();
    private readonly listeners = new Set<(settings: CloudAccountSettings, delta: SettingsDelta) => void>();
    private unsubscribeFromStorage: (() => void) | null = null;
    /** 正在写入的那批键值，用来认出自己的写入回声 */
    private pending: Record<string, StorageValue> | null = null;

    constructor(storage: CloudSettingsStorage) {
        this.storage = storage;
    }

    /** 当前快照（返回副本：调用方改不到内部状态） */
    get(): CloudAccountSettings {
        return { ...this.current };
    }

    isLoggedIn(): boolean {
        return !!this.current.token;
    }

    /** 从存储读回全部设置；页面启动时调用一次，读到的内容与之前不同会通知订阅者 */
    async load(): Promise<CloudAccountSettings> {
        const stored = await this.storage.getMany(CLOUD_SETTING_KEYS as string[]);
        let next = emptySettings();
        for (const { key, field } of SETTING_FIELDS) {
            if (!(key in stored)) continue;
            next = withField(next, field, normalize(key, stored[key]));
        }
        const delta = describe(next, this.current);
        this.current = next;
        if (delta.changed) this.notify(delta);
        return this.get();
    }

    /**
     * 观察存储：别的标签页登录、换账号、断开同步时本页立刻跟上
     *
     * 云同步面板是常驻挂载的（模态框用 v-show），设置只在启动时读一次；
     * 缺了这条订阅，A 标签页登录后同时开着的 B 标签页会一直停在「未登录」。
     */
    observe(): () => void {
        if (!this.unsubscribeFromStorage) {
            this.unsubscribeFromStorage = this.storage.subscribe(changes => {
                this.applyExternal(changes);
            });
        }
        return () => this.stopObserving();
    }

    stopObserving(): void {
        this.unsubscribeFromStorage?.();
        this.unsubscribeFromStorage = null;
    }

    /**
     * 本机改动：只写真的变了的键，然后通知订阅者
     * @returns 是否真的产生了变化（没变时不写存储，也不广播）
     */
    async save(patch: Partial<CloudAccountSettings>): Promise<SettingsDelta> {
        const next = { ...this.current, ...patch };
        const items: Record<string, StorageValue> = {};
        for (const { key, field } of SETTING_FIELDS) {
            if (!(field in patch)) continue;
            if (sameValue(this.current[field], next[field])) continue;
            items[key] = next[field] ?? null;
        }

        const delta = describe(next, this.current);
        if (!delta.changed) return delta;

        // 先落盘再改内存：写失败时状态不能已经前进，否则内存与存储就此分叉
        this.pending = items;
        try {
            await this.storage.setMany(items);
            this.current = next;
        } finally {
            this.pending = null;
        }
        this.notify(delta);
        return delta;
    }

    /**
     * 采纳别的页面写入的设置（只改内存，绝不回写）
     *
     * 回写等于把同一个值再广播一轮：两个页面各自采纳、各自回写，就此互相触发。
     */
    applyExternal(changes: StorageChanges): SettingsDelta {
        let touched = CLOUD_SETTING_KEYS.filter(key => key in changes);
        if (this.pending) {
            // 落盘期间内核会把这次写入原样通知回来，而那时内存还是旧值；
            // 对得上待写内容的就是自己的回声，不能当成别的页面的改动再广播一轮
            touched = touched.filter(key => !sameValue(changes[key].newValue, this.pending?.[key]));
        }
        if (touched.length === 0) {
            return NOTHING_CHANGED;
        }

        let next = this.current;
        for (const key of touched) {
            const field = FIELD_BY_KEY.get(key)!;
            next = withField(next, field, normalize(key, changes[key].newValue));
        }

        // 换的是账号：这一批没带的派生字段也要清空，不能留着上一个账号的
        const authChanged = describe(next, this.current).authChanged;
        if (authChanged) {
            for (const field of DERIVED_ON_AUTH_CHANGE) {
                if (touched.includes(KEY_BY_FIELD.get(field)!)) continue;
                next = withField(next, field, emptySettings()[field]);
            }
        }

        const delta: SettingsDelta = { ...describe(next, this.current), fromOtherPage: true };
        if (!delta.changed) return NOTHING_CHANGED;

        this.current = next;
        this.notify(delta);
        return delta;
    }

    /** 订阅设置变化（本机改动与别的页面的改动都走这里，只有一条通知路径） */
    watch(listener: (settings: CloudAccountSettings, delta: SettingsDelta) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(delta: SettingsDelta): void {
        const snapshot = this.get();
        for (const listener of this.listeners) {
            listener(snapshot, delta);
        }
    }
}
