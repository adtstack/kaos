const CLAIMED_KEY = "claimed";
const TOKEN_HASH_KEY = "tokenHash";
const UPDATE_PROVIDER_KEY = "updateProvider";
const UPDATE_REPO_URL_KEY = "updateRepoUrl";
const UPDATE_REPO_BRANCH_KEY = "updateRepoBranch";

type UpdateProvider = "github" | "gitlab" | "unknown";

export interface StoredServerConfig {
	claimed: boolean;
	tokenHash: string | null;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function normalizeUpdateProvider(value: unknown): UpdateProvider | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateProvider");
	}
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "github" || raw === "gitlab" || raw === "unknown") {
		return raw;
	}
	throw new Error("invalid updateProvider");
}

function normalizeUpdateRepoUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateRepoUrl");
	}
	const raw = value.trim();
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("invalid updateRepoUrl");
	}
	const pathParts = parsed.pathname.split("/").filter(Boolean);
	if (pathParts.length < 2) {
		throw new Error("invalid updateRepoUrl");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeUpdateRepoBranch(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error("invalid updateRepoBranch");
	}
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > 120) {
		throw new Error("invalid updateRepoBranch");
	}
	// Keep this strict and safe for URL/query usage.
	if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) {
		throw new Error("invalid updateRepoBranch");
	}
	return raw;
}

export class ServerConfig {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/__kaos/config") {
			return json(await this.readConfig());
		}

		if (request.method === "POST" && url.pathname === "/__kaos/claim") {
			let body: { tokenHash?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (typeof body.tokenHash !== "string" || !body.tokenHash) {
				return json({ error: "missing tokenHash" }, 400);
			}

			return await this.state.storage.transaction(async (txn) => {
				const map = await txn.get<unknown>([CLAIMED_KEY, TOKEN_HASH_KEY]);
				const claimed = map.get(CLAIMED_KEY) as boolean | undefined;
				const existingHash = map.get(TOKEN_HASH_KEY) as string | undefined;
				if (claimed === true && typeof existingHash === "string" && existingHash.length > 0) {
					return json({ error: "already_claimed" }, 403);
				}

				await txn.put({
					[CLAIMED_KEY]: true,
					[TOKEN_HASH_KEY]: body.tokenHash,
				});
				return json({ ok: true });
			});
		}

		if (request.method === "POST" && url.pathname === "/__kaos/update-metadata") {
			let body: {
				updateProvider?: unknown;
				updateRepoUrl?: unknown;
				updateRepoBranch?: unknown;
			} = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			let updateProvider: UpdateProvider | null;
			let updateRepoUrl: string | null;
			let updateRepoBranch: string | null;
			try {
				updateProvider = normalizeUpdateProvider(body.updateProvider);
				updateRepoUrl = normalizeUpdateRepoUrl(body.updateRepoUrl);
				updateRepoBranch = normalizeUpdateRepoBranch(body.updateRepoBranch);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : "invalid metadata" }, 400);
			}

			const entries: Record<string, unknown> = {};
			if (updateProvider !== null) {
				entries[UPDATE_PROVIDER_KEY] = updateProvider;
			}
			if (updateRepoUrl !== null) {
				entries[UPDATE_REPO_URL_KEY] = updateRepoUrl;
			}
			if (updateRepoBranch !== null) {
				entries[UPDATE_REPO_BRANCH_KEY] = updateRepoBranch;
			}
			if (Object.keys(entries).length > 0) {
				await this.state.storage.put(entries);
			}

			return json({ ok: true, config: await this.readConfig() });
		}

		return json({ error: "not found" }, 404);
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const map = await this.state.storage.get<unknown>([
			CLAIMED_KEY,
			TOKEN_HASH_KEY,
			UPDATE_PROVIDER_KEY,
			UPDATE_REPO_URL_KEY,
			UPDATE_REPO_BRANCH_KEY,
		]);
		const claimed = map.get(CLAIMED_KEY) as boolean | undefined;
		const tokenHash = map.get(TOKEN_HASH_KEY) as string | undefined;
		const updateProvider = map.get(UPDATE_PROVIDER_KEY) as UpdateProvider | undefined;
		const updateRepoUrl = map.get(UPDATE_REPO_URL_KEY) as string | undefined;
		const updateRepoBranch = map.get(UPDATE_REPO_BRANCH_KEY) as string | undefined;
		return {
			claimed: claimed === true && typeof tokenHash === "string" && tokenHash.length > 0,
			tokenHash: typeof tokenHash === "string" && tokenHash.length > 0 ? tokenHash : null,
			updateProvider:
				updateProvider === "github" || updateProvider === "gitlab" || updateProvider === "unknown"
					? updateProvider
					: null,
			updateRepoUrl: typeof updateRepoUrl === "string" && updateRepoUrl.length > 0 ? updateRepoUrl : null,
			updateRepoBranch:
				typeof updateRepoBranch === "string" && updateRepoBranch.length > 0 ? updateRepoBranch : null,
		};
	}
}

export default ServerConfig;
