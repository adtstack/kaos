import type {
	DashboardBlobConflictResolutionChoice,
	DashboardBlobConflictResolutionResult,
} from "../dashboard/dashboardTypes";
import type {
	BlobDownloadConflictResolutionIdentity,
	BlobQueueSnapshot,
} from "../sync/blobSync";
import { sameBlobRef, type BlobRef } from "../types";

export interface BlobConflictResolutionAdmission {
	path: string;
	choice: DashboardBlobConflictResolutionChoice;
	authorityReady: boolean;
	expectedRemoteRef: BlobRef | null;
	expectedRemoteSourceVersion: string | null;
	currentRemoteRef: BlobRef | undefined;
	currentRemoteSourceVersion: string | undefined;
	artifactIsExactFile: boolean;
	originalIsExactFile: boolean;
	canResumeRemoteVacancy: boolean;
	hasPendingLocalMutation: boolean;
	queueAuthorityAvailable: boolean;
}

/** Pure admission gate shared by the Obsidian Dashboard action and its tests. */
export function assertBlobConflictResolutionAdmission(
	input: BlobConflictResolutionAdmission,
): asserts input is BlobConflictResolutionAdmission & {
	expectedRemoteRef: BlobRef;
	expectedRemoteSourceVersion: string;
} {
	if (input.choice !== "keep-local" && input.choice !== "use-remote-copy") {
		throw new Error("Unknown attachment conflict resolution choice.");
	}
	if (!input.authorityReady) {
		throw new Error("Attachment authority is still initializing. Refresh the dashboard.");
	}
	if (!input.expectedRemoteRef || !input.expectedRemoteSourceVersion) {
		throw new Error("Exact remote attachment authority is unavailable. Refresh the dashboard.");
	}
	if (!input.artifactIsExactFile) {
		throw new Error("The reviewed remote conflict copy must still be a file.");
	}
	if (!input.originalIsExactFile && !input.canResumeRemoteVacancy) {
		throw new Error("The current local attachment is missing or changed type.");
	}
	if (
		!sameBlobRef(input.currentRemoteRef, input.expectedRemoteRef)
		|| input.currentRemoteSourceVersion !== input.expectedRemoteSourceVersion
	) {
		throw new Error(`Remote attachment changed for "${input.path}". Refresh the dashboard.`);
	}
	if (input.hasPendingLocalMutation) {
		throw new Error(`Another local attachment mutation is already pending: ${input.path}`);
	}
	if (!input.queueAuthorityAvailable) {
		throw new Error("Attachment queue authority scope is unavailable.");
	}
}

interface BlobConflictResolutionExecution {
	path: string;
	choice: DashboardBlobConflictResolutionChoice;
	identity: BlobDownloadConflictResolutionIdentity;
	keepLocal(
		path: string,
		identity: BlobDownloadConflictResolutionIdentity,
		persistQueue: (snapshot: BlobQueueSnapshot) => Promise<void>,
	): Promise<void>;
	useRemote(
		path: string,
		identity: BlobDownloadConflictResolutionIdentity,
		persistQueue: (snapshot: BlobQueueSnapshot) => Promise<void>,
	): Promise<{ safetyCopyPath: string | null; artifactRemoved: boolean }>;
	persistKeepLocalQueue(snapshot: BlobQueueSnapshot): Promise<void>;
	persistUseRemoteQueue(snapshot: BlobQueueSnapshot): Promise<void>;
	persistPluginState(): Promise<void>;
}

/**
 * Preserve the action ordering that makes the Dashboard choice crash-safe:
 * engine mutation -> exact queue persistence -> complete plugin-state save.
 */
export async function executeBlobConflictResolution(
	input: BlobConflictResolutionExecution,
): Promise<DashboardBlobConflictResolutionResult> {
	if (input.choice === "keep-local") {
		await input.keepLocal(
			input.path,
			input.identity,
			(snapshot) => input.persistKeepLocalQueue(snapshot),
		);
		await input.persistPluginState();
		return {
			status: "pending",
			message: `Publishing the selected local attachment: ${input.path}`,
		};
	}

	const result = await input.useRemote(
		input.path,
		input.identity,
		(snapshot) => input.persistUseRemoteQueue(snapshot),
	);
	await input.persistPluginState();
	return {
		status: "completed",
		safetyCopyPath: result.safetyCopyPath,
		artifactRemoved: result.artifactRemoved,
	};
}
