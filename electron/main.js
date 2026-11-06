'use strict';
const {app,BrowserWindow,Menu,screen,dialog}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {startServer,stopServer}=require('../server');
app.setName('拾页');app.setAppUserModelId('com.shiye.reader');
let window,server,quitting=false,shuttingDown=false,baseUrl;
function log(message){console.log('[desktop] '+message);try{fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.appendFileSync(path.join(app.getPath('userData'),'desktop.log'),new Date().toISOString()+' '+message+'\n');}catch{}}
function focus(){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();log('existing window focused');}}
function readBounds(){
 try{
  const value=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'window.json'),'utf8'));
  const width=Number.isFinite(value.width)?Math.max(900,value.width):1280,height=Number.isFinite(value.height)?Math.max(600,value.height):860;
  const options={width,height,maximized:!!value.maximized};
  if(Number.isFinite(value.x)&&Number.isFinite(value.y)&&screen.getAllDisplays().some(({workArea:r})=>value.x<r.x+r.width&&value.y<r.y+r.height&&value.x+width>r.x&&value.y+height>r.y)){options.x=value.x;options.y=value.y;}
  return options;
 }catch{return {width:1280,height:860};}
}
function saveBounds(){if(!window||window.isDestroyed())return;try{fs.writeFileSync(path.join(app.getPath('userData'),'window.json'),JSON.stringify({...window.getNormalBounds(),maximized:window.isMaximized()},null,2));}catch(error){log('cannot save window bounds: '+error.message);}}
async function openWindow(){
 const {maximized,...bounds}=readBounds();
 window=new BrowserWindow({...bounds,minWidth:900,minHeight:600,show:false,backgroundColor:'#f6f4ed',title:'拾页',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==baseUrl)event.preventDefault();});
 window.once('ready-to-show',()=>{if(maximized)window.maximize();window.show();log('reader window ready '+baseUrl);});
 window.on('close',saveBounds);window.on('closed',()=>{window=null;});
 await window.loadURL(baseUrl);
}
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',focus);
 app.on('activate',focus);
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',event=>{
  if(quitting)return;
  event.preventDefault();if(shuttingDown)return;shuttingDown=true;saveBounds();
  stopServer(server).catch(error=>log('shutdown error: '+error.message)).finally(()=>{log('server and browser closed');quitting=true;app.quit();});
 });
 app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  for(let port=3000;port<3010;port++){
   try{server=await startServer(port);baseUrl='http://127.0.0.1:'+port;break;}catch(error){if(error.code!=='EADDRINUSE')throw error;}
  }
  if(!server)throw new Error('3000–3009 端口均被占用，无法启动阅读器');
  log('server '+baseUrl+' pid='+process.pid);await openWindow();
 }).catch(error=>{log(error.stack||error.message);dialog.showErrorBox('拾页启动失败',error.message);app.quit();});
}
