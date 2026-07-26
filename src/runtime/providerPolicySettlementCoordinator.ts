export interface ProviderPolicySettlementRequest {
	readonly vaultSync: object;
	readonly generation: number;
	readonly reason: string;
}

/**
 * Coalesces settlement requests without losing a newer provider generation.
 *
 * Only the latest request waiting behind the active disk read is needed, but
 * the active promise does not complete until that latest request has also run.
 */
export class ProviderPolicySettlementCoordinator {
	private pending: ProviderPolicySettlementRequest | null = null;
	private inFlight: Promise<void> | null = null;

	constructor(
		private readonly settle: (
			request: ProviderPolicySettlementRequest,
		) => Promise<void>,
	) {}

	request(request: ProviderPolicySettlementRequest): Promise<void> {
		this.pending = request;
		if (this.inFlight) return this.inFlight;

		const run = this.drain().finally(() => {
			if (this.inFlight === run) this.inFlight = null;
		});
		this.inFlight = run;
		return run;
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const next = this.pending;
			this.pending = null;
			await this.settle(next);
		}
	}
}
