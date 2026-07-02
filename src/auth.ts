/**
 * Pure-Node auth core for the pi remote-control extension: a `clever login`-style
 * loopback OAuth (PKCE) flow, a persistent token store, and silent refresh. No
 * separate binary — `/remote-login` runs this in-process. The on-disk format is
 * shared with the optional Rust `pidev` tester, so both interoperate.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const CREDENTIALS_PATH = join(homedir(), ".config", "pidev", "credentials.json");
/** Fixed callback ports so an *exact* redirect URI can be registered in Keycloak
 *  (a `http://127.0.0.1/*` wildcard does NOT cover the port). */
const CALLBACK_PORTS = [8765, 8766, 8767];

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  issuer: string;
  client_id: string;
}

interface WebConfig {
  issuer: string;
  clientId: string;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const b64url = (buf: Buffer): string => buf.toString("base64url");
const httpBase = (relay: string): string => relay.replace(/\/$/, "").replace(/^ws/, "http");

export function hasCredentials(): boolean {
  return existsSync(CREDENTIALS_PATH);
}

async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
  } catch {
    return null;
  }
}

async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export async function logout(): Promise<boolean> {
  if (!existsSync(CREDENTIALS_PATH)) return false;
  await rm(CREDENTIALS_PATH);
  return true;
}

async function fetchWebConfig(relay: string): Promise<WebConfig> {
  const res = await fetch(`${httpBase(relay)}/web-config.json`);
  if (!res.ok) throw new Error(`/web-config.json → ${res.status}`);
  return (await res.json()) as WebConfig;
}

function openBrowser(url: string): void {
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is logged for manual use */
  }
}

/** Listen on the first free callback port; resolve the bound port. */
function bindFirstFree(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number): void => {
      if (i >= CALLBACK_PORTS.length) {
        reject(new Error(`no free loopback port among ${CALLBACK_PORTS.join(", ")}`));
        return;
      }
      const onError = (): void => tryPort(i + 1);
      server.once("error", onError);
      server.listen(CALLBACK_PORTS[i], "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(CALLBACK_PORTS[i]);
      });
    };
    tryPort(0);
  });
}

const SIGNED_IN_PAGE =
  "<html><body style='font-family:system-ui;background:#171a21;color:#eee;" +
  "text-align:center;padding-top:4rem'><h2>✓ Signed in</h2>" +
  "<p>You can close this tab and return to your editor.</p></body></html>";

/**
 * Run the loopback PKCE login: open the browser, capture the code on 127.0.0.1,
 * exchange it for access+refresh tokens, and persist them.
 */
export async function login(relay: string, log: (m: string) => void): Promise<void> {
  const cfg = await fetchWebConfig(relay);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let port = 0;
  let resolveCode!: (v: { code: string; state: string }) => void;
  const codePromise = new Promise<{ code: string; state: string }>((res) => {
    resolveCode = res;
  });
  const server = createServer((req, resp) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    if (code && gotState) {
      resp.writeHead(200, { "content-type": "text/html" });
      resp.end(SIGNED_IN_PAGE);
      resolveCode({ code, state: gotState });
    } else {
      resp.writeHead(204);
      resp.end();
    }
  });

  port = await bindFirstFree(server);
  const redirect = `http://127.0.0.1:${port}/callback`;
  const authUrl =
    `${cfg.issuer}/protocol/openid-connect/auth?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&response_type=code&scope=${encodeURIComponent("openid offline_access")}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;

  log(`opening your browser to sign in… if it doesn't open, visit:\n  ${authUrl}`);
  openBrowser(authUrl);

  const got = await codePromise;
  server.close();
  if (got.state !== state) throw new Error("OAuth state mismatch (possible CSRF)");

  const res = await fetch(`${cfg.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: got.code,
      redirect_uri: redirect,
      client_id: cfg.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!t.refresh_token) throw new Error("no refresh_token — the client needs offline_access");
  await saveCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: nowSec() + t.expires_in - 30,
    issuer: cfg.issuer,
    client_id: cfg.clientId,
  });
}

/**
 * Resolve a valid OIDC access token: `PIDEV_OIDC_TOKEN` env override first, else
 * the stored login credentials, refreshing them when near expiry.
 */
export async function resolveOidcToken(log: (m: string) => void): Promise<string | undefined> {
  if (process.env.PIDEV_OIDC_TOKEN) return process.env.PIDEV_OIDC_TOKEN;
  const creds = await loadCredentials();
  if (!creds) return undefined;
  if (creds.expires_at > nowSec() + 30) return creds.access_token;
  try {
    const res = await fetch(`${creds.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id: creds.client_id,
      }),
    });
    if (!res.ok) {
      log(`token refresh failed (${res.status}) — run /remote-login again`);
      return undefined;
    }
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    creds.access_token = t.access_token;
    if (t.refresh_token) creds.refresh_token = t.refresh_token;
    creds.expires_at = nowSec() + t.expires_in - 30;
    await saveCredentials(creds);
    return creds.access_token;
  } catch (e) {
    log(`token refresh error: ${String(e)}`);
    return undefined;
  }
}
