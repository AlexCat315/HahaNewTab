import { STORAGE_KEYS } from '@/types/storage';
import { CLOUD_SYNC_DATA_KEYS } from '@/services/storageSchema.service';
import { compactSnapshot, pickMinimalMode, trace } from '@/services/diag.service';
import type { SyncSnapshot } from '@/utils/syncMerge.util';
import { SyncProviderError } from '@/services/gistProvider.service';
import * as transport from '@/services/cloudSync/transport';
import { assertRemoteUsable, planSync } from '@/services/cloudSync/engine';
import { CloudSettings } from '@/services/cloudSync/settings';
import type { SettingsDelta } from '@/services/cloudSync/settings';
import { SyncLedger } from '@/services/cloudSync/ledger';
import type {
    CloudBundle,
    CloudSyncDependencies,
    CloudSyncSettings,
    CloudSyncStorage,
    CloudTarget,
    ConnectResult,
    DownloadResult,
    GitHubUserInfo,
    ICloudSyncDataManager,
    SyncResult,
    UploadResult
} from '@/types/cloudSync.types';

/** 一次设置变化的完整描述：新的快照 + 这一轮该做什么 */
export interface CloudSettingsChange {
    settings: CloudSyncSettings;
    /** 凭据换了：界面要清空错误提示 */
    authChanged: boolean;
    /** 变化来自同一浏览器的其他页面 */
    fromOtherPage: boolean;
}

/** 启动那一轮的结果：凭据判定的结论 + 是否真跑了一次同步 */
export interface CloudSyncStartupResult {
    /**
     * 平台明确拒绝本机保存的凭据（已撤销或过期）时的原因，此时凭据已被清掉；
     * 其余情况（凭据有效、没登录、只是连不上）为 null
     */
    rejectedReason: string | null;
    /** 启动那一轮同步的结果；没登录、凭据被拒或没开自动同步时为 null */
    sync: SyncResult | null;
}

/**
 * 云同步编排层
 *
 * 四类知识各自只在一个地方，本类只负责按顺序把它们串起来：
 *   - `cloudSync/settings.ts` —— 账号与开关（Token、Gist、自动同步、用户信息）；
 *   - `cloudSync/ledger.ts` —— 本机与云端对齐到哪一版（base 快照、已见版本、上次同步时间）；
 *   - `cloudSync/transport.ts` —— 云端长什么样（文件、分片、超时差异）；
 *   - `cloudSync/engine.ts` —— 三份数据怎么合成一份（校验、旧版本顶替、首次同步定方向、冲突取向）。
 *
 * 同步哪些键、怎么校验、怎么合并全部由存储键注册表决定。
 * 方法一律只返回结构化结果：弹什么提示、要不要用户确认，是要把结果写回界面的那一层
 * （cloudSync store）决定的事——这一层既不知道有没有人看着，也不该被打断去等人点按钮。
 * 「数据变了就自动同步」的触发与防抖同样在 store，
 * 这里只负责在把云端数据写回本地期间给出 isApplyingRemoteData 信号。
 */
export class CloudSyncService {
    private readonly storage: CloudSyncStorage;
    private readonly dataManager: ICloudSyncDataManager;
    /** 账号与开关的唯一所有者 */
    private readonly account: CloudSettings;
    /** 与云端对齐到哪一版的唯一记录者 */
    private readonly ledger: SyncLedger;

    private syncInProgress = false;
    /**
     * 正在把云端数据写回本地
     * 内核会把这次写入也当成「本地数据变更」通知回来，不抑制掉就会同步完再自动同步一次。
     */
    private applyingRemote = false;

    constructor(deps: CloudSyncDependencies) {
        this.storage = deps.storage;
        this.dataManager = deps.dataManager;
        this.account = new CloudSettings(deps.storage);
        this.ledger = new SyncLedger(deps.storage);
        // 从这一刻起就跟住存储变更：设置只有「本机写的」和「别的页面写的」两种来源，
        // 晚一步挂监听就会出现「启动读取之前那段时间里的改动没人认」的空窗
        this.account.observe();
        this.ledger.observe();
    }

    private get token(): string | null {
        return this.account.get().token;
    }

    private get gistId(): string | null {
        return this.account.get().gistId;
    }

    private get autoSync(): boolean {
        return this.account.get().autoSync;
    }

    /**
     * 本轮云端请求用的凭据快照
     * 服务层不再逐个方法碰适配器：平台差异、文件名、分片大小全在传输层，这里只交出一份凭据。
     * @throws 未登录
     */
    private target(): CloudTarget {
        const token = this.token;
        if (!token) {
            throw new Error('未配置 Token');
        }
        return { token };
    }

    /**
     * 启动：读回设置，确认保存的凭据还认得，开着自动同步就补一次静默同步
     *
     * @returns 见 `CloudSyncStartupResult`。启动失败属于「没人主动操作时的故障」，
     *          要不要说、说几次由调用方（store）定
     */
    async init(): Promise<CloudSyncStartupResult> {
        await this.loadSettings();

        if (!this.token) {
            return { rejectedReason: null, sync: null };
        }

        const rejected = await this.checkToken(this.token);
        if (rejected) {
            // 到这一步，云端账号里唯一还能骗过界面的就是这份 Token：留着它，
            // 界面按缓存的用户信息一路显示「已连接」，而每一次同步都注定失败。
            // 与 sync()/upload() 撞到 401 时同一个处理，差别只在于这里要说明原因。
            await this.account.save({ token: null, userInfo: null });
            return { rejectedReason: rejected, sync: null };
        }

        // 连不上、超时都不等于凭据失效（见 checkToken）：照常走启动那一轮，
        // 失败原因由 sync() 如实交出去，而不是在这里替它决定「那就不用试了」
        return {
            rejectedReason: null,
            sync: this.autoSync ? await this.sync({ silent: true }) : null
        };
    }

    /**
     * 读回设置与账本
     *
     * 别的页面的改动从服务创建起就一直跟着（见构造函数），这里只补上本机启动时那一份。
     */
    async loadSettings(): Promise<void> {
        await this.account.load();
        await this.ledger.load();
    }

    /**
     * 确认本机保存的凭据平台还认不认
     *
     * @returns 平台明确拒绝（401）时返回它给出的原因，其余情况（连不上、超时、其他状态码）
     *          返回 null。只有 401 才说明「这份 Token 解不开任何云端请求」；把网络问题
     *          当成凭据失效会在断网启动时把用户的登录状态抹掉。
     */
    private async checkToken(token: string): Promise<string | null> {
        try {
            const user = await transport.validateToken(token);
            await this.account.save({ token, userInfo: user });
            return null;
        } catch (e) {
            if (e instanceof SyncProviderError && e.status === 401) {
                return e.message;
            }
            console.warn('[CloudSync] 启动校验未能确认凭据（不是平台拒绝）:', e);
            return null;
        }
    }

    /**
     * 找到（或建出）放同步包的 Gist，并把认领到的 id 记回设置
     * 传输层不认识存储：它只回答「这个账号的同步空间是哪个」，认领结果由这里落盘。
     */
    private async resolveGistId(target: CloudTarget): Promise<string> {
        const known = this.gistId;
        const gistId = await transport.findOrCreateGist(target, known);
        if (gistId !== known) {
            await this.account.save({ gistId });
        }
        return gistId;
    }

    /** 查找或创建同步用的 Gist（用当前凭据） */
    async findOrCreateGist(): Promise<string> {
        return this.resolveGistId(this.target());
    }

    /**
     * 双向增量同步
     * 下载云端数据，以本地保存的上次同步快照为 base 与本地数据做三方合并（冲突本地优先），
     * 合并结果按需应用到本地并上传云端，成功后更新 base 快照。
     * 合并非破坏性，无需用户确认。
     * 返回 retry=true 表示本地改动这一轮没送出去（被进行中的同步挡下、下载期间别的页面同步完成、请求失败），
     * 调用方应当重新排程再来一次，否则会一直搁置到下一次编辑为止。
     *
     * 快照读取顺序：base → 云端 → 本地。base 必须在下载云端之前取，
     * 否则另一个标签页在这几次网络往返里同步完成并写了新 base，
     * 我们就会拿「新 base + 旧云端」去合并：本机改动被判成没动过，
     * 云端那份过期值反倒成了最新，用户刚改的设置几秒后被倒回去，
     * 而且这个倒回去的结果会被推上云端扩散到其他设备。
     */
    async sync({ silent = false }: { silent?: boolean } = {}): Promise<SyncResult> {
        if (this.syncInProgress) {
            trace('cloud-sync', { outcome: 'skipped-in-progress', silent });
            return { success: false, retry: true, skipped: 'in-progress', message: '同步进行中' };
        }
        if (!this.token) {
            return { success: false, skipped: 'not-authenticated', message: '请先完成 GitHub 授权' };
        }

        this.syncInProgress = true;
        try {
            // 一轮之内凭据、基线、云端内容各自只取一次：中途换了账号或别的页面写完 base，
            // 都不能让这一轮拿着半新半旧的三份数据去做合并
            const target = this.target();
            const round = await this.ledger.beginRound();
            const gistId = await this.resolveGistId(target);
            const remote = await transport.readBundle(target, gistId);

            if (await this.ledger.isStale(round)) {
                trace('cloud-sync', {
                    outcome: 'skipped-stale-base',
                    syncTimeBefore: round.startedAt,
                    remoteLastModified: remote.lastModified
                });
                // 别的页面在这期间又同步完一次：手里的 base 与刚下载的云端已经对不上，
                // 三方合并的结论不可信；放弃本轮，让调用方重来
                return { success: false, retry: true, skipped: 'stale-base', message: '其他标签页刚完成同步，稍后重试' };
            }

            // 先刷入内存变更，再收集本地数据
            await this.dataManager.syncNow();
            const local = await this.collectLocalSnapshot();
            const localUpdatedAt = (await this.storage.get(STORAGE_KEYS.DATA_UPDATED_AT) as number | null) ?? 0;
            // 云端这一版是不是本机没见过的新内容，判断只认文件内容哈希（见 SyncLedger）
            const remoteIsNew = this.ledger.isNewRevision(round, remote.revision);

            const plan = planSync({
                base: round.base,
                local,
                remote: remote.data,
                remoteIsNew,
                localUpdatedAt,
                remoteLastModified: remote.lastModified
            });

            trace('cloud-sync', {
                outcome: `${plan.applied ? 'applied ' : ''}${plan.uploaded ? 'uploaded' : ''}`.trim() || 'no-change',
                silent,
                hasBase: plan.hasBase,
                tieBreak: plan.tieBreak,
                remoteIsNew,
                localUpdatedAt,
                remoteLastModified: remote.lastModified,
                minimalModeRemote: pickMinimalMode(remote.data),
                minimalModeLocal: pickMinimalMode(local),
                minimalModeMerged: pickMinimalMode(plan.merged),
                base: compactSnapshot(round.base),
                remote: compactSnapshot(remote.data),
                local: compactSnapshot(local),
                merged: compactSnapshot(plan.merged)
            });

            if (plan.applied) {
                await this.applyToLocal(plan.merged);
            }
            if (plan.uploaded) {
                await transport.writeBundle(target, gistId, plan.merged);
            }

            const lastSyncTime = Date.now();
            await this.ledger.commit(round, plan.merged, remote.revision, lastSyncTime);

            return { success: true, uploaded: plan.uploaded, applied: plan.applied, time: lastSyncTime };
        } catch (e) {
            const authRejected = await this.handleIfUnauthorized(e);
            const message = e instanceof Error ? e.message : String(e);
            console.error('[CloudSync] sync error:', e);
            trace('cloud-sync', { outcome: 'failed', silent, message });
            return { success: false, retry: true, message, authRejected };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * 上传本地数据到云端（全量覆盖远端，并用上传结果更新 base 快照）
     * 多端场景请优先使用 sync()，此方法主要用于兼容与强制上传
     */
    async upload(): Promise<UploadResult> {
        if (this.syncInProgress) return { success: false, skipped: 'in-progress', message: '同步进行中' };
        if (!this.token) return { success: false, skipped: 'not-authenticated', message: '请先完成 GitHub 授权' };

        this.syncInProgress = true;
        const target = this.target();
        try {
            const gistId = await this.resolveGistId(target);
            await this.dataManager.syncNow();
            const snapshot = await this.collectLocalSnapshot();
            const lastModified = await transport.writeBundle(target, gistId, snapshot);

            await this.ledger.rebase(snapshot, lastModified);

            return { success: true, time: lastModified };
        } catch (e) {
            await this.handleIfUnauthorized(e);
            console.error('[CloudSync] upload error:', e);
            const message = e instanceof Error ? e.message : String(e);
            return { success: false, message };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * 从云端下载数据（不做任何本地写入）
     */
    async download(): Promise<DownloadResult> {
        if (this.syncInProgress) return { success: false, skipped: 'in-progress', message: '同步进行中' };
        if (!this.token) return { success: false, skipped: 'not-authenticated', message: '请先完成 GitHub 授权' };

        this.syncInProgress = true;
        const target = this.target();
        try {
            const gistId = await this.resolveGistId(target);
            return { success: true, data: await transport.readBundle(target, gistId) };
        } catch (e) {
            await this.handleIfUnauthorized(e);
            console.error('[CloudSync] download error:', e);
            const message = e instanceof Error ? e.message : String(e);
            return { success: false, message };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * 将云端数据整份覆盖到本地，并把 base 对齐到这一版
     * 覆盖是不可撤销的，因此先验结构再落盘；结构非法时抛出，什么都不写。
     */
    async applyDownloadedData(bundle: CloudBundle): Promise<void> {
        assertRemoteUsable(bundle.data);

        await this.applyToLocal(bundle.data);
        await this.ledger.rebase(bundle.data, bundle.lastModified);
    }

    /**
     * 保存并验证 OAuth 授权换到的 access_token
     *
     * 换账号时上一家的基线与 Gist 一并作废，留着旧 base 会让新账号的空远端
     * 被误判为「远端删除全部」。
     */
    async saveToken(token: string): Promise<ConnectResult> {
        token = token.trim();
        if (!token) {
            return { success: false, reason: 'empty' };
        }

        let userInfo: GitHubUserInfo;
        try {
            userInfo = await transport.validateToken(token);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error('[CloudSync] 凭据验证失败:', e);
            return { success: false, reason: 'invalid-token', message };
        }

        const switchingAccount = token !== this.token;
        if (switchingAccount) {
            await this.ledger.discard();
        }
        await this.account.save({
            token,
            userInfo,
            ...(switchingAccount ? { gistId: null } : {})
        });

        // Gist 初始化失败（无 gist 权限 / 网络受限）不应让整次登录失败：
        // 凭据已验证且已保存，用户至少已经「连上」，可以稍后重试同步。
        try {
            await this.resolveGistId({ token });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[CloudSync] 初始化 Gist 失败:', error);
            return { success: true, reason: 'gist-unavailable', message, userInfo };
        }

        return { success: true, userInfo };
    }

    /**
     * 断开云同步：清空云同步配置（含 base 快照），本地数据一律不动
     *
     * 「真的要断开吗」是界面要问的话，见 store.logout。
     * OAuth App 的 Client ID 不属于账号凭据，保留下来供下一次授权直接用。
     */
    async logout(): Promise<void> {
        await this.account.save({
            token: null,
            gistId: null,
            userInfo: null
        });
        await this.ledger.discard();
    }

    /**
     * 切换自动同步（开启后：数据变更时自动上传、启动时自动拉取合并）
     */
    async setAutoSync(enabled: boolean): Promise<void> {
        await this.account.save({ autoSync: !!enabled });
    }

    /**
     * 是否正在把云端数据写回本地
     *
     * 写入会经存储内核当成「本地数据变更」再通知一次；自动同步的触发方需要这个信号
     * 来分辨「本机改了数据」和「刚把云端结果落盘」，否则会同步完又自动同步一次。
     */
    get isApplyingRemoteData(): boolean {
        return this.applyingRemote;
    }

    /**
     * 当前设置快照
     * 账号侧来自 CloudSettings，上次同步时间来自账本，两份合起来才是界面看到的五项。
     */
    get settings(): CloudSyncSettings {
        return { ...this.account.get(), lastSyncTime: this.ledger.lastSyncTime() };
    }

    /**
     * 订阅设置快照变化：本机改动、同一浏览器其他页面的改动、账本更新都走这一条路
     *
     * 订阅者（store 的界面镜像）不需要知道变化来自哪一层，也不需要再各自对账。
     */
    watchSettings(listener: (change: CloudSettingsChange) => void): () => void {
        const emit = (delta: SettingsDelta): void => {
            listener({
                settings: this.settings,
                authChanged: delta.authChanged,
                fromOtherPage: delta.fromOtherPage
            });
        };
        const stopAccount = this.account.watch((_settings, delta) => emit(delta));
        const stopLedger = this.ledger.watch((_lastSyncTime, fromOtherPage) => emit({
            changed: true,
            authChanged: false,
            fromOtherPage
        }));
        return () => {
            stopAccount();
            stopLedger();
        };
    }

    /**
     * 是否已登录
     */
    get isLoggedIn(): boolean {
        return !!this.token;
    }

    /**
     * 是否正在同步
     */
    get isSyncing(): boolean {
        return this.syncInProgress;
    }

    /**
     * 授权失效（401）：清空本地凭据与用户信息，保留 gistId 以便重新授权后复用
     */
    private async handleIfUnauthorized(e: unknown): Promise<boolean> {
        if (e instanceof SyncProviderError && e.status === 401) {
            await this.account.save({ token: null, userInfo: null });
            return true;
        }
        return false;
    }

    /**
     * 按注册表收集本地需要同步的数据
     *
     * 只收本机真正写过的键：内核对于从没落盘的键返回 null，而另一端压根没带这个键，
     * null 参与比较会把每次同步都判成「本地有更新」，白白上传一遍。
     */
    private async collectLocalSnapshot(): Promise<SyncSnapshot> {
        const values = await this.storage.getMany(CLOUD_SYNC_DATA_KEYS);
        const snapshot: SyncSnapshot = {};
        for (const [key, value] of Object.entries(values)) {
            if (value !== null && value !== undefined) {
                snapshot[key] = value;
            }
        }
        return snapshot;
    }

    /** 把快照写回本地；写入期间抑制自动同步，免得「同步完成 → 触发变更 → 又同步一次」 */
    private async applyToLocal(snapshot: SyncSnapshot): Promise<void> {
        this.applyingRemote = true;
        try {
            await this.dataManager.applyStorageSnapshot(snapshot);
        } finally {
            this.applyingRemote = false;
        }
    }
}

/**
 * 工厂函数：根据依赖创建 CloudSyncService 实例
 */
export function createCloudSyncService(deps: CloudSyncDependencies): CloudSyncService {
    return new CloudSyncService(deps);
}
