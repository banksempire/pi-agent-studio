<script setup lang="ts">
import SvgIcon from '@sf/components/SvgIcon.vue';
import { computed, onMounted } from 'vue';
import { type DirNode, useChatStore } from '../store/chat';

const store = useChatStore();

onMounted(() => {
  if (!store.tree) void store.loadTree();
});

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

function allSelected(n: DirNode): boolean {
  if (store.selectedDirs.has(n.path)) return true;
  if (n.children.length === 0) return false;
  return n.children.every(allSelected);
}

function checkState(node: DirNode): 'on' | 'mid' | 'off' {
  if (store.selectedDirs.has(node.path) || allSelected(node)) return 'on';
  const walk = (n: DirNode): boolean => {
    if (store.selectedDirs.has(n.path)) return true;
    for (const c of n.children) if (walk(c)) return true;
    return false;
  };
  for (const c of node.children) if (walk(c)) return 'mid';
  return 'off';
}
</script>

<template>
  <div class="dir-tree">
    <div v-if="!store.tree" class="dir-tree-empty">Loading directories…</div>
    <div
      v-for="{ node, depth } in flat"
      :key="node.path"
      class="dir-node"
      :class="{
        'dir-node--checked': checkState(node) === 'on',
        'dir-node--indet': checkState(node) === 'mid',
      }"
      :style="{ paddingLeft: 4 + depth * 12 + 'px' }"
      :title="'Filter chats under ' + node.path"
      @click="store.toggleDir(node.path)"
    >
      <span
        class="dir-check"
        :class="{
          'dir-check--on': checkState(node) === 'on',
          'dir-check--mid': checkState(node) === 'mid',
        }"
      ><SvgIcon v-if="checkState(node) === 'on'" name="✓" /><SvgIcon v-else-if="checkState(node) === 'mid'" name="–" /></span>
      <span
        class="dir-node-toggle"
        :class="{ 'dir-node-toggle--open': !store.treeCollapsed.has(node.path) }"
        @click.stop="store.toggleTreeCollapsed(node.path)"
      ><SvgIcon v-if="node.children.length" name="❯" /><span v-else class="dir-leaf-dot">·</span></span>
      <span class="dir-node-name">{{ node.name }}</span>
      <span class="dir-node-count">{{ node.count }}</span>
    </div>
  </div>
</template>
