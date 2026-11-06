'use strict';
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
let instance, starting, idleTimer, active = 0, headed = false;
const profiles = new Set();
function findBrowser() {
 const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
 for (const relative of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
  for (const root of roots) { const file=path.join(root, relative); if(fs.existsSync(file)) return file; }
 }
 throw new Error('需要本地浏览器，未找到 Edge/Chrome');
}
function cleanProfile(dir) {
 if (!profiles.has(dir) || path.dirname(dir)!==os.tmpdir() || !path.basename(dir).startsWith('novel-reader-cdp-')) return;
 try { fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});profiles.delete(dir); } catch(e) { console.error('[browser] profile cleanup:',e.message); }
}
let closing;
async function closeBrowser() {
 clearTimeout(idleTimer);
 const old=instance;instance=null;
 if(!old)return closing;
 if(old.external){
  await Promise.allSettled([...(old.imagePages?.values()||[])].map(async promise=>{const page=await promise;await imageDeadline(old.cdp.send('Target.closeTarget',{targetId:page.targetId}),Date.now()+1500);}));
  old.cdp.close();console.log('[browser] detached external CDP; browser remains open');return;
 }
 closing=(async()=>{
  try {
   if(!old.cdp){
    const response=await fetch('http://127.0.0.1:'+old.port+'/json/version',{signal:AbortSignal.timeout(1000)});
    const version=await response.json();old.cdp=await connect(version.webSocketDebuggerUrl);
   }
   if(!old.browserPid){const info=await old.cdp.send('SystemInfo.getProcessInfo');old.browserPid=info.processInfo.find(p=>p.type==='browser')?.id;}
   await Promise.race([old.cdp.send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);
   const deadline=Date.now()+4000;
   while(Date.now()<deadline){
    try{await fetch('http://127.0.0.1:'+old.port+'/json/version',{signal:AbortSignal.timeout(250)});}catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   // The CDP port disappears before Windows has finished browser disk teardown.
   const processDeadline=Date.now()+4000;
   while(old.browserPid && Date.now()<processDeadline){
    try{process.kill(old.browserPid,0);}catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   await new Promise(resolve=>setTimeout(resolve,300));
  }catch(e){console.error('[browser] close:',e.message);}
  finally{old.cdp?.close();cleanProfile(old.profile);console.log('[browser] closed via CDP launcherPid='+old.child.pid+' browserPid='+old.browserPid);}
 })();
 try{await closing;}finally{closing=null;}
}
// exit cannot await a WebSocket round trip. A short-lived Node helper performs
// the same Browser.close command for explicit process.exit(), without relying
// on the launcher's PID (which Edge may already have retired).
function closeOnExit(){
 const old=instance;if(!old)return;
 instance=null;
 if(old.external){old.cdp?.close();return;}
 const helper=`(async()=>{const data=JSON.parse(require('fs').readFileSync(0,'utf8'));const r=await fetch('http://127.0.0.1:'+data.port+'/json/version',{signal:AbortSignal.timeout(1500)});const v=await r.json();const ws=new WebSocket(v.webSocketDebuggerUrl);let pid=data.browserPid;ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'SystemInfo.getProcessInfo'}));ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id===1){pid=m.result?.processInfo.find(p=>p.type==='browser')?.id||pid;ws.send(JSON.stringify({id:2,method:'Browser.close'}));}};ws.onclose=()=>{const deadline=Date.now()+3500;const poll=()=>{let alive=false;try{if(pid){process.kill(pid,0);alive=true;}}catch{}if(alive&&Date.now()<deadline)setTimeout(poll,100);else setTimeout(()=>process.exit(0),300);};poll();};ws.onerror=()=>process.exit(1);setTimeout(()=>process.exit(1),5500);})().catch(()=>process.exit(1));`;
 spawnSync(process.execPath,['-e',helper],{input:JSON.stringify({port:old.port,browserPid:old.browserPid}),timeout:6500,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','ignore','ignore']});
 cleanProfile(old.profile);
}
function connect(endpoint) {
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(endpoint);const pending=new Map();let sequence=0;
  const fail=()=>{for(const {reject} of pending.values())reject(new Error('浏览器 CDP 连接已关闭'));pending.clear();};
  ws.addEventListener('error',()=>{reject(new Error('无法连接本地浏览器 CDP'));fail();});ws.addEventListener('close',fail);
  ws.addEventListener('message',event=>{const data=JSON.parse(event.data);const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.error?task.reject(new Error(data.error.message)):task.resolve(data.result);});
  ws.addEventListener('open',()=>resolve({get isOpen(){return ws.readyState===WebSocket.OPEN;},send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});},close(){ws.close();fail();}}));
 });
}
async function freePort() {
 return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
}
async function browser() {
 if(closing)await closing;
 if(instance?.cdp?.isOpen)return instance;
 if(instance && !starting)await closeBrowser();
 if(starting)return starting;
 starting=(async()=>{
  if(typeof WebSocket==='undefined')throw new Error('浏览器搜索需要 Node.js 24+（内置 WebSocket）');
  if(process.env.SHIYE_BROWSER_CDP_URL){
   const endpoint=process.env.SHIYE_BROWSER_CDP_URL;
   const response=await fetch(new URL('/json/version',endpoint),{signal:AbortSignal.timeout(2000)});
   if(!response.ok)throw new Error('无法访问指定浏览器 CDP');
   const version=await response.json(),cdp=await imageDeadline(connect(version.webSocketDebuggerUrl),Date.now()+3000);
   const state={cdp,ua:version['User-Agent'],headed:true,external:true};
   if(!state.ua){cdp.close();throw new Error('指定浏览器未返回 User-Agent');}
   instance=state;console.log('[browser] attached external persistent CDP');return state;
  }
  const executable=findBrowser(),profile=process.env.SHIYE_BROWSER_PROFILE||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'shiye','edge-profile');fs.mkdirSync(profile,{recursive:true});
  const port=await freePort();
  const child=spawn(executable,[...(headed?['--window-position=-32000,-32000','--window-size=1280,900']:['--headless=new']),'--disable-blink-features=AutomationControlled','--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
  const state={child,profile,port,headed,cdp:null};instance=state;
  console.log('[browser] started pid='+child.pid+' '+path.basename(executable));
  // Edge's launcher may exit successfully while its browser/CDP stays alive.
  child.once('exit',(code)=>console.log('[browser] launcher exited code='+code+'; CDP remains authoritative'));
  try {
   let version;
   const deadline=Date.now()+12000;
   let launchError;child.once('error',error=>{launchError=error;});
   while(Date.now()<deadline){
    if(launchError)throw launchError;
    try {const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(750)});if(response.ok){version=await response.json();break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   if(!version?.webSocketDebuggerUrl)throw new Error('浏览器启动超时：无法获取 CDP 地址');
   const browserVersion=version.Browser.match(/(?:Edg|Chrome|HeadlessChrome)\/([\d.]+)/)?.[1];
   if(!browserVersion)throw new Error('无法识别浏览器版本：'+version.Browser);
   const major=browserVersion.split('.')[0];
   state.ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'+major+'.0.0.0 Safari/537.36'+(path.basename(executable).toLowerCase()==='msedge.exe'?' Edg/'+browserVersion:'');
   state.cdp=await connect(version.webSocketDebuggerUrl);
   const info=await state.cdp.send('SystemInfo.getProcessInfo');state.browserPid=info.processInfo.find(p=>p.type==='browser')?.id;
   console.log('[browser] CDP ready browserPid='+state.browserPid+' launcherExitCode='+child.exitCode+' version='+version.Browser);return state;
  } catch(e){if(instance===state)await closeBrowser();throw e;}
 })();
 try{return await starting;}finally{starting=null;}
}
async function searchHTML(s,url,options) {
 active++;clearTimeout(idleTimer);
 let timer,state,targetId;
 const operation=(async()=>{
  state=await browser();
  const cdp=state.cdp;
  ({targetId}=await cdp.send('Target.createTarget',{url:'about:blank'}));
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  const send=(method,params)=>cdp.send(method,params,sessionId);
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setUserAgentOverride',{userAgent:state.ua,acceptLanguage:'zh-CN,zh;q=0.9'});
  await send('Network.setExtraHTTPHeaders',{headers:s.headers||{}});
  if(s.search.blockedUrls?.length)await send('Network.setBlockedURLs',{urls:s.search.blockedUrls});
  await send('Page.navigate',{url:s.baseUrl+'/'});
  // Wait for the real site's document before evaluating its same-origin fetch.
  const readyDeadline=Date.now()+10000;
  for(;;){
   if(Date.now()>=readyDeadline)throw new Error('首页加载超时（10 秒）：尚未完成站点脚本初始化');
   const {result}=await send('Runtime.evaluate',{expression:`location.origin === ${JSON.stringify(new URL(s.baseUrl).origin)} && document.readyState === 'complete'`,returnByValue:true});
   if(result.value){
    if(!s.search.readyCookie)break;
    const cookie=await send('Runtime.evaluate',{expression:`document.cookie.split(';').some(v=>v.trim().startsWith(${JSON.stringify(s.search.readyCookie+'=')}))`,returnByValue:true});
    if(cookie.result.value)break;
   }
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  const expression=`(async()=>{const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(options.method)},headers:{'Content-Type':'application/x-www-form-urlencoded'},body:${JSON.stringify(options.body)}});if(!r.ok)throw new Error('上游 HTTP '+r.status);const html=await r.text();return {status:r.status,html};})()`;
  for(let attempt=0;attempt<2;attempt++){
   const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
   if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0]||result.exceptionDetails.text);
   if(result.result.value?.html?.trim())return result.result.value.html;
   if(attempt===0)await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('浏览器搜索返回空响应（已重试 1 次）');
 })();
 try {
  return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{closeBrowser();reject(new Error('本地浏览器搜索超时（最多 15 秒）'));},15000);})]);
 } finally {
  clearTimeout(timer);
  if(targetId&&state?.cdp&&state===instance)state.cdp.send('Target.closeTarget',{targetId}).catch(()=>{});
  active--;if(!active)idleTimer=setTimeout(()=>{closeBrowser().catch(console.error);},60000).unref();
 }
}
// Wenku pages may require a document navigation to complete their challenge.
// Keep this separate from search fetches and the shared image page.
async function pageHTML(s,url){
 active++;clearTimeout(idleTimer);
 let state,targetId;const deadline=Date.now()+210000;
 try{
  for(let mode=0;mode<2;mode++){
  state=await imageDeadline(browser(),deadline,'浏览器文库页加载超时（210 秒）');
  const cdp=state.cdp,command=(method,params,sessionId)=>imageDeadline(cdp.send(method,params,sessionId),deadline,'浏览器文库页加载超时（210 秒）');
  ({targetId}=await command('Target.createTarget',{url:'about:blank'}));
  const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  const send=(method,params)=>command(method,params,sessionId);
  await send('Page.enable');await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"});
  // Preserve native UA Client Hints as well as UA; a text-only override drops
  // the browser's metadata and can keep Wenku in a challenge loop.
  await send('Network.setExtraHTTPHeaders',{headers:s.headers||{}});
  if(s.search?.blockedUrls?.length)await send('Network.setBlockedURLs',{urls:s.search.blockedUrls});
  await send('Page.navigate',{url});let reloads=0,nextReload=0,gesture=false;
  await new Promise(resolve=>setTimeout(resolve,8000));
  for(;;){
   if(Date.now()>=deadline)throw new Error('浏览器文库页加载超时（210 秒）');
   const response=await send('Runtime.evaluate',{expression:`({ready:location.origin===${JSON.stringify(new URL(s.baseUrl).origin)}&&document.readyState!=='loading',title:document.title,challenge:!!document.querySelector('#challenge-running,#challenge-stage'),hasBooks:!!document.querySelector(${JSON.stringify(s.discover.readySelector||s.discover.rules.list)}),emptyContainer:${s.discover.emptySelector?'!!document.querySelector('+JSON.stringify(s.discover.emptySelector)+')':'false'},metadataCount:(document.body?.innerText.match(new RegExp(${JSON.stringify(s.discover.readyTextPattern||'(?!)')},'g'))||[]).length,empty:${JSON.stringify(s.discover.emptyPattern||'没有找到|暂无相关|没有符合|无符合')},text:document.body?.innerText||'',html:document.documentElement.outerHTML})`,returnByValue:true});
   const value=response.result.value;
   const challenge=value?.challenge||/Just a moment|Attention Required|Access denied|请稍候|正在验证|403 Forbidden/i.test(value?.title||'');
   if(value?.ready&&!challenge&&new RegExp(s.discover.titlePattern||'.').test(value.title)&&(value.hasBooks||value.emptyContainer||value.metadataCount>0||new RegExp(value.empty).test(value.text)))return value.html;
   if(!gesture){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:178,y:192});await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:178,y:192,deltaX:0,deltaY:300});gesture=true;nextReload=Date.now()+[6000,10000,15000,15000][reloads];}
   if(Date.now()>=nextReload){
    if(reloads===3)break;
    await send('Page.reload',{ignoreCache:true});reloads++;
    console.log('[browser] wenku reload='+reloads+' mode='+(state.headed?'headed':'headless')+' title='+value?.title);
    gesture=false;await new Promise(resolve=>setTimeout(resolve,8000));
   }
   await new Promise(resolve=>setTimeout(resolve,200));
  }
  await command('Target.closeTarget',{targetId});targetId=null;
  if(state.headed)break;
  console.log('[browser] wenku challenge persists; retrying headed with persistent profile');
  await closeBrowser();headed=true;
  }
  throw new Error('文库页安全验证未通过：持久化 profile、三次重载及有头回退均未获取到书单');
 }finally{
  if(targetId&&state?.cdp&&state===instance)state.cdp.send('Target.closeTarget',{targetId}).catch(()=>{});
  active--;if(!active)idleTimer=setTimeout(()=>{closeBrowser().catch(console.error);},60000).unref();
 }
}
// Image requests share a same-origin page as well as the existing browser/CDP.
// A page fetch supplies the browser's own UA, cookies and real Referer.
function imageDeadline(promise,deadline,message='浏览器取图超时（最多 25 秒）'){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),Math.max(1,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
}
async function imagePage(state,origin){
 state.imagePages ||= new Map();
 if(state.imagePages.has(origin))return state.imagePages.get(origin);
 const ready=(async()=>{
  let targetId;
  const deadline=Date.now()+10000;
  const command=(method,params,sessionId)=>imageDeadline(state.cdp.send(method,params,sessionId),deadline);
  try{
   ({targetId}=await command('Target.createTarget',{url:'about:blank'}));
   const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
   const send=(method,params)=>command(method,params,sessionId);
   await send('Page.enable');await send('Network.enable');
   await send('Network.setUserAgentOverride',{userAgent:state.ua,acceptLanguage:'zh-CN,zh;q=0.9'});
   await send('Network.setExtraHTTPHeaders',{headers:{Referer:origin+'/'}});
   await send('Network.setBlockedURLs',{urls:['*://hm.baidu.com/*']});
   await send('Page.navigate',{url:origin+'/'});
   for(;;){
    const {result}=await send('Runtime.evaluate',{expression:`location.origin === ${JSON.stringify(origin)} && document.readyState !== 'loading'`,returnByValue:true});
    if(result.value)return {targetId,sessionId};
    await new Promise(resolve=>setTimeout(resolve,100));
   }
  }catch(error){
   if(targetId)state.cdp.send('Target.closeTarget',{targetId}).catch(()=>{});
   state.imagePages.delete(origin);throw error;
  }
 })();
 state.imagePages.set(origin,ready);return ready;
}
async function fetchImageBuffer(url){
 const target=new URL(url);
 if(!['https:','http:'].includes(target.protocol))throw new Error('图片 URL 协议无效');
 active++;clearTimeout(idleTimer);
 const deadline=Date.now()+25000;
 try{
  const state=await imageDeadline(browser(),deadline);
  const page=await imageDeadline(imagePage(state,target.origin),deadline);
  const expression=`(async()=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(${JSON.stringify(target.href)},{credentials:'include',referrer:${JSON.stringify(target.origin+'/')},signal:controller.signal});if(!response.ok)throw new Error('上游 HTTP '+response.status);const contentType=response.headers.get('content-type')||'';if(!contentType.toLowerCase().startsWith('image/'))throw new Error('上游未返回图片');const bytes=new Uint8Array(await response.arrayBuffer());if(!bytes.length)throw new Error('上游返回空图片');let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return {base64:btoa(binary),contentType};}finally{clearTimeout(timer);}})()`;
  const result=await imageDeadline(state.cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},page.sessionId),deadline);
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0]||result.exceptionDetails.text);
  const data=result.result.value;
  if(!data?.base64||!data.contentType?.toLowerCase().startsWith('image/'))throw new Error('浏览器未返回有效图片');
  return {buffer:Buffer.from(data.base64,'base64'),contentType:data.contentType};
 }finally{
  active--;if(!active)idleTimer=setTimeout(()=>{closeBrowser().catch(console.error);},60000).unref();
 }
}
process.once('exit',()=>{closeOnExit();for(const dir of profiles)cleanProfile(dir);});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await closeBrowser();process.exit(0);});
module.exports={searchHTML,pageHTML,fetchImageBuffer,closeBrowser};
