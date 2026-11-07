/**
 * OAuth Client ID 配置单测：构建期默认值与本机覆盖值的关系
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { builtInClientId, loadClientId, saveClientId } from '../oauthConfig';
import { storageManager } from '@/services/storage.service';
import { browserApi } from '@/services/browserApi.service';
import { STORAGE_KEYS } from '@/types/storage';

describe('OAuth Client ID 配置', () => {
    beforeEach(() => {
        localStorage.clear();
        browserApi.resetDetection();
    });

    it('没有本机配置时退回构建期默认值', async () => {
        expect(await loadClientId()).toBe(builtInClientId());
    });

    it('保存后读取覆盖值，并去掉首尾空白', async () => {
        await saveClientId('  Iv1.frompanel  ');

        expect(await loadClientId()).toBe('Iv1.frompanel');
        expect(await storageManager.get(STORAGE_KEYS.CLOUD_OAUTH_CLIENT_ID)).toBe('Iv1.frompanel');
    });

    it('空串清掉覆盖值，退回默认值', async () => {
        await saveClientId('Iv1.frompanel');
        await saveClientId('');

        expect(await loadClientId()).toBe(builtInClientId());
    });
});
