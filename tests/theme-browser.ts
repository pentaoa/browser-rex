// Owned loopback fixture: verify real canvas colors, preference persistence and
// cross-document synchronization without reconnecting terminal sessions.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,type Browser,type Page} from '../web/node_modules/playwright';
const scratch=await mkdtemp('/tmp/rexweb-theme-');
let browser:Browser|undefined,child:ReturnType<typeof spawn>|undefined,logs='';
const paletteColors = {obsidian:'#0d0e10',ocean:'#171d28',graphite:'#28292d'};
async function expectTheme(page:Page,theme:'light'|'dark',preference:string,palette:keyof typeof paletteColors='obsidian'){
 const background=theme==='dark'?paletteColors[palette]:'#fafafa';
 await page.waitForFunction(({theme,preference})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.themePreference===preference,{theme,preference});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()),background);
 assert.equal(await page.locator(`[data-theme-choice="${preference}"]`).getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator(`[data-palette-choice="${palette}"]`).getAttribute('aria-pressed'),'true');
 // The canvas renderer must redraw too; checking CSS alone misses stale PTYs.
 await page.waitForFunction(expected=>{
  const canvas=document.querySelector<HTMLCanvasElement>('.webterm-terminal canvas');
  if(!canvas||canvas.width<10||canvas.height<10)return false;
  const pixel=canvas.getContext('2d')?.getImageData(canvas.width-5,canvas.height-5,1,1).data;
  return pixel&&expected.every((component,index)=>pixel[index]===component)&&pixel[3]===255;
 },[1,3,5].map(index=>parseInt(background.slice(index,index+2),16)));
}
async function choose(page:Page,mode:string,kind='theme'){
 await page.locator('#workspace-menu summary').click();
 await page.locator(`[data-${kind}-choice="${mode}"]`).click();
 assert.equal(await page.locator('#workspace-menu').getAttribute('open'),null);
 await page.waitForFunction(()=>document.activeElement instanceof HTMLTextAreaElement);
}
try{
 await writeFile(join(scratch,'hosts.json'),'[]',{mode:0o600});
 child=spawn(resolve('bin/browser-rex'),['-mode','web','-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,'work'),'-session-socket',join(scratch,'run/session.sock'),'-hosts-file',join(scratch,'hosts.json')],{stdio:['ignore','ignore','pipe']});
 child.stderr!.on('data',data=>logs+=data);
 for(let i=0;i<200&&!logs.includes('Ready:');i++){assert.equal(child.exitCode,null,logs);await Bun.sleep(50);}
 const address=logs.match(/Web listener at (\S+)/)?.[1];assert(address,logs);const origin='http://'+address;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-proxy-server']});
 const context=await browser.newContext({colorScheme:'light'});const page=await context.newPage();const errors:string[]=[];let sockets=0;
 page.on('pageerror',error=>errors.push(String(error)));page.on('websocket',()=>sockets++);
 await page.goto(origin);await page.locator('.webterm-terminal.-connected').waitFor();
 await expectTheme(page,'light','system');
 await page.evaluate(()=>{(window as any).originalCanvas=document.querySelector('.webterm-terminal canvas');});
 const initialSockets=sockets;
 await page.emulateMedia({colorScheme:'dark'});await expectTheme(page,'dark','system');
 await choose(page,'light');await expectTheme(page,'light','light');
 await page.emulateMedia({colorScheme:'light'});await page.emulateMedia({colorScheme:'dark'});await expectTheme(page,'light','light');
 await choose(page,'dark');await page.emulateMedia({colorScheme:'light'});await expectTheme(page,'dark','dark');
 await choose(page,'ocean','palette');await expectTheme(page,'dark','dark','ocean');
 await choose(page,'graphite','palette');await expectTheme(page,'dark','dark','graphite');
 assert.equal(sockets,initialSockets,'theme switching reconnected the terminal');
 assert(await page.evaluate(()=>(window as any).originalCanvas===document.querySelector('.webterm-terminal canvas')),'theme switching recreated the renderer');
 await page.keyboard.insertText("printf '\\137\\137THEME_OK\\137\\137\\n'");await page.keyboard.press('Enter');
 await page.keyboard.press('Control+f');await page.locator('#search-text').fill('__THEME_OK__');
 await page.waitForFunction(()=>document.querySelector('#search-results')?.textContent==='1 / 1');await page.keyboard.press('Escape');
 // Observe the saved choice before the main workspace module is delivered.
 let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);
 await page.route('**/static/js/workspace-*.js',async route=>{await hold;await route.continue();});
 try{
  await page.reload({waitUntil:'commit'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.themePreference),'dark');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.palette),'graphite');
 }finally{release();}
 await page.waitForLoadState();await page.unroute('**/static/js/workspace-*.js');await page.locator('.webterm-terminal.-connected').waitFor();await expectTheme(page,'dark','dark','graphite');
 await page.getByRole('button',{name:'New session on This server',exact:true}).click();
 const dialog=page.locator('#action-dialog');
 await dialog.waitFor();
 const backdrop=await dialog.evaluate(el=>{
  const style=getComputedStyle(el,'::backdrop');
  return [style.backgroundColor,style.backdropFilter];
 });
 assert.deepEqual(backdrop,['rgba(0, 0, 0, 0)','none'],'creating a session tinted the workspace');
 await expectTheme(page,'dark','dark','graphite');
 await dialog.locator('#action-name').fill('theme-sync');
 const creating=page.waitForResponse(response=>response.url()===origin+'/api/action'&&response.request().postDataJSON().op==='create');
 await dialog.getByRole('button',{name:'Create session',exact:true}).click();
 const response=await creating;
 assert(response.ok());const {session_id}=await response.json();
 await page.waitForURL(url=>url.searchParams.get('session')===session_id);
 await page.locator('.webterm-terminal.-connected').waitFor();
 await expectTheme(page,'dark','dark','graphite');
 // Use a different session for the cross-document test, since one pane has one viewer.
 const initialSession=await (await fetch(origin+'/api/sessions')).json();
 const previous=initialSession.sessions.find((item:{session_id:string})=>item.session_id!==session_id);
 assert(previous);
 const second=await context.newPage();await second.goto(origin+'/?'+new URLSearchParams({session:previous.session_id}));await second.locator('.webterm-terminal.-connected').waitFor();
 await expectTheme(second,'dark','dark','graphite');
 await second.locator('#workspace-menu summary').click();await second.locator('#manage-hosts').click();
 await second.locator('#host-name').fill('preserve editing focus');
 await choose(page,'ocean','palette');await expectTheme(second,'dark','dark','ocean');
 await choose(page,'light');await expectTheme(second,'light','light','ocean');
 assert.equal(await second.locator('#host-name').inputValue(),'preserve editing focus');
 assert(await second.locator('#host-name').evaluate(el=>el===document.activeElement),'synchronized theme stole dialog focus');
 await choose(page,'system');await expectTheme(page,'light','system','ocean');
 await page.emulateMedia({colorScheme:'dark'});await expectTheme(page,'dark','system','ocean');await expectTheme(second,'light','system','ocean');
 await second.close();
 // Invalid persisted input must safely fall back to the system preference.
 await page.evaluate(()=>{localStorage.setItem('rexweb:theme','invalid');localStorage.setItem('rexweb:dark-palette','invalid');});
 await page.reload();await page.locator('.webterm-terminal.-connected').waitFor();await expectTheme(page,'dark','system');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',checks:['light and three dark canvas palettes' ,'explicit choice overrides OS','live OS changes','no renderer recreation or reconnect','input focus retained','saved theme before workspace load','cross-page preference sync without focus theft','invalid preference fallback'],browserErrors:errors.length}));
}finally{
 if(browser)await browser.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}
 await rm(scratch,{recursive:true,force:true});
}
