// Native Rex fixture in a disposable host-mode workspace. No production hosts.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium,type Browser,type Page} from '../web/node_modules/playwright';
const scratch=await mkdtemp('/tmp/rexweb-layout-');
let currentPage:Page|undefined;
let child:ReturnType<typeof spawn>|undefined,browser:Browser|undefined,logs='',origin='';
async function request(path:string,body?:Record<string,unknown>){
 const r=await fetch(origin+path,body?{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 assert(r.ok,await r.clone().text());return r.json();
}
try{
 await writeFile(join(scratch,'hosts.json'),'[]',{mode:0o600});
 child=spawn(resolve('bin/browser-rex'),['-mode','both','-listen','127.0.0.1:0','-rex-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,'work'),'-session-socket',join(scratch,'run/session.sock'),'-hosts-file',join(scratch,'hosts.json')],{stdio:['ignore','ignore','pipe']});
 child.stderr!.on('data',data=>logs+=data);
 for(let i=0;i<200&&!logs.includes('Ready:');i++){assert.equal(child.exitCode,null,logs);await Bun.sleep(50);}
 const web=logs.match(/Web listener at (\S+)/)?.[1],native=logs.match(/Rex listener at (\S+)/)?.[1];assert(web&&native,logs);origin='http://'+web;
 const ids:Record<string,string>={};
 for(const [key,label]of [['alpha','Studio server'],['beta','Build server'],['gamma','Archive server']])ids[key]=(await request('/api/hosts',{op:'save',label,endpoint:'http://'+native})).id;
 const created=await request('/api/action',{op:'create',label:'Research workspace'});const session=created.session_id;
 for(const item of (await request('/api/sessions')).sessions)if(item.session_id!==session)await request('/api/action',{op:'destroy',session:item.session_id});
 const initial=await request('/api/session?'+new URLSearchParams({session}));const original=initial.active_window_id;
 const extra=await request('/api/action',{op:'new-window',session});
 await request('/api/action',{op:'rename-window',session,window:original,label:'Window 1'});
 await request('/api/action',{op:'rename-window',session,window:extra.window_id,label:'Window 2'});
 await request('/api/action',{op:'focus-window',session,window:original});
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-proxy-server']});
 const context=await browser.newContext({viewport:{width:1100,height:800},colorScheme:'dark'});const page=await context.newPage();currentPage=page;
 async function selectedTabs(host:string,count:number){
  await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
  await page.waitForFunction(({host,count})=>{
   const items=document.querySelector(`.host-group[data-host="${host}"] .host-group-tabs`);
   return items?.children.length===1&&items.firstElementChild?.id==='windows'&&items.querySelectorAll('.window-tab').length===count;
  },{host,count});
  assert.equal(await page.locator('#windows').count(),1,'more than one live tab strip');
 }
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 // Native wire views put the task label on the focused block while the window
 // label can remain generated. Exercise both the live and inactive sidebars.
 await page.route(url=>url.pathname==='/api/session'&&url.searchParams.get('host')===ids.gamma,async route=>{
  const response=await route.fetch();const result=await response.json();
  for(const window of result.windows??[]){
   for(const layer of window.layers??[]){
    const block=layer.blocks?.find((item:any)=>item.block_id===window.focused_block_id);
    if(block)block.label='Build runner';
   }
   if(window.window_id===extra.window_id)window.label='Release notes';
  }
  await route.fulfill({response,json:result});
 });
 let sockets=0;page.on('websocket',()=>sockets++);
 const reads:string[]=[];page.on('request',r=>{if(/\/api\/sessions?\?/.test(r.url()))reads.push(new URL(r.url()).searchParams.get('host')??'');});
 await page.goto(origin+'/?'+new URLSearchParams({session}));await page.locator('.webterm-terminal.-connected').waitFor();
 await page.waitForFunction(()=>document.activeElement instanceof HTMLTextAreaElement);
 const identity=await page.locator('.webterm-terminal').evaluate(el=>{(window as any).__terminal=el;return true});assert(identity);
 const initialSockets=sockets;
 assert.equal(await page.locator('body').getAttribute('data-layout'),'vertical','new workspaces should default to sidebar tabs');
 assert.equal(await page.locator('#connection-status').count(),0,'connection dot still rendered');
 await page.locator('.host-group').nth(3).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.host-group-caption')].every(el=>el.textContent==='Research workspace'));
 await page.waitForFunction(()=>document.querySelectorAll('.host-group-tabs .window-tab').length===8);
 assert.deepEqual(await page.locator('#windows .tab-label').allTextContents(),['shell','shell']);
 assert.deepEqual(await page.locator(`.host-group[data-host="${ids.gamma}"] .tab-label`).allTextContents(),['Build runner','Release notes']);
 await page.keyboard.insertText("printf '\\033]0;Example application\\007'");
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#content-title')?.textContent==='Example application');
 assert.deepEqual(await page.locator('#windows .tab-label').allTextContents(),['Example application','shell']);
 assert.equal(await page.locator('.host-group[data-host=""] .host-group-caption').textContent(),'Research workspace');
 assert.equal(await page.locator('#navigation').evaluate(el=>Math.round(el.getBoundingClientRect().width)),210);
 assert.equal(await page.locator('#terminal-surface').evaluate(el=>getComputedStyle(el).borderTopLeftRadius),'12px');
 assert.equal(await page.locator('.window-tab[data-active="true"]').evaluate(el=>getComputedStyle(el).borderTopLeftRadius),'999px');
 assert(await page.locator('.webterm-terminal').evaluate(el=>el===(window as any).__terminal),'layout replaced terminal');
 assert.equal(sockets,initialSockets,'layout reopened terminal socket');
 assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).boxShadow),'none');
 assert.equal(await page.locator('#sidebar-footer button').count(),1,'ambiguous duplicate host controls');
 assert(await page.locator('#sidebar-footer .sidebar-host-label').isVisible(),'host control has no visible label');
 // Cross-host sidebar rows select the correct canonical session/window.
 await page.locator(`.host-group[data-host="${ids.alpha}"] .tab-select`).first().click();
 await page.waitForFunction(id=>new URL(location.href).searchParams.get('host')===id,ids.alpha);
 await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
 await page.waitForFunction(id=>document.querySelector(`.host-group[data-host="${id}"] #windows`),ids.alpha);
 for(let i=0;i<100&&(await request('/api/session?'+new URLSearchParams({session}))).active_window_id!==original;i++)await Bun.sleep(50);
 assert.equal((await request('/api/session?'+new URLSearchParams({session}))).active_window_id,original,'sidebar selected the wrong window');
 assert.equal(await page.locator(`.host-group[data-host="${ids.alpha}"] .window-tab`).count(),2,'selected host retained duplicate cached tabs');
 await selectedTabs(ids.alpha,2);
 assert.equal(await page.locator('#windows .tab-label').first().textContent(),'Example application','remote title missing on first attach');
 await page.keyboard.insertText("printf '\\033]0;研究任务 · 构建报告\\007'");
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#windows .tab-label')?.textContent==='研究任务 · 构建报告');
 await request('/api/action',{op:'rename-window',session,window:original,label:'Pinned workspace'});
 await page.waitForFunction(()=>document.querySelector('#windows .tab-label')?.textContent==='Pinned workspace');
 assert.equal(await page.locator('#content-title').textContent(),'研究任务 · 构建报告','explicit tab name replaced the application heading');
 await request('/api/action',{op:'rename-window',session,window:original,label:'Window 1'});
 await page.waitForFunction(()=>document.querySelector('#windows .tab-label')?.textContent==='研究任务 · 构建报告');
 await page.keyboard.insertText("printf '\\033]0;\\007'");
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#windows .tab-label')?.textContent==='shell');
 // Identical labels are legitimate for distinct windows: both stay clickable.
 for(const [index,window]of [original,extra.window_id].entries()){
  await page.locator('#windows .tab-select').nth(index).click();
  for(let i=0;i<100&&(await request('/api/session?'+new URLSearchParams({session}))).active_window_id!==window;i++)await Bun.sleep(50);
  assert.equal((await request('/api/session?'+new URLSearchParams({session}))).active_window_id,window,'same-name tab was not selectable');
 }
 for(const host of [ids.beta,ids.alpha,ids.beta,ids.alpha]){
  await page.locator(`.host-group[data-host="${host}"] .tab-select`).first().click();
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('host')===id,host);
  await selectedTabs(host,2);
 }
 await page.locator(`.host-group[data-host="${ids.beta}"] .tab-select`).first().evaluate(el=>(window as any).__summary=el);
 const before=reads.filter(host=>host===ids.beta||host===ids.gamma).length;
 await page.getByRole('button',{name:'Use horizontal tabs'}).click();
 await page.getByRole('button',{name:'Use vertical tabs'}).click();await selectedTabs(ids.alpha,2);
 assert.equal(reads.filter(host=>host===ids.beta||host===ids.gamma).length,before,'layout toggle reread fresh inactive hosts');
 assert(await page.locator(`.host-group[data-host="${ids.beta}"] .tab-select`).first().evaluate(el=>el===(window as any).__summary),'unchanged summary replaced its DOM');
 await request('/api/action',{op:'close-window',session,window:extra.window_id});
 await page.getByRole('button',{name:'Choose host'}).click();
 await page.getByRole('combobox',{name:'Search hosts'}).fill('Archive');
 assert.equal(await page.locator('.host-option').count(),1);
 await page.keyboard.press('Enter');await page.waitForFunction(id=>new URL(location.href).searchParams.get('host')===id,ids.gamma);
 await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
 await page.goBack();await page.locator('.webterm-terminal.-connected').waitFor({timeout:30000});
 assert.equal(await page.locator('#host-picker').getAttribute('data-value'),ids.alpha);
 await selectedTabs(ids.alpha,1);
 await page.goForward();await selectedTabs(ids.gamma,1);
 await page.goBack();await selectedTabs(ids.alpha,1);
 await page.getByRole('button',{name:'Choose host'}).click();
 await page.getByRole('combobox',{name:'Search hosts'}).fill('nothing-matches');
 await page.locator('#host-empty').waitFor();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.activeElement instanceof HTMLTextAreaElement);
 // Long names are text nodes, and the custom panel fits both bottom-anchored
 // sidebar controls and a narrow top toolbar.
 await request('/api/hosts',{op:'save',label:'<b>Very long host name that should truncate without markup</b>',endpoint:'http://'+native});
 await page.getByRole('button',{name:'Choose host'}).click();
 await page.locator('#picker-manage-hosts').click();await page.locator('#hosts-dialog[open]').waitFor();
 await page.keyboard.press('Escape');await page.locator('#hosts-dialog').waitFor({state:'hidden'});
 await selectedTabs(ids.alpha,1);
 await page.getByRole('button',{name:'Choose host'}).click();
 await page.getByRole('combobox',{name:'Search hosts'}).fill('<b>');
 assert.equal(await page.locator('.host-option b').count(),0);assert.equal(await page.locator('.host-option').count(),1);await page.keyboard.press('Escape');
 // Real text input after each geometry change; verify one shell result.
 await page.keyboard.insertText("printf '\\137\\137LAYOUT_OK\\137\\137\\n'");await page.keyboard.press('Enter');
 await page.keyboard.press('Control+f');await page.locator('#search-text').fill('__LAYOUT_OK__');
 await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent==='1 / 1');await page.keyboard.press('Escape');
 const shots=process.env.REXWEB_SCREENSHOTS;if(shots)await mkdir(shots,{recursive:true});
 if(shots)await page.screenshot({animations:'disabled',path:join(shots,'layout-vertical-dark.png')});
 await page.getByRole('button',{name:'Use horizontal tabs'}).click();
 await page.waitForFunction(()=>document.querySelector('#horizontal-tabs #windows'));
 if(shots)await page.screenshot({animations:'disabled',path:join(shots,'layout-horizontal-dark.png')});
 await page.getByRole('button',{name:'Choose host'}).click();
 if(shots)await page.screenshot({animations:'disabled',path:join(shots,'layout-host-picker-dark.png')});
 await page.keyboard.press('Escape');
 await page.reload();await page.locator('.webterm-terminal.-connected').waitFor();assert.equal(await page.locator('body').getAttribute('data-layout'),'horizontal');
 await page.getByRole('button',{name:'Use vertical tabs'}).click();await page.reload();
 await page.locator('.webterm-terminal.-connected').waitFor();assert.equal(await page.locator('body').getAttribute('data-layout'),'vertical');
 for(const width of [390,320])for(const mode of ['vertical','horizontal']){
  await page.setViewportSize({width,height:844});
  const state=await page.locator('body').getAttribute('data-layout');if(state!==mode)await page.locator('#layout-toggle').click();
  await page.getByRole('button',{name:'Choose host'}).click();
  const r=await page.locator('#host-popover').boundingBox();assert(r&&r.x>=0&&r.y>=0&&r.x+r.width<=width&&r.y+r.height<=844,'host popover overflow');
  await page.keyboard.press('Escape');
  assert(await page.locator('#content-heading').isVisible());
  assert(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),'layout horizontal overflow');
 }
 await page.setViewportSize({width:1100,height:800});await page.emulateMedia({colorScheme:'light'});
 if(shots)await page.screenshot({animations:'disabled',path:join(shots,'layout-horizontal-light.png')});
 await page.getByRole('button',{name:'Use vertical tabs'}).click();
 const startHost=new URL(page.url()).searchParams.get('host');
 assert.notEqual(startHost,ids.beta);
 await page.locator(`.host-group[data-host="${ids.beta}"]`).getByRole('button',{name:'New session on Build server'}).click();
 const dialog=page.locator('#action-dialog');
 assert.equal(await dialog.locator('#action-description').textContent(),'Host: Build server');
 assert.equal(new URL(page.url()).searchParams.get('host'),startHost,'opening the dialog changed hosts');
 await dialog.locator('#action-name').fill('Build workspace');
 const creates=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/action'&&response.request().postDataJSON().op==='create');
 await dialog.getByRole('button',{name:'Create session',exact:true}).click();
 const response=await creates;assert(response.ok());
 assert.equal(new URL(response.url()).searchParams.get('host'),ids.beta,'creation went to the wrong host');
 const createdSession=(await response.json()).session_id;
 await page.waitForURL(url=>url.searchParams.get('host')===ids.beta&&url.searchParams.get('session')===createdSession);
 await page.locator('.webterm-terminal.-connected').waitFor();
 assert.equal(await page.locator(`.host-group[data-host="${ids.beta}"] .host-group-caption`).textContent(),'Build workspace');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',checks:['reference sidebar/topbar geometry','rounded content/pill tabs','layout preserves terminal and socket','native per-host sidebar groups','no duplicate cached/live rows after repeated host changes','same-name windows remain selectable','local and remote application titles update automatic tabs','explicit window labels override automatic titles','single labeled footer control','cross-host tab selection','search/keyboard/custom host picker','history','safe long labels','input after resize','persistent layout','320/390px popover bounds','light/dark'],browserErrors:errors.length}));
}catch(error){
 const dir=process.env.REXWEB_SCREENSHOTS;if(dir&&currentPage){await mkdir(dir,{recursive:true});await currentPage.screenshot({path:join(dir,'layout-failure.png')});console.error('LAYOUT',await currentPage.evaluate(()=>({status:document.querySelector('#status')?.textContent,groups:[...document.querySelectorAll('.host-group-caption')].map(e=>e.textContent)})));}throw error;
}finally{
 if(browser)await browser.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
 await rm(scratch,{recursive:true,force:true});
}
