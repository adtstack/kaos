type ExtensionRecord = {
	kind: string;
	name: string;
	value?: unknown;
};

function extensionPoint(name: string): { of(value: unknown): ExtensionRecord } {
	return {
		of(value: unknown): ExtensionRecord {
			return { kind: "codemirror-view-extension", name, value };
		},
	};
}

function emptyDom(): {
	isConnected: boolean;
	contains(target: unknown): boolean;
} {
	return {
		isConnected: false,
		contains(_target: unknown): boolean {
			return false;
		},
	};
}

export class EditorView {
	static updateListener = extensionPoint("EditorView.updateListener");
	static decorations = extensionPoint("EditorView.decorations");
	static editable = extensionPoint("EditorView.editable");
	static domEventHandlers(value: unknown): ExtensionRecord {
		return { kind: "codemirror-view-extension", name: "EditorView.domEventHandlers", value };
	}
	static theme(value: unknown): ExtensionRecord {
		return { kind: "codemirror-view-theme", name: "theme", value };
	}
	static baseTheme(value: unknown): ExtensionRecord {
		return { kind: "codemirror-view-theme", name: "baseTheme", value };
	}

	dom = emptyDom();
	hasFocus = false;
	state = {
		doc: {
			length: 0,
			toString(): string {
				return "";
			},
		},
		facet(_facet: unknown): unknown {
			return undefined;
		},
	};

	dispatch(_spec: unknown): void {}
}

export const ViewPlugin = {
	fromClass(pluginClass: unknown, spec?: unknown): ExtensionRecord {
		return { kind: "codemirror-view-plugin", name: "fromClass", value: { pluginClass, spec } };
	},
	define(factory: unknown, spec?: unknown): ExtensionRecord {
		return { kind: "codemirror-view-plugin", name: "define", value: { factory, spec } };
	},
};

export class WidgetType {
	eq(_other: WidgetType): boolean {
		return false;
	}

	toDOM(): unknown {
		return emptyDom();
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export const Decoration = {
	none: Object.freeze({ kind: "codemirror-decoration", name: "none" }),
	mark(spec?: unknown): { range(from: number, to: number): ExtensionRecord } {
		return {
			range(from: number, to: number): ExtensionRecord {
				return { kind: "codemirror-decoration", name: "mark", value: { spec, from, to } };
			},
		};
	},
	widget(spec?: unknown): { range(pos: number): ExtensionRecord } {
		return {
			range(pos: number): ExtensionRecord {
				return { kind: "codemirror-decoration", name: "widget", value: { spec, pos } };
			},
		};
	},
	set(value: unknown): ExtensionRecord {
		return { kind: "codemirror-decoration", name: "set", value };
	},
};

export type DecorationSet = unknown;
export type ViewUpdate = unknown;
