/**
 * 云同步 Store：把服务层的结果写回界面
 *
 * 服务层（cloudSync.service.ts 及其下四个模块）只返回结构化结果，本层负责剩下四件事：
 *   - 界面状态镜像：账号六项跟着服务层的设置订阅抄一份，操作态（isLoading/error）自己管；
 *   - 提示口径：弹什么、弹几次（同一轮自动同步的故障只说一次）由 reportSyncResult / reportConnectResult 定；
 *   - 需要用户点头的操作：断开同步、用云端覆盖本地，先确认再交给服务层；
 *   - 自动同步的排程，以及把登录凭据递给浏览器账号同步区（跨设备状态见 crossDeviceAuth store）。
 * 「什么时候再同步一次」本身在 cloudSync/autoSync.ts，怎么合并怎么传输在服务层。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { storageManager } from '@/services/storage.service';
import { trace } from '@/services/diag.service';
import { CloudSyncService, createCloudSyncService } from '@/services/cloudSync.service';
import type { CloudSettingsChange } from '@/services/cloudSync.service';
import { AutoSyncScheduler } from '@/services/cloudSync/autoSync';
import { providerProfile } from '@/services/cloudSync/transport';
import { useCrossDeviceAuthStore } from './crossDeviceAuth.store';
import type { RecoveredAuth } from './crossDeviceAuth.store';
import type { CrossDevicePushOutcome } from './crossDeviceAuth.store';
import type { CrossDeviceAuth } from '@/services/crossDeviceSync.service';
import type { EnableCrossDeviceResult } from '@/services/crossDeviceSync.service';
import { MIN_PASSPHRASE_LENGTH } from '@/utils/crypto.util';
import { createCloudSyncDataManager } from './cloudSyncDataManager';
import type {
    ConnectResult,
    ICloudSyncUIAdapter,
    CloudSyncProviderId,
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

/** 启用浏览器同步的结果：是否已推送、是否顺带还原了其他设备的登录状态 */
export interface EnableCrossDeviceOutcome extends EnableCrossDeviceResult {
    restored: boolean;
}

export const useCloudSyncStore = defineStore('cloudSync', () => {
    const uiAdapter = ref<ICloudSyncUIAdapter>(DEFAULT_UI_ADAPTER);

    /** GitHub Token */
    const token = ref<string | null>(null);
    /** 同步用 Gist ID */
    const gistId = ref<string | null>(null);
    /** 是否开启自动同步 */
    const autoSync = ref(false);
    /** GitHub 用户信息缓存 */
    const userInfo = ref<GitHubUserInfo | null>(null);
    /** 上次同步时间戳 */
    const lastSyncTime = ref(0);
    /** 当前连接的同步平台 */
    const provider = ref<CloudSyncProviderId>('github');
    /** 是否正在执行云同步操作 */
    const isLoading = ref(false);
    /** 最近一次错误信息 */
    const error = ref<string | null>(null);

    /**
     * 浏览器账号同步区（跨设备凭据）：状态与操作都在那个 store，这里只按云同步的流程调用它
     * 必须先于服务实例拿到，否则设置订阅里的「别的页面换了账号」会找不到它。
     */
    const crossDevice = useCrossDeviceAuthStore();

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
     * 界面状态镜像：这六项的真相在服务层的设置模块与账本里，这里只跟着抄一份
     * 唯一的一条同步路径是服务层的订阅，动作函数里不再各自对账。
     */
    function applySettings(settings: CloudSyncSettings): void {
        token.value = settings.token;
        gistId.value = settings.gistId;
        autoSync.value = settings.autoSync;
        userInfo.value = settings.userInfo;
        lastSyncTime.value = settings.lastSyncTime;
        provider.value = settings.provider;
    }

    /**
     * 设置变化 → 刷新界面；来自其他页面时还要顺带清掉旧的错误提示
     *
     * 面板常驻挂载（模态框用 v-show），设置只在启动时读一次；少了这条订阅，
     * A 标签页输入 Token 后，同时开着的 B 标签页仍显示未登录、也不参与自动同步，
     * 看起来就像「Token 没同步过来」。
     */
    function handleSettingsChange(change: CloudSettingsChange): void {
        applySettings(change.settings);
        if (!change.fromOtherPage) {
            return;
        }
        trace('cloud-sync', {
            outcome: 'adopted-page-settings',
            loggedIn: !!token.value,
            provider: provider.value,
            authChanged: change.authChanged
        });
        if (change.authChanged) {
            error.value = null;
            void refreshCrossDevice();
        }
    }

    /** 重新读取浏览器账号同步区的状态 */
    function refreshCrossDevice(): Promise<void> {
        return crossDevice.refresh();
    }

    /** 本机当前的登录凭据，用于交给同步区（未登录时为 null） */
    function currentAuth(): CrossDeviceAuth | null {
        return token.value ? { token: token.value, provider: provider.value } : null;
    }

    /**
     * 启用跨设备同步登录状态（加密）
     *
     * 已登录：立即把当前凭据加密后推送到同步区。
     * 未登录：只记住开关与密码；随后若发现同步区已有其他设备的凭据，
     *        用同一个密码尝试解密并直接登录（新设备「开启」即恢复，不必再点一次「恢复」）。
     */
    async function enableCrossDeviceSync(passphrase: string): Promise<EnableCrossDeviceOutcome> {
        error.value = null;
        try {
            const auth = currentAuth();
            const result = await crossDevice.enable(passphrase, auth);
            if (auth || !crossDevice.remoteAvailable) {
                return { ...result, restored: false };
            }
            return { pushed: result.pushed, restored: await tryRestoreCrossDevice(passphrase) };
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        }
    }

    /** 关闭跨设备同步：清除本机口令与同步区密文 */
    async function disableCrossDeviceSync(): Promise<void> {
        error.value = null;
        try {
            await crossDevice.disable();
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        }
    }

    /**
     * 在新设备上凭口令还原登录状态
     *
     * 还原成功后会立即做一次双向合并同步，把云端数据一并拉下来；
     * 同步失败不影响登录状态（用户可以稍后手动点「立即同步」）。
     * 口令不对时原样抛出——这是用户主动输的口令，要看到原因。
     *
     * @returns 是否还原成功
     */
    async function restoreFromCrossDevice(passphrase: string): Promise<boolean> {
        error.value = null;
        try {
            const auth = await crossDevice.readAuth(passphrase);
            if (!auth) {
                return false;
            }
            return await applyRecoveredAuth(auth);
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        }
    }

    /**
     * 用本机已保存的密码尝试还原同步区里的凭据
     *
     * 这是「另一台设备刚把凭据同步过来」时的自动恢复入口：面板打开、同步区变更、
     * 用户点「重新检查」时都会调用。本机已经登录就不必再动，口令不匹配也只是没有可用凭据，
     * 不是故障——所以这里一律不弹提示，只回答「有没有恢复成功」。
     *
     * @param passphrase 指定密码（刚开启时用）；不传则用本机保存的密码
     */
    async function tryRestoreCrossDevice(passphrase?: string): Promise<boolean> {
        if (token.value) {
            return false;
        }
        const auth = await crossDevice.tryReadAuth(passphrase);
        if (!auth) {
            return false;
        }
        return await applyRecoveredAuth(auth);
    }

    /** 拿到同步区的凭据后：登录，成功再补一轮同步把云端数据拉下来 */
    async function applyRecoveredAuth(auth: RecoveredAuth): Promise<boolean> {
        if (!await login(auth.token, auth.provider)) {
            return false;
        }
        // 登录成功后立刻补齐数据：走 store.sync，失败提示与其他自动同步同一个口径
        await sync({ silent: true });
        return true;
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
     * 初始化：读回设置、确认保存的凭据还认得、必要时从浏览器同步区恢复登录，最后跟一句启动同步的结果
     */
    async function init(): Promise<void> {
        isLoading.value = true;
        error.value = null;
        try {
            const startup = await cloudSyncService.init();
            await refreshCrossDevice();
            if (startup.rejectedReason) {
                // 服务层已经把这份凭据清掉了；不说一句，用户只会看到「已连接」莫名变回「未连接」
                error.value = startup.rejectedReason;
                uiAdapter.value.showToast(startup.rejectedReason, 'error');
            }
            // 本机没有可用凭据（从没登录、或刚被平台拒绝）时，先看浏览器同步区里
            // 另一台设备推来的那份还能不能用——这才是「换设备免 Token」的正路
            const adopted = token.value ? false : await tryRestoreCrossDevice();
            await refreshCrossDevice();
            if (!adopted && token.value && crossDevice.enabled && !crossDevice.remoteAvailable) {
                // 已登录、已开启，同步区里却没有凭据：上一次推送没成，这里补一次。
                // 后台静默补推，成没成由面板那行状态如实显示，不额外弹提示。
                await crossDevice.pushIfMissing(currentAuth());
                await refreshCrossDevice();
            }
            // 启动那一轮是后台同步：失败了提示一次，不弹窗、不挡任何人。
            // 失败是因为本机凭据被拒、而且已经换上同步区里那份可用的了，这句失败就不再重复
            if (startup.sync && !(startup.sync.authRejected && adopted)) {
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
     * 使用 Token 登录
     * 验证通过后持久化，并把凭据推给浏览器同步区。
     *
     * 注意：即使同步空间没建出来，Token 也已经保存成功；
     * 设置模块在写成的那一刻就通知了界面，所以这里不会停在「未连接」，
     * 用户反复点「连接」不像没反应。
     */
    async function login(inputToken: string, providerId?: CloudSyncProviderId): Promise<boolean> {
        if (!inputToken.trim()) {
            uiAdapter.value.showToast('请输入 Token', 'error');
            return false;
        }

        isLoading.value = true;
        error.value = null;
        try {
            uiAdapter.value.showToast('正在验证 Token...', 'info');
            const result = await cloudSyncService.saveToken(inputToken, providerId);
            await pushAuthToCrossDevice();
            await refreshCrossDevice();
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
            await pushAuthToCrossDevice();
            await refreshCrossDevice();
            uiAdapter.value.showToast('已断开云同步', 'success');
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * 把当前登录凭据推送到浏览器账号同步区
     *
     * 没开浏览器同步时什么都不说；已开启却没写成功（本机口令丢了、同步区不可用）必须提示，
     * 否则用户会以为「浏览器同步已经生效」，换设备时才发现根本没有凭据。
     * 断开同步时同样要推一次空的，把同步区里那份旧凭据带走。
     */
    async function pushAuthToCrossDevice(): Promise<void> {
        const outcome = await crossDevice.push(currentAuth());
        if (!outcome.enabled || outcome.pushed || !token.value) {
            return;
        }
        announcePushOutcome(outcome);
    }

    /**
     * 手动「重试写入同步区」
     *
     * 面板上的状态说「没写进去」，用户点一下就要给出结果：成功报成功，
     * 失败按原因说人话——三种原因对应三种自救动作。
     */
    async function retryCrossDevicePush(): Promise<boolean> {
        const outcome = await crossDevice.pushIfMissing(currentAuth());
        await refreshCrossDevice();
        if (outcome.pushed) {
            uiAdapter.value.showToast('登录状态已加密写入浏览器同步区', 'success');
            return true;
        }
        if (!crossDevice.enabled) {
            uiAdapter.value.showToast('浏览器同步未开启', 'info');
            return false;
        }
        announcePushOutcome(outcome);
        return false;
    }

    /** 「已开启却没写进去」的三种原因，各自一句话 */
    function announcePushOutcome(outcome: CrossDevicePushOutcome): void {
        if (outcome.reason === 'error') {
            uiAdapter.value.showToast('浏览器同步失败：' + outcome.message, 'error');
            return;
        }
        uiAdapter.value.showToast(
            outcome.reason === 'missing-passphrase'
                ? '浏览器同步未写入：本机缺少同步密码，请重新设置'
                : '浏览器同步未写入：同步区不可用，请检查浏览器账号同步设置',
            'error'
        );
    }

    /**
     * 导出恢复码
     *
     * 卸载扩展会连同步区一起清掉，恢复码是唯一活得过卸载的那份凭据。
     * 口令默认用本机保存的；本机口令丢了（清过浏览器数据）就得由界面层收一个再传进来。
     */
    async function exportRecoveryCode(passphrase?: string): Promise<string> {
        const auth = currentAuth();
        if (!auth) {
            throw new Error('请先连接 GitHub / Gitee，再导出恢复码');
        }
        const password = passphrase ?? await crossDevice.readStoredPassphrase();
        if (!password) {
            throw new Error(`请输入同步密码（至少 ${MIN_PASSPHRASE_LENGTH} 位）`);
        }
        return crossDevice.createRecovery(password, auth);
    }

    /**
     * 用恢复码恢复登录（重装扩展 / 换浏览器后用）
     *
     * 与同步区恢复同一条收尾：登录成功后补一轮同步，把云端数据一并拉下来。
     * 码或口令不对时原样抛出，用户输的东西要看到原因。
     */
    async function restoreFromRecoveryCode(code: string, passphrase: string): Promise<boolean> {
        error.value = null;
        try {
            const auth = await crossDevice.restoreWithRecovery(code, passphrase);
            if (!auth) {
                return false;
            }
            return await applyRecoveredAuth(auth);
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
            throw e;
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
                    uiAdapter.value.showToast(`数据已同步到 ${providerProfile(provider.value).name}`, 'success');
                }
            } else if (result.skipped) {
                if (result.skipped === 'not-authenticated' && !silent) {
                    uiAdapter.value.showToast('请先配置 Token', 'error');
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
            if (result.authRejected) {
                // 被拒的只是本机这一份 Token：另一台设备多半早就换掉了，
                // 同步区里那份才是在用的凭据。跟上它，不用等用户重启浏览器。
                await tryRestoreCrossDevice();
                await refreshCrossDevice();
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
                uiAdapter.value.showToast('请先配置 Token', 'error');
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
                result.reason === 'empty' ? '请输入 Token' : 'Token 验证失败：' + (result.message ?? '未知错误'),
                'error'
            );
            return;
        }
        if (result.reason === 'gist-unavailable') {
            // Token 已经存下，用户至少「连上」了；同步空间稍后重试即可
            uiAdapter.value.showToast(`账号已连接，但同步空间初始化失败：${result.message}`, 'error');
            return;
        }
        uiAdapter.value.showToast(`${providerProfile(provider.value).name} 账号已连接`, 'success');
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
            if (!silent) uiAdapter.value.showToast('请先配置 Token', 'error');
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

    /**
     * 显示 Token 输入对话框并尝试登录。
     */
    async function showLoginDialog(): Promise<void> {
        const profile = providerProfile(provider.value);
        const inputToken = await uiAdapter.value.showPrompt(
            `请输入 ${profile.name} Token（${profile.tokenHint}）`,
            {
                title: `连接 ${profile.name}`,
                confirmText: '连接',
                cancelText: '取消',
                inputPlaceholder: profile.tokenPlaceholder,
                inputType: 'password'
            }
        );
        if (inputToken) {
            await login(inputToken);
        }
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
        provider,
        isLoading,
        error,
        // Getters
        isLoggedIn,
        isSyncing,
        // Actions
        init,
        login,
        logout,
        setAutoSync,
        upload,
        sync,
        download,
        pullAndApply,
        showLoginDialog,
        scheduleAutoSync,
        startAutoSyncWatch,
        stopAutoSyncWatch,
        setUIAdapter,
        refreshCrossDevice,
        enableCrossDeviceSync,
        disableCrossDeviceSync,
        restoreFromCrossDevice,
        tryRestoreCrossDevice,
        retryCrossDevicePush,
        exportRecoveryCode,
        restoreFromRecoveryCode
    };
});
