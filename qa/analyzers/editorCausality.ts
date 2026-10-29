/** Passive evidence classifier. Candidate sources are observations, not root-cause verdicts. */
export interface CausalityEvent {
	kind: string;
	seq: number;
	deviceId?: string;
	bootId?: string;
	traceId?: string;
	pathId?: string;
	data?: Record<string, unknown>;
}

export function analyzeEditorCausality(events: CausalityEvent[]) {
	const groups = new Map<string, CausalityEvent[]>();
	const gaps: Array<{ seq: number; deviceId?: string; reason: string }> = [];
	for (const event of events) {
		if (["flight.events.dropped", "redaction.failure", "path.identity.degraded"].includes(event.kind)) {
			gaps.push({ seq: event.seq, deviceId: event.deviceId, reason: event.kind });
		}
		if (event.data?.captureStatus && event.data.captureStatus !== "ok") {
			gaps.push({ seq: event.seq, deviceId: event.deviceId, reason: String(event.data.captureStatus) });
		}
		if (!event.pathId) continue;
		// seq is meaningful only inside a device/boot/trace, never across devices.
		const key = JSON.stringify([event.deviceId, event.bootId, event.traceId, event.pathId]);
		const group = groups.get(key) ?? [];
		group.push(event);
		groups.set(key, group);
	}
	const observations: Array<{
		kind: string; pathId: string; deviceId?: string; bootId?: string;
		seq: number; evidenceSeqs: number[]; candidates?: string[];
	}> = [];
	let editorObservations = 0;
	for (const group of groups.values()) {
		group.sort((a, b) => a.seq - b.seq);
		const writeKind = group.some(event => event.kind === "disk.write.committed") ? "disk.write.committed" : "disk.write.ok";
		const histories = new Map<string, Map<string, number>>();
		const recent: CausalityEvent[] = [];
		const writes = new Map<string, number[]>();
		for (const event of group) {
			const data = event.data ?? {};
			const base = { pathId: event.pathId!, deviceId: event.deviceId, bootId: event.bootId, seq: event.seq };
			if (event.kind === writeKind && typeof data.diskHash === "string") {
				const key = `${data.contentHashDomain}:${data.diskHash}`;
				const prior = writes.get(key) ?? [];
				prior.push(event.seq);
				writes.set(key, prior.slice(-3));
				if (prior.length === 3) observations.push({ ...base, kind: "repeated-same-content-disk-write", evidenceSeqs: prior });
			}
			if (event.kind === "editor.causality.observed") {
				if (data.phase === "symptom-marked") {
					observations.push({ ...base, kind: "user-reported-rollback", evidenceSeqs: [event.seq] });
				}
				if (data.captureStatus === "ok" && typeof data.editorAfterHash === "string") {
					editorObservations++;
					// Returning to prior bytes is an observation even across a rebind.
					// A CRDT source match below still requires exact binding/text lineage.
					const lineage = JSON.stringify([data.runtimeId, data.cmId, data.contentHashDomain]);
					const history = histories.get(lineage) ?? new Map<string, number>();
					const before = data.editorBeforeHash;
					const after = data.editorAfterHash;
					const previous = history.get(after);
					if (["editor-update", "binding-applied"].includes(String(data.phase)) &&
						typeof before === "string" && before !== after && previous !== undefined && !data.undoOrRedo) {
						const matched = recent.filter(prior => {
							const p = prior.data ?? {};
							if (p.captureStatus !== "ok" || p.contentHashDomain !== data.contentHashDomain) return false;
							if (p.runtimeId !== data.runtimeId) return false;
							if (prior.kind === "disk.modify.classified") {
								return (p.diskEditorNormalizedHash ?? p.diskHash) === after && p.runtimeCurrent === true;
							}
							return p.phase === "crdt-change" && p.yTextId === data.yTextId &&
								p.bindingEpoch === data.bindingEpoch && p.cmId === data.cmId && p.crdtHash === after;
						});
						const candidates = Array.from(new Set(matched.map(prior => prior.kind === "disk.modify.classified"
							? `disk-reload:${String(prior.data?.classification ?? "unknown")}`
							: `${String(prior.data?.originKind ?? "unknown")}-crdt-projection`)));
						if (data.phase === "binding-applied") candidates.push("binding-reprojection");
						observations.push({ ...base,
							kind: data.nonUserDocChanged || data.phase === "binding-applied"
								? "non-user-return-to-seen-editor-state" : "return-to-seen-editor-state",
							evidenceSeqs: [previous, ...matched.map(prior => prior.seq), event.seq], candidates,
						});
					}
					if (data.phase === "editor-update" && data.userDocChanged && data.editorEqualsCrdt === false) {
						observations.push({ ...base, kind: "editor-crdt-diverged-after-input", evidenceSeqs: [event.seq] });
					}
					if (typeof before === "string") history.set(before, event.seq);
					if (history.has(after)) history.delete(after);
					history.set(after, event.seq);
					if (history.size > 64) history.delete(history.keys().next().value!);
					histories.set(lineage, history);
				}
			}
			recent.push(event);
			if (recent.length > 24) recent.shift();
		}
	}
	return {
		status: editorObservations === 0 || gaps.length > 0 ? "INSUFFICIENT_EVIDENCE" : "OBSERVED",
		editorObservations, gaps, observations,
		interpretation: "Candidate sources require reproduction and causal review; absence of observations does not prove absence of rollback.",
	};
}
