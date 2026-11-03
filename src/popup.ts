import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PopupApp from './PopupApp.vue';
import { cleanupLegacyStorageKeys } from '@/services/storage.service';
import '@/styles/global.scss';

const app = createApp(PopupApp);
app.use(createPinia());
app.mount('#app');

// 异步清理，不阻塞弹窗打开；失败只是少回收一点配额，不影响功能
void cleanupLegacyStorageKeys().catch(() => undefined);
