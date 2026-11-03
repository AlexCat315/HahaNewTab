<script setup lang="ts">
/**
 * MinimalHome - 极简约模式首页
 *
 * 对齐浏览器默认新标签页的形态：页面正中一个大号搜索框，下方是若干行站点磁贴。
 * 不渲染顶栏 / 侧边栏 / 分类标题 / 浮动按钮，只保留「找站点」和「去站点」两件事。
 *
 * 本组件只做编排：搜索框、分类胶囊与磁贴行、右下控制区各自住在同目录的子组件里
 * （MinimalSearchBox / MinimalTileGrid / MinimalControlBar），这里只留页面层才知道的
 * 状态——当前分类、站点操作菜单的锚点、排序落盘。
 *
 * 交互：
 * - 搜索框自动聚焦，输入即联想（复用 useSearch 与 SearchSuggestions）
 * - Enter 搜索 / 选中高亮建议，↑↓ 切换建议，Esc 清空
 * - 磁贴 hover 浮起并露出「更多」按钮，点击打开站点
 * - 磁贴右键 / 触屏长按 / 更多按钮 / ContextMenu 键 → 站点操作菜单
 *   （打开、复制链接、编辑、移动到分类、隐藏、删除）
 * - 磁贴可直接拖拽排序，仅在当前分类范围内生效
 * - 分类切换用一行极轻的胶囊标签承载，超过 16 个站点时可展开全部
 * - 右下角悬停控制区提供：添加站点 / 完整搜索 / 云同步 / 个性化 / 显示隐藏站点 / 退出极简
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { AppItem } from '@/types/app';
import { useDataManager } from '@/composables/useDataManager';
import { useToast } from '@/composables/useToast';
import { useLayoutStore } from '@/stores/layout.store';
import { openUrl } from '@/utils/navigation.util';
import MinimalSearchBox from '@/components/layout/MinimalSearchBox.vue';
import MinimalTileGrid from '@/components/layout/MinimalTileGrid.vue';
import MinimalControlBar from '@/components/layout/MinimalControlBar.vue';
import MinimalSiteMenu from '@/components/layout/MinimalSiteMenu.vue';

export interface MinimalHomeProps {
    /** 是否显示隐藏站点（与完整模式的揭示模式共享同一状态） */
    showHidden?: boolean;
}

const props = withDefaults(defineProps<MinimalHomeProps>(), {
    showHidden: false
});

const emit = defineEmits<{
    /** 打开个性化面板 */
    (e: 'open-personalization'): void;
    /** 添加站点 */
    (e: 'add-app'): void;
    /** 编辑站点 */
    (e: 'edit-app', app: AppItem): void;
    /** 删除站点（由外层弹确认框） */
    (e: 'delete-app', app: AppItem): void;
    /** 切换隐藏站点揭示模式 */
    (e: 'toggle-hidden-reveal'): void;
    /** 打开完整搜索（历史 / 引擎切换） */
    (e: 'open-full-search'): void;
    /** 打开云同步面板 */
    (e: 'open-cloud-sync'): void;
    /** 退出极简约模式 */
    (e: 'exit-minimal'): void;
}>();

const dataManager = useDataManager({ autoInit: true });
const toast = useToast();
const layoutStore = useLayoutStore();

const activeCategoryId = ref('all');
const rootEl = ref<HTMLElement | null>(null);
const searchBoxRef = ref<InstanceType<typeof MinimalSearchBox> | null>(null);

/** 当前打开操作菜单的站点（null 表示菜单关闭） */
const menuApp = ref<AppItem | null>(null);
const menuPoint = ref({ x: 0, y: 0 });

// ==================== 数据 ====================

const categories = computed(() => dataManager.categories.value);

/** 可移动到的分类（不含「全部」虚拟分类） */
const userCategories = computed(() => dataManager.userCategories.value);

/** 当前分类下的站点；未开启揭示模式时过滤掉隐藏站点 */
const scopedApps = computed<AppItem[]>(() => {
    const source =
        activeCategoryId.value === 'all'
            ? dataManager.apps.value
            : dataManager.getAppsByCategory(activeCategoryId.value);
    return props.showHidden ? source : source.filter((app) => !app.hidden);
});

const hiddenCount = computed(
    () =>
        (activeCategoryId.value === 'all'
            ? dataManager.apps.value
            : dataManager.getAppsByCategory(activeCategoryId.value)
        ).filter((app) => app.hidden).length
);

// ==================== 搜索框编排 ====================

/** 暴露给 App.vue：进出极简模式后把焦点交还搜索框 */
function focusInput(): void {
    searchBoxRef.value?.focusInput();
}

/** 建议状态住在搜索框里，点其他区域时由这一层派发「收起建议」 */
function handlePagePointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.minimal-search')) {
        return;
    }
    searchBoxRef.value?.clearSuggestions();
}

// ==================== 站点操作菜单 ====================

function openMenu(app: AppItem, point: { clientX: number; clientY: number }): void {
    menuApp.value = app;
    menuPoint.value = { x: point.clientX, y: point.clientY };
}

function closeMenu(): void {
    menuApp.value = null;
}

function handleMenuOpen(): void {
    const app = menuApp.value;
    closeMenu();
    if (!app?.url) return;
    openUrl(app.url, layoutStore.openMode);
}

async function handleMenuCopyLink(): Promise<void> {
    const app = menuApp.value;
    closeMenu();
    if (!app) return;

    try {
        await navigator.clipboard?.writeText(app.url);
        toast.success('链接已复制');
        return;
    } catch {
        // 剪贴板 API 不可用（未聚焦 / 无权限）时退回临时 textarea 方案
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = app.url;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) throw new Error('execCommand failed');
        toast.success('链接已复制');
    } catch {
        toast.error('复制失败，请手动复制链接');
    }
}

function handleMenuEdit(): void {
    const app = menuApp.value;
    closeMenu();
    if (app) emit('edit-app', app);
}

function handleMenuDelete(): void {
    const app = menuApp.value;
    closeMenu();
    if (app) emit('delete-app', app);
}

async function handleMenuToggleHidden(): Promise<void> {
    const app = menuApp.value;
    closeMenu();
    if (!app) return;

    try {
        await dataManager.updateApp(app.id, { hidden: !app.hidden });
        toast.success(app.hidden ? `已取消隐藏「${app.name}」` : `已隐藏「${app.name}」`);
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '操作失败');
    }
}

async function handleMenuMove(categoryId: string): Promise<void> {
    const app = menuApp.value;
    closeMenu();
    if (!app || app.category === categoryId) return;

    try {
        await dataManager.updateApp(app.id, { category: categoryId });
        const target = dataManager.getCategoryById(categoryId);
        toast.success(`已移动到「${target?.name ?? '新分类'}」`);
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '移动失败');
    }
}

// ==================== 磁贴行编排 ====================

/** 跳转方式由布局设置决定，所以打开动作落在持有 store 的这一层 */
function handleOpenApp(app: AppItem): void {
    if (!app.url) return;
    openUrl(app.url, layoutStore.openMode);
}

/**
 * 把当前分类的展示顺序写回全局顺序。
 *
 * 全局 apps 是跨分类混排的，直接整体重排会把其他分类的位置也打乱，
 * 因此只替换「属于当前展示范围」的那些槽位。
 */
async function applyScopedOrder(orderedIds: string[]): Promise<void> {
    const scopedIds = new Set(scopedApps.value.map((app) => app.id));
    const nextIds = dataManager.apps.value.map((app) => app.id);
    const slots: number[] = [];

    dataManager.apps.value.forEach((app, index) => {
        if (scopedIds.has(app.id)) slots.push(index);
    });

    if (slots.length !== orderedIds.length) return;

    slots.forEach((slot, index) => {
        nextIds[slot] = orderedIds[index];
    });

    // 顺序没变就不写盘，避免每次拖动都触发一次存储更新
    const currentIds = dataManager.apps.value.map((app) => app.id);
    if (nextIds.join('\u0000') === currentIds.join('\u0000')) return;

    await dataManager.updateAppsOrder(nextIds);
}

async function handleReorder(orderedIds: string[]): Promise<void> {
    try {
        await applyScopedOrder(orderedIds);
        toast.success('排序已保存');
    } catch (error) {
        toast.error(error instanceof Error ? error.message : '排序失败');
    }
}

// ==================== 生命周期 ====================

onMounted(() => {
    // 首屏自动聚焦，模拟浏览器默认新标签页「打开即可打字」
    window.setTimeout(focusInput, 80);
});

// 菜单锚定的站点可能已不在当前视图，切分类先收菜单
// （「显示全部」展开态由磁贴行自己收起）
watch(activeCategoryId, () => {
    closeMenu();
});

defineExpose({ focusInput });
</script>

<template>
    <div ref="rootEl" class="minimal-home" @pointerdown="handlePagePointerDown">
        <div class="minimal-home__inner">
            <!-- ============ 居中搜索框 ============ -->
            <MinimalSearchBox ref="searchBoxRef" />

            <!-- ============ 分类胶囊 + 站点磁贴 ============ -->
            <MinimalTileGrid
                :categories="categories"
                :active-category-id="activeCategoryId"
                :apps="scopedApps"
                :show-hidden="showHidden"
                :is-loading="dataManager.isLoading.value"
                :hidden-count="hiddenCount"
                @select-category="activeCategoryId = $event"
                @open-app="handleOpenApp"
                @menu="openMenu"
                @drag-start="closeMenu"
                @reorder="handleReorder"
                @add-app="emit('add-app')"
                @toggle-hidden-reveal="emit('toggle-hidden-reveal')"
            />
        </div>

        <!-- ============ 右下角控制区：默认收成一个设置按钮，悬停向左展开 ============ -->
        <MinimalControlBar
            :show-hidden="showHidden"
            @add-app="emit('add-app')"
            @open-full-search="emit('open-full-search')"
            @open-cloud-sync="emit('open-cloud-sync')"
            @toggle-hidden-reveal="emit('toggle-hidden-reveal')"
            @open-personalization="emit('open-personalization')"
            @exit-minimal="emit('exit-minimal')"
        />

        <!-- ============ 站点操作菜单（右键 / 长按 / 更多按钮触发） ============ -->
        <MinimalSiteMenu
            v-if="menuApp"
            :app="menuApp"
            :categories="userCategories"
            :x="menuPoint.x"
            :y="menuPoint.y"
            @close="closeMenu"
            @open="handleMenuOpen"
            @copy-link="handleMenuCopyLink"
            @edit="handleMenuEdit"
            @delete="handleMenuDelete"
            @toggle-hidden="handleMenuToggleHidden"
            @move="handleMenuMove"
        />
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/mixins' as *;

.minimal-home {
    position: relative;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    // 底部留白给右下角固定的控制区让位
    padding: 14vh var(--space-6) calc(var(--space-12) * 2);
}

.minimal-home__inner {
    width: 100%;
    // 极简首页是「一列居中」的排版，用阅读列宽，不是完整模式的 1240 多列网格
    max-width: var(--reading-max-width);
    display: flex;
    flex-direction: column;
    align-items: center;
}

@include respond-to(mobile) {
    .minimal-home {
        padding: 10vh var(--space-4) calc(var(--space-12) + var(--space-8));
    }
}
</style>
