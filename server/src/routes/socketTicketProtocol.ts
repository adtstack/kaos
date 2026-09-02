/**
 * Parse the one-time WebSocket ticket from the only accepted transport:
 * `Sec-WebSocket-Protocol: kaos-ticket.<opaque>`.  Keeping this independent
 * of the PartyServer runtime makes the URL-token rejection testable in Node.
 */
export function getSocketTicketFromProtocol(req: Request): string | null {
	const protocols = req.headers.get("Sec-WebSocket-Protocol");
	if (!protocols) return null;
	const prefix = "kaos-ticket.";
	const candidates = protocols
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.startsWith(prefix));
	if (candidates.length !== 1) return null;
	const ticket = candidates[0].slice(prefix.length);
	return /^[A-Za-z0-9_-]{32,256}$/.test(ticket) ? ticket : null;
}
