import { expect, test } from "bun:test";
import { acquireStore, resolveStateRoot } from "../../scripts/sdk-runner.mjs";
import { assertSdkNodeVersion } from "../../src/client/sdk-child.js";

test("shares a workspace store until its last active request releases it", async () => {
  let opened=0,disposed=0;
  const store={dispose:async()=>{disposed++;}};
  const Store={open:async()=>{opened++;return store;}};
  const [a,b]=await Promise.all([acquireStore('/workspace',Store,'shared-root'),acquireStore('/workspace',Store,'shared-root')]);
  expect(opened).toBe(1);
  expect(a!.store).toBe(b!.store);
  await a!.release();expect(disposed).toBe(0);
  await b!.release();expect(disposed).toBe(1);
  const next=await acquireStore('/workspace',Store,'shared-root');
  expect(opened).toBe(2);await next!.release();
});

test("waits for old store disposal before reopening the same root", async () => {
  let finish!:()=>void;
  let opened=0;
  const closing=new Promise<void>(resolve=>{finish=resolve;});
  const Store={open:async()=>{opened++;return {dispose:()=>closing};}};
  const a=await acquireStore('/workspace',Store,'closing-root');
  const released=a!.release();
  const b=acquireStore('/workspace',Store,'closing-root');
  await Promise.resolve();expect(opened).toBe(1);
  finish();await released;
  const next=await b;expect(opened).toBe(2);await next!.release();
});

test("failed store opens report remediation and allow a later retry", async () => {
  const failing={open:async()=>{throw new Error('access denied');}};
  await expect(acquireStore('/workspace',failing,'failed-root')).rejects.toThrow('failed-root');
  await expect(acquireStore('/workspace',failing,'failed-root')).rejects.toThrow('CURSOR_ACP_SDK_STATE_ROOT');
  const lease=await acquireStore('/workspace',{open:async()=>({dispose:async()=>{}})},'failed-root');
  expect(lease).toBeDefined();await lease!.release();
});

test("Windows workspace aliases resolve to the same short store root", () => {
  expect(resolveStateRoot('C:\\Work\\Project',{},'win32','C:\\Users\\me')).toBe(
    resolveStateRoot('c:/work/./project',{},'win32','C:\\Users\\me'),
  );
});

test("SDK runtime requires Node 22.13 while CLI compatibility remains independent", () => {
  for (const version of ['v18.20.8','v20.19.0','v22.12.0','garbage']) {
    expect(()=>assertSdkNodeVersion(version)).toThrow('Node >=22.13');
  }
  for (const version of ['v22.13.0','v22.20.0','v24.14.0']) {
    expect(()=>assertSdkNodeVersion(version)).not.toThrow();
  }
});
