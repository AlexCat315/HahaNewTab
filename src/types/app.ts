/**
 * 应用与分类相关类型定义
 * 与原项目 js/storage.js、js/data.config.js、config/defaultData.json 数据结构保持一致
 */

/** 应用分类 */
export interface Category {
    id: string;
    name: string;
    /** 图标：SVG 路径、Emoji 或图片 URL */
    icon?: string;
    /** 深色模式专用图标 */
    iconDark?: string;
    /** 是否为单色图标（深色模式下会反转为白色） */
    monochrome?: boolean;
}

/** 应用站点 */
export interface AppItem {
    id: string;
    name: string;
    description?: string;
    /** 图标：图片 URL、Emoji 或 SVG 路径 */
    icon?: string;
    url: string;
    category: string;
    /** 设置为 true 时站点默认不在首页显示 */
    hidden?: boolean;
}

/** 应用导航完整数据 */
export interface AppNavigatorData {
    categories: Category[];
    apps: AppItem[];
}

/**
 * 判断是否为合法的应用导航数据
 *
 * 站点数据要经过存储读写、导入备份、云端快照好几条路径，每一步都可能拿到被截断或
 * 结构过期的值；拿到非法值就当没有数据，比拿它去渲染或合并安全得多。
 */
export function isAppNavigatorData(data: unknown): data is AppNavigatorData {
    return Boolean(
        data &&
        typeof data === 'object' &&
        Array.isArray((data as AppNavigatorData).categories) &&
        Array.isArray((data as AppNavigatorData).apps)
    );
}

/** 创建/更新应用时允许传入的字段（id 由系统自动生成） */
export interface AppInput extends Partial<Omit<AppItem, 'id' | 'name' | 'url' | 'category'>> {
    name: string;
    url: string;
    category: string;
}

/** 创建/更新分类时允许传入的字段（id 由系统自动生成） */
export interface CategoryInput extends Partial<Omit<Category, 'id' | 'name'>> {
    name: string;
}
