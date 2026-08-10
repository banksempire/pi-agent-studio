<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useChatStore, type DirNode } from '../store/chat';

const store = useChatStore();

// The tree is fetched ONCE (store.loadTree) and kept fresh by backend SSE
// pushes — remounting this section never refetches. Expand/collapse state
// lives in the store too, so flipping sections or panels preserves it.
onMounted(() => {
  if (!store.tree) void store.loadTree();
});

/** Flattened rows (indent by depth) honoring the store's collapsed set. */
const flat = computed<{ node: DirNode; depth: number }[]>(() => {
  const out: { node: DirNode; depth: number }[] = [];
  const walk = (n: DirNode, depth: number) => {
    out.push({ node: n, depth });
    if (n.children.length && !store.treeCollapsed.has(n.path)) {
      for (const c of n.children) walk(c, depth + 1);
    }
  };
  if (store.tree) walk(store.tree, 0);
  return out;
});

/** Click a folder: filter the chat lists to it; click again to clear. */
function select(node: DirNode) {
  store.setCwdFilter(store.cwdFilter === node.path ? null : node.path);
}
</script>

<template>
  <div class="dir-tree">
    <div v-if="!store.tree" class="dir-tree-empty">Loading directories…</div>
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
        :class="{ 'dir-node-toggle--open': !store.treeCollapsed.has(node.path) }"
        @click.stop="store.toggleTreeCollapsed(node.path)"
      >{{ node.children.length ? '❯' : '·' }}</span>
      <span class="dir-node-name">{{ node.name }}</span>
      <span class="dir-node-count">{{ node.count }}</span>
    </div>
  </div>
</template>
