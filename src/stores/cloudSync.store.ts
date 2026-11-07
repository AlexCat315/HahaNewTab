/**
 * 云同步 Store：把服务层的结果写回界面
 *
 * 服务层（cloudSync.service.ts 及其下四个模块）只返回结构化结果，本层负责剩下三件事：
 *   - 界面状态镜像：账号设置跟着服务层的设置订阅抄一份，操作态（isLoading/error）自己管；
 *   - 提示口径：弹什么、弹几次（同一轮自动同步的故障只说一次）由 reportSyncResult / reportConnectResult 定；
 *   - 需要用户点头的操作：断开同步、用云端覆盖本地，先确认再交给服务层。
 * 「什么时候再同步一次」本身在 cloudSync/autoSync.ts，怎么合并怎么传输在服务层。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { storageManager } from '@/services/storage.service';
import { trace } from '@/services/diag.service';
import { CloudSyncService, createCloudSyncService } from '@/services/cloudSync.service';
import type { CloudSettingsChange } from '@/services/cloudSync.service';
import { AutoSyncScheduler } from '@/services/cloudSync/autoSync';
import { createCloudSyncDataManager } from './cloudSyncDataManager';
import type {
    ClearRemoteResult,
    ConnectResult,
    ICloudSyncUIAdapter,
    CloudSyncSettings,
    GitHubUserInfo,
    UploadResult,
    DownloadResult,
    PullResult,
    SyncResult
} from '@/types/cloudSync.types';

/**
 * 「云端比本机新」的判定余量
 * 秒级以内的差多半是两台机器的时钟没对齐，不是真有一端改过数据。
 */
const PULL_FRESHNESS_BUFFER_MS = 5000;

/** 默认 UI 适配器：Store 不直接操作 UI，默认无提示 / 自动确认 */
const DEFAULT_UI_ADAPTER: ICloudSyncUIAdapter = {
    showToast: () => {},
    showConfirm: async () => true,
    showPrompt: async () => null
};

export const useCloudSyncStore = defineStore('cloudSync', () => {
    const uiAdapter = ref<ICloudSyncUIAdapter>(DEFAULT_UI_ADAPTER);

    /** GitHub OAuth access_token */
    const token = ref<string | null>(null);
    /** 同步用 Gist ID */
    const gistId = ref<string | null>(null);
    /** 是否开启自动同步 */
    const autoSync = ref(false);
    /** GitHub 用户信息缓存 */
    const userInfo = ref<GitHubUserInfo | null>(null);
    /** 上次同步时间戳 */
    const lastSyncTime = ref(0);
    /** 是否正在执行云同步操作 */
    const isLoading = ref(false);
    /** 最近一次错误信息 */
    const error = ref<string | null>(null);

    /** 云同步服务：store 一建立就创建，设置从这一刻起跟着存储变更走 */
    const cloudSyncService = createService();
    /**
     * 这一轮自动同步的故障已经提示过没有
     * 失败会自动重试若干次，断网时每次都要再提示一遍就成了刷屏；只在第一次提示，
     * 任一轮成功之后复位。
     */
    let autoSyncFailureReported = false;

    function createService(): CloudSyncService {
        const service = createCloudSyncService({
            storage: storageManager,
            dataManager: createCloudSyncDataManager()
        });
        // 服务自己一直在观察存储变更（见 CloudSyncService 构造函数），本页是「另一个页面」时
        // 的采纳就完全不依赖谁先调用了哪个方法——只要这个页面开着，设置就是新的。
        service.watchSettings(handleSettingsChange);
        return service;
    }

    /**
     * 「本地数据变更 → 防抖自动同步」的调度器
     *
     * 变更源是存储内核，不是某个 store 自己派发的事件：站点数据与图标库无论经过哪条
     * 写入路径（增删站点、导入备份、其他标签页改动）都会通知到这里。
     * 走 store.sync 是为了让结果同时落回界面状态与提示口径。
     */
    const autoSyncScheduler = new AutoSyncScheduler({
        subscribe: listener => storageManager.subscribe(listener),
        isArmed: () => autoSync.value && !!token.value,
        isApplyingRemoteData: () => cloudSyncService.isApplyingRemoteData,
        run: () => sync({ silent: true })
    });

    /** 挂上本地数据变更监听（云同步面板/页面挂载期间为 true） */
    function startAutoSyncWatch(): void {
        autoSyncScheduler.start();
    }

    /** 摘掉监听，并撤销尚未发出的自动同步 */
    function stopAutoSyncWatch(): void {
        autoSyncScheduler.stop();
    }

    /** 一次新的用户改动：重新排一次自动同步 */
    function scheduleAutoSync(): void {
        autoSyncScheduler.trigger();
    }

    /**
     * 界面状态镜像：这几项的真相在服务层的设置模块与账本里，这里只跟着抄一份
     * 唯一的一条同步路径是服务层的订阅，动作函数里不再各自对账。
     */
    function applySettings(settings: CloudSyncSettings): void {
        token.value = settings.token;
        gistId.value = settings.gistId;
        autoSync.value = settings.autoSync;
        userInfo.value = settings.userInfo;
        lastSyncTime.value = settings.lastSyncTime;
    }

    /**
     * 设置变化 → 刷新界面；来自其他页面时还要顺带清掉旧的错误提示
     *
     * 面板常驻挂载（模态框用 v-show），设置只在启动时读一次；少了这条订阅，
     * A 标签页完成授权后，同时开着的 B 标签页仍显示未连接、也不参与自动同步。
     */
    function handleSettingsChange(change: CloudSettingsChange): void {
        applySettings(change.settings);
        if (!change.fromOtherPage) {
            return;
        }
        trace('cloud-sync', {
            outcome: 'adopted-page-settings',
            loggedIn: !!token.value,
            authChanged: change.authChanged
        });
        if (change.authChanged) {
            error.value = null;
        }
    }

    /**
     * 设置 UI 适配器
     * 应用层通过此方法注入真实的 Toast / Confirm / Prompt 实现；
     * 服务层不碰界面，所以换适配器不需要重建服务。
     */
    function setUIAdapter(adapter: ICloudSyncUIAdapter): void {
        uiAdapter.value = adapter;
    }

    /**
     * 初始化：读回设置、确认保存的凭据还认得，最后跟一句启动同步的结果
     */
    async function init(): Promise<void> {
        isLoading.value = true;
        error.value = null;
        try {
            const startup = await cloudSyncService.init();
            if (startup.rejectedReason) {
                // 服务层已经把这份凭据清掉了；不说一句，用户只会看到「已连接」莫名变回「未连接」
                error.value = startup.rejectedReason;
                uiAdapter.value.showToast(startup.rejectedReason, 'error');
            }
            // 启动那一轮是后台同步：失败了提示一次，不弹窗、不挡任何人。
            if (startup.sync) {
                reportSyncResult(startup.sync, true);
            }
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 保存 OAuth 授权换到的 access_token
     * 验证通过后持久化；即使同步空间没建出来，凭据也已经保存成功。
     */
    async function login(accessToken: string): Promise<boolean> {
        if (!accessToken.trim()) {
            uiAdapter.value.showToast('授权未返回有效凭据，请重试', 'error');
            return false;
        }

        isLoading.value = true;
        error.value = null;
        try {
            uiAdapter.value.showToast('正在验证 GitHub 授权...', 'info');
            const result = await cloudSyncService.saveToken(accessToken);
            reportConnectResult(result);
            return result.success;
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 断开云同步：先问一句，确认了才动配置
     *
     * 「本地数据不会删除」这句要说清楚：断开只是不再跟云端往来，本机的一份原样留着。
     */
    async function logout(): Promise<void> {
        const confirmed = await uiAdapter.value.showConfirm('确定要断开云同步吗？本地数据不会删除。', {
            title: '断开同步',
            okText: '断开',
            isDanger: true
        });
        if (!confirmed) return;

        isLoading.value = true;
        error.value = null;
        try {
            await cloudSyncService.logout();
            uiAdapter.value.showToast('已断开云同步', 'success');
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 清理云端数据：危险且不可撤销，先让用户点头
     *
     * 文案要说清两个后果：云端 Gist 被删、自动同步会被关掉（否则数据立刻又被推回去）。
     */
    async function clearRemoteData(): Promise<ClearRemoteResult> {
        const confirmed = await uiAdapter.value.showConfirm(
            '将删除云端 Gist 中的全部同步数据（含图标、壁纸等资源），本地数据不受影响。' +
            '删除后会自动关闭自动同步，避免数据被立刻重新上传。此操作不可撤销，是否继续？',
            { title: '清理云端数据', okText: '删除云端数据', isDanger: true }
        );
        if (!confirmed) {
            return { success: true, cancelled: true };
        }

        isLoading.value = true;
        error.value = null;
        try {
            const result = await cloudSyncService.clearRemoteData();
            if (!result.success) {
                uiAdapter.value.showToast('清理云端数据失败：' + (result.message ?? '未知错误'), 'error');
            } else if (result.deleted) {
                uiAdapter.value.showToast('云端数据已删除，本地数据保留；自动同步已关闭', 'success');
            } else {
                uiAdapter.value.showToast('云端没有同步数据，已重置本机同步状态', 'success');
            }
            return result;
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 切换自动同步开关。
     */
    async function setAutoSync(enabled: boolean): Promise<void> {
        await cloudSyncService.setAutoSync(enabled);
    }

    /**
     * 上传本地数据到 Gist（全量覆盖云端）。
     */
    async function upload({ silent = false }: { silent?: boolean } = {}): Promise<UploadResult> {
        isLoading.value = true;
        error.value = null;
        try {
            const result = await cloudSyncService.upload();
            if (result.success) {
                if (!silent) {
                    uiAdapter.value.showToast('数据已同步到 GitHub', 'success');
                }
            } else if (result.skipped) {
                if (result.skipped === 'not-authenticated' && !silent) {
                    uiAdapter.value.showToast('请先完成 GitHub 授权', 'error');
                }
            } else {
                // 手动点「上传」就是明确要一个结果，失败必定说
                uiAdapter.value.showToast('同步失败：' + (result.message ?? '未知错误'), 'error');
            }
            return result;
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 双向增量同步：下载云端数据与本地三方合并（冲突本地优先），
     * 按需应用与上传。手动「立即同步」、自动同步与启动拉取均走此入口。
     */
    async function sync(options: { silent?: boolean } = {}): Promise<SyncResult> {
        isLoading.value = true;
        error.value = null;
        try {
            const result = await cloudSyncService.sync(options);
            reportSyncResult(result, options.silent === true);
            return result;
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 同步结果 → 该说的话
     *
     * 手动操作必定给个说法；后台（silent）那一轮同一轮故障只说一次：失败会自动重试，
     * 断网时每次重试都提示就成了刷屏，任一轮成功之后复位，下一次故障仍会说。
     * 没走到云端的那几种（没登录 / 正在进行 / 别的页面刚同步完）不是故障，按原因区别对待。
     */
    function reportSyncResult(result: SyncResult, silent: boolean): void {
        if (result.success) {
            autoSyncFailureReported = false;
            if (silent) return;
            const actions = [
                result.applied ? '已拉取云端更新' : '',
                result.uploaded ? '已上传本地更新' : ''
            ].filter(Boolean);
            uiAdapter.value.showToast(
                actions.length ? `同步完成：${actions.join('，')}` : '同步完成：本地与云端已一致',
                'success'
            );
            return;
        }
        if (result.skipped) {
            // 重试是本层自己排的，用户没登录时手动点同步才需要知道为什么没动
            if (result.skipped === 'not-authenticated' && !silent) {
                uiAdapter.value.showToast('请先完成 GitHub 授权', 'error');
            }
            return;
        }
        if (!silent || !autoSyncFailureReported) {
            autoSyncFailureReported = true;
            uiAdapter.value.showToast('同步失败：' + (result.message ?? '未知错误'), 'error');
        }
    }

    /** 连接账号的结果 → 该说的话 */
    function reportConnectResult(result: ConnectResult): void {
        if (!result.success) {
            uiAdapter.value.showToast(
                result.reason === 'empty'
                    ? '授权未返回有效凭据，请重试'
                    : 'GitHub 授权验证失败：' + (result.message ?? '未知错误'),
                'error'
            );
            return;
        }
        if (result.reason === 'gist-unavailable') {
            // 凭据已经存下，用户至少「连上」了；同步空间稍后重试即可
            uiAdapter.value.showToast(`账号已连接，但同步空间初始化失败：${result.message}`, 'error');
            return;
        }
        uiAdapter.value.showToast('GitHub 账号已连接', 'success');
    }

    /**
     * 从 Gist 下载数据，不自动应用到本地。
     */
    async function download(): Promise<DownloadResult> {
        isLoading.value = true;
        error.value = null;
        try {
            return await cloudSyncService.download();
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 强制恢复：拉取云端数据并覆盖本地（用户主动点击「强制恢复云端」）
     *
     * 覆盖前一定要用户点头——这是兜底手段，日常同步走 sync()；
     * 「云端比本机新」也只跟上次同步时间比，比本机没动过的数据更保守。
     */
    async function pullAndApply({ force = false, silent = false }: { force?: boolean; silent?: boolean } = {}): Promise<PullResult> {
        if (!token.value) {
            if (!silent) uiAdapter.value.showToast('请先完成 GitHub 授权', 'error');
            return { success: false };
        }

        isLoading.value = true;
        error.value = null;
        try {
            const result = await download();
            if (!result.success || !result.data) {
                if (!silent) uiAdapter.value.showToast('拉取失败：' + result.message, 'error');
                return { success: false, message: result.message };
            }

            const bundle = result.data;
            const remoteTime = new Date(bundle.lastModified).toLocaleString();

            if (!force) {
                if (bundle.lastModified <= lastSyncTime.value + PULL_FRESHNESS_BUFFER_MS) {
                    return { success: true, applied: false, message: '本地数据已是最新' };
                }
                const confirmed = await uiAdapter.value.showConfirm(
                    `检测到云端数据更新（云端 ${remoteTime}，本地上次上传 ${localSyncTimeText()}），是否用云端数据覆盖本地？`,
                    { title: '恢复云端数据', okText: '覆盖本地', isDanger: true }
                );
                if (!confirmed) return { success: true, applied: false, message: '用户取消' };
            } else {
                const confirmed = await uiAdapter.value.showConfirm(
                    `将用云端数据覆盖本地（云端更新时间：${remoteTime}），此操作不可撤销，是否继续？`,
                    { title: '强制恢复云端', okText: '覆盖本地', isDanger: true }
                );
                if (!confirmed) return { success: true, applied: false, message: '用户取消' };
            }

            await cloudSyncService.applyDownloadedData(bundle);
            if (!silent) uiAdapter.value.showToast('已从云端恢复数据', 'success');
            return { success: true, applied: true };
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    function localSyncTimeText(): string {
        return lastSyncTime.value ? new Date(lastSyncTime.value).toLocaleString() : '从未上传';
    }

    /** 是否已登录 */
    const isLoggedIn = computed(() => !!token.value);

    /** 是否正在同步（来自 CloudSyncService） */
    const isSyncing = computed(() => cloudSyncService.isSyncing);

    return {
        // State
        token,
        gistId,
        autoSync,
        userInfo,
        lastSyncTime,
        isLoading,
        error,
        // Getters
        isLoggedIn,
        isSyncing,
        // Actions
        init,
        login,
        logout,
        clearRemoteData,
        setAutoSync,
        upload,
        sync,
        download,
        pullAndApply,
        scheduleAutoSync,
        startAutoSyncWatch,
        stopAutoSyncWatch,
        setUIAdapter
    };
});
