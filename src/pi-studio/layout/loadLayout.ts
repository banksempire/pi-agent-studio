import { loadLayout as loadFrameworkLayout } from '@sf/layout/loadLayout';
import json from './app.layout.json';

export const layout = loadFrameworkLayout(json, 'app.layout.json');
