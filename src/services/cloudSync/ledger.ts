/**
 * 同步账本：本机「和云端对齐到哪一版」的唯一记录
 *
 * 这三项是一起写的：上次同步的合并基线（base）、这一版云端文件的指纹、上次同步时间。
 * 拆开放在服务层里，就会长出三套各自发明的探针——
 *   - 比 base 深比较（太贵）→ 改成比上次同步时间；
 *   - 时间探针认不出「云端把刚才那版又还给我一次」→ 补一份已见版本名单；
 *   - 名单本身又要跟 base 同批读写，否则探针在并发下失效。
 * 三个探针其实都在回答同一个问题：「本轮的合并基线还作数吗」。
 * 现在这个问题由账本回答，答案只有这一个出处。
 *
 * 约定：
 *   - `beginRound()` 必须在下载云端之前调用，本轮全程只用这一份快照；
 *   - `commit()` 把三项作为一批写回，别的页面据此判断自己手里的基线过期了；
 *   - 上次同步时间只有这里是作者，账号设置（settings.ts）不碰它。
 */

import { STORAGE_KEYS } from '@/types/storage';
import type { StorageValue } from '@/types/storage';
import { hasCloudSyncBase } from '@/services/storageSchema.service';
import type { SyncSnapshot } from '@/utils/syncMerge.util';
import type { CloudLedgerStorage } from '@/types/cloudSync.types';

/**
 * 记住最近几版的云端版本号
 * 只留最新的一版不够：一轮同步里本机可能连着读到同一个旧版本两次
 * （上传后 1 分钟内旧版本还在服务），而多标签页各自同步时读到的新旧顺序也不固定。
 */
const SEEN_REVISIONS_LIMIT = 5;

/** 一轮同步的合并基线，全部在下载云端之前取齐 */
export interface SyncRound {
    /** 上次同步落定的快照；首次同步为 null */
    base: SyncSnapshot | null;
    /** 已经合并过的云端版本号 */
    seenRevisions: string[];
    /** 取基线时的同步时间，用来发现「下载期间别的页面又同步完了一次」 */
    startedAt: number;
}

export class SyncLedger {
    private readonly storage: CloudLedgerStorage;
    private lastSyncedAt = 0;
    private readonly listeners = new Set<(lastSyncTime: number, fromOtherPage: boolean) => void>();
    private unsubscribeFromStorage: (() => void) | null = null;
    /** 正在写入的同步时间，用来认出内核送回来的自己的回声 */
    private pendingTime: number | null = null;

    constructor(storage: CloudLedgerStorage) {
        this.storage = storage;
    }

    /** 上次同步成功的时间（内存缓存，供界面同步读取） */
    lastSyncTime(): number {
        return this.lastSyncedAt;
    }

    /** 从存储读回上次同步时间；页面启动时调用一次 */
    async load(): Promise<number> {
        const stored = await this.storage.get(STORAGE_KEYS.CLOUD_LAST_SYNC_TIME);
        this.track(typeof stored === 'number' ? stored : 0, false);
        return this.lastSyncedAt;
    }

    /**
     * 开始一轮同步：一次性取齐基线
     *
     * 三个键必须在这一次读齐、并且都发生在下载之前。晚一步读，拿到的就是别的页面
     * 在这几次网络往返里写下的新基线，配上手里的旧云端数据，合并结论不可信。
     */
    async beginRound(): Promise<SyncRound> {
        const [base, startedAt, seen] = await Promise.all([
            this.storage.get(STORAGE_KEYS.CLOUD_SYNC_BASE) as Promise<SyncSnapshot | null>,
            this.storage.get(STORAGE_KEYS.CLOUD_LAST_SYNC_TIME),
            this.storage.get(STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS)
        ]);
        return {
            base: base ?? null,
            startedAt: typeof startedAt === 'number' ? startedAt : 0,
            seenRevisions: Array.isArray(seen) ? (seen as string[]) : []
        };
    }

    /** 下载期间别的页面是否又同步完了一次 */
    async isStale(round: SyncRound): Promise<boolean> {
        const now = await this.storage.get(STORAGE_KEYS.CLOUD_LAST_SYNC_TIME);
        return (typeof now === 'number' ? now : 0) !== round.startedAt;
    }

    /**
     * 云端这一版对本机是不是新内容
     *
     * 不能只看 lastModified：写后立读时 Gist 有约 1 分钟把旧文件再返回一次，
     * 旧文件在字段级三方合并里和「别的设备改了云端」一模一样，会把过期值当成最新
     * 采纳下来，再推上云端扩散。版本号取文件内容哈希，同一版永远同一个指纹。
     */
    isNewRevision(round: SyncRound, revision: string | undefined): boolean {
        if (!revision) return true;
        // 本机还没有基线时，云端任何一版都是新的（首次同步要看云端脸色）
        if (!hasCloudSyncBase(round.base)) return true;
        return !round.seenRevisions.includes(revision);
    }

    /**
     * 一轮双向同步走通：基线、同步时间、已见版本作为一批写回
     *
     * 名单从本轮的基线往后追加，而不是重新读一次存储：读回来的可能是别的页面
     * 在这一轮里写的版本名单，混进本机这份就会把对方刚合并过的那版记成「本机看过的旧内容」。
     * @param revision 本轮读到的云端版本号；没有版本号时不动名单
     */
    async commit(
        round: SyncRound,
        snapshot: SyncSnapshot,
        revision: string | undefined,
        time: number
    ): Promise<void> {
        if (!revision) {
            await this.rebase(snapshot, time);
            return;
        }
        const seenRevisions = [revision, ...round.seenRevisions.filter(item => item !== revision)]
            .slice(0, SEEN_REVISIONS_LIMIT);
        await this.write({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: snapshot,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: time,
            [STORAGE_KEYS.CLOUD_SYNC_SEEN_REVISIONS]: seenRevisions
        }, time);
    }

    /**
     * 全量覆盖云端之后重新对齐基线
     * 云端现在就是刚推上去的这份；版本名单不动——本机没读过云端，凭什么改「见过哪些版」。
     */
    async rebase(snapshot: SyncSnapshot, time: number): Promise<void> {
        await this.write({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: snapshot,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: time
        }, time);
    }

    /** 换平台或断开同步：基线与同步时间一起作废，留着会让新平台的空云端被误判成「远端删了全部」 */
    async discard(): Promise<void> {
        await this.write({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: null,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: 0
        }, 0);
    }

    /**
     * 跟着别的页面的账本走
     * 上次同步时间是界面要显示的数，别的设备同步完，本页的「上次同步」也得跟着更新。
     */
    observe(): () => void {
        if (!this.unsubscribeFromStorage) {
            this.unsubscribeFromStorage = this.storage.subscribe(changes => {
                const stored = changes[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]?.newValue;
                if (typeof stored !== 'number' || stored === this.pendingTime) return;
                this.track(stored, true);
            });
        }
        return () => this.stopObserving();
    }

    stopObserving(): void {
        this.unsubscribeFromStorage?.();
        this.unsubscribeFromStorage = null;
    }

    /** 订阅上次同步时间变化（本机与别的页面都走这里） */
    watch(listener: (lastSyncTime: number, fromOtherPage: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * 账本三项永远作为一批写入
     * 记下正在写的同步时间：内核会把这批写入原样通知回来，那条回声不能当成「别的页面同步完了」。
     */
    private async write(items: Record<string, StorageValue>, time: number): Promise<void> {
        this.pendingTime = time;
        try {
            await this.storage.setMany(items);
        } finally {
            this.pendingTime = null;
        }
        this.track(time, false);
    }

    private track(time: number, fromOtherPage: boolean): void {
        if (this.lastSyncedAt === time) return;
        this.lastSyncedAt = time;
        for (const listener of this.listeners) {
            listener(time, fromOtherPage);
        }
    }
}
