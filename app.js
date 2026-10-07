export const UPLOAD_URL = "https://lyvisiuknkumqrxihqnb.supabase.co/functions/v1/mobile-intake/upload";

// Safari requires native fetch to receive its global Window, even when called by a session.
const browserFetch = (...args) => globalThis.fetch(...args);

export function readAndClearCapability(locationValue, historyValue) {
  const token = new URLSearchParams(locationValue.hash.slice(1)).get("token") || "";
  historyValue.replaceState(null, "", locationValue.pathname);
  return token;
}

export function selectImage(selections, side, source, file) {
  if (!file) return false;
  selections[side] = { file, source };
  return true;
}

export function buildUploadBody(selections, token) {
  if (!selections.front?.file || !selections.back?.file) {
    throw new Error("Front and back photos are required.");
  }
  const body = new FormData();
  body.set("front", selections.front.file);
  body.set("back", selections.back.file);
  body.set("token", token);
  return body;
}

export async function submitCapture(selections, token, fetcher = browserFetch) {
  const body = buildUploadBody(selections, token);
  return fetcher(UPLOAD_URL, { method: "POST", body, referrerPolicy: "no-referrer" });
}

export class PhoneJournal {
  async db() {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open('cardhq-incomplete-photos',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Phone storage is unavailable. Keep this page open.'));
    });
  }
  async transaction(mode,key,value) {
    const db=await this.db();
    try {
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction('drafts',mode),store=tx.objectStore('drafts');let result;
        const request=mode==='readonly'?store.get(key):value===undefined?store.delete(key):store.put(value,key);
        request.onsuccess=()=>{result=request.result;};
        tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(Error('Photos could not be saved on this phone. Keep this page open.'));
      });
    } finally {db.close();}
  }
  get(session,item){return this.transaction('readonly',session+'/'+item);}
  save(draft){return this.transaction('readwrite',draft.session_id+'/'+draft.item_id,draft);}
  drop(session,item){return this.transaction('readwrite',session+'/'+item);}
}

const SESSION_URL=UPLOAD_URL.replace('/upload','/session-action');
const PAIR_URL=UPLOAD_URL.replace('/upload','/intake-upload');
const BOOTSTRAP_URL=UPLOAD_URL.replace('/upload','/session-bootstrap');
const ORIGINAL_URL=UPLOAD_URL.replace('/upload','/session-original');
const photoFingerprint=async file=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())))
  .map(v=>v.toString(16).padStart(2,'0')).join('');
const fingerprints=async selections=>Promise.all(['front','back'].map(async side=>
  photoFingerprint(selections[side].file)));
const supportedPhoto=file=>file instanceof Blob && file.size>0 && file.size<=15*1024*1024 &&
  ['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.type);

export class CaptureSession {
  constructor(token,fetcher=browserFetch,journal=new PhoneJournal()) {
    this.bootstrapToken=token;this.token=null;this.fetcher=fetcher;this.journal=journal;this.selections={};
    this.submitted=false;this.busy=false;this.frontAcknowledged=false;this.authorityActive=false;
  }
  applySnapshot(snapshot,expectedItem=null){
    if(!snapshot || !snapshot.session_id || !['single','multi'].includes(snapshot.mode) || !Array.isArray(snapshot.items) ||
      this.session_id && (snapshot.session_id!==this.session_id || snapshot.mode!==this.mode ||
        snapshot.registration_id!==this.registration_id || snapshot.user_id!==this.owner_id) ||
      snapshot.items.some((item,index)=>!item.id || item.ordinal!==index+1 || !Number.isSafeInteger(item.revision) ||
        item.revision<1 || item.revision>1000 || !['awaiting_front','awaiting_back','uploading','uploaded'].includes(item.state)) ||
      new Set(snapshot.items.map(item=>item.id)).size!==snapshot.items.length ||
      expectedItem && snapshot.items.at(-1)?.id!==expectedItem)throw Error('Session or current card changed. Request a fresh QR for this same intake.');
    this.session_id=snapshot.session_id;this.mode=snapshot.mode;this.registration_id=snapshot.registration_id;
    this.owner_id=snapshot.user_id;this.finished=snapshot.capture_finished===true || snapshot.revoked_at!=null;
    this.current=snapshot.items.at(-1);return snapshot;
  }
  async checkedResponse(response){
    if(response.ok)return response;
    if(response.status===403){this.authorityActive=false;throw Error('Capture expired or ended. Request a fresh QR for this same intake. Your saved photos remain on this phone.');}
    throw Error(response.status===429?'Capture is busy. Wait a minute, then retry with your saved photos.':'This card could not continue. Keep your photos and retry shortly.');
  }
  async action(action,item_id=null){
    if(!this.token)throw Error('Connect with a fresh QR for this intake first.');
    const response=await this.fetcher(SESSION_URL,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({token:this.token,action,item_id}),referrerPolicy:'no-referrer'});
    await this.checkedResponse(response);
    return this.applySnapshot(await response.json(),['front','retake','activity'].includes(action)?item_id:null);
  }
  async open(){
    if(!this.token){
      const response=await this.fetcher(BOOTSTRAP_URL,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({token:this.bootstrapToken}),referrerPolicy:'no-referrer'});
      await this.checkedResponse(response);const result=await response.json();
      if(!/^[0-9a-f]{64}$/.test(result.active_token) || result.inactivity_seconds!==1800 || result.hard_seconds!==43200)throw Error('Capture establishment failed. Request a fresh QR for this intake.');
      this.applySnapshot(result.snapshot);this.token=result.active_token;this.bootstrapToken=null;this.authorityActive=!this.finished;
    }else await this.action('status');
    if(this.current){
      const saved=await this.journal.get(this.session_id,this.current.id);
      if(saved && saved.session_id===this.session_id && saved.item_id===this.current.id && saved.revision===this.current.revision){
        if(this.current.state==='uploaded')await this.journal.drop(this.session_id,this.current.id);
        else{
          for(const side of ['front','back'])if(supportedPhoto(saved.selections?.[side]?.file))this.selections[side]=saved.selections[side];
          this.submitted=saved.submitted===true;
        }
      }
      if(this.current.state!=='uploaded' && !this.finished){
        const evidence=this.current.side_evidence || [];
        if(!Array.isArray(evidence) || evidence.length>2 || new Set(evidence.map(r=>r.side)).size!==evidence.length ||
          evidence.some(r=>!['front','back'].includes(r.side) || !/^[0-9a-f]{64}$/.test(r.fingerprint)))throw Error('Stored side evidence is invalid. Keep your photos and request desktop recovery.');
        for(const receipt of evidence){
          const side=receipt.side;
          if(this.selections[side]){
            if(await photoFingerprint(this.selections[side].file)!==receipt.fingerprint)throw Error('Phone photo fingerprint differs from the stored original. Keep both and use Replace Photos for this same card.');
          }else{
            const response=await this.fetcher(ORIGINAL_URL,{method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({token:this.token,item_id:this.current.id,revision:this.current.revision,side}),referrerPolicy:'no-referrer'});
            await this.checkedResponse(response);const file=await response.blob();
            if(!supportedPhoto(file) || await photoFingerprint(file)!==receipt.fingerprint)throw Error('Stored photo integrity or fingerprint could not be confirmed. Keep your photos and use desktop recovery.');
            this.selections[side]={file,source:'hosted'};
          }
        }
        if(this.selections.front){
          if(this.current.state==='awaiting_front')await this.action('front',this.current.id);
          this.frontAcknowledged=this.current.state==='awaiting_back'||this.current.state==='uploading';
        }
        if(this.selections.front || this.selections.back)await this.save();
      }else if(this.current.state==='uploaded' && this.mode==='single' && !this.finished){
        await this._finish();
      }
    }
    return this;
  }
  async activity(){
    if(this.busy || this.finished || !this.authorityActive || this.activityPromise || !this.current)return;
    this.activityPromise=this.action('activity',this.current.id);
    try{await this.activityPromise;}finally{this.activityPromise=null;}
  }
  async save(){
    await this.journal.save({session_id:this.session_id,item_id:this.current.id,revision:this.current.revision,
      selections:this.selections,submitted:this.submitted}); // Bearer stays exclusively in memory.
  }
  async select(side,file){
    if(this.activityPromise)await this.activityPromise;
    if(this.busy)throw Error('A photo operation is busy. Wait for it to finish.');
    if(this.finished || !this.current || this.current.state==='uploaded')throw Error('This pair is already submitted. Retake it on the desktop before confirmation.');
    if(!['front','back'].includes(side) || !supportedPhoto(file))throw Error('Choose a supported photo up to 15 MiB.');
    if(side==='back' && (!this.selections.front || !this.frontAcknowledged))throw Error('Capture Front first and wait for its acknowledgement, then Back.');
    if(!this.authorityActive)throw Error('Request a fresh QR for this same card; your photos remain saved.');
    this.busy=true;
    try{
      if(this.submitted)await this.action('status');
      if(this.current.state==='uploaded')throw Error('This pair is already uploaded. Use desktop review or Replace Photos for this same card.');
      const stored=(this.current.side_evidence || []).find(r=>r.side===side);
      if(stored && await photoFingerprint(file)!==stored.fingerprint){
        await this.action('retake',this.current.id);this.submitted=false;this.frontAcknowledged=false;
        if(side==='back' && this.selections.front){await this.action('front',this.current.id);this.frontAcknowledged=true;}
      }
      this.selections[side]={file,source:'selected'};await this.save();
      if(side==='front'){
        this.frontAcknowledged=false;await this.action('front',this.current.id);
        if(this.current.state!=='awaiting_back' && this.current.state!=='uploading')throw Error('Front acknowledgement is incomplete. Keep this photo and reconnect to the same card.');
        this.frontAcknowledged=true;
      }else await this.action('activity',this.current.id);
    }finally{this.busy=false;}
  }
  async submit(){
    if(this.activityPromise)await this.activityPromise;
    if(this.busy || this.finished || !this.authorityActive || !this.frontAcknowledged || !this.current ||
      !this.selections.front || !this.selections.back)throw Error('A complete acknowledged Front/Back pair is required.');
    this.busy=true;
    try {
      this.submitted=true;await this.save();
      const item=this.current.id,fp=await fingerprints(this.selections);
      const body=buildUploadBody(this.selections,this.token);body.set('item_id',item);body.set('revision',String(this.current.revision));
      const response=await this.fetcher(PAIR_URL,{method:'POST',body,referrerPolicy:'no-referrer'});
      await this.checkedResponse(response);
      const result=await response.json();
      if(result.status!=='completed' || result.item_id!==item || result.revision!==this.current.revision ||
        typeof result.capture_finished!=='boolean' || JSON.stringify(result.fingerprints)!==JSON.stringify(fp))throw Error('Upload acknowledgement did not match this pair. Keep your photos and retry.');
      this.current.state='uploaded';await this.journal.drop(this.session_id,item);
      if(result.capture_finished){this.finished=true;this.authorityActive=false;}
      else if(this.mode==='single')await this._finish();
      return result;
    } finally {this.busy=false;}
  }
  async next(){
    if(this.activityPromise)await this.activityPromise;
    if(this.busy)throw Error('Capture is busy. Wait for it to finish.');
    if(this.mode!=='multi' || this.finished || this.current?.state!=='uploaded')throw Error('Next Card requires an acknowledged Multi pair.');
    this.busy=true;
    try{await this.action('next',this.current.id);this.selections={};this.submitted=false;this.frontAcknowledged=false;}finally{this.busy=false;}
  }
  async finish(){
    if(this.activityPromise)await this.activityPromise;
    if(this.busy)throw Error('Capture is busy. Wait for it to finish.');
    this.busy=true;
    try{await this._finish();}finally{this.busy=false;}
  }
  async _finish(){
    if(this.current?.state!=='uploaded')throw Error('Finish requires the current completed pair.');
    await this.action('finish',this.current.id);
    this.authorityActive=false;
  }
}

async function initializeSession(form,status,token){
  const session=new CaptureSession(token),submit=form.querySelector('[type="submit"]');
  const next=document.querySelector('#next-card'),finish=document.querySelector('#finish-batch');
  const retryFront=document.querySelector('#retry-front');
  const inputs=[...form.querySelectorAll('[data-image-input]')];
  for(const input of inputs)input.disabled=true;
  const render=()=>{
    const complete=session.current?.state==='uploaded',closed=session.finished;
    document.querySelector('#card-progress').textContent=session.current?`Card ${session.current.ordinal} · ${session.mode==='single'?'Single':'Multi'} intake`:'Connecting to intake…';
    for(const input of inputs)input.disabled=session.busy || !session.authorityActive || closed || complete || input.dataset.side==='back'&&!session.frontAcknowledged;
    submit.disabled=session.busy || !session.authorityActive || closed || complete || !session.frontAcknowledged || !session.selections.front || !session.selections.back;
    submit.textContent=session.mode==='single'?'Finish / Upload':'Save this Front/Back pair';
    next.hidden=session.mode!=='multi'||!complete||closed;finish.hidden=!complete||closed;
    next.disabled=finish.disabled=session.busy;
    retryFront.hidden=!session.authorityActive || closed || complete || session.frontAcknowledged || !session.selections.front;
    retryFront.disabled=session.busy;
    for(const side of ['front','back'])form.querySelector(`[data-selection-for="${side}"]`).textContent=session.selections[side]?
      `${side==='front'?'Front':'Back'} ${session.selections[side].source==='hosted'?'restored from its stored original':'saved on this phone'}. Choose again to retake before submission.`:`No ${side} photo selected.`;
    if(!complete && session.current?.recovery_note)status.textContent=session.current.recovery_note;
    if(complete)status.textContent=closed?'Capture finished. Uploaded originals remain saved; validation and review continue on the desktop.':'Photos uploaded; desktop validation pending. Check the desktop card status. If originals cannot be read, use Replace Photos for that same card. Next Card continues capture.';
  };
  try{await session.open();render();}catch(error){status.textContent=error.message;submit.disabled=true;return;}
  for(const input of inputs)input.addEventListener('change',async()=>{
    try{const pending=session.select(input.dataset.side,input.files?.[0]);render();await pending;input.value='';render();status.textContent='';}catch(error){render();status.textContent=error.message;}
  });
  for(const input of inputs)input.addEventListener('click',()=>{
    session.activity().catch(error=>{render();status.textContent=error.message;});
  });
  retryFront.addEventListener('click',async()=>{
    try{const pending=session.select('front',session.selections.front.file);render();await pending;render();status.textContent='Front acknowledged. Continue with Back.';}catch(error){render();status.textContent=error.message;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    status.textContent='Uploading this pair… Keep this page open until it is acknowledged.';
    try{const pending=session.submit();render();await pending;render();}catch(error){render();status.textContent=error.message;}
  });
  for(const [button,action] of [[next,'next'],[finish,'finish']])button.addEventListener('click',async()=>{
    try{const pending=session[action]();render();await pending;render();}catch(error){render();status.textContent=error.message;}
  });
}

function initialize() {
  const form = document.querySelector("#capture-form");
  const status = document.querySelector("#status");
  const button = form.querySelector("button");
  const protocol=new URLSearchParams(window.location.hash.slice(1)).get('protocol');
  const token = readAndClearCapability(window.location, window.history);
  const selections = {};

  if (!token) {
    status.textContent = "Request a fresh desktop QR for the same intake. Unfinished photos saved on this phone can resume after reconnecting.";
    button.disabled = true;
    return;
  }
  if(protocol==='intake'){initializeSession(form,status,token);return;}

  for (const input of form.querySelectorAll("[data-image-input]")) {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!selectImage(selections, input.dataset.side, input.dataset.source, file)) return;
      for (const alternate of form.querySelectorAll(`[data-side="${input.dataset.side}"]`)) {
        if (alternate !== input) alternate.value = "";
      }
      const source = input.dataset.source === "camera" ? "camera" : "photo library";
      form.querySelector(`[data-selection-for="${input.dataset.side}"]`).textContent = `Selected from ${source}.`;
      status.textContent = "";
      button.disabled = !(selections.front && selections.back);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Uploading… Keep this page open.";
    try {
      const response = await submitCapture(selections, token);
      if (response.ok) {
        status.textContent = "Photos received. You may close this page.";
        return;
      }
      button.disabled = false;
      status.textContent = response.status === 403
        ? "This link expired or was already used. Request a new pairing link."
        : response.status === 413
        ? "One of the images could not be accepted. Retake both photos and try again."
        : "Upload did not finish. Check your connection and try again.";
    } catch {
      button.disabled = false;
      status.textContent = "Upload was interrupted. Check your connection and try again.";
    }
  });
}

if (typeof document !== "undefined") initialize();
