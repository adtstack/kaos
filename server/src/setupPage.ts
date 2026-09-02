interface SetupPageOptions {
	host: string;
	deployRepo?: string;
	claimEnabled?: boolean;
	scriptNonce?: string;
}

interface RunningPageOptions {
	host: string;
	attachments: boolean;
	snapshots: boolean;
}

interface MobileSetupPageOptions {
	host: string;
	deployRepo?: string;
	scriptNonce?: string;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; box-sizing:border-box; font-family:ui-sans-serif,system-ui,sans-serif; background:#08111d; color:#f4f7fb; }
  main { width:min(560px,100%); padding:30px; border:1px solid #24374e; border-radius:18px; background:#0d1725; }
  h1 { margin:0 0 10px; font-size:25px; } p,li { color:#b6c8d9; line-height:1.55; } input { width:100%; box-sizing:border-box; padding:11px; border-radius:9px; border:1px solid #405774; background:#08111d; color:#f4f7fb; }
  button,a.cta { display:inline-block; margin-top:12px; border:0; border-radius:9px; padding:11px 16px; background:#7bdff6; color:#08111d; text-decoration:none; font-weight:700; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:not-allowed; } code { background:#08111d; padding:2px 5px; border-radius:4px; } .muted { color:#7f98b0; font-size:13px; } .status { min-height:20px; margin-top:14px; } .details { margin-top:18px; border-top:1px solid #24374e; padding-top:14px; }
`;

/**
 * Claiming deliberately produces no reusable setup credential. The random seed
 * only creates the bounded legacy migration verifier; it is never displayed.
 */
export function renderSetupPage(options: SetupPageOptions): string {
	const host = escapeHtml(options.host);
	const nonce = options.scriptNonce ? ` nonce="${escapeHtml(options.scriptNonce)}"` : "";
	const disabled = options.claimEnabled === true ? "" : " disabled";
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claim KAOS Server</title><style>${STYLE}
  .card { margin-top:16px; padding:16px; border-radius:12px; background:#08111d; border:1px solid #24374e; }
  .code-badge { font-size:22px; font-weight:800; letter-spacing:2px; color:#7bdff6; font-family:monospace; margin:8px 0; display:inline-block; }
  .secret-box { word-break:break-all; font-family:monospace; background:#040911; padding:10px; border-radius:8px; border:1px solid #1c2b3d; color:#ffd166; font-size:13px; margin:8px 0; }
  .btn-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .btn-sub { background:#24374e; color:#f4f7fb; }
</style></head><body><main>
<h1>Claim your KAOS server</h1><p>Claiming locks this server to a private vault. Devices authenticate with their own cryptographic keys.</p>
<p class="muted">Server: <code>${host}</code></p>
<div id="claim-form">
  <label>Deployment claim secret<input id="claim-secret" type="password" autocomplete="off"${disabled}></label>
  <button id="claim"${disabled}>Claim server</button>
</div>
<div id="status" class="status"></div>
<div id="complete" hidden class="details">
  <h2>Server Claimed! Connect Primary Device</h2>
  <p>Your primary device will be registered as the <strong>Owner</strong>.</p>

  <div class="card">
    <div><strong>Option 1: 1-Click Connect on this PC</strong></div>
    <a id="deep-link" class="cta" href="#">Open Obsidian as Owner</a>
  </div>

  <div class="card">
    <div><strong>Option 2: Enter Pairing Code on another PC/Mobile</strong></div>
    <div class="code-badge" id="pairing-code"></div>
    <p class="muted">In Obsidian Settings $\rightarrow$ KAOS $\rightarrow$ Paste this code. (Expires in 15 mins)</p>
  </div>

  <div class="card">
    <div><strong>Step 2: Save Backup Recovery Key (Important)</strong></div>
    <p class="muted">Keep this secret offline to recover access if all Owner devices are lost.</p>
    <div class="secret-box" id="recovery-secret"></div>
    <div class="btn-row">
      <button id="copy-recovery" class="btn-sub">Copy Recovery Secret</button>
      <button id="copy-link" class="btn-sub">Copy Deep Link</button>
    </div>
  </div>
</div>
</main><script${nonce}>
const status=document.getElementById("status"),button=document.getElementById("claim"),secret=document.getElementById("claim-secret"),form=document.getElementById("claim-form");
function randomValue(bytes){const data=new Uint8Array(bytes);crypto.getRandomValues(data);let s="";for(const b of data)s+=String.fromCharCode(b);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");}
button?.addEventListener("click",async()=>{
  if(!secret.value){status.textContent="Enter the deployment claim secret.";return;}
  button.disabled=true;status.textContent="Claiming server…";
  try{
    const vaultId=randomValue(16);
    const res=await fetch("/claim",{method:"POST",headers:{"Content-Type":"application/json","X-KAOS-Claim-Proof":secret.value},body:JSON.stringify({vaultId})});
    const body=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(body.error||"Claim failed");
    form.hidden=true;
    secret.value="";
    const pairing=body.ownerPairing;
    const deepLink="obsidian://kaos?action=claim-owner&host="+encodeURIComponent(location.origin)+"&vaultId="+encodeURIComponent(body.vaultId)+"&secret="+encodeURIComponent(pairing?.qrSecret||"");
    document.getElementById("deep-link").href=deepLink;
    document.getElementById("pairing-code").textContent=pairing?.code||"";
    document.getElementById("recovery-secret").textContent=body.recoverySecret||"";
    document.getElementById("complete").hidden=false;
    status.textContent="Server claimed successfully!";
    status.style.color="#7bdff6";
    document.getElementById("copy-recovery").onclick=()=>{navigator.clipboard.writeText(body.recoverySecret||"");status.textContent="Recovery Secret copied to clipboard!";};
    document.getElementById("copy-link").onclick=()=>{navigator.clipboard.writeText(deepLink);status.textContent="Obsidian setup link copied to clipboard!";};
  }catch(error){
    status.textContent=error instanceof Error?error.message:"Claim failed";
    status.style.color="#ff8a8a";
    button.disabled=false;
  }
});
</script></body></html>`;
}

/** Mobile links contain only an expiring, single-use pairing session. */
export function renderMobileSetupPage(options: MobileSetupPageOptions): string {
	const nonce = options.scriptNonce ? ` nonce="${escapeHtml(options.scriptNonce)}"` : "";
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect KAOS</title><style>${STYLE}</style></head><body><main>
<h1>Connect KAOS Device</h1><p>Connect this device to your KAOS sync server instantly.</p><a id="connect" class="cta" hidden>Open in Obsidian</a><div id="status" class="status"></div>
</main><script${nonce}>
const params=new URLSearchParams(location.hash.startsWith("#")?location.hash.slice(1):location.hash);const targetHost=(params.get("host")||"").trim().replace(/\\/$/,"");const vaultId=(params.get("vaultId")||"").trim();const secret=(params.get("secret")||params.get("invite")||"").trim();const status=document.getElementById("status"),connect=document.getElementById("connect");
if(targetHost!==location.origin||!vaultId||!/^[A-Za-z0-9_-]{32,512}$/.test(secret)){status.textContent="Invalid or expired device pairing link.";status.style.color="#ff8a8a";}else{connect.href="obsidian://kaos?"+new URLSearchParams({action:"pair",host:targetHost,vaultId,secret});connect.hidden=false;status.textContent="Ready. Click above to connect in Obsidian.";}history.replaceState(null,"",location.pathname);
</script></body></html>`;
}

export function renderRunningPage(options: RunningPageOptions): string {
	const host = escapeHtml(options.host);
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KAOS Server</title><style>${STYLE}</style></head><body><main><h1>KAOS Server is online</h1><p>Device-key authentication is active. Owner devices approve, revoke, and manage roles; Member devices can sync only.</p><p class="muted">Server: <code>${host}</code></p><p>Text sync: enabled · Attachments: ${options.attachments ? "enabled" : "unavailable"} · Snapshots: ${options.snapshots ? "enabled" : "unavailable"}</p></main></body></html>`;
}
