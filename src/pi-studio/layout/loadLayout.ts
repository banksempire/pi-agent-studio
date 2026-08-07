import { loadLayout as loadFrameworkLayout } from '@sf/layout/loadLayout';
import json from './app.layout.json';

/**
 * The pi-agent-studio layout — validated/normalized by the framework's
 * loader, so the whole UI (menu, docker, panels, workspace, status bar)
 * stays driven by this single JSON file.
 */
export const layout = loadFrameworkLayout(json, 'app.layout.json');
