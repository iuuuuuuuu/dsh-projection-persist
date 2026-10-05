# dsh-projection-persist

**English** | [简体中文](./README.md)

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-topic-2f6feb)](https://github.com/topics/dsh-plugin)

Three fixes in one package (a host half and a browser half, without touching any file in the
DSH installation directory):

1. **Session titles** no longer collapse to "Untitled" during a connection rebuild (a Host generation reset);
2. The **session list** is no longer fully rebuilt once per control frame during a control-frame flood (coalesced to rAF; measured at roughly a 6.3x reduction);
3. The **running-state spinner** rotates again (this machine's WebView2 unconditionally reports `prefers-reduced-motion: reduce`).

> Symptom: titles in the session list briefly turn into "Untitled" (「未命名」 in the Chinese UI) and then recover on their own.

This is a [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that ships both a host half and a browser half.

---

## Symptom and root cause

The session list flashes and titles briefly turn into "Untitled" because **the projection is cleared when the connection is rebuilt**:

1. The host's `dsh-api-gateway` defaults to a **2000 ms** WebSocket heartbeat on `/api/remote.mux`, with `MAX_MISSED_HEARTBEATS` **hard-coded to 2**.
2. As soon as the client's main thread stalls for **more than 4 s**, the host decides the connection is dead and calls `socket.terminate()`.
3. The browser side sees **close 1006** and the `ConnectionController` rebuilds the connection generation.
4. `SessionManager.handleConnected()` calls `store.clear()` on **every resident projection store**.
5. `ProjectionValueStore#clear()` is implemented as **deleting every row**, so the titles are lost and fall back to `t("session.untitled")` — until `refreshList()` returns and they come back.

Key code anchors (version `0.2.0-rc.2`):

- `@deepseek-ai/dsh-api-gateway/lib/index.js` — `startHeartbeat()`, `MAX_MISSED_HEARTBEATS = 2`
- `@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/manager.js` — the `store.clear()` loop in `handleConnected()`
- `@deepseek-ai/dsh-api-session-controller/lib/client.js` — `ProjectionValueStore#clear()`

## What this plugin does

It replaces `ProjectionValueStore.prototype.clear` so that **every row keeps its value and only the sequence watermark is dropped**:

```js
function retainValues() {
  for (const [key, row] of this.rows) {
    if (row.kind === "sequenced") this.rows.set(key, { kind: "cached", value: row.value });
    this.changed(key);
  }
}
```

- Values are kept, so titles stay readable and `buildListSnapshot()` no longer falls back to "Untitled".
- The watermark is dropped, so the cached blocks delivered by the immediately following `refreshList()` can still overwrite as usual.
- Every `sequenced` row is **downgraded in place** to a `cached` row.

> **Why this cannot simply be a no-op**: `apply()` rejects frames whose seq does not advance
> (`if (row?.kind === "sequenced" && seq <= row.seq) return;`), so keeping the old watermark would
> permanently block the low-seq frames of the new connection generation — hence the "reset the
> watermark" semantics must be preserved.

It also covers **lazily created** stores (by wrapping `manager.projectionStore`) and rolls everything back completely on unload.

## Install

### From GitHub (recommended)

Add this repository to a DSH profile with pnpm:

```bash
dsh plugin --profile <your profile> add github:iuuuuuuuu/dsh-projection-persist
```

Or go into the profile directory and install it by hand:

```bash
cd "$DSH_HOME/profiles/<your profile>"
pnpm add github:iuuuuuuuu/dsh-projection-persist
```

Then add the package name to the profile's `package.json` → `dsh.profile.bundles`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-projection-persist"
      ]
    }
  }
}
```

Editing `dsh.profile.bundles` triggers a hot reload — **a restart is normally not needed**.

### Manual install (without pnpm)

Copy this repository to `$DSH_HOME/profiles/<your profile>/node_modules/dsh-projection-persist/`,
then append `"dsh-projection-persist"` to `dsh.profile.bundles` in that profile's `package.json`.

## Verify

While the plugin is active, the host half appends an install record to `<DSH_HOME>/logs/projection-persist.log`:

```json
{"kind":"install","ok":true,"revision":9,"installed":"instance","wrapped":true,"swept":42,"prototypePatched":true,"stores":42,"framePatch":"patched","spinner":"installed","watch":"watching"}
```

You can also query the diagnostics endpoint directly (a GET returns the current revision):

```bash
curl http://127.0.0.1:3080/dsh-projection-persist
# {"ok":true,"name":"projection-persist","revision":9}
```

## Rollback

Both ways take effect hot; pick either one:

1. Delete the `- insert:` row from `node_modules/dsh-projection-persist/cordis.patch.yml`;
2. Remove `"dsh-projection-persist"` from the profile's `dsh.profile.bundles`, or just delete the whole package directory.

On unload the plugin restores the original `clear()` and `manager.projectionStore`.

## Compatibility

- It depends only on the `sessions` service and declares no peerDependencies, so the compatibility check will never flag it as incompatible.
- It does not modify the DSH installation directory, so upgrading DSH does not overwrite it.
- Verified against `@deepseek-ai/dsh-api-session-controller` `0.2.0-rc.2`.
- It only affects projection stores **held by the manager**; stores held by a session itself are out of scope (that store's `seqOf` has other consumers).

## The other two fixes (same client half)

### 1. Coalescing full session-list rebuilds

The `SessionManager` list `Notifier` originally used `markDirty()` (microtask coalescing). Control frames arrive as separate socket tasks,
so microtasks cannot coalesce them at all: 8-15 control frames meant 8-15 full `projectList()` rebuilds plus an unconditional `list.set()`.
The plugin switches the **list** notifier's `markDirty` to the upstream-provided but never-enabled `markFrameDirty()` (rAF coalescing, last-write-wins unchanged,
and `ensureFresh()` keeps synchronous reads fresh). **`Session.notifier` is left alone** — its synchronous contract is relied on by `beginSubmission`/`finishSubmission`.

Measured (interleaved A/B x 3 rounds, 8 s per window):

| | Triggers | Full rebuilds | `list.set` | Rebuilds per trigger |
|---|---|---|---|---|
| Patched | 176 | **14** | 34 | **0.080** |
| Unpatched | 288 | 145 | 165 | **0.503** |

Roughly **6.3x** (about 18/s down to about 1.8/s when converted using the observed frame rate).

### 2. The running-state spinner

In this WebView2 host, `matchMedia("(prefers-reduced-motion: reduce)")` is **always true**,
which hits the `@media (prefers-reduced-motion: reduce) { .spinnerMotion, .spinnerArc { animation: none } }` rule in `StateDot.module.css`,
so nothing spins while a session is running. The plugin injects its own `<style>` that re-declares the keyframes with `!important` inside the **same**
media block (selectors scoped to `svg[data-state="ongoing"] > g` and `circle[class*="spinnerArc"]`, so the 9 other legitimate reduced-motion blocks are untouched),
and attaches a `childList` `MutationObserver` to `<head>` that reinstalls it as soon as someone removes it (measured `healedAtMs: 83`).

To turn off the spinner fix alone: `localStorage["dsh-projection-persist.spinner"] = "off"`.

## Heartbeat threshold (a different chain — not this plugin's job)

Raising `websocketHeartbeatIntervalMs` only lowers **how often** reconnects happen; it cannot eliminate reconnects themselves. You need both layers:

- a larger heartbeat interval => fewer reconnects;
- this plugin => titles no longer disappear **when a reconnect actually happens**.

## License

MIT
