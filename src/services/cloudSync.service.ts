import { STORAGE_KEYS } from '@/types/storage';
import {
    CLOUD_SYNC_DATA_KEYS,
    CLOUD_SYNC_KEY_STRATEGIES,
    findCloudSyncViolation,
    hasCloudSyncBase
} from '@/services/storageSchema.service';
import { pushCrossDeviceAuth, pullCrossDeviceAuth, getCrossDeviceState } from '@/services/crossDeviceSync.service';
import { deepEqual, mergeSnapshots } from '@/utils/syncMerge.util';
import type { MergeTieBreak, SyncSnapshot } from '@/utils/syncMerge.util';
import { createGistProvider, SyncProviderError } from '@/services/gistProvider.service';
import type {
    CloudSyncDependencies,
    CloudSyncProviderId,
    CloudSyncSettings,
    CloudSyncStorage,
    DownloadResult,
    GitHubUserInfo,
    ICloudSyncDataManager,
    ICloudSyncUIAdapter,
    ISyncProvider,
    PullResult,
    SyncData,
    SyncResult,
    UploadResult
} from '@/types/cloudSync.types';

const SYNC_FILE_NAME = 'haha-newtab-sync.json';
const GIST_DESCRIPTION = 'HahaNewTab 导航数据云同步备份';

/** 默认同步平台（老用户有 token 但无 provider 记录时按 GitHub 处理） */
const DEFAULT_PROVIDER: CloudSyncProviderId = 'github';

/**
 * 云同步服务
 * 通过 ISyncProvider 适配 GitHub / Gitee 的 Gist（代码片段）API。
 * 多端同步通过 `sync()` 完成：以本地保存的上次同步快照为 base 做三方合并，
 * 冲突时本地优先，避免全量覆盖丢失其他设备的修改。
 * 同步哪些键、怎么校验、怎么合并全部由存储键注册表决定，本服务只按表执行；
 * 「数据变了就自动同步」的触发与防抖在 cloudSync store（它才是要把结果写回界面状态的那一方），
 * 这里只负责在把云端数据写回本地期间给出 isApplyingRemoteData 信号。
 * 所有平台请求带 10s 超时，失败按网络/401/频率限制分类并 Toast 提示。
 */
export class CloudSyncService {
    private readonly storage: CloudSyncStorage;
    private readonly dataManager: ICloudSyncDataManager;
    private readonly ui: ICloudSyncUIAdapter;

    private token: string | null = null;
    private gistId: string | null = null;
    private autoSync = false;
    private lastSyncTime = 0;
    private userInfo: GitHubUserInfo | null = null;
    private providerId: CloudSyncProviderId = DEFAULT_PROVIDER;
    private syncInProgress = false;
    /**
     * 正在把云端数据写回本地
     * 内核会把这次写入也当成「本地数据变更」通知回来，不抑制掉就会同步完再自动同步一次。
     */
    private applyingRemote = false;

    constructor(deps: CloudSyncDependencies) {
        this.storage = deps.storage;
        this.dataManager = deps.dataManager;
        this.ui = deps.ui;
    }

    /** 当前平台的同步适配器 */
    private get provider(): ISyncProvider {
        return createGistProvider(this.providerId);
    }

    /**
     * 初始化云同步服务
     * 加载设置，若已登录则验证 Token；开启自动同步时启动即执行一次双向合并同步
     */
    async init(): Promise<void> {
        await this.loadSettings();

        // 本机没有 Token 时，尝试从浏览器账号同步区还原（跨设备登录状态）
        if (!this.token) {
            await this.adoptCrossDeviceAuth();
        }

        if (this.token) {
            const valid = await this.validateToken(this.token);
            if (valid && this.autoSync) {
                await this.sync({ silent: true });
            }
        }
    }

    /**
     * 尝试从 storage.sync 还原登录凭据
     * 解密失败（例如另一台设备用了不同口令）时静默跳过，不影响正常流程
     */
    private async adoptCrossDeviceAuth(): Promise<void> {
        try {
            const auth = await pullCrossDeviceAuth();
            if (!auth) return;

            this.token = auth.token;
            this.providerId = auth.provider as CloudSyncProviderId;
            await this.saveSettings();
        } catch (error) {
            console.warn('[CloudSync] 跨设备登录状态还原失败:', error);
        }
    }

    /**
     * 从存储中加载云同步设置
     */
    async loadSettings(): Promise<void> {
        const stored = await this.storage.getMany([
            STORAGE_KEYS.CLOUD_TOKEN,
            STORAGE_KEYS.CLOUD_GIST_ID,
            STORAGE_KEYS.CLOUD_AUTO_SYNC,
            STORAGE_KEYS.CLOUD_LAST_SYNC_TIME,
            STORAGE_KEYS.CLOUD_USER_INFO,
            STORAGE_KEYS.CLOUD_PROVIDER
        ]);

        this.token = (stored[STORAGE_KEYS.CLOUD_TOKEN] as string | null) ?? null;
        this.gistId = (stored[STORAGE_KEYS.CLOUD_GIST_ID] as string | null) ?? null;
        this.autoSync = (stored[STORAGE_KEYS.CLOUD_AUTO_SYNC] as boolean | null) ?? false;
        this.lastSyncTime = (stored[STORAGE_KEYS.CLOUD_LAST_SYNC_TIME] as number | null) ?? 0;
        this.userInfo = (stored[STORAGE_KEYS.CLOUD_USER_INFO] as GitHubUserInfo | null) ?? null;
        this.providerId = (stored[STORAGE_KEYS.CLOUD_PROVIDER] as CloudSyncProviderId | null) ?? DEFAULT_PROVIDER;
    }

    /**
     * 将当前设置保存到存储
     */
    async saveSettings(): Promise<void> {
        await this.storage.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: this.token,
            [STORAGE_KEYS.CLOUD_GIST_ID]: this.gistId,
            [STORAGE_KEYS.CLOUD_AUTO_SYNC]: this.autoSync,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: this.lastSyncTime,
            [STORAGE_KEYS.CLOUD_USER_INFO]: this.userInfo,
            [STORAGE_KEYS.CLOUD_PROVIDER]: this.providerId
        });
    }

    /**
     * 验证 Token 是否有效（使用当前平台）
     */
    async validateToken(token: string | null = this.token): Promise<boolean> {
        if (!token) return false;
        try {
            const user = await this.provider.validateToken(token);
            this.userInfo = user;
            if (token !== this.token) {
                this.token = token;
                await this.saveSettings();
            } else {
                await this.storage.set(STORAGE_KEYS.CLOUD_USER_INFO, this.userInfo);
            }
            return true;
        } catch (e) {
            console.error('[CloudSync] validateToken error:', e);
            return false;
        }
    }

    /**
     * 查找或创建同步用的 Gist
     */
    async findOrCreateGist(): Promise<string> {
        if (!this.token) {
            throw new Error('未配置 Token');
        }

        if (this.gistId) {
            try {
                const content = await this.provider.getGistFileContent(this.token, this.gistId, SYNC_FILE_NAME);
                if (content !== null) {
                    return this.gistId;
                }
            } catch (e) {
                console.warn('[CloudSync] stored gist not found, creating new one');
            }
        }

        const gists = await this.provider.listGists(this.token);
        const existing = gists.find((gist) => gist.files && gist.files[SYNC_FILE_NAME]);
        if (existing) {
            this.gistId = existing.id;
            await this.storage.set(STORAGE_KEYS.CLOUD_GIST_ID, this.gistId);
            return this.gistId;
        }

        this.gistId = await this.provider.createGist(
            this.token,
            SYNC_FILE_NAME,
            JSON.stringify(this.createEmptySyncData(), null, 2),
            GIST_DESCRIPTION
        );
        await this.storage.set(STORAGE_KEYS.CLOUD_GIST_ID, this.gistId);
        return this.gistId;
    }

    /**
     * 双向增量同步
     * 下载云端数据，以本地保存的上次同步快照为 base 与本地数据做三方合并（冲突本地优先），
     * 合并结果按需应用到本地并上传云端，成功后更新 base 快照。
     * 合并非破坏性，无需用户确认；失败时无论 silent 与否都会 Toast 提示。
     */
    async sync({ silent = false }: { silent?: boolean } = {}): Promise<SyncResult> {
        if (this.syncInProgress) return { success: false, message: '同步进行中' };
        if (!this.token) {
            if (!silent) this.ui.showToast('请先配置 Token', 'error');
            return { success: false, message: '请先配置 Token' };
        }

        this.syncInProgress = true;
        try {
            const gistId = await this.findOrCreateGist();
            const remote = await this.downloadSyncData(gistId);

            // 先刷入内存变更，再收集本地数据
            await this.dataManager.syncNow();
            const localData = await this.collectLocalSnapshot();

            this.assertSyncData(localData, remote.data ?? {});

            const base = (await this.storage.get(STORAGE_KEYS.CLOUD_SYNC_BASE)) as SyncSnapshot | null;
            // 首次同步没有 base，同 id 冲突无法判断哪端改过：改按「最后一次写入更晚」的一方胜出，
            // 否则新装设备那份出厂默认数据会把另一台已经改过的云端覆盖回去
            const localUpdatedAt = (await this.storage.get(STORAGE_KEYS.DATA_UPDATED_AT) as number | null) ?? 0;
            const tieBreak: MergeTieBreak =
                !hasCloudSyncBase(base) && (remote.lastModified ?? 0) > localUpdatedAt ? 'remote' : 'local';
            const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, base, localData, remote.data ?? {}, tieBreak);

            const applied = CLOUD_SYNC_DATA_KEYS.some((key) => !deepEqual(merged[key], localData[key]));
            const uploaded = CLOUD_SYNC_DATA_KEYS.some((key) => !deepEqual(merged[key], remote.data?.[key]));

            if (applied) {
                await this.applyToLocal(merged);
            }
            if (uploaded) {
                await this.uploadData(gistId, merged);
            }

            this.lastSyncTime = Date.now();
            await this.storage.setMany({
                [STORAGE_KEYS.CLOUD_SYNC_BASE]: merged,
                [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: this.lastSyncTime
            });

            if (!silent) {
                const actions = [
                    applied ? '已拉取云端更新' : '',
                    uploaded ? '已上传本地更新' : ''
                ].filter(Boolean);
                this.ui.showToast(actions.length ? `同步完成：${actions.join('，')}` : '同步完成：本地与云端已一致', 'success');
            }
            return { success: true, uploaded, applied, time: this.lastSyncTime };
        } catch (e) {
            await this.handleIfUnauthorized(e);
            const message = e instanceof Error ? e.message : String(e);
            console.error('[CloudSync] sync error:', e);
            // 失败策略：每次失败都提示（含静默的自动同步）
            this.ui.showToast('同步失败：' + message, 'error');
            return { success: false, message };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * 上传本地数据到云端（全量覆盖远端，并用上传结果更新 base 快照）
     * 多端场景请优先使用 sync()，此方法主要用于兼容与强制上传
     */
    async upload({ silent = false }: { silent?: boolean } = {}): Promise<UploadResult> {
        if (this.syncInProgress) return { success: false, message: '同步进行中' };
        if (!this.token) {
            if (!silent) this.ui.showToast('请先配置 Token', 'error');
            return { success: false, message: '请先配置 Token' };
        }

        this.syncInProgress = true;
        try {
            const gistId = await this.findOrCreateGist();
            const syncData = await this.collectLocalData();
            await this.uploadData(gistId, syncData.data);

            this.lastSyncTime = syncData.lastModified;
            await this.storage.setMany({
                [STORAGE_KEYS.CLOUD_SYNC_BASE]: syncData.data,
                [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: this.lastSyncTime
            });

            if (!silent) this.ui.showToast(`数据已同步到 ${this.provider.name}`, 'success');
            return { success: true, time: this.lastSyncTime };
        } catch (e) {
            await this.handleIfUnauthorized(e);
            console.error('[CloudSync] upload error:', e);
            const message = e instanceof Error ? e.message : String(e);
            // 失败策略：每次失败都提示
            this.ui.showToast('同步失败：' + message, 'error');
            return { success: false, message };
        } finally {
            this.syncInProgress = false;
        }
    }

    /**
     * 从云端下载数据
     */
    async download(): Promise<DownloadResult> {
        if (this.syncInProgress) return { success: false, message: '同步进行中' };
        if (!this.token) return { success: false, message: '请先配置 Token' };

        this.syncInProgress = true;
        try {
            const gistId = await this.findOrCreateGist();
            const syncData = await this.downloadSyncData(gistId);
            return { success: true, data: syncData };
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
     * 将云端数据应用到本地（覆盖），并同步更新 base 快照
     */
    async applyDownloadedData(syncData: SyncData): Promise<boolean> {
        if (!syncData?.data) return false;

        const snapshot = this.pickCloudSyncData(syncData.data);
        const violation = findCloudSyncViolation(snapshot);
        if (violation) {
            throw new Error(`云端${violation}`);
        }

        await this.applyToLocal(snapshot);

        this.lastSyncTime = syncData.lastModified ?? Date.now();
        await this.storage.setMany({
            [STORAGE_KEYS.CLOUD_SYNC_BASE]: snapshot,
            [STORAGE_KEYS.CLOUD_LAST_SYNC_TIME]: this.lastSyncTime
        });

        return true;
    }

    /**
     * 强制恢复：拉取云端数据并覆盖本地（用户主动点击「强制恢复云端」）
     * 覆盖前弹确认框；此操作是兜底手段，日常同步请使用 sync()
     */
    async pullAndApply({ force = false, silent = false }: { force?: boolean; silent?: boolean } = {}): Promise<PullResult> {
        if (!this.token) {
            if (!silent) this.ui.showToast('请先配置 Token', 'error');
            return { success: false };
        }

        const result = await this.download();
        if (!result.success || !result.data) {
            if (!silent) this.ui.showToast('拉取失败：' + result.message, 'error');
            return result;
        }

        const remote = result.data;
        const remoteTime = new Date(remote.lastModified).toLocaleString();
        const localSyncTime = this.lastSyncTime ? new Date(this.lastSyncTime).toLocaleString() : '从未上传';

        if (!force) {
            const TIME_BUFFER = 5000;
            const remoteNewer = remote.lastModified > (this.lastSyncTime ?? 0) + TIME_BUFFER;
            if (!remoteNewer) {
                return { success: true, applied: false, message: '本地数据已是最新' };
            }

            const confirmed = await this.ui.showConfirm(
                `检测到云端数据更新（云端 ${remoteTime}，本地上次上传 ${localSyncTime}），是否用云端数据覆盖本地？`,
                { title: '恢复云端数据', okText: '覆盖本地', isDanger: true }
            );
            if (!confirmed) return { success: true, applied: false, message: '用户取消' };
        } else {
            const confirmed = await this.ui.showConfirm(
                `将用云端数据覆盖本地（云端更新时间：${remoteTime}），此操作不可撤销，是否继续？`,
                { title: '强制恢复云端', okText: '覆盖本地', isDanger: true }
            );
            if (!confirmed) return { success: true, applied: false, message: '用户取消' };
        }

        await this.applyDownloadedData(remote);
        if (!silent) this.ui.showToast('已从云端恢复数据', 'success');
        return { success: true, applied: true };
    }

    /**
     * 保存并验证 Token
     * @param providerId 目标平台；切换平台会重置 gistId/base 快照/上次同步时间，
     *                   避免旧平台的 base 让新平台的空远端被误判为「远端删除全部」
     */
    async saveToken(token: string, providerId: CloudSyncProviderId = this.providerId): Promise<boolean> {
        token = token.trim();
        if (!token) {
            this.ui.showToast('请输入 Token', 'error');
            return false;
        }

        const provider = createGistProvider(providerId);
        this.ui.showToast('正在验证 Token...', 'info');
        let userInfo: GitHubUserInfo;
        try {
            userInfo = await provider.validateToken(token);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.ui.showToast('Token 验证失败：' + message, 'error');
            return false;
        }

        if (providerId !== this.providerId || token !== this.token) {
            this.gistId = null;
            this.lastSyncTime = 0;
            await this.storage.set(STORAGE_KEYS.CLOUD_SYNC_BASE, null);
        }
        this.providerId = providerId;
        this.token = token;
        this.userInfo = userInfo;
        await this.saveSettings();
        await this.pushAuthToCrossDevice();

        // Gist 初始化失败（无 gist 权限 / 网络受限）不应让整次登录失败：
        // Token 已验证且已保存，用户至少已经「连上」，可以稍后重试同步。
        try {
            await this.findOrCreateGist();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[CloudSync] 初始化 Gist 失败:', error);
            this.ui.showToast(`账号已连接，但同步空间初始化失败：${message}`, 'error');
            return true;
        }

        this.ui.showToast(`${provider.name} 账号已连接`, 'success');
        return true;
    }

    /**
     * 把当前登录凭据推送到浏览器账号同步区（未启用跨设备同步时为 no-op）
     *
     * 已开启浏览器同步但推送失败（例如本机口令丢失、同步区配额不足）时必须提示，
     * 否则用户会以为「浏览器同步已经生效」，换设备时才发现根本没有凭据。
     */
    private async pushAuthToCrossDevice(): Promise<void> {
        try {
            const state = await getCrossDeviceState();
            if (!state.enabled) {
                return;
            }

            const pushed = await pushCrossDeviceAuth(
                this.token ? { token: this.token, provider: this.providerId } : null
            );

            if (!pushed && this.token) {
                this.ui.showToast(
                    state.hasPassphrase
                        ? '浏览器同步未写入：同步区不可用，请检查浏览器账号同步设置'
                        : '浏览器同步未写入：本机缺少同步密码，请重新设置',
                    'error'
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[CloudSync] 浏览器同步失败:', error);
            this.ui.showToast('浏览器同步失败：' + message, 'error');
        }
    }

    /**
     * 显示 Token 输入对话框并尝试保存（使用当前平台）
     */
    async showLoginDialog(): Promise<void> {
        const provider = this.provider;
        const token = await this.ui.showPrompt(
            `请输入 ${provider.name} Token（${provider.tokenHint}）`,
            {
                title: `连接 ${provider.name}`,
                confirmText: '连接',
                cancelText: '取消',
                inputPlaceholder: this.providerId === 'gitee' ? 'xxxxxxxxxxxxxxxx' : 'ghp_xxxxxxxxxxxxxxxxxxxx',
                inputType: 'password'
            }
        );
        if (token) {
            await this.saveToken(token);
        }
    }

    /**
     * 退出登录，清空云同步配置（含 base 快照与平台选择）
     */
    async logout(): Promise<void> {
        const confirmed = await this.ui.showConfirm('确定要断开云同步吗？本地数据不会删除。', {
            title: '断开同步',
            okText: '断开',
            isDanger: true
        });
        if (!confirmed) return;

        this.token = null;
        this.gistId = null;
        this.userInfo = null;
        this.lastSyncTime = 0;
        this.providerId = DEFAULT_PROVIDER;
        await this.saveSettings();
        await this.pushAuthToCrossDevice();
        await this.storage.set(STORAGE_KEYS.CLOUD_SYNC_BASE, null);
        this.ui.showToast('已断开云同步', 'success');
    }

    /**
     * 切换自动同步（开启后：数据变更时自动上传、启动时自动拉取合并）
     */
    async setAutoSync(enabled: boolean): Promise<void> {
        this.autoSync = !!enabled;
        await this.storage.set(STORAGE_KEYS.CLOUD_AUTO_SYNC, this.autoSync);
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
     */
    get settings(): CloudSyncSettings {
        return {
            token: this.token,
            gistId: this.gistId,
            autoSync: this.autoSync,
            lastSyncTime: this.lastSyncTime,
            userInfo: this.userInfo,
            provider: this.providerId
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
     * Token 失效（401）：清空本地 Token 与用户信息，保留 gistId 以便重新连接后复用
     */
    private async handleIfUnauthorized(e: unknown): Promise<void> {
        if (e instanceof SyncProviderError && e.status === 401) {
            this.token = null;
            this.userInfo = null;
            await this.saveSettings();
        }
    }

    /** 按注册表收集本地需要同步的数据 */
    private async collectLocalSnapshot(): Promise<SyncSnapshot> {
        return await this.storage.getMany(CLOUD_SYNC_DATA_KEYS);
    }

    /**
     * 从任意数据里挑出注册表登记的同步键
     * 云端 data 可能带着旧版本、别的分支写过的多余键，收进来前先按表过滤。
     */
    private pickCloudSyncData(data: Record<string, unknown>): SyncSnapshot {
        const snapshot: SyncSnapshot = {};
        for (const key of CLOUD_SYNC_DATA_KEYS) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                snapshot[key] = data[key];
            }
        }
        return snapshot;
    }

    /** 两端数据任一份结构非法就中止同步：坏数据一旦被合并上传，会覆盖掉好那一端 */
    private assertSyncData(localData: SyncSnapshot, remoteData: SyncSnapshot): void {
        const localViolation = findCloudSyncViolation(localData);
        if (localViolation) {
            throw new Error(`本地${localViolation}`);
        }
        const remoteViolation = findCloudSyncViolation(remoteData);
        if (remoteViolation) {
            throw new Error(`云端${remoteViolation}`);
        }
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

    /**
     * 下载并解析远端同步数据
     */
    private async downloadSyncData(gistId: string): Promise<SyncData> {
        if (!this.token) {
            throw new Error('未配置 Token');
        }
        const content = await this.provider.getGistFileContent(this.token, gistId, SYNC_FILE_NAME);
        if (content === null) {
            throw new Error('同步文件不存在');
        }
        return JSON.parse(content) as SyncData;
    }

    /**
     * 上传合并后的数据到云端
     */
    private async uploadData(gistId: string, data: SyncSnapshot): Promise<void> {
        if (!this.token) {
            throw new Error('未配置 Token');
        }
        const syncData: SyncData = {
            version: '1.0',
            lastModified: Date.now(),
            device: this.getDeviceName(),
            data
        };
        await this.provider.updateGist(this.token, gistId, SYNC_FILE_NAME, JSON.stringify(syncData, null, 2));
    }

    private createEmptySyncData(): SyncData {
        return {
            version: '1.0',
            lastModified: Date.now(),
            device: this.getDeviceName(),
            data: {}
        };
    }

    private async collectLocalData(): Promise<SyncData> {
        await this.dataManager.syncNow();
        return {
            version: '1.0',
            lastModified: Date.now(),
            device: this.getDeviceName(),
            data: await this.collectLocalSnapshot()
        };
    }

    private getDeviceName(): string {
        if (typeof navigator === 'undefined') return 'Browser';
        const ua = navigator.userAgent;
        if (ua.includes('Chrome')) return 'Chrome';
        if (ua.includes('Firefox')) return 'Firefox';
        if (ua.includes('Safari')) return 'Safari';
        if (ua.includes('Edg')) return 'Edge';
        return 'Browser';
    }
}

/**
 * 工厂函数：根据依赖创建 CloudSyncService 实例
 */
export function createCloudSyncService(deps: CloudSyncDependencies): CloudSyncService {
    return new CloudSyncService(deps);
}
