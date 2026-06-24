const SUPPRESS_MS = 500;
const encoder = new TextEncoder();

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

async function fingerprintContent(content) {
	const bytes = encoder.encode(content);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return {
		bytes: bytes.length,
		hash: Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(""),
	};
}

class DiskMirrorHarness {
	constructor(store) {
		this.store = store;
		this.suppressedPaths = new Map();
		this.pathWriteLocks = new Map();
		this.ytexts = new Map();
	}

	setYText(path, value) {
		this.ytexts.set(path, value);
	}

	isSuppressed(path) {
		return this.getActiveSuppression(path) !== null;
	}

	suppressDelete(path) {
		this.suppressedPaths.set(path, {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
		});
	}

	async shouldSuppressModify(file) {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file) {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	async flushWrite(path) {
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path));
	}

	async flushWriteUnlocked(path) {
		const content = this.ytexts.get(path);
		if (typeof content !== "string") return;

		const existing = this.store.get(path);
		if (existing) {
			const currentContent = await this.store.read(path);
			if (currentContent === content) return;
			await this.suppressWrite(path, content);
			await this.store.modify(path, content);
			return;
		}

		await this.suppressWrite(path, content);
		await this.store.create(path, content);
	}

	getActiveSuppression(path) {
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) return entry;
		this.suppressedPaths.delete(path);
		return null;
	}

	async suppressWrite(path, content) {
		const fingerprint = await fingerprintContent(content);
		this.suppressedPaths.set(path, {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
	}

	async shouldSuppressWriteEvent(file, event) {
		const entry = this.getActiveSuppression(file.path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(file.path);
			return false;
		}

		if (
			typeof file.stat?.size === "number"
			&& typeof entry.expectedBytes === "number"
			&& file.stat.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(file.path);
			return false;
		}

		try {
			const content = await this.store.read(file.path);
			const fingerprint = await fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				this.suppressedPaths.delete(file.path);
				return true;
			}
		} catch {
			// Fall through to normal sync handling.
		}

		this.suppressedPaths.delete(file.path);
		return false;
	}

	runPathWriteLocked(path, work) {
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked;
		tracked = next.finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return tracked;
	}
}

function makeStore() {
	const files = new Map();
	const readFailures = new Set();
	let activeWrites = 0;
	let maxConcurrentWrites = 0;
	let modifyHook = null;

	function update(path, content) {
		const record = files.get(path) ?? {
			path,
			stat: { size: 0, mtime: Date.now() },
			content: "",
		};
		record.content = content;
		record.stat.size = encoder.encode(content).length;
		record.stat.mtime = Date.now();
		files.set(path, record);
		return record;
	}

	return {
		get(path) {
			return files.get(path) ?? null;
		},
		update,
		async read(path) {
			if (readFailures.delete(path)) {
				throw new Error(`Injected read failure for ${path}`);
			}
			const record = files.get(path);
			if (!record) {
				throw new Error(`Missing file: ${path}`);
			}
			return record.content;
		},
		async modify(path, content) {
			activeWrites++;
			maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
			try {
				if (modifyHook) {
					await modifyHook(path, content);
				}
				update(path, content);
			} finally {
				activeWrites--;
			}
		},
		async create(path, content) {
			update(path, content);
		},
		failNextRead(path) {
			readFailures.add(path);
		},
		setModifyHook(fn) {
			modifyHook = fn;
		},
		getMaxConcurrentWrites() {
			return maxConcurrentWrites;
		},
	};
}

console.log("\n--- Test A: external modify inside suppression window with different content ---");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-a.md";
	mirror.setYText(path, "ours");
	store.update(path, "before");

	await mirror.flushWrite(path);
	store.update(path, "external write");

	const suppressed = await mirror.shouldSuppressModify(store.get(path));
	assert(!suppressed, "different external content is not suppressed");
	assert(!mirror.isSuppressed(path), "suppression entry clears after mismatch");
}

console.log("\n--- Test B: queued + direct flushWrite on the same path serialize ---");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-b.md";
	mirror.setYText(path, "first");
	store.update(path, "seed");

	let firstWriteStarted;
	const firstWriteSeen = new Promise((resolve) => {
		firstWriteStarted = resolve;
	});
	let releaseFirstWrite;
	const firstWriteGate = new Promise((resolve) => {
		releaseFirstWrite = resolve;
	});

	store.setModifyHook(async (_path, content) => {
		if (content === "first") {
			firstWriteStarted();
			await firstWriteGate;
		}
	});

	const queuedWrite = mirror.runPathWriteLocked(path, () => mirror.flushWriteUnlocked(path));
	await firstWriteSeen;

	mirror.setYText(path, "second");
	const directWrite = mirror.flushWrite(path);

	releaseFirstWrite();
	await Promise.all([queuedWrite, directWrite]);

	assert(
		store.getMaxConcurrentWrites() === 1,
		"same-path writes never overlap",
	);
	assert(
		store.get(path)?.content === "second",
		"final content reflects the later write deterministically",
	);
}

console.log("\n--- Test C: delete suppression does not eat a rapid recreate ---");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-c.md";
	store.update(path, "recreated");

	mirror.suppressDelete(path);
	const suppressed = await mirror.shouldSuppressCreate(store.get(path));

	assert(!suppressed, "create after delete is not suppressed as a delete");
	assert(!mirror.isSuppressed(path), "delete suppression clears after recreate mismatch");
}

console.log("\n--- Test D: suppressed write falls through safely when file read fails ---");
{
	const store = makeStore();
	const mirror = new DiskMirrorHarness(store);
	const path = "note-d.md";
	mirror.setYText(path, "ours");
	store.update(path, "before");

	await mirror.flushWrite(path);
	store.failNextRead(path);

	const suppressed = await mirror.shouldSuppressModify(store.get(path));
	assert(!suppressed, "read failure does not suppress the event");
	assert(!mirror.isSuppressed(path), "suppression entry clears after read failure");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
