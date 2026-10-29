import { App, ItemView, Modal, Notice, Platform, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import type {
	AttentionAuditItem,
	AttentionAuditResult,
	AttentionRetirementSummary,
	AttentionRetirementTarget,
	DashboardAttentionItem,
	DashboardBlobConflictResolutionChoice,
	DashboardBlobConflictResolutionResult,
	DashboardBlobConflictResolutionTarget,
	DashboardConflictArtifact,
	DashboardMetric,
	DashboardRecentChange,
	DashboardRecentChanges,
	DashboardFileHistoryAttempt,
	DashboardLegacyMissingBlobResolution,
	DashboardLegacyMissingBlobResolutionChoice,
	DashboardLegacyMissingBlobResolutionTarget,
	DashboardMarkdownConflictResolution,
	DashboardMarkdownConflictReviewSides,
	DashboardMarkdownConflictResolutionChoice,
	DashboardMarkdownConflictResolutionResult,
	DashboardMarkdownConflictResolutionTarget,
	DashboardRemoteDeleteResolution,
	DashboardRemoteDeleteResolutionChoice,
	DashboardRemoteDeleteResolutionResult,
	DashboardRemoteDeleteResolutionTarget,
	DashboardRecoveryHistoryTarget,
	DashboardRecoveryStorageStatus,
	DashboardStuckLocalMutationResolution,
	DashboardStuckLocalMutationResolutionResult,
	DashboardStuckLocalMutationResolutionTarget,
	DashboardTombstoneDiskConflictResolution,
	DashboardTone,
	KaosDashboardData,
	ResolvedAttentionItem,
} from "./dashboardTypes";
import {
	deriveDashboardHealth,
	resolveKaosDashboardMode,
	type KaosDashboardMode,
} from "./dashboardLayout";
import { formatDashboardDeviceName } from "./deviceDisplay";
import {
	renderDiffLines as buildTextDiffLines,
	type RenderedDiffLine,
} from "../utils/textDiff";
import {
	mergeTexts3,
	type ThreeWayMergeConflictHunk,
	type ThreeWayMergeSegment,
} from "../utils/threeWayMerge";
import { ConfirmModal } from "../ui/ConfirmModal";
import {
	captureConflictResolutionSnapshot,
	resolveConflictArtifactWithCas,
	type ConflictResolutionChoice,
	type ConflictResolutionSnapshot,
} from "./conflictResolution";
import { buildSummary } from "./attentionAudit";

export const KAOS_DASHBOARD_VIEW_TYPE = "kaos-dashboard";

export interface KaosDashboardActions {
	reconnect(): void;
	forceReconcile(): Promise<void>;
	importUntracked(): Promise<void>;
	takeSnapshotNow(): Promise<void>;
	showSnapshotList(): Promise<void>;
	createFileHistoryPoint(): Promise<void>;
	resetFileHistoryBaseline(): Promise<void>;
	showRecoveryHistory(target?: DashboardRecoveryHistoryTarget): Promise<void>;
	exportDiagnostics(): void;
	exportDiagnosticsWithFilenames(): void;
	auditAttention(): Promise<AttentionAuditResult>;
	retireVerifiedAttention(
		targets: AttentionRetirementTarget[],
	): Promise<AttentionRetirementSummary>;
	resolveRemoteDeleteAttention(
		target: DashboardRemoteDeleteResolutionTarget,
		choice: DashboardRemoteDeleteResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult>;
	resolveMarkdownConflictAttention(
		target: DashboardMarkdownConflictResolutionTarget,
		choice: DashboardMarkdownConflictResolutionChoice,
	): Promise<DashboardMarkdownConflictResolutionResult>;
	resolveLegacyMissingBlobAttention(
		target: DashboardLegacyMissingBlobResolutionTarget,
		choice: DashboardLegacyMissingBlobResolutionChoice,
	): Promise<DashboardRemoteDeleteResolutionResult>;
	dismissStuckLocalMutationAttention(
		target: DashboardStuckLocalMutationResolutionTarget,
	): Promise<DashboardStuckLocalMutationResolutionResult>;
	resolveBlobConflict(
		target: DashboardBlobConflictResolutionTarget,
		choice: DashboardBlobConflictResolutionChoice,
	): Promise<DashboardBlobConflictResolutionResult>;
	resolveTombstoneConflict(
		path: string,
		choice: "keep-local" | "accept-delete",
		target?: DashboardTombstoneDiskConflictResolution,
	): Promise<void>;
	clearResolvedAttentionHistory?(): Promise<void>;
	dismissAttentionEntry?(path: string): Promise<void>;
	adoptStructuralRename?(oldPath: string, newPath: string): Promise<void>;
	resetLocalCache?(): void;
	nuclearReset?(): void;
	forceReconcileUnhydrated?(): Promise<void>;
	prunePhantomRemotePaths?(): Promise<void>;
	resolveSettledCollisionMarkers?(): Promise<void>;
	clearLocalServerReceiptState?(): Promise<void>;
	runSyncCheck?(): Promise<void>;
	openRecoveryHoldResolution?(): void;
	repairFileHistoryStorage?(): Promise<void>;
	cleanupFileHistory?(): Promise<void>;
	pruneSnapshots?(): Promise<void>;
	copyDebugInfo?(): void;
	restoreAllFilesFromServer?(): Promise<void>;
	openDivergenceResolutionForPath?(path: string): void;
}

export interface KaosDashboardViewDeps {
	collectData(): Promise<KaosDashboardData>;
	getBaselineText?(contentHash: string): Promise<string | null> | string | null;
	getMarkdownConflictReviewSides?(path: string): Promise<DashboardMarkdownConflictReviewSides | null>;
	getConflictMergeBaseHash?(artifactPath: string): string | null;
	clearConflictMergeBase?(artifactPath: string): void;
	actions: KaosDashboardActions;
}

export class KaosDashboardView extends ItemView {
	private data: KaosDashboardData | null = null;
	private loading = false;
	private error: string | null = null;
	private refreshTimer: number | null = null;
	private readonly pendingAttentionEpisodes = new Set<string>();
	private isAuditingAttention = false;
	private isRetiringAttention = false;
	private lastAuditResult: AttentionAuditResult | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: KaosDashboardViewDeps,
	) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return KAOS_DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Dashboard";
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("kaos-dashboard");
		this.addAction("refresh-cw", "Refresh dashboard", () => {
			void this.refresh();
		});
		await this.refresh();
		this.refreshTimer = window.setInterval(() => {
			void this.refresh(true);
		}, 30_000);
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.removeClass("kaos-dashboard");
		this.contentEl.classList.remove("is-phone-dashboard");
		this.contentEl.empty();
	}

	private async refresh(silent = false): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error = null;
		this.render();
		try {
			this.data = await this.deps.collectData();
		} catch (err) {
			this.error = formatUnknown(err);
			if (!silent) new Notice("Dashboard failed to refresh. Check console.", 5000);
			console.warn("[kaos] dashboard refresh failed:", err);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private render(): void {
		const root = this.contentEl;
		const mode = this.getDashboardMode();
		root.empty();
		root.classList.toggle("is-phone-dashboard", mode === "phone");
		this.renderHeader(root);
		if (!this.data && this.loading) {
			root.createDiv({ text: "Loading...", cls: "kaos-dashboard-muted" });
			return;
		}
		if (!this.data && this.error) {
			root.createDiv({ text: this.error, cls: "kaos-dashboard-error" });
			return;
		}
		if (!this.data) return;

		this.renderHealthSummary(root, this.data);
		const hasAttentionContent = this.data.attentionTotalCount > 0
			|| this.data.attention.length > 0
			|| (this.data.attentionAudit && (this.data.attentionAudit.summary.retirableCount > 0 || this.data.attentionAudit.summary.needsReviewCount > 0))
			|| (this.data.resolvedAttentionHistory && this.data.resolvedAttentionHistory.length > 0);
		if (hasAttentionContent) {
			this.renderAttention(root, this.data.attention, this.data.attentionTotalCount);
		}
		if (this.data.conflicts.length > 0) {
			this.renderConflicts(root, this.data.conflicts, this.data.settings.deviceName);
		}
		this.renderRecentActivity(root, this.data, mode === "phone" ? 10 : 40);
		this.renderRecovery(root, this.data);
		if (this.data.blobSafetyCopies.length > 0) {
			this.renderBlobSafetyCopies(root, this.data.blobSafetyCopies);
		}
		this.renderOperations(root, this.data);
		this.renderEmergency(root, this.data);
		this.renderAdvanced(root, this.data.overview);
	}

	private getDashboardMode(): KaosDashboardMode {
		return resolveKaosDashboardMode(Platform);
	}

	private renderHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "kaos-dashboard-header" });
		header.createEl("h2", { text: "Dashboard" });
		const meta = header.createDiv({ cls: "kaos-dashboard-muted" });
		if (this.data) {
			const deviceName = this.data.settings.deviceName;
			meta.setText(`${formatDateTime(this.data.generatedAt)} · ${deviceName}`);
			if (this.loading) meta.appendText(" · refreshing");
		} else if (this.loading) {
			meta.setText("Loading...");
		}
		if (this.error) {
			header.createDiv({ text: this.error, cls: "kaos-dashboard-error" });
		}
	}

	private renderHealthSummary(root: HTMLElement, data: KaosDashboardData): void {
		const health = deriveDashboardHealth(data);
		const status = data.overview.find((metric) => metric.label === "Status");
		const connection = data.overview.find((metric) => metric.label === "Connection");
		const hero = root.createDiv({
			cls: `kaos-dashboard-health ${toneClass(health.tone)}`,
		});
		hero.setAttr("role", "status");
		hero.setAttr("aria-live", "polite");
		const layout = hero.createDiv({ cls: "kaos-dashboard-health-layout" });
		const copy = layout.createDiv({ cls: "kaos-dashboard-health-copy" });
		const label = copy.createDiv({ cls: "kaos-dashboard-health-label" });
		label.createSpan({ cls: "kaos-dashboard-health-dot" });
		label.createSpan({ text: health.label });
		copy.createEl("h3", { text: health.headline });
		copy.createDiv({ text: health.detail, cls: "kaos-dashboard-health-detail" });
		const actions = layout.createDiv({ cls: "kaos-dashboard-health-actions" });
		this.button(
			actions,
			this.loading ? "Refreshing…" : "Refresh",
			() => this.refresh(),
			this.loading,
			this.loading ? "Refresh is already running." : undefined,
			false,
		);

		const facts = hero.createDiv({ cls: "kaos-dashboard-health-facts" });
		this.renderHealthFact(facts, "Status", status?.value ?? "unknown", status?.tone);
		this.renderHealthFact(facts, "Connection", connection?.value ?? "unknown", connection?.tone);
		this.renderHealthFact(
			facts,
			"Attention",
			String(data.attentionTotalCount),
			data.attentionTotalCount > 0 ? "warn" : "ok",
		);
		this.renderHealthFact(
			facts,
			"Conflicts",
			String(data.conflicts.length),
			data.conflicts.length > 0 ? "error" : "ok",
		);
	}

	private renderHealthFact(
		parent: HTMLElement,
		label: string,
		value: string,
		tone?: DashboardTone,
	): void {
		const fact = parent.createDiv({ cls: `kaos-dashboard-health-fact ${toneClass(tone)}` });
		fact.createSpan({ text: label, cls: "kaos-dashboard-health-fact-label" });
		fact.createSpan({ text: value, cls: "kaos-dashboard-health-fact-value" });
	}

	private renderOperations(root: HTMLElement, data: KaosDashboardData): void {
		const body = this.disclosure(
			root,
			"Operations",
			"Sync, recovery, and maintenance actions",
			"kaos-dashboard-operations",
		);
		const syncActions = this.actionGroup(body, "Sync operations");
		this.button(syncActions, "Reconnect", async () => this.deps.actions.reconnect(), !data.actions.syncInitialized);
		this.button(
			syncActions,
			"Force reconcile",
			async () => {
				await this.deps.actions.forceReconcile();
				await this.refresh(true);
			},
			!data.actions.syncInitialized,
		);
		const pathCollisionMetric = data.overview.find(
			(m) => m.label === "Path collisions" && m.tone === "error",
		);
		if (pathCollisionMetric) {
			const resolveBtn = this.button(
				syncActions,
				`Resolve path collisions (${pathCollisionMetric.value})`,
				async () => {
					await this.deps.actions.forceReconcile();
					await this.refresh(true);
				},
				!data.actions.syncInitialized,
				"Resolve active CRDT path collisions for files settled on disk.",
			);
			resolveBtn.classList.add("mod-warning");
		}
		this.button(
			syncActions,
			`Import untracked${data.actions.untrackedFileCount > 0 ? ` (${data.actions.untrackedFileCount})` : ""}`,
			() => this.deps.actions.importUntracked(),
			!data.actions.syncInitialized || data.actions.untrackedFileCount === 0,
		);

		const recoveryActions = this.actionGroup(body, "Recovery operations");
		const recoveryDisabled = !data.actions.syncInitialized
			|| !data.actions.snapshotsAvailable
			|| !data.actions.connected;
		this.button(recoveryActions, "Take vault snapshot", () => this.deps.actions.takeSnapshotNow(), recoveryDisabled);
		this.button(recoveryActions, "Browse vault snapshots", () => this.deps.actions.showSnapshotList(), recoveryDisabled);
		this.button(recoveryActions, "Create file history point", () => this.deps.actions.createFileHistoryPoint(), recoveryDisabled);
		this.button(recoveryActions, "Reset file history baseline", () => this.deps.actions.resetFileHistoryBaseline(), recoveryDisabled);
		this.button(recoveryActions, "Review file history", () => this.deps.actions.showRecoveryHistory(), recoveryDisabled);
	}

	private renderEmergency(root: HTMLElement, data: KaosDashboardData): void {
		const body = this.disclosure(
			root,
			"Emergency actions (긴급 조치)",
			"Destructive resets, state cleaning, and storage repair",
			"kaos-dashboard-emergency",
		);

		const storageDisabled = !data.actions.syncInitialized
			|| !data.actions.snapshotsAvailable
			|| !data.actions.connected;

		// 1. Sync resets & cache recovery
		const resetsGroup = body.createDiv({ cls: "kaos-dashboard-action-group" });
		resetsGroup.createEl("h4", { text: "동기화 리셋 및 캐시 복구 (sync resets & cache)" });
		const resetsList = resetsGroup.createDiv({ cls: "kaos-dashboard-emergency-list" });

		this.renderEmergencyItem(
			resetsList,
			"로컬 캐시 초기화 (Reset local cache)",
			"IndexedDB 로컬 캐시를 삭제하고 서버에서 다시 동기화합니다. 로컬 디스크 파일과 원격 서버 데이터는 안전하게 보존됩니다. (캐시가 손상되었거나 로컬-서버 상태가 꼬였을 때 1차 해결책)",
			"Reset local cache",
			() => this.deps.actions.resetLocalCache?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			resetsList,
			"캐시 미로딩 강제 동기화 (Force unhydrated reconcile)",
			"로컬 캐시 로딩 완료 게이트를 건너뛰고 서버 상태 기준으로 강제 권한 동기화를 수행합니다. (캐시 로딩이 멈췄거나 오류로 인해 정상 동기화 진행이 막혔을 때 비상 탈출구)",
			"Force unhydrated reconcile",
			() => this.deps.actions.forceReconcileUnhydrated?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			resetsList,
			"전체 파일 서버 복원 (Restore all files from server)",
			"서버와 내용이 다른 로컬 파일 및 누락된 파일을 서버의 최신 상태로 일괄 복원합니다. (기존 로컬 파일은 restore-backups에 자동 백업되며, 서버에 없는 로컬 전용 파일은 유지됨)",
			"Restore all from server",
			() => this.deps.actions.restoreAllFilesFromServer?.(),
			{ isWarning: true, disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			resetsList,
			"Nuclear reset (완전 초기화 & 디스크 재시딩)",
			"서버와 로컬의 모든 CRDT 상태를 완전히 지우고, 현재 디스크의 실제 파일들을 기준으로 동기화 룸을 완전히 재시딩합니다. (동기화가 완전히 파탄나서 어떤 복구로도 해결되지 않을 때 최후의 수단)",
			"Nuclear reset",
			() => this.deps.actions.nuclearReset?.(),
			{ isWarning: true, disabled: !data.actions.syncInitialized },
		);

		// 2. Ghost paths & marker cleanup
		const cleanupGroup = body.createDiv({ cls: "kaos-dashboard-action-group" });
		cleanupGroup.createEl("h4", { text: "유령 경로 및 마커 정리 (ghost paths & markers)" });
		const cleanupList = cleanupGroup.createDiv({ cls: "kaos-dashboard-emergency-list" });

		this.renderEmergencyItem(
			cleanupList,
			"원격 유령 경로 정리 (Prune phantom paths)",
			"로컬 디스크에는 없는데 서버 CRDT에 남아있는 유령 경로 마커를 청소합니다. (삭제/이동된 파일이 서버에 남아 계속해서 경로 충돌이나 유령 충돌 복사본을 유발할 때)",
			"Prune phantom paths",
			() => this.deps.actions.prunePhantomRemotePaths?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			cleanupList,
			"정리 완료된 마커 일괄 해제 (Resolve settled markers)",
			"이미 이동이 끝났거나 아카이브(OLD/)된 파일의 오래된 충돌/주의 마커를 일괄 정리합니다. (Attention 탭이 이미 처리 끝난 파일들의 과거 충돌 찌꺼기로 가득 찼을 때)",
			"Resolve settled markers",
			() => this.deps.actions.resolveSettledCollisionMarkers?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			cleanupList,
			"서버 수신 영수증 초기화 (Clear server receipts)",
			"서버와 주고받은 동기화 확인 영수증(ACK echo) 상태를 초기화합니다. (영수증 불일치 경고가 뜨거나 수신 확인 실패로 인해 파일 수정 전송 대기열이 멈춰있을 때)",
			"Clear server receipts",
			() => this.deps.actions.clearLocalServerReceiptState?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		// 3. Troubleshooting & lock resolution
		const diagGroup = body.createDiv({ cls: "kaos-dashboard-action-group" });
		diagGroup.createEl("h4", { text: "동기화 정지 진단 및 락 해제 (troubleshooting & locks)" });
		const diagList = diagGroup.createDiv({ cls: "kaos-dashboard-emergency-list" });

		this.renderEmergencyItem(
			diagList,
			"동기화 정지 종합 진단 (Run sync check)",
			"서버와 로컬 상태를 점검하여 4대 침묵 정지 원인(잘못된 룸, 스키마 버전 불일치, 프로젝션 게이트 닫힘, 세이프티 브레이크)을 진단하고 리포트를 알림으로 띄웁니다. (에러 메시지는 없는데 동기화가 조용히 멈췄을 때)",
			"Run sync check",
			() => this.deps.actions.runSyncCheck?.(),
			{ disabled: !data.actions.syncInitialized },
		);

		this.renderEmergencyItem(
			diagList,
			"일시정지된 복구 상태 해결 (Resolve paused recovery)",
			"안전 잠금(Safety Hold)으로 인해 자동 복구가 일시 중지된 파일 목록을 열어 직접 수락/거절할 수 있는 모달 창을 엽니다. (안전상의 이유로 복구가 홀드되어 있다는 알림이 떴을 때)",
			"Resolve paused recovery",
			() => this.deps.actions.openRecoveryHoldResolution?.(),
			{ disabled: !data.actions.syncInitialized, refreshAfterAction: false },
		);

		this.renderEmergencyItem(
			diagList,
			"동기화 디버그 정보 복사 (Copy debug info)",
			"현재 동기화 상태, 에러, 메트릭이 포함된 진단 정보를 클립보드에 즉시 복사합니다. (문제 분석 및 공유용)",
			"Copy debug info",
			() => this.deps.actions.copyDebugInfo?.(),
			{ refreshAfterAction: false },
		);

		// 4. Storage maintenance
		const storageGroup = body.createDiv({ cls: "kaos-dashboard-action-group" });
		storageGroup.createEl("h4", { text: "R2 스토리지 점검 및 정리 (storage maintenance)" });
		const storageList = storageGroup.createDiv({ cls: "kaos-dashboard-emergency-list" });

		this.renderEmergencyItem(
			storageList,
			"스토리지 점검 및 수리 (Check & repair storage)",
			"R2 클라우드 스토리지의 파일 히스토리 매니페스트와 데이터 청크 상태를 점검하고 손상된 참조를 자동 수리합니다. (R2 스냅샷 상태가 Degraded/Error로 뜨거나 백업이 누락될 때)",
			"Check & repair storage",
			() => this.deps.actions.repairFileHistoryStorage?.(),
			{ disabled: storageDisabled },
		);

		this.renderEmergencyItem(
			storageList,
			"파일 이력 청크 정리 (Cleanup file history)",
			"R2 스토리지의 불필요한 고아(orphan) 파일 히스토리 청크를 삭제하여 저장소 공간을 절약합니다.",
			"Cleanup file history",
			() => this.deps.actions.cleanupFileHistory?.(),
			{ disabled: storageDisabled },
		);

		this.renderEmergencyItem(
			storageList,
			"오래된 스냅샷 정리 (Prune snapshots)",
			"보존 기간이 지난 오래된 볼트 스냅샷을 정리하여 용량을 확보합니다.",
			"Prune snapshots",
			() => this.deps.actions.pruneSnapshots?.(),
			{ disabled: storageDisabled },
		);
	}

	private renderEmergencyItem(
		parent: HTMLElement,
		title: string,
		description: string,
		buttonLabel: string,
		action: () => void | Promise<void>,
		options?: {
			isWarning?: boolean;
			disabled?: boolean;
			disabledReason?: string;
			refreshAfterAction?: boolean;
		},
	): void {
		const item = parent.createDiv({ cls: "kaos-dashboard-emergency-item" });
		const info = item.createDiv({ cls: "kaos-dashboard-emergency-item-info" });
		info.createDiv({ cls: "kaos-dashboard-emergency-item-title", text: title });
		info.createDiv({ cls: "kaos-dashboard-emergency-item-desc", text: description });
		const actionContainer = item.createDiv({ cls: "kaos-dashboard-emergency-item-action" });
		const btn = this.button(
			actionContainer,
			buttonLabel,
			action,
			options?.disabled ?? false,
			options?.disabledReason,
			options?.refreshAfterAction ?? true,
		);
		if (options?.isWarning) {
			btn.classList.add("mod-warning");
		}
	}

	private renderAdvanced(root: HTMLElement, metrics: DashboardMetric[]): void {
		const body = this.disclosure(
			root,
			"Advanced diagnostics",
			`${metrics.length} detailed sync metrics`,
			"kaos-dashboard-advanced",
		);
		this.renderMetricGrid(body, metrics);
		const exports = this.actionGroup(body, "Diagnostic exports");
		this.button(exports, "Export diagnostics", async () => this.deps.actions.exportDiagnostics());
		this.button(exports, "Export with filenames", async () => this.deps.actions.exportDiagnosticsWithFilenames());
	}

	private disclosure(
		root: HTMLElement,
		title: string,
		detail: string,
		extraClass: string,
	): HTMLElement {
		const details = root.createEl("details", {
			cls: `kaos-dashboard-disclosure ${extraClass}`,
		});
		const summary = details.createEl("summary", { cls: "kaos-dashboard-disclosure-summary" });
		const copy = summary.createSpan({ cls: "kaos-dashboard-disclosure-copy" });
		copy.createSpan({ text: title, cls: "kaos-dashboard-disclosure-title" });
		copy.createSpan({ text: detail, cls: "kaos-dashboard-disclosure-detail" });
		return details.createDiv({ cls: "kaos-dashboard-disclosure-body" });
	}

	private actionGroup(root: HTMLElement, title: string): HTMLElement {
		const group = root.createDiv({ cls: "kaos-dashboard-action-group" });
		group.createEl("h4", { text: title });
		return group.createDiv({ cls: "kaos-dashboard-row-actions" });
	}

	private renderMetricGrid(root: HTMLElement, metrics: DashboardMetric[], extraClass = ""): void {
		const grid = root.createDiv({
			cls: ["kaos-dashboard-metric-grid", extraClass].filter(Boolean).join(" "),
		});
		for (const metric of metrics) {
			const card = grid.createDiv({ cls: `kaos-dashboard-metric ${toneClass(metric.tone)}` });
			card.createDiv({ text: metric.label, cls: "kaos-dashboard-metric-label" });
			card.createDiv({ text: metric.value, cls: "kaos-dashboard-metric-value" });
		}
	}

	private renderRecentActivity(root: HTMLElement, data: KaosDashboardData, changeLimit: number): void {
		const section = this.section(root, "Recent activity", "kaos-dashboard-activity-section");
		if (data.recentChanges.status !== "ready") {
			section.createDiv({ text: data.recentChanges.message, cls: `kaos-dashboard-${data.recentChanges.status === "error" ? "error" : "muted"}` });
			return;
		}
		if (data.recentChanges.changes.length === 0) {
			section.createDiv({ text: "No recent file changes.", cls: "kaos-dashboard-muted" });
			return;
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const change of data.recentChanges.changes.slice(0, changeLimit)) {
			this.renderRecentChange(list, change, data.settings.deviceName);
		}
	}

	private renderRecovery(root: HTMLElement, data: KaosDashboardData): void {
		const section = this.section(root, "Recovery", "kaos-dashboard-recovery-section");
		section.createDiv({
			text: "File history and vault snapshots provide separate recovery points.",
			cls: "kaos-dashboard-muted kaos-dashboard-section-copy",
		});
		const grid = section.createDiv({ cls: "kaos-dashboard-recovery-grid" });
		const snapshotRow = grid.createDiv({ cls: "kaos-dashboard-recovery-card" });
		snapshotRow.createDiv({ text: "Vault snapshots", cls: "kaos-dashboard-recovery-label" });
		if (data.snapshotStatus.status === "ready") {
			const summary = data.snapshotStatus.summary;
			snapshotRow.createDiv({
				text: `${summary.snapshotCountLowerBound} vault snapshot(s), ${formatBytes(summary.estimatedStorageBytesLowerBound)} stored`,
				cls: "kaos-dashboard-strong kaos-dashboard-recovery-value",
			});
			snapshotRow.createDiv({
				text: summary.latestCreatedAt ? `latest ${formatDateTime(summary.latestCreatedAt)}` : "no vault snapshot timestamp",
				cls: "kaos-dashboard-muted",
			});
		} else {
			snapshotRow.createDiv({ text: data.snapshotStatus.message, cls: `kaos-dashboard-${data.snapshotStatus.status === "error" ? "error" : "muted"}` });
		}

		const historyRow = grid.createDiv({ cls: "kaos-dashboard-recovery-card" });
		historyRow.createDiv({ text: "File history", cls: "kaos-dashboard-recovery-label" });
		this.renderFileHistoryState(historyRow, data.recentChanges);

		const storage = recoveryStorageDisplay(data.recoveryStorageStatus);
		const storageRow = grid.createDiv({ cls: `kaos-dashboard-recovery-card ${toneClass(storage.tone)}` });
		storageRow.createDiv({ text: "Recovery storage", cls: "kaos-dashboard-recovery-label" });
		storageRow.createDiv({
			text: storage.label,
			cls: "kaos-dashboard-strong kaos-dashboard-recovery-value",
		});
		if (storage.detail) {
			storageRow.createDiv({
				text: storage.detail,
				cls: storage.tone === "error" ? "kaos-dashboard-error" : "kaos-dashboard-muted",
			});
		}
	}

	private renderFileHistoryState(section: HTMLElement, recentChanges: DashboardRecentChanges): void {
		const row = section.createDiv({ cls: "kaos-dashboard-snapshot-summary" });
		if (recentChanges.status === "ready") {
			row.createDiv({
				text: recentChanges.latestCreatedAt
					? `Latest file history point: ${formatDateTime(recentChanges.latestCreatedAt)}`
					: "Latest file history point: none",
				cls: "kaos-dashboard-strong",
			});
		}
		if (recentChanges.lastAttempt) {
			row.createDiv({
				text: formatFileHistoryAttempt(recentChanges.lastAttempt),
				cls: `kaos-dashboard-muted ${toneClass(fileHistoryAttemptTone(recentChanges.lastAttempt))}`,
			});
		}
		if (recentChanges.status !== "ready" && !recentChanges.lastAttempt) {
			row.createDiv({
				text: "Latest file history point: unavailable",
				cls: "kaos-dashboard-muted",
			});
		}
	}

	private renderRecentChange(parent: HTMLElement, change: DashboardRecentChange, currentDeviceName: string): void {
		const row = parent.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-recent-row" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.setAttr("aria-label", `Review file history for ${change.path}`);
		row.addEventListener("click", () => {
			void this.openRecentChangeHistory(change);
		});
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			void this.openRecentChangeHistory(change);
		});
		const mainLine = row.createDiv({
			cls: `kaos-dashboard-recent-main ${changeKindClass(change.changeKind)}`,
		});
		mainLine.createEl("span", {
			text: displayChangeKind(change.changeKind),
			cls: "kaos-dashboard-event-badge",
		});
		mainLine.createEl("span", {
			text: change.oldPath && change.newPath
				? `${change.oldPath} → ${change.newPath}`
				: change.path,
			cls: "kaos-dashboard-path kaos-dashboard-recent-path",
		});
		const actions = mainLine.createDiv({ cls: "kaos-dashboard-recent-actions" });
		actions.addEventListener("click", (event) => event.stopPropagation());
		this.button(actions, "Open", () => this.openPath(change.path));
		const metadata = [
			formatDateTime(change.createdAt),
			change.size !== null ? formatBytes(change.size) : "",
			change.device ? formatDashboardDeviceName(change.device, currentDeviceName) : "",
		].filter(Boolean).join(" · ");
		row.createDiv({ text: metadata, cls: "kaos-dashboard-muted kaos-dashboard-recent-meta" });
	}

	private async openRecentChangeHistory(change: DashboardRecentChange): Promise<void> {
		await this.deps.actions.showRecoveryHistory({
			initialManifestId: change.manifestId,
			initialFileId: change.fileId,
			autoExpandDiff: Boolean(change.contentHash || change.previousContentHash),
		});
	}

	private renderConflicts(root: HTMLElement, conflicts: DashboardConflictArtifact[], currentDeviceName: string): void {
		const section = this.section(root, `Conflicts (${conflicts.length})`, "kaos-dashboard-callout is-error");
		if (conflicts.length === 0) {
			section.createDiv({ text: "No conflict artifacts found.", cls: "kaos-dashboard-muted" });
			return;
		}
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const artifact of conflicts) {
			const row = list.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-conflict-row" });
			row.createDiv({ text: artifact.inferredOriginalPath, cls: "kaos-dashboard-path" });
			const details = [
				artifact.kind,
				artifact.source ?? "unknown side",
				formatDateTime(artifact.timestamp),
				artifact.originalExists ? "original exists" : "original missing",
				artifact.originalPathConfidence === "possibly-truncated" ? "path may be truncated" : "",
				artifact.artifactIndexed ? "indexed" : "local-only",
			].filter(Boolean).join(" · ");
			row.createDiv({ text: details, cls: "kaos-dashboard-muted" });
			if (artifact.deviceName) {
				row.createDiv({
					text: formatDashboardDeviceName(artifact.deviceName, currentDeviceName),
					cls: "kaos-dashboard-device-line",
				});
			}
			row.createDiv({ text: artifact.artifactPath, cls: "kaos-dashboard-subpath" });
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			if (artifact.kind === "markdown") {
				this.button(
					actions,
					"Use artifact",
					() => this.confirmDashboardConflictResolution(artifact, { kind: "artifact" }),
					!artifact.originalExists,
				);
				this.button(
					actions,
					"Use original",
					() => this.confirmDashboardConflictResolution(artifact, { kind: "original" }),
					!artifact.originalExists,
				);
			} else {
				const resolution = artifact.blobResolution;
				const target = resolution ? {
					...resolution,
					path: artifact.inferredOriginalPath,
					artifactPath: artifact.artifactPath,
				} satisfies DashboardBlobConflictResolutionTarget : null;
				const unavailableReason = resolution === null
					? "No exact active conflict episode is available for this copy."
					: null;
				this.button(
					actions,
					"Keep local original",
					() => {
						if (!target) throw new Error("The active attachment conflict is unavailable.");
						return this.confirmBlobConflictResolution(target, "keep-local");
					},
					target === null || !resolution?.canKeepLocal,
					resolution?.keepLocalUnavailableReason ?? unavailableReason ?? undefined,
				);
				this.button(
					actions,
					"Use remote copy",
					() => {
						if (!target) throw new Error("The active attachment conflict is unavailable.");
						return this.confirmBlobConflictResolution(target, "use-remote-copy");
					},
					target === null || !resolution?.canUseRemoteCopy,
					resolution?.useRemoteCopyUnavailableReason ?? unavailableReason ?? undefined,
				);
				const keepLocalReason = resolution?.canKeepLocal === false
					? resolution.keepLocalUnavailableReason
					: null;
				const useRemoteReason = resolution?.canUseRemoteCopy === false
					? resolution.useRemoteCopyUnavailableReason
					: null;
				if (unavailableReason) {
					row.createDiv({
						text: unavailableReason,
						cls: "kaos-dashboard-muted",
					});
				} else if (keepLocalReason && keepLocalReason === useRemoteReason) {
					row.createDiv({
						text: `Resolution unavailable: ${keepLocalReason}`,
						cls: "kaos-dashboard-muted",
					});
				} else {
					if (keepLocalReason) {
						row.createDiv({
							text: `Keep local unavailable: ${keepLocalReason}`,
							cls: "kaos-dashboard-muted",
						});
					}
					if (useRemoteReason) {
						row.createDiv({
							text: `Use remote copy unavailable: ${useRemoteReason}`,
							cls: "kaos-dashboard-muted",
						});
					}
				}
			}
			this.button(actions, "View diff", () => this.openConflictDiff(artifact), artifact.kind !== "markdown" || !artifact.originalExists);
			this.button(actions, "Open artifact", () => this.openPath(artifact.artifactPath));
			this.button(actions, "Open original", () => this.openPath(artifact.inferredOriginalPath), !artifact.originalExists);
		}
	}

	private renderBlobSafetyCopies(
		root: HTMLElement,
		copies: DashboardConflictArtifact[],
	): void {
		const section = this.section(root, `Attachment safety copies (${copies.length})`, "kaos-dashboard-callout is-muted");
		section.createDiv({
			text: "These local-only rollback copies come from safe attachment replacement or remote deletion. They are not sync conflicts; review them before deleting them manually.",
			cls: "kaos-dashboard-muted",
		});
		const list = section.createDiv({ cls: "kaos-dashboard-list" });
		for (const copy of copies) {
			const originalPathCertain = copy.originalPathConfidence !== "possibly-truncated";
			const row = list.createDiv({ cls: "kaos-dashboard-row kaos-dashboard-conflict-row" });
			row.createDiv({ text: copy.artifactPath, cls: "kaos-dashboard-path" });
			row.createDiv({
				text: [
					"local rollback copy",
					formatDateTime(copy.timestamp),
					originalPathCertain
						? copy.originalExists ? "current attachment exists" : "current attachment missing"
						: "current path may be truncated",
					"local-only",
				].join(" · "),
				cls: "kaos-dashboard-muted",
			});
			row.createDiv({
				text: `${originalPathCertain ? "Current path" : "Possible current path"}: ${copy.inferredOriginalPath}`,
				cls: "kaos-dashboard-subpath",
			});
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			this.button(actions, "Open copy", () => this.openPath(copy.artifactPath));
			this.button(
				actions,
				"Open current",
				() => this.openPath(copy.inferredOriginalPath),
				!originalPathCertain || !copy.originalExists,
				!originalPathCertain
					? "The original basename was truncated; locate the current attachment manually."
					: undefined,
			);
			this.button(actions, "Copy path", () => this.copyPath(copy.artifactPath));
			const deleteBtn = this.button(
				actions,
				"Delete backup",
				() => this.confirmDeleteSafetyCopy(copy),
				false,
				"Move this safety backup file to Obsidian trash after confirming the current file is normal.",
			);
			deleteBtn.classList.add("mod-warning");
		}
	}

	private renderAttention(
		root: HTMLElement,
		items: DashboardAttentionItem[],
		totalCount: number,
	): void {
		const audit = this.lastAuditResult ?? this.data?.attentionAudit;
		const retirableCount = audit?.summary.retirableCount ?? 0;
		const attentionTone = items.some((item) => item.tone === "error") ? "error" : "warn";
		const displayCount = totalCount > 0
			? totalCount
			: retirableCount > 0
				? `${retirableCount} retirable`
				: 0;
		const section = this.section(root, `Attention (${displayCount})`, `kaos-dashboard-callout is-${attentionTone}`);

		const toolbar = section.createDiv({ cls: "kaos-dashboard-row-actions kaos-dashboard-attention-toolbar" });
		this.button(
			toolbar,
			this.isAuditingAttention ? "Auditing Attention…" : "Audit Attention",
			() => this.runAttentionAudit(),
			this.isAuditingAttention || this.isRetiringAttention,
		);

		const auditItemByPath = new Map<string, AttentionAuditItem>();
		if (audit) {
			for (const auditItem of audit.items) {
				auditItemByPath.set(normalizePath(auditItem.entry.path), auditItem);
			}
		}

		if (audit) {
			const auditSummaryBox = section.createDiv({
				cls: "kaos-dashboard-callout is-muted kaos-dashboard-audit-summary",
			});
			const stats = [
				`즉시 조치 필요: ${audit.summary.activeCount}`,
				`검증 후 퇴역 가능: ${audit.summary.retirableCount}`,
				`추가 확인 필요: ${audit.summary.needsReviewCount}`,
			];
			auditSummaryBox.createDiv({ text: stats.join(" · "), cls: "kaos-dashboard-muted" });

			if (audit.summary.retirableCount > 0) {
				const retirableActions = auditSummaryBox.createDiv({ cls: "kaos-dashboard-row-actions" });
				this.button(
					retirableActions,
					this.isRetiringAttention
						? "Retiring verified markers…"
						: `Retire Verified Attention (${audit.summary.retirableCount})`,
					() => this.confirmRetireVerifiedAttention(audit),
					this.isAuditingAttention || this.isRetiringAttention,
				);
			}
		}

		if (items.length === 0 && retirableCount === 0) {
			section.createDiv({ text: "No active files currently need attention.", cls: "kaos-dashboard-muted" });
		} else if (items.length > 0) {
			if (items.length < totalCount) {
				section.createDiv({
					text: `Showing ${items.length} representative row(s) for ${totalCount} attention item(s).`,
					cls: "kaos-dashboard-muted",
				});
			}
			section.createDiv({
				text: "Remote deletions can be resolved here. Other attention types show the safest available next step.",
				cls: "kaos-dashboard-muted kaos-dashboard-attention-help",
			});
			const list = section.createDiv({ cls: "kaos-dashboard-list" });
			for (const item of items) {
				const row = list.createDiv({ cls: `kaos-dashboard-row ${toneClass(item.tone)}` });
			row.createDiv({ text: item.path ?? item.title, cls: "kaos-dashboard-path" });
			const path = item.path;
			const normalizedPath = path ? normalizePath(path) : null;
			const auditItem = normalizedPath ? auditItemByPath.get(normalizedPath) : null;

			if (item.structuralChange) {
				this.renderStructuralChangeDetail(row, item.structuralChange);
			} else {
				let detailText = `${item.title} · ${item.detail}`;
				if (auditItem && auditItem.classification === "retirable") {
					detailText = `[retirable] ${auditItem.rationale}`;
				}
				row.createDiv({ text: detailText, cls: "kaos-dashboard-muted" });
			}
			if (item.lastSeenAt) {
				row.createDiv({ text: `last ${formatDateTime(item.lastSeenAt)}`, cls: "kaos-dashboard-muted" });
			}
			if (path) {
				const actions = row.createDiv({ cls: "kaos-dashboard-row-actions kaos-dashboard-attention-actions" });
				this.button(actions, "Open file", () => this.openPath(path));
				this.button(actions, "Copy path", () => this.copyPath(path));

				if (auditItem && auditItem.classification === "retirable") {
					this.button(
						actions,
						this.isRetiringAttention ? "Retiring…" : "Retire marker",
						() => this.confirmRetireSingleAttention(auditItem),
						this.isAuditingAttention || this.isRetiringAttention,
						auditItem.rationale,
					);
				}

				const resolution = item.resolution;
				if (resolution?.kind === "remote-delete") {
					const actionPending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					const pending = actionPending || resolution.keepLocalPending;
					this.button(
						actions,
						resolution.keepLocalPending
							? "Publishing local file…"
							: actionPending ? "Resolving…" : "Keep local file",
						() => this.confirmRemoteDeleteResolution(
							path,
							resolution,
							"keep-local",
						),
						pending || !resolution.canKeepLocal,
						resolution.keepLocalUnavailableReason ?? undefined,
					);
					const acceptDeleteButton = this.button(
						actions,
						"Accept remote delete",
						() => this.confirmRemoteDeleteResolution(
							path,
							resolution,
							"accept-remote-delete",
						),
						pending || !resolution.canAcceptRemoteDelete,
						resolution.acceptRemoteDeleteUnavailableReason ?? undefined,
					);
					acceptDeleteButton.classList.add("mod-warning");
				} else if (resolution?.kind === "legacy-missing-blob") {
					const pending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					this.button(
						actions,
						pending ? "Resolving…" : "Download remote file",
						() => this.confirmLegacyMissingBlobResolution(
							path,
							resolution,
							"download-remote",
						),
						pending || !resolution.canDownloadRemote,
						resolution.unavailableReason
							?? (resolution.remoteRef === null
								? "The remote attachment no longer exists."
								: undefined),
					);
					const keepAbsentButton = this.button(
						actions,
						"Keep local absence",
						() => this.confirmLegacyMissingBlobResolution(
							path,
							resolution,
							"keep-local-absent",
						),
						pending || !resolution.canKeepLocalAbsent,
						resolution.unavailableReason ?? undefined,
					);
					keepAbsentButton.classList.add("mod-warning");
				} else if (resolution?.kind === "stuck-local-mutation") {
					const pending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					const dismissButton = this.button(
						actions,
						pending ? "Dismissing…" : "Dismiss (trace-only)",
						() => this.confirmStuckLocalMutationDismiss(path, resolution),
						pending || !resolution.canDismiss,
						resolution.unavailableReason ?? undefined,
					);
					dismissButton.classList.add("mod-warning");
				} else if (resolution?.kind === "markdown-conflict") {
					const pending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					this.button(actions, "Review diff & merge", () => this.openMarkdownConflictReview(path, resolution),
						pending || !this.deps.getMarkdownConflictReviewSides,
						"Review local and remote content and apply a merged result.");
					this.button(
						actions,
						pending ? "Resolving…" : "Keep local version",
						() => this.confirmMarkdownConflictResolution(
							path,
							resolution,
							"keep-local",
						),
						pending || !resolution.canKeepLocal,
						resolution.keepLocalUnavailableReason ?? undefined,
					);
					const useRemoteButton = this.button(
						actions,
						pending ? "Resolving…" : "Use remote copy",
						() => this.confirmMarkdownConflictResolution(
							path,
							resolution,
							"use-remote",
						),
						pending || !resolution.canUseRemote,
						resolution.useRemoteUnavailableReason ?? undefined,
					);
					useRemoteButton.classList.add("mod-warning");
				} else if (resolution?.kind === "tombstone-disk-conflict") {
					const pending = this.pendingAttentionEpisodes.has(
						attentionEpisodeKey(path, resolution),
					);
					this.button(
						actions,
						pending ? "Resolving…" : "Keep local version",
						() => this.confirmTombstoneConflictResolution(
							path,
							resolution,
							"keep-local",
						),
						pending || !resolution.canKeepLocal,
						resolution.keepLocalUnavailableReason ?? undefined,
					);
					const acceptDeleteButton = this.button(
						actions,
						pending ? "Resolving…" : "Accept delete",
						() => this.confirmTombstoneConflictResolution(
							path,
							resolution,
							"accept-delete",
						),
						pending || !resolution.canAcceptDelete,
						resolution.acceptDeleteUnavailableReason ?? undefined,
					);
					acceptDeleteButton.classList.add("mod-warning");
				} else {
					if (!auditItem || auditItem.classification !== "retirable") {
						this.button(
							actions,
							"Manual review required",
							async () => undefined,
							true,
							auditItem ? auditItem.rationale : this.getManualAttentionReason(item),
						);
					}
					if (path) {
						if (item.kind === "blocked-divergence" && this.deps.actions.openDivergenceResolutionForPath) {
							const diffBtn = this.button(
								actions,
								"Review diff & resolve",
								() => this.deps.actions.openDivergenceResolutionForPath!(path),
								false,
								"Open side-by-side diff to compare local and server versions and resolve divergence.",
								false,
							);
							diffBtn.classList.add("mod-cta");
						}
						const ackBtn = this.button(
							actions,
							"Acknowledge & clear",
							() => this.confirmAcknowledgeAttention(item),
							false,
							"Clear this attention marker after confirming the file state is normal.",
						);
						ackBtn.classList.add("mod-cta");
					}
				}
			} else {
				const actions = row.createDiv({ cls: "kaos-dashboard-row-actions kaos-dashboard-attention-actions" });
				this.button(
					actions,
					"Run reconcile again",
					async () => this.deps.actions.forceReconcile(),
				);
				if (item.structuralChange) {
					const oldPath = item.structuralChange.oldPaths[0];
					const newPath = item.structuralChange.newPaths[0];
					const isSinglePair =
						item.structuralChange.oldPaths.length === 1
						&& item.structuralChange.newPaths.length === 1
						&& typeof oldPath === "string"
						&& typeof newPath === "string";
					if (isSinglePair) {
						const adoptBtn = this.button(
							actions,
							"Adopt rename",
							() => this.confirmAdoptStructuralRename(oldPath, newPath),
							false,
							`Adopt rename: "${oldPath}" → "${newPath}". Links file identity in sync and clears conflict markers.`,
						);
						adoptBtn.classList.add("mod-cta");
					} else {
						this.button(
							actions,
							"No direct file action",
							async () => undefined,
							true,
							"This structural change involves multiple paths or count mismatch. Resolve manually or via reconcile.",
						);
					}
				} else {
					this.button(
						actions,
						"No direct file action",
						async () => undefined,
						true,
						"This attention item describes a structural or vault-wide condition, not one file.",
					);
				}
			}
		}
		}

		if (this.data?.resolvedAttentionHistory && this.data.resolvedAttentionHistory.length > 0) {
			this.renderResolvedAttentionHistory(section, this.data.resolvedAttentionHistory);
		}
	}

	private renderStructuralChangeDetail(
		row: HTMLElement,
		change: NonNullable<DashboardAttentionItem["structuralChange"]>,
	): void {
		const fields = row.createDiv({ cls: "kaos-dashboard-structural-fields" });
		this.renderStructuralChangeField(fields, "Old", change.oldPaths.join(", ") || "(none)");
		this.renderStructuralChangeField(fields, "New", change.newPaths.join(", ") || "(none)");
		this.renderStructuralChangeField(fields, "Hash", change.contentHashPrefix);
	}

	private renderStructuralChangeField(parent: HTMLElement, label: string, value: string): void {
		const field = parent.createDiv({ cls: "kaos-dashboard-structural-field" });
		field.createSpan({ text: `${label}:`, cls: "kaos-dashboard-structural-label" });
		field.createSpan({ text: value, cls: "kaos-dashboard-muted" });
	}

	private getManualAttentionReason(item: DashboardAttentionItem): string {
		switch (item.kind) {
			case "frontmatter-quarantine":
				return "KAOS blocked unsafe frontmatter. Inspect and correct the file before reconciling again.";
			case "preserved-unresolved":
				return "This is not an authoritative remote deletion, so deleting or overwriting the file automatically would be unsafe.";
			case "structural-change":
			case "blocked-divergence":
				return "This condition must be reviewed and reconciled before KAOS can choose a safe file operation.";
			case "remote-projection-policy":
				return "Correct the shared exclude policy; local and editor changes remain active while remote projection is paused.";
			case "room-divergence":
				return "Run the sync check to identify whether this device is paired to the wrong room or frozen by a closed projection gate.";
			case "tombstone-disk-conflict":
				return "Note exists at a deleted path and is not syncing. Choose Keep local version or Accept delete.";
			default:
				return "This condition must be reviewed before resolving.";
		}
	}

	private confirmRemoteDeleteResolution(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
		choice: DashboardRemoteDeleteResolutionChoice,
	): Promise<void> {
		const keepingLocal = choice === "keep-local";
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepingLocal ? "Keep local file?" : "Accept remote delete?",
				keepingLocal
					? `Revive "${path}" and publish this local ${resolution.fileKind} to synced devices? The remote deletion will be ignored.`
					: `Delete the local copy of "${path}" using Obsidian's configured delete behavior? The remote deletion will be kept.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveRemoteDeleteAttention(
							{ path, ...resolution },
							choice,
						);
						if (result.status === "pending") {
							this.markAttentionEpisodePending(path, resolution);
							new Notice(result.message, 7000);
						} else {
							new Notice(
								keepingLocal
									? `Local file kept: ${path}`
									: `Remote deletion accepted: ${path}`,
							);
							this.removeResolvedAttentionEpisode(path, resolution);
						}
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				keepingLocal ? "Keep local file" : "Accept remote delete",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				keepingLocal ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private confirmLegacyMissingBlobResolution(
		path: string,
		resolution: DashboardLegacyMissingBlobResolution,
		choice: DashboardLegacyMissingBlobResolutionChoice,
	): Promise<void> {
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		const downloading = choice === "download-remote";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				downloading ? "Download remote attachment?" : "Keep the local deletion?",
				downloading
					? `Restore "${path}" from the exact remote version currently shown?`
					: `Keep "${path}" absent and delete only the exact remote version currently shown? Other devices will observe the deletion.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveLegacyMissingBlobAttention(
							{ path, ...resolution },
							choice,
						);
						new Notice(result.status === "pending"
							? result.message
							: downloading
								? `Remote attachment queued: ${path}`
								: `Local absence kept: ${path}`,
							7_000,
						);
						this.removeResolvedLegacyMissingEpisode(path, resolution);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				downloading ? "Download remote" : "Keep local absence",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				downloading ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private removeResolvedLegacyMissingEpisode(
		path: string,
		resolution: DashboardLegacyMissingBlobResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "legacy-missing-blob") {
				return true;
			}
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private confirmStuckLocalMutationDismiss(
		path: string,
		resolution: DashboardStuckLocalMutationResolution,
	): Promise<void> {
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				"Dismiss this conflict episode?",
				`Retire the stuck local-mutation conflict for "${path}"? The quarantined journal intent is removed and the dismissal is recorded as a trace. If the remote still holds a live version of this path, the standard download-or-keep-absence choice appears instead of deleting anything.`,
				async () => {
					try {
						const result = await this.deps.actions.dismissStuckLocalMutationAttention(
							{ path, ...resolution },
						);
						new Notice(result.status === "pending"
							? result.message
							: `Conflict episode dismissed: ${path}`, 7_000);
						if (result.status === "completed") {
							this.removeResolvedStuckLocalMutationEpisode(path, resolution);
						}
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				"Dismiss (trace-only)",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				"mod-warning",
			).open();
		});
	}

	private confirmMarkdownConflictResolution(
		path: string,
		resolution: DashboardMarkdownConflictResolution,
		choice: DashboardMarkdownConflictResolutionChoice,
	): Promise<void> {
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		const keepingLocal = choice === "keep-local";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepingLocal ? "Keep local note version?" : "Use remote note copy?",
				keepingLocal
					? `Promote the local disk content of "${path}" as the authoritative version? Remote changes will be overwritten in the CRDT (an audit copy will be preserved).`
					: `Overwrite the local disk file "${path}" with the remote CRDT version? Local uncommitted disk changes will be replaced.`,
				async () => {
					try {
						await this.deps.actions.resolveMarkdownConflictAttention(
							{ path, ...resolution },
							choice,
						);
						new Notice(
							keepingLocal
								? `Local version kept for: ${path}`
								: `Remote copy applied for: ${path}`,
						);
						this.removeResolvedMarkdownConflictEpisode(path, resolution);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				keepingLocal ? "Keep local version" : "Use remote copy",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				keepingLocal ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private confirmTombstoneConflictResolution(
		path: string,
		resolution: DashboardTombstoneDiskConflictResolution,
		choice: "keep-local" | "accept-delete",
	): Promise<void> {
		const episodeKey = attentionEpisodeKey(path, resolution);
		if (this.pendingAttentionEpisodes.has(episodeKey)) {
			return Promise.reject(new Error(`A resolution is already pending for "${path}".`));
		}
		this.pendingAttentionEpisodes.add(episodeKey);
		this.render();
		const keepingLocal = choice === "keep-local";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepingLocal ? "Keep local note version?" : "Accept delete?",
				keepingLocal
					? `Revive "${path}" and publish this local note to sync? The CRDT deletion tombstone will be cleared.`
					: `Move the local file "${path}" to trash? The sync deletion will be confirmed.`,
				async () => {
					try {
						await this.deps.actions.resolveTombstoneConflict(path, choice, resolution);
						new Notice(
							keepingLocal
								? `Local note revived and kept: ${path}`
								: `Local file moved to trash: ${path}`,
						);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					} finally {
						this.pendingAttentionEpisodes.delete(episodeKey);
						this.render();
					}
				},
				keepingLocal ? "Keep local version" : "Accept delete",
				"Cancel",
				() => {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
					resolve();
				},
				keepingLocal ? "mod-cta" : "mod-warning",
			).open();
		});
	}

	private removeResolvedMarkdownConflictEpisode(
		path: string,
		resolution: DashboardMarkdownConflictResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "markdown-conflict") {
				return true;
			}
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private removeResolvedStuckLocalMutationEpisode(
		path: string,
		resolution: DashboardStuckLocalMutationResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "stuck-local-mutation") {
				return true;
			}
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private removeResolvedAttentionEpisode(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
	): void {
		if (!this.data) return;
		const nextAttention = this.data.attention.filter((item) => {
			if (item.path !== path || item.resolution?.kind !== "remote-delete") return true;
			return item.resolution.episodeId !== resolution.episodeId;
		});
		if (nextAttention.length === this.data.attention.length) return;
		this.data = {
			...this.data,
			attention: nextAttention,
			attentionTotalCount: Math.max(0, this.data.attentionTotalCount - 1),
		};
	}

	private async runAttentionAudit(): Promise<void> {
		if (this.isAuditingAttention || this.isRetiringAttention) return;
		this.isAuditingAttention = true;
		this.render();
		try {
			this.lastAuditResult = await this.deps.actions.auditAttention();
			await this.refresh();
			new Notice(
				`Attention audit completed: ${this.lastAuditResult.summary.retirableCount} retirable, ${this.lastAuditResult.summary.activeCount} active.`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Attention audit failed: ${message}`);
		} finally {
			this.isAuditingAttention = false;
			this.render();
		}
	}

	private async confirmRetireVerifiedAttention(audit: AttentionAuditResult): Promise<void> {
		if (this.isAuditingAttention || this.isRetiringAttention) return;
		const retirableItems = audit.items.filter((item) => item.classification === "retirable");
		if (retirableItems.length === 0) return;

		const targets: AttentionRetirementTarget[] = retirableItems.map((item) => ({
			path: item.entry.path,
			kind: item.entry.kind,
			reason: item.entry.reason,
			episodeId: item.episodeId,
			expectedRemoteFingerprint: item.remoteDeleteFingerprint ?? undefined,
			pairPath: item.pairPath ?? undefined,
		}));

		new ConfirmModal(
			this.app,
			`Retire ${targets.length} verified attention marker(s)?`,
			"This will retire historical markers whose paths are absent locally and confirmed settled remotely. No local files, remote documents, or backups will be deleted.",
			async () => {
				this.isRetiringAttention = true;
				this.render();
				try {
					const summary = await this.deps.actions.retireVerifiedAttention(targets);
					this.lastAuditResult = null;
					await this.refresh();
					new Notice(
						`Retired ${summary.retiredCount} attention marker(s)${summary.failedCount > 0 ? ` (${summary.failedCount} skipped due to state change)` : ""}.`,
					);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Attention retirement failed: ${message}`);
				} finally {
					this.isRetiringAttention = false;
					this.render();
				}
			},
			`Retire ${targets.length} marker(s)`,
			"Cancel",
			() => {},
			"mod-cta",
		).open();
	}

	private async confirmRetireSingleAttention(auditItem: AttentionAuditItem): Promise<void> {
		if (this.isAuditingAttention || this.isRetiringAttention) return;
		const target: AttentionRetirementTarget = {
			path: auditItem.entry.path,
			kind: auditItem.entry.kind,
			reason: auditItem.entry.reason,
			episodeId: auditItem.episodeId,
			expectedRemoteFingerprint: auditItem.remoteDeleteFingerprint ?? undefined,
			pairPath: auditItem.pairPath ?? undefined,
		};

		new ConfirmModal(
			this.app,
			`Retire attention marker for "${auditItem.entry.path}"?`,
			`This will retire the verified attention marker for "${auditItem.entry.path}".\n\nReason: ${auditItem.rationale}\n\nNo local files, remote documents, or backups will be deleted.`,
			async () => {
				this.isRetiringAttention = true;
				this.render();
				try {
					const summary = await this.deps.actions.retireVerifiedAttention([target]);
					if (summary.retiredCount > 0) {
						new Notice(`Retired attention marker: ${auditItem.entry.path}`);
						if (this.lastAuditResult) {
							this.lastAuditResult.items = this.lastAuditResult.items.filter(
								(i) => !(
									i.entry.kind === target.kind
									&& normalizePath(i.entry.path) === normalizePath(target.path)
									&& i.episodeId === target.episodeId
								),
							);
							this.lastAuditResult.summary = buildSummary(this.lastAuditResult.items);
						}
						await this.refresh(true);
					} else if (summary.failedCount > 0) {
						new Notice(`Retirement skipped for "${auditItem.entry.path}" due to state change.`);
						await this.refresh(true);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Attention retirement failed: ${message}`);
				} finally {
					this.isRetiringAttention = false;
					this.render();
				}
			},
			"Retire marker",
			"Cancel",
			() => {},
			"mod-cta",
		).open();
	}

	private async confirmDeleteSafetyCopy(copy: DashboardConflictArtifact): Promise<void> {
		const normalized = normalizePath(copy.artifactPath);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!file || !(file instanceof TFile)) {
			new Notice(`Backup file not found on disk: ${copy.artifactPath}`);
			await this.refresh(true);
			return;
		}

		new ConfirmModal(
			this.app,
			"Delete safety backup file?",
			`Are you sure you want to delete this local backup file?\n\n` +
			`Path: ${copy.artifactPath}\n` +
			(copy.originalExists ? `Current file: ${copy.inferredOriginalPath}\n\n` : `\n`) +
			`The backup file will be moved to the Obsidian trash.`,
			async () => {
				try {
					if (this.app.fileManager?.trashFile) {
						await this.app.fileManager.trashFile(file);
					} else {
						// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
						await this.app.vault.trash(file, true);
					}
					new Notice(`Moved backup to trash: ${copy.artifactPath}`);
					await this.refresh(true);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Failed to delete backup: ${message}`);
				}
			},
			"Delete backup",
			"Cancel",
			() => {},
			"mod-warning",
		).open();
	}

	private async confirmAcknowledgeAttention(item: DashboardAttentionItem): Promise<void> {
		const targetPath = item.path;
		if (!targetPath) return;

		new ConfirmModal(
			this.app,
			`Acknowledge attention marker for "${targetPath}"?`,
			`This confirms that you have reviewed this file and verified its state is normal.\n\n` +
			`Path: ${targetPath}\n` +
			`Reason: ${item.detail || item.title}\n\n` +
			`This will clear the attention marker from KAOS without modifying or deleting any local files. Continue?`,
			async () => {
				try {
					if (this.deps.actions.dismissAttentionEntry) {
						await this.deps.actions.dismissAttentionEntry(targetPath);
					}
					if (this.lastAuditResult) {
						const normTarget = normalizePath(targetPath);
						this.lastAuditResult.items = this.lastAuditResult.items.filter(
							(i) => normalizePath(i.entry.path) !== normTarget,
						);
						this.lastAuditResult.summary = buildSummary(this.lastAuditResult.items);
					}
					new Notice(`Cleared attention marker: ${targetPath}`);
					await this.refresh(true);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Failed to clear attention marker: ${message}`);
				}
			},
			"Acknowledge & clear",
			"Cancel",
			() => {},
			"mod-cta",
		).open();
	}

	private async confirmAdoptStructuralRename(oldPath: string, newPath: string): Promise<void> {
		new ConfirmModal(
			this.app,
			"Adopt rename?",
			`Adopt structural rename:\n\n"${oldPath}" → "${newPath}"\n\n` +
			`This confirms that this file was moved or renamed.\n` +
			`KAOS will link the file identity in sync and clear conflict markers.\n\n` +
			`No local file content will be modified. Continue?`,
			async () => {
				try {
					if (this.deps.actions.adoptStructuralRename) {
						await this.deps.actions.adoptStructuralRename(oldPath, newPath);
					}
					if (this.lastAuditResult) {
						const normTargetOld = normalizePath(oldPath);
						const normTargetNew = normalizePath(newPath);
						this.lastAuditResult.items = this.lastAuditResult.items.filter(
							(i) => {
								const p = normalizePath(i.entry.path);
								return p !== normTargetOld && p !== normTargetNew;
							},
						);
						this.lastAuditResult.summary = buildSummary(this.lastAuditResult.items);
					}
					new Notice(`Adopted rename: "${oldPath}" → "${newPath}"`);
					await this.refresh(true);
					await this.deps.actions.forceReconcile();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					new Notice(`Failed to adopt rename: ${message}`);
					await this.refresh(true);
				}
			},
			"Adopt rename",
			"Cancel",
			() => {},
			"mod-cta",
		).open();
	}

	private markAttentionEpisodePending(
		path: string,
		resolution: DashboardRemoteDeleteResolution,
	): void {
		if (!this.data) return;
		this.data = {
			...this.data,
			attention: this.data.attention.map((item) => {
				if (
					item.path !== path
					|| item.resolution?.kind !== "remote-delete"
					|| item.resolution.episodeId !== resolution.episodeId
				) return item;
				return {
					...item,
					resolution: {
						...item.resolution,
						keepLocalPending: true,
						canKeepLocal: false,
						canAcceptRemoteDelete: false,
						keepLocalUnavailableReason: "The local attachment is still being published.",
						acceptRemoteDeleteUnavailableReason: "Wait for the pending Keep local upload to finish.",
					},
				};
			}),
		};
	}

	private section(root: HTMLElement, title: string, extraClass = ""): HTMLElement {
		const section = root.createDiv({
			cls: ["kaos-dashboard-section", extraClass].filter(Boolean).join(" "),
		});
		section.createEl("h3", { text: title });
		return section;
	}

	private button(
		parent: HTMLElement,
		label: string,
		action: () => void | Promise<void>,
		disabled = false,
		disabledReason?: string,
		refreshAfterAction = true,
	): HTMLButtonElement {
		const button = parent.createEl("button", { text: label });
		button.disabled = disabled;
		if (disabled && disabledReason) {
			button.title = disabledReason;
			button.setAttribute("aria-label", `${label}: ${disabledReason}`);
		}
		button.addEventListener("click", () => {
			if (button.disabled) return;
			button.disabled = true;
			Promise.resolve(action())
				.then(() => refreshAfterAction ? this.refresh(true) : undefined)
				.catch((err) => {
					new Notice(`${label} failed: ${formatUnknown(err)}`, 7000);
					console.warn(`[kaos] dashboard action failed: ${label}`, err);
				})
				.finally(() => {
					button.disabled = disabled;
				});
		});
		return button;
	}

	private async openPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`File not found: ${path}`, 5000);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	private async openMarkdownConflictReview(path: string, resolution: DashboardMarkdownConflictResolution): Promise<void> {
		const sides = await this.deps.getMarkdownConflictReviewSides?.(path);
		if (!sides || (sides.localText === null && sides.remoteText === null)) {
			throw new Error("Local and remote note content are required. Refresh the dashboard and try again.");
		}
		const baseText = sides.baseHash ? await this.deps.getBaselineText?.(sides.baseHash) ?? null : null;
		new ConflictDiffModal(this.app, {
			artifactPath: path, originalPath: path,
			originalText: sides.localText ?? "", artifactText: sides.remoteText ?? "",
			baseHash: sides.baseHash, baseText,
			labels: { original: "Local (disk)", artifact: "Remote (sync)" }, context: "attention",
			onResolve: async (choice) => {
				const episodeKey = attentionEpisodeKey(path, resolution);
				if (this.pendingAttentionEpisodes.has(episodeKey)) throw new Error("A resolution is already pending.");
				this.pendingAttentionEpisodes.add(episodeKey);
				this.render();
				try {
					const current = await this.deps.getMarkdownConflictReviewSides?.(path);
					if (!current || current.localText !== sides.localText || current.remoteText !== sides.remoteText) {
						throw new Error("Note content changed. Reopen the conflict review and try again.");
					}
					const dashboardChoice: DashboardMarkdownConflictResolutionChoice = choice.kind === "original" ? "keep-local"
						: choice.kind === "artifact" ? "use-remote"
						: { kind: "use-merged", mergedText: choice.mergedText, expectedLocalText: sides.localText ?? "", expectedRemoteText: sides.remoteText ?? "" };
					const result = await this.deps.actions.resolveMarkdownConflictAttention({ path, ...resolution }, dashboardChoice);
					if (result.status !== "completed") throw new Error(result.message);
					this.removeResolvedMarkdownConflictEpisode(path, resolution);
					await this.refresh(true);
				} finally {
					this.pendingAttentionEpisodes.delete(episodeKey);
					this.render();
				}
			},
		}).open();
	}

	private async openConflictDiff(artifact: DashboardConflictArtifact): Promise<void> {
		if (artifact.kind !== "markdown") {
			new Notice("Diff is available for text-document conflict artifacts.");
			return;
		}
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			new Notice("Both the conflict artifact and original document are required for diff.", 5000);
			return;
		}
		const [originalText, artifactText] = await Promise.all([
			this.app.vault.read(originalFile),
			this.app.vault.read(artifactFile),
		]);
		const resolutionSnapshot = captureConflictResolutionSnapshot({
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			artifactFile,
			originalFile,
			artifactText,
			originalText,
		});
		const baseHash = this.deps.getConflictMergeBaseHash?.(artifact.artifactPath) ?? null;
		const baseText = baseHash ? await this.deps.getBaselineText?.(baseHash) ?? null : null;
		new ConflictDiffModal(this.app, {
			artifactPath: artifact.artifactPath,
			originalPath: artifact.inferredOriginalPath,
			originalText,
			artifactText,
			baseHash,
			baseText,
			onResolve: (choice) => this.resolveConflictArtifact(resolutionSnapshot, choice),
		}).open();
	}

	private async resolveConflictArtifact(
		snapshot: ConflictResolutionSnapshot,
		choice: ConflictResolutionChoice,
	): Promise<void> {
		await resolveConflictArtifactWithCas(this.app.vault, snapshot, choice);
		this.deps.clearConflictMergeBase?.(snapshot.artifactPath);
		await this.refresh(true);
	}

	private confirmDashboardConflictResolution(
		artifact: DashboardConflictArtifact,
		choice: Extract<ConflictResolutionChoice, { kind: "original" | "artifact" }>,
	): Promise<void> {
		const useArtifact = choice.kind === "artifact";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				useArtifact ? "Use conflict artifact?" : "Use original document?",
				useArtifact
					? `Replace "${artifact.inferredOriginalPath}" with the conflict artifact content and move the conflict artifact to trash?`
					: `Keep "${artifact.inferredOriginalPath}" as the selected version and move the conflict artifact to trash?`,
				async () => {
					try {
						await this.resolveConflictArtifactFromDashboard(artifact, choice);
						new Notice(
							useArtifact
								? "Conflict resolved using artifact. Conflict artifact moved to trash."
								: "Original selected. Conflict artifact moved to trash.",
						);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				},
				useArtifact ? "Use artifact" : "Use original",
				"Cancel",
				resolve,
				"mod-cta",
			).open();
		});
	}

	private confirmBlobConflictResolution(
		target: DashboardBlobConflictResolutionTarget,
		choice: DashboardBlobConflictResolutionChoice,
	): Promise<void> {
		const keepLocal = choice === "keep-local";
		return new Promise((resolve, reject) => {
			new ConfirmModal(
				this.app,
				keepLocal ? "Keep local attachment?" : "Use remote attachment copy?",
				keepLocal
					? `Publish the current local attachment at "${target.path}" as the selected version? The remote conflict copy remains recoverable until the upload settles.`
					: `Replace "${target.path}" with the reviewed remote copy? If the current local attachment differs, KAOS will preserve it as a local rollback safety copy.`,
				async () => {
					try {
						const result = await this.deps.actions.resolveBlobConflict(target, choice);
						const message = result.status === "pending"
							? result.message
							: keepLocal
								? "Local attachment selected. Publishing is complete."
								: [
									"Remote attachment copy selected.",
									result.safetyCopyPath
										? `The previous local version was preserved at "${result.safetyCopyPath}".`
										: "No additional local safety copy was needed.",
									result.artifactRemoved
										? ""
										: "The reviewed conflict copy could not be moved to trash; review it manually.",
								].filter(Boolean).join(" ");
						new Notice(message, result.status === "completed" && !result.artifactRemoved ? 9000 : 6000);
						resolve();
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				},
				keepLocal ? "Keep local original" : "Use remote copy",
				"Cancel",
				resolve,
				"mod-cta",
			).open();
		});
	}

	private async resolveConflictArtifactFromDashboard(
		artifact: DashboardConflictArtifact,
		choice: Extract<ConflictResolutionChoice, { kind: "original" | "artifact" }>,
	): Promise<void> {
		if (artifact.kind !== "markdown" || !artifact.originalExists) {
			throw new Error("Both text documents must exist before choosing a conflict version.");
		}
		const artifactFile = this.app.vault.getAbstractFileByPath(artifact.artifactPath);
		const originalFile = this.app.vault.getAbstractFileByPath(artifact.inferredOriginalPath);
		if (!(artifactFile instanceof TFile) || !(originalFile instanceof TFile)) {
			throw new Error("Both the conflict artifact and original document are required before choosing a version.");
		}
		const [originalText, artifactText] = await Promise.all([
			this.app.vault.read(originalFile),
			this.app.vault.read(artifactFile),
		]);
		await this.resolveConflictArtifact(
			captureConflictResolutionSnapshot({
				artifactPath: artifact.artifactPath,
				originalPath: artifact.inferredOriginalPath,
				artifactFile,
				originalFile,
				artifactText,
				originalText,
			}),
			choice,
		);
	}

	private async copyPath(path: string): Promise<void> {
		await navigator.clipboard.writeText(path);
		new Notice("Path copied.");
	}

	private renderResolvedAttentionHistory(
		root: HTMLElement,
		history: ResolvedAttentionItem[],
	): void {
		if (history.length === 0) return;
		const details = root.createEl("details", {
			cls: "kaos-dashboard-disclosure kaos-dashboard-attention-history-disclosure",
		});
		const summary = details.createEl("summary", { cls: "kaos-dashboard-disclosure-summary" });
		const copy = summary.createSpan({ cls: "kaos-dashboard-disclosure-copy" });
		copy.createSpan({ text: `Resolved attention history (${history.length})`, cls: "kaos-dashboard-disclosure-title" });
		copy.createSpan({ text: "Recently retired and settled attention markers", cls: "kaos-dashboard-disclosure-detail" });
		const body = details.createDiv({ cls: "kaos-dashboard-disclosure-body" });

		const toolbar = body.createDiv({ cls: "kaos-dashboard-row-actions" });
		this.button(
			toolbar,
			"Clear history",
			() => {
				new ConfirmModal(
					this.app,
					"Clear resolved attention history?",
					"This will clear the history of resolved attention markers displayed in the dashboard. Existing files and sync documents are not affected.",
					async () => {
						await this.deps.actions.clearResolvedAttentionHistory?.();
						await this.refresh();
					},
					"Clear history",
					"Cancel",
					() => {},
					"mod-warning",
				).open();
			},
			!this.deps.actions.clearResolvedAttentionHistory,
		);

		const list = body.createDiv({ cls: "kaos-dashboard-list" });
		for (const entry of history) {
			const row = list.createDiv({ cls: "kaos-dashboard-row is-muted" });
			row.createDiv({ text: entry.path, cls: "kaos-dashboard-path" });
			const metaParts = [
				entry.kind,
				entry.reason,
				entry.resolution,
				formatDateTime(new Date(entry.resolvedAt).toISOString()),
			];
			if (entry.pairPath) {
				metaParts.push(`pair: ${entry.pairPath}`);
			}
			row.createDiv({ text: metaParts.join(" · "), cls: "kaos-dashboard-muted" });
			if (entry.summary) {
				row.createDiv({ text: entry.summary, cls: "kaos-dashboard-subpath kaos-dashboard-muted" });
			}
			const actions = row.createDiv({ cls: "kaos-dashboard-row-actions" });
			const exists = this.app.vault.getAbstractFileByPath(normalizePath(entry.path)) !== null;
			if (exists) {
				this.button(actions, "Open file", () => this.openPath(entry.path));
			}
			if (entry.pairPath && this.app.vault.getAbstractFileByPath(normalizePath(entry.pairPath)) !== null) {
				this.button(actions, "Open pair", () => this.openPath(entry.pairPath!));
			}
			this.button(actions, "Copy path", () => this.copyPath(entry.path));
		}
	}
}

interface ConflictDiffModalData {
	artifactPath: string;
	originalPath: string;
	originalText: string;
	artifactText: string;
	baseHash: string | null;
	baseText: string | null;
	labels?: { original: string; artifact: string };
	context?: "artifact-cas" | "attention";
	onResolve(choice: ConflictResolutionChoice): Promise<void>;
}

interface ManualMergeModel {
	mode: "clean" | "three-way" | "two-way";
	hunks: ThreeWayMergeConflictHunk[];
	segments: ThreeWayMergeSegment[];
	cleanText?: string;
}

class ConflictDiffModal extends Modal {
	private mergeModel: ManualMergeModel | null = null;
	private hunkEdits = new Map<number, string>();
	private previewEl: HTMLTextAreaElement | null = null;

	constructor(
		app: App,
		private readonly data: ConflictDiffModalData,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("kaos-conflict-diff-modal-frame");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("kaos-conflict-diff-modal");
		contentEl.createEl("h3", { text: "Conflict diff" });

		const pathGrid = contentEl.createDiv({ cls: "kaos-conflict-diff-paths" });
		this.renderPath(pathGrid, this.data.labels?.original ?? "Original", this.data.originalPath);
		this.renderPath(pathGrid, this.data.labels?.artifact ?? "Conflict artifact", this.data.artifactPath);
		this.renderPath(pathGrid, "Base", this.data.baseHash ? `available (${this.data.baseHash.slice(0, 12)})` : "not available");

		const actions = contentEl.createDiv({ cls: "modal-button-container kaos-conflict-diff-actions" });
		actions.createEl("button", { text: this.data.context === "attention" ? "Keep local version" : "Use original" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "original" });
		});
		actions.createEl("button", { text: this.data.context === "attention" ? "Use remote copy" : "Use artifact", cls: "mod-cta" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "artifact" });
		});
		actions.createEl("button", { text: "Apply merged", cls: "mod-cta" }).addEventListener("click", () => {
			this.confirmResolution({ kind: "merged", mergedText: this.currentMergedText() });
		});
		actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());

		if (this.data.context === "attention") {
			const sides = contentEl.createDiv({ cls: "kaos-conflict-review-sides" });
			for (const [label, text] of [[this.data.labels?.original ?? "Local", this.data.originalText], [this.data.labels?.artifact ?? "Remote", this.data.artifactText]]) {
				const pane = sides.createDiv({ cls: "kaos-conflict-merge-pane" });
				pane.createDiv({ text: label, cls: "kaos-conflict-merge-pane-label" });
				this.renderMergePlainText(pane.createDiv({ cls: "kaos-conflict-merge-pane-body" }), text!, "Empty or missing note");
			}
		}

		this.renderManualMerge(contentEl);

		contentEl.createEl("h4", { text: this.data.context === "attention" ? "Local vs remote diff" : "Original vs artifact diff", cls: "kaos-conflict-diff-heading" });
		const legend = contentEl.createDiv({ cls: "kaos-conflict-diff-legend" });
		legend.createEl("span", { text: `- ${this.data.labels?.original ?? "original"}`, cls: "kaos-conflict-diff-delete" });
		legend.createEl("span", { text: `+ ${this.data.labels?.artifact ?? "artifact"}`, cls: "kaos-conflict-diff-insert" });

		const diffBody = contentEl.createDiv({ cls: "kaos-conflict-diff-body" });
		this.renderDiffLines(
			diffBody,
			buildTextDiffLines(this.data.originalText, this.data.artifactText, {
				maxSegments: 80,
				maxLinesPerSegment: 20,
				contextLines: 15,
			}),
		);
	}

	onClose(): void {
		this.modalEl.removeClass("kaos-conflict-diff-modal-frame");
		this.contentEl.empty();
	}

	private renderPath(parent: HTMLElement, label: string, path: string): void {
		const item = parent.createDiv({ cls: "kaos-conflict-diff-path-item" });
		item.createDiv({ text: label, cls: "kaos-conflict-diff-path-label" });
		item.createDiv({ text: path, cls: "kaos-conflict-diff-path-value" });
	}

	private renderManualMerge(parent: HTMLElement): void {
		this.mergeModel = this.buildMergeModel();
		this.hunkEdits.clear();
		const root = parent.createDiv({ cls: "kaos-conflict-merge" });
		root.createEl("h4", { text: this.mergeModel.mode === "two-way" ? "Manual merge" : "3-way merge" });

		if (this.mergeModel.hunks.length > 0) {
			for (const hunk of this.mergeModel.hunks) {
				this.hunkEdits.set(hunk.index, hunk.leftText);
				this.renderMergeHunk(root, hunk, this.mergeModel.mode);
			}
		}

		const previewWrap = root.createDiv({ cls: "kaos-conflict-merge-preview" });
		previewWrap.createDiv({ text: "Merged", cls: "kaos-conflict-diff-path-label" });
		this.previewEl = previewWrap.createEl("textarea", {
			cls: "kaos-conflict-merge-preview-text",
		});
		this.previewEl.readOnly = true;
		this.updateMergePreview();
	}

	private buildMergeModel(): ManualMergeModel {
		if (this.data.baseText !== null) {
			const result = mergeTexts3(this.data.baseText, this.data.originalText, this.data.artifactText);
			if (result.kind === "clean-merge") {
				return {
					mode: "clean",
					hunks: [],
					segments: [{ kind: "text", text: result.mergedText }],
					cleanText: result.mergedText,
				};
			}
			if (result.kind === "conflict") {
				return {
					mode: "three-way",
					hunks: result.hunks,
					segments: result.segments,
				};
			}
		}

		const fallbackHunk: ThreeWayMergeConflictHunk = {
			index: 0,
			baseStart: 0,
			baseEnd: 0,
			baseText: "",
			leftText: this.data.originalText,
			rightText: this.data.artifactText,
		};
		return {
			mode: "two-way",
			hunks: [fallbackHunk],
			segments: [{ kind: "conflict", hunkIndex: 0 }],
		};
	}

	private renderMergeHunk(parent: HTMLElement, hunk: ThreeWayMergeConflictHunk, mode: ManualMergeModel["mode"]): void {
		const item = parent.createDiv({ cls: "kaos-conflict-merge-hunk" });
		item.createDiv({
			text: `Hunk ${hunk.index + 1}`,
			cls: "kaos-conflict-merge-hunk-title",
		});

		const paneGrid = item.createDiv({ cls: "kaos-conflict-merge-pane-grid" });
		this.renderMergeSourcePane(paneGrid, "Base", hunk.baseText, {
			kind: "base",
			baseText: hunk.baseText,
			diffAgainstBase: false,
			unavailable: mode === "two-way",
		});
		this.renderMergeSourcePane(paneGrid, this.data.labels?.original ?? "Original", hunk.leftText, {
			kind: "original",
			baseText: hunk.baseText,
			diffAgainstBase: mode !== "two-way",
			unavailable: false,
		});
		this.renderMergeSourcePane(paneGrid, this.data.labels?.artifact ?? "Artifact", hunk.rightText, {
			kind: "artifact",
			baseText: hunk.baseText,
			diffAgainstBase: mode !== "two-way",
			unavailable: false,
		});

		const buttons = item.createDiv({ cls: "kaos-conflict-merge-hunk-actions" });
		const editor = item.createDiv({ cls: "kaos-conflict-merge-editor" });
		editor.createDiv({ text: "Merged", cls: "kaos-conflict-diff-path-label" });
		const textarea = editor.createEl("textarea", { cls: "kaos-conflict-merge-hunk-text" });
		textarea.value = hunk.leftText;
		textarea.addEventListener("input", () => {
			this.hunkEdits.set(hunk.index, textarea.value);
			this.updateMergePreview();
		});
		const setText = (text: string) => {
			textarea.value = text;
			this.hunkEdits.set(hunk.index, text);
			this.updateMergePreview();
		};
		buttons.createEl("button", { text: this.data.context === "attention" ? "Use local" : "Use original" }).addEventListener("click", () => setText(hunk.leftText));
		buttons.createEl("button", { text: this.data.context === "attention" ? "Use remote" : "Use artifact" }).addEventListener("click", () => setText(hunk.rightText));
		buttons.createEl("button", { text: "Use both" }).addEventListener("click", () => setText(combineBoth(hunk.leftText, hunk.rightText)));
		buttons.createEl("button", { text: "Edit merged" }).addEventListener("click", () => textarea.focus());
	}

	private renderMergeSourcePane(
		parent: HTMLElement,
		label: string,
		text: string,
		options: {
			kind: "base" | "original" | "artifact";
			baseText: string;
			diffAgainstBase: boolean;
			unavailable: boolean;
		},
	): void {
		const pane = parent.createDiv({ cls: `kaos-conflict-merge-pane is-${options.kind}` });
		pane.createDiv({ text: label, cls: "kaos-conflict-merge-pane-label" });
		const body = pane.createDiv({ cls: "kaos-conflict-merge-pane-body" });
		if (options.unavailable) {
			this.renderMergeEmptyText(body, "Base not available");
			return;
		}
		if (options.kind === "base") {
			this.renderMergePlainText(body, text, "Empty base");
			return;
		}
		if (!options.diffAgainstBase) {
			this.renderMergePlainText(body, text, `Empty ${label.toLowerCase()}`);
			return;
		}
		this.renderMergeVariantDiff(body, options.baseText, text, options.kind);
	}

	private renderMergeVariantDiff(
		parent: HTMLElement,
		baseText: string,
		variantText: string,
		kind: "original" | "artifact",
	): void {
		const lines = buildTextDiffLines(baseText, variantText, {
			maxSegments: 200,
			maxLinesPerSegment: 200,
		});
		if (lines.length === 0) {
			this.renderMergeEmptyText(parent, "No changes");
			return;
		}
		for (const line of lines) {
			const changed = line.kind !== "equal" && line.kind !== "context";
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const text = line.text.length === 0 ? prefix : `${prefix}${line.text}`;
			const cls = [
				"kaos-conflict-merge-pane-line",
				changed ? `is-${kind}-change` : "",
				line.kind === "context" ? "is-context" : "",
			].filter(Boolean).join(" ");
			parent.createDiv({ text, cls });
		}
	}

	private renderMergePlainText(parent: HTMLElement, text: string, emptyText: string): void {
		const lines = splitDisplayLines(text);
		if (lines.length === 0) {
			this.renderMergeEmptyText(parent, emptyText);
			return;
		}
		for (const line of lines) {
			parent.createDiv({
				text: line.length === 0 ? "  " : `  ${line}`,
				cls: "kaos-conflict-merge-pane-line",
			});
		}
	}

	private renderMergeEmptyText(parent: HTMLElement, text: string): void {
		parent.createDiv({ text, cls: "kaos-conflict-merge-pane-empty" });
	}

	private currentMergedText(): string {
		const model = this.mergeModel ?? this.buildMergeModel();
		if (model.cleanText !== undefined) return model.cleanText;
		return model.segments.map((segment) => {
			if (segment.kind === "text") return segment.text;
			return this.hunkEdits.get(segment.hunkIndex) ?? "";
		}).join("");
	}

	private updateMergePreview(): void {
		if (!this.previewEl) return;
		this.previewEl.value = this.currentMergedText();
	}

	private renderDiffLines(parent: HTMLElement, lines: RenderedDiffLine[]): void {
		for (const line of lines) {
			const prefix = line.kind === "delete" ? "- " : line.kind === "insert" ? "+ " : "  ";
			const cls = line.kind === "delete"
				? "kaos-conflict-diff-line is-delete"
				: line.kind === "insert"
					? "kaos-conflict-diff-line is-insert"
					: line.kind === "context"
						? "kaos-conflict-diff-line is-context"
						: "kaos-conflict-diff-line";
			parent.createDiv({ text: `${prefix}${line.text}` || " ", cls });
		}
	}

	private confirmResolution(choice: ConflictResolutionChoice): void {
		if (this.data.context === "attention") {
			const merged = choice.kind === "merged";
			const remote = choice.kind === "artifact";
			const title = merged ? "Apply merged result?" : remote ? "Use remote copy?" : "Keep local version?";
			const message = merged ? "Apply the merged result to this note?" : remote ? "Use the remote copy?" : "Keep the local version?";
			const confirm = merged ? "Apply merged" : remote ? "Use remote copy" : "Keep local version";
			new ConfirmModal(this.app, title, message, () => this.applyResolution(choice), confirm, "Cancel").open();
			return;
		}

		const useArtifact = choice.kind === "artifact";
		const useMerged = choice.kind === "merged";
		new ConfirmModal(
			this.app,
			useMerged ? "Apply merged result?" : useArtifact ? "Use conflict artifact?" : "Use original note?",
			useMerged
				? `Replace "${this.data.originalPath}" with the merged result and move "${this.data.artifactPath}" to trash?`
				: useArtifact
				? `Replace "${this.data.originalPath}" with the conflict artifact content and move "${this.data.artifactPath}" to trash?`
				: `Keep "${this.data.originalPath}" as-is and move "${this.data.artifactPath}" to trash?`,
			() => this.applyResolution(choice),
			useMerged ? "Apply merged" : useArtifact ? "Use artifact" : "Use original",
			"Cancel",
		).open();
	}

	private async applyResolution(choice: ConflictResolutionChoice): Promise<void> {
		try {
			await this.data.onResolve(choice);
			new Notice(
				this.data.context === "attention" ? "Note conflict resolved." : choice.kind === "merged"
					? "Conflict resolved using merged result. Conflict artifact moved to trash."
					: choice.kind === "artifact"
						? "Conflict resolved using artifact. Conflict artifact moved to trash."
						: "Original selected. Conflict artifact moved to trash.",
			);
			this.close();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Conflict resolution failed: ${message}`, 8000);
			console.warn("[kaos] conflict resolution failed:", err);
		}
	}
}

function combineBoth(left: string, right: string): string {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	if (left.endsWith("\n") || right.startsWith("\n")) return left + right;
	return `${left}\n${right}`;
}

function splitDisplayLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function toneClass(tone: string | undefined): string {
	return tone ? `is-${tone}` : "";
}

function displayChangeKind(kind: string): string {
	switch (kind) {
		case "created": return "Created";
		case "modified": return "Modified";
		case "renamed": return "Renamed";
		case "deleted": return "Deleted";
		case "restored": return "Restored";
		default: return kind;
	}
}

function changeKindClass(kind: string): string {
	return `is-change-${kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
}

function recoveryStorageDisplay(status: DashboardRecoveryStorageStatus): { label: string; tone: DashboardTone; detail: string } {
	if (status.status !== "ready") {
		return {
			label: "Unknown",
			tone: status.status === "error" ? "error" : "muted",
			detail: status.message,
		};
	}
	const report = status.report;
	switch (report.status) {
		case "healthy":
		case "empty":
			return {
				label: "Healthy",
				tone: "ok",
				detail: `${report.manifestCountLowerBound} manifest(s) checked`,
			};
		case "repaired":
			return {
				label: "Repaired",
				tone: "warn",
				detail: `${report.repairs.filter((repair) => repair.success).length} repair(s) applied`,
			};
		case "degraded":
			return {
				label: "Needs attention",
				tone: "error",
				detail: `${report.issues.filter((issue) => !issue.repaired).length} issue(s) remaining`,
			};
		case "unavailable":
			return {
				label: "Unknown",
				tone: "muted",
				detail: report.issues[0]?.message ?? "File history storage is unavailable.",
			};
	}
}

function fileHistoryAttemptTone(attempt: DashboardFileHistoryAttempt): DashboardTone {
	switch (attempt.status) {
		case "created":
			return "ok";
		case "pending":
			return "busy";
		case "unavailable":
			return "warn";
		case "noop":
			return "muted";
	}
}

function formatFileHistoryAttempt(attempt: DashboardFileHistoryAttempt): string {
	const detail = attempt.pending
		? `upload ${attempt.pending.uploadedContentCount}/${attempt.pending.totalContentCount} content object(s)`
		: attempt.changedCount !== null
			? `${attempt.changedCount} changed file(s)`
			: attempt.reason ?? "";
	const mode = attempt.forceFull ? "full scan" : "incremental";
	return [
		`Last attempt: ${attempt.status}`,
		detail,
		mode,
		formatDateTime(attempt.attemptedAt),
	].filter(Boolean).join(" - ");
}

function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUnknown(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function attentionEpisodeKey(
	path: string,
	resolution:
		| Pick<DashboardRemoteDeleteResolution, "fileKind" | "episodeId">
		| DashboardTombstoneDiskConflictResolution,
): string {
	if ("fileKind" in resolution && "episodeId" in resolution) {
		return `${resolution.fileKind}:${path}:${resolution.episodeId}`;
	}
	return `tombstone:${path}`;
}
