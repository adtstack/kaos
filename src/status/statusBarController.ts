import type { ConnectionState } from "../runtime/connectionController";

export type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

export type ServerReceiptStatus = {
	serverAppliedLocalState: boolean | null;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean | null;
	serverReceiptStartupValidation: string | null;
};

export function getSyncStatusLabel(state: SyncStatus): string {
	const labels: Record<SyncStatus, string> = {
		disconnected: "CRDT: Disconnected",
		loading: "CRDT: Loading cache...",
		syncing: "CRDT: Syncing...",
		connected: "CRDT: Connected",
		offline: "CRDT: Offline",
		error: "CRDT: Error",
		unauthorized: "CRDT: Unauthorized",
	};
	return labels[state];
}

export interface UnsyncedEditsSummary {
	hasUnsynced: boolean;
	unsyncedFileCount: number;
	activeUnsyncedChars: number;
	activeHasUnsynced: boolean;
	/** Open views whose push is frozen by a conflict hold awaiting resolution. */
	conflictHoldCount: number;
	activeConflictHold: boolean;
}

/**
 * Derives a status bar label directly from the rich `ConnectionState`. This
 * replaces the coarse 7-value SyncStatus → label mapping for the visible
 * status bar text, allowing the user to see auth rejection reasons and
 * schema-mismatch details without a full dashboard. Per the stabilization
 * plan (INV-AUTH-01): not a dashboard — just enough truth.
 */
export function getLabelFromConnectionState(
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
	unsyncedSummary?: UnsyncedEditsSummary | null,
): string {
	let base: string;
	switch (state.kind) {
		case "disconnected":
			base = "KAOS: Disconnected";
			break;
		case "loading_cache":
			base = "KAOS: Loading...";
			break;
		case "connecting":
			base = "KAOS: Connecting...";
			break;
		case "online":
			base = "KAOS: Connected";
			break;
		case "offline":
			base = "KAOS: Offline";
			break;
		case "auth_failed":
			switch (state.code) {
				case "unclaimed":
					base = "KAOS: Server unclaimed";
					break;
				case "server_misconfigured":
					base = "KAOS: Server misconfigured";
					break;
				case "unauthorized":
				default:
					base = "KAOS: Auth rejected";
					break;
			}
			break;
		case "server_update_required":
			base = "KAOS: Update required";
			break;
	}
	if (transferStatus) base = `${base} (${transferStatus})`;
	const receipt = serverReceipt && shouldShowReceiptStatus(state)
		? getServerReceiptStatusLabel(serverReceipt, state.kind === "online")
		: null;
	if (attentionCount > 0) {
		base = `${base} · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	const unsyncedSegment = formatUnsyncedSegment(unsyncedSummary, state.kind === "online");
	if (unsyncedSegment) base = `${base} · ${unsyncedSegment}`;
	return receipt ? `${base} · ${receipt}` : base;
}

/**
 * Status-bar segment for editor-to-CRDT residue and conflict holds.
 *
 * Plain residue is transient while connected (realtime push), so it is only
 * shown when not connected. A conflict hold freezes the push (and remote
 * projection) until resolved, so it is shown regardless of connection state
 * and regardless of whether the editor currently differs from the base.
 */
export function formatUnsyncedSegment(
	summary: UnsyncedEditsSummary | null | undefined,
	connected: boolean,
): string | null {
	if (!summary) return null;
	const parts: string[] = [];
	const showResidue = summary.hasUnsynced &&
		(!connected || (summary.activeHasUnsynced && summary.activeConflictHold));
	if (showResidue) {
		if (summary.activeHasUnsynced) {
			const count = Math.abs(summary.activeUnsyncedChars);
			const conflict = summary.activeConflictHold ? " (conflict)" : "";
			parts.push(`${count > 0 ? `${count} unsynced chars` : "unsynced edits"}${conflict}`);
		} else {
			parts.push(`${summary.unsyncedFileCount} unsynced file${summary.unsyncedFileCount === 1 ? "" : "s"}`);
		}
	}
	// Conflict holds not already described by the active-note segment above.
	const describedActive = showResidue && summary.activeHasUnsynced && summary.activeConflictHold;
	const otherHolds = summary.conflictHoldCount - (describedActive ? 1 : 0);
	if (otherHolds > 0) {
		parts.push(`${otherHolds} sync conflict${otherHolds === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

function shouldShowReceiptStatus(state: ConnectionState): boolean {
	return state.kind === "online" || state.kind === "offline";
}

function fmtTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function getServerReceiptStatusLabel(
	receipt: ServerReceiptStatus,
	connected: boolean,
): string {
	let label: string;
	if (receipt.serverAppliedLocalState === true && connected) {
		label = "Receipt: received";
	} else if (receipt.serverAppliedLocalState === false && connected) {
		label = "Receipt: waiting";
	} else if (receipt.serverAppliedLocalState === false && !connected) {
		label = "Receipt: offline, waiting";
	} else if (receipt.serverAppliedLocalState === true && !connected && receipt.lastServerReceiptEchoAt !== null) {
		label = `Receipt: offline, last echo ${fmtTime(receipt.lastServerReceiptEchoAt)}`;
	} else if (receipt.serverReceiptStartupValidation === "skipped_local_yjs_timeout") {
		label = "Receipt: restart unchecked";
	} else if (receipt.lastKnownServerReceiptEchoAt !== null && receipt.lastServerReceiptEchoAt === null) {
		label = "Receipt: checking";
	} else {
		label = "Receipt: not tracked";
	}
	if (receipt.candidatePersistenceHealthy === false) {
		label += " (persistence degraded)";
	}
	return label;
}

export function renderSyncStatus(
	statusBarEl: HTMLElement,
	state: SyncStatus,
	transferStatus?: string | null,
	attentionCount = 0,
	unsyncedSummary?: UnsyncedEditsSummary | null,
): void {
	let text = getSyncStatusLabel(state);
	if (transferStatus) {
		text += ` (${transferStatus})`;
	}
	if (attentionCount > 0) {
		text += ` · ${attentionCount} file${attentionCount === 1 ? "" : "s"} need attention`;
	}
	const unsyncedSegment = formatUnsyncedSegment(unsyncedSummary, state === "connected");
	if (unsyncedSegment) text += ` · ${unsyncedSegment}`;
	statusBarEl.setText(text);
}

/**
 * Renders the status bar using the rich ConnectionState label. Prefer this
 * over renderSyncStatus when the ConnectionState is available.
 */
export function renderConnectionState(
	statusBarEl: HTMLElement,
	state: ConnectionState,
	transferStatus?: string | null,
	serverReceipt?: ServerReceiptStatus | null,
	attentionCount = 0,
	unsyncedSummary?: UnsyncedEditsSummary | null,
): void {
	statusBarEl.setText(getLabelFromConnectionState(state, transferStatus, serverReceipt, attentionCount, unsyncedSummary));
	let title = serverReceipt && shouldShowReceiptStatus(state)
		? "Server receipt means the server Y.Doc received this device's latest local CRDT state. It is not durable and does not mean other devices have applied it."
		: "";
	const connected = state.kind === "online";
	const notes: string[] = [];
	if (unsyncedSummary?.hasUnsynced && !connected) {
		notes.push("Local edits have not yet synced to the server.");
	}
	if ((unsyncedSummary?.conflictHoldCount ?? 0) > 0) {
		notes.push(
			"A sync conflict froze syncing for an open note: local and remote edits overlap. " +
			"Both versions are kept until it is resolved.",
		);
	}
	if (notes.length > 0) {
		title = (title ? `${title}\n` : "") + notes.join("\n");
	}
	statusBarEl.setAttr("title", title);
}
