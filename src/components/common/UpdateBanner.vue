<!--
  UpdateBanner - 应用内更新提示条

  仅用于 Chromium 系（Chrome / Edge）自托管安装的场景：这些浏览器不会自动
  更新商店外的扩展，只能靠界面提示引导用户手动下载新版本。
  Firefox 有自己的 update_url 静默更新通道，正常情况下不会看到它。

  纯展示组件：是否显示、点按钮做什么，全部由父组件决定。
-->
<script setup lang="ts">
import IconSvg from '@/components/icon/IconSvg.vue';

interface Props {
    /** 最新版本号，如 1.0.0.109 */
    latestVersion: string;
    /** 当前版本号，用于展示「当前 → 最新」 */
    currentVersion?: string;
}

withDefaults(defineProps<Props>(), {
    currentVersion: '',
});

const emit = defineEmits<{
    /** 点击「立即更新」 */
    (e: 'update'): void;
    /** 关闭提示条（该版本不再提示） */
    (e: 'close'): void;
}>();
</script>

<template>
    <Transition name="update-banner" appear>
        <div class="update-banner" role="status" aria-live="polite">
            <span class="update-banner__icon" aria-hidden="true">
                <IconSvg name="download" size="var(--icon-sm)" />
            </span>

            <div class="update-banner__text">
                <p class="update-banner__title">发现新版本 v{{ latestVersion }}</p>
                <p v-if="currentVersion" class="update-banner__sub">
                    当前 v{{ currentVersion }}
                </p>
            </div>

            <button
                type="button"
                class="update-banner__action"
                @click="emit('update')"
            >
                立即更新
            </button>

            <button
                type="button"
                class="update-banner__close"
                aria-label="关闭更新提示"
                @click="emit('close')"
            >
                <IconSvg name="close" size="var(--icon-xs)" />
            </button>
        </div>
    </Transition>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.update-banner {
    position: fixed;
    left: var(--space-6);
    bottom: var(--space-6);
    // 压过菜单/下拉，但让位给弹层与 Toast：更新提示不该抢模态焦点
    z-index: var(--z-banner);

    display: flex;
    align-items: center;
    gap: var(--space-3);
    max-width: var(--panel-w-sm);
    padding: var(--space-3);

    color: var(--label);
    @include glass-surface(var(--glass-bg-strong), var(--radius-lg));
    @include spring-transition(transform, var(--dur-fast));

    &__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-md);
        background: var(--tint-primary);
        color: var(--on-tint);
    }

    &__text {
        flex: 1;
        min-width: 0;
    }

    &__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        line-height: var(--leading-normal);
        @include text-ellipsis;
    }

    &__sub {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        line-height: var(--leading-normal);
        color: var(--label-secondary);
        @include text-ellipsis;
    }

    &__action {
        @include button-reset;
        @include focus-ring;
        flex-shrink: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--control-radius);
        font-size: var(--text-xs);
        font-weight: var(--weight-semibold);
        white-space: nowrap;
        background: var(--accent);
        color: var(--on-accent);
        @include spring-transition(all, var(--dur-fast));

        &:hover {
            transform: scale(1.02);
            box-shadow: var(--elevation-2);
        }
    }

    &__close {
        @include button-reset;
        @include focus-ring;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        border-radius: var(--radius-sm);
        color: var(--label-secondary);
        opacity: 0.7;
        @include spring-transition(all, var(--dur-fast));

        &:hover {
            opacity: 1;
            background: var(--hover-bg);
        }
    }
}

// 入场/出场：从下方滑入
.update-banner-enter-active,
.update-banner-leave-active {
    transition:
        opacity var(--dur-med) var(--ease-spring),
        transform var(--dur-med) var(--ease-spring);
}

.update-banner-enter-from,
.update-banner-leave-to {
    opacity: 0;
    transform: translateY(var(--space-3));
}

@include respond-to(mobile) {
    .update-banner {
        left: var(--space-3);
        right: var(--space-3);
        bottom: var(--space-3);
        max-width: none;
    }
}
</style>
