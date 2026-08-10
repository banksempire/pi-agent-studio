<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useChatStore } from '../store/chat';

interface DirNode {
  name: string;
  path: string;
  /** recursive: how many sessions live under this folder */
  count: number;
  children: DirNode[];
}

const store = useChatStore();
const tree = ref<DirNode | null>(null);
const collapsed = ref<Set<string>>(new Set());

async function load() {
  try {
    const res = await fetch('/api/tree');
    const j = await res.json();
    if (j && typeof j.name === 'string') {
      tree.value = j;
      // Everything collapsed by default: only the root (and the flat
      // outside-CWD session dirs) is visible until a branch is expanded.
      const s = new Set<string>();
      const collapseAll = (n: DirNode) => {
        if (n.children.length) {
          s.add(n.path);
          for (const c of n.children) collapseAll(c);
        }
      };
      collapseAll(j);
      collapsed.value = s;
    }
  } catch { /* backend offline — keep the last tree */ }
}

onMounted(load);
// Counts change as sessions appear or are deleted.
watch(() => store.sessions.length, () => { void load(); });

/** Flattened rows (indent by depth) honoring the collapsed set. */
const flat = computed<{ node: DirNode; depth: number }[]>(() => {
  const out: { node: DirNode; depth: number }[] = [];
  const walk = (n: DirNode, depth: number) => {
    out.push({ node: n, depth });
    if (n.children.length && !collapsed.value.has(n.path)) {
      for (const c of n.children) walk(c, depth + 1);
    }
  };
  if (tree.value) walk(tree.value, 0);
  return out;
});

function toggle(node: DirNode) {
  if (!node.children.length) return;
  const next = new Set(collapsed.value);
  if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
  collapsed.value = next;
}

/** Click a folder: filter the chat lists to it; click again to clear. */
function select(node: DirNode) {
  store.setCwdFilter(store.cwdFilter === node.path ? null : node.path);
}
</script>

<template>
  <div class="dir-tree">
    <div v-if="!tree" class="dir-tree-empty">Loading directories…</div>
    <div
      v-for="{ node, depth } in flat"
      :key="node.path"
      class="dir-node"
      :class="{ 'dir-node--active': store.cwdFilter === node.path }"
      :style="{ paddingLeft: 6 + depth * 12 + 'px' }"
      :title="'Filter chats under ' + node.path"
      @click="select(node)"
    >
      <span
        class="dir-node-toggle"
        :class="{ 'dir-node-toggle--open': !collapsed.has(node.path) }"
        @click.stop="toggle(node)"
      >{{ node.children.length ? '❯' : '·' }}</span>
      <span class="dir-node-name">{{ node.name }}</span>
      <span class="dir-node-count">{{ node.count }}</span>
    </div>
  </div>
</template>