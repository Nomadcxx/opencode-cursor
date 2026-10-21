import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createCursorAgentLogin,
  readCursorAgentStatus,
  type CursorAgentStatus,
} from "../../../src/opencode2/cursor-agent-login.js";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean; killed?: string };

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal?: string) {
      child.killed = signal ?? "SIGTERM";
      return true;
    },
  }) as FakeChild;
  return child;
}

const LINK = "https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login";
const printLink = (child: FakeChild) =>
  queueMicrotask(() => child.stdout.write(`Starting login process...\nOpen a browser and navigate to this link: ${LINK}\n`));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function statuses(...values: Array<CursorAgentStatus | Error>) {
  const queue = [...values];
  return async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
}

describe("opencode2/cursor-agent-login", () => {
  it("finishes at once when cursor-agent is already logged in", async () => {
    let started = 0;
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: true, email: "ada@example.com" }),
      startLogin: () => { started++; return fakeChild(); },
    });

    const authorization = await login.authorize();
    expect(started).toBe(0);
    expect(authorization.url).toBe("");
    expect(authorization.instructions).toContain("ada@example.com");
    expect(await authorization.callback).toMatchObject({
      type: "oauth",
      methodID: "cursor-agent-login",
      access: "cursor-agent",
      metadata: { email: "ada@example.com" },
    });
  });

  it("says how to install cursor-agent when it is missing", async () => {
    const missing = Object.assign(new Error("spawn cursor-agent ENOENT"), { code: "ENOENT" });
    const login = createCursorAgentLogin({ status: statuses(missing) });
    await expect(login.authorize()).rejects.toThrow("cursor-agent is not installed");
  });

  it("hands OpenCode the sign-in link and connects when cursor-agent login exits", async () => {
    const child = fakeChild();
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: false }, { authenticated: true, email: "ada@example.com" }),
      startLogin: () => { printLink(child); return child; },
      now: () => 1_000,
      loginTimeoutMs: 60_000,
    });

    const authorization = await login.authorize();
    expect(authorization.url).toBe(LINK);
    expect(authorization.expiresAt).toBe(61_000);

    child.emit("close", 0);
    expect(await authorization.callback).toMatchObject({ access: "cursor-agent", metadata: { email: "ada@example.com" } });
    expect(child.killed).toBeUndefined();
  });

  it("fails with the CLI's last line when login exits before printing a link", async () => {
    const child = fakeChild();
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: false }),
      startLogin: () => {
        queueMicrotask(() => {
          child.stdout.write("Login failed: network unreachable\n");
          setTimeout(() => child.emit("close", 1), 0);
        });
        return child;
      },
    });
    await expect(login.authorize()).rejects.toThrow("exited with code 1: Login failed: network unreachable");
  });

  it("kills a login that never prints a link", async () => {
    const child = fakeChild();
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: false }),
      startLogin: () => child,
      linkTimeoutMs: 10,
    });
    await expect(login.authorize()).rejects.toThrow("did not print a sign-in link");
    expect(child.killed).toBe("SIGTERM");
  });

  it("kills a sign-in the user never finishes", async () => {
    const child = fakeChild();
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: false }),
      startLogin: () => { printLink(child); return child; },
      loginTimeoutMs: 20,
    });
    const authorization = await login.authorize();
    await expect(authorization.callback).rejects.toThrow("Cursor sign-in timed out");
    expect(child.killed).toBe("SIGTERM");
  });

  it("stops the earlier login when a new attempt starts, and on dispose", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const login = createCursorAgentLogin({
      status: statuses({ authenticated: false }),
      startLogin: () => { const child = children.shift()!; printLink(child); return child; },
    });

    const earlier = await login.authorize();
    const later = await login.authorize();
    await expect(earlier.callback).rejects.toThrow("Superseded");
    expect(first.killed).toBe("SIGTERM");

    login.dispose();
    await expect(later.callback).rejects.toThrow("cancelled");
    expect(second.killed).toBe("SIGTERM");
    await tick();
  });

  it("parses cursor-agent status JSON", async () => {
    const spawnWith = (stdout: string) => ((() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end(stdout);
        child.stderr.end();
        setTimeout(() => child.emit("close", 0), 0);
      });
      return child;
    }) as any);

    expect(await readCursorAgentStatus({ spawn: spawnWith(JSON.stringify({
      isAuthenticated: true,
      userInfo: { email: "ada@example.com" },
    })), resolveBinary: () => "cursor-agent" })).toEqual({ authenticated: true, email: "ada@example.com" });
    expect(await readCursorAgentStatus({ spawn: spawnWith(JSON.stringify({
      status: "unauthenticated",
      isAuthenticated: false,
    })), resolveBinary: () => "cursor-agent" })).toEqual({ authenticated: false });
    expect(await readCursorAgentStatus({ spawn: spawnWith("Not logged in"), resolveBinary: () => "cursor-agent" }))
      .toEqual({ authenticated: false });
  });
});
