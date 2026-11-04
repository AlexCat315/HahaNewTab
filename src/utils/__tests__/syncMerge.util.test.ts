/**
 * syncMerge.util 三方合并工具测试
 * 覆盖合并规则表全部分支：仅一端修改、双改冲突（本地优先）、删除 vs 修改、
 * 新增并集、顺序保持、拖动排序（纯顺序变更）的顺序归属，忽略键序的深比较，
 * 以及按注册表策略逐键合并快照。
 * 设置类键另有三条策略：整体替换（scalar）、逐字段（fieldwise）、搜索历史（并集 + 尊重删除）。
 */
import { describe, it, expect } from 'vitest';
import {
    stableStringify,
    deepEqual,
    mergeById,
    mergeAppList,
    mergeAppNavigatorData,
    mergeUserUiLib,
    mergeScalarSnapshot,
    mergeFieldwiseSnapshot,
    mergeSearchHistorySnapshot,
    mergeSnapshots
} from '@/utils/syncMerge.util';
import { CLOUD_SYNC_KEY_STRATEGIES } from '@/services/storageSchema.service';
import { STORAGE_KEYS } from '@/types/storage';
import type { AppNavigatorData, AppItem, Category } from '@/types/app';
import type { UserUiLib } from '@/types/ui';

interface TestItem {
    id: string;
    name: string;
    extra?: number;
}

function item(id: string, name: string, extra?: number): TestItem {
    return extra === undefined ? { id, name } : { id, name, extra };
}

describe('stableStringify / deepEqual', () => {
    it('stableStringify 忽略对象键序', () => {
        const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
        const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
        expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('deepEqual 对键序不同但内容相同的对象返回 true', () => {
        expect(deepEqual({ id: 'a', name: 'A' }, { name: 'A', id: 'a' })).toBe(true);
    });

    it('deepEqual 对内容不同的对象返回 false', () => {
        expect(deepEqual({ id: 'a', name: 'A' }, { id: 'a', name: 'B' })).toBe(false);
        expect(deepEqual({ id: 'a' }, { id: 'a', name: 'A' })).toBe(false);
    });

    it('deepEqual 对数组顺序敏感', () => {
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
        expect(deepEqual([1, 2], [1, 2])).toBe(true);
    });

    it('deepEqual 处理 null 与嵌套数组', () => {
        expect(deepEqual(null, null)).toBe(true);
        expect(deepEqual(null, {})).toBe(false);
        expect(deepEqual([{ a: [1, { b: 2 }] }], [{ a: [1, { b: 2 }] }])).toBe(true);
    });
});

describe('mergeById 修改分支', () => {
    const base = [item('a', 'A'), item('b', 'B')];

    it('双方都未修改时保留本地项', () => {
        const result = mergeById(base, [...base.map((i) => ({ ...i }))], [...base.map((i) => ({ ...i }))]);
        expect(result).toEqual(base);
    });

    it('仅本地修改时采用本地版本', () => {
        const local = [item('a', 'A-local'), item('b', 'B')];
        const remote = [item('a', 'A'), item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-local');
    });

    it('仅远端修改时采用远端版本', () => {
        const local = [item('a', 'A'), item('b', 'B')];
        const remote = [item('a', 'A-remote'), item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-remote');
    });

    it('两端都修改且内容相同时任取其一（结果一致）', () => {
        const local = [item('a', 'A-same'), item('b', 'B')];
        const remote = [{ name: 'A-same', id: 'a' } as TestItem, item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-same');
    });

    it('两端都修改且内容不同（冲突）时本地优先', () => {
        const local = [item('a', 'A-local'), item('b', 'B')];
        const remote = [item('a', 'A-remote'), item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-local');
    });

    it('修改判定忽略对象键序', () => {
        // remote 仅键序不同，不视为修改
        const local = [item('a', 'A-local'), item('b', 'B')];
        const remote = [{ name: 'A', id: 'a' } as TestItem, { name: 'B', id: 'b' } as TestItem];
        const result = mergeById(base, local, remote);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-local');
    });
});

describe('mergeById 删除分支', () => {
    const base = [item('a', 'A'), item('b', 'B')];

    it('本地删除、远端未改时删除该项', () => {
        const local = [item('b', 'B')];
        const remote = [item('a', 'A'), item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['b']);
    });

    it('远端删除、本地未改时删除该项', () => {
        const local = [item('a', 'A'), item('b', 'B')];
        const remote = [item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['b']);
    });

    it('两端都删除时删除该项', () => {
        const result = mergeById(base, [item('b', 'B')], [item('b', 'B')]);
        expect(result.map((i) => i.id)).toEqual(['b']);
    });

    it('本地删除、远端修改（冲突）时本地优先：删除生效', () => {
        const local = [item('b', 'B')];
        const remote = [item('a', 'A-remote'), item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['b']);
    });

    it('远端删除、本地修改（冲突）时本地优先：保留本地版本', () => {
        const local = [item('a', 'A-local'), item('b', 'B')];
        const remote = [item('b', 'B')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['a', 'b']);
        expect(result.find((i) => i.id === 'a')?.name).toBe('A-local');
    });
});

describe('mergeById 新增分支', () => {
    it('仅本地新增时采用本地新增项', () => {
        const base = [item('a', 'A')];
        const local = [item('a', 'A'), item('n', 'N-local')];
        const remote = [item('a', 'A')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['a', 'n']);
    });

    it('仅远端新增时采用远端新增项并追加到末尾', () => {
        const base = [item('a', 'A')];
        const local = [item('a', 'A')];
        const remote = [item('a', 'A'), item('n', 'N-remote')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['a', 'n']);
        expect(result[1].name).toBe('N-remote');
    });

    it('两端同 id 新增且内容不同（冲突）时本地优先', () => {
        const base: TestItem[] = [];
        const local = [item('n', 'N-local')];
        const remote = [item('n', 'N-remote')];
        const result = mergeById(base, local, remote);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('N-local');
    });
});

describe('mergeById 顺序与 base 为空', () => {
    it('输出保留本地顺序，远端新增项追加到末尾', () => {
        const base = [item('a', 'A'), item('b', 'B'), item('c', 'C')];
        // 本地调整了顺序
        const local = [item('c', 'C'), item('a', 'A'), item('b', 'B')];
        // 远端在头部/中间插入新项
        const remote = [item('r1', 'R1'), item('a', 'A'), item('r2', 'R2'), item('b', 'B'), item('c', 'C')];
        const result = mergeById(base, local, remote);
        expect(result.map((i) => i.id)).toEqual(['c', 'a', 'b', 'r1', 'r2']);
    });

    it('base 为 null 时按空快照处理：本地与远端做并集', () => {
        const local = [item('a', 'A'), item('b', 'B-local')];
        const remote = [item('b', 'B-remote'), item('c', 'C')];
        const result = mergeById(null, local, remote);
        // 同 id（b）视为两端新增冲突，本地优先；c 为远端新增追加末尾
        expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
        expect(result.find((i) => i.id === 'b')?.name).toBe('B-local');
    });

    it('local / remote 为 null/undefined 时不报错', () => {
        expect(mergeById(null, null, null)).toEqual([]);
        expect(mergeById(null, [item('a', 'A')], undefined)).toEqual([item('a', 'A')]);
        expect(mergeById(null, undefined, [item('a', 'A')])).toEqual([item('a', 'A')]);
    });

    it('tieBreak 为 remote 时同 id 冲突取远端版本', () => {
        const local = [item('a', 'A'), item('b', 'B-local')];
        const remote = [item('b', 'B-remote'), item('c', 'C')];
        const result = mergeById(null, local, remote, 'remote');
        expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
        expect(result.find((i) => i.id === 'b')?.name).toBe('B-remote');
        // 并集语义不变：本地独有项不会因为让给了远端而丢失
        expect(result.find((i) => i.id === 'a')?.name).toBe('A');
    });

    it('tieBreak 为 remote 时内容相同的同 id 项不受影响', () => {
        const result = mergeById(null, [item('b', 'Same')], [item('b', 'Same')], 'remote');
        expect(result).toEqual([item('b', 'Same')]);
    });

    it('tieBreak 只在 base 缺失时生效，有 base 仍按三方规则本地优先', () => {
        const base = [item('b', 'B-base')];
        const local = [item('b', 'B-local')];
        const remote = [item('b', 'B-remote')];
        expect(mergeById(base, local, remote, 'remote').map((i) => i.name)).toEqual(['B-local']);
    });
});

describe('mergeAppNavigatorData', () => {
    const cat = (id: string, name: string): Category => ({ id, name });
    /** 默认给每个 id 一个独立 URL，避免触发 URL 去重（去重行为另有专门用例） */
    const app = (id: string, name: string, url = `https://example.com/${id}`): AppItem => ({
        id,
        name,
        url,
        category: 'c1'
    });

    it('categories 与 apps 分别按 id 合并', () => {
        const base: AppNavigatorData = { categories: [cat('c1', '分类')], apps: [app('a1', '站点')] };
        const local: AppNavigatorData = { categories: [cat('c1', '分类-本地')], apps: [app('a1', '站点')] };
        const remote: AppNavigatorData = { categories: [cat('c1', '分类')], apps: [app('a1', '站点-远端'), app('a2', '远端新增')] };

        const result = mergeAppNavigatorData(base, local, remote);
        expect(result.categories[0].name).toBe('分类-本地');
        expect(result.apps.map((a) => a.id)).toEqual(['a1', 'a2']);
        expect(result.apps[0].name).toBe('站点-远端');
    });

    it('任一侧为 null/undefined 时按空数据处理', () => {
        const result = mergeAppNavigatorData(null, undefined, { categories: [cat('c1', '分类')], apps: [] });
        expect(result.categories).toHaveLength(1);
        expect(result.apps).toEqual([]);
    });
});

describe('mergeAppList 跨设备 URL 去重', () => {
    const app = (id: string, name: string, url: string): AppItem => ({ id, name, url, category: 'c1' });

    it('远端与本地指向同一站点（写法不同）时丢弃远端，保留本地', () => {
        const local = [app('l1', '本地版', 'https://a.com')];
        const remote = [app('r1', '远端版', 'http://www.a.com/')];

        const result = mergeAppList(null, local, remote);
        expect(result.map((a) => a.id)).toEqual(['l1']);
        expect(result[0].name).toBe('本地版');
    });

    it('URL 不同的远端站点正常追加', () => {
        const local = [app('l1', '本地站', 'https://a.com')];
        const remote = [app('r1', '远端站', 'https://b.com')];

        expect(mergeAppList(null, local, remote).map((a) => a.id)).toEqual(['l1', 'r1']);
    });

    it('远端内部同址重复只保留第一个', () => {
        const remote = [
            app('r1', '第一个', 'https://a.com'),
            app('r2', '第二个', 'https://a.com/')
        ];

        const result = mergeAppList(null, [], remote);
        expect(result.map((a) => a.id)).toEqual(['r1']);
    });

    it('本地自身的重复不做处理（尊重用户现有数据）', () => {
        const local = [app('l1', '第一个', 'https://a.com'), app('l2', '第二个', 'https://a.com/')];

        expect(mergeAppList(null, local, []).map((a) => a.id)).toEqual(['l1', 'l2']);
    });

    it('query 不同视为不同站点', () => {
        const local = [app('l1', 'A', 'https://a.com/?id=1')];
        const remote = [app('r1', 'B', 'https://a.com/?id=2')];

        expect(mergeAppList(null, local, remote).map((a) => a.id)).toEqual(['l1', 'r1']);
    });
});

describe('mergeAppNavigatorData 分类同名合并', () => {
    it('远端同名分类并入本地分类，引用它的站点改指本地分类', () => {
        const local: AppNavigatorData = {
            categories: [{ id: 'c1', name: '工具' }],
            apps: [{ id: 'l1', name: '本地站', url: 'https://l.com', category: 'c1' }]
        };
        const remote: AppNavigatorData = {
            categories: [{ id: 'c9', name: ' 工具 ' }],
            apps: [{ id: 'r1', name: '远端站', url: 'https://r.com', category: 'c9' }]
        };

        const result = mergeAppNavigatorData(null, local, remote);
        expect(result.categories.map((c) => c.id)).toEqual(['c1']);
        expect(result.apps.map((a) => a.id)).toEqual(['l1', 'r1']);
        expect(result.apps.find((a) => a.id === 'r1')!.category).toBe('c1');
    });

    it('名称不同的远端分类保留，站点分类不变', () => {
        const local: AppNavigatorData = {
            categories: [{ id: 'c1', name: '工具' }],
            apps: []
        };
        const remote: AppNavigatorData = {
            categories: [{ id: 'c9', name: '阅读' }],
            apps: [{ id: 'r1', name: '远端站', url: 'https://r.com', category: 'c9' }]
        };

        const result = mergeAppNavigatorData(null, local, remote);
        expect(result.categories.map((c) => c.id)).toEqual(['c1', 'c9']);
        expect(result.apps[0].category).toBe('c9');
    });
});

describe('mergeUserUiLib', () => {
    it('categories 与 items 分别按 id 合并', () => {
        const base: UserUiLib = {
            categories: [{ id: 'uc1', name: '图标分类' }],
            items: [{ id: 'i1', name: '图标', url: 'icon.svg', category: 'uc1' }]
        };
        const local: UserUiLib = {
            categories: [{ id: 'uc1', name: '图标分类' }],
            items: [
                { id: 'i1', name: '图标-本地', url: 'icon.svg', category: 'uc1' },
                { id: 'i2', name: '本地新增', url: 'a.svg', category: 'uc1' }
            ]
        };
        const remote: UserUiLib = {
            categories: [{ id: 'uc1', name: '图标分类-远端' }, { id: 'uc2', name: '远端新增分类' }],
            items: [{ id: 'i1', name: '图标', url: 'icon.svg', category: 'uc1' }]
        };

        const result = mergeUserUiLib(base, local, remote);
        // 分类仅远端修改 → 采用远端；远端新增分类追加
        expect(result.categories.map((c) => c.id)).toEqual(['uc1', 'uc2']);
        expect(result.categories[0].name).toBe('图标分类-远端');
        // 图标项仅本地修改 → 本地优先；本地新增保留
        expect(result.items.map((i) => i.id)).toEqual(['i1', 'i2']);
        expect(result.items[0].name).toBe('图标-本地');
    });
});

describe('拖动排序（纯顺序变更）跨设备同步', () => {
    /** 默认给每个 id 一个独立 URL，避免触发 URL 去重（去重行为另有专门用例） */
    const app = (id: string, name = id): AppItem => ({
        id,
        name,
        url: `https://example.com/${id}`,
        category: 'c1'
    });
    const cat = (id: string): Category => ({ id, name: `分类-${id}` });
    const ids = (list: { id: string }[]) => list.map(i => i.id);

    it('仅远端重新排序时采用远端顺序', () => {
        const base = [app('a'), app('b'), app('c')];
        const local = [app('a'), app('b'), app('c')];
        const remote = [app('c'), app('a'), app('b')];

        expect(ids(mergeAppList(base, local, remote))).toEqual(['c', 'a', 'b']);
    });

    it('两端都重新排序时本地优先', () => {
        const base = [app('a'), app('b'), app('c')];
        const local = [app('b'), app('a'), app('c')];
        const remote = [app('c'), app('a'), app('b')];

        expect(ids(mergeAppList(base, local, remote))).toEqual(['b', 'a', 'c']);
    });

    it('本机未重排但改过内容时，仍跟随远端顺序且不丢本机改名', () => {
        const base = [app('a', '旧名'), app('b')];
        const local = [app('a', '本机改名'), app('b')];
        const remote = [app('b'), app('a', '旧名')];

        const result = mergeAppList(base, local, remote);
        expect(ids(result)).toEqual(['b', 'a']);
        expect(result.find(i => i.id === 'a')!.name).toBe('本机改名');
    });

    it('远端一边新增一边重排时不追随机位：保持本机顺序，新增项追加末尾', () => {
        // id 集合有出入就说明这不是「拖动排序」，跟随远端顺序会把本机顺序打乱，属于擅自改动
        const base = [app('a'), app('b')];
        const local = [app('a'), app('b')];
        const remote = [app('n', '远端新增'), app('b'), app('a')];

        expect(ids(mergeAppList(base, local, remote))).toEqual(['a', 'b', 'n']);
    });

    it('首次同步两端各握一批不同站点时不互相挤位', () => {
        // tieBreak=remote 只决定同 id 冲突的内容归属，不该把远端整体插到本机前面
        const result = mergeAppList(null, [app('l1', '本地站点')], [app('r1', '远端站点')], 'remote');

        expect(ids(result)).toEqual(['l1', 'r1']);
    });

    it('本机删除导致 id 集合变化时不算重排：保持本机顺序，删除照常生效', () => {
        const base = [app('a'), app('b'), app('c')];
        const local = [app('a'), app('c')];
        const remote = [app('c'), app('b'), app('a')];

        expect(ids(mergeAppList(base, local, remote))).toEqual(['a', 'c']);
    });

    it('base 为空（首次同步）时由 tieBreak 定顺序归属', () => {
        const local = [app('a'), app('b')];
        const remote = [app('b'), app('a')];

        expect(ids(mergeAppList(null, local, remote, 'remote'))).toEqual(['b', 'a']);
        expect(ids(mergeAppList(null, local, remote, 'local'))).toEqual(['a', 'b']);
    });

    it('顺序完全一致时不做任何重排', () => {
        const base = [app('a'), app('b')];
        const local = [app('a'), app('b')];
        const remote = [app('a'), app('b')];

        expect(mergeAppList(base, local, remote)).toEqual(local);
    });

    it('分类列表同样跟随远端顺序', () => {
        const result = mergeAppNavigatorData(
            { categories: [cat('c1'), cat('c2')], apps: [] },
            { categories: [cat('c1'), cat('c2')], apps: [] },
            { categories: [cat('c2'), cat('c1')], apps: [] }
        );
        expect(ids(result.categories)).toEqual(['c2', 'c1']);
    });

    it('图标库的 items 与 categories 顺序同样跟随仅远端的重排', () => {
        const icon = (id: string): UserUiLib['items'][number] => ({
            id,
            name: id,
            url: `${id}.svg`,
            category: 'uc1'
        });
        const base: UserUiLib = { categories: [], items: [icon('i1'), icon('i2')] };
        const local: UserUiLib = { categories: [], items: [icon('i1'), icon('i2')] };
        const remote: UserUiLib = { categories: [], items: [icon('i2'), icon('i1')] };

        expect(ids(mergeUserUiLib(base, local, remote).items)).toEqual(['i2', 'i1']);
    });
});

describe('mergeSnapshots 按注册表策略逐键合并', () => {
    /** 默认给每个 id 一个独立 URL，避免触发 URL 去重（去重行为另有专门用例） */
    const app = (id: string, name: string, url = `https://example.com/${id}`): AppItem => ({
        id,
        name,
        url,
        category: 'c1'
    });

    it('按同步键合并站点数据与用户图标库', () => {
        const base = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const local = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A-local')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const remote = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A'), app('a2', 'A2')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };

        const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, base, local, remote);
        const data = merged[STORAGE_KEYS.MAIN_DATA] as AppNavigatorData;
        expect(data.apps.map((a) => a.id)).toEqual(['a1', 'a2']);
        expect(data.apps[0].name).toBe('A-local');
        expect(merged[STORAGE_KEYS.USER_UI_LIB]).toEqual({ categories: [], items: [] });
    });

    it('另一端拖动排序：本机采纳新顺序，也不会把旧顺序推回云端', () => {
        // 顺序不落在任何字段上，只体现在数组位置，而快照级差异判定对数组顺序敏感：
        // 合并必须把「谁重排过」判对，否则本机不但收不到，还会用旧顺序覆盖云端
        const base = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A'), app('a2', 'A2')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const local = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A'), app('a2', 'A2')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const remote = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a2', 'A2'), app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };

        const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, base, local, remote);
        const data = merged[STORAGE_KEYS.MAIN_DATA] as AppNavigatorData;
        expect(data.apps.map((a) => a.id)).toEqual(['a2', 'a1']);
        // 与 CloudSyncService.sync 里 applied / uploaded 的判定式一一对应
        expect(deepEqual(merged[STORAGE_KEYS.MAIN_DATA], local[STORAGE_KEYS.MAIN_DATA])).toBe(false);
        expect(deepEqual(merged[STORAGE_KEYS.MAIN_DATA], remote[STORAGE_KEYS.MAIN_DATA])).toBe(true);
    });

    it('base 为 null（首次同步）时本地与远端做并集，互不覆盖', () => {
        const local = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('l1', '本地站点')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const remote = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('r1', '远端站点')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };

        const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, null, local, remote);
        const data = merged[STORAGE_KEYS.MAIN_DATA] as AppNavigatorData;
        expect(data.apps.map((a) => a.id)).toEqual(['l1', 'r1']);
    });

    it('远端缺少某个同步键时按空数据处理', () => {
        const local = {
            [STORAGE_KEYS.MAIN_DATA]: { categories: [], apps: [app('a1', 'A')] },
            [STORAGE_KEYS.USER_UI_LIB]: { categories: [], items: [] }
        };
        const merged = mergeSnapshots(CLOUD_SYNC_KEY_STRATEGIES, null, local, {});
        const data = merged[STORAGE_KEYS.MAIN_DATA] as AppNavigatorData;
        expect(data.apps).toHaveLength(1);
        expect(merged[STORAGE_KEYS.USER_UI_LIB]).toEqual({ categories: [], items: [] });
    });
});

describe('mergeScalarSnapshot 整体替换型键', () => {
    it('只有一端相对 base 改过时用改过那端', () => {
        expect(mergeScalarSnapshot('old', 'new', 'old')).toBe('new');
        expect(mergeScalarSnapshot('old', 'old', 'new')).toBe('new');
    });

    it('两端都相对 base 改过时本机优先，tieBreak 为 remote 时改用云端', () => {
        expect(mergeScalarSnapshot('old', '本地', '云端')).toBe('本地');
        expect(mergeScalarSnapshot('old', '本地', '云端', 'remote')).toBe('云端');
    });

    it('某一端没有这个键不算「那一端删掉了它」', () => {
        expect(mergeScalarSnapshot('old', undefined, '云端')).toBe('云端');
        expect(mergeScalarSnapshot('old', '本地', undefined)).toBe('本地');
    });

    it('两端都没有时返回 undefined，不凭空造值', () => {
        expect(mergeScalarSnapshot(undefined, undefined, undefined)).toBeUndefined();
        expect(mergeScalarSnapshot(undefined, null, undefined)).toBeUndefined();
    });
});

describe('mergeFieldwiseSnapshot 设置类对象逐字段合并', () => {
    const wallpaper = (url: string, blur: number) => ({ url, blur });

    it('一台改地址、另一台改模糊度，两处改动都保留', () => {
        const merged = mergeFieldwiseSnapshot(
            wallpaper('a', 0),
            wallpaper('b', 0),
            wallpaper('a', 8)
        ) as ReturnType<typeof wallpaper>;

        expect(merged).toEqual({ url: 'b', blur: 8 });
    });

    it('两端改同一个字段时本机优先', () => {
        const merged = mergeFieldwiseSnapshot(
            wallpaper('a', 0),
            wallpaper('本机', 0),
            wallpaper('云端', 0)
        ) as ReturnType<typeof wallpaper>;

        expect(merged.url).toBe('本机');
    });

    it('一端没写过的字段取另一端，不因为另一端的 base 值而回滚', () => {
        const merged = mergeFieldwiseSnapshot(
            { url: 'a' },
            { url: 'a' },
            { url: 'a', blur: 4 }
        ) as ReturnType<typeof wallpaper>;

        expect(merged).toEqual({ url: 'a', blur: 4 });
    });

    it('任一端不是普通对象时退回整体合并', () => {
        expect(mergeFieldwiseSnapshot({ a: 1 }, undefined, { a: 2 })).toEqual({ a: 2 });
        expect(mergeFieldwiseSnapshot('标量', '标量', '另一值')).toBe('另一值');
    });

    it('两端都没有该键时返回 undefined，避免每次同步都判成本机有更新', () => {
        expect(mergeFieldwiseSnapshot(undefined, undefined, undefined)).toBeUndefined();
    });
});

describe('mergeSearchHistorySnapshot 搜索历史', () => {
    const entry = (query: string, time: number) => ({ query, time });

    it('两端各自新增的查询取并集，按时间倒序', () => {
        const merged = mergeSearchHistorySnapshot(
            [entry('老查询', 1)],
            [entry('老查询', 1), entry('本机搜的', 3)],
            [entry('老查询', 1), entry('云端搜的', 2)]
        ) as Array<{ query: string }>;

        expect(merged.map(item => item.query)).toEqual(['本机搜的', '云端搜的', '老查询']);
    });

    it('同一查询两端都有时保留更晚的时间戳', () => {
        const merged = mergeSearchHistorySnapshot(
            [entry('q', 1)],
            [entry('q', 5)],
            [entry('q', 9)]
        ) as Array<{ time: number }>;

        expect(merged).toEqual([entry('q', 9)]);
    });

    it('本机清掉的历史不会被云端原样推回来', () => {
        const merged = mergeSearchHistorySnapshot(
            [entry('删掉的', 1), entry('留下的', 2)],
            [entry('留下的', 2)],
            [entry('删掉的', 1), entry('留下的', 2)]
        ) as Array<{ query: string }>;

        expect(merged.map(item => item.query)).toEqual(['留下的']);
    });

    it('另一端删掉的同样不再保留，两端都删的也不复活', () => {
        const remoteDeleted = mergeSearchHistorySnapshot(
            [entry('x', 1)],
            [entry('x', 1)],
            []
        );
        expect(remoteDeleted).toEqual([]);

        const bothDeleted = mergeSearchHistorySnapshot([entry('x', 1)], [], []);
        expect(bothDeleted).toEqual([]);
    });

    it('新设备（本机没有该键）采纳云端全部历史', () => {
        const merged = mergeSearchHistorySnapshot(
            undefined,
            undefined,
            [entry('云端历史', 7)]
        ) as Array<{ query: string }>;

        expect(merged).toEqual([entry('云端历史', 7)]);
    });

    it('两端都没这份数据时返回 undefined，不造出空数组', () => {
        expect(mergeSearchHistorySnapshot(undefined, undefined, undefined)).toBeUndefined();
    });

    it('忽略空白查询与非条目', () => {
        const merged = mergeSearchHistorySnapshot(
            null,
            [entry('  ', 1), { query: 1, time: 2 } as unknown as { query: string }, entry('有效', 3)],
            null
        ) as Array<{ query: string }>;

        expect(merged).toEqual([entry('有效', 3)]);
    });
});
