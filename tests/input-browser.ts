// Browser-level input regression: native beforeinput and Chromium IME, rather
// than keyboard.type alone. All shells belong to a disposable host-mode server.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,type Browser,type Frame,type Page} from '../web/node_modules/playwright';

const scratch=await mkdtemp('/tmp/rexweb-input-browser-');
let browser:Browser|undefined,child:ReturnType<typeof spawn>|undefined,logs='',origin='';
async function action(session:string,body:Record<string,unknown>){
  const r=await fetch(origin+'/api/action',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({session,...body})});
  assert(r.ok,await r.clone().text());return r.json();
}
async function getView(session:string){return(await fetch(origin+'/api/session?'+new URLSearchParams({session}))).json();}
async function until(check:()=>Promise<boolean>,message:string){
  for(let i=0;i<100;i++){if(await check())return;await Bun.sleep(50);}throw Error(message);
}
try{
  await writeFile(join(scratch,'hosts.json'),'[]',{mode:0o600});
  child=spawn(resolve('bin/browser-rex'),['-mode','web','-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,'work'),'-session-socket',join(scratch,'run/session.sock'),'-hosts-file',join(scratch,'hosts.json')],{stdio:['ignore','ignore','pipe']});
  child.stderr!.on('data',chunk=>logs+=chunk);
  for(let i=0;i<200&&!logs.includes('Ready:');i++){assert(child.exitCode===null,logs);await Bun.sleep(50);}
  const address=logs.match(/Web listener at (\S+)/)?.[1];assert(address,logs);origin='http://'+address;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  // Fulfilled iframe documents have no network address space. Grant only this
  // disposable loopback origin access to its own terminal WebSocket.
  await context.grantPermissions(['local-network-access'],{origin});
  for(const embedded of [false,true]){
    const {session_id:session}=await action('',{op:'create',label:'input-regression'});
    const page=await context.newPage();const errors:string[]=[],stdin:string[]=[];
    const cdp=await context.newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride',{
      userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',platform:'MacIntel',
    });
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('websocket',ws=>ws.on('framesent',frame=>{try{const [kind,data]=JSON.parse(String(frame.payload));if(kind==='stdin')stdin.push(data);}catch{}}));
    const url='/?'+new URLSearchParams({session});
    let frame:Frame|Page=page;
    if(embedded){
      // The deployment's authenticated embedding proxy removes X-Frame-Options;
      // emulate only that response header for this same-origin iframe fixture.
      await page.route(url=>url.origin===origin&&url.pathname==='/',async route=>{
        const response=await route.fetch();const headers={...response.headers()};
        delete headers['x-frame-options'];await route.fulfill({response,headers});
      });
      await page.route('**/input-embed',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><style>body{margin:0;padding:70px 60px}iframe{width:calc(100vw - 120px);height:calc(100vh - 140px);border:0}@media(max-width:560px){body{padding:30px 8px}iframe{width:calc(100vw - 16px);height:calc(100vh - 60px)}}</style><iframe title="Terminal" src="${url}"></iframe>`}));
      await page.goto(origin+'/input-embed');
      await page.locator('iframe').waitFor();
      const embeddedFrame=await (await page.locator('iframe').elementHandle())!.contentFrame();
      assert(embeddedFrame);frame=embeddedFrame;
    }else await page.goto(origin+url);
    await frame.locator('.webterm-terminal.-connected').waitFor();
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'initial focus missed native textarea');
    // Text insertion used by dictation/IME must work without clicking first.
    const prefix="printf '\\137\\137IME_OK\\137\\137:%s\\n' '";
    await page.keyboard.insertText(prefix);
    await until(async()=>stdin.join('')===prefix,'beforeinput-only insertion lost');
    await cdp.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    const input=frame.locator('.webterm-terminal textarea');
    const overlay=await frame.locator('.webterm-terminal').evaluate(el=>{const canvases=[...el.querySelectorAll('canvas')];const main=canvases[0].getBoundingClientRect(),preedit=canvases[1].getBoundingClientRect();return {dx:preedit.left-main.left,dy:preedit.top-main.top};});
    assert(Math.abs(overlay.dx)<1&&Math.abs(overlay.dy)<1,'preedit overlay detached from terminal canvas');
    assert.equal(await input.inputValue(),'zhong','preedit was cleared');
    await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true});
    await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});
    await Bun.sleep(40);assert.equal(stdin.join(''),prefix,'preedit/acceptance leaked into PTY');
    await cdp.send('Input.insertText',{text:'中文输入'});
    await page.keyboard.insertText("'");await page.keyboard.press('Enter');
    await until(async()=>stdin.join('')===prefix+"中文输入'\r",'IME commit lost, duplicated, or executed twice');
    const state=await getView(session);const block=state.windows[0].focused_block_id;
    await until(async()=>{
      const text=await(await fetch(origin+'/api/capture?'+new URLSearchParams({session,block,format:'text',trim:'true'}))).text();
      return text.split('__IME_OK__:中文输入').length-1===1;
    },'composed command did not execute exactly once');
    // Padding is clickable too; focus must survive the browser default action.
    await frame.locator('.webterm-terminal').click({position:{x:2,y:2}});
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'padding click missed input');
    const before=stdin.join('');await page.keyboard.type('abc');await page.keyboard.press('Backspace');await page.keyboard.press('Control+u');
    await until(async()=>stdin.join('')===before+'abc\x7f\x15','physical keyboard/control keys regressed');
    // Menus and dialogs keep their own input, then return focus on dismissal.
    await frame.locator('#workspace-menu summary').click();await frame.locator('#manage-hosts').click();
    await frame.locator('#host-name').fill('not terminal input');
    assert.equal(await frame.locator('#host-name').inputValue(),'not terminal input');
    const beforeDialog=stdin.join('');await page.keyboard.press('Escape');
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'dialog did not restore terminal input');
    assert.equal(stdin.join(''),beforeDialog,'dialog text reached terminal');
    await page.keyboard.press('Meta+f');await frame.locator('#search-text').waitFor();
    await page.keyboard.insertText('IME_OK');await page.keyboard.press('Escape');
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'macOS search shortcut lost terminal focus');
    await page.keyboard.press('Meta+k');await frame.locator('#chooser[open]').waitFor();
    await page.keyboard.press('Escape');
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'macOS session shortcut lost terminal focus');
    // Splits must anchor inside the selected pane, also with an iframe offset.
    await frame.locator('#workspace-menu summary').click();await frame.locator('.workspace-menu-items [data-op="split-right"]').click();
    await frame.locator('.webterm-terminal.-connected').nth(1).waitFor();await Bun.sleep(120);
    assert(await frame.evaluate(()=>document.activeElement===document.querySelector('.pane.active textarea')),'split stole focus into container/wrong pane');
    const geometry=await frame.locator('.pane.active').evaluate(pane=>{
      const input=pane.querySelector('textarea')!.getBoundingClientRect();const canvas=pane.querySelector('canvas')!.getBoundingClientRect();
      return {x:input.left,y:input.top,bottom:input.bottom,left:canvas.left,top:canvas.top,right:canvas.right,end:canvas.bottom};
    });
    assert(geometry.x>=geometry.left-1&&geometry.x<geometry.right&&geometry.y>=geometry.top-1&&geometry.bottom<=geometry.end+1,'IME anchor outside focused canvas: '+JSON.stringify(geometry));
    // Closing a background tab must not change the selected window.
    const original=(await getView(session)).active_window_id;
    await frame.getByRole('button',{name:'New tab',exact:true}).click();
    await until(async()=> (await getView(session)).windows.length===2,'new tab missing');
    const current=(await getView(session)).active_window_id;assert.notEqual(current,original);
    await frame.locator('.window-tab[data-active="false"] .tab-close').click();
    await until(async()=> (await getView(session)).windows.length===1,'background tab did not close');
    assert.equal((await getView(session)).active_window_id,current,'background close changed selection');
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'background tab close did not restore input');
    await frame.locator('.tab-close').click();await frame.locator('.empty-state').waitFor();
    assert.equal((await getView(session)).windows?.length??0,0,'last tab did not close');
    await frame.locator('.empty-state button').click();await frame.locator('.webterm-terminal.-connected').waitFor();
    await until(()=>frame.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement),'reopened tab lost focus');
    // Opening the same pane in a second tab must hand off its single server
    // connection, without recreating the session, fighting reconnects or losing
    // consumed replay offsets. The first viewer can explicitly take it back.
    const second=await context.newPage();await second.goto(origin+'/?'+new URLSearchParams({session}));
    await second.bringToFront();
    await second.locator('.webterm-terminal.-connected').waitFor();
    await frame.locator('.webterm-terminal.-paused').waitFor();
    // A server layout change also remounts panes in the paused document. Its
    // asynchronous renderer must not steal the active document's new pane.
    await second.getByRole('button',{name:'New tab',exact:true}).click();
    await until(async()=>await second.locator('.window-tab').count()===2,'second viewer tab missing');
    await second.locator('.webterm-terminal.-connected').waitFor();await Bun.sleep(1700);
    await frame.locator('.webterm-terminal.-paused').waitFor();
    await second.locator('.window-tab[data-active="true"] .tab-close').click();
    await until(async()=>await second.locator('.window-tab').count()===1,'second viewer tab close missing');
    await second.locator('.webterm-terminal.-connected').waitFor();await Bun.sleep(1700);
    await frame.locator('.webterm-terminal.-paused').waitFor();
    await second.keyboard.insertText("printf '\\137\\137HANDOFF_OK\\137\\137\\n'");await second.keyboard.press('Enter');
    await page.bringToFront();
    await frame.getByRole('button',{name:'Resume terminal in this tab'}).click();
    await frame.locator('.webterm-terminal.-connected').waitFor();
    await second.locator('.webterm-terminal.-paused').waitFor();
    const handed=(await getView(session)).windows[0].focused_block_id;
    await until(async()=>{
      const text=await(await fetch(origin+'/api/capture?'+new URLSearchParams({session,block:handed,format:'text',trim:'true'}))).text();
      return text.split('__HANDOFF_OK__').length-1===1;
    },'handoff lost or duplicated terminal input');
    await page.keyboard.press('Meta+f');
    await frame.locator('#search-text').fill('__HANDOFF_OK__');
    await frame.waitForFunction(()=>document.querySelector('#search-results')?.textContent==='1 / 1');
    await page.keyboard.press('Escape');
    await second.close();
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      await frame.waitForFunction(()=>document.body.getBoundingClientRect().right<=innerWidth+1);
      assert(await frame.evaluate(()=>[...document.querySelectorAll('.connection-picker,.toolbar-actions')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})),'mobile toolbar overflow');
      assert(await frame.locator('.tab-close').isVisible(),'close button hidden on small viewport');
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({embedded,checks:['initial textarea focus','beforeinput-only text','native IME preedit/commit','no confirming Enter leak','capture exactly once','padding click','physical/control keys','dialog focus','macOS shortcuts','split IME anchor','background/last tab close','same-pane tab/iframe handoff','320/390px layout'],result:'passed'}));
    await cdp.detach();await page.close();await action(session,{op:'destroy'});
  }
}finally{
  if(browser)await browser.close();
  if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
  await rm(scratch,{recursive:true,force:true});
}
