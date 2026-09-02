import type { VaultSyncSettings } from "../settings";

/**
 * Resolves a short-lived, device-bound session header at request time.  The
 * provider lives only in process memory and is deliberately not serializable
 * into Obsidian's plugin data.
 */
export async function getDeviceAuthorizationHeader(
	settings: Pick<VaultSyncSettings, "authorizationHeader">,
): Promise<string> {
	const header = await settings.authorizationHeader?.();
	if (!header || !/^Bearer\s+\S+$/.test(header)) {
		throw new Error("This device is not approved for KAOS sync.");
	}
	return header;
}
