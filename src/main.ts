import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { initializeStorage } from '@/services/storageLifecycle';
import '@/styles/global.scss';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

// 异步维护，不阻塞首屏；失败只是少回收一点配额，不影响功能
void initializeStorage().catch(() => undefined);
