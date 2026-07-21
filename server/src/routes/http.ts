const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, OPTIONS";
const CORS_EXPOSE_HEADERS = "X-KAOS-Snapshot-Day";

export interface HtmlResponseOptions {
	scriptNonce?: string;
}

export function createCspNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function htmlContentSecurityPolicy(scriptNonce?: string): string {
	if (scriptNonce !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(scriptNonce)) {
		throw new Error("invalid CSP nonce");
	}
	const scriptSource = scriptNonce ? `'nonce-${scriptNonce}'` : "'none'";
	return [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		`script-src ${scriptSource}`,
		"style-src 'unsafe-inline'",
		"img-src 'self' data:",
		"connect-src 'self'",
		"font-src 'none'",
		"object-src 'none'",
		"worker-src 'none'",
	].join("; ");
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
	headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);

	const responseWithSocket = response as { webSocket?: WebSocket };
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		webSocket: responseWithSocket.webSocket,
	});
}

export function corsPreflight(): Response {
	return withCors(new Response(null, { status: 204 }));
}

export function html(body: string, status = 200, options: HtmlResponseOptions = {}): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": htmlContentSecurityPolicy(options.scriptNonce),
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
		},
	});
}
