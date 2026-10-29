// Read-only live room dump: joins as the oracle instance device, waits for
// sync, then writes the full Y.Doc update + per-file summary to disk.
// Never writes to the room. usage: node audit-room-dump.mjs
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";

const session = JSON.parse(readFileSync("/tmp/kaos-audit-session.json", "utf8"));
const { host, vaultId, bearer } = session;

const ticketRes = await fetch(`${host}/vault/${vaultId}/auth/ticket`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
	body: JSON.stringify({}),
});
const ticketBody = await ticketRes.json().catch(() => null);
if (!ticketRes.ok || !ticketBody?.ticket) {
	console.error("ticket failed", ticketRes.status, JSON.stringify(ticketBody));
	process.exit(1);
}
const ticket = ticketBody.ticket;
console.error("ticket ok");

class TicketProtocolWebSocket {
	constructor(url) {
		const parsed = new URL(String(url));
		const t = parsed.searchParams.get("ticket");
		parsed.searchParams.delete("ticket");
		parsed.searchParams.delete("token");
		if (!t) throw new Error("ticket missing");
		return new WebSocket(parsed.toString(), [`kaos-ticket.${t}`]);
	}
}

const doc = new Y.Doc();
const provider = new YSyncProvider(host, vaultId, doc, {
	prefix: `/vault/sync/${vaultId}`,
	params: async () => ({ schemaVersion: "4", ticket }),
	WebSocketPolyfill: TicketProtocolWebSocket,
	connect: true,
});

const timeout = setTimeout(() => {
	console.error("TIMEOUT waiting for sync");
	process.exit(2);
}, 20000);

provider.on("sync", () => {
	clearTimeout(timeout);
	console.error("synced");
	setTimeout(() => {
		const update = Y.encodeStateAsUpdate(doc);
		writeFileSync("/tmp/kaos-room-live.bin", update);
		const meta = doc.getMap("meta");
		const idToText = doc.getMap("idToText");
		const summary = [];
		for (const [fileId, value] of meta.entries()) {
			const path = value instanceof Y.Map ? value.get("path") : value?.path;
			const deleted = value instanceof Y.Map ? value.get("deletedAt") : value?.deletedAt;
			const ytext = idToText.get(fileId);
			summary.push({
				fileId,
				path: typeof path === "string" ? path : null,
				deleted: deleted !== undefined && deleted !== null,
				bytes: ytext ? Buffer.byteLength(ytext.toString()) : 0,
			});
		}
		writeFileSync("/tmp/kaos-room-live-summary.json", JSON.stringify(summary, null, 1));
		console.error(`dumped: ${summary.length} file entries, ${update.length} bytes`);
		process.exit(0);
	}, 1500);
});
