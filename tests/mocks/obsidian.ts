/**
 * Minimal runtime mock for the "obsidian" package.
 *
 * The real obsidian package ships only TypeScript declaration files with no
 * runtime JavaScript. Tests that import code which depends on obsidian
 * (e.g. DiskMirror) need a runtime stand-in for the symbols they actually call.
 *
 * Only the symbols that DiskMirror uses at runtime are provided here.
 * Type-only imports (App, etc.) compile away and need no runtime value.
 *
 * Use via JITI_ALIAS: { "obsidian": "<path-to-this-file>" }
 */

/** Identity normalization — adequate for test paths that don't need slash fixup. */
export function normalizePath(path: string): string {
	return path;
}

/** Stub class. Passed as an argument to app.workspace.getActiveViewOfType(). */
export class MarkdownView {}

/** Stub class. Used in instanceof checks inside DiskMirror's vault event handlers. */
export class TFile {}
export class TFolder {}

/** Notice constructor used by runtime controllers. */
export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

/** Stub class. Type-only in DiskMirror but exported for completeness. */
export class App {}

/** Minimal ItemView base used by dashboard interaction tests. */
export class ItemView {
	readonly app: unknown;
	readonly contentEl = {};
	navigation = false;

	constructor(readonly leaf: { app?: unknown } = {}) {
		this.app = leaf.app;
	}

	addAction(): void {}
}

/** Stable desktop defaults; individual tests can exercise layout policy directly. */
export const Platform = {
	isMobile: false,
	isPhone: false,
	isTablet: false,
};

/** Injectable requestUrl seam for tests that exercise authenticated HTTP wiring. */
export async function requestUrl(request: unknown): Promise<unknown> {
	const handler = (globalThis as {
		__KAOS_TEST_REQUEST_URL__?: (value: unknown) => Promise<unknown> | unknown;
	}).__KAOS_TEST_REQUEST_URL__;
	if (!handler) throw new Error("requestUrl is not configured in this test");
	return await handler(request);
}

/** Stub class. ConfirmModal extends Modal — needs to exist as a constructor. */
export class Modal {
	constructor(_app?: unknown) {}
	open(): void {}
	close(): void {}
}

/** Not called in observer/scheduling paths — stub for completeness. */
export function arrayBufferToHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}
