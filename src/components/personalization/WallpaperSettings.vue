<script setup lang="ts">
/**
 * WallpaperSettings - 壁纸背景设置
 *
 * 提供预设壁纸、网络图片 URL、本地图片上传，以及透明度/模糊/遮罩调节。
 * 拖动滑块时直接改 store 状态做实时预览，松手后再持久化。
 */
import { ref, watch } from 'vue';
import { useWallpaper } from '@/composables/useWallpaper';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import IconSvg from '@/components/icon/IconSvg.vue';
import BaseInput from '@/components/common/BaseInput.vue';
import BaseSlider from '@/components/common/BaseSlider.vue';
import BaseButton from '@/components/common/BaseButton.vue';
import SettingsSection from '@/components/common/SettingsSection.vue';
import SettingsRow from '@/components/common/SettingsRow.vue';

export interface WallpaperSettingsProps {
    /** 预设壁纸 URL 列表 */
    presets?: string[];
    /** 是否自动初始化壁纸 store */
    autoInit?: boolean;
}

const props = withDefaults(defineProps<WallpaperSettingsProps>(), {
    presets: () => [
        'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80',
        'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=1920&q=80',
        'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1920&q=80',
        'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1920&q=80'
    ],
    autoInit: true
});

const toast = useToast();
const confirm = useConfirm();

const {
    settings,
    effectiveUrl,
    hasWallpaper,
    isLocalImage,
    imageData,
    loading,
    setUrl,
    setLocalImage,
    setOpacity,
    setBlur,
    setOverlayOpacity,
    removeWallpaper,
    reset
} = useWallpaper({ autoInit: props.autoInit });

const urlInput = ref('');
const fileInputRef = ref<HTMLInputElement | null>(null);

watch(
    () => settings.value.url,
    (next) => {
        urlInput.value = next ?? '';
    },
    { immediate: true }
);

const UPLOAD_PATH = 'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z';
const DELETE_PATH = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';

function fail(err: unknown): void {
    toast.error(err instanceof Error ? err.message : String(err));
}

function isPresetActive(url: string): boolean {
    return !isLocalImage.value && effectiveUrl.value === url;
}

async function handlePresetClick(url: string): Promise<void> {
    try {
        await setUrl(url);
    } catch (err) {
        fail(err);
    }
}

async function handleApplyUrl(): Promise<void> {
    const url = urlInput.value.trim();
    if (!url) return;
    try {
        await setUrl(url);
        toast.success('壁纸已更新');
    } catch (err) {
        fail(err);
    }
}

function handleFileSelect(): void {
    fileInputRef.value?.click();
}

async function handleFileChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) {
        return;
    }

    try {
        await setLocalImage(file);
        toast.success('本地壁纸已应用');
    } catch (err) {
        fail(err);
    } finally {
        target.value = '';
    }
}

async function handleRemove(): Promise<void> {
    try {
        await removeWallpaper();
        urlInput.value = '';
    } catch (err) {
        fail(err);
    }
}

async function handleReset(): Promise<void> {
    const ok = await confirm.confirm('将清除壁纸并恢复透明度、模糊、遮罩的默认值。', {
        title: '恢复默认壁纸设置',
        okText: '恢复',
    });
    if (!ok) return;
    try {
        await reset();
        urlInput.value = '';
    } catch (err) {
        fail(err);
    }
}

async function handleOpacityChange(value: number): Promise<void> {
    try {
        await setOpacity(value);
    } catch (err) {
        fail(err);
    }
}

async function handleBlurChange(value: number): Promise<void> {
    try {
        await setBlur(value);
    } catch (err) {
        fail(err);
    }
}

async function handleOverlayChange(value: number): Promise<void> {
    try {
        await setOverlayOpacity(value);
    } catch (err) {
        fail(err);
    }
}

function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatPx(value: number): string {
    return `${value}px`;
}
</script>

<template>
    <div class="wallpaper-settings" aria-label="壁纸设置">
        <SettingsSection title="壁纸背景" description="预设、网络图片或本地图片任选一种，下方调节显示效果">
            <div class="wallpaper-presets" role="group" aria-label="预设壁纸">
                <button
                    v-for="(url, index) in presets"
                    :key="index"
                    type="button"
                    class="wallpaper-preset"
                    :class="{ active: isPresetActive(url) }"
                    :style="{ backgroundImage: `url(${url})` }"
                    :title="`预设壁纸 ${index + 1}`"
                    @click="handlePresetClick(url)"
                />
            </div>

            <SettingsRow orientation="stacked" label="网络图片" hint="粘贴图片地址后回车即可生效">
                <div class="wallpaper-url">
                    <BaseInput
                        v-model="urlInput"
                        placeholder="https://..."
                        type="url"
                        :disabled="loading"
                        @enter="handleApplyUrl"
                    />
                    <BaseButton
                        variant="primary"
                        :loading="loading"
                        :disabled="!urlInput.trim()"
                        @click="handleApplyUrl"
                    >
                        应用
                    </BaseButton>
                </div>
            </SettingsRow>

            <SettingsRow
                orientation="stacked"
                label="本地图片"
                :hint="imageData ? `已选择：${imageData.name}` : '图片存入本地存储，单张最大 5MB'"
            >
                <input
                    ref="fileInputRef"
                    type="file"
                    accept="image/*"
                    class="wallpaper-local__input"
                    @change="handleFileChange"
                >
                <BaseButton variant="outlined" :loading="loading" @click="handleFileSelect">
                    <template #icon>
                        <IconSvg :path="UPLOAD_PATH" size="var(--icon-xs)" />
                    </template>
                    选择本地图片
                </BaseButton>
            </SettingsRow>

            <SettingsRow orientation="stacked" label="显示效果" align-start>
                <div class="wallpaper-sliders">
                    <BaseSlider
                        v-model="settings.opacity"
                        label="壁纸透明度"
                        :min="0"
                        :max="1"
                        :step="0.01"
                        :format-value="formatPercent"
                        :disabled="loading"
                        @change="handleOpacityChange"
                    />

                    <BaseSlider
                        v-model="settings.blur"
                        label="模糊程度"
                        :min="0"
                        :max="20"
                        :step="0.5"
                        :format-value="formatPx"
                        :disabled="loading"
                        @change="handleBlurChange"
                    />

                    <BaseSlider
                        v-model="settings.overlayOpacity"
                        label="背景遮罩"
                        :min="0"
                        :max="1"
                        :step="0.01"
                        :format-value="formatPercent"
                        :disabled="loading"
                        @change="handleOverlayChange"
                    />
                </div>
            </SettingsRow>

            <div class="wallpaper-actions">
                <span v-if="hasWallpaper" class="wallpaper-status">
                    当前使用{{ isLocalImage ? '本地图片' : '网络图片' }}壁纸
                </span>
                <BaseButton variant="text" size="small" :disabled="!hasWallpaper" @click="handleRemove">
                    <template #icon>
                        <IconSvg :path="DELETE_PATH" size="var(--icon-xs)" />
                    </template>
                    移除壁纸
                </BaseButton>
                <BaseButton variant="outlined" size="small" :disabled="loading" @click="handleReset">
                    恢复默认
                </BaseButton>
            </div>
        </SettingsSection>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.wallpaper-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
}

.wallpaper-presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: var(--space-2);
    margin-bottom: var(--space-2);
}

.wallpaper-preset {
    @include button-reset;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius-sm);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    border: 2px solid var(--md-sys-color-outline-variant);
    @include md-transition(all, var(--md-transition-fast));

    &:hover {
        border-color: var(--md-sys-color-primary);
        transform: translateY(-1px);
    }

    &.active {
        border-color: var(--md-sys-color-primary);
        box-shadow: var(--elevation-2);
    }
}

.wallpaper-url {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    width: 100%;

    :deep(.mnt-base-input) {
        flex: 1;
    }
}

.wallpaper-local__input {
    @include visually-hidden;
}

.wallpaper-sliders {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
}

.wallpaper-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-top: var(--space-3);
}

.wallpaper-status {
    margin-right: auto;
    font-size: var(--text-sm);
    color: var(--md-sys-color-on-surface-variant);
}
</style>
