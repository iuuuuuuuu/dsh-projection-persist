window.__ModuleLoader__.load({
	id: "dsh-projection-persist",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * Keep session projection values alive across a Host generation reset.
		 *
		 * SessionManager.handleConnected() runs on every rebuilt connection
		 * generation and calls clear() on each resident projection store. The
		 * shipped clear() DELETES every row, so the session list loses every
		 * title until refreshList() answers — the "session title flickers to
		 * 未命名" symptom. This half replaces clear() so the VALUE of every row
		 * survives and only the sequence watermark is dropped: each `sequenced`
		 * row is downgraded in place to a `cached` row, which a later cached
		 * list block or a lower-seq frame may still overwrite.
		 *
		 * The downgrade is required (a plain no-op is wrong): apply() rejects a
		 * frame whose seq is not newer than a `sequenced` row, so keeping the
		 * old watermark would deadlock the new generation's lower-seq frames.
		 */
		const REVISION = 6;
		/** Diagnostics sink owned by the host half. */
		const ROUTE = "/dsh-projection-persist";
		/** Own-property marker proving the manager method is already wrapped. */
		const WRAP_KEY = "__dshProjectionPersistWrap";

		/**
		 * Replacement for ProjectionValueStore#clear: retain every value, drop
		 * every watermark, and fire the same per-key change notification the
		 * original fired so subscribed faces and the list projection rebuild.
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
		 * Post one JSON evidence line to the host sink. Best effort: a desktop
		 * shell throttles iframe console output, so this is the only durable
		 * channel. Never let a failed report break the fix.
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
		 * Patch the class itself once a resident instance proves it reachable, so
		 * even a store created outside the manager map is covered.
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
		 * Install the patch on every reachable projection store and report one
		 * install line, so <DSH_HOME>/logs/projection-persist.log always shows
		 * whether the fix is live after a shell update.
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
			const originalMethod = manager.projectionStore;
			if (manager[WRAP_KEY] === void 0 && typeof originalMethod === "function") {
				const wrapper = function (sessionId) {
					const store = originalMethod.call(this, sessionId);
					patchStore(store);
					return store;
				};
				manager[WRAP_KEY] = wrapper;
				manager.projectionStore = wrapper;
				wrapped = true;
			}
			ctx.effect(() => () => {
				if (manager[WRAP_KEY] !== void 0) {
					delete manager[WRAP_KEY];
					manager.projectionStore = originalMethod;
				}
				if (restored !== void 0 && sample !== void 0) {
					const proto = Object.getPrototypeOf(sample);
					if (proto !== null && proto.clear === retainValues) proto.clear = restored;
				}
			}, "projection-persist: restore");
			const live = sample !== void 0 && sample.clear === retainValues;
			report({
				ok: live,
				kind: "install",
				installed: sample === void 0 ? "wrapped-manager" : restored === void 0 ? "instance+prototype" : "instance",
				wrapped,
				swept,
				prototypePatched: restored !== void 0,
				stores: manager.projectionStores.size
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
