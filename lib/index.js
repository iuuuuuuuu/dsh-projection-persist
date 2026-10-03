/**
 * Host half of dsh-projection-persist.
 *
 * The fix itself lives in the browser half (see lib/client.js): it replaces
 * ProjectionValueStore#clear so a rebuilt connection generation keeps every
 * projection value instead of dropping the session titles. This half only
 * owns a diagnostics sink under /dsh-projection-persist so the browser half
 * (and any probe) can leave evidence on disk, which survives the desktop
 * shell throttling iframe console output.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const name = "projection-persist";
const ROUTE = "/dsh-projection-persist";
const LOG_NAME = "projection-persist.log";
const REVISION = 6;

/** Resolve <home>/logs/<LOG_NAME> from the running profile. */
function reportFile(ctx) {
	const home = ctx.get("profileContext")?.home ?? process.env.DSH_HOME ?? process.cwd();
	return join(home, "logs", LOG_NAME);
}

/** Read a whole request body as text. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function apply(ctx) {
	ctx.inject(["webServer"], (sctx) => {
		sctx.effect(() => {
			const dispose = sctx.webServer.register({
				kind: "prefix",
				path: ROUTE,
				handler: async (req, res) => {
					if (req.method === "GET") {
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ ok: true, name, revision: REVISION }));
						return;
					}
					if (req.method !== "POST") {
						res.writeHead(405);
						res.end();
						return;
					}
					try {
						const body = await readBody(req);
						if (body !== "") appendFileSync(reportFile(sctx), body + "\n", "utf8");
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
					} catch (error) {
						res.writeHead(500);
						res.end(String(error));
					}
				}
			}, "projection-persist: report sink");
			return () => {
				dispose();
			};
		}, "projection-persist: report sink");
	});
}

export { apply, name };
