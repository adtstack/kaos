type ExtensionRecord = {
	kind: string;
	name: string;
	token?: symbol;
	value?: unknown;
};

function extensionPoint(name: string): { of(value: unknown): ExtensionRecord } {
	return {
		of(value: unknown): ExtensionRecord {
			return { kind: "codemirror-extension", name, value };
		},
	};
}

function definedToken(name: string): {
	of(value: unknown): ExtensionRecord;
	is(value: unknown): boolean;
} {
	const token = Symbol(`kaos-headless-cm:${name}`);
	return {
		of(value: unknown): ExtensionRecord {
			return { kind: "codemirror-token", name, value, token };
		},
		is(value: unknown): boolean {
			return typeof value === "object" && value !== null && (value as { token?: symbol }).token === token;
		},
	};
}

export class Compartment {
	of(value: unknown): ExtensionRecord {
		return { kind: "codemirror-compartment", name: "of", value };
	}

	reconfigure(value: unknown): ExtensionRecord {
		return { kind: "codemirror-compartment", name: "reconfigure", value };
	}
}

export const Annotation = {
	define(): ReturnType<typeof definedToken> {
		return definedToken("Annotation");
	},
};

export const Facet = {
	define(config?: unknown): {
		config?: unknown;
		of(value: unknown): ExtensionRecord;
		compute(deps: unknown, get: unknown): ExtensionRecord;
		from(field: unknown, get?: unknown): ExtensionRecord;
	} {
		return {
			config,
			of(value: unknown): ExtensionRecord {
				return { kind: "codemirror-facet", name: "of", value };
			},
			compute(deps: unknown, get: unknown): ExtensionRecord {
				return { kind: "codemirror-facet", name: "compute", value: { deps, get } };
			},
			from(field: unknown, get?: unknown): ExtensionRecord {
				return { kind: "codemirror-facet", name: "from", value: { field, get } };
			},
		};
	},
};

export const StateEffect = {
	define(): ReturnType<typeof definedToken> {
		return definedToken("StateEffect");
	},
};

export const StateField = {
	define(spec: unknown): ExtensionRecord {
		return { kind: "codemirror-state-field", name: "define", value: spec };
	},
};

export const EditorSelection = {
	cursor(pos: number, assoc = 0): { anchor: number; head: number; assoc: number } {
		return { anchor: pos, head: pos, assoc };
	},
	range(anchor: number, head: number): { anchor: number; head: number } {
		return { anchor, head };
	},
};

export const EditorState = {
	transactionFilter: extensionPoint("EditorState.transactionFilter"),
	transactionExtender: extensionPoint("EditorState.transactionExtender"),
	readOnly: extensionPoint("EditorState.readOnly"),
};

export const Transaction = {
	userEvent: Symbol("kaos-headless-cm:Transaction.userEvent"),
	addToHistory: Symbol("kaos-headless-cm:Transaction.addToHistory"),
};

export const RangeSet = {
	empty: Object.freeze({ kind: "codemirror-rangeset", name: "empty" }),
	of(value: unknown): ExtensionRecord {
		return { kind: "codemirror-rangeset", name: "of", value };
	},
};

export class RangeSetBuilder {
	private readonly values: unknown[] = [];

	add(from: number, to: number, value: unknown): void {
		this.values.push({ from, to, value });
	}

	finish(): unknown[] {
		return [...this.values];
	}
}

export const Prec = {
	highest<T>(value: T): T { return value; },
	high<T>(value: T): T { return value; },
	default<T>(value: T): T { return value; },
	low<T>(value: T): T { return value; },
	lowest<T>(value: T): T { return value; },
};

export class Text {
	static of(lines: string[]): string {
		return lines.join("\n");
	}
}

export type Extension = unknown;
export type TransactionSpec = unknown;
