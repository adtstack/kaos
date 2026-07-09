export interface HeadlessRequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export async function requestUrl(input: HeadlessRequestUrlParam | string): Promise<{
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}> {
	const request = typeof input === "string" ? { url: input } : input;
	const headers = new Headers(request.headers ?? {});
	if (request.contentType && !headers.has("Content-Type")) {
		headers.set("Content-Type", request.contentType);
	}
	const res = await fetch(request.url, {
		method: request.method ?? "GET",
		headers,
		body: request.body as BodyInit | undefined,
	});
	const arrayBuffer = await res.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	return { status: res.status, text, json, arrayBuffer };
}

