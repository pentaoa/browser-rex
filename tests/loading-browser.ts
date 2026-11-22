// Disposable host-mode fixture: verify useful UI before engine delivery, early
// WASM fetch and actual browser cache reuse instead of timing-only assertions.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from '../web/node_modules/playwright';
const scratch=await mkdtemp('/tmp/rexweb-loading-');
let browser:Browser|undefined,child:ReturnType<typeof spawn>|undefined,logs='';
try{
 child=spawn(resolve('bin/browser-rex'),['-mode','web','-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,'work'),'-session-socket',join(scratch,'run/session.sock')],{stdio:['ignore','ignore','pipe']});
 child.stderr!.on('data',data=>logs+=data);
 for(let i=0;i<200&&!logs.includes('Ready:');i++){assert.equal(child.exitCode,null,logs);await Bun.sleep(50);}
 const address=logs.match(/Web listener at (\S+)/)?.[1];assert(address,logs);const origin='http://'+address;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-proxy-server']});
 const errors:string[]=[];
 const delayed=await browser.newContext();const first=await delayed.newPage();first.on('pageerror',e=>errors.push(String(e)));
 first.on('console',m=>{if(m.type()==='error'&&!m.location().url.endsWith('/favicon.ico'))errors.push(m.text());});
 let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);
 await first.route('**/static/js/terminal-*.js',async route=>{await hold;await route.continue();});
 try{
  await first.goto(origin,{waitUntil:'domcontentloaded'});
  await first.locator('#windows .tab-select').first().waitFor();
  assert.equal(await first.locator('.webterm-terminal.-connected').count(),0);
  await first.locator('#host-picker').click();await first.locator('#host-filter').fill('Local');
  assert.equal(await first.locator('.host-option').count(),1);await first.keyboard.press('Escape');
 }finally{release();}
 await first.locator('.webterm-terminal.-connected').waitFor();await delayed.close();
 const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error'&&!m.location().url.endsWith('/favicon.ico'))errors.push(m.text());});
 const metrics=[];
 for(const run of ['cold','warm']){
  const start=Date.now();if(run==='cold')await page.goto(origin);else await page.reload();
  await page.locator('.webterm-terminal.-connected').waitFor();const connectedMs=Date.now()-start;
  await page.evaluate(()=>document.fonts.ready);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/static/')).map(entry=>{
   const e=entry as PerformanceResourceTiming;return {path:new URL(e.name).pathname,initiator:e.initiatorType,start:e.startTime,end:e.responseEnd,transfer:e.transferSize,decoded:e.decodedBodySize};
  }));
  const entry=resources.find(e=>/\/workspace-[^/]+\.js$/.test(e.path));assert(entry&&entry.decoded<100_000,'UI entry still contains the engine');
  const wasm=resources.filter(e=>e.path.endsWith('.wasm'));assert.equal(wasm.length,1,'preload was fetched twice');
  assert.equal(wasm[0].initiator,'link','WASM fetch waited for JS bootstrap');
  assert(resources.some(e=>e.path.endsWith('.woff2')),'compressed full-glyph font missing');
  if(run==='warm')assert.equal(resources.reduce((sum,e)=>sum+e.transfer,0),0,'warm navigation downloaded static assets again');
  metrics.push({run,connectedMs,entryBytes:entry.decoded,staticTransfer:resources.reduce((sum,e)=>sum+e.transfer,0)});
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['interactive UI before engine delivery','small UI entry','early single WASM fetch','WOFF2 font','zero warm static transfer'],metrics,browserErrors:errors.length}));
}finally{
 if(browser)await browser.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
 await rm(scratch,{recursive:true,force:true});
}
