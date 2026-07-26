export function normalizeEditorText(content: string): string {
	const withoutBom = content.charCodeAt(0) === 0xfeff
		? content.slice(1)
		: content;
	return withoutBom.replace(/\r\n?/g, "\n");
}
