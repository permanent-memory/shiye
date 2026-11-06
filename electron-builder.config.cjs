'use strict';
module.exports={
 ...require('./package.json').build,
 beforePack(context){
  // This portable app neither installs nor elevates. Omit electron-builder's
  // installer-only elevate.exe helper from both the payload and staging step.
  if(context.electronPlatformName==='win32')context.packager.info.framework.isCopyElevateHelper=false;
 }
};
