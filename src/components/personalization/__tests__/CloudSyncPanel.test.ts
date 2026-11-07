/**
 * CloudSyncPanel 测试
 * 覆盖：未登录态的 OAuth 授权入口与 Client ID 配置、设备码展示与取消、
 * 已登录态操作按钮（「立即同步」双向合并、「强制恢复云端」兜底）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CloudSyncPanel from '@/components/personalization/CloudSyncPanel.vue';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';

function createResponse(body: unknown, status = 200): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    } as Response;
}

function findButton(wrapper: ReturnType<typeof mount>, text: string) {
    return wrapper.findAll('.mnt-base-button').find(button => button.text().includes(text));
}

describe('CloudSyncPanel', () => {
    beforeEach(() => {
        localStorage.clear();
        setActivePinia(createPinia());
        browserApi.resetDetection();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('未配置 Client ID 时展示配置入口并禁用授权按钮', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain('云同步');
        expect(text).toContain('未连接');
        expect(text).toContain('通过 GitHub 授权登录');
        expect(text).toContain('OAuth App Client ID');
        expect(text).toContain('使用 GitHub 登录');
        expect(findButton(wrapper, '使用 GitHub 登录')?.attributes('disabled')).toBeDefined();
    });

    it('保存 Client ID 后可以一键授权', async () => {
        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        await wrapper.find('.cloud-sync-oauth-config input').setValue('Iv1.frompanel');
        const saveButton = findButton(wrapper, '保存');
        expect(saveButton).toBeDefined();
        await saveButton!.trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('Iv1.…anel');
        expect(findButton(wrapper, '使用 GitHub 登录')?.attributes('disabled')).toBeUndefined();
        expect(await storageManager.get(STORAGE_KEYS.CLOUD_OAUTH_CLIENT_ID)).toBe('Iv1.frompanel');
    });

    it('发起授权时展示用户码与授权页链接，取消后回到初始态', async () => {
        await storageManager.set(STORAGE_KEYS.CLOUD_OAUTH_CLIENT_ID, 'Iv1.savedclient');
        const fetchMock = vi.fn().mockResolvedValue(createResponse({
            device_code: 'dc_123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 5,
            expires_in: 900
        }));
        vi.stubGlobal('fetch', fetchMock);

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        await findButton(wrapper, '使用 GitHub 登录')!.trigger('click');
        await flushPromises();

        expect(fetchMock.mock.calls[0][0]).toBe('https://github.com/login/device/code');
        expect(wrapper.text()).toContain('ABCD-1234');
        expect(wrapper.find('.cloud-sync-oauth-code').text()).toBe('ABCD-1234');
        expect(wrapper.find('.cloud-sync-oauth-link').attributes('href'))
            .toBe('https://github.com/login/device');

        await findButton(wrapper, '取消')!.trigger('click');
        await flushPromises();

        expect(wrapper.find('.cloud-sync-oauth-code').exists()).toBe(false);
        expect(wrapper.text()).toContain('使用 GitHub 登录');
        wrapper.unmount();
    });

    it('已登录时展示「立即同步」与「强制恢复云端」按钮', async () => {
        await storageManager.setMany({
            [STORAGE_KEYS.CLOUD_TOKEN]: 'gho_test',
            [STORAGE_KEYS.CLOUD_GIST_ID]: 'gist_1',
            [STORAGE_KEYS.CLOUD_USER_INFO]: { login: 'tester', id: 1, avatar: 'https://avatar.png' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createResponse({
            login: 'tester', id: 1, avatar_url: 'https://avatar.png'
        })));

        const wrapper = mount(CloudSyncPanel);
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain('已连接');
        expect(text).toContain('立即同步');
        expect(text).toContain('强制恢复云端');
        expect(text).toContain('断开连接');
    });
});
