/**
 * CloudSyncPanel 测试
 * 覆盖：未登录态渲染（平台选择 + Token 输入）、空 Token 提示、
 * 已登录态操作按钮（「立即同步」双向合并、「强制恢复云端」兜底）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CloudSyncPanel from '@/components/personalization/CloudSyncPanel.vue';
import { enableCrossDevice } from '@/services/crossDeviceSync.service';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';

describe('CloudSyncPanel', () => {
    beforeEach(() => {
        localStorage.clear();
        setActivePinia(createPinia());
        browserApi.resetDetection();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('渲染未登录状态与连接按钮', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        expect(wrapper.text()).toContain('云同步');
        expect(wrapper.text()).toContain('未连接');
        expect(wrapper.text()).toContain('使用 GitHub / Gitee 代码片段（Gist）备份和同步你的站点数据');
        expect(wrapper.find('.cloud-sync-panel__guest').exists()).toBe(true);
        // 默认平台为 GitHub
        expect(wrapper.find('.cloud-sync-panel__guest .mnt-base-button').text()).toContain('连接 GitHub');
    });

    it('Token 输入框为空时点击连接给出提示', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const button = wrapper.find('.cloud-sync-panel__guest .mnt-base-button');
        await button.trigger('click');
        await flushPromises();

        expect(wrapper.emitted('login')).toBeUndefined();
    });

    it('切换平台按钮后更新 Token 标签、占位提示与连接按钮文案', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        // 默认 GitHub
        expect(wrapper.text()).toContain('GitHub Token');
        expect(wrapper.find('.cloud-sync-panel__guest .mnt-base-button').text()).toContain('连接 GitHub');

        // 点击 Gitee 平台按钮
        const providerButtons = wrapper.findAll('.cloud-sync-provider__btn');
        expect(providerButtons).toHaveLength(2);
        await providerButtons[1].trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('Gitee Token');
        expect(wrapper.text()).toContain('gitee.com/profile/personal_access_tokens');
        expect(wrapper.find('.cloud-sync-panel__guest .mnt-base-button').text()).toContain('连接 Gitee');
        // 输入框占位符随平台变化
        expect(wrapper.find('.cloud-sync-panel__guest input').attributes('placeholder')).toBe('xxxxxxxxxxxxxxxx');
    });

    it('已登录时展示「立即同步」与「强制恢复云端」按钮', async () => {
        // 预置登录态；init 会用 provider 验证 Token（mock /user 返回成功）
        await storageManager.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: 'ghp_test',
            [STORAGE_KEYS.CLOUD_GIST_ID]: 'gist_1',
            [STORAGE_KEYS.CLOUD_USER_INFO]: { login: 'tester', id: 1, avatar: 'https://avatar.png' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            status: 200,
            ok: true,
            json: async () => ({ login: 'tester', id: 1, avatar_url: 'https://avatar.png' }),
            text: async () => ''
        }));

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain('已连接');
        expect(text).toContain('立即同步');
        expect(text).toContain('强制恢复云端');
        expect(text).toContain('断开连接');

        vi.unstubAllGlobals();
    });

    /** 预置登录态（init 会用 provider 验证 Token） */
    async function prepareLoggedIn(): Promise<void> {
        await storageManager.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: 'ghp_test',
            [STORAGE_KEYS.CLOUD_GIST_ID]: 'gist_1',
            [STORAGE_KEYS.CLOUD_USER_INFO]: { login: 'tester', id: 1, avatar: 'https://avatar.png' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            status: 200,
            ok: true,
            json: async () => ({ login: 'tester', id: 1, avatar_url: 'https://avatar.png' }),
            text: async () => ''
        }));
    }

    it('已登录时展示「浏览器同步」区块', async () => {
        await prepareLoggedIn();

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        expect(wrapper.text()).toContain('浏览器同步');
        expect(wrapper.text()).toContain('开启浏览器同步');
        // 默认未开启：不展示密码输入
        expect(wrapper.text()).not.toContain('同步密码只保存在本机');

        vi.unstubAllGlobals();
    });

    it('未登录时也展示「浏览器同步」区块（修复：卡片上没有这个功能）', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        // 未登录态仍然可以开启浏览器同步：先设密码，登录后自动补推凭据
        expect(wrapper.find('.cloud-sync-cross').exists()).toBe(true);
        expect(wrapper.text()).toContain('开启浏览器同步');
        expect(wrapper.text()).toContain('登录同一浏览器账号的其他设备');
    });

    it('勾选「开启浏览器同步」后展开密码输入，密码过短时不提交', async () => {
        await prepareLoggedIn();

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const toggle = wrapper.find('.cloud-sync-cross .cloud-sync-toggle input[type="checkbox"]');
        expect(toggle.exists()).toBe(true);

        await toggle.setValue(true);
        await flushPromises();

        expect(wrapper.text()).toContain('同步密码只保存在本机');
        expect(wrapper.text()).toContain('开启并加密同步');

        // 密码为空时点击启用：只提示（Toast 由外层容器渲染），不应真正开启
        const enableBtn = wrapper
            .findAll('.cloud-sync-cross .mnt-base-button')
            .find((btn) => btn.text().includes('开启并加密同步'));
        expect(enableBtn).toBeTruthy();
        await enableBtn!.trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('开启并加密同步');
        expect(wrapper.text()).not.toContain('已开启 · ');

        vi.unstubAllGlobals();
    });

    it('未登录也能开启浏览器同步：密码写入本机，开关变为已开启', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const toggle = wrapper.find('.cloud-sync-cross .cloud-sync-toggle input[type="checkbox"]');
        await toggle.setValue(true);
        await flushPromises();

        await wrapper.find('.cloud-sync-cross input[type="password"]').setValue('my-sync-pass');
        const enableBtn = wrapper
            .findAll('.cloud-sync-cross .mnt-base-button')
            .find((btn) => btn.text().includes('开启并加密同步'));
        await enableBtn!.trigger('click');

        // 启用包含 PBKDF2 密钥派生（异步耗时），等待真实写入完成
        await vi.waitFor(() => {
            expect(localStorage.getItem('appNavigator_crossDevice_enabled')).toBe('true');
        });
        await flushPromises();

        // 未登录时只保存开关与密码，等登录后由 CloudSyncService 自动补推
        expect(localStorage.getItem('appNavigator_crossDevice_passphrase')).toBe('my-sync-pass');
        expect(wrapper.text()).toContain('已开启');
        expect(wrapper.text()).toContain('登录后会把登录状态加密写入同步区');
        // 同步区诊断：明确告知「凭据暂无」，而不是让用户以为已经同步好了
        expect(wrapper.text()).toContain('凭据：暂无');
        expect(wrapper.text()).toContain('重新检查');
    });

    it('同步区已有其他设备凭据时提示「恢复登录状态」', async () => {
        // 模拟另一台设备：本机没有开关与密码，但同步区已有密文
        await enableCrossDevice('my-sync-pass', { token: 'ghp_other_device', provider: 'github' });
        localStorage.removeItem('appNavigator_crossDevice_enabled');
        localStorage.removeItem('appNavigator_crossDevice_passphrase');

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        expect(wrapper.text()).toContain('检测到其他设备的登录状态');
        expect(wrapper.text()).toContain('恢复登录状态');
        // 诊断行显示凭据来源
        expect(wrapper.text()).toContain('凭据：有');
    });

    it('新设备用同一密码「开启」时自动恢复登录状态（不必再点恢复）', async () => {
        // 设备 A：登录后推送凭据
        await enableCrossDevice('my-sync-pass', { token: 'ghp_other_device', provider: 'github' });
        // 设备 B：本机没有开关与密码，只有同步区密文
        localStorage.removeItem('appNavigator_crossDevice_enabled');
        localStorage.removeItem('appNavigator_crossDevice_passphrase');

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const body = url.endsWith('/user')
                ? { login: 'tester', id: 1, avatar_url: 'https://avatar.png' }
                : url.includes('/gists?')
                    ? []
                    : { id: 'gist_1', files: {} };
            return {
                status: 200,
                ok: true,
                json: async () => body,
                text: async () => JSON.stringify(body)
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock);

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        // 放弃「恢复」提示，改走「直接开启」
        const skip = wrapper
            .findAll('.cloud-sync-cross .mnt-base-button')
            .find((btn) => btn.text().includes('直接开启'));
        expect(skip).toBeTruthy();
        await skip!.trigger('click');
        await flushPromises();

        await wrapper.find('.cloud-sync-cross input[type="password"]').setValue('my-sync-pass');
        const enableBtn = wrapper
            .findAll('.cloud-sync-cross .mnt-base-button')
            .find((btn) => btn.text().includes('开启并加密同步'));
        await enableBtn!.trigger('click');

        // 开启后会尝试用同一密码解密同步区里的凭据并直接登录
        await vi.waitFor(() => {
            expect(wrapper.text()).toContain('已连接');
        });

        vi.unstubAllGlobals();
    });

    describe('同步区补推与恢复码', () => {
        afterEach(() => {
            delete (window as unknown as { chrome?: unknown }).chrome;
        });

        /** 只找文案精确匹配的按钮，避免「恢复登录」误命中「用恢复码恢复登录」 */
        function findButton(wrapper: ReturnType<typeof mount>, text: string, exact = true) {
            return wrapper
                .findAll('.mnt-base-button')
                .find((btn) => (exact ? btn.text().trim() === text : btn.text().includes(text)));
        }

        /** 判定「同步区没凭据」要区分本机模拟与真实浏览器账号同步区，这里造一个原生环境 */
        function installNativeSyncArea(): { store: Record<string, unknown>; failWrites: boolean } {
            const api = {
                store: {} as Record<string, unknown>,
                failWrites: false
            };
            (window as unknown as { chrome?: unknown }).chrome = {
                storage: {
                    sync: {
                        get: (key: string, cb: (items: Record<string, unknown>) => void) => {
                            cb(key in api.store ? { [key]: api.store[key] } : {});
                        },
                        set: (items: Record<string, unknown>, cb: () => void) => {
                            // failWrites 模拟「调用没报错，但同步区里就是没有」：配额满、账号同步刚关掉等
                            if (!api.failWrites) Object.assign(api.store, items);
                            cb();
                        },
                        remove: (key: string, cb: () => void) => {
                            delete api.store[key];
                            cb();
                        }
                    },
                    onChanged: { addListener: () => {}, removeListener: () => {} }
                },
                runtime: {}
            };
            return api;
        }

        /** 恢复码要等 PBKDF2 派生完成才有内容，只等区块渲染出来会读到空串 */
        async function waitForRecoveryCode(wrapper: ReturnType<typeof mount>): Promise<string> {
            await vi.waitFor(() => {
                const box = wrapper.find('.cloud-sync-cross__code').element as HTMLTextAreaElement;
                expect(box.value.startsWith('HANTAB1.')).toBe(true);
            });
            return (wrapper.find('.cloud-sync-cross__code').element as HTMLTextAreaElement).value;
        }

        it('已开启、已登录但同步区为空时如实说明并给出「重试写入同步区」', async () => {
            // 先在没有原生同步区的环境里开启（凭据写进了本机模拟区）
            await prepareLoggedIn();
            await enableCrossDevice('my-sync-pass', { token: 'ghp_test', provider: 'github' });

            // 换到原生同步区且写入不落地，等价于「启动时补推也没成」
            const syncArea = installNativeSyncArea();
            syncArea.failWrites = true;

            const wrapper = mount(CloudSyncPanel);
            await vi.waitFor(() => {
                expect(wrapper.text()).toContain('已开启 · 但同步区还没有凭据，上一次写入没成功');
            });
            expect(wrapper.text()).not.toContain('登录状态已加密写入浏览器同步区');
            expect(findButton(wrapper, '重试写入同步区')).toBeTruthy();

            syncArea.failWrites = false;
            await findButton(wrapper, '重试写入同步区')!.trigger('click');
            await vi.waitFor(() => {
                expect(wrapper.text()).toContain('已开启 · 登录状态已加密写入浏览器同步区');
            });
            expect(Object.keys(syncArea.store).some((key) => key.includes('cross_device'))).toBe(true);
            // 补推成功后按钮消失，不再对着已经写好的凭据喊重试
            expect(findButton(wrapper, '重试写入同步区')).toBeUndefined();

            vi.unstubAllGlobals();
        });

        it('本机模拟同步区：凭据在就照说在，不显示「重试写入同步区」', async () => {
            await prepareLoggedIn();
            await enableCrossDevice('my-sync-pass', { token: 'ghp_test', provider: 'github' });

            const wrapper = mount(CloudSyncPanel);
            await vi.waitFor(() => {
                expect(wrapper.text()).toContain('凭据在本机模拟同步区（预览环境不会同步到其他设备）');
            });
            expect(findButton(wrapper, '重试写入同步区')).toBeUndefined();

            // 清掉模拟同步区里的凭据，只留本机开关与密码：改成「写不进去」的口径
            for (const key of Object.keys(localStorage)) {
                if (key.startsWith('__mnt_sync__:haha_cross_device')) {
                    localStorage.removeItem(key);
                }
            }
            await wrapper.find('.cloud-sync-cross__refresh').trigger('click');
            await vi.waitFor(() => {
                expect(wrapper.text()).toContain('当前环境无法写入浏览器同步区');
            });
            expect(wrapper.text()).toContain('凭据：暂无');
            expect(findButton(wrapper, '重试写入同步区')).toBeUndefined();

            vi.unstubAllGlobals();
        });

        it('「导出恢复码」生成一段可解回的密文', async () => {
            await prepareLoggedIn();
            await enableCrossDevice('my-sync-pass', { token: 'ghp_test', provider: 'github' });

            const wrapper = mount(CloudSyncPanel);
            await flushPromises();

            await findButton(wrapper, '导出恢复码')!.trigger('click');

            const code = await waitForRecoveryCode(wrapper);
            // 恢复码里不能夹带明文 Token
            expect(code).not.toContain('ghp_test');

            vi.unstubAllGlobals();
        });

        it('卸载重装后：用恢复码 + 同步密码恢复登录', async () => {
            await prepareLoggedIn();
            await enableCrossDevice('my-sync-pass', { token: 'ghp_test', provider: 'github' });

            const first = mount(CloudSyncPanel);
            await flushPromises();
            await findButton(first, '导出恢复码')!.trigger('click');
            const code = await waitForRecoveryCode(first);
            first.unmount();
            vi.unstubAllGlobals();

            // 卸载扩展：本机存储与同步区一起清空
            localStorage.clear();

            // 重装后的新面板：未登录，只留下用户自己保存的恢复码
            const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                const body = url.endsWith('/user')
                    ? { login: 'tester', id: 1, avatar_url: 'https://avatar.png' }
                    : url.includes('/gists?')
                        ? []
                        : { id: 'gist_1', files: {} };
                return {
                    status: 200,
                    ok: true,
                    json: async () => body,
                    text: async () => JSON.stringify(body)
                } as Response;
            });
            vi.stubGlobal('fetch', fetchMock);

            const wrapper = mount(CloudSyncPanel);
            await flushPromises();

            await findButton(wrapper, '用恢复码恢复登录')!.trigger('click');
            await flushPromises();
            expect(wrapper.text()).toContain('粘贴当初保存的恢复码');

            // 只粘码不给密码：拦在本地，不发请求
            await wrapper
                .find('.cloud-sync-cross__recovery textarea')
                .setValue(code);
            await findButton(wrapper, '恢复登录')!.trigger('click');
            await flushPromises();
            expect(wrapper.text()).toContain('未连接');
            expect(fetchMock).not.toHaveBeenCalled();

            await wrapper
                .find('.cloud-sync-cross__recovery input[type="password"]')
                .setValue('my-sync-pass');
            await findButton(wrapper, '恢复登录')!.trigger('click');

            await vi.waitFor(() => {
                expect(wrapper.text()).toContain('已连接');
            });
            // 恢复走的是码里的 Token，用户不需要再填一遍
            expect(fetchMock.mock.calls.some(([req]) => String(req).endsWith('/user'))).toBe(true);
            expect(localStorage.getItem('appNavigator_crossDevice_passphrase')).toBe('my-sync-pass');

            vi.unstubAllGlobals();
        });
    });
});
