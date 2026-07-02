/**
 * pi.dev remote-control extension.
 *
 * Bridges the live pi session to the relay over a WebSocket:
 *   - observes assistant streaming (`message_update`) and tool runs, and
 *     forwards them to the relay as `from-pi` events;
 *   - receives `to-pi` commands from remote devices and injects them into the
 *     session via `pi.sendUserMessage`;
 *   - gates tool calls on remote approval: on `tool_call` it asks the device
 *     and blocks the tool if denied (or on timeout).
 *
 * Auth: before connecting, the extension exchanges an OIDC token (or, in the
 * relay's dev mode, nothing) for a session-scoped biscuit at `POST
 * /auth/token`, and presents that biscuit on the WS connect.
 *
 * Config via env:
 *   PIDEV_RELAY_URL    relay base, default wss://pidev-remote.cleverapps.io
 *   PIDEV_SESSION      session id shared with the device leg, default "demo"
 *   PIDEV_OIDC_TOKEN   optional OIDC access token (required when the relay has
 *                      OIDC_ISSUER set; omitted in dev mode)
 *
 * NOTE: pi's published types aren't depended on here — the `ExtensionAPI`
 * surface is modelled loosely against the documented methods/events
 * (docs/extensions.md). Tighten once we pin a pi version.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { hasCredentials, login, logout, resolveOidcToken } from "./auth.js";

/** Default session = the project folder name, so different projects (and pi
 *  instances) don't collide on one shared session. Override with PIDEV_SESSION. */
function defaultSession(): string {
  const name = basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "pi";
}

// ---- Loose model of the bits of pi's ExtensionAPI we use -------------------

interface ExtensionContext {
  mode: "tui" | "rpc" | "json" | "print";
}

type ToolDecision = { block: true; reason: string } | undefined;
type AskUserResponse = { text: string };

interface ExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description?: string;
      // LOOSE MODEL: pi passes any text after the command as `args`; optional so
      // arg-less commands still work.
      handler: (args?: string) => void | Promise<void>;
    },
  ): void;
  sendUserMessage(
    content: string,
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): void | Promise<void>;
  /** Interrupt the in-flight turn. LOOSE MODEL: pi's real abort hook is
   *  unconfirmed (same caveat as the rest of this file); optional so a build
   *  without it degrades gracefully. */
  abort?(): void | Promise<void>;
  on(
    event: string,
    handler: (
      event: any,
    ) => void | ToolDecision | AskUserResponse | Promise<ToolDecision | AskUserResponse>,
  ): void;
}

// ---- Wire envelopes (see docs/ARCHITECTURE.md) -----------------------------

type FromPi =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; phase: "start" | "end"; name: string }
  | { type: "approval_request"; id: string; title: string; tool: string }
  | { type: "question"; id: string; prompt: string; choices?: string[] }
  | { type: "ack"; status: "received" | "busy" }
  | { type: "working" }
  | { type: "turn_end" };

type ToPi =
  | { type: "prompt"; text: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "approval"; id: string; allow: boolean }
  | { type: "answer"; id: string; text: string }
  | { type: "abort" };

const APPROVAL_TIMEOUT_MS = 60_000;
const ASK_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------

export default function activate(pi: ExtensionAPI, ctx?: ExtensionContext): void {
  const relayBase = (process.env.PIDEV_RELAY_URL ?? "wss://pidev-remote.cleverapps.io").replace(/\/$/, "");
  const session = process.env.PIDEV_SESSION ?? defaultSession();
  const wsUrl = `${relayBase}/ws/pi?session=${encodeURIComponent(session)}`;
  const httpBase = relayBase.replace(/^ws/, "http");
  const oidcToken = process.env.PIDEV_OIDC_TOKEN;

  // Transport policy: cleartext is only allowed to a loopback relay. Off-loopback
  // requires wss:// and an OIDC token (fail closed rather than leak credentials
  // or connect unauthenticated). See docs/audits/SECURITY-AUDIT.md (C1, C6).
  const host = (() => {
    try {
      return new URL(relayBase).hostname;
    } catch {
      return "";
    }
  })();
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!isLoopback) {
    if (!relayBase.startsWith("wss://")) {
      log(`refusing to connect: ${relayBase} is not loopback and not wss:// (cleartext would leak the biscuit)`);
      return;
    }
    if (!oidcToken && !hasCredentials()) {
      log("refusing to connect: non-loopback relay needs auth — run /remote-login (or set PIDEV_OIDC_TOKEN). Failing closed.");
      return;
    }
  }

  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 1000;
  const RETRY_MAX_MS = 30_000;
  // Detect a session conflict (another pi kicking us): count short-lived connects.
  let openedAt = 0;
  let shortLived = 0;
  let conflictWarned = false;

  // Pending tool approvals, keyed by request id.
  const pendingApprovals = new Map<string, (allow: boolean) => void>();
  // Pending ask-user questions, keyed by question id.
  const pendingAnswers = new Map<string, (text: string) => void>();
  // Whether a turn is currently running (drives the busy ack hint).
  let turnInProgress = false;
  // How much of the turn's thinking content we've already forwarded (for diffing).
  let sentThinkingLen = 0;

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(retryMs, RETRY_MAX_MS) + Math.floor(Math.random() * 500);
    debug(`reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS); // exponential backoff
  };

  const send = (msg: FromPi) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // "pi is working" heartbeat: while a turn runs, tell the device every few
  // seconds so it can show a live loader even during long silent tool runs.
  let workingTimer: ReturnType<typeof setInterval> | null = null;
  const startWorking = () => {
    send({ type: "working" });
    if (workingTimer) return;
    workingTimer = setInterval(() => {
      if (turnInProgress) send({ type: "working" });
      else stopWorking();
    }, 2500);
  };
  function stopWorking(): void {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
  }

  const fetchBiscuit = async (): Promise<string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = await resolveOidcToken(log);
    if (token) headers["authorization"] = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${httpBase}/auth/token`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session, role: "pi" }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`auth/token returned ${res.status}`);
      const body = (await res.json()) as { biscuit: string };
      return body.biscuit;
    } finally {
      clearTimeout(timer);
    }
  };

  const connect = async () => {
    if (closed) return;
    let biscuit: string;
    try {
      biscuit = await fetchBiscuit();
    } catch (err) {
      log(`auth failed: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }

    debug(`connecting to relay ${wsUrl}`);
    // Global WebSocket (bun/Node) can't set request headers, so the biscuit rides
    // as the access_token query param (the relay accepts header OR query). Keeps
    // the extension dependency-free — no `ws` package — so `pi install` just works.
    ws = new WebSocket(`${wsUrl}&access_token=${encodeURIComponent(biscuit)}`);

    ws.onopen = () => {
      retryMs = 1000; // reset backoff on a successful connect
      openedAt = Date.now();
      debug("relay connected");
    };

    ws.onmessage = (event) => {
      let cmd: ToPi;
      try {
        cmd = JSON.parse(String(event.data)) as ToPi;
      } catch {
        log(`bad command frame: ${String(event.data)}`);
        return;
      }
      if (cmd.type === "prompt") {
        log(`remote prompt: ${cmd.text}`);
        // Instant receipt ack (remote_pi-style) so the device knows pi got it,
        // without waiting for the first delta or a timeout.
        send({ type: "ack", status: turnInProgress ? "busy" : "received" });
        turnInProgress = true;
        sentThinkingLen = 0; // reset the thinking diff for the new turn
        startWorking();
        void pi.sendUserMessage(cmd.text, {
          streamingBehavior: cmd.streamingBehavior ?? "followUp",
        });
      } else if (cmd.type === "approval") {
        const resolve = pendingApprovals.get(cmd.id);
        if (resolve) resolve(cmd.allow);
      } else if (cmd.type === "answer") {
        const resolve = pendingAnswers.get(cmd.id);
        if (resolve) resolve(cmd.text);
      } else if (cmd.type === "abort") {
        log("remote abort: interrupting the current turn");
        void pi.abort?.();
      }
    };

    ws.onclose = () => {
      debug("relay disconnected");
      stopWorking();
      // A connection that barely lived is the signature of a session conflict
      // (another pi kicking us off the "pi" subscription). Warn once, don't spam.
      const lived = openedAt ? Date.now() - openedAt : 0;
      if (openedAt && lived < 3000) {
        if (++shortLived >= 3 && !conflictWarned) {
          conflictWarned = true;
          log(`the relay keeps dropping this connection — another pi is likely on session "${session}". Set PIDEV_SESSION to a unique name.`);
        }
      } else {
        shortLived = 0;
        conflictWarned = false;
      }
      openedAt = 0;
      // Fail any in-flight approvals closed (deny by default).
      for (const resolve of pendingApprovals.values()) resolve(false);
      pendingApprovals.clear();
      // Fail any in-flight questions with an empty answer.
      for (const resolve of pendingAnswers.values()) resolve("");
      pendingAnswers.clear();
      scheduleReconnect();
    };

    ws.onerror = () => debug("relay websocket error");
  };

  const awaitApproval = (id: string): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (allow: boolean) => {
        if (settled) return;
        settled = true;
        pendingApprovals.delete(id);
        resolve(allow);
      };
      pendingApprovals.set(id, finish);
      setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS); // default-deny on timeout
    });

  const awaitAnswer = (id: string): Promise<string> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (text: string) => {
        if (settled) return;
        settled = true;
        pendingAnswers.delete(id);
        resolve(text);
      };
      pendingAnswers.set(id, finish);
      setTimeout(() => finish(""), ASK_TIMEOUT_MS); // empty answer on timeout
    });

  // Each message accumulates its own thinking content, so reset the diff cursor
  // when a new message starts (a turn may have several assistant messages).
  pi.on("message_start", () => {
    sentThinkingLen = 0;
  });

  // Assistant token stream → device.
  pi.on("message_update", (event) => {
    const ev = event?.assistantMessageEvent;
    if (ev?.type === "text_delta" && typeof ev.delta === "string") {
      send({ type: "delta", text: ev.delta });
    }
    // Thinking: pi's message content carries `{type:"thinking", thinking}` blocks
    // (see docs/session-format.md). Diff against what we've sent and stream the
    // new suffix — robust to whatever the per-token stream event shape is.
    const content = event?.message?.content;
    if (Array.isArray(content)) {
      let thinking = "";
      for (const block of content) {
        if (block?.type === "thinking" && typeof block.thinking === "string") {
          thinking += block.thinking;
        }
      }
      if (thinking.length > sentThinkingLen) {
        send({ type: "thinking", text: thinking.slice(sentThinkingLen) });
        sentThinkingLen = thinking.length;
      }
    }
  });

  // Tool lifecycle markers → device.
  pi.on("tool_execution_start", (event) => {
    send({ type: "tool", phase: "start", name: event?.toolName ?? "?" });
  });
  pi.on("tool_execution_end", (event) => {
    send({ type: "tool", phase: "end", name: event?.toolName ?? "?" });
  });

  // Gate each tool call on a remote approval. Returns `{ block }` to deny.
  pi.on("tool_call", async (event): Promise<ToolDecision> => {
    const tool = event?.toolName ?? event?.name ?? "tool";
    const id = randomUUID(); // unguessable, matches docs' "uuid" contract
    const title = `Allow tool \`${tool}\`?`;
    log(`requesting approval for ${tool} (${id})`);
    send({ type: "approval_request", id, title, tool });
    const allow = await awaitApproval(id);
    log(`approval ${id}: ${allow ? "allowed" : "denied"}`);
    return allow ? undefined : { block: true, reason: "denied by remote operator" };
  });

  // pi asks the user a free-form question → forward to the device and await the
  // typed answer (mirrors the tool_call gate). LOOSE MODEL: pi's real ask-user
  // hook name/shape is unconfirmed — same caveat as the rest of this file —
  // modelled as a `user_input_request` event whose handler returns `{ text }`.
  // Tighten once a pi version is pinned (see docs/extensions.md).
  pi.on("user_input_request", async (event): Promise<AskUserResponse> => {
    const prompt = event?.prompt ?? event?.question ?? "pi needs your input";
    const choices = Array.isArray(event?.choices) ? event.choices : undefined;
    const id = randomUUID();
    log(`asking user: ${prompt} (${id})`);
    send({ type: "question", id, prompt, choices });
    const text = await awaitAnswer(id);
    log(`answer ${id}: ${JSON.stringify(text)}`);
    return { text };
  });

  // End of an agent turn → device.
  pi.on("agent_end", () => {
    turnInProgress = false;
    stopWorking();
    send({ type: "turn_end" });
  });

  pi.registerCommand("remote-status", {
    description: "Show pi-dev remote-control connection status",
    handler: () => {
      const state = ws ? readyStateName(ws.readyState) : "disconnected";
      const auth = process.env.PIDEV_OIDC_TOKEN ? "env token" : hasCredentials() ? "logged in" : "not signed in";
      log(`relay ${state} · ${relayBase} · session ${session} · auth ${auth} · mode ${ctx?.mode ?? "?"}`);
    },
  });

  pi.registerCommand("remote-login", {
    description: "Sign in to the remote relay (opens your browser)",
    handler: async () => {
      try {
        log("signing in…");
        await login(relayBase, log);
        log("✓ signed in — credentials stored and auto-refreshed. reconnecting…");
        if (ws) ws.close(); // the reconnect picks up the fresh credentials
        else void connect();
      } catch (e) {
        log(`login failed: ${String(e)}`);
      }
    },
  });

  pi.registerCommand("remote-logout", {
    description: "Forget stored remote credentials",
    handler: async () => {
      log((await logout()) ? "✓ logged out (credentials removed)" : "no stored credentials");
    },
  });

  pi.registerCommand("remote-pair", {
    description: "Show a QR to pair your phone with this remote (no login on the phone)",
    handler: async () => {
      const token = await resolveOidcToken(log);
      if (!token) {
        log("not signed in — run /remote-login first");
        return;
      }
      try {
        const res = await fetch(`${httpBase}/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) {
          log(`pairing failed (${res.status})`);
          return;
        }
        const p = (await res.json()) as { qrTerminal: string; expiresIn: number };
        // eslint-disable-next-line no-console
        console.error(
          `\n${p.qrTerminal}\nScan with the pi.dev app — then use session "${session}". ` +
            `Expires in ${p.expiresIn}s. No login needed on the phone.\n`,
        );
      } catch (e) {
        log(`pairing error: ${String(e)}`);
      }
    },
  });

  pi.registerCommand("remote-beta-invite", {
    description: "Add your Apple ID to the iOS TestFlight beta: /remote-beta-invite you@appleid",
    handler: async (args?: string) => {
      const email = (args ?? "").trim();
      if (!email || !email.includes("@")) {
        log("usage: /remote-beta-invite you@your-apple-id.com");
        return;
      }
      const token = await resolveOidcToken(log);
      if (!token) {
        log("not signed in — run /remote-login first");
        return;
      }
      try {
        const res = await fetch(`${httpBase}/beta/invite`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ email }),
        });
        const body = await res.text();
        if (!res.ok) {
          log(`beta invite failed (${res.status}): ${body}`);
          return;
        }
        log(
          body.includes("already_registered")
            ? `${email} is already in the beta — open TestFlight to install.`
            : `✓ invited ${email} to the TestFlight beta — check your email, then install "pi.dev remote".`,
        );
      } catch (e) {
        log(`beta invite error: ${String(e)}`);
      }
    },
  });

  void connect();
}

function readyStateName(s: number): string {
  return ["connecting", "open", "closing", "closed"][s] ?? String(s);
}

// Actionable messages the user should see (rare: login needed, hard failures).
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[pi-remote] ${msg}`);
}

// Routine lifecycle chatter (connect/reconnect/etc.) — silent by default so it
// doesn't garble pi's TUI. Set PIDEV_DEBUG=1 to see it.
function debug(msg: string): void {
  if (process.env.PIDEV_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[pi-remote] ${msg}`);
  }
}
