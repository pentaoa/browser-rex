// Optional owner-supplied native hosts. All terminal mutations use disposable
// sessions, with explicit host isolation in a temporary directory.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from '../web/node_modules/playwright';

const hostFile=process.env.REXWEB_TEST_HOSTS;
assert(hostFile,'Set REXWEB_TEST_HOSTS to a private hosts.json');
const hosts: {id:string;label:string;endpoint:string}[]=JSON.parse(await readFile(hostFile,'utf8'));
assert(hosts.length>0&&hosts.length<=32,'Provide between 1 and 32 hosts');
const scratch=await mkdtemp('/tmp/rexweb-remote-browser-');
let browser:Browser|undefined;let child:ReturnType<typeof spawn>|undefined;let logs='';
const owned:{host:string;session:string}[]=[];let origin='';
async function action(host:string,body:Record<string,unknown>){
  const r=await fetch(origin+'/api/action?'+new URLSearchParams({host}),{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error(await r.text());
  return r.json();
}

try{
  await writeFile(join(scratch,'hosts.json'),JSON.stringify(hosts),{mode:0o600});
  child=spawn(resolve('bin/browser-rex'),['-mode','web','-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,'work'),'-session-socket',join(scratch,'run/session.sock'),'-hosts-file',join(scratch,'hosts.json')],{stdio:['ignore','ignore','pipe']});
  child.stderr!.on('data',chunk=>logs+=chunk);
  for(let i=0;i<200&&!logs.includes('Ready:');i++){assert(child.exitCode===null,logs);await Bun.sleep(50);}
  const address=logs.match(/Web listener at (\S+)/)?.[1];assert(address,logs);origin='http://'+address;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  let reads=0;page.on('request',r=>{if(/\/api\/sessions?\?/.test(r.url()))reads++;});
  for(const host of hosts){
    const created=await action(host.id,{op:'create',label:'rexweb-performance-test'});owned.push({host:host.id,session:created.session_id});
    await page.goto(origin+'/?'+new URLSearchParams({host:host.id,session:created.session_id}));
    await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
    const marker=await page.evaluate(()=>((window as any).__documentMarker=crypto.randomUUID()));
    await page.locator('#host-picker').click();await page.locator('.host-option[data-host=""]').click();await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
    await page.locator('#host-picker').click();await page.locator(`.host-option[data-host="${host.id}"]`).click();await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
    assert.equal(await page.evaluate(()=>(window as any).__documentMarker),marker,'host switch reloaded the document');
    assert.equal(new URL(page.url()).searchParams.get('session'),created.session_id,'host switch lost its selected session');
    await page.goBack();await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
    assert.equal(await page.locator('#host-picker').getAttribute('data-value'),'');
    await page.goForward();await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
    assert.equal(await page.locator('#host-picker').getAttribute('data-value'),host.id);
    assert.equal(await page.evaluate(()=>(window as any).__documentMarker),marker,'history navigation reloaded the document');
    await page.evaluate(()=>((window as any).__tab=document.querySelector('.window-tab')));
    await action(host.id,{op:'rename',session:created.session_id,label:'event-refresh-test'});
    await page.waitForFunction(()=>document.querySelector('#session-label')?.textContent==='event-refresh-test',undefined,{timeout:15000});
    assert(await page.evaluate(()=>(window as any).__tab===document.querySelector('.window-tab')),'metadata refresh replaced the tab');
    await page.locator('#workspace-menu summary').click();
    await page.locator('.workspace-menu-items [data-op="split-right"]').click();
    await page.locator('.webterm-terminal.-connected').nth(1).waitFor({timeout:30000});
    const divider=page.getByRole('separator').first();const box=await divider.boundingBox();assert(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    const dragReads=reads;
    await action(host.id,{op:'rename',session:created.session_id,label:'drag-event-test'});
    await page.mouse.move(box.x+100,box.y+box.height/2,{steps:15});
    assert.equal(reads,dragReads,'layout refresh interrupted the drag');
    await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#session-label')?.textContent==='drag-event-test',undefined,{timeout:15000});
    await Bun.sleep(800);
    await page.locator('.pane.active .webterm-terminal').click();await page.keyboard.type("printf '\\137\\137PERF_INPUT_OK\\137\\137\\n'");await page.keyboard.press('Enter');
    await Bun.sleep(300);
    const view=await(await fetch(origin+'/api/session?'+new URLSearchParams({host:host.id,session:created.session_id}))).json();
    const active=view.windows.find((w:any)=>w.window_id===view.active_window_id);
    let capture='';
    for(let i=0;i<20;i++){
      capture=await(await fetch(origin+'/api/capture?'+new URLSearchParams({host:host.id,session:created.session_id,block:active.focused_block_id,format:'text',trim:'true'}))).text();
      if(capture.includes('__PERF_INPUT_OK__'))break;await Bun.sleep(100);
    }assert(capture.includes('__PERF_INPUT_OK__'),'terminal input lost after resize/switch');
    assert.equal(capture.split('__PERF_INPUT_OK__').length-1,1,'terminal input was replayed');
    await Bun.sleep(800);const before=reads;await Bun.sleep(3000);
    assert.equal(reads-before,0,'idle remote page kept polling the session list/view');
    console.log(JSON.stringify({host:host.id,idleWorkspaceReads:reads-before,checks:['in-page host switch','session selection retained','native layout event','stable tab node','split drag','terminal input']}));
  }
  await page.locator('#workspace-menu summary').click();await page.locator('#manage-hosts').click();await page.locator('#hosts-dialog[open]').waitFor();
  assert.notEqual(await page.locator('#hosts-dialog').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.keyboard.press('Escape');await page.locator('#hosts-dialog').waitFor({state:'hidden'});
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#workspace-menu summary').click();await page.locator('#manage-hosts').click();
  assert.equal(await page.locator('#hosts-dialog').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.keyboard.press('Escape');await page.locator('#hosts-dialog').waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.body.getBoundingClientRect().right<=innerWidth+1);
  const geometry=await page.evaluate(()=>[...document.querySelectorAll('.connection-picker,.toolbar-actions')].map(e=>e.getBoundingClientRect().toJSON()));
  assert(geometry.every(b=>b.left>=0&&b.right<=390),'mobile controls overflowed: '+JSON.stringify(geometry));
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({result:'passed',checks:['motion','reduced motion','mobile geometry'],browserErrors:errors.length}));
}finally{
  if(browser)await browser.close();
  const cleanup=await Promise.allSettled(owned.map(item=>action(item.host,{op:'destroy',session:item.session})));
  if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
  await rm(scratch,{recursive:true,force:true});
  for(const result of cleanup)if(result.status==='rejected'){console.error('Disposable session cleanup failed',result.reason);process.exitCode=1;}
}
