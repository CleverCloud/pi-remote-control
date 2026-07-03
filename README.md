# pi.dev remote control — extension

A [pi.dev](https://pi.dev) extension that bridges your live `pi` coding-agent
session to the pi-remote-control relay, so you can drive it from your phone or
any browser: watch the reasoning + output stream, approve tool calls, answer
questions, and stop a turn — from anywhere.

This is the **open-source extension**. The relay and the iOS app live in a
separate (private) repository operated by Clever Cloud. Signing in requires a
**Clever Cloud account** — it's a beta service by Clever Cloud.

## Install

```
pi install npm:@clevercloud/pi-remote-control
```

or straight from this repo:

```
pi install git:github.com/CleverCloud/pi-remote-control
```

No build step, no dependencies (Node builtins + the global `WebSocket`/`fetch`);
`pi` loads the committed `dist/` directly.

## Use — inside pi

```
/remote-login                          # opens your browser; tokens auto-refresh
/remote-status                         # relay state · session · auth
/remote-pair                           # show a QR to pair your phone
/remote-beta-invite you@apple-id.com   # join the iOS TestFlight beta
/remote-logout
```

Pick a session (defaults to the project folder name) and start pi:

```
export PIDEV_SESSION="myproject"       # the device must use the same session
# relay defaults to wss://pidev-remote.cleverapps.io (override with PIDEV_RELAY_URL)
pi
```

Then drive it from the web client (`…/app?session=myproject&connect=1`) or the
iOS app.

Auth precedence: `PIDEV_OIDC_TOKEN` (CI override) → stored `/remote-login`
credentials (auto-refreshed, at `~/.config/pidev/credentials.json`) → none
(dev mode, loopback relay only).

## Develop

```
npm install && npm run build   # → dist/index.js  (commit it; pi loads it as-is)
```

Rebuild and re-commit `dist/` after editing `src/`. Transport test against a
mock pi (no model key needed), with a local relay:

```
PIDEV_RELAY_URL=ws://localhost:8080 PIDEV_SESSION=demo bun test/harness.mjs
```

## License

Apache-2.0
