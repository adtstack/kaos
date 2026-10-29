import * as Y from "yjs";
import { normalizeEditorText } from "../utils/editorTextNormalization";
import { isLocalStringOrigin } from "./origins";

export type TextChangeSource = "provider" | "persistence" | "editor" | "repair" | "unknown";

/** A runtime-only identity. No wall clock or persisted revision can grant authority. */
export interface RemoteTextRevision {
	readonly scope: object;
	readonly fileId: string;
	readonly text: Y.Text;
	readonly textRevision: number;
	readonly remoteRevision: number;
	readonly authorityRevision: number;
	readonly source: TextChangeSource;
}

/** Installed before hydration; runs before any per-text projection observer. */
export class RemoteTextRevisionTracker {
	private readonly normalizedContents = new WeakMap<RemoteTextRevision, string>();
	private readonly states = new WeakMap<Y.Text, RemoteTextRevision>();
	private readonly active = new Map<string, Y.Text>();
	private readonly reverse = new WeakMap<Y.Text, string>();
	private readonly editorOrigins = new WeakSet<object>();
	private readonly lastRemoteAdvancedAt = new WeakMap<Y.Text, number>();
	private readonly listeners = new Set<(text: Y.Text) => void>();
	private readonly seen = new WeakSet<Y.Transaction>();
	private destroyed = false;

	constructor(
		private readonly doc: Y.Doc,
		private readonly texts: Y.Map<Y.Text>,
		private readonly provider: () => unknown,
		private readonly persistence: () => unknown,
	) {
		for (const [id, text] of texts) { this.active.set(id, text); this.reverse.set(text, id); }
		doc.on("beforeObserverCalls", this.beforeObservers);
	}

	getNormalizedContent(revision: RemoteTextRevision): string | null {
		if (this.destroyed || this.states.get(revision.text) !== revision) return null;
		let content = this.normalizedContents.get(revision);
		if (content === undefined) {
			content = normalizeEditorText(revision.text.toJSON());
			this.normalizedContents.set(revision, content);
		}
		return content;
	}

	getFileId(text: Y.Text): string | null {
		const id = this.reverse.get(text);
		return id !== undefined && this.texts.get(id) === text ? id : null;
	}

	registerEditorOrigin(origin: object): void {
		this.editorOrigins.add(origin);
	}

	getLastRemoteAdvancedAt(text: Y.Text): number {
		return this.lastRemoteAdvancedAt.get(text) ?? 0;
	}

	subscribe(listener: (text: Y.Text) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	get(text: Y.Text, fileId: string): RemoteTextRevision | null {
		if (this.destroyed || this.texts.get(fileId) !== text) return null;
		this.reverse.set(text, fileId);
		let state = this.states.get(text);
		if (!state || state.fileId !== fileId) {
			state = Object.freeze({ scope: {}, fileId, text, textRevision: 0,
				remoteRevision: 0, authorityRevision: 0, source: "unknown" as const });
			this.states.set(text, state);
		}
		return state;
	}

	private classify(origin: unknown): TextChangeSource {
		if (this.provider() != null && origin === this.provider()) return "provider";
		if (this.persistence() != null && origin === this.persistence()) return "persistence";
		if (typeof origin === "object" && origin !== null && this.editorOrigins.has(origin)) return "editor";
		if (typeof origin === "string" && isLocalStringOrigin(origin)) return "repair";
		return "unknown";
	}

	private readonly beforeObservers = (transaction: Y.Transaction): void => {
		if (this.destroyed || this.seen.has(transaction)) return;
		this.seen.add(transaction);
		const changed = new Set<Y.Text>();
		for (const type of transaction.changed.keys()) {
			if (type instanceof Y.Text) changed.add(type);
		}
		// Newly integrated nested texts need not appear in transaction.changed.
		const mapChanges = transaction.changed.get(this.texts);
		if (mapChanges) {
			for (const key of mapChanges) {
				if (key === null) continue;
				const text = this.texts.get(key);
				const previous = this.active.get(key);
				if (previous && previous !== text) {
					this.states.delete(previous);
					this.active.delete(key);
					for (const listener of this.listeners) listener(previous);
				}
				if (text instanceof Y.Text) {
					this.reverse.set(text, key);
					this.active.set(key, text);
					changed.add(text);
				}
			}
		}
		let fallback: Map<Y.Text, string> | null = null;
		const source = this.classify(transaction.origin);
		for (const text of changed) {
			let id = this.reverse.get(text);
			if (id === undefined || this.texts.get(id) !== text) {
				if (!fallback) {
					fallback = new Map();
					for (const [key, value] of this.texts) {
						this.reverse.set(value, key);
						fallback.set(value, key);
					}
				}
				id = fallback.get(text);
			}
			if (id === undefined) continue;
			const previous = this.get(text, id);
			if (!previous) continue;
			if (source === "provider") {
				this.lastRemoteAdvancedAt.set(text, Date.now());
			}
			this.states.set(text, Object.freeze({ ...previous,
				textRevision: previous.textRevision + 1,
				remoteRevision: previous.remoteRevision + (source === "provider" ? 1 : 0),
				authorityRevision: previous.authorityRevision + (source === "editor" ? 0 : 1),
				source,
			}));
			for (const listener of this.listeners) listener(text);
		}
	};

	destroy(): void {
		this.destroyed = true;
		this.doc.off("beforeObserverCalls", this.beforeObservers);
		this.listeners.clear();
		this.active.clear();
	}
}
