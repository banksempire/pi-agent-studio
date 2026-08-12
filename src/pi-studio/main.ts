import { createApp } from 'vue';
import '@sf/styles/main.css';
import './styles/app.css';

import { registerPanelComponent, registerStatusComponent, registerTabContent } from '@sf/registry';

import StudioShell from './shell/StudioShell.vue';
import WorkspacePanel from '@sf/components/WorkspacePanel.vue';
import ChatWindow from './components/ChatWindow.vue';
import WelcomeContent from './components/WelcomeContent.vue';
import ChatHistory from './components/ChatHistory.vue';
import ChatSessions from './components/ChatSessions.vue';
import DirectoryTree from './components/DirectoryTree.vue';
import SessionStats from './components/SessionStats.vue';
import BackendStatus from './components/BackendStatus.vue';
import ModelPicker from './components/ModelPicker.vue';
import PrefsPanel from './components/PrefsPanel.vue';

// ── Register content renderers referenced by the layout JSON ──────────────

// Workspace tab content
registerTabContent('welcome', WelcomeContent);
registerTabContent('chat-window', ChatWindow);

// Custom panel components
registerPanelComponent('chat-history', ChatHistory);
registerPanelComponent('chat-sessions', ChatSessions);
registerPanelComponent('directory-tree', DirectoryTree);
registerPanelComponent('session-stats', SessionStats);
registerStatusComponent('backend-status', BackendStatus);
registerPanelComponent('model-picker', ModelPicker);
registerPanelComponent('prefs', PrefsPanel);

// The Workspace app (docker item "workspace") — saved-workspace management.
registerPanelComponent('workspace-panel', WorkspacePanel);

createApp(StudioShell).mount('#app');
