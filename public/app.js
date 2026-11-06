 'use strict';
const view=document.querySelector('#view'), status=document.querySelector('#status');
let currentBook=null, currentIndex=-1, busy=false, sources=[];
function stored(key,fallback){try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}}
let shelf=stored('shelf',[]);if(!Array.isArray(shelf))shelf=[];shelf=shelf.filter(b=>b&&typeof b.name==='string'&&typeof b.url==='string'&&typeof b.source==='string').map((b,i)=>({...b,addedAt:Number.isFinite(b.addedAt)?b.addedAt:Date.now()+i})); document.body.dataset.theme=stored('theme','light');
function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{status.textContent='浏览器存储不可用，无法保存书架';}}
function node(tag,text,cls){const el=document.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el;}
function button(text,fn){const el=node('button',text);el.onclick=fn;return el;}
const READER_SETTINGS_KEY='shiye.reader.settings';
const READER_DEFAULTS=Object.freeze({preset:'light',colorMode:'preset',backgroundColor:'#f6f4ed',textColor:'#23352c',fontFamily:'serif',fontSize:18,lineHeight:1.95,paragraphSpacing:'normal',width:'medium',indent:true,align:'justify',keyboard:true,clickTurn:false,autoNext:false});
const READER_PALETTES={light:{label:'浅色',background:'#f6f4ed',text:'#23352c'},eye:{label:'护眼绿',background:'#dfe8d6',text:'#243729'},parchment:{label:'羊皮纸',background:'#f1e2be',text:'#3d3025'},dark:{label:'深灰',background:'#242424',text:'#e7e7e7'},oled:{label:'纯黑',background:'#000000',text:'#e6e6e6'}};
const READER_FONTS={serif:'"Source Han Serif SC","Noto Serif SC",SimSun,serif',sans:'"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif',kai:'KaiTi,STKaiti,serif',system:'system-ui,sans-serif'};
function validateReaderSettings(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
 const result={...READER_DEFAULTS},choices={preset:Object.keys(READER_PALETTES),colorMode:['preset','custom'],fontFamily:Object.keys(READER_FONTS),paragraphSpacing:['compact','normal','relaxed'],width:['narrow','medium','wide'],align:['justify','left']};
 for(const [key,options] of Object.entries(choices))if(options.includes(raw[key]))result[key]=raw[key];
 for(const key of ['backgroundColor','textColor'])if(typeof raw[key]==='string'&&/^#[0-9a-f]{6}$/i.test(raw[key]))result[key]=raw[key].toLowerCase();
 if(typeof raw.fontSize==='number'&&Number.isInteger(raw.fontSize)&&raw.fontSize>=14&&raw.fontSize<=26)result.fontSize=raw.fontSize;
 if(typeof raw.lineHeight==='number'&&Number.isFinite(raw.lineHeight)&&raw.lineHeight>=1.5&&raw.lineHeight<=2.4)result.lineHeight=raw.lineHeight;
 for(const key of ['indent','keyboard','clickTurn','autoNext'])if(typeof raw[key]==='boolean')result[key]=raw[key];
 return result;
}
let readerSettings=validateReaderSettings(stored(READER_SETTINGS_KEY,{})),readerSettingsDialog;
const readerSiteTheme=document.body.dataset.theme;
let readerClickTimer,readerPointer,readerAutoFrame=0,readerAutoArmed=false,readerAutoLock=false,readerLastY=window.scrollY,readerAutoSuppressUntil=0;
function resetReaderGestures(){clearTimeout(readerClickTimer);readerPointer=null;readerAutoArmed=false;readerLastY=window.scrollY;readerAutoSuppressUntil=Date.now()+300;}
function applyReaderSettings(){
 const s=readerSettings,palette=READER_PALETTES[s.preset],style=document.body.style;
 const values={'--reader-bg':s.colorMode==='custom'?s.backgroundColor:palette.background,'--reader-ink':s.colorMode==='custom'?s.textColor:palette.text,'--reader-font':READER_FONTS[s.fontFamily],'--reader-size':s.fontSize+'px','--reader-line':String(s.lineHeight),'--reader-gap':({compact:'.6em',normal:'1.15em',relaxed:'1.75em'})[s.paragraphSpacing],'--reader-width':({narrow:'32em',medium:'42em',wide:'52em'})[s.width],'--reader-indent':s.indent?'2em':'0','--reader-align':s.align};
 for(const [key,value] of Object.entries(values))style.setProperty(key,value);
 if(document.body.classList.contains('is-reading'))document.body.dataset.theme=s.preset;
 resetReaderGestures();syncReaderSettingsPanel();
}
function updateReaderSettings(changes){readerSettings=validateReaderSettings({...readerSettings,...changes});save(READER_SETTINGS_KEY,readerSettings);applyReaderSettings();}
function stopReaderPresentation(){resetReaderGestures();cancelAnimationFrame(readerAutoFrame);readerAutoFrame=0;readerAutoLock=false;document.body.classList.remove('is-reading');document.body.dataset.theme=readerSiteTheme;if(readerSettingsDialog?.open)readerSettingsDialog.close();}
function syncReaderSettingsPanel(){
 if(!readerSettingsDialog)return;
 readerSettingsDialog.querySelectorAll('[data-reader-setting]').forEach(input=>{const value=readerSettings[input.dataset.readerSetting];if(input.type==='checkbox')input.checked=value;else input.value=String(value);});
 readerSettingsDialog.querySelectorAll('[data-reader-output]').forEach(output=>{const key=output.dataset.readerOutput;output.textContent=readerSettings[key]+(key==='fontSize'?'px':'');});
 readerSettingsDialog.querySelectorAll('[data-reader-preset]').forEach(control=>control.setAttribute('aria-pressed',String(readerSettings.colorMode==='preset'&&control.dataset.readerPreset===readerSettings.preset)));
 readerSettingsDialog.querySelector('[data-reader-custom]').setAttribute('aria-pressed',String(readerSettings.colorMode==='custom'));
}
function openReaderSettings(){
 if(!readerSettingsDialog){
  const dialog=node('dialog','','reader-settings');dialog.id='reader-settings';dialog.setAttribute('aria-labelledby','reader-settings-title');
  const header=node('header','','reader-settings-header'),title=node('h2','阅读设置');title.id='reader-settings-title';const close=button('关闭',()=>dialog.close());close.setAttribute('aria-label','关闭阅读设置');header.append(title,close);dialog.append(header);
  function group(name){const fieldset=node('fieldset'),legend=node('legend',name);fieldset.append(legend);dialog.append(fieldset);return fieldset;}
  function field(parent,label,key,type,options){
   const row=node('label','','reader-setting-row'),input=node(type==='select'?'select':'input');input.dataset.readerSetting=key;input.setAttribute('aria-label',label);
   if(type==='select')for(const [value,text] of options){const option=node('option',text);option.value=value;input.append(option);}
   else input.type=type;
   row.append(node('span',label),input);parent.append(row);
   const change=()=>updateReaderSettings({[key]:type==='checkbox'?input.checked:type==='range'?Number(input.value):input.value,...(type==='color'?{colorMode:'custom'}:{})});
   input.addEventListener(type==='range'||type==='color'?'input':'change',change);return {row,input};
  }
  const appearance=group('外观'),presets=node('div','','reader-presets');presets.setAttribute('role','group');presets.setAttribute('aria-label','配色预设');
  for(const [id,palette] of Object.entries(READER_PALETTES)){const control=button(palette.label,()=>updateReaderSettings({preset:id,colorMode:'preset'}));control.dataset.readerPreset=id;presets.append(control);}appearance.append(presets);
  const custom=button('自定义颜色',()=>updateReaderSettings({colorMode:'custom'}));custom.dataset.readerCustom='';custom.className='reader-custom-mode';appearance.append(custom);
  field(appearance,'背景色','backgroundColor','color');field(appearance,'文字色','textColor','color');
  const typography=group('排版');field(typography,'字体','fontFamily','select',[['serif','宋体 / 衬线'],['sans','黑体'],['kai','楷体'],['system','系统默认']]);
  for(const [label,key,min,max,step] of [['字号','fontSize',14,26,1],['行高','lineHeight',1.5,2.4,.05]]){const {row,input}=field(typography,label,key,'range');row.classList.add('reader-setting-range');Object.assign(input,{min:String(min),max:String(max),step:String(step)});const output=node('output');output.dataset.readerOutput=key;row.append(output);}
  field(typography,'段间距','paragraphSpacing','select',[['compact','紧凑'],['normal','标准'],['relaxed','宽松']]);field(typography,'正文宽度','width','select',[['narrow','窄（32em）'],['medium','中（42em）'],['wide','宽（52em）']]);
  field(typography,'首行缩进','indent','checkbox');field(typography,'文字对齐','align','select',[['justify','两端对齐'],['left','左对齐']]);
  const navigation=group('翻页');field(navigation,'键盘翻页','keyboard','checkbox');field(navigation,'点击翻页','clickTurn','checkbox');navigation.append(node('p','正文左侧三分之一为上一章，右侧三分之一为下一章；中间不翻页，选中文字或拖动时不翻页。','reader-setting-help'));field(navigation,'章末自动续章','autoNext','checkbox');navigation.append(node('p','向下滚动至章末时加载下一章，最后一章停止。','reader-setting-help'));
  const footer=node('div','','reader-settings-footer'),reset=button('恢复默认',()=>{readerSettings={...READER_DEFAULTS};save(READER_SETTINGS_KEY,readerSettings);applyReaderSettings();});footer.append(reset);dialog.append(footer);
  let backdropDown=false;const outside=event=>{const rect=dialog.getBoundingClientRect();return event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom;};
  dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===dialog&&outside(event);});dialog.addEventListener('click',event=>{if(backdropDown&&event.target===dialog&&outside(event))dialog.close();backdropDown=false;});dialog.addEventListener('close',resetReaderGestures);
  document.body.append(dialog);readerSettingsDialog=dialog;
 }
 resetReaderGestures();syncReaderSettingsPanel();readerSettingsDialog.showModal();
}
function readingGestureAllowed(){return document.body.classList.contains('is-reading')&&currentIndex>=0&&!busy&&!readerSettingsDialog?.open;}
view.addEventListener('pointerdown',event=>{if(event.target.closest('.reader')){clearTimeout(readerClickTimer);readerPointer={x:event.clientX,y:event.clientY,moved:false};}});
document.addEventListener('pointermove',event=>{if(readerPointer&&(Math.abs(event.clientX-readerPointer.x)>8||Math.abs(event.clientY-readerPointer.y)>8))readerPointer.moved=true;},{passive:true});
view.addEventListener('click',event=>{
 const article=event.target.closest('.reader');clearTimeout(readerClickTimer);
 if(!article||!readerSettings.clickTurn||!readingGestureAllowed()||event.button!==0||event.detail>1||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||readerPointer?.moved||!window.getSelection()?.isCollapsed||event.target.closest('a,button,input,select,textarea,[contenteditable]'))return;
 const rect=article.getBoundingClientRect(),portion=(event.clientX-rect.left)/rect.width,next=portion<1/3?currentIndex-1:portion>2/3?currentIndex+1:currentIndex,version=viewVersion;
 if(next===currentIndex)return;
 readerClickTimer=setTimeout(()=>{if(article.isConnected&&version===viewVersion&&readingGestureAllowed()&&window.getSelection()?.isCollapsed)read(next);},220);
});
function checkReaderAutoNext(){
 readerAutoFrame=0;
 if(!readerSettings.autoNext||!readingGestureAllowed()||readerAutoLock||!readerAutoArmed||Date.now()<readerAutoSuppressUntil||currentIndex>=currentBook.chapters.length-1)return;
 const article=view.querySelector('.reader');if(!article||article.getBoundingClientRect().bottom>window.innerHeight+1)return;
 readerAutoArmed=false;readerAutoLock=true;Promise.resolve(read(currentIndex+1)).finally(()=>{readerAutoLock=false;});
}
function queueReaderAutoNext(event){
 const down=event.type==='wheel'?event.deltaY>0:window.scrollY>readerLastY+1;readerLastY=window.scrollY;
 if(!readerSettings.autoNext||!readingGestureAllowed()||Date.now()<readerAutoSuppressUntil)return;
 if(down)readerAutoArmed=true;if(!readerAutoFrame)readerAutoFrame=requestAnimationFrame(checkReaderAutoNext);
}
window.addEventListener('scroll',queueReaderAutoNext,{passive:true});window.addEventListener('wheel',queueReaderAutoNext,{passive:true});
async function api(route,params={},options={}){const r=await fetch('/api/'+route+'?'+new URLSearchParams(params),options);const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
function dismissError(){document.querySelector('#error-banner').hidden=true;document.body.classList.remove('has-feedback');}
function showError(message){document.querySelector('#error-message').textContent=message;document.querySelector('#error-banner').hidden=false;document.body.classList.add('has-feedback');}
function error(e){status.textContent='';showError(e.message);}
function emptyState(title,description,label,action){const section=node('section','','empty-state');section.append(node('h2',title),node('p',description));if(label&&action)section.append(button(label,action));return section;}
function showLoading(kind='search'){
 resetCovers();view.replaceChildren();const grid=node('div','',kind==='discover'?'discover-grid loading-grid':'grid loading-grid');grid.setAttribute('aria-busy','true');grid.setAttribute('aria-label','正在加载书单');
 for(let i=0;i<8;i++){const card=node('div','',kind==='discover'?'discover-card skeleton-card':'card skeleton-card');card.setAttribute('aria-hidden','true');const copy=node('div','','skeleton-copy');copy.append(node('div','','skeleton-line'),node('div','','skeleton-line short'));card.append(node('div','','skeleton-cover'),copy);grid.append(card);}view.append(grid);return grid;
}
let coverWarningShown=false;
function coverFailed(slot,notify=false){if(!slot.isConnected)return;slot.classList.remove('is-loading');slot.classList.add('is-failed');if(notify&&!coverWarningShown){coverWarningShown=true;showError('部分封面暂时无法加载，已显示文字占位。');}}

let progressTimer=null,activeReading=null;
function getProgress(book){
 const p=book?.progress;
 if(!p||!Number.isInteger(p.chapterIndex)||!Number.isInteger(p.totalChapters)||p.totalChapters<=0||p.chapterIndex<0||p.chapterIndex>=p.totalChapters||typeof p.chapterName!=='string'||!p.chapterName.trim()||!Number.isFinite(p.scrollRatio)||p.scrollRatio<0||p.scrollRatio>1||!Number.isFinite(p.updatedAt)||p.updatedAt<0)return null;
 return p;
}
function sameBook(a,b){return a?.source===b?.source&&a?.url===b?.url;}
function bookMetadata(book){return {name:book.name,author:book.author||'',url:book.url,source:book.source,sourceName:book.sourceName||book.source,cover:book.cover||''};}
function scrollRange(){const el=document.scrollingElement||document.documentElement;return Math.max(0,el.scrollHeight-el.clientHeight);}
function flushProgress(){
 clearTimeout(progressTimer);progressTimer=null;
 if(!activeReading||!document.querySelector('.reader'))return;
 const entry=shelf.find(b=>sameBook(b,activeReading));if(!entry||!getProgress(entry))return;
 const el=document.scrollingElement||document.documentElement,range=scrollRange();entry.progress={...entry.progress,scrollRatio:range?Math.min(1,Math.max(0,el.scrollTop/range)):0,updatedAt:Date.now()};save('shelf',shelf);
}
function leaveReading(){flushProgress();activeReading=null;}
function recordChapter(index,previousBook){
 const old=shelf.find(b=>sameBook(b,previousBook))||shelf.find(b=>sameBook(b,currentBook));
 const entry={...bookMetadata(currentBook),addedAt:Number.isFinite(old?.addedAt)?old.addedAt:Date.now(),progress:{chapterIndex:index,chapterName:currentBook.chapters[index].name,scrollRatio:0,totalChapters:currentBook.chapters.length,updatedAt:Date.now()}};
 shelf=shelf.filter(b=>!sameBook(b,previousBook)&&!sameBook(b,currentBook));shelf.push(entry);activeReading={source:entry.source,url:entry.url};save('shelf',shelf);
}
window.addEventListener('scroll',()=>{if(activeReading&&!progressTimer)progressTimer=setTimeout(flushProgress,800);},{passive:true});
window.addEventListener('beforeunload',flushProgress);window.addEventListener('pagehide',flushProgress);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushProgress();});
function sortedShelf(){return [...shelf].sort((a,b)=>{const pa=getProgress(a),pb=getProgress(b);return Number(!!pb)-Number(!!pa)||(pb?.updatedAt||0)-(pa?.updatedAt||0)||(b.addedAt||0)-(a.addedAt||0);});}
async function continueReading(entry){
 leaveReading();busy=false;const progress=getProgress(entry),version=++viewVersion;status.textContent='正在恢复阅读进度…';
 try{
  const book=await api('book',{source:entry.source,url:entry.url});if(version!==viewVersion)return;currentBook=book;currentIndex=-1;
  const matched=progress?book.chapters.findIndex(c=>c.name===progress.chapterName):-1;
  const index=matched>=0?matched:Math.min(progress?.chapterIndex||0,book.chapters.length-1);
  await read(index,progress?.scrollRatio||0);
 }catch(e){if(version===viewVersion)error(e);}
}
let readerMode=stored('readerMode','novel');if(!['novel','light'].includes(readerMode))readerMode='novel';
let activeView='discover',pendingDiscoveryReturn=false;
function modeSources(){return sources.filter(s=>(s.kind||'novel')===readerMode);}
function belongsToMode(book){return (sources.find(s=>s.id===book.source)?.kind||'novel')===readerMode;}
function syncReaderMode(){document.body.dataset.mode=readerMode;document.querySelectorAll('[data-reader-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.readerMode===readerMode)));}
function resetDiscoverMode(){const available=modeSources().filter(s=>s.discoverCategories?.length||s.discover?.facets?.length),preferred=stored('shiye.discover.source.'+readerMode,null),s=available.find(s=>s.id===preferred)||available[0];if(s)restoreDiscoverSource(s);}
async function changeReaderMode(next,nextView='discover'){
 if(!['novel','light'].includes(next))return;
 readerMode=next;save('readerMode',next);syncReaderMode();await sourcesReady;resetDiscoverMode();document.querySelector('#query').value='';
 if(document.body.classList.contains('is-reading')){pendingDiscoveryReturn=true;return;}
 pendingDiscoveryReturn=false;if(nextView==='shelf'){setMode('shelf');showShelf();}else await showDiscover();
}
function shelfCard(book,onRemove){
 const card=node('article','','card shelf-card'),info=node('div','','card-info'),p=getProgress(book);
 info.append(node('h2',book.name),node('p',book.author||'作者未知'));
 info.append(node('p',p?`读到 第 ${p.chapterIndex+1} 章 / 共 ${p.totalChapters} 章`:'未开始','progress-label'));
 if(p){const track=node('div','','progress-track'),fill=node('progress','','progress-fill');fill.max=p.totalChapters;fill.value=p.chapterIndex;fill.setAttribute('aria-label','章节阅读进度');track.append(fill);info.append(track);}
 const actions=node('div','','shelf-actions'),resume=button('继续阅读',()=>continueReading(book));resume.className='continue-button';actions.append(resume);
 if(onRemove){const remove=button('移出书架',()=>{if(!confirm(`将《${book.name}》移出书架？`))return;shelf=shelf.filter(b=>!sameBook(b,book));save('shelf',shelf);onRemove();});remove.className='remove-button';actions.append(remove);}
 info.append(actions);card.dataset.url=book.url;card.append(coverElement(book),info);return card;
}
function showShelf(){
 leaveReading();resetCovers();view.replaceChildren();view.append(node('h2',(readerMode==='novel'?'网文':'轻小说')+'书架'));
 const books=sortedShelf().filter(belongsToMode),grid=node('div','','shelf-grid');books.forEach(book=>grid.append(shelfCard(book,showShelf)));view.append(grid);
 if(!books.length){const other=readerMode==='novel'?'light':'novel',hasOther=shelf.some(b=>!belongsToMode(b));view.append(emptyState('这个书架还空着','阅读过的故事会留在对应模式的书架。',hasOther?'切到'+(other==='novel'?'网文':'轻小说'):'去发现',()=>hasOther?changeReaderMode(other,'shelf'):showDiscover()));}
 observeCovers();status.textContent=(readerMode==='novel'?'网文':'轻小说')+'书架 · '+books.length+' 本';
}
function showHome(){return showDiscover();}
// Shared lazy cover queue. Each attempt covers detail lookup and image loading.
let coverObserver,coverQueue=[],coverRunning=0;
const coverMetadata=new Map();
function categoryBadge(slot,category){if(!category)return;let badge=slot.querySelector('.category-badge');if(!badge){badge=node('span','','category-badge');slot.append(badge);}badge.textContent=category;badge.title=category;}
const coverTasks=new WeakMap(),coverControllers=new Set(),coverUrls=new Map();
function resetCovers(){coverWarningShown=false;coverObserver?.disconnect();coverQueue=[];for(const c of coverControllers)c.abort();}
function loadCoverImage(slot,url,signal){
 return new Promise((resolve,reject)=>{
  const img=new Image();img.alt=slot.dataset.name+' 封面';img.decoding='async';
  const cleanup=()=>{img.onload=null;img.onerror=null;signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();img.removeAttribute('src');reject(new Error('封面加载超时或取消'));};
  img.onload=()=>{cleanup();if(slot.isConnected){slot.querySelector('img')?.remove();slot.append(img);requestAnimationFrame(()=>requestAnimationFrame(()=>{if(slot.isConnected){slot.classList.remove('is-loading','is-failed');slot.classList.add('is-loaded');}}));}resolve();};
  img.onerror=()=>{cleanup();reject(new Error('封面图片不可用'));};
  if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});
  img.src='/api/image?'+new URLSearchParams({url});
 });
}
function pumpCovers(){
 while(coverRunning<4&&coverQueue.length){
  const task=coverQueue.shift();if(!task.slot.isConnected)continue;
  coverRunning++;
  (async()=>{
   for(let attempt=0;attempt<2&&task.slot.isConnected;attempt++){
    const controller=new AbortController();coverControllers.add(controller);const timer=setTimeout(()=>controller.abort(),task.book.source==='linovelib'?30000:5000);
    try{
     const key=task.book.source+':'+task.book.url;
     let url=task.book.cover||coverUrls.get(key);const known=coverMetadata.get(key)||task.book;if(known.category)categoryBadge(task.slot,known.category);
     // A known light-novel cover must not depend on a successful catalog lookup.
     if(url&&task.book.source==='linovelib'){
      if(!known.category)api('detail',{source:task.book.source,url:task.book.url},{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}).then(detail=>{if(coverMetadata.size>=500)coverMetadata.delete(coverMetadata.keys().next().value);coverMetadata.set(key,detail);if(task.slot.isConnected)categoryBadge(task.slot,detail.category);}).catch(()=>{});
      await loadCoverImage(task.slot,url,controller.signal);return;
     }
     if(!url||!known.category){const detail=await api('book',{source:task.book.source,url:task.book.url},{signal:controller.signal});url=detail.cover||url;if(coverMetadata.size>=500)coverMetadata.delete(coverMetadata.keys().next().value);coverMetadata.set(key,detail);categoryBadge(task.slot,detail.category);if(url){if(coverUrls.size>=500)coverUrls.delete(coverUrls.keys().next().value);coverUrls.set(key,url);}}
     if(!url){coverFailed(task.slot);return;}
     await loadCoverImage(task.slot,url,controller.signal);return;
    }catch{if(controller.signal.aborted&&!task.slot.isConnected)return;}
    finally{clearTimeout(timer);coverControllers.delete(controller);}
   }
   coverFailed(task.slot,true);
  })().finally(()=>{coverRunning--;pumpCovers();});
 }
}
function coverElement(book){
 const slot=node('div','','book-cover is-loading');slot.dataset.name=book.name;slot.setAttribute('role','img');slot.setAttribute('aria-label',book.name+' 封面');
 let hash=2166136261;for(const ch of book.name){hash=Math.imul(hash^ch.codePointAt(0),16777619)>>>0;}
 slot.classList.add('cover-tone-'+(hash%12));slot.append(node('span',Array.from(book.name.trim())[0]||'书','cover-initial'));
 categoryBadge(slot,book.category);coverTasks.set(slot,{slot,book});return slot;
}
function observeCovers(){
 if(!coverObserver)coverObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;coverObserver.unobserve(entry.target);coverQueue.push(coverTasks.get(entry.target));}pumpCovers();},{rootMargin:'0px'});
 view.querySelectorAll('.book-cover').forEach(slot=>coverObserver.observe(slot));
}
let viewVersion=0;
function setMode(mode){
 leaveReading();dismissError();stopReaderPresentation();busy=false;viewVersion++;currentIndex=-1;activeView=mode;
 document.querySelector('#shelf').setAttribute('aria-current',mode==='shelf'?'page':'false');return viewVersion;
}
const discoverState={source:null,category:null,page:1,facets:{},expandedFacets:{}};
function discoverStorageKey(source){return 'shiye.discover.'+source;}
function validatedFacets(source,memory){
 const values={};
 for(const facet of source.discover?.facets||[]){
  const raw=memory[facet.id],value=typeof raw==='string'||typeof raw==='number'?String(raw):String(facet.default),parts=facet.multiple?value.split(facet.separator||'-'):[value];
  const valid=parts.every(v=>facet.options.some(option=>String(option.value)===v))&&!(parts.length>1&&parts.includes(String(facet.default)));
  values[facet.id]=!valid?String(facet.default):facet.multiple?facet.options.map(option=>String(option.value)).filter(v=>parts.includes(v)).join(facet.separator||'-'):value;
 }
 return values;
}
function restoreDiscoverSource(source,memory=stored(discoverStorageKey(source.id),{})){
 if(!memory||typeof memory!=='object'||Array.isArray(memory))memory={};
 const category=source.discoverCategories.find(c=>String(c.id)===String(memory.category))?.id||source.discoverCategories[0]?.id;
 Object.assign(discoverState,{source:source.id,category,facets:validatedFacets(source,memory),page:1,expandedFacets:{}});
}
function rememberDiscoverSource(){
 const source=sources.find(s=>s.id===discoverState.source);if(!source)return;
 const value=source.discover?.facets?.length?validatedFacets(source,discoverState.facets):{category:discoverState.category};
 save(discoverStorageKey(source.id),value);
}
function resetDiscoverFilters(source){
 try{localStorage.removeItem(discoverStorageKey(source.id));}catch{status.textContent='浏览器存储不可用，无法清除筛选记忆';}
 restoreDiscoverSource(source,{});showDiscover();
}
function renderDiscoverFacets(container,facets){
 const filters=node('section','','discover-filters');filters.setAttribute('aria-label','筛选条件');
 facets.forEach((facet,index)=>{
  const row=node('div','',index===0?'facet-sort':'facet-row'),label=node('span',facet.name,'facet-label'),options=node('div','','facet-options');row.dataset.facet=facet.id;row.setAttribute('role','group');row.setAttribute('aria-label',facet.name);
  const collapsible=!!facet.collapsible,toggleArea=node('span','','facet-toggle');
  function renderOptions(){
   options.replaceChildren();toggleArea.replaceChildren();const expanded=discoverState.expandedFacets[facet.id]!==false,visible=collapsible&&!expanded?facet.options.slice(0,9):facet.options;
   visible.forEach(option=>{const value=String(option.value),selected=facet.multiple?discoverState.facets[facet.id].split(facet.separator||'-'):[discoverState.facets[facet.id]],chip=button(option.label,()=>{if(facet.multiple&&value!==String(facet.default)){const next=new Set(selected.filter(v=>v!==String(facet.default)));next.has(value)?next.delete(value):next.add(value);discoverState.facets[facet.id]=facet.options.map(o=>String(o.value)).filter(v=>next.has(v)).join(facet.separator||'-')||String(facet.default);}else discoverState.facets[facet.id]=value;rememberDiscoverSource();showDiscover(undefined,1);});chip.className='category-chip facet-option';chip.dataset.value=value;chip.setAttribute('aria-pressed',String(selected.includes(value)));options.append(chip);});
   if(collapsible){const toggle=button(expanded?'收起':'展开',()=>{discoverState.expandedFacets[facet.id]=!expanded;renderOptions();});toggle.className='facet-expand';toggle.setAttribute('aria-expanded',String(expanded));toggleArea.append(toggle);}
  }
  renderOptions();row.append(label,options);if(collapsible)row.append(toggleArea);(index===0?container:filters).append(row);
 });container.append(filters);
}
async function showDiscover(category,page){
 await sourcesReady;
 const available=modeSources().filter(s=>s.discoverCategories?.length||s.discover?.facets?.length);if(!available.length){setMode('discover');resetCovers();view.replaceChildren(emptyState('暂时没有可用书单','请稍后再试。'));return;}pendingDiscoveryReturn=false;
 const selected=available.find(s=>s.id===discoverState.source)||available[0];if(discoverState.source!==selected.id)restoreDiscoverSource(selected);
 const facets=selected.discover?.facets||[];for(const facet of facets){const values=facet.multiple?(discoverState.facets[facet.id]||'').split(facet.separator||'-'):[discoverState.facets[facet.id]];if(!values.every(v=>facet.options.some(option=>String(option.value)===v)))discoverState.facets[facet.id]=String(facet.default);}
 discoverState.category=category||discoverState.category||selected.discoverCategories[0]?.id;discoverState.page=page||1;
 const version=setMode('discover');resetCovers();view.replaceChildren();window.scrollTo(0,0);status.textContent='正在加载分类书单…';
 const heading=node('div','','discover-heading'),reset=button('重置筛选',()=>resetDiscoverFilters(selected));reset.className='reset-discover';heading.append(node('p',(readerMode==='novel'?'网文发现':'轻小说发现')+' · '+selected.name),reset);view.append(heading);
 if(available.length>1){const select=node('select');select.setAttribute('aria-label','发现书源');available.forEach(s=>{const o=node('option',s.name);o.value=s.id;o.selected=s.id===selected.id;select.append(o);});select.onchange=()=>{save('shiye.discover.source.'+readerMode,select.value);restoreDiscoverSource(available.find(s=>s.id===select.value));showDiscover();};view.append(select);}
 if(facets.length)renderDiscoverFacets(view,facets);
 else{const chips=node('div','','category-chips');selected.discoverCategories.forEach(c=>{const chip=button(c.name,()=>{discoverState.category=c.id;rememberDiscoverSource();showDiscover(c.id,1);});chip.className='category-chip';chip.dataset.category=c.id;chip.setAttribute('aria-pressed',String(c.id===discoverState.category));chips.append(chip);});view.append(chips);}
 const categoryId=discoverState.category,pageNumber=discoverState.page;
 const loading=node('div','','discover-grid loading-grid');loading.setAttribute('aria-busy','true');loading.setAttribute('aria-label','正在加载书单');for(let i=0;i<8;i++){const card=node('div','','discover-card skeleton-card');card.setAttribute('aria-hidden','true');card.append(node('div','','skeleton-cover'),node('div','','skeleton-line'));loading.append(card);}view.append(loading);
 try{
  const data=await api('discover',{source:selected.id,...(facets.length?{...discoverState.facets}:{category:categoryId}),page:pageNumber});if(version!==viewVersion)return;loading.remove();
  const grid=node('div','','discover-grid');
  data.items.forEach(book=>{const b={...book,source:selected.id};const card=button('',()=>openBook(b));card.className='discover-card';card.dataset.url=b.url;card.append(coverElement(b),node('span',b.name,'discover-name'));if(b.author||b.imprint||b.status){const meta=node('span','','discover-card-meta');if(b.author)meta.append(node('span',b.author,'discover-author'));if(b.imprint)meta.append(node('span',b.imprint,'imprint-tag'));if(b.status)meta.append(node('span',b.status,'book-status'));if(b.updated)meta.title='更新于 '+b.updated;card.append(meta);}grid.append(card);});view.append(grid);
  if(!data.items.length)view.append(emptyState('这里暂时没有书','试试其他分类，找一个新的故事。'));
  const navigation=node('div','','discover-pagination'),previous=button('← 上一页',()=>showDiscover(categoryId,pageNumber-1)),next=button('下一页 →',()=>showDiscover(categoryId,pageNumber+1));previous.id='discover-prev';next.id='discover-next';previous.disabled=pageNumber===1;next.disabled=!data.hasNextPage;navigation.append(previous,node('span','第 '+pageNumber+' 页'),next);view.append(navigation);observeCovers();const summary=facets.length?facets.map((facet,index)=>index===0||discoverState.facets[facet.id]!==String(facet.default)?facet.options.filter(option=>(facet.multiple?discoverState.facets[facet.id].split(facet.separator||'-'):[discoverState.facets[facet.id]]).includes(String(option.value))).map(option=>option.label).join('、'):'').filter(Boolean):[selected.discoverCategories.find(c=>c.id===categoryId).name];status.textContent=[...summary,'第 '+pageNumber+' 页',data.items.length+' 本书'].join(' · ');
 }catch(e){if(version===viewVersion){loading.remove();error(e);view.append(emptyState('书单暂时没有加载出来','请稍后再试，或切换一个分类。','重试',()=>showDiscover(categoryId,pageNumber)));}}
}
function showBooks(books){resetCovers();view.replaceChildren();const grid=node('div','','grid');books.forEach(b=>{const c=node('article','','card');const info=node('div','','card-info');info.append(node('h2',b.name),node('p',b.author||'作者未知'),node('p',b.sourceName||b.source),button('查看目录 →',()=>openBook(b)));c.append(coverElement(b),info);grid.append(c);});view.append(grid);observeCovers();if(!books.length)view.append(emptyState('没有找到这本书',readerMode==='novel'?'换个书名试试':'换个书名或日文原名试试','重新搜索',()=>document.querySelector('#query').focus()));}
async function openBook(b){leaveReading();stopReaderPresentation();dismissError();const version=++viewVersion;status.textContent='正在获取书籍与完整目录…';try{const detail=await api('book',{source:b.source,url:b.url});if(version!==viewVersion)return;currentBook=detail;currentIndex=-1;renderBook();status.textContent='共 '+currentBook.chapters.length+' 章';}catch(e){error(e);}}
function renderBook(){if(pendingDiscoveryReturn){pendingDiscoveryReturn=false;showDiscover();return;}leaveReading();stopReaderPresentation();resetCovers();view.replaceChildren();const b=currentBook;const d=node('section','','detail');d.append(coverElement(b));const info=node('div');info.append(node('h2',b.name));const meta=[b.category,b.status,b.updateTime?'更新于 '+b.updateTime:'',b.latestChapter?'最新 '+b.latestChapter:''].filter(Boolean);if(meta.length)info.append(node('p',meta.join(' · '),'book-meta'));info.append(node('p',b.author),node('p',b.intro,'intro'));const toggle=button('',()=>{const i=shelf.findIndex(x=>x.url===b.url&&x.source===b.source);if(i<0)shelf.push({...bookMetadata(b),addedAt:Date.now()});else{if(!confirm(`将《${b.name}》移出书架？`))return;shelf.splice(i,1);}save('shelf',shelf);renderBook();});toggle.textContent=shelf.some(x=>x.url===b.url&&x.source===b.source)?'移出书架':'加入书架';info.append(toggle);d.append(info);view.append(d);const list=node('div','','chapters');b.chapters.forEach((c,i)=>list.append(button(c.name,()=>read(i))));view.append(list);observeCovers();}
async function read(index,restoreRatio=0){
 if(busy||!currentBook||index<0||index>=currentBook.chapters.length)return false;
 resetReaderGestures();flushProgress();const previousBook=currentBook,version=++viewVersion;busy=true;status.textContent='正在读取章节…';
 try{
  const c=currentBook.chapters[index],data=await api('chapter',{source:currentBook.source,url:c.url,bookTitle:currentBook.name,chapterIndex:index,chapterTitle:c.name});if(version!==viewVersion)return false;
  const fromName=sources.find(s=>s.id===data.switchedFrom)?.name||data.switchedFrom;
  if(data.switchedFrom&&data.resolvedBook){currentBook=data.resolvedBook;index=data.chapterIndex;}
  currentIndex=index;leaveReading();document.body.classList.add('is-reading');applyReaderSettings();dismissError();resetCovers();view.replaceChildren();
  const bar=node('div','','toolbar'),settings=button('设置',openReaderSettings);settings.dataset.openReaderSettings='';settings.setAttribute('aria-haspopup','dialog');settings.setAttribute('aria-controls','reader-settings');
  bar.append(button('← 返回目录',()=>{currentIndex=-1;renderBook();}),node('span',`第 ${index+1} / ${currentBook.chapters.length} 章`,'chapter-count'),settings);
  const article=node('article','','reader');article.tabIndex=0;article.setAttribute('aria-label','正文');
  if(data.switchedFrom){const notice=node('p',`已从『${fromName}』切换到『${data.sourceName}』`,'source-notice');notice.setAttribute('role','status');article.append(notice);}
  article.append(node('h1',data.title||currentBook.chapters[index].name));data.paragraphs.forEach(p=>article.append(node('p',p)));
  const nav=node('div','','nav'),prev=button('← 上一章',()=>read(currentIndex-1)),next=button('下一章 →',()=>read(currentIndex+1));prev.disabled=index===0;next.disabled=index===currentBook.chapters.length-1;
  nav.append(prev,node('span',`第 ${index+1} / ${currentBook.chapters.length} 章`,'chapter-count'),next);view.append(bar,article,nav);status.textContent=`${index+1} / ${currentBook.chapters.length}`;
  window.scrollTo(0,0);recordChapter(index,previousBook);
  if(restoreRatio>0){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(version!==viewVersion)return false;window.scrollTo(0,Math.min(1,restoreRatio)*scrollRange());flushProgress();}
  resetReaderGestures();return true;
 }catch(e){if(version===viewVersion)error(e);return false;}finally{if(version===viewVersion)busy=false;}
}

document.querySelector('#search').onsubmit=async e=>{
 e.preventDefault();await sourcesReady;const q=document.querySelector('#query').value.trim();if(!q){showDiscover();return;}
 const version=setMode('search'),mode=readerMode;showLoading();status.textContent='正在搜索'+(mode==='novel'?'网文':'轻小说')+'…';
 try{
  const batches=await Promise.all(modeSources().filter(s=>s.searchSupported!==false).map(async s=>{try{return await api('search',{q,source:s.id});}catch(e){return {results:[],errors:[{source:s.id,message:e.message}]};}}));
  if(version!==viewVersion||mode!==readerMode)return;const results=batches.flatMap(b=>b.results),errors=batches.flatMap(b=>b.errors);showBooks(results);status.textContent='找到 '+results.length+' 本'+(mode==='novel'?'网文':'轻小说');
  if(errors.length)showError(errors.map(e=>(sources.find(s=>s.id===e.source)?.name||e.source)+'：'+e.message).join('；'));
 }catch(e){if(version===viewVersion){view.querySelector('.loading-grid')?.remove();error(e);}}
};
document.querySelector('#query').addEventListener('blur',()=>{if(!document.querySelector('#query').value.trim()&&activeView==='search'&&!document.body.classList.contains('is-reading'))showDiscover();});
document.querySelectorAll('[data-reader-mode]').forEach(b=>b.onclick=()=>{if(b.dataset.readerMode!==readerMode)changeReaderMode(b.dataset.readerMode).catch(error);});
document.querySelector('#shelf').onclick=async()=>{await sourcesReady;pendingDiscoveryReturn=false;setMode('shelf');showShelf();};
document.addEventListener('keydown',e=>{if(!readerSettings.keyboard||!readingGestureAllowed()||e.defaultPrevented||e.repeat||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.target.closest('input,select,textarea,[contenteditable]')||!window.getSelection()?.isCollapsed)return;if(e.key==='ArrowLeft'){e.preventDefault();read(currentIndex-1);}if(e.key==='ArrowRight'){e.preventDefault();read(currentIndex+1);}});
document.querySelector('#error-dismiss').onclick=dismissError;
document.querySelector('.brand').onclick=e=>{e.preventDefault();showDiscover();};
let headerFrame=0;const updateHeader=()=>document.querySelector('.site-header').classList.toggle('is-scrolled',window.scrollY>8);window.addEventListener('scroll',()=>{if(!headerFrame)headerFrame=requestAnimationFrame(()=>{headerFrame=0;updateHeader();});},{passive:true});updateHeader();
const sourcesReady=api('sources').then(data=>{sources=data;}).catch(error);
applyReaderSettings();save('readerMode',readerMode);syncReaderMode();setMode('discover');showLoading('discover');sourcesReady.then(()=>{resetDiscoverMode();return showDiscover();}).catch(error);
