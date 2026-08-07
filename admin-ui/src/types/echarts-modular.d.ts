/* Type declarations for echarts' modular subpath imports.
 *
 * echarts ships `.d.ts` files for `core`, `charts`, `components` and
 * `renderers`, but its package.json `exports` map exposes only `"./core"`
 * → `"./core.js"` with no `types` condition. Under TypeScript's bundler
 * module resolution the declaration files therefore aren't resolved and
 * the imports fail with TS2307.
 *
 * This shim types the four subpaths explicitly. The runtime modules are
 * real (Vite resolves them via the exports map), so tree-shaking is
 * unaffected — this only satisfies the type checker.
 */
declare module "echarts/core" {
  export * from "echarts/types/dist/core"
  export { init, use } from "echarts/types/dist/core"
  import * as echarts from "echarts/types/dist/core"
  export default echarts
}

declare module "echarts/charts" {
  export * from "echarts/types/dist/charts"
  export { SankeyChart } from "echarts/types/dist/charts"
}

declare module "echarts/components" {
  export * from "echarts/types/dist/components"
  export { TooltipComponent } from "echarts/types/dist/components"
}

declare module "echarts/renderers" {
  export * from "echarts/types/dist/renderers"
  export { CanvasRenderer } from "echarts/types/dist/renderers"
}
