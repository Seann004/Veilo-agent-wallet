<script setup lang="ts">
import { onMounted, ref, useId } from 'vue'
const props = defineProps<{ source: string; caption: string }>()
const markup = ref('')
const failed = ref(false)
const diagramId = `diagram-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
onMounted(async () => {
  try {
    const { default: mermaid } = await import('mermaid')
    // Measure labels after the documentation fonts have finished loading.
    await document.fonts.ready
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
      fontFamily: 'system-ui, sans-serif',
      htmlLabels: false,
      themeVariables: { fontSize: '16px' },
      flowchart: { useMaxWidth: true, htmlLabels: false, padding: 22 },
      sequence: { useMaxWidth: true, wrap: true, diagramMarginX: 24, diagramMarginY: 24 } })
    const result = await mermaid.render(diagramId, props.source)
    markup.value = result.svg
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <figure class="diagram">
    <div v-if="markup" class="diagram-canvas" :class="{ 'diagram-canvas--sequence': source.trimStart().startsWith('sequenceDiagram') }" tabindex="0" role="region" :aria-label="caption" v-html="markup" />
    <p v-else-if="failed" role="status">Diagram unavailable. The diagram source and written explanation are below.</p>
    <figcaption>{{ caption }} <span v-if="markup">Scroll horizontally if the diagram is wider than the page.</span></figcaption>
    <details :open="!markup">
      <summary>Text diagram source</summary>
      <pre>{{ source }}</pre>
    </details>
  </figure>
</template>

<style scoped>
.diagram { margin: 1.5rem 0; }
.diagram-canvas { background: #fff; color: #222; border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 16px; overflow-x: auto; }
.diagram-canvas :deep(svg) { display: block; min-width: 480px; max-width: none !important; margin: auto; overflow: visible; }
.diagram-canvas:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
.diagram-canvas--sequence :deep(svg) { min-width: 1200px; }
figcaption { font-size: .875rem; color: var(--vp-c-text-2); margin: .75rem 0; }
summary { cursor: pointer; padding: .5rem 0; }
summary:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
pre { overflow-x: auto; font-size: .8rem; padding: .75rem; background: var(--vp-c-bg-soft); }
</style>
