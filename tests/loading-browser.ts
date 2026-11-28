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
 const created=await fetch(origin+'/api/action',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({op:'create',label:'Slow session'})});
 assert(created.ok);const {session_id:target}=await created.json();
 const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 let expectedConflict=false;
 page.on('console',m=>{
  const url=m.location().url;
  if(m.type()!=='error'||url.endsWith('/favicon.ico'))return;
  if(expectedConflict&&url===origin+'/api/action'&&m.text().includes('409 (Conflict)'))return;
  errors.push(m.text());
 });
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
 // Hold both phases of a user-initiated switch. A constructed canvas must
 // stay hidden even after the layout request returns and history starts.
 const targetView=(url:URL)=>url.pathname==='/api/session'&&url.searchParams.get('session')===target;
 let releaseView!:()=>void;
 const waitForView=new Promise<void>(resolve=>releaseView=resolve);
 await page.route(targetView,async route=>{await waitForView;await route.continue();});
 let releaseList!:()=>void;
 const holdList=new Promise<void>(resolve=>releaseList=resolve);
 const listRoute=(url:URL)=>url.pathname==='/api/sessions';
 await page.evaluate(targetID=>{
  const BrowserSocket=window.WebSocket;
  window.WebSocket=class extends BrowserSocket {
   addEventListener(type:string,listener:any,options?:any){
    if(type!=='message'||new URL(this.url).searchParams.get('session')!==targetID){
     super.addEventListener(type,listener,options);return;
    }
    super.addEventListener('message',event=>{
     if(typeof event.data==='string'&&JSON.parse(event.data)[0]==='ready'){
      (window as any).finishTerminalStream=()=>listener.call(this,event);
     }else listener.call(this,event);
    },options);
   }
  };
 },target);
 await page.keyboard.press('Control+k');
 await page.route(listRoute,async route=>{await holdList;await route.continue();});
 try {
  await page.locator('#chooser').getByRole('button',{name:'Slow session',exact:true}).click();
  await page.locator('#session-loading').waitFor();
  assert.equal(await page.locator('#workspace').getAttribute('aria-busy'),'true');
  releaseView();
  await page.locator('.pane .terminal-loading').waitFor();
  await page.waitForFunction(()=>document.querySelector('.webterm-terminal canvas')!==null);
  await page.waitForFunction(()=>typeof (window as any).finishTerminalStream==='function');
 } finally {releaseView();releaseList();}
 assert.equal(await page.locator('.webterm-terminal canvas').first().evaluate(canvas=>getComputedStyle(canvas).visibility),'hidden');
 assert.equal(await page.locator('.pane .terminal-loading').evaluate(loader=>getComputedStyle(loader,'::before').animationName),'terminal-spin');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.pane .terminal-loading').evaluate(loader=>getComputedStyle(loader,'::before').animationName),'none');
 await page.evaluate(()=>(window as any).finishTerminalStream());
 await page.locator('.webterm-terminal.-connected').waitFor();
 await page.locator('.pane .terminal-loading').waitFor({state:'hidden'});
 assert.equal(await page.locator('.webterm-terminal canvas').first().evaluate(canvas=>getComputedStyle(canvas).visibility),'visible');
 await page.route('**/api/action',route=>{
  expectedConflict=true;
  return route.fulfill({status:409,json:{message:'The terminal is busy. Try again in a moment.'}});
 });
 await page.getByRole('button',{name:'New tab',exact:true}).click();
 const notice=page.locator('#status[data-kind="error"]');
 await notice.waitFor();
 assert.equal(await notice.textContent(),'The terminal is busy. Try again in a moment.');
 assert.deepEqual(await notice.evaluate(el=>{
  const style=getComputedStyle(el);
  return [style.paddingLeft,style.borderLeftWidth];
 }),['11px','1px']);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['interactive UI before engine delivery','small UI entry','early single WASM fetch','WOFF2 font','zero warm static transfer','terminal opens while session list is pending','session and pane spinners, hidden cursor until replay, reduced motion','padded error notice'],metrics,browserErrors:errors.length}));
}finally{
 if(browser)await browser.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
 await rm(scratch,{recursive:true,force:true});
}
