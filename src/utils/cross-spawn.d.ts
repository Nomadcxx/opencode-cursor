declare module "cross-spawn" {
  const spawn: typeof import("node:child_process").spawn & {
    sync: typeof import("node:child_process").spawnSync;
  };
  export default spawn;
}
