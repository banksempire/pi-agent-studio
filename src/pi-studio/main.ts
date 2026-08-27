import { createApp } from 'vue';
import '@sf/styles/main.css';
import './styles/app.css';

import WorkspacePanel from '@sf/components/WorkspacePanel.vue';
import { registerPanelComponent, registerStatusComponent, registerTabContent } from '@sf/registry';
import BackendStatus from './components/BackendStatus.vue';
import ChatHistory from './components/ChatHistory.vue';
import ChatSessions from './components/ChatSessions.vue';
import ChatWindow from './components/ChatWindow.vue';
import DirectoryTree from './components/DirectoryTree.vue';
import JobEditor from './components/JobEditor.vue';
import JobsPanel from './components/JobsPanel.vue';
import ModelCatalog from './components/ModelCatalog.vue';
import ModelDetail from './components/ModelDetail.vue';
import ModelPicker from './components/ModelPicker.vue';
import ModelPreference from './components/ModelPreference.vue';
import PrefsPanel from './components/PrefsPanel.vue';
import SessionStats from './components/SessionStats.vue';
import WelcomeContent from './components/WelcomeContent.vue';
import StudioShell from './shell/StudioShell.vue';

registerTabContent('welcome', WelcomeContent);
registerTabContent('chat-window', ChatWindow);
registerTabContent('job-editor', JobEditor);
registerTabContent('model-catalog', ModelCatalog);

registerPanelComponent('chat-history', ChatHistory);
registerPanelComponent('chat-sessions', ChatSessions);
registerPanelComponent('directory-tree', DirectoryTree);
registerPanelComponent('session-stats', SessionStats);
registerStatusComponent('backend-status', BackendStatus);
registerPanelComponent('model-picker', ModelPicker);
registerPanelComponent('model-detail', ModelDetail);
registerPanelComponent('model-preference', ModelPreference);
registerPanelComponent('prefs', PrefsPanel);
registerPanelComponent('jobs-panel', JobsPanel);

registerPanelComponent('workspace-panel', WorkspacePanel);

createApp(StudioShell).mount('#app');
