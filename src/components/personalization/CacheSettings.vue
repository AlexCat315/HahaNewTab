<script setup lang="ts">
/**
 * CacheSettings - 本地缓存设置
 *
 * 站点图标与网络壁纸默认缓存在 IndexedDB（mediaCacheService）里，
 * 这里提供总开关、用量展示与一键清理。
 */
import { computed, onMounted } from 'vue';
import { useCacheStore } from '@/stores/cache.store';
import { useToast } from '@/composables/useToast';
import { useConfirm } from '@/composables/useConfirm';
import { formatFileSize } from '@/utils/file.util';
import BaseButton from '@/components/common/BaseButton.vue';
import SettingsSection from '@/components/common/SettingsSection.vue';
import SettingsRow from '@/components/common/SettingsRow.vue';
import SwitchField from '@/components/common/SwitchField.vue';

const cacheStore = useCacheStore();
const toast = useToast();
const confirm = useConfirm();

const stats = computed(() => cacheStore.stats);

/** 缓存占用的人类可读文案 */
const usageText = computed(() => {
    if (!cacheStore.isAvailable()) {
        return '当前环境不支持本地缓存';
    }
    if (!stats.value.count) {
        return '暂无缓存';
    }
    return `${stats.value.count} 项 · ${formatFileSize(stats.value.bytes)}`;
});

/** 分类明细 */
const breakdownText = computed(() => {
    const { icon, wallpaper } = stats.value.byKind;
    if (!icon && !wallpaper) {
        return '';
    }
    const parts: string[] = [];
    if (icon) parts.push(`图标 ${icon}`);
    if (wallpaper) parts.push(`壁纸 ${wallpaper}`);
    return parts.join(' / ');
});

onMounted(() => {
    void cacheStore.init().then(() => cacheStore.refreshStats());
});

async function handleToggle(value: boolean): Promise<void> {
    await cacheStore.setEnabled(value);
    toast.success(value ? '已开启本地缓存' : '已关闭本地缓存');
}

async function handleClear(): Promise<void> {
    if (!stats.value.count) {
        toast.info('当前没有可清理的缓存');
        return;
    }
    const ok = await confirm.confirm(
        `将删除 ${usageText.value} 的本地缓存，站点图标与壁纸会重新从网络获取。`,
        { title: '清理本地缓存', okText: '清理', isDanger: true }
    );
    if (!ok) return;
    await cacheStore.clearCache();
    toast.success('缓存已清理');
}
</script>

<template>
    <div class="cache-settings" aria-label="本地缓存">
        <SettingsSection title="本地缓存">
            <SettingsRow
                label="启用本地缓存"
                hint="站点图标与网络壁纸存到本地，不再每次打开都请求网络。关闭后不再读写，已有缓存会保留，重新开启即可继续复用。"
            >
                <SwitchField :model-value="cacheStore.enabled" @update:model-value="handleToggle" />
            </SettingsRow>

            <SettingsRow label="已占用" :hint="breakdownText || '图标缓存 7 天、壁纸缓存 30 天后自动过期'">
                <template #control>
                    <div class="cache-settings__control">
                        <span class="cache-settings__usage">{{ usageText }}</span>
                        <BaseButton
                            variant="outlined"
                            size="small"
                            :disabled="cacheStore.loading || !stats.count"
                            @click="handleClear"
                        >
                            {{ cacheStore.loading ? '清理中…' : '清理缓存' }}
                        </BaseButton>
                    </div>
                </template>
            </SettingsRow>
        </SettingsSection>

        <p class="cache-settings__note">
            只缓存 http(s) 资源，本地图片与内置图标不占空间。
        </p>
    </div>
</template>

<style scoped lang="scss">
.cache-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);

    &__control {
        display: flex;
        align-items: center;
        gap: var(--space-3);
    }

    &__usage {
        font-size: var(--text-base);
        font-weight: var(--weight-semibold);
        color: var(--md-sys-color-on-surface);
        font-variant-numeric: tabular-nums;
    }

    &__note {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--leading-relaxed);
        color: var(--md-sys-color-on-surface-variant);
    }
}
</style>
