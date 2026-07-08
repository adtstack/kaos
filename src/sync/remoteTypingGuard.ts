export const KAOS_ACTIVE_FILE_AWARENESS_FIELD = "kaosActiveFile";
export const KAOS_TYPING_AWARENESS_FIELD = "kaosTyping";
export const REMOTE_TYPING_ACTIVE_MS = 8_000;

export interface RemoteTypingPeer {
	clientId: number;
	deviceName: string;
	path: string;
	at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readDeviceName(state: Record<string, unknown>, clientId: number): string {
	const typing = state[KAOS_TYPING_AWARENESS_FIELD];
	if (isRecord(typing) && typeof typing.deviceName === "string" && typing.deviceName.trim()) {
		return typing.deviceName.trim();
	}

	const user = state.user;
	if (isRecord(user) && typeof user.name === "string" && user.name.trim()) {
		return user.name.trim();
	}

	return `device-${clientId}`;
}

export function buildTypingAwareness(path: string, deviceName: string, at = Date.now()): Record<string, unknown> {
	return {
		path,
		deviceName,
		at,
	};
}

export function buildActiveFileAwareness(path: string, deviceName: string, at = Date.now()): Record<string, unknown> {
	return {
		path,
		deviceName,
		at,
	};
}

export function collectActiveRemoteTypers(
	states: Iterable<[number, Record<string, unknown>]>,
	localClientId: number | null,
	path: string,
	now = Date.now(),
	activeMs = REMOTE_TYPING_ACTIVE_MS,
): RemoteTypingPeer[] {
	const peers: RemoteTypingPeer[] = [];
	for (const [clientId, state] of states) {
		if (localClientId !== null && clientId === localClientId) continue;

		const typing = state[KAOS_TYPING_AWARENESS_FIELD];
		if (!isRecord(typing)) continue;
		if (typing.path !== path) continue;
		if (typeof typing.at !== "number" || !Number.isFinite(typing.at)) continue;
		if (typing.at > now + 1000) continue;
		if (now - typing.at > activeMs) continue;

		peers.push({
			clientId,
			deviceName: readDeviceName(state, clientId),
			path,
			at: typing.at,
		});
	}

	return peers.sort((a, b) => b.at - a.at || a.clientId - b.clientId);
}

export function formatRemoteTypers(peers: RemoteTypingPeer[]): string {
	const names = [...new Set(peers.map((peer) => peer.deviceName))];
	if (names.length === 0) return "Another device";
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} and ${names.length - 1} other devices`;
}
