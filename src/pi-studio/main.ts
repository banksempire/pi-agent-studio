import { createApp } from 'vue';
import '@sf/styles/main.css';
import './styles/app.css';

import WorkspacePanel from '@sf/components/WorkspacePanel.vue';
import { registerPanelComponent, registerStatusComponent, registerTabContent } from '@sf/registry';
import BackendStatus from './components/BackendStatus.vue';
import ChatWindow from './components/ChatWindow.vue';
import JobsTab from './components/JobsTab.vue';
import ModelCatalog from './components/ModelCatalog.vue';
import PeakHoursTab from './components/PeakHoursTab.vue';
import WelcomeContent from './components/WelcomeContent.vue';
import './layout/panelData';
import StudioShell from './shell/StudioShell.vue';

registerTabContent('welcome', WelcomeContent);
registerTabContent('chat-window', ChatWindow);
registerTabContent('jobs', JobsTab);
registerTabContent('model-catalog', ModelCatalog);
registerTabContent('peak-hours', PeakHoursTab);

registerStatusComponent('backend-status', BackendStatus);

registerPanelComponent('workspace-panel', WorkspacePanel);

createApp(StudioShell).mount('#app');
