import { registerWorkspaceStorage } from '@sf/workspace/manager';
import type { WorkspaceSnapshot } from '@sf/workspace/snapshots';
import { api } from './store/chat';

export interface WorkspaceMeta {
  id: string;
  name: string;
  savedAt: number;
  tiles: number;
  tabs: number;
  windows: number;
}

export interface WorkspacePatch {
  name?: string;
  snapshot?: WorkspaceSnapshot;
}

registerWorkspaceStorage({
  async list() {
    const j = await api<{ workspaces: WorkspaceMeta[] }>('/api/workspaces');
    return j.workspaces ?? [];
  },
  async load(id) {
    const j = await api<{ workspace: { snapshot: WorkspaceSnapshot } }>(
      `/api/workspaces/${encodeURIComponent(id)}`,
    );
    return j.workspace.snapshot;
  },
  async save(name, snapshot) {
    const j = await api<{ workspace: WorkspaceMeta }>('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, snapshot }),
    });
    return j.workspace;
  },
  async update(id, patch: WorkspacePatch) {
    const j = await api<{ workspace: WorkspaceMeta }>(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return j.workspace;
  },
  async delete(id) {
    await api<{ ok: boolean }>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
});
