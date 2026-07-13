export async function withAttentionResolutionLock<T>(
	inFlight: Set<string>,
	key: string,
	displayPath: string,
	action: () => Promise<T>,
): Promise<T> {
	if (inFlight.has(key)) {
		throw new Error(`Another Attention action is already running for "${displayPath}".`);
	}
	inFlight.add(key);
	try {
		return await action();
	} finally {
		inFlight.delete(key);
	}
}
