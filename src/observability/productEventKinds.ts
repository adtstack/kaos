/**
 * Product-owned event kind constants.
 *
 * Product sync/runtime code uses these constants instead of importing
 * FLIGHT_KIND from debug/flightEvents.ts. This breaks the product→lab
 * dependency and allows lab code to be dynamically loaded or evicted.
 *
 * The lab layer (FlightTraceSink) maps these to the flight recorder schema.
 * The string values must match FLIGHT_KIND values exactly for compatibility.
 */

export const PRODUCT_EVENT_KIND = {
	// CRDT lifecycle
	crdtFileCreated: "crdt.file.created",
	crdtFileUpdated: "crdt.file.updated",
	crdtFileRenamed: "crdt.file.renamed",
	crdtFileTombstoned: "crdt.file.tombstoned",
	crdtFileRevived: "crdt.file.revived",

	// Disk observations
	diskWriteOk: "disk.write.ok",
	diskWriteCommitted: "disk.write.committed",
	diskWriteFailed: "disk.write.failed",
	diskEventNotSuppressed: "disk.event.not_suppressed",

	// Reconcile
	reconcileStart: "reconcile.start",
	reconcileComplete: "reconcile.complete",
	reconcileFileDecision: "reconcile.file.decision",
	reconcileSafetyBrakeTriggered: "reconcile.safety_brake.triggered",
	reconcileModeDowngraded: "reconcile.mode.downgraded",
	reconcileForcedUnhydrated: "reconcile.forced_unhydrated",

	// Recovery
	recoveryDecision: "recovery.decision",
	recoveryApplyStart: "recovery.apply.start",
	recoveryApplyDone: "recovery.apply.done",
	recoverySkipped: "recovery.skipped",
	recoveryRestoreFullStarted: "recovery.restore.full.started",
	recoveryRestoreFullCompleted: "recovery.restore.full.completed",
	recoveryRestoreFullFailed: "recovery.restore.full.failed",
	recoveryPostconditionFailed: "recovery.postcondition.failed",
	recoveryQuarantined: "recovery.quarantined",
	recoveryLoopDetected: "recovery.loop.detected",
	recoveryAmplificationQuarantined: "recovery.amplification.quarantined",

	// Editor
	editorHealApplied: "editor.heal.applied",
	editorRepairApplied: "editor.repair.applied",
	editorAuthorityShieldApplied: "editor.authority_shield.applied",
	providerRegressiveDeleteSuspected: "editor.provider_regressive_delete.suspected",
	editorCausalityObserved: "editor.causality.observed",
	diskModifyClassified: "disk.modify.classified",
	bindingDivergenceObserved: "binding.divergence.observed",
} as const;

export type ProductEventKind =
	typeof PRODUCT_EVENT_KIND[keyof typeof PRODUCT_EVENT_KIND];
