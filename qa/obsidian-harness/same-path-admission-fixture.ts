export type SamePathAdmissionFixtureView = Readonly<{
	leaf: Readonly<{ id: string }>;
	file: Readonly<{ path: string }> | null;
}>;

export type SamePathAdmissionFixtureManager<View extends SamePathAdmissionFixtureView> = Readonly<{
	unbind(view: View): void;
	bind(view: View, deviceName: string): void;
}>;

export type SamePathProjectionFreezeView = SamePathAdmissionFixtureView & {
	editor: Readonly<{ getValue(): string }>;
	setViewData(data: string, clear: boolean, ...args: unknown[]): void;
	requestSave: (() => void) & {
		cancel?: () => unknown;
		flush?: () => unknown;
		run?: () => unknown;
	};
	save(clear?: boolean): Promise<void>;
};

export function freezeSamePathPaneProjectionForQa(
	views: readonly SamePathProjectionFreezeView[],
	path: string,
): () => void {
	type FrozenMethod = Readonly<{
		view: SamePathProjectionFreezeView;
		name: "setViewData" | "requestSave" | "save";
		original: PropertyDescriptor;
		installed: (...args: unknown[]) => unknown;
	}>;
	const panes = views
		.filter((view) => view.file?.path === path)
		.sort((left, right) => left.leaf.id.localeCompare(right.leaf.id));
	if (panes.length !== 2) {
		throw new Error(
			`same-path QA projection freeze requires exactly two panes; observed=${panes.length}`,
		);
	}
	const frozen: FrozenMethod[] = [];
	const restore = (): void => {
		for (const entry of [...frozen].reverse()) {
			const current = Object.getOwnPropertyDescriptor(entry.view, entry.name);
			if (current?.value !== entry.installed) continue;
			Object.defineProperty(entry.view, entry.name, entry.original);
		}
		frozen.length = 0;
	};
	try {
		for (const view of panes) {
			for (const name of ["setViewData", "requestSave", "save"] as const) {
				const original = Object.getOwnPropertyDescriptor(view, name);
				if (!original || typeof original.value !== "function") {
					throw new Error(`same-path QA projection method is not own/wrappable: ${name}`);
				}
				const installed = name === "requestSave"
					? Object.assign(function blockedSamePathQaRequestSave() {}, {
						cancel() {},
						async flush() {},
						async run() {},
					})
					: name === "save"
						? async function blockedSamePathQaSave() {}
						: function blockedSamePathQaSetViewData() {};
				Object.defineProperty(view, name, { ...original, value: installed });
				frozen.push({ view, name, original, installed });
			}
		}
	} catch (error) {
		restore();
		throw error;
	}
	return restore;
}

export function atomicallyReadmitSamePathPanesForQa<
	View extends SamePathAdmissionFixtureView,
>(input: Readonly<{
	manager: SamePathAdmissionFixtureManager<View>;
	views: readonly View[];
	path: string;
	deviceName: string;
}>): readonly string[] {
	const panes = input.views
		.filter((view) => view.file?.path === input.path)
		.sort((left, right) => left.leaf.id.localeCompare(right.leaf.id));
	if (panes.length !== 2) {
		throw new Error(
			`same-path QA readmission requires exactly two panes; observed=${panes.length}`,
		);
	}
	for (const pane of panes) {
		input.manager.unbind(pane);
	}
	input.manager.bind(panes[0]!, input.deviceName);
	return panes.map((pane) => pane.leaf.id);
}
