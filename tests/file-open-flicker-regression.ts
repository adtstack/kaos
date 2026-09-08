import * as Y from "yjs";
import { normalizeEditorText } from "../src/utils/editorTextNormalization";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

console.log("\n--- Test 1: normalizeEditorText handles CRLF, CR, and BOM ---");
{
	const crlf = "Line 1\r\nLine 2\r\nLine 3";
	const lf = "Line 1\nLine 2\nLine 3";
	const bom = "\ufeffLine 1\nLine 2\nLine 3";
	const cr = "Line 1\rLine 2\rLine 3";

	assert(normalizeEditorText(crlf) === lf, "CRLF normalized to LF");
	assert(normalizeEditorText(bom) === lf, "BOM stripped");
	assert(normalizeEditorText(cr) === lf, "CR normalized to LF");
	assert(normalizeEditorText(lf) === lf, "LF preserved as LF");
}

console.log("\n--- Test 2: editorBinding normalization logic ---");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "Hello\nWorld");

	const crdtContent = ytext.toJSON();
	const editorWithCrlf = "Hello\r\nWorld";
	const editorWithLf = "Hello\nWorld";
	const editorDiverged = "Hello\nDifferent World";

	const isNormalizedEqualCrlf =
		editorWithCrlf === crdtContent ||
		normalizeEditorText(editorWithCrlf) === normalizeEditorText(crdtContent);
	assert(isNormalizedEqualCrlf, "CRLF editor content equals LF CRDT after normalization");

	const isNormalizedEqualLf =
		editorWithLf === crdtContent ||
		normalizeEditorText(editorWithLf) === normalizeEditorText(crdtContent);
	assert(isNormalizedEqualLf, "LF editor content equals LF CRDT");

	const isNormalizedEqualDiverged =
		editorDiverged === crdtContent ||
		normalizeEditorText(editorDiverged) === normalizeEditorText(crdtContent);
	assert(!isNormalizedEqualDiverged, "Truly diverged content correctly fails normalization check");
}

console.log("\n--- Test 3: diskMirror unchanged check logic ---");
{
	const diskContentCrlf = "Heading\r\nParagraph 1\r\n";
	const crdtContentLf = "Heading\nParagraph 1\n";

	const isUnchanged =
		diskContentCrlf === crdtContentLf ||
		normalizeEditorText(diskContentCrlf) === normalizeEditorText(crdtContentLf);
	assert(isUnchanged, "diskMirror treats CRLF vs LF as unchanged, skipping vault.modify");

	const hasMismatch =
		diskContentCrlf !== crdtContentLf &&
		normalizeEditorText(diskContentCrlf) !== normalizeEditorText(crdtContentLf);
	assert(!hasMismatch, "hasOpenEditorContentMismatch returns false when normalized equal");
}

console.log("\n--- Test 4: reconciliation open-editor authority normalization ---");
{
	const authorityContent = "Title\r\nContent\r\n";
	const diskContent = "Title\nContent\n";
	const crdtContent = "Title\nContent\n";

	const authorityMatchesDisk =
		authorityContent === diskContent ||
		normalizeEditorText(authorityContent) === normalizeEditorText(diskContent);
	assert(authorityMatchesDisk, "authority matches disk across line endings");

	const authorityMatchesCrdt =
		authorityContent === crdtContent ||
		normalizeEditorText(authorityContent) === normalizeEditorText(crdtContent);
	assert(authorityMatchesCrdt, "authority matches CRDT across line endings");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────\n");

if (failed > 0) {
	process.exit(1);
}
