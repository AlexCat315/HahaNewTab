<script setup lang="ts">
/**
 * CloudSyncPanel - 云同步状态面板
 *
 * 用 GitHub OAuth Device Flow 授权，换取 gist scope 的 access_token 后读写私密 Gist。
 * 用户不再需要手工申请、复制或粘贴 Token，也不再需要选择平台。
 * 提示使用 useToast，确认框使用 useConfirm（依赖 App.vue 挂载的 MntConfirmHost）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useCloudSync } from '@/composables/useCloudSync';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { loadClientId, saveClientId } from '@/services/cloudSync/oauthConfig';
import {
    GitHubOAuthError,
    pollForAccessToken,
    requestDeviceCode
} from '@/services/githubOAuth.service';
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
    login,
    logout,
    sync,
    pullAndApply,
    setAutoSync
} = useCloudSync({
    uiAdapter: {
        showToast: (message, type = 'info') => {
            toast.show(message, { type });
        },
        showConfirm: (message, options) => confirmDialog.confirm(message, options),
        showPrompt: async () => null
    }
});

const CLOUD_PATH = 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z';

type OAuthPhase = 'idle' | 'requesting' | 'waiting' | 'finishing';

const oauthPhase = ref<OAuthPhase>('idle');
const userCode = ref('');
const verificationUri = ref('');
const oauthError = ref<string | null>(null);
const copied = ref(false);

/** OAuth App 的公开标识，只需配置一次；断开连接不会清掉它 */
const clientId = ref('');
const clientIdInput = ref('');
const editingClientId = ref(false);

let authorizationAbort: AbortController | null = null;

const maskedClientId = computed(() => {
    const id = clientId.value;
    return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
});

const oauthStatusText = computed(() => {
    switch (oauthPhase.value) {
        case 'requesting':
            return '正在向 GitHub 申请授权码…';
        case 'waiting':
            return '在 GitHub 页面输入下面的授权码并确认，完成后会自动连接。';
        case 'finishing':
            return '授权成功，正在验证并初始化同步空间…';
        default:
            return '';
    }
});

function resetAuthorization(): void {
    oauthPhase.value = 'idle';
    userCode.value = '';
    verificationUri.value = '';
    copied.value = false;
    authorizationAbort = null;
}

function cancelAuthorization(): void {
    authorizationAbort?.abort();
    resetAuthorization();
}

/**
 * 一键授权：申请设备码 → 展示用户码 → 轮询换 token → 交给服务层验证并保存。
 * 过程中任何一步都可取消，面板卸载时也会自动取消，不留后台轮询。
 */
async function handleAuthorize(): Promise<void> {
    const id = (await loadClientId()).trim();
    clientId.value = id;
    if (!id) {
        oauthError.value = '请先配置 OAuth App 的 Client ID';
        editingClientId.value = true;
        return;
    }

    oauthError.value = null;
    copied.value = false;
    const controller = new AbortController();
    authorizationAbort = controller;
    oauthPhase.value = 'requesting';

    try {
        const authorization = await requestDeviceCode(id, controller.signal);
        userCode.value = authorization.userCode;
        verificationUri.value = authorization.verificationUri;
        oauthPhase.value = 'waiting';

        const accessToken = await pollForAccessToken(id, authorization, controller.signal);
        oauthPhase.value = 'finishing';

        const success = await login(accessToken);
        emit('login', success);
        if (success) {
            toast.show('GitHub 授权成功，云同步已连接', { type: 'success' });
        } else {
            oauthError.value = '授权返回的凭据无法使用，请重新授权';
        }
        resetAuthorization();
    } catch (err) {
        if (err instanceof GitHubOAuthError && err.reason === 'cancelled') {
            resetAuthorization();
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        oauthError.value = message;
        emit('error', message);
        toast.show(message, { type: 'error' });
        resetAuthorization();
    }
}

async function copyUserCode(): Promise<void> {
    if (!userCode.value) return;
    try {
        await navigator.clipboard?.writeText(userCode.value);
        copied.value = true;
    } catch {
        toast.show('复制失败，请手动选中授权码', { type: 'error' });
    }
}

function openClientIdEditor(): void {
    clientIdInput.value = clientId.value;
    editingClientId.value = true;
}

async function saveClientIdSetting(): Promise<void> {
    const value = clientIdInput.value.trim();
    if (!value) {
        toast.show('请输入 Client ID', { type: 'error' });
        return;
    }
    await saveClientId(value);
    clientId.value = value;
    clientIdInput.value = '';
    editingClientId.value = false;
    toast.show('Client ID 已保存', { type: 'success' });
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

const statusClass = computed(() => {
    if (isLoading.value) {
        return 'is-loading';
    }
    return isLoggedIn.value ? 'is-connected' : 'is-disconnected';
});

onMounted(async () => {
    clientId.value = await loadClientId();
});

onUnmounted(() => {
    authorizationAbort?.abort();
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
                通过 GitHub 授权登录，数据保存在你自己的私密 Gist 中；无需手动申请或粘贴 Token。
            </p>

            <div v-if="oauthPhase === 'idle'" class="cloud-sync-oauth-setup">
                <div v-if="editingClientId || !clientId" class="cloud-sync-oauth-config">
                    <BaseInput
                        v-model="clientIdInput"
                        label="OAuth App Client ID"
                        placeholder="Iv1.xxxxxxxxxxxxxxxx"
                        autocomplete="off"
                        @enter="saveClientIdSetting"
                    />
                    <p class="cloud-sync-panel__hint">
                        在 GitHub → Settings → Developer settings → OAuth Apps 创建应用并勾选「Enable Device Flow」，
                        把 Client ID 填在这里。它是公开标识、不是密钥，只需配置一次。
                    </p>
                    <div class="cloud-sync-oauth-config__actions">
                        <BaseButton size="small" @click="saveClientIdSetting">保存</BaseButton>
                        <BaseButton
                            v-if="clientId"
                            variant="text"
                            size="small"
                            @click="editingClientId = false"
                        >
                            取消
                        </BaseButton>
                    </div>
                </div>

                <div v-else class="cloud-sync-oauth-client">
                    <span>Client ID：{{ maskedClientId }}</span>
                    <button
                        type="button"
                        class="cloud-sync-oauth-client__edit"
                        @click="openClientIdEditor"
                    >
                        修改
                    </button>
                </div>

                <BaseButton
                    variant="primary"
                    size="small"
                    block
                    :disabled="!clientId"
                    :loading="isLoading"
                    @click="handleAuthorize"
                >
                    <template #icon>
                        <IconSvg name="link" size="var(--icon-xs)" />
                    </template>
                    使用 GitHub 登录
                </BaseButton>
                <p v-if="!clientId" class="cloud-sync-panel__hint">
                    配置 Client ID 后即可一键授权。
                </p>
            </div>

            <div v-else class="cloud-sync-oauth-pending" role="status">
                <p class="cloud-sync-panel__hint">{{ oauthStatusText }}</p>

                <template v-if="userCode">
                    <div class="cloud-sync-oauth-code" aria-label="GitHub 授权码">
                        {{ userCode }}
                    </div>
                    <div class="cloud-sync-oauth-actions">
                        <a
                            class="cloud-sync-oauth-link"
                            :href="verificationUri"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            打开 GitHub 授权页
                        </a>
                        <BaseButton variant="outlined" size="small" @click="copyUserCode">
                            {{ copied ? '已复制' : '复制授权码' }}
                        </BaseButton>
                    </div>
                </template>

                <BaseButton variant="text" size="small" @click="cancelAuthorization">
                    取消
                </BaseButton>
            </div>

            <p v-if="oauthError" class="cloud-sync-panel__error" role="alert">
                {{ oauthError }}
            </p>
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

.cloud-sync-oauth-setup,
.cloud-sync-oauth-config,
.cloud-sync-oauth-pending {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.cloud-sync-oauth-config__actions,
.cloud-sync-oauth-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.cloud-sync-oauth-client {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--label-secondary);

    &__edit {
        padding: 0;
        border: none;
        background: transparent;
        color: var(--accent);
        font-size: var(--text-xs);
        cursor: pointer;
    }
}

.cloud-sync-oauth-code {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--separator);
    border-radius: var(--radius-sm);
    background: var(--fill);
    color: var(--label);
    font-size: var(--text-2xl);
    font-weight: var(--weight-medium);
    letter-spacing: var(--space-1);
    text-align: center;
    user-select: all;
}

.cloud-sync-oauth-link {
    flex: 1;
    padding: 0 var(--space-3);
    height: var(--control-h-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--tint-primary);
    color: var(--on-tint);
    font-size: var(--text-sm);
    text-decoration: none;
    cursor: pointer;
}
</style>
