import { webcrypto } from "node:crypto";
import { indexedDB as fakeIndexedDB, IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";
import NodeWebSocket from "ws";
import { createHeadlessElement } from "./core/dom";

type Listener = (...args: any[]) => void;

export function installHeadlessHostPolyfills(): void {
	const listeners = new Map<string, Set<Listener>>();
	const addEventListener = (type: string, listener: Listener): void => {
		let set = listeners.get(type);
		if (!set) {
			set = new Set();
			listeners.set(type, set);
		}
		set.add(listener);
	};
	const removeEventListener = (type: string, listener: Listener): void => {
		listeners.get(type)?.delete(listener);
	};
	const dispatchEvent = (event: { type?: string }): boolean => {
		const type = event.type;
		if (!type) return true;
		for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
		return true;
	};

	const win = globalThis as any;
	if (!win.window) win.window = win;
	win.window.addEventListener ??= addEventListener;
	win.window.removeEventListener ??= removeEventListener;
	win.window.dispatchEvent ??= dispatchEvent;
	win.window.open ??= () => null;
	win.window.setInterval ??= setInterval;
	win.window.clearInterval ??= clearInterval;
	win.window.setTimeout ??= setTimeout;
	win.window.clearTimeout ??= clearTimeout;

	if (!win.document) {
		const body = createHeadlessElement("body");
		win.document = {
			body,
			activeElement: null,
			visibilityState: "visible",
			addEventListener,
			removeEventListener,
			dispatchEvent,
			hasFocus: () => true,
			createElement: (tag: string) => createHeadlessElement(tag),
			createDiv: (...args: any[]) => body.createDiv(...args),
			createSpan: (...args: any[]) => body.createSpan(...args),
			createDocumentFragment: () => createHeadlessElement("fragment"),
		};
	}

	win.navigator ??= {};
	win.navigator.onLine ??= true;
	win.navigator.clipboard ??= {
		writeText: async () => undefined,
	};

	win.requestAnimationFrame ??= (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as any;
	win.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
	win.crypto ??= webcrypto;
	win.indexedDB ??= fakeIndexedDB;
	win.IDBKeyRange ??= FakeIDBKeyRange;
	win.WebSocket ??= NodeWebSocket;
}
