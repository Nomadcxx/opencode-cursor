import spawn from "cross-spawn";
import { resolveCursorAgentBinary } from "../utils/binary.js";
import { buildCursorAgentSpawnCommand } from "../utils/cursor-agent-command.mjs";
import { runCursorAgent, type CursorAgentRunDeps } from "../utils/cursor-agent-run.js";
import type { CredentialOAuth, IntegrationOAuthAuthorization } from "./types.js";

/**
 * OpenCode 2 OAuth method backed by `cursor-agent login`.
 *
 * Cursor has no third-party OAuth client, so cursor-agent keeps owning the
 * token: the stored credential is a marker (`access: "cursor-agent"`), and
 * requests run through the CLI login. An `oauth` method (not `command`) is the
 * one every OpenCode surface offers, desktop included. Same shape as the Kiro
 * and Claude Code plugins: finish at once when the CLI is already logged in,
 * otherwise run the CLI login and hand OpenCode its browser link.
 */

export const CURSOR_AGENT_LOGIN_METHOD_ID = "cursor-agent-login";
/** Placeholder `access` value; the plugin reads it as "use the cursor-agent login". */
export const CURSOR_AGENT_ACCESS = "cursor-agent";

const STATUS_TIMEOUT_MS = 10_000;
const LINK_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LINK_PATTERN = /https:\/\/\S+/;
const INSTALL_URL = "https://cursor.com/cli";

export type CursorAgentStatus = { authenticated: boolean; email?: string };

type LoginChild = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
};

export type CursorAgentLoginDeps = {
  status?: () => Promise<CursorAgentStatus>;
  startLogin?: () => LoginChild;
  now?: () => number;
  linkTimeoutMs?: number;
  loginTimeoutMs?: number;
};

export async function readCursorAgentStatus(deps: CursorAgentRunDeps = {}): Promise<CursorAgentStatus> {
  const result = await runCursorAgent(["status", "--format", "json"], { timeoutMs: STATUS_TIMEOUT_MS, ...deps });
  try {
    const parsed = JSON.parse(result.stdout);
    const email = typeof parsed?.userInfo?.email === "string" ? parsed.userInfo.email : undefined;
    return { authenticated: parsed?.isAuthenticated === true, ...(email ? { email } : {}) };
  } catch {
    return { authenticated: false };
  }
}

function startCursorAgentLogin(): LoginChild {
  const [command, args] = buildCursorAgentSpawnCommand(resolveCursorAgentBinary(), ["login"]);
  // OpenCode shows or opens the link on the machine the user is at; the
  // server running this may be headless or remote.
  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_OPEN_BROWSER: "1" },
  });
}

export function cursorAgentCredential(email?: string): CredentialOAuth {
  return {
    type: "oauth",
    methodID: CURSOR_AGENT_LOGIN_METHOD_ID,
    access: CURSOR_AGENT_ACCESS,
    refresh: "",
    expires: 0,
    ...(email ? { metadata: { email } } : {}),
  };
}

export function cursorAgentCredentialLabel(credential: CredentialOAuth): string {
  const email = credential.metadata?.email;
  return typeof email === "string" && email ? `cursor-agent (${email})` : "cursor-agent";
}

function isMissingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export type CursorAgentLogin = {
  authorize(): Promise<IntegrationOAuthAuthorization>;
  dispose(): void;
};

export function createCursorAgentLogin(deps: CursorAgentLoginDeps = {}): CursorAgentLogin {
  const status = deps.status ?? (() => readCursorAgentStatus());
  const startLogin = deps.startLogin ?? startCursorAgentLogin;
  const now = deps.now ?? Date.now;
  const linkTimeoutMs = deps.linkTimeoutMs ?? LINK_TIMEOUT_MS;
  const loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;

  // OpenCode cannot tell a promise plugin that an attempt was cancelled, so the
  // running login is killed by a newer attempt, its timeout, or plugin cleanup.
  let stopActive: ((reason: Error) => void) | undefined;
  const stop = (reason: Error) => {
    const current = stopActive;
    stopActive = undefined;
    current?.(reason);
  };

  const run = (child: LoginChild) =>
    new Promise<{ link: string; done: Promise<void> }>((resolveLink, rejectLink) => {
      let output = "";
      let link: string | undefined;
      let resolveDone!: () => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      done.catch(() => {});

      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(linkTimer);
        clearTimeout(loginTimer);
        if (stopActive === fail) stopActive = undefined;
        if (!error) {
          resolveDone();
          return;
        }
        child.kill("SIGTERM");
        rejectLink(error); // no-op once the link was handed over
        rejectDone(error);
      };
      const fail = (error: Error) => settle(error);
      stopActive = fail;

      const linkTimer = setTimeout(
        () => fail(new Error("cursor-agent login did not print a sign-in link. Run `cursor-agent login` in a terminal, then try again.")),
        linkTimeoutMs,
      );
      const loginTimer = setTimeout(
        () => fail(new Error("Cursor sign-in timed out. Run `cursor-agent login` in a terminal, then try again.")),
        loginTimeoutMs,
      );

      const onOutput = (chunk: Buffer | string) => {
        output += String(chunk);
        if (link !== undefined) return;
        const match = output.match(LINK_PATTERN);
        if (!match) return;
        link = match[0];
        clearTimeout(linkTimer);
        resolveLink({ link, done });
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      child.on("error", (error) =>
        fail(isMissingBinary(error) ? new Error(`cursor-agent is not installed. Install it from ${INSTALL_URL}`) : error));
      child.on("close", (code) => {
        if (code === 0 && link !== undefined) return settle();
        const detail = output.trim().split("\n").pop() ?? "";
        fail(new Error(`cursor-agent login exited with code ${code}${detail ? `: ${detail}` : ""}`));
      });
    });

  return {
    async authorize() {
      stop(new Error("Superseded by a newer Cursor sign-in."));

      let current: CursorAgentStatus;
      try {
        current = await status();
      } catch (error) {
        if (isMissingBinary(error)) throw new Error(`cursor-agent is not installed. Install it from ${INSTALL_URL}`);
        throw error;
      }

      if (current.authenticated) {
        return {
          url: "",
          instructions: `Using the cursor-agent login${current.email ? ` for ${current.email}` : ""}.`,
          mode: "auto",
          callback: Promise.resolve(cursorAgentCredential(current.email)),
        };
      }

      const started = now();
      const { link, done } = await run(startLogin());
      // The email only labels the account; a failed lookup must not fail the login.
      const callback = done
        .then(() => status().then((after) => after.email, () => undefined))
        .then(cursorAgentCredential);
      callback.catch(() => {});
      return {
        url: link,
        instructions: "Sign in to Cursor in your browser. OpenCode connects when cursor-agent login finishes.",
        mode: "auto",
        expiresAt: started + loginTimeoutMs,
        callback,
      };
    },
    dispose() {
      stop(new Error("Cursor sign-in cancelled."));
    },
  };
}
