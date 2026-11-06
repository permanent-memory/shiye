'use strict';
const http=require('node:http'),https=require('node:https'),zlib=require('node:zlib');
// Built-in transports deliberately ignore HTTP_PROXY / HTTPS_PROXY and system proxies.
async function directRequest(url,options={},redirects=0){
 if(redirects>5)throw new Error('直连重定向次数过多');
 const u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw new Error('不支持的直连协议');
 return new Promise((resolve,reject)=>{
  const headers={...options.headers,'Accept-Encoding':'identity'};
  const req=(u.protocol==='https:'?https:http).request(u,{method:options.method||'GET',headers,signal:options.signal},res=>{
   if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
    res.resume();const next=new URL(res.headers.location,u);const get=res.statusCode===303||([301,302].includes(res.statusCode)&&(options.method||'GET')==='POST');
    const h={...options.headers};if(next.hostname!==u.hostname){delete h.Cookie;delete h.cookie;}
    directRequest(next.href,{...options,headers:h,...(get?{method:'GET',body:undefined}:{})},redirects+1).then(resolve,reject);return;
   }
   if(res.statusCode<200||res.statusCode>=300){res.resume();reject(new Error('上游 HTTP '+res.statusCode));return;}
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{let buffer=Buffer.concat(chunks);const encoding=res.headers['content-encoding'];if(encoding==='gzip'||encoding==='deflate')buffer=zlib.unzipSync(buffer);if(encoding==='br')buffer=zlib.brotliDecompressSync(buffer);if(!buffer.length)throw new Error('上游返回空响应');resolve({buffer,type:res.headers['content-type']||'',url:u.href});}catch(e){reject(e);}});
  });req.on('error',reject);if(options.body)req.write(options.body);req.end();
 });
}
module.exports={directRequest};
