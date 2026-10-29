#!/usr/bin/env node
// Browser rendering/interaction fixture using real recovery views and an Obsidian API shim.
// This is intentionally manual: it requires Playwright Chromium, not a live vault.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = resolve(process.env.KAOS_RECOVERY_UI_ARTIFACTS ?? "/tmp/kaos-recovery-ui");
await mkdir(artifacts, { recursive: true });
const shim = join(artifacts, "obsidian-shim.ts");
await writeFile(shim, `
export class App {}
export class TFile {}
export class TFolder {}
export class MarkdownView {}
export const Platform = { isMobile: false, isPhone: false, isTablet: false };
export const normalizePath = (path) => path;
export class Notice { constructor(message) { window.notices.push(message); } }
export class ItemView { constructor(leaf) { this.app = leaf.app; this.contentEl = document.createElement('div'); } }
export class Modal {
 constructor(app) { this.app=app; this.modalEl=document.createElement('div'); this.modalEl.className='modal'; this.contentEl=this.modalEl.createDiv({cls:'modal-content'}); }
 open() { document.body.append(this.modalEl); this.onOpen?.(); window.lastModal=this; }
 close() { this.onClose?.(); this.modalEl.remove(); }
}
`);
const script = await build({
	stdin: { contents: `
import { KaosDashboardView } from './src/dashboard/KaosDashboardView';
import { FullVaultRestoreConfirmModal } from './src/snapshots/fullRestoreModal';
window.notices=[];
HTMLElement.prototype.empty=function(){this.replaceChildren()};
HTMLElement.prototype.addClass=function(cls){this.classList.add(cls)};
HTMLElement.prototype.removeClass=function(cls){this.classList.remove(cls)};
HTMLElement.prototype.createEl=function(tag,opts={}) {const el=document.createElement(tag); if(opts.text)el.textContent=opts.text;if(opts.cls)el.className=opts.cls;for(const name of ['type','placeholder','href'])if(opts[name])el.setAttribute(name,opts[name]);this.append(el);return el;};
HTMLElement.prototype.createDiv=function(opts={}){return this.createEl('div',opts)};
window.applied=[];
window.openReview=async(base=true)=>{
 document.querySelectorAll('.modal').forEach(el=>el.remove());
 const app={vault:{}};
 const view=new KaosDashboardView({app},{collectData:async()=>({}),getBaselineText:()=>base?'# Note\\nshared base\\n':null,
 getMarkdownConflictReviewSides:async()=>({path:'notes/review.md',localText:'# Note\\nlocal work\\n',remoteText:'# Note\\nremote work\\n',baseHash:base?'baseline':null}),
 actions:{resolveMarkdownConflictAttention:async(target,choice)=>{window.applied.push(choice);return{status:'completed'}}}});
 view.render=()=>{};view.refresh=async()=>{};
 await view.openMarkdownConflictReview('notes/review.md',{kind:'markdown-conflict',fileKind:'markdown',reason:'three-way-preserve-failed',episodeId:'browser-review'});
};
window.openFull=()=>{
 document.querySelectorAll('.modal').forEach(el=>el.remove());
 const diff={contentChanged:[],deletedSinceSnapshot:[],createdSinceSnapshot:Array.from({length:51},(_,i)=>'created-'+i+'.md'),unchanged:[],blobsChanged:[],blobsDeletedSinceSnapshot:[],blobsCreatedSinceSnapshot:['created.png']};
 new FullVaultRestoreConfirmModal({},diff,()=>window.applied.push('full')).open();
};
`, resolveDir: root, loader: "ts" },
	bundle: true, write: false, format: "iife", platform: "browser",
	alias: { obsidian: shim },
});
const css = await readFile(join(root, "styles.css"), "utf8");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
	for (const [name, width, height] of [["desktop", 1280, 960], ["mobile", 390, 844]]) {
		const page = await browser.newPage({ viewport: { width, height } });
		const errors = []; page.on("pageerror", error => errors.push(error.message));
		await page.setContent(`<html><head><style>
:root{--text-normal:#202020;--text-muted:#555;--background-primary:#fff;--background-secondary:#f4f4f4;--background-modifier-border:#ccc;--text-accent:#2954bd;--interactive-accent:#2954bd;--color-red:#ac2934;--color-green:#26714a;--font-text:system-ui;--font-monospace:monospace;--font-ui-small:13px;--font-ui-smaller:12px}
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#e8e8e8;color:#202020}.modal{margin:16px auto;background:#fff;padding:20px;width:760px;max-width:calc(100vw - 24px);border-radius:8px}.modal-content{max-height:calc(100vh - 80px);overflow:auto}button{padding:8px 12px;margin:4px;border:1px solid #aaa;border-radius:4px;background:#f5f5f5;cursor:pointer}button.mod-cta{background:#2954bd;color:white}button:disabled{opacity:.45;cursor:default}textarea{width:100%;font:13px monospace;padding:10px}input{padding:8px}
${css}</style></head><body></body></html>`);
		await page.addScriptTag({ content: script.outputFiles[0].text });
		await page.evaluate(() => window.openReview(true));
		assert.equal(await page.getByText("Local (disk)", { exact: true }).count() >= 1, true);
		assert.equal(await page.getByText("Remote (sync)", { exact: true }).count() >= 1, true);
		await page.screenshot({ path: join(artifacts, `${name}-conflict.png`), fullPage: true });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal page overflow`);
		await page.getByRole("button", { name: "Use both", exact: true }).click();
		const merged = await page.locator(".kaos-conflict-merge-preview-text").inputValue();
		assert(merged.includes("local work") && merged.includes("remote work"));
		await page.getByRole("button", { name: "Apply merged", exact: true }).click();
		assert.equal(await page.getByText("Apply the merged result to this note?", { exact: true }).count(), 1);
		await page.locator(".modal").last().getByRole("button", { name: "Apply merged", exact: true }).click();
		await page.waitForFunction(() => window.applied.length === 1);
		await page.evaluate(() => window.openReview(false));
		assert.equal(await page.getByRole("heading", { name: "Manual merge", exact: true }).count(), 1);
		await page.evaluate(() => window.openFull());
		const button = page.getByRole("button", { name: "Restore entire vault", exact: true });
		assert(await button.isDisabled());
		await page.getByRole("textbox", { name: "Type restore to confirm" }).fill("restore");
		assert(await button.isEnabled());
		await page.screenshot({ path: join(artifacts, `${name}-full-restore.png`), fullPage: true });
		await button.click(); await page.waitForFunction(() => window.applied.includes("full"));
		assert.deepEqual(errors, []);
		console.log(`PASS ${name}: content review, merged apply, two-way fallback, typed confirmation; artifacts ${artifacts}`);
		await page.close();
	}
} finally { await browser.close(); }
