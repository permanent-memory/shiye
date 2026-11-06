 'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const {directRequest}=require('./direct-request');
const { searchHTML, pageHTML, fetchImageBuffer, closeBrowser } = require('./browser');
const sources = fs.readdirSync(path.join(__dirname, 'sources')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(__dirname,'sources',f),'utf8')));
const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();
const discoverCache = new Map(), metadataCache = new Map();
const cache = new Map(), booksCache = new Map(), chapterCache = new Map();
const imageCache = new Map(), pendingImages = new Map();
async function browserImage(url){
 const hit=imageCache.get(url);
 if(hit&&Date.now()-hit.time<3600000)return hit.data;
 imageCache.delete(url);
 if(pendingImages.has(url))return pendingImages.get(url);
 const operation=(async()=>{
  const {buffer,contentType}=await fetchImageBuffer(url),data={buffer,type:contentType};
  if(imageCache.size>=100)imageCache.delete(imageCache.keys().next().value);
  imageCache.set(url,{data,time:Date.now()});return data;
 })();
 pendingImages.set(url,operation);
 try{return await operation;}finally{pendingImages.delete(url);}
}
function remember(map,key,data,ttl=300000){if(map.size>=500)map.delete(map.keys().next().value);map.set(key,{data,time:Date.now(),ttl});return data;}
function cached(map,key){const item=map.get(key);if(item && Date.now()-item.time<item.ttl)return item.data;map.delete(key);}
function checkDeadline(){const ctx=requestContext.getStore();if(ctx?.signal.aborted)throw new Error('自动换源超时');}

function absolute(value, s) { return value ? new URL(value, s.baseUrl).href : ''; }
function allowed(value, s) {
 const u = new URL(absolute(value,s));
 if (!['http:','https:'].includes(u.protocol) || u.hostname !== new URL(s.baseUrl).hostname) throw new Error('URL 必须属于所选书源');
 return u.href;
}
function rule($, el, spec) {
 const i=spec.lastIndexOf('@'); const selector=i<0?spec:spec.slice(0,i); const attr=i<0?'text':spec.slice(i+1);
 const node=selector?$(el).find(selector).first():$(el);
 return (attr==='text'?node.text():attr==='html'?node.html():node.attr(attr)||'')?.trim()||'';
}
async function request(url, options={}) {
 let last;
 for(let attempt=0;attempt<2;attempt++) {
  checkDeadline();
  const controller=new AbortController(); const ctx=requestContext.getStore();const abort=()=>controller.abort();ctx?.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.min(15000,ctx?Math.max(1,ctx.deadline-Date.now()):15000));
  try {
   if(options.direct)return await directRequest(url,{...options,signal:controller.signal});
   const res=await fetch(url,{...options,signal:controller.signal});
   if(!res.ok) throw new Error(`上游 HTTP ${res.status}`);
   const buffer=Buffer.from(await res.arrayBuffer());
   if(!buffer.length) throw new Error('上游返回空响应');
   return {buffer,type:res.headers.get('content-type')||''};
  } catch(e) {last=e;} finally {clearTimeout(timer);ctx?.signal.removeEventListener('abort',abort);}
 }
 throw new Error(last.name==='AbortError'?'请求超时（15 秒，已重试 1 次）':last.message);
}
async function document(url,s, options={}) {
 const response=await request(url,{...options,direct:!!s.direct,headers:{'User-Agent':'Mozilla/5.0','Accept-Language':'zh-CN,zh;q=0.9',...s.headers,...options.headers}});
 const charset=response.type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1]||'utf-8';
 return cheerio.load(new TextDecoder(charset).decode(response.buffer));
}
async function search(s,key) {
 checkDeadline();
 if(s.search.unsupported) throw new Error(s.search.unsupportedMessage||'该源暂不支持搜索');
 const ck=s.id+':'+key; const previous=cache.get(ck); if(previous&&Date.now()-previous.time<60000) return previous.data;
 const replace=v=>v.replaceAll('{{key}}',encodeURIComponent(key));
 const url=absolute(replace(s.search.url),s);
 const options={method:s.search.method||'GET',...(s.search.body?{body:replace(s.search.body)}:{}),headers:{'Content-Type':'application/x-www-form-urlencoded',...(s.search.referer?{Referer:s.search.referer}:{})}};
 const $=s.search.needsBrowser?cheerio.load(await searchHTML(s,url,options)):await document(url,s,options);
 const results=[]; const seen=new Set();
 $(s.search.rules.list).each((_,el)=>{const r=s.search.rules; const url=absolute(rule($,el,r.url),s); const name=rule($,el,r.name); if(url&&name&&!seen.has(url)){seen.add(url);results.push({source:s.id,sourceName:s.name,name,url,author:rule($,el,r.author)});}});
 if(!results.length && /搜索间隔/.test($.html())) throw new Error('站点搜索限流，请等待 15 秒后重试');
 cache.set(ck,{time:Date.now(),data:results}); return results;
}
function chapterNumber(name){const match=name.match(/第([0-9０-９一二三四五六七八九十百千万零〇两]+)[章回节話话－-]/);if(!match)return /序|楔子/.test(name)?0:Infinity;const t=match[1].normalize('NFKC');if(/^\d+$/.test(t))return Number(t);const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9},units={十:10,百:100,千:1000,万:10000};let sum=0,value=0;for(const c of t){if(c in digits)value=digits[c];else{sum+=(value||1)*units[c];value=0;}}return sum+value;}
async function detail(s,url){
 checkDeadline();url=allowed(url,s);const key=s.id+':'+url,hit=cached(metadataCache,key);if(hit)return hit;
 const $=await document(url,s); const r=s.detail.rules;
 const data={source:s.id,sourceName:s.name,url,name:rule($,$.root(),r.name),author:rule($,$.root(),r.author),intro:rule($,$.root(),r.intro),cover:absolute(rule($,$.root(),r.cover),s)};
 for(const field of ['category','status','updateTime','latestChapter'])data[field]=r[field]?rule($,$.root(),r[field]):'';
 data.updateTime=data.updateTime.replace(/^(?:更新时间|最后更新|更新于)[:：\s]*/,'');
 if(!data.name) throw new Error('未找到书籍详情，站点可能拦截了请求');
 if(metadataCache.size>=100)metadataCache.delete(metadataCache.keys().next().value);
 return remember(metadataCache,key,{data,$},60000);
}
async function book(s,url){
 checkDeadline();const key=s.id+':'+url,hit=cached(booksCache,key);if(hit)return hit;
 url=allowed(url,s);const id=[s.bookIdPattern,...(s.bookIdPatterns||[])].map(pattern=>url.match(new RegExp(pattern))?.[1]).find(Boolean);if(!id)throw new Error('无法提取书籍 id');
 const {data:metadata,$}=await detail(s,url),data={...metadata};
 const catalogHref=s.detail.catalogUrlRule?rule($,$.root(),s.detail.catalogUrlRule):'';
 const catalogUrl=allowed(catalogHref||s.detail.catalogUrl.replaceAll('{{id}}',id),s),c=await document(catalogUrl,s);
 const pages=s.catalog.pages,urls=pages?c(pages.list).toArray().map(el=>allowed(rule(c,el,pages.url),s)):[];
 const ordered=urls.length?[...new Set(urls)].slice(0,50):[catalogUrl],seen=new Set();data.chapters=[];
 for(const pageUrl of ordered){const page=pageUrl===catalogUrl?c:pageUrl===url?$:await document(pageUrl,s);page(s.catalog.list).each((_,el)=>{const u=absolute(rule(page,el,s.catalog.url),s),name=rule(page,el,s.catalog.name);if(u&&name&&!seen.has(u)){seen.add(u);data.chapters.push({name,url:u});}});}
 if(s.catalog.sortBy==='chapterNumber')data.chapters.sort((a,b)=>chapterNumber(a.name)-chapterNumber(b.name));
 if(!data.chapters.length) throw new Error('未找到目录章节，请检查书源规则');
 return remember(booksCache,key,data,60000);
}
function discoverField($,el,spec){
 if(typeof spec==='string')return rule($,el,spec);
 const value=rule($,el,spec.selector),part=(spec.split?value.split(spec.split)[spec.index||0]||'':value).trim();return spec.pattern?part.match(new RegExp(spec.pattern))?.[spec.group||0]||'':part;
}
async function discover(s,category,page,facets={}){
 const key=JSON.stringify([s.id,category,page,facets]);const hit=cached(discoverCache,key);if(hit)return hit;
 const d=s.discover,pageSize=d.pageSize||10,upstreamSize=d.upstreamPageSize||pageSize;
 const pattern=n=>absolute(d.pagePattern.replaceAll('{id}',encodeURIComponent(category||'')).replaceAll('{page}',String(n)).replace(/\{([^{}]+)\}/g,(_,id)=>encodeURIComponent(facets[id]??'')),s);
 async function upstream(n){
  const cacheKey=JSON.stringify(['upstream',s.id,category,n,facets]);const hit=cached(discoverCache,cacheKey);if(hit)return hit;
  const url=allowed(pattern(n),s),$=d.needsBrowser?cheerio.load(d.browserNavigation?await pageHTML(s,url):await searchHTML(s,url,{method:'GET'})):await document(url,s);
  const items=[],seen=new Set();
  $(d.rules.list).each((_,el)=>{const name=rule($,el,d.rules.name),href=rule($,el,d.rules.url);if(!name||!href)return;const url=absolute(href,s);if(seen.has(url))return;seen.add(url);const item={name,url,cover:absolute(rule($,el,d.rules.cover),s)};for(const field of ['imprint','author','status','updated'])if(d.rules[field])item[field]=discoverField($,el,d.rules[field]);items.push(item);});
  const hasNextPage=items.length>0&&$('a[href]').toArray().some(el=>absolute($(el).attr('href'),s)===pattern(n+1));
  return remember(discoverCache,cacheKey,{items,hasNextPage},60000);
 }
 const offset=(page-1)*pageSize;let upstreamPage=Math.floor(offset/upstreamSize)+1,skip=offset%upstreamSize,hasNextPage=false;const items=[];
 while(items.length<pageSize){
  const batch=await upstream(upstreamPage),take=batch.items.slice(skip,skip+pageSize-items.length);items.push(...take.map(item=>({...item})));
  hasNextPage=skip+take.length<batch.items.length||batch.hasNextPage;
  if(items.length===pageSize||!batch.hasNextPage)break;
  upstreamPage++;skip=0;
 }
 if(d.resolveCovers){
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{while(cursor<items.length){const item=items[cursor++];if(item.cover)continue;try{const metadata=(await detail(s,item.url)).data;item.cover=metadata.cover;item.category=metadata.category;}catch{ /* The client keeps its placeholder when detail metadata is unavailable. */ }}}));
 }
 return remember(discoverCache,key,{items,hasNextPage},60000);
}
async function chapter(s,url) {
 checkDeadline();
 const $=await document(allowed(url,s),s); const container=$(s.content.container).first();
 if(!container.length) throw new Error(`未找到正文容器：${s.content.container}`);
 if(s.content.unavailable && container.find(s.content.unavailable).length)throw new Error('上游暂不提供本章节：'+container.find(s.content.unavailable).text().trim());
 const title=s.content.title?rule($,$.root(),s.content.title):$('h1').first().text().trim();
 if(s.content.decodeBase64Calls)container.find('script').each((_,el)=>{const html=[...$(el).text().matchAll(/qsbs\.bb\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/g)].map(m=>Buffer.from(m[1],'base64').toString('utf8')).join('');if(html)$(el).replaceWith(html);});
 if(s.content.removeSelectors)container.find(s.content.removeSelectors).remove();
 container.find('script,style,ins,iframe').remove(); container.find('br').replaceWith('\n');
 container.find('p,div').each((_,el)=>{$(el).prepend('\n').append('\n');});
 const filters=s.content.removeLinesMatching.map(v=>new RegExp(v,'i'));
 const paragraphs=container.text().split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!filters.some(re=>re.test(v)));
 if(!paragraphs.length) throw new Error('正文容器内没有有效内容');
 if(/沒[有无]可閱讀的章節|没有可阅读的章节|审[核查]未通过|審[核查]未通過|需要足[夠够]的[權权]限/.test(paragraphs.join('')))throw new Error('上游暂不提供本章节：正文为权限或审核提示');
 return {title,paragraphs,content:paragraphs.join('\n\n')};
}

function normalize(value){return (value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');}
function shortTitle(value){return value.split(/[～~（(]/)[0].trim();}
function titleScore(a,b){a=normalize(a);b=normalize(b);if(a===b)return 1;if(a&&b&&(a.includes(b)||b.includes(a)))return Math.min(a.length,b.length)/Math.max(a.length,b.length);return 0;}
function chapterPosition(chapters,index,title){
 const clean=v=>normalize(v).replace(/^第[零〇一二三四五六七八九十百千万两\d]+[章话話回节節卷]/,'');
 const wanted=clean(title);let best=-1,score=0;
 if(wanted)chapters.forEach((c,i)=>{const candidate=clean(c.name);const s=titleScore(wanted,candidate);if(s>score){score=s;best=i;}});
 if(score>=0.65)return best;
 return Number.isInteger(index)&&index>=0&&index<chapters.length?index:-1;
}
async function resolveChapter(s,url,params){
 const key=JSON.stringify([s.id,url,params.bookTitle,params.chapterIndex,params.chapterTitle]);
 const hit=cached(chapterCache,key);if(hit)return hit;
 const controller=new AbortController(),deadline=Date.now()+28000;const timer=setTimeout(()=>controller.abort(),28000);
 let originalError='请求超时',errors=[];
 const operation=requestContext.run({signal:controller.signal,deadline},async()=>{
  try{return remember(chapterCache,key,{...await chapter(s,url),source:s.id,sourceName:s.name,url});}
  catch(e){originalError=e.message;errors.push({source:s.id,message:e.message});}
  if(!params.bookTitle){const e=new Error(originalError);e.errors=errors;throw e;}
  const query=shortTitle(params.bookTitle);
  for(const alternative of sources.filter(other=>other.id!==s.id).slice(0,3)){
   checkDeadline();
   try{
    const results=await search(alternative,query);checkDeadline();
    const candidates=results.map(b=>({...b,score:Math.max(titleScore(b.name,params.bookTitle),titleScore(b.name,query))})).filter(b=>b.score>=0.65).sort((a,b)=>b.score-a.score).slice(0,3);
    if(!candidates.length)throw new Error('未找到匹配书籍：'+query);
    const failures=[];
    for(const candidate of candidates){
     try{
      checkDeadline();const resolvedBook=await book(alternative,candidate.url);checkDeadline();
      const chapterIndex=chapterPosition(resolvedBook.chapters,params.chapterIndex,params.chapterTitle);
      if(chapterIndex<0)throw new Error('目录中没有对应章节');
      const target=resolvedBook.chapters[chapterIndex];const content=await chapter(alternative,target.url);checkDeadline();
      return remember(chapterCache,key,{...content,title:target.name,source:alternative.id,sourceName:alternative.name,url:target.url,switchedFrom:s.id,resolvedBook,chapterIndex});
     }catch(e){failures.push(candidate.name+'：'+e.message);checkDeadline();}
    }
    throw new Error(failures.join('；'));
   }catch(e){errors.push({source:alternative.id,message:e.message});}
  }
  const e=new Error('所有书源都找不到可读章节：'+originalError);e.originalError=originalError;e.errors=errors;throw e;
 });
 try{return await Promise.race([operation,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>{const e=new Error('所有书源都找不到可读章节：自动换源超时');e.originalError=originalError;e.errors=[...errors,{source:'fallback',message:'总耗时达到 28 秒上限'}];reject(e);},{once:true}))]);}
 finally{clearTimeout(timer);}
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function createServer(){
return http.createServer(async(req,res)=>{
 try {
 const u=new URL(req.url,'http://127.0.0.1'); const q=u.searchParams;
 if(u.pathname==='/api/sources') return json(res,200,sources.map(({id,name,lang,baseUrl,search,discover,kind})=>({id,name,lang,baseUrl,kind:kind||'novel',searchSupported:!search.unsupported,discoverCategories:discover?.categories||[],discover:{facets:discover?.facets||[]}})));
 if(u.pathname==='/api/discover'){
  const page=q.get('page')??'1';if(!/^[1-9][0-9]*$/.test(page)||!Number.isSafeInteger(Number(page)))return json(res,400,{error:'page 必须为从 1 开始的整数'});
  const s=sources.find(s=>s.id===q.get('source'));if(!s?.discover)return json(res,400,{error:'该书源不支持发现或书源不存在'});
  const category=q.get('category'),legacy=s.discover.categories?.find(c=>String(c.id)===category),facets={};
  if(category&&!legacy)return json(res,400,{error:'未知分类'});
  if(s.discover.facets?.length){
   for(const facet of s.discover.facets){const value=String(q.get(facet.id)??legacy?.facets?.[facet.id]??facet.default),values=facet.multiple?value.split(facet.separator||'-'):[value];if(!values.every(v=>facet.options.some(option=>String(option.value)===v))||(values.length>1&&values.includes(String(facet.default))))return json(res,400,{error:'未知筛选值：'+facet.id});facets[facet.id]=facet.multiple?facet.options.map(option=>String(option.value)).filter(v=>values.includes(v)).join(facet.separator||'-'):value;}
  }else if(!legacy)return json(res,400,{error:'未知分类'});
  return json(res,200,await discover(s,s.discover.facets?.length?null:category,Number(page),facets));
 }
 if(u.pathname==='/api/search') {
  const key=q.get('q')?.trim(); if(!key) return json(res,400,{error:'请输入书名'});
  const selected=sources.filter(s=>!q.get('source')||s.id===q.get('source')); if(!selected.length) return json(res,400,{error:'未知书源'});
  const results=[],errors=[];
  await Promise.all(selected.map(async s=>{try{results.push(...await search(s,key));}catch(e){errors.push({source:s.id,message:e.message});}}));
  return json(res,200,{results,errors});
 }
 if(u.pathname==='/api/image') {
  const target=q.get('url'); const s=sources.find(s=>{try{return new URL(target).hostname===new URL(s.baseUrl).hostname;}catch{return false;}});
  if(!s) return json(res,400,{error:'只允许代理已配置书源的图片'});
  const url=allowed(target,s);
  const result=s.needsBrowserForImage||s.discover?.needsBrowser?await browserImage(url):await request(url,{direct:!!s.direct,headers:{...s.headers,Referer:s.baseUrl+'/'}});
  if(!result.type.startsWith('image/')) throw new Error('上游未返回图片');
  res.writeHead(200,{'Content-Type':result.type,'Cache-Control':'public, max-age=3600'});return res.end(result.buffer);
 }
 if(['/api/book','/api/detail','/api/catalog','/api/chapter','/api/content'].includes(u.pathname)){
  const s=sources.find(s=>s.id===q.get('source'));if(!s)return json(res,400,{error:'需要有效 source'});
  let url=q.get('url');const id=q.get('id');if(!url&&id&&/^[0-9]+$/.test(id))url=absolute((s.detail.url||'/book/{{id}}/').replaceAll('{{id}}',id),s);if(!url)return json(res,400,{error:'需要有效 url 或书籍 id'});
  if(u.pathname==='/api/detail')return json(res,200,(await detail(s,url)).data);
  if(['/api/book','/api/catalog'].includes(u.pathname)){const data=await book(s,url);return json(res,200,u.pathname==='/api/catalog'?{source:s.id,url:data.url,chapters:data.chapters}:data);}
  const index=q.get('chapterIndex');if(index!==null&&!/^[0-9]+$/.test(index))return json(res,400,{error:'chapterIndex 必须为非负整数'});
  return json(res,200,await resolveChapter(s,url,{bookTitle:q.get('bookTitle'),chapterTitle:q.get('chapterTitle')||'',chapterIndex:index===null?undefined:Number(index)}));
 }
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=files[u.pathname];
 if(!file)return json(res,404,{error:'未找到页面'});
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'}); fs.createReadStream(path.join(__dirname,'public',file)).pipe(res);
 }catch(e){json(res,502,{error:e.message,...(e.originalError?{originalError:e.originalError}:{}),...(e.errors?{errors:e.errors}:{})});}
});
}
function startServer(port=3000){
 return new Promise((resolve,reject)=>{
  const server=createServer();server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);console.log(`小说阅读器 http://127.0.0.1:${server.address().port}`);resolve(server);});
 });
}
async function stopServer(server){
 await closeBrowser();
 if(!server?.listening)return;
 await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});
}
module.exports={startServer,stopServer};
if(require.main===module)startServer(Number(process.env.PORT)||3000).catch(error=>{console.error(error);process.exitCode=1;});
