// Minimal one-shot CDP evaluator for a running Obsidian QA instance.
// Picks the main app page target and evaluates one expression with
// awaitPromise + returnByValue. Async results that returnByValue drops can
// be stashed on window.__R and read with a second synchronous call.
//
// Usage: QA_CDP_PORT=9223 node qa/scripts/cdp-eval.mjs '<js expression>'
import WebSocket from "ws";

const PORT = parseInt(process.env.QA_CDP_PORT ?? "9223", 10);
const expr = process.argv[2];
if (!expr) { console.error("usage: node qa/scripts/cdp-eval.mjs '<expr>'"); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("index.html")) ||
	list.find((t) => t.type === "page" && t.title.includes("Obsidian"));
if (!page) { console.error("no obsidian page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const msgId = ++id;
		pending.set(msgId, { resolve, reject });
		ws.send(JSON.stringify({ id: msgId, method, params }));
	});
}
ws.on("message", (raw) => {
	const msg = JSON.parse(raw.toString());
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(msg.error.message));
		else resolve(msg.result);
	}
});
ws.on("open", async () => {
	try {
		await send("Runtime.enable");
		const result = await send("Runtime.evaluate", {
			expression: expr,
			awaitPromise: true,
			returnByValue: true,
			replMode: true,
		});
		if (result.exceptionDetails) {
			console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text, null, 2).slice(0, 2000));
			process.exitCode = 1;
		} else {
			console.log(JSON.stringify(result.result.value ?? result.result.description ?? null, null, 1));
		}
	} catch (e) {
		console.error("CDP error:", e.message);
		process.exitCode = 1;
	} finally {
		ws.close();
	}
});
