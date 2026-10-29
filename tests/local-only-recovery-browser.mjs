#!/usr/bin/env node
// Real CodeMirror ViewPlugins and Yjs cycles; no live Obsidian vault needed.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = "/tmp/kaos-local-only-browser";
await mkdir(artifacts, { recursive: true });
const shim = join(artifacts, "obsidian.ts");
await writeFile(shim, `export class Notice { constructor(message) { window.notices.push(message); } }
export class MarkdownView {} export class TFile {} export const normalizePath = p=>p;
export const Platform = { isMobile:false, isPhone:false, isTablet:false };`);
const result = await build({ stdin: { resolveDir: root, loader: "ts", contents: `
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { EditorBindingManager } from './src/sync/editorBinding';
import { RemoteTextRevisionTracker } from './src/sync/remoteTextRevisionTracker';
import { localOnlyRecoveryBlockReason } from './src/sync/localOnlyRecoveryEvidence';
import { MarkdownView, TFile } from 'obsidian';
import { ReconciliationController } from './src/runtime/reconciliationController';
window.notices=[];
const tick = () => new Promise(resolve => queueMicrotask(resolve));
window.run = async () => {
 const doc = new Y.Doc(); const texts = doc.getMap('idToText');
 const awareness = new Awareness(doc); const provider = { awareness };
 const tracker = new RemoteTextRevisionTracker(doc, texts, () => provider, () => null);
 doc.transact(() => texts.set('a', new Y.Text('BASE')), 'vault-crdt-seed');
 const text = texts.get('a'); const revision=()=>tracker.get(text,'a');
 const vaultSync = { provider, remoteTextRevisions: tracker,
  getRemoteTextRevisionForPath: ()=>revision(), getTextForPath:()=>text,
  getFileIdForText:()=> 'a', getFileId:()=> 'a', getPendingRenameOldPathForTarget:()=>undefined };
 const traces=[];
 const manager = new EditorBindingManager(vaultSync, false, ()=>true, (source,msg,details)=>traces.push({source,msg,details}), undefined, undefined, ()=>false);
 const view = new MarkdownView(); view.file=new TFile();view.file.path='a.md';view.leaf={id:'leaf-a'};
 view.containerEl=document.createElement('div');document.body.append(view.containerEl);
 const cm = new EditorView({ state: EditorState.create({doc:'BASE',extensions:[manager.getBaseExtension()]}), parent:view.containerEl });
 view.editor={ getValue:()=>cm.state.doc.toString(), setValue:value=>cm.dispatch({changes:{from:0,to:cm.state.doc.length,insert:value}}) };
 const applied = manager.applyBinding({action:'bind',deviceName:'browser',view,cm,cmId:'cm-a',leafId:'leaf-a',filePath:'a.md',ytext:text,fileId:'a'});
 if (!applied) throw new Error('Real binding fixture failed: '+JSON.stringify(traces));
 await tick();
 const view2 = new MarkdownView();view2.file=view.file;view2.leaf={id:'leaf-b'};
 view2.containerEl=document.createElement('div');document.body.append(view2.containerEl);
 const cm2 = new EditorView({state:EditorState.create({doc:'BASE',extensions:[manager.getBaseExtension()]}),parent:view2.containerEl});
 view2.editor={getValue:()=>cm2.state.doc.toString()};
 if (!manager.applyBinding({action:'bind',deviceName:'browser',view:view2,cm:cm2,cmId:'cm-b',leafId:'leaf-b',filePath:'a.md',ytext:text,fileId:'a'})) throw new Error('second pane binding failed');
 await tick();
 const evidence2=()=>manager.getLocalOnlyRecoveryEvidenceForView(view2);
 const evidence=()=>manager.getLocalOnlyRecoveryEvidenceForView(view);
 const initial=evidence(); if (!initial) throw new Error('Initial finalized checkpoint missing');
 // Real remote projection: revision must already be visible while CM updates.
 let observedRevision=0;
 text.observe(()=>{if (observedRevision===0) observedRevision=revision().remoteRevision});
 doc.transact(()=>text.insert(text.length,'-REMOTE'),provider);
 await tick();
 const reflected=evidence();
 const remoteAck=reflected?.remoteRevision===revision().remoteRevision;
 const remoteText=cm.state.doc.toString();
 // Programmatic default-origin edit and user edit push through actual ySync.
 cm.dispatch({changes:{from:cm.state.doc.length,insert:'-API'}}); await tick();
 const apiText=text.toString(), apiCheckpoint=!!evidence();
 cm.dispatch({changes:{from:cm.state.doc.length,insert:'-USER'},annotations:Transaction.userEvent.of('input')});await tick();
 const userText=text.toString();
 // Undo/redo travel through the real Y.UndoManager and per-text observers.
 const undo=manager.bindings.get('leaf-a').undoManager;
 undo.undo();await tick();const undoRetainsRemote=text.toString().includes('-REMOTE');
 undo.redo();await tick();const redoCheckpoint=!!evidence();
 // Pause only the harness push path while keeping base evidence observation:
 // a proven local successor should be admitted in this SAME binding epoch.
 cm.dispatch({effects:manager.compartment.reconfigure([])});
 cm2.dispatch({effects:manager.compartment.reconfigure([])});await tick();
 const before=cm.state.doc.toString();
 cm.dispatch({changes:{from:cm.state.doc.length,insert:'-LAG'},annotations:Transaction.userEvent.of('input')});await tick();
 cm2.dispatch({changes:{from:cm2.state.doc.length,insert:'-LAG'},annotations:Transaction.userEvent.of('input')});await tick();
 const normalLag=localOnlyRecoveryBlockReason(revision(),[evidence(),evidence2()],[cm.state.doc.toString(),cm2.state.doc.toString()]);
 const independentPanes=evidence()?.identity!==evidence2()?.identity;
 const controller = new ReconciliationController({
  app:{vault:{getAbstractFileByPath:()=>view.file},workspace:{iterateAllLeaves:visit=>{visit({view});visit({view:view2})}}},
  getVaultSync:()=>vaultSync,getEditorBindings:()=>manager,getDiskMirror:()=>null,getDiskIndex:()=>({}),
  getRuntimeConfig:()=>({automaticRecoveryMode:'guarded'}),getSettings:()=>({deviceName:'browser'}),
  trace:()=>{},refreshStatusBar:()=>{},log:()=>{},
 });
 const actualAdmission=controller.admitAutomaticRecovery('a.md',text,cm.state.doc.toString());
 manager.unbind(view2,true);await tick();
 const missingPane=localOnlyRecoveryBlockReason(revision(),[evidence(),evidence2()],[cm.state.doc.toString(),cm2.state.doc.toString()]);
 const actualMissingPaneBlocked=!controller.admitAutomaticRecovery('a.md',text,cm.state.doc.toString());
 const bindingIdentity=initial.identity===evidence()?.identity;
 // Subsequent remote receive cannot be acknowledged while projection is absent.
 doc.transact(()=>text.insert(text.length,'-NEW-REMOTE'),provider);await tick();
 const staleBlocked=localOnlyRecoveryBlockReason(revision(),[evidence()],[cm.state.doc.toString()]);
 // Unknown full reload must invalidate, even if labelled non-user local.
 cm.dispatch({changes:{from:0,to:cm.state.doc.length,insert:'BASE'},filter:false});await tick();
 const reloadEvidence=evidence();
 // Actual composition DOM events invalidate partial admission without changing
 // the user's edit or the existing composition synchronization implementation.
 cm.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
 cm.dispatch({changes:{from:cm.state.doc.length,insert:'-IME'},annotations:Transaction.userEvent.of('input')});await tick();
 const partialComposition=evidence();
 cm.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
 controller.reset();manager.unbindAll();cm.destroy();cm2.destroy();awareness.destroy();tracker.destroy();doc.destroy();
 return {observedRevision,remoteAck,remoteText,apiText,apiCheckpoint,userText,before,normalLag,bindingIdentity,independentPanes,actualAdmission,actualMissingPaneBlocked,missingPane,undoRetainsRemote,redoCheckpoint,partialComposition,staleBlocked,reloadEvidence};
};
` }, bundle:true, write:false, format:"iife", platform:"browser", define:{__KAOS_QA_HARNESS_ENABLED__:"false"}, alias:{obsidian:shim, yjs:resolve(root,"node_modules/yjs/dist/yjs.mjs")} });
let browser;
try {
	browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
} catch (err) {
	if (String(err?.message ?? err).includes("Executable doesn't exist") || String(err?.message ?? err).includes("Please run the following command")) {
		console.log("  SKIPPED: Playwright browser executable not installed in this environment");
		process.exit(0);
	}
	throw err;
}
try {
 const page=await browser.newPage(); const errors=[];
 page.on("pageerror", error=>errors.push(error.message));
 await page.setContent("<html><body></body></html>");
 await page.addScriptTag({content:result.outputFiles[0].text});
 const observed=await page.evaluate(()=>window.run());
 await writeFile(join(artifacts,"result.json"),JSON.stringify(observed,null,2));
 assert.equal(observed.remoteAck,true); assert.equal(observed.observedRevision,1);
 assert.equal(observed.remoteText,"BASE-REMOTE");
 assert.equal(observed.apiText,"BASE-REMOTE-API"); assert.equal(observed.apiCheckpoint,true);
 assert.equal(observed.userText,"BASE-REMOTE-API-USER");
 assert.equal(observed.actualAdmission,true);assert.equal(observed.actualMissingPaneBlocked,true);
 assert.equal(observed.independentPanes,true);assert.equal(observed.missingPane,"initial-authority-unverified");
 assert.equal(observed.undoRetainsRemote,true);assert.equal(observed.redoCheckpoint,true);assert.equal(observed.partialComposition,null);
 assert.equal(observed.normalLag,null); assert.equal(observed.bindingIdentity,true);
 assert.equal(observed.staleBlocked,"remote-not-acknowledged"); assert.equal(observed.reloadEvidence,null);
 assert.deepEqual(errors,[]);
 await writeFile(join(artifacts,"result.json"),JSON.stringify(observed,null,2));
 console.log("PASS actual EditorView + ViewPlugin + Yjs ordering, local API/user lag, stale remote and reload; artifacts "+artifacts);
} finally { if (browser) await browser.close(); }
