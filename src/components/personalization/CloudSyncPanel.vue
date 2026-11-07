<script setup lang="ts">
/**
 * CloudSyncPanel - 云同步状态面板
 *
 * 两条互补的同步路径：
 *   1. 云同步：用 GitHub / Gitee 的 Token 读写 Gist（数据本体）；
 *   2. 浏览器同步：把 Token 加密后写进浏览器账号同步区（storage.sync），
 *      让同一浏览器账号的其他设备免 Token 登录，再自动拉取 Gist 数据。
 *
 * 浏览器同步区块在未登录 / 已登录两种状态下都常驻显示：
 * 未登录时可以先设密码（登录后自动补推凭据），也可以凭密码恢复其他设备的登录状态。
 * 提示使用 useToast，确认/输入框使用 useConfirm（依赖 App.vue 挂载的 MntConfirmHost）。
 */
import { computed, ref } from 'vue';
import { useCloudSync } from '@/composables/useCloudSync';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import type { PromptOptions } from '@/composables/useConfirm';
import { MIN_PASSPHRASE_LENGTH } from '@/utils/crypto.util';
import { getExtensionId } from '@/services/crossDeviceSync.service';
import IconSvg from '@/components/icon/IconSvg.vue';
import BaseInput from '@/components/common/BaseInput.vue';
import BaseButton from '@/components/common/BaseButton.vue';

export interface CloudSyncPanelProps {
    /** 面板标题 */
    title?: string;
}

const props = withDefaults(defineProps<CloudSyncPanelProps>(), {
    title: '云同步'
});

const title = computed(() => props.title);

const emit = defineEmits<{
    (e: 'login', success: boolean): void;
    (e: 'logout'): void;
    (e: 'upload', result: { success: boolean; message?: string }): void;
    (e: 'pull', result: { success: boolean; applied?: boolean; message?: string }): void;
    (e: 'error', message: string): void;
}>();

const toast = useToast();
const confirmDialog = useConfirm();

const {
    isLoggedIn,
    userInfo,
    statusText,
    formattedLastSyncTime,
    autoSync,
    isLoading,
    error,
    crossDeviceEnabled,
    crossDeviceHasPassphrase,
    crossDeviceRemoteAvailable,
    crossDeviceRemoteMeta,
    syncAreaNative,
    syncAreaCrossDevice,
    login,
    logout,
    sync,
    pullAndApply,
    setAutoSync,
    enableCrossDeviceSync,
    disableCrossDeviceSync,
    restoreFromCrossDevice,
    refreshCrossDevice,
    tryRestoreCrossDevice,
    retryCrossDevicePush,
    crossDeviceRemoteProbe,
    probeCrossDeviceSyncArea,
    exportRecoveryCode,
    restoreFromRecoveryCode
} = useCloudSync({
    uiAdapter: {
        showToast: (message, type = 'info') => {
            toast.show(message, { type });
        },
        showConfirm: (message, options) => confirmDialog.confirm(message, options),
        showPrompt: (message, options) => confirmDialog.prompt(message, options as PromptOptions | undefined)
    }
});

/** 浏览器同步：密码输入值（开启 / 更新 / 恢复共用） */
const browserPassphrase = ref('');
/** 浏览器同步：正在执行开启 / 关闭 / 恢复 */
const browserBusy = ref(false);
/** 浏览器同步：用户是否点了「开启浏览器同步」（展开密码输入） */
const browserExpanded = ref(false);
/** 浏览器同步：用户放弃恢复旧凭据，直接在本机开启 */
const browserSkipRestore = ref(false);

/** 恢复码：生成后显示在只读框里，由用户自己复制保存 */
const recoveryCode = ref('');
/** 恢复码：导出区块是否展开 */
const recoveryExpanded = ref(false);
/** 恢复码：用码恢复时粘进来的内容 */
const recoveryInput = ref('');
/** 恢复码：用码恢复的区块是否展开 */
const recoveryRestoreExpanded = ref(false);

const tokenInput = ref('');

type ProviderId = 'github' | 'gitee';

const PROVIDER_OPTIONS: Array<{ id: ProviderId; name: string; placeholder: string; hint: string }> = [
    {
        id: 'github',
        name: 'GitHub',
        placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
        hint: '在 github.com/settings/tokens 创建 Token（需要 gist 权限）'
    },
    {
        id: 'gitee',
        name: 'Gitee',
        placeholder: 'xxxxxxxxxxxxxxxx',
        hint: '在 gitee.com/profile/personal_access_tokens 创建私人令牌（勾选 gists 权限）'
    }
];

const selectedProvider = ref<ProviderId>('github');

const currentProviderOption = computed(() => PROVIDER_OPTIONS.find((option) => option.id === selectedProvider.value) ?? PROVIDER_OPTIONS[0]);

const CLOUD_PATH = 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z';

/** 挂锁图标（浏览器同步） */
const LOCK_PATHS = [
    'M7 11V7a5 5 0 0 1 10 0v4',
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z'
];

/**
 * 浏览器同步的界面状态
 * - off：未开启，只显示开关
 * - setup：已展开开关，等待输入密码开启
 * - restore：同步区已有其他设备的密文，优先提示恢复登录
 * - enabled：已开启且本机有密码
 * - missing-passphrase：已开启但本机密码丢失（清理过浏览器数据）
 */
type BrowserMode = 'off' | 'setup' | 'restore' | 'enabled' | 'missing-passphrase';

const browserMode = computed<BrowserMode>(() => {
    // 未登录 + 同步区已有凭据 → 优先引导恢复（即使本机开关是「已开启」，
    // 也可能是密码对不上，需要用户重新输入）
    if (!isLoggedIn.value && crossDeviceRemoteAvailable.value && !browserSkipRestore.value) {
        return 'restore';
    }
    if (crossDeviceEnabled.value) {
        return crossDeviceHasPassphrase.value ? 'enabled' : 'missing-passphrase';
    }
    return browserExpanded.value ? 'setup' : 'off';
});

/** 是否 Firefox：storage.sync 的同步节奏与开关位置和其他浏览器不同，提示文案要分开 */
const isFirefox = computed(
    () => typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent)
);

/** 当前扩展 ID，直接印在诊断行里供两台设备比对（隔离原因见 getExtensionId） */
const extensionId = computed(() => getExtensionId());

/** 同步区凭据的来源描述 */
const remoteMetaText = computed(() => {
    const meta = crossDeviceRemoteMeta.value;
    if (!meta) return '有（来源未知）';
    return `有（${meta.device}，${formatCompactTime(meta.updatedAt)}）`;
});

/** 紧凑时间：10-22 15:29（面板宽度有限，不显示年份与秒） */
function formatCompactTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const browserNeedsPassphrase = computed(
    () => browserMode.value !== 'off' && (browserMode.value !== 'enabled' || browserExpanded.value)
);

const browserActionLabel = computed(() => {
    switch (browserMode.value) {
        case 'restore':
            return '恢复登录状态';
        case 'missing-passphrase':
            return '重新设置同步密码';
        case 'enabled':
            return '更新同步密码';
        default:
            return '开启并加密同步';
    }
});

const browserHint = computed(() => {
    switch (browserMode.value) {
        case 'restore':
            return '输入在原设备设置的同步密码，即可免 Token 恢复登录；密码只在本机校验，不会上传。';
        case 'missing-passphrase':
            return '本机缺少同步密码（可能清理过浏览器数据）。重新设置会用新密码覆盖同步区里的旧密文。';
        case 'enabled':
            return '更新密码会用新密码重新加密并覆盖同步区里的旧密文，其他设备需要用新密码恢复。';
        default:
            return `同步密码只保存在本机、不会上传。换设备时输入同一密码即可还原登录状态（至少 ${MIN_PASSPHRASE_LENGTH} 位）。`;
    }
});

/**
 * 已开启、已登录，但同步区里还没有凭据
 *
 * 这一行以前只看「开没开」就宣称「已加密写入」，写失败时界面与下面的「凭据：暂无」
 * 自相矛盾，用户要到换设备那天才发现根本没同步上。状态改成照着实说，并给出重试入口。
 */
const browserPushMissing = computed(() =>
    browserMode.value === 'enabled'
    && isLoggedIn.value
    && syncAreaNative.value
    && syncAreaCrossDevice.value
    && !crossDeviceRemoteAvailable.value
);

const browserStatusText = computed(() => {
    if (browserMode.value === 'enabled') {
        if (!isLoggedIn.value) {
            return '已开启 · 登录后会把登录状态加密写入同步区';
        }
        if (!syncAreaNative.value) {
            // 网页预览环境写的是本机模拟同步区：凭据确实在，但它出不了这台机器
            return crossDeviceRemoteAvailable.value
                ? '已开启 · 凭据在本机模拟同步区（预览环境不会同步到其他设备）'
                : '已开启 · 当前环境无法写入浏览器同步区';
        }
        if (!syncAreaCrossDevice.value) {
            // 原生同步区在，但开发版安装的扩展不参与 Chrome 的扩展存储同步
            return crossDeviceRemoteAvailable.value
                ? '已开启 · 凭据只留在本机的浏览器同步区（当前安装方式不会同步到其他设备）'
                : '已开启 · 但本机同步区还没有凭据，上一次写入没成功';
        }
        if (!crossDeviceRemoteAvailable.value) {
            return '已开启 · 但同步区还没有凭据，上一次写入没成功';
        }
        return '已开启 · 登录状态已加密写入浏览器同步区';
    }
    if (browserMode.value === 'missing-passphrase') {
        return '已开启，但本机缺少同步密码';
    }
    if (browserMode.value === 'restore') {
        return '检测到其他设备的登录状态';
    }
    return '未开启';
});

async function handleLogin(): Promise<void> {
    const token = tokenInput.value.trim();
    if (!token) {
        toast.show('请输入 Token', { type: 'error' });
        return;
    }

    try {
        const success = await login(token, selectedProvider.value);
        emit('login', success);
        if (success) {
            tokenInput.value = '';
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    }
}

async function handleLogout(): Promise<void> {
    try {
        await logout();
        emit('logout');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    }
}

async function handleSync(): Promise<void> {
    try {
        const result = await sync();
        emit('upload', { success: result.success, message: result.message });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    }
}

async function handlePull(): Promise<void> {
    try {
        const result = await pullAndApply({ force: true });
        emit('pull', {
            success: result.success,
            applied: result.applied,
            message: result.message
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    }
}

async function handleAutoSyncChange(event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    try {
        await setAutoSync(checked);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    }
}

/** 勾选「开启浏览器同步」：展开密码输入 */
function handleBrowserToggle(event: Event): void {
    browserExpanded.value = (event.target as HTMLInputElement).checked;
    if (!browserExpanded.value) {
        browserPassphrase.value = '';
    }
}

/** 开启 / 更新浏览器同步 */
async function handleEnableBrowserSync(): Promise<void> {
    const passphrase = browserPassphrase.value;
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        toast.show(`同步密码至少 ${MIN_PASSPHRASE_LENGTH} 位`, { type: 'error' });
        return;
    }

    browserBusy.value = true;
    try {
        // enableCrossDeviceSync 内部会先重读一次同步区再决定走不走恢复，
        // 这里不能拿面板打开时那份「暂无」的旧镜像下结论。
        const { pushed, restored } = await enableCrossDeviceSync(passphrase);
        browserPassphrase.value = '';
        browserExpanded.value = false;

        if (restored) {
            toast.show('已开启浏览器同步，并从同步区恢复了其他设备的登录状态', { type: 'success' });
        } else if (pushed) {
            toast.show('已开启浏览器同步，登录状态已加密写入同步区', { type: 'success' });
        } else if (isLoggedIn.value) {
            toast.show('已开启浏览器同步，但本次未能写入同步区，请检查浏览器账号同步设置', { type: 'error' });
        } else if (crossDeviceRemoteAvailable.value) {
            toast.show('已开启，但同步区里的密码对不上，请用原设备的同步密码恢复', { type: 'error' });
        } else {
            // 以前这里报的是绿色「已开启」：密码是记下了，可同步区里没有任何凭据，
            // 想拿另一台的 Token 的人等到重装那天也不会等到。成功提示不能给一个没发生的结果。
            toast.show(
                isFirefox.value
                    ? '同步密码已记下，但浏览器同步区里没有任何凭据：等另一台设备送 Token 过来的话，请在那台点「同步区自检」，再回这里点「重新检查」；Firefox 还要在「设置 → 同步」勾选「附加组件」。若这台就是主力机，登录后会自动把凭据加密写进去。'
                    : '同步密码已记下，但浏览器同步区里没有任何凭据：等另一台设备送 Token 过来的话，请在那台点「同步区自检」，再回这里点「重新检查」；若这台就是主力机，登录后会自动把凭据加密写进去。',
                { type: 'warning' }
            );
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

/** 同步区空着的时候，用自检结果说清是「没推上来」还是「传不过来」 */
function emptySyncAreaMessage(): string {
    const probe = crossDeviceRemoteProbe.value;
    if (probe) {
        return `同步区是通的（收到 ${probe.device} 于 ${formatCompactTime(probe.updatedAt)} 发出的自检），但里面没有凭据：那台设备没把 Token 推上来，请到那台点「重试写入同步区」`;
    }
    if (syncAreaNative.value && !syncAreaCrossDevice.value) {
        return '当前是开发版安装：Chrome 不会上传这种安装方式的扩展同步区，另一台设备永远收不到这里的凭据。换设备请用恢复码，或直接粘贴 Token';
    }
    return isFirefox.value
        ? '同步区既没有凭据，也没收到另一台的自检：这条路还没通。Firefox 需在「设置 → 同步」勾选「附加组件」，并每 10 分钟或点「立即同步」；两台装的还必须是同一个扩展 ID'
        : '同步区既没有凭据，也没收到另一台的自检：请确认两台登录的是同一个浏览器账号、在同步设置里勾选了「扩展」，且扩展 ID 一致';
}

/** 重新读取同步区状态，并尝试用本机密码免 Token 还原 */
async function handleRefreshSyncArea(): Promise<void> {
    browserBusy.value = true;
    try {
        await refreshCrossDevice();
        const restored = await tryRestoreCrossDevice();
        if (restored) {
            toast.show('已从同步区恢复登录状态', { type: 'success' });
        } else if (!crossDeviceRemoteAvailable.value) {
            toast.show(emptySyncAreaMessage(), { type: 'info' });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    } finally {
        browserBusy.value = false;
    }
}

/**
 * 往同步区发一次自检
 *
 * 自检写的是与口令无关的明文随机值，另一台不需要密码、不需要登录就能读到。
 * 于是「凭据：暂无」终于有了第二种读法：读得到自检 = 路通、凭据没推上来；
 * 读不到 = 路本来就不通，跟 Token 无关。
 */
async function handleProbeSyncArea(): Promise<void> {
    browserBusy.value = true;
    try {
        const probe = await probeCrossDeviceSyncArea();
        toast.show(
            `已向浏览器同步区发出自检（编号 ${probe.nonce.slice(0, 8)}），请到另一台设备点「重新检查」`,
            { type: 'success' }
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

/** 凭密码恢复其他设备的登录状态 */
async function handleRestoreBrowserAuth(): Promise<void> {
    const passphrase = browserPassphrase.value;
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        toast.show(`同步密码至少 ${MIN_PASSPHRASE_LENGTH} 位`, { type: 'error' });
        return;
    }

    browserBusy.value = true;
    try {
        const success = await restoreFromCrossDevice(passphrase);
        if (success) {
            browserPassphrase.value = '';
            browserExpanded.value = false;
            toast.show('已从其他设备恢复登录状态，正在同步数据', { type: 'success' });
        } else {
            toast.show('同步区没有可用的登录凭据', { type: 'error' });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

/** 关闭浏览器同步（清除本机密码与同步区密文） */
async function handleDisableBrowserSync(): Promise<void> {
    const confirmed = await confirmDialog.confirm(
        '关闭后将从浏览器同步区清除已加密的登录凭据，其他设备需要重新输入 Token。',
        { title: '关闭浏览器同步', okText: '关闭', isDanger: true }
    );
    if (!confirmed) {
        browserExpanded.value = false;
        return;
    }

    browserBusy.value = true;
    try {
        await disableCrossDeviceSync();
        browserExpanded.value = false;
        browserPassphrase.value = '';
        toast.show('已关闭浏览器同步', { type: 'info' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

/** 密码框回车：按当前状态执行开启 / 更新 / 恢复 */
function handleBrowserSubmit(): void {
    if (browserMode.value === 'restore') {
        void handleRestoreBrowserAuth();
        return;
    }
    void handleEnableBrowserSync();
}

/** 放弃用旧密码恢复，直接在本机开启新的浏览器同步 */
function handleSkipRestore(): void {
    browserSkipRestore.value = true;
    browserExpanded.value = true;
    browserPassphrase.value = '';
}

/** 手动把当前凭据补写进同步区 */
async function handleRetryPush(): Promise<void> {
    browserBusy.value = true;
    try {
        await retryCrossDevicePush();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
    } finally {
        browserBusy.value = false;
    }
}

/** 展开恢复码区块；第一次展开时生成一份 */
async function toggleRecovery(): Promise<void> {
    recoveryExpanded.value = !recoveryExpanded.value;
    if (!recoveryExpanded.value || recoveryCode.value) {
        return;
    }
    browserBusy.value = true;
    try {
        recoveryCode.value = await exportRecoveryCode();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recoveryExpanded.value = false;
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

async function handleCopyRecovery(): Promise<void> {
    try {
        await navigator.clipboard.writeText(recoveryCode.value);
        toast.show('恢复码已复制，请存到你自己的密码管理器或备忘录', { type: 'success' });
    } catch {
        toast.show('浏览器拒绝了剪贴板，请手动全选复制', { type: 'info' });
    }
}

/** 本机口令丢了（重装 / 清过数据）时，用恢复码 + 口令重新拿到凭据 */
async function handleRestoreWithRecovery(): Promise<void> {
    const passphrase = browserPassphrase.value;
    if (!recoveryInput.value.trim()) {
        toast.show('请整段粘贴恢复码', { type: 'error' });
        return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        toast.show(`同步密码至少 ${MIN_PASSPHRASE_LENGTH} 位`, { type: 'error' });
        return;
    }

    browserBusy.value = true;
    try {
        const success = await restoreFromRecoveryCode(recoveryInput.value, passphrase);
        if (success) {
            recoveryInput.value = '';
            browserPassphrase.value = '';
            recoveryRestoreExpanded.value = false;
            toast.show('已用恢复码恢复登录状态，正在同步数据', { type: 'success' });
        } else {
            toast.show('恢复码里没有可用的登录凭据', { type: 'error' });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit('error', message);
        toast.show(message, { type: 'error' });
    } finally {
        browserBusy.value = false;
    }
}

const statusClass = computed(() => {
    if (isLoading.value) {
        return 'is-loading';
    }
    return isLoggedIn.value ? 'is-connected' : 'is-disconnected';
});
</script>

<template>
    <section class="cloud-sync-panel" aria-label="云同步">
        <header class="cloud-sync-panel__header">
            <IconSvg :path="CLOUD_PATH" size="var(--icon-sm)" color="var(--accent)" />
            <h3 class="cloud-sync-panel__title">{{ title }}</h3>
        </header>

        <div v-if="error" class="cloud-sync-panel__error" role="alert">
            {{ error }}
        </div>

        <div class="cloud-sync-panel__status" :class="statusClass">
            {{ statusText }}
        </div>

        <div v-if="!isLoggedIn" class="cloud-sync-panel__guest">
            <p class="cloud-sync-panel__hint">
                使用 GitHub / Gitee 代码片段（Gist）备份和同步你的站点数据
            </p>

            <div class="cloud-sync-provider" role="tablist" aria-label="同步平台">
                <button
                    v-for="option in PROVIDER_OPTIONS"
                    :key="option.id"
                    type="button"
                    role="tab"
                    class="cloud-sync-provider__btn"
                    :class="{ 'is-active': selectedProvider === option.id }"
                    :aria-selected="selectedProvider === option.id"
                    :disabled="isLoading"
                    @click="selectedProvider = option.id"
                >
                    {{ option.name }}
                </button>
            </div>

            <BaseInput
                v-model="tokenInput"
                type="password"
                :label="`${currentProviderOption.name} Token`"
                :placeholder="currentProviderOption.placeholder"
                autocomplete="off"
                :disabled="isLoading"
                @enter="handleLogin"
            />

            <p class="cloud-sync-panel__hint">{{ currentProviderOption.hint }}</p>

            <BaseButton
                variant="primary"
                size="small"
                block
                :loading="isLoading"
                @click="handleLogin"
            >
                <template #icon>
                    <IconSvg name="link" size="var(--icon-xs)" />
                </template>
                连接 {{ currentProviderOption.name }}
            </BaseButton>
        </div>

        <div v-else class="cloud-sync-panel__logged">
            <div v-if="userInfo" class="cloud-sync-user">
                <img
                    :src="userInfo.avatar"
                    alt=""
                    class="cloud-sync-user__avatar"
                    loading="lazy"
                />
                <div class="cloud-sync-user__info">
                    <div class="cloud-sync-user__name">{{ userInfo.login }}</div>
                    <div class="cloud-sync-user__time">
                        上次同步：{{ formattedLastSyncTime }}
                    </div>
                </div>
            </div>

            <label class="cloud-sync-toggle">
                <input
                    type="checkbox"
                    :checked="autoSync"
                    :disabled="isLoading"
                    @change="handleAutoSyncChange"
                >
                <span>自动同步</span>
            </label>

            <div class="cloud-sync-actions">
                <BaseButton
                    variant="primary"
                    size="small"
                    :loading="isLoading"
                    @click="handleSync"
                >
                    <template #icon>
                        <IconSvg name="upload" size="var(--icon-xs)" />
                    </template>
                    立即同步
                </BaseButton>

                <BaseButton
                    variant="outlined"
                    size="small"
                    :loading="isLoading"
                    @click="handlePull"
                >
                    <template #icon>
                        <IconSvg name="download" size="var(--icon-xs)" />
                    </template>
                    强制恢复云端
                </BaseButton>
            </div>

            <BaseButton
                variant="text"
                size="small"
                class="cloud-sync-logout"
                :loading="isLoading"
                @click="handleLogout"
            >
                <template #icon>
                    <IconSvg name="logout" size="var(--icon-xs)" />
                </template>
                断开连接
            </BaseButton>
        </div>

        <!-- ============ 浏览器同步（始终可见） ============ -->
        <div
            class="cloud-sync-cross"
            :class="{
                'is-restore': browserMode === 'restore',
                'is-on': browserMode === 'enabled',
                'is-unavailable': !syncAreaNative
            }"
        >
            <div class="cloud-sync-cross__head">
                <IconSvg :paths="LOCK_PATHS" size="var(--icon-xs)" color="var(--accent)" />
                <span class="cloud-sync-cross__name">浏览器同步</span>
                <span v-if="browserMode === 'enabled'" class="cloud-sync-cross__badge">已开启</span>
            </div>

            <p v-if="browserMode !== 'off' && browserMode !== 'setup'" class="cloud-sync-cross__status">
                {{ browserStatusText }}
            </p>

            <p v-if="browserMode === 'off' || browserMode === 'setup'" class="cloud-sync-panel__hint">
                登录同一浏览器账号的其他设备，输入同步密码即可免 Token 登录。同步区只保存 AES-GCM 密文。
            </p>

            <p v-if="!syncAreaNative" class="cloud-sync-cross__warn">
                当前为网页预览环境，无法写入浏览器账号同步区，该功能仅在扩展中生效。
            </p>
            <p v-if="syncAreaNative && !syncAreaCrossDevice" class="cloud-sync-cross__warn">
                当前扩展是以「加载已解压的扩展程序」安装的：Chrome 不会上传这种安装方式的扩展同步区，
                同一账号、同一扩展 ID 也不会把这里的凭据送到其他设备。换设备请用下方的「导出恢复码」，
                或直接粘贴 Token；从扩展商店安装后这项才真正跨设备。
            </p>

            <label v-if="browserMode === 'off' || browserMode === 'setup'" class="cloud-sync-toggle">
                <input
                    type="checkbox"
                    :checked="browserMode === 'setup'"
                    :disabled="isLoading || browserBusy"
                    @change="handleBrowserToggle"
                >
                <span>开启浏览器同步</span>
            </label>

            <template v-if="browserNeedsPassphrase">
                <p class="cloud-sync-panel__hint">{{ browserHint }}</p>
                <BaseInput
                    v-model="browserPassphrase"
                    type="password"
                    label="同步密码"
                    :placeholder="`至少 ${MIN_PASSPHRASE_LENGTH} 位`"
                    autocomplete="off"
                    :disabled="browserBusy"
                    @enter="handleBrowserSubmit"
                />
                <BaseButton
                    :variant="browserMode === 'restore' ? 'primary' : 'outlined'"
                    size="small"
                    block
                    :loading="browserBusy"
                    @click="handleBrowserSubmit"
                >
                    <template #icon>
                        <IconSvg :paths="LOCK_PATHS" size="var(--icon-xs)" />
                    </template>
                    {{ browserActionLabel }}
                </BaseButton>
            </template>

            <BaseButton
                v-if="browserMode === 'restore'"
                variant="text"
                size="small"
                class="cloud-sync-cross__skip"
                @click="handleSkipRestore"
            >
                没有旧密码？直接开启新的浏览器同步
            </BaseButton>

            <div v-if="browserMode === 'enabled'" class="cloud-sync-cross__actions">
                <BaseButton
                    variant="text"
                    size="small"
                    :disabled="browserBusy"
                    @click="browserExpanded = !browserExpanded"
                >
                    {{ browserExpanded ? '收起' : '更新密码' }}
                </BaseButton>
                <BaseButton
                    v-if="browserPushMissing"
                    variant="text"
                    size="small"
                    :disabled="browserBusy"
                    @click="handleRetryPush"
                >
                    重试写入同步区
                </BaseButton>
                <BaseButton
                    variant="text"
                    size="small"
                    :disabled="browserBusy"
                    @click="toggleRecovery"
                >
                    {{ recoveryExpanded ? '收起恢复码' : '导出恢复码' }}
                </BaseButton>
                <BaseButton
                    variant="text"
                    size="small"
                    :disabled="browserBusy"
                    @click="handleDisableBrowserSync"
                >
                    关闭浏览器同步
                </BaseButton>
            </div>

            <div v-if="!isLoggedIn && !recoveryRestoreExpanded" class="cloud-sync-cross__actions">
                <BaseButton
                    variant="text"
                    size="small"
                    :disabled="browserBusy"
                    @click="recoveryRestoreExpanded = true"
                >
                    用恢复码恢复登录
                </BaseButton>
            </div>

            <!-- 恢复码：唯一活得过「卸载扩展」的凭据副本，交给用户自己存 -->
            <div v-if="recoveryExpanded" class="cloud-sync-cross__recovery">
                <p class="cloud-sync-panel__hint">
                    卸载扩展时，浏览器会把扩展的本地存储和同步区一起清掉，重装后同步区就是空的。
                    恢复码是加密后的登录凭据，只有配上同步密码才解得开——请整段存到你自己的密码管理器或备忘录。
                </p>
                <textarea
                    class="cloud-sync-cross__code"
                    rows="3"
                    readonly
                    :value="recoveryCode"
                    aria-label="恢复码"
                    @focus="($event.target as HTMLTextAreaElement).select()"
                ></textarea>
                <div class="cloud-sync-cross__actions">
                    <BaseButton variant="text" size="small" @click="handleCopyRecovery">复制</BaseButton>
                </div>
            </div>

            <div v-if="recoveryRestoreExpanded" class="cloud-sync-cross__recovery">
                <p class="cloud-sync-panel__hint">
                    粘贴当初保存的恢复码，再输入对应的同步密码，即可免 Token 恢复登录。
                </p>
                <textarea
                    v-model="recoveryInput"
                    class="cloud-sync-cross__code"
                    rows="3"
                    placeholder="粘贴恢复码（HANTAB1. 开头）"
                    aria-label="恢复码"
                    :disabled="browserBusy"
                ></textarea>
                <BaseInput
                    v-model="browserPassphrase"
                    type="password"
                    label="同步密码"
                    :placeholder="`至少 ${MIN_PASSPHRASE_LENGTH} 位`"
                    autocomplete="off"
                    :disabled="browserBusy"
                    @enter="handleRestoreWithRecovery"
                />
                <div class="cloud-sync-cross__actions">
                    <BaseButton
                        variant="primary"
                        size="small"
                        :loading="browserBusy"
                        @click="handleRestoreWithRecovery"
                    >
                        恢复登录
                    </BaseButton>
                    <BaseButton
                        variant="text"
                        size="small"
                        :disabled="browserBusy"
                        @click="recoveryRestoreExpanded = false"
                    >
                        取消
                    </BaseButton>
                </div>
            </div>

            <!-- 同步区诊断：让「到底同步到了没」可见，而不是靠猜 -->
            <div class="cloud-sync-cross__diag">
                <span>同步区：{{ syncAreaNative ? (syncAreaCrossDevice ? '浏览器账号' : '本机（开发版安装）') : '本机模拟' }}</span>
                <span>凭据：{{ crossDeviceRemoteAvailable ? remoteMetaText : '暂无' }}</span>
                <!-- 扩展 ID 直接印出来：同步区按它隔离，两台不一致就永远看不到对方，
                     这一点原来藏在鼠标悬停里，谁也不会去悬停。 -->
                <span
                    v-if="extensionId"
                    class="cloud-sync-cross__id"
                    :title="extensionId"
                >
                    扩展 ID：{{ extensionId }}
                </span>
                <span v-if="crossDeviceRemoteProbe">
                    自检：收到（{{ crossDeviceRemoteProbe.device }}，{{ formatCompactTime(crossDeviceRemoteProbe.updatedAt) }}）
                </span>
                <button
                    type="button"
                    class="cloud-sync-cross__refresh"
                    :disabled="browserBusy"
                    @click="handleRefreshSyncArea"
                >
                    重新检查
                </button>
                <button
                    v-if="syncAreaNative"
                    type="button"
                    class="cloud-sync-cross__refresh"
                    :disabled="browserBusy"
                    @click="handleProbeSyncArea"
                >
                    同步区自检
                </button>
            </div>

            <p
                v-if="syncAreaNative && syncAreaCrossDevice && !crossDeviceRemoteAvailable && !isLoggedIn"
                class="cloud-sync-cross__warn"
            >
                <template v-if="isFirefox">
                    Firefox 需在「设置 → 同步」勾选「附加组件」，且每 10 分钟或点「立即同步」才会把同步区数据传到另一台设备；到达后本页会自动识别，无需重开。
                </template>
                <template v-else>
                    两台设备需登录同一个浏览器账号，并在同步设置里勾选「扩展」，数据才会在同步区之间流转。
                </template>
            </p>
        </div>
    </section>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.cloud-sync-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);

    &__header {
        display: flex;
        align-items: center;
        gap: var(--space-2);
    }

    &__title {
        @include section-label(var(--accent));
    }

    &__error {
        font-size: var(--text-xs);
        color: var(--color-error);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--tint-error);
    }

    &__status {
        font-size: var(--text-sm);
        color: var(--label-secondary);

        &.is-connected {
            color: var(--color-success);
        }

        &.is-loading {
            color: var(--accent);
        }
    }

    &__guest {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
    }

    &__hint {
        font-size: var(--text-xs);
        color: var(--label-secondary);
        line-height: var(--leading-normal);
        margin: 0;
    }

    &__logged {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
    }
}

.cloud-sync-user {
    display: flex;
    align-items: center;
    gap: var(--space-2);

    &__avatar {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
        object-fit: cover;
        background: var(--fill);
        flex-shrink: 0;
    }

    &__info {
        flex: 1;
        min-width: 0;
    }

    &__name {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--label);
        @include text-ellipsis;
    }

    &__time {
        font-size: var(--text-xs);
        color: var(--label-secondary);
    }
}

.cloud-sync-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--label);
    cursor: pointer;

    input {
        @include apple-checkbox;
    }
}

.cloud-sync-cross {
    @include card;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);

    &.is-restore,
    &.is-on {
        border-color: var(--accent);
    }

    &.is-unavailable {
        border-style: dashed;
        opacity: 0.9;
    }

    &__head {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--label);
    }

    &__name {
        flex: 1;
        min-width: 0;
    }

    &__badge {
        flex-shrink: 0;
        padding: 0 var(--space-2);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--weight-semibold);
        line-height: var(--leading-tight);
        color: var(--label-secondary);
        background: var(--fill);
    }

    // 「已开启」用 tint 底 + 主色字，不用主色实底 + 白字：
    // 深色主题的 primary 是提亮过的，白字压上去读不出。
    &.is-on &__badge {
        color: var(--accent);
        background: var(--tint-primary-strong);
    }

    &__status {
        margin: 0;
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        color: var(--label-secondary);
    }

    &.is-on &__status {
        color: var(--color-success);
    }

    &__warn {
        margin: 0;
        font-size: var(--text-xs);
        line-height: var(--leading-normal);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm);
        color: var(--on-warning);
        background: var(--tint-warning);
    }

    &__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);

        > * {
            flex: 1;
        }
    }

    &__skip {
        align-self: flex-start;
    }

    &__diag {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
        padding-top: var(--space-2);
        border-top: 1px dashed var(--separator);
        font-size: var(--text-xs);
        color: var(--label-secondary);
        opacity: 0.9;
    }

    // 扩展 ID 是这台机器上「同步区归谁」的唯一标识，比对两台时必须一眼看得清
    &__id {
        font-family: var(--font-mono, ui-monospace, monospace);
        word-break: break-all;
        opacity: 0.75;
    }

    &__refresh {
        @include button-reset;
        margin-left: auto;
        // 诊断行里的文字按钮热区抬到 xs 档，避免只有 20px 高的可点区
        min-height: var(--control-h-xs);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-xs);
        font-size: var(--text-xs);
        font-weight: var(--weight-semibold);
        color: var(--accent);
        @include spring-transition(background-color color, var(--dur-fast));

        &:hover:not(:disabled) {
            background: var(--hover-bg);
        }

        &:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    }

    &__recovery {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        background: var(--fill-secondary);
    }

    &__code {
        width: 100%;
        min-height: 64px;
        padding: var(--space-2);
        border: 1px solid var(--separator);
        border-radius: var(--radius-xs);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: var(--text-xs);
        line-height: var(--leading-normal);
        color: var(--label);
        background: var(--fill-tertiary);
        resize: vertical;
        // 恢复码是一整行 base64，不折行会拖出横向滚动条，全选复制也更麻烦
        word-break: break-all;
    }
}

.cloud-sync-provider {
    display: flex;
    gap: var(--space-1);

    &__btn {
        flex: 1;
        // 与同面板的 BaseButton small 取同一档，切换平台按钮和「连接」按钮等高
        height: var(--control-h-sm);
        padding: 0;
        border: 1px solid var(--separator);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--label-secondary);
        font-size: var(--text-sm);
        cursor: pointer;
        @include spring-transition(background-color color border-color, var(--dur-med));

        &.is-active {
            background: var(--tint-primary);
            color: var(--on-tint);
            border-color: var(--accent);
        }

        &:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
    }
}

.cloud-sync-actions {
    display: flex;
    gap: var(--space-2);

    > * {
        flex: 1;
    }
}

.cloud-sync-logout {
    align-self: flex-start;
    color: var(--color-error);
}
</style>
