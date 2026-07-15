export interface BlobAuthorityScope {
	host: string;
	vaultId: string;
	localDeviceId: string;
}

export type BlobAuthorityPersistenceLane = "pending" | "settled";

/** Identity-only token captured before an asynchronous authority operation. */
export interface BlobAuthorityScopeToken {
	readonly identity: string | null;
	readonly epoch: number;
}

/**
 * One load attempt for one exact store instance. The monotonically increasing
 * lane attempt prevents concurrent same-scope loads from both installing state.
 */
export interface BlobAuthorityEnsureToken extends BlobAuthorityScopeToken {
	readonly lane: BlobAuthorityPersistenceLane;
	readonly attempt: number;
	readonly key: string;
	readonly store: object;
}

export interface BlobAuthorityScopeActivation {
	readonly changed: boolean;
	readonly scope: BlobAuthorityScope;
	readonly token: BlobAuthorityScopeToken;
}

/** Canonicalize exactly the host/vault/device tuple that owns blob authority. */
export function canonicalizeBlobAuthorityScope(
	scope: BlobAuthorityScope,
): BlobAuthorityScope {
	let host = scope.host.trim().replace(/\/+$/, "");
	try {
		const url = new URL(host);
		url.hash = "";
		url.search = "";
		host = url.toString().replace(/\/+$/, "");
	} catch {
		// Invalid hosts fail connection elsewhere. Keeping the exact trimmed value
		// prevents an invalid setting from aliasing a different valid authority.
	}
	return {
		host,
		vaultId: scope.vaultId.trim(),
		localDeviceId: scope.localDeviceId.trim(),
	};
}

/** Invalid/incomplete scopes deliberately share the fail-closed null identity. */
export function buildBlobAuthorityScopeIdentity(
	scope: BlobAuthorityScope,
): string | null {
	const canonical = canonicalizeBlobAuthorityScope(scope);
	if (!canonical.host || !canonical.vaultId || !canonical.localDeviceId) return null;
	return JSON.stringify([
		canonical.host,
		canonical.vaultId,
		canonical.localDeviceId,
	]);
}

/**
 * Generation fence shared by the pending-intent and settled-ref stores.
 *
 * This class intentionally owns no IndexedDB state. A caller first advances
 * the epoch, synchronously revokes its global authority, and then uses tokens
 * to decide whether delayed load/save completions may touch current state.
 */
export class BlobAuthorityScopeGuard {
	private identity: string | null = null;
	private epoch = 0;
	private readonly ensureAttempts: Record<BlobAuthorityPersistenceLane, number> = {
		pending: 0,
		settled: 0,
	};

	activate(
		scope: BlobAuthorityScope,
		options: { force?: boolean } = {},
	): BlobAuthorityScopeActivation {
		const canonical = canonicalizeBlobAuthorityScope(scope);
		const identity = buildBlobAuthorityScopeIdentity(canonical);
		if (!options.force && identity === this.identity) {
			return { changed: false, scope: canonical, token: this.capture() };
		}

		// Epoch advances before the caller clears refs, stores, or health. Every
		// completion holding the previous token is stale from this line onward.
		this.epoch++;
		this.identity = identity;
		return { changed: true, scope: canonical, token: this.capture() };
	}

	capture(): BlobAuthorityScopeToken {
		return { identity: this.identity, epoch: this.epoch };
	}

	beginEnsure(
		lane: BlobAuthorityPersistenceLane,
		scope: BlobAuthorityScope,
		key: string,
		store: object,
	): BlobAuthorityEnsureToken {
		const attempt = ++this.ensureAttempts[lane];
		return {
			identity: buildBlobAuthorityScopeIdentity(scope),
			epoch: this.epoch,
			lane,
			attempt,
			key,
			store,
		};
	}

	isCurrent(
		token: BlobAuthorityScopeToken,
		scope?: BlobAuthorityScope,
	): boolean {
		return token.epoch === this.epoch
			&& token.identity === this.identity
			&& (scope === undefined
				|| buildBlobAuthorityScopeIdentity(scope) === this.identity);
	}

	isCurrentEnsure(
		token: BlobAuthorityEnsureToken,
		scope: BlobAuthorityScope,
		key: string,
		store: object,
	): boolean {
		return this.isCurrent(token, scope)
			&& token.key === key
			&& token.store === store
			&& token.attempt === this.ensureAttempts[token.lane];
	}

	get currentIdentity(): string | null {
		return this.identity;
	}

	get currentEpoch(): number {
		return this.epoch;
	}
}
