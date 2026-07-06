import { parseSyncClientKind } from "./clientKind";

const CLIENT_KIND_STATE_KEY = "kaosClientKind";
const UNKNOWN_CLIENT_KIND = "unknown";

export type WsMessageLike = ArrayBuffer | ArrayBufferView | string;

export interface ConnectionStateCarrier {
	state: unknown;
	setState?: (state: unknown | ((prevState: unknown) => unknown)) => unknown;
}

export function attachConnectionClientKind(
	connection: ConnectionStateCarrier,
	request: Request,
): string {
	const clientKind = parseSyncClientKind(new URL(request.url));
	try {
		connection.setState?.((prevState: unknown) => ({
			...(isRecord(prevState) ? prevState : {}),
			[CLIENT_KIND_STATE_KEY]: clientKind,
		}));
	} catch {
		// Connection state is observability metadata only; sync must not fail if
		// a runtime refuses attachment writes.
	}
	return clientKind;
}

export function readConnectionClientKind(connection: Pick<ConnectionStateCarrier, "state">): string {
	const state = connection.state;
	if (!isRecord(state)) return UNKNOWN_CLIENT_KIND;
	const value = state[CLIENT_KIND_STATE_KEY];
	return typeof value === "string" && value.length > 0 ? value : UNKNOWN_CLIENT_KIND;
}

export function buildUpdateObservedTraceData(
	connection: Pick<ConnectionStateCarrier, "state">,
	message: WsMessageLike,
	docChanged: boolean,
): Record<string, unknown> {
	return {
		updateBytes: getWsMessageByteLength(message),
		docChanged,
		clientKind: readConnectionClientKind(connection),
	};
}

function getWsMessageByteLength(message: WsMessageLike): number {
	if (typeof message === "string") return message.length;
	if (message instanceof ArrayBuffer) return message.byteLength;
	return message.byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
