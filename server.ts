/**
 * OpenCode V2 local-plugin entrypoint.
 *
 * The host resolves a local plugin *directory* by probing `<dir>/server`
 * (then `<dir>/index`) with native module resolution — package.json exports
 * are only honoured for installed npm packages. Keeping this file means a
 * `"F:/code/jev-model-picker"` config entry resolves here, which re-exports
 * the real plugin from `src/index.ts`.
 *
 * When installed from npm, the host instead uses the package's
 * `"./server"` export, which also points at `src/index.ts`.
 */
export { default } from "./src/index";
