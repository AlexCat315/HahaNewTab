import { CLOUD_SYNC_DATA_KEYS } from '@/services/storageSchema.service';
import type { StorageChanges } from '@/types/storage';

/** 自动同步防抖：连续增删站点时只在停下来后同步一次 */
export const AUTO_SYNC_DEBOUNCE_MS = 3000;

/**
 * 本轮自动同步失败后允许的重试轮数
 * 只补最小的一截：改动会因为「另一个页面正在同步」或一次网络抖动被整轮丢弃，
 * 不重试就得等下一次编辑或重开页面才送出去。设上限是为了断网时不无限重试，
 * 也不会每隔几秒再弹一次失败提示。
 */
export const AUTO_SYNC_MAX_RETRY_ROUNDS = 2;

export interface AutoSyncSchedulerDeps {
    /** 变更源：存储内核，不是某个 store 自己派发的事件 */
    subscribe: (listener: (changes: StorageChanges) => void) => () => void;
    /** 本机是否处在「有东西值得同步」的状态：已登录且开启自动同步 */
    isArmed: () => boolean;
    /**
     * 是否正在把云端数据写回本地
     * 那次落盘同样会通知回来，不认出来就会「同步完成 → 触发变更 → 又同步一次」。
     */
    isApplyingRemoteData: () => boolean;
    /** 跑一轮，返回值里的 retry 表示这一轮没把本地改动送出去，需要再来一次 */
    run: () => Promise<{ retry?: boolean }>;
    /** 防抖时长与重试轮数：只在测试里收紧 */
    debounceMs?: number;
    maxRetryRounds?: number;
}

/**
 * 自动同步调度器
 *
 * 只管「什么时候再同步一次」这一件事：认出本机改了同步范围内的数据、防抖、
 * 失败后补最小的一截重试。同步本身、界面状态、要提示什么都归调用方。
 */
export class AutoSyncScheduler {
    private readonly deps: AutoSyncSchedulerDeps;
    private readonly debounceMs: number;
    private readonly maxRetryRounds: number;

    /** 监听是否已挂上（start/stop 可重复调用） */
    private attached = false;
    private unsubscribe: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** 本轮还允许重试几次 */
    private retryLeft = 0;

    constructor(deps: AutoSyncSchedulerDeps) {
        this.deps = deps;
        this.debounceMs = deps.debounceMs ?? AUTO_SYNC_DEBOUNCE_MS;
        this.maxRetryRounds = deps.maxRetryRounds ?? AUTO_SYNC_MAX_RETRY_ROUNDS;
    }

    /** 开始监听存储变更 */
    start(): void {
        if (this.attached) return;
        this.attached = true;
        this.unsubscribe = this.deps.subscribe(changes => this.handleChanges(changes));
    }

    /** 停止监听，并撤销尚未发出的同步 */
    stop(): void {
        this.attached = false;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.cancel();
    }

    /**
     * 一次新的用户改动：重新排程并给满重试额度
     *
     * 面板、快捷键等「刚改完东西」的入口可以直接调用它；挂在存储上的监听也会走到这里。
     */
    trigger(): void {
        if (!this.deps.isArmed()) return;
        this.retryLeft = this.maxRetryRounds;
        this.arm();
    }

    /** 撤销尚未发出的同步（含重试），不改变监听状态 */
    cancel(): void {
        this.retryLeft = 0;
        this.clearTimer();
    }

    /**
     * 只认「本机把同步范围内的数据改了」
     *
     * 名单来自存储键注册表：站点数据与图标库无论经过哪条写入路径（增删站点、导入备份、
     * 其他标签页改动）都会通知到这里；设备本地态（侧栏折叠这类）不在名单里，不该触发。
     */
    private handleChanges(changes: StorageChanges): void {
        if (!CLOUD_SYNC_DATA_KEYS.some(key => key in changes)) {
            return;
        }
        if (this.deps.isApplyingRemoteData()) {
            return;
        }
        this.trigger();
    }

    /** 起一个防抖定时器；重试走这里，因此不会重置额度，也不会把额度叠回上限 */
    private arm(): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.round();
        }, this.debounceMs);
    }

    private async round(): Promise<void> {
        let needsRetry = false;
        try {
            needsRetry = (await this.deps.run()).retry === true;
        } catch {
            // 抛错同样是「这一轮没送出去」；提示由调用方负责，这里只避免未处理的 Promise 拒绝
            needsRetry = true;
        }
        if (needsRetry && this.retryLeft > 0) {
            this.retryLeft--;
            this.arm();
        }
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
