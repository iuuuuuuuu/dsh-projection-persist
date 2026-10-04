window.__ModuleLoader__.load({
	id: "dsh-projection-persist",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * Client-side robustness patches for the DSH web GUI. Three independent
		 * fixes, each installed and reverted on its own:
		 *
		 * 1. projection retention — ProjectionValueStore#clear() DELETES every row,
		 *    so a rebuilt connection generation drops all session titles until
		 *    refreshList() answers (the "title flickers to 未命名" symptom). The
		 *    replacement keeps every value and only drops the sequence watermark.
		 *
		 * 2. session-list coalescing — every control frame ends in
		 *    SessionManager.notifier.markDirty(), which notifies in a MICROTASK.
		 *    Control frames arrive as separate socket tasks, so a burst of 8-15
		 *    frames becomes 8-15 whole-list rebuilds (buildListSnapshot() +
		 *    projectList() + a deep-frozen list.set()), and every whole-store
		 *    selector (`useSessions((s) => s)`) re-renders because the snapshot
		 *    identity always changes. Redirecting the LIST notifier to
		 *    markFrameDirty() collapses a frame's worth of frames into one
		 *    rebuild. Read freshness is unchanged: getListSnapshot() still rebuilds
		 *    synchronously through ensureFresh(), and the Session notifier (which
		 *    documents a same-tick echo contract for submissions) is untouched.
		 *
		 * 3. reduced-motion spinner — a WebView2 host reports
		 *    `prefers-reduced-motion: reduce` even when Windows has animations
		 *    enabled (verified against Edge on the same machine, same page), which
		 *    trips StateDot.module.css's `animation: none` and freezes the
		 *    running-session spinner into a static ring. The injected stylesheet
		 *    re-declares the spin and dash keyframes inside the same media block.
		 *    Opt out with localStorage["dsh-projection-persist.spinner"] = "off".
		 */
		const REVISION = 9;
		/** Diagnostics sink owned by the host half. */
		const ROUTE = "/dsh-projection-persist";
		/** Own-property marker proving the manager method is already wrapped. */
		const WRAP_KEY = "__dshProjectionPersistWrap";
		/** Own-property marker holding the markDirty replaced by frame coalescing. */
		const FRAME_KEY = "__dshProjectionPersistFrame";
		/** Id of the injected reduced-motion spinner override. */
		const STYLE_ID = "dsh-projection-persist-spinner";
		/** Own-property token marking which evaluation owns the style element. */
		const STYLE_OWNER_KEY = "__dshProjectionPersistOwner";
		/** localStorage key that opts the spinner override out. */
		const SPINNER_PREF = "dsh-projection-persist.spinner";
		/** Own-property marker holding the head observer that re-installs the style. */
		const OBSERVER_KEY = "__dshProjectionPersistObserver";

		/**
		 * Re-declare the StateDot spin/dash animations INSIDE the same
		 * `prefers-reduced-motion: reduce` block the app uses to disable them, so a
		 * host that misreports the preference still gets a turning loader. Scoped to
		 * the ongoing state dot only: the app's other reduced-motion rules are
		 * legitimate accommodations and stay untouched.
		 */
		const SPINNER_CSS = [
			"@media (prefers-reduced-motion: reduce) {",
			"  @keyframes dsh-projection-persist-spin { to { transform: rotate(360deg); } }",
			"  @keyframes dsh-projection-persist-dash {",
			"    0% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }",
			"    50% { stroke-dasharray: 24 150; stroke-dashoffset: -6; }",
			"    100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }",
			"  }",
			"  svg[data-state=\"ongoing\"] > g {",
			"    transform-origin: center;",
			"    animation: dsh-projection-persist-spin 1.5s linear infinite !important;",
			"  }",
			"  svg[data-state=\"ongoing\"] circle[class*=\"spinnerArc\"] {",
			"    animation: dsh-projection-persist-dash 1.5s ease-in-out infinite !important;",
			"  }",
			"}"
		].join("\n");

		/** Per-evaluation identity, so a hot-reloaded instance owns its own style. */
		const STYLE_TOKEN = { revision: REVISION };

		/**
		 * Replacement for ProjectionValueStore#clear: retain every value, drop every
		 * watermark, and fire the same per-key change notification the original fired
		 * so subscribed faces and the list projection rebuild.
		 */
		function retainValues() {
			for (const [key, row] of this.rows) {
				if (row.kind === "sequenced") this.rows.set(key, {
					kind: "cached",
					value: row.value
				});
				this.changed(key);
			}
		}

		/** Fingerprint diagnostics read to prove which clear() is installed. */
		retainValues.__dshProjectionPersist = REVISION;

		/**
		 * Post one JSON evidence line to the host sink. Best effort: a desktop shell
		 * throttles iframe console output, so this is the only durable channel.
		 * Never let a failed report break a fix.
		 */
		function report(payload) {
			try {
				void fetch(ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						at: (new Date()).toISOString(),
						revision: REVISION,
						...payload
					})
				}).catch(() => {});
			} catch {}
		}

		/**
		 * Install the replacement on one store instance.
		 * @param store - a ProjectionValueStore instance.
		 * @returns whether this call installed it.
		 */
		function patchStore(store) {
			if (store === null || typeof store !== "object") return false;
			if (store.clear === retainValues) return false;
			if (typeof store.clear !== "function") return false;
			store.clear = retainValues;
			return true;
		}

		/**
		 * Patch the class itself once a resident instance proves it reachable, so even
		 * a store created outside the manager map is covered.
		 * @param sample - any live ProjectionValueStore instance.
		 * @returns the original method when this call patched the prototype.
		 */
		function patchPrototype(sample) {
			if (sample === void 0 || sample === null) return void 0;
			const proto = Object.getPrototypeOf(sample);
			const descriptor = proto === null ? void 0 : Object.getOwnPropertyDescriptor(proto, "clear");
			if (descriptor === void 0 || typeof descriptor.value !== "function") return void 0;
			if (descriptor.value === retainValues) return void 0;
			proto.clear = retainValues;
			return descriptor.value;
		}

		/**
		 * Redirect the session-list notifier from microtask notification to frame
		 * coalescing. markFrameDirty() keeps the same dirty/notifyPending bookkeeping
		 * and only changes WHEN the rebuild happens, so every synchronous reader
		 * (getListSnapshot -> ensureFresh) stays fresh.
		 * @param manager - the SessionManager owning the list snapshot.
		 * @returns how this call concluded.
		 */
		function patchListNotifier(manager) {
			const notifier = manager === void 0 || manager === null ? void 0 : manager.notifier;
			if (notifier === void 0 || notifier === null) return "no-notifier";
			if (notifier[FRAME_KEY] !== void 0) return "already";
			if (typeof notifier.markDirty !== "function") return "no-markDirty";
			if (typeof notifier.markFrameDirty !== "function") return "no-markFrameDirty";
			const original = notifier.markDirty;
			notifier[FRAME_KEY] = original;
			notifier.markDirty = function () {
				this.markFrameDirty();
			};
			return "patched";
		}

		/**
		 * Put the original microtask notification back.
		 * @param manager - the SessionManager whose notifier was redirected.
		 * @returns whether this call restored it.
		 */
		function restoreListNotifier(manager) {
			const notifier = manager === void 0 || manager === null ? void 0 : manager.notifier;
			if (notifier === void 0 || notifier === null) return false;
			const original = notifier[FRAME_KEY];
			if (original === void 0) return false;
			delete notifier[FRAME_KEY];
			notifier.markDirty = original;
			return true;
		}

		/**
		 * Append the spinner override once and stamp this evaluation as its owner, so
		 * a hot reload replaces ownership instead of leaving two stylesheets behind.
		 * @returns the install outcome.
		 */
		function installSpinnerStyle() {
			if (typeof document === "undefined") return "no-document";
			let optedOut = false;
			try {
				optedOut = globalThis.localStorage?.getItem(SPINNER_PREF) === "off";
			} catch {}
			if (optedOut) return "opted-out";
			const root = document.head ?? document.documentElement;
			if (root === null || root === void 0) return "no-head";
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = SPINNER_CSS;
				root.appendChild(style);
			}
			style[STYLE_OWNER_KEY] = STYLE_TOKEN;
			return "installed";
		}

		/**
		 * Re-install the override when something else removed it. The style element is
		 * plain DOM in a document other plugins also write to, so its disappearance is
		 * not ours to prevent — only to notice. Observed once on this machine: the
		 * element was gone with no removal we could attribute, and the spinner stayed
		 * frozen until it was put back by hand.
		 * @returns whether this call put the element back.
		 */
		function healSpinnerStyle() {
			if (typeof document === "undefined") return false;
			if (document.getElementById(STYLE_ID) !== null) return false;
			const outcome = installSpinnerStyle();
			if (outcome === "installed") report({ ok: true, kind: "spinner", event: "healed" });
			return outcome === "installed";
		}

		/**
		 * Watch the head for the removal of the override and put it back. Kept for the
		 * lifetime of the plugin: one childList observer on one element.
		 * @returns the install outcome for the report line.
		 */
		function watchSpinnerStyle() {
			if (typeof document === "undefined" || typeof MutationObserver !== "function") return "no-observer";
			const root = document.head ?? document.documentElement;
			if (root === null || root === void 0) return "no-head";
			if (root[OBSERVER_KEY] !== void 0) return "watching";
			const observer = new MutationObserver(() => { healSpinnerStyle(); });
			observer.observe(root, { childList: true });
			root[OBSERVER_KEY] = observer;
			return "watching";
		}

		/** Stop watching and remove the override when this evaluation still owns it. */
		function uninstallSpinnerStyle() {
			if (typeof document === "undefined") return;
			const root = document.head ?? document.documentElement;
			const observer = root === null || root === void 0 ? void 0 : root[OBSERVER_KEY];
			if (observer !== void 0) {
				observer.disconnect();
				delete root[OBSERVER_KEY];
			}
			const style = document.getElementById(STYLE_ID);
			if (style === null || style[STYLE_OWNER_KEY] !== STYLE_TOKEN) return;
			style.remove();
		}
		/**
		 * Install all three fixes and report one install line, so
		 * <DSH_HOME>/logs/projection-persist.log always shows whether each fix is live
		 * after a shell update.
		 */
		function apply(ctx) {
			const sessions = ctx.sessions;
			const manager = sessions?.manager;
			if (manager === void 0) {
				report({
					ok: false,
					kind: "install",
					error: "sessions.manager unavailable; clear() left unpatched"
				});
				return;
			}
			const sample = manager.projectionStores.values().next().value;
			const restored = patchPrototype(sample);
			let swept = 0;
			for (const store of manager.projectionStores.values()) if (patchStore(store)) swept += 1;
			let wrapped = false;
			let prototypePatched = restored !== void 0;
			const originalMethod = manager.projectionStore;
			if (manager[WRAP_KEY] === void 0 && typeof originalMethod === "function") {
				const wrapper = function (sessionId) {
					const store = originalMethod.call(this, sessionId);
					patchStore(store);
					// The first store to appear is also the first chance to patch the
					// prototype: at cold boot apply() runs before any session is restored,
					// so the class itself was still unreachable then.
					if (!prototypePatched) prototypePatched = patchPrototype(store) !== void 0;
					return store;
				};
				manager[WRAP_KEY] = wrapper;
				manager.projectionStore = wrapper;
				wrapped = true;
			}
			const framePatch = patchListNotifier(manager);
			const spinner = installSpinnerStyle();
			const watch = watchSpinnerStyle();
			ctx.effect(() => () => {
				if (wrapped) {
					delete manager[WRAP_KEY];
					manager.projectionStore = originalMethod;
				}
				if (restored !== void 0 && sample !== void 0) {
					const proto = Object.getPrototypeOf(sample);
					if (proto !== null && proto.clear === retainValues) proto.clear = restored;
				}
				restoreListNotifier(manager);
				uninstallSpinnerStyle();
			}, "projection-persist: restore");
			// The retention fix counts as live when any of its three paths is active: a
			// swept instance, the patched prototype, or the manager wrapper that patches
			// every store created later. At cold boot only the wrapper exists yet.
			const live = (sample !== void 0 && sample.clear === retainValues) || prototypePatched || wrapped;
			report({
				ok: live && framePatch === "patched",
				kind: "install",
				installed: sample === void 0 ? "wrapped-manager" : restored === void 0 ? "instance+prototype" : "instance",
				wrapped,
				swept,
				prototypePatched,
				stores: manager.projectionStores.size,
				framePatch,
				spinner,
				watch
			});
		}

		/** Required services: the object-layer cluster owning every projection store. */
		const inject = ["sessions"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
