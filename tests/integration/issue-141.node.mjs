import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "open cursor, 141-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "package.json"), '{"type":"module"}');
const sourceRoot = resolve(process.env.ISSUE_141_SOURCE_ROOT ?? ".");
const build = spawnSync("bun", ["build", "./src/plugin.ts", "./src/client/sdk-child.ts", "--outdir", dir, "--target", "node"], {
  cwd: sourceRoot, encoding: "utf8", timeout: 30_000,
});
assert.equal(build.status, 0, build.stderr);
const pluginURL = pathToFileURL(join(dir, "plugin.js")).href;
const sdkChildURL = pathToFileURL(join(dir, "client/sdk-child.js")).href;

function run(code, env = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: sourceRoot, env: { ...process.env, CURSOR_API_KEY: "", CURSOR_ACP_BACKEND: "auto", ...env },
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("private proxy bypasses the legacy port and uses request credentials and workspaces", () => {
  const runner = join(dir, "sdk-runner.mjs");
  writeFileSync(runner, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      const event={type:'assistant',message:{role:'assistant',content:[{type:'text',text:process.env.CURSOR_API_KEY+'|'+request.cwd+'|'+process.pid}]}};
      console.log(JSON.stringify({id:request.id,event}));
      console.log(JSON.stringify({id:request.id,done:true,exitCode:0}));
    }
  `);
  run(`
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { resolve } from 'node:path';
    const { ensureCursorProxyServer, setStoredApiKey } = await import(${JSON.stringify(pluginURL)});
    const projectA=resolve('issue-141-project-a');
    const projectB=resolve('issue-141-project-b');
    let legacyRequests=0;
    const legacy=createServer((req,res)=>{
      legacyRequests++;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ok:true,workspaceDirectory:projectA}));
    });
    // A running OpenCode may own this port; leave that process alone.
    await new Promise((resolve,reject)=>{
      legacy.once('error',error=>error.code==='EADDRINUSE'?resolve():reject(error));
      legacy.listen(32124,'127.0.0.1',resolve);
    });
    const [a,b]=await Promise.all([
      ensureCursorProxyServer(projectA,undefined,{private:true}),
      ensureCursorProxyServer(projectB,undefined,{private:true}),
    ]);
    assert.equal(a,b,'concurrent 2.0 locations must share their private proxy');
    assert.notEqual(a,'http://127.0.0.1:32124/v1');
    assert.equal(legacyRequests,0,'private startup must not even probe the legacy proxy');
    const missingWorkspace=await fetch(a+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'auto',messages:[]})});
    assert.equal(missingWorkspace.status,400,'private requests must not silently use another project fallback');
    setStoredApiKey('another-host-key');
    const request=async(key,directory,stream=false)=>{
      const headers={'content-type':'application/json','x-opencode-directory':encodeURIComponent(directory)};
      if(key)headers.authorization='Bearer '+key;
      return fetch(a+'/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'auto',messages:[{role:'user',content:'ping'}],stream})});
    };
    const retiredPids=await Promise.all([['key-a',projectA],['key-b',projectB]].map(async([key,directory])=>{
      const response=await request(key,directory);
      assert.equal(response.status,200);
      const body=await response.json();
      const [actualKey,actualDirectory,pid]=body.choices[0].message.content.split('|');
      assert.equal(actualKey,key);
      assert.equal(actualDirectory,directory);
      return Number(pid);
    }));
    const streamed=await request('key-stream',projectB,true);
    assert.equal(streamed.status,200);
    assert.ok((await streamed.text()).includes('key-stream|'),'streaming must use the request key too');
    for(const pid of retiredPids) {
      const deadline=Date.now()+2000;
      while(true) {
        try { process.kill(pid,0); } catch { break; }
        assert.ok(Date.now()<deadline,'completed accounts must not retain SDK processes after a key switch');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    }
    process.env.CURSOR_ACP_BACKEND='sdk';
    assert.equal((await request(undefined,projectA)).status,401,'private proxy must ignore another host stored key');
    process.env.CURSOR_ACP_BACKEND='auto';
    process.env.CURSOR_AGENT_EXECUTABLE=${JSON.stringify(join(dir, "missing-cursor-agent.exe"))};
    const unavailable=await request(undefined,projectA);
    assert.equal(unavailable.status,500);
    assert.match((await unavailable.json()).error,/install cursor-agent or connect a Cursor API key/i);
    const upgraded=await ensureCursorProxyServer(projectA);
    assert.notEqual(upgraded,'http://127.0.0.1:32124/v1','older health payloads must fall back to a new port');
    const c=await ensureCursorProxyServer(resolve('issue-141-project-c'));
    const d=await ensureCursorProxyServer(resolve('issue-141-project-d'));
    assert.notEqual(c,d,'1.x workspace fallback must belong to its own proxy');
    assert.equal((await (await fetch(d.replace('/v1','/health'))).json()).workspaceDirectory,resolve('issue-141-project-d'));
    process.exit(0);
  `, { CURSOR_ACP_SDK_RUNNER_PATH: runner, CURSOR_ACP_REUSE_EXISTING_PROXY: "true" });
});

test("SDK done waits for agent cleanup before idle retirement", () => {
  const runnerURL=pathToFileURL(join(sourceRoot,"scripts/sdk-runner.mjs")).href;
  const result=run(`
    const {handleRequest}=await import(${JSON.stringify(runnerURL)});
    const agent={
      send:async()=>({stream:async function*(){yield {type:'text',text:'answer'};}}),
      [Symbol.asyncDispose]:async()=>{
        console.log(JSON.stringify({marker:'cleanup-started'}));
        await new Promise(resolve=>setTimeout(resolve,20));
        console.log(JSON.stringify({marker:'cleanup-finished'}));
      },
    };
    await handleRequest('fake-key',{id:'cleanup',model:'auto',cwd:'.',prompt:'test'},{create:async()=>agent});
  `);
  const rows=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(rows.findIndex(row=>row.done)>rows.findIndex(row=>row.marker==='cleanup-finished'));
});

test("real SQLite stores share a short root for long workspaces and reopen after disposal", () => {
  const runnerURL=pathToFileURL(join(sourceRoot,"scripts/sdk-runner.mjs")).href;
  run(`
    import assert from 'node:assert/strict';
    import {join} from 'node:path';
    import {SqliteLocalAgentStore} from '@cursor/sdk/sqlite';
    const {acquireStore}=await import(${JSON.stringify(runnerURL)});
    const cwd=join(${JSON.stringify(dir)},...Array(20).fill('deep-workspace'));
    const root=join(${JSON.stringify(dir)},'sqlite');
    const [a,b]=await Promise.all([acquireStore(cwd,SqliteLocalAgentStore,root),acquireStore(cwd,SqliteLocalAgentStore,root)]);
    assert.equal(a.store,b.store);
    await a.release();await b.release();
    const next=await acquireStore(cwd,SqliteLocalAgentStore,root);
    assert.notEqual(next.store,a.store);
    await next.release();
  `);
});

test("SDK cancellation stays bound to its key's runner, including early and Bun cancellation", () => {
  const runner=join(dir,"cancellable.mjs");
  writeFileSync(runner, `
    import {createInterface} from 'node:readline';
    const timers=new Map();
    for await(const line of createInterface({input:process.stdin})){
      const req=JSON.parse(line);
      if(req.op==='cancel'){
        clearInterval(timers.get(req.id));timers.delete(req.id);
        console.log(JSON.stringify({id:req.id,done:true,exitCode:130}));
      }else{
        timers.set(req.id,setInterval(()=>console.log(JSON.stringify({id:req.id,event:{type:'assistant',message:{role:'assistant',content:[{type:'text',text:process.env.CURSOR_API_KEY}]}}})),10));
      }
    }
  `);
  run(`
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    const {createSdkNodeChild,createSdkBunChild,stopSdkRunner}=await import(${JSON.stringify(sdkChildURL)});
    const options=key=>({apiKey:key,model:'auto',cwd:'.',prompt:'test'});
    const a=createSdkNodeChild(options('key-a'));
    const b=createSdkNodeChild(options('key-b'));
    const aClosed=once(a,'close'),bClosed=once(b,'close');
    const [aChunk,bChunk]=await Promise.all([once(a.stdout,'data'),once(b.stdout,'data')]);
    assert.match(aChunk[0].toString(),/key-a/);assert.match(bChunk[0].toString(),/key-b/);
    a.kill();assert.deepEqual(await aClosed,[130]);
    assert.match((await once(b.stdout,'data'))[0].toString(),/key-b/);
    b.kill();assert.deepEqual(await bClosed,[130]);
    const early=createSdkNodeChild(options('early'));
    const earlyClosed=once(early,'close');early.kill();
    assert.deepEqual(await earlyClosed,[130]);
    const bun=createSdkBunChild(options('bun'));
    const reader=bun.stdout.getReader();await reader.read();
    await reader.cancel();assert.equal(await bun.exited,130);
    stopSdkRunner();process.exit(0);
  `,{CURSOR_ACP_SDK_RUNNER_PATH:runner});
});

test("Windows .cmd to PowerShell arguments survive the direct and pooled CLI paths", {
  skip: process.platform !== "win32",
}, () => {
  const workspace = join(dir, "OneDrive - Contoso, Inc", "project & literal %PATH% !bang! (draft)");
  const ps1 = join(dir, "cursor-agent.ps1");
  const cmd = join(dir, "cursor-agent.cmd");
  writeFileSync(join(dir, "argv.mjs"), `
    const text=JSON.stringify(process.argv.slice(2));
    console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}}));
  `);
  // Cursor's PowerShell launcher forwards $args to its bundled Node entry.
  writeFileSync(ps1, `& '${process.execPath.replaceAll("'", "''")}' "$PSScriptRoot\\argv.mjs" $args\n`);
  // Match the Cursor installer boundary: cmd.exe forwards argv into PowerShell.
  writeFileSync(cmd, '@echo off\r\nsetlocal enabledelayedexpansion\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cursor-agent.ps1" %*\r\n');
  for (const pooled of [false, true]) {
    run(`
      import assert from 'node:assert/strict';
      const {ensureCursorProxyServer,buildCursorAgentCommand}=await import(${JSON.stringify(pluginURL)});
      assert.equal(buildCursorAgentCommand('auto',${JSON.stringify(workspace)})[0],${JSON.stringify(cmd)},'logical argv must retain the selected binary');
      const url=await ensureCursorProxyServer(${JSON.stringify(workspace)});
      const response=await fetch(url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'auto',messages:[{role:'user',content:'test'}]})});
      assert.equal(response.status,200);
      const body=await response.json();
      const args=JSON.parse(body.choices[0].message.content);
      assert.equal(args[args.indexOf('--workspace')+1],${JSON.stringify(workspace)});
      assert.ok(args.includes('--trust'));
      process.exit(0);
    `, {
      CURSOR_AGENT_EXECUTABLE: cmd, CURSOR_ACP_BACKEND: "cursor-agent",
      CURSOR_ACP_AGENT_POOL: pooled ? "true" : "false",
      CURSOR_ACP_TRUST_WORKSPACE: "true", CURSOR_ACP_REUSE_EXISTING_PROXY: "false",
      CURSOR_ACP_CURSOR_AGENT_RUNNER_PATH: join(sourceRoot, "scripts/cursor-agent-runner.mjs"),
    });
  }
});
