/**
 * Durable audit client for discarded markdown revisions.
 *
 * With conflict-artifact preservation abolished, a losing revision (a
 * superseded disk snapshot, a closed-file conflict loser, an ambiguous
 * divergence side) is no longer written to a `(KAOS conflict ...)` file.
 * This client records each discard to the kaos server's durable trace store
 * (POST /vault/:id/trace) so the loss stays observable: path identity is
 * hashed (no raw vault path leaves the device), content identity is the
 * sha256 content hash, and the reason names the policy decision.
 *
 * Records are debounced into small batches and posted fire-and-forget;
 * failures are silent (audit is best-effort by design — the CRDT journal,
 * server snapshots, the disk-index baseline, and git remain the recovery
 * layer).
 *
 * This module is intentionally Obsidian-free so it can be imported in Node
 * regression tests; the plugin wires the real HTTP transport via
 * {@link DiscardedRevisionAuditDeps.postJson}.
 */

import { contentFingerprint } from "../sync/diskIndex";

/** One discarded revision record, ready for server-side storage. */
export interface DiscardedRevisionRecord {
	/** FNV-1a fingerprint of the vault-relative path (no raw path). */
	pathHash: string;
	/** sha256 hex of the discarded content. */
	contentHash: string;
	/** Policy reason string (e.g. "superseded-external-revision"). */
	reason: string;
	/** ISO timestamp at discard time (client clock). */
	ts: string;
}

export interface DiscardedRevisionAuditDeps {
	getSettings(): { host: string; token: string; vaultId: string };
	/** Injectable transport for tests; the plugin wires obsidianRequest. */
	postJson?: (url: string, body: unknown) => Promise<{ ok: boolean }>;
}

/** Debounce before the first flush of a burst (ms). */
export const AUDIT_FLUSH_DELAY_MS = 1000;
/** Maximum records per POST batch. */
export const AUDIT_MAX_BATCH = 20;

export class DiscardedRevisionAudit {
	private readonly queue: DiscardedRevisionRecord[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;
	private readonly flushDelayMs: number;

	constructor(
		private readonly deps: DiscardedRevisionAuditDeps,
		options: { flushDelayMs?: number } = {},
	) {
		this.flushDelayMs = options.flushDelayMs ?? AUDIT_FLUSH_DELAY_MS;
	}

	/**
	 * Queue a discarded revision for server-side audit. Content hashes are
	 * expected to be sha256 hex from contentBaselineHash(); no hashing of
	 * content is performed here.
	 */
	record(path: string, contentHash: string, reason: string): void {
		this.queue.push({
			pathHash: contentFingerprint(path),
			contentHash,
			reason,
			ts: new Date().toISOString(),
		});
		if (this.queue.length >= AUDIT_MAX_BATCH) {
			void this.flush();
			return;
		}
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, this.flushDelayMs);
	}

	/** Flush pending records immediately (plugin shutdown). */
	async flushNow(): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await this.flush();
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.queue.length === 0) return;
		const settings = this.deps.getSettings();
		if (!settings.host || !settings.token || !settings.vaultId) return;

		this.flushing = true;
		const batch = this.queue.splice(0, AUDIT_MAX_BATCH);
		try {
			const url = `${settings.host.replace(/\/$/, "")}/vault/${encodeURIComponent(settings.vaultId)}/trace`;
			await this.deps.postJson?.(url, {
				event: "revision.discarded",
				data: { records: batch },
			});
		} catch {
			// Best-effort audit: transport failures are silent and the batch is
			// dropped rather than retried (discard records are advisory).
		} finally {
			this.flushing = false;
		}
	}
}
