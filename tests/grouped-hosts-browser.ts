import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,type Browser} from '../web/node_modules/playwright';

const scratch=await mkdtemp('/tmp/browser-rex-grouped-');
const children:ReturnType<typeof spawn>[]=[];
let browser:Browser|undefined;

async function start(name:string,flags:string[]){
 const child=spawn(resolve('bin/browser-rex'),[
  '-listen','127.0.0.1:0','-isolation','host','-workspace',join(scratch,name,'work'),
  '-session-socket',join(scratch,name,'runtime','rex.sock'),...flags,
 ],{stdio:['ignore','ignore','pipe']});
 children.push(child);
 let log='';
 child.stderr!.on('data',data=>log+=data);
 for(let i=0;i<200&&!log.includes('Ready:');i++){
  assert.equal(child.exitCode,null,log);
  await Bun.sleep(40);
 }
 const web=log.match(/Web listener at (\S+)/)?.[1];
 assert(web,log);
 return {web:'http://'+web,native:log.match(/Rex listener at (\S+)/)?.[1]};
}

async function list(origin:string){
 const response=await fetch(origin+'/api/sessions');
 assert(response.ok);
 return (await response.json()).sessions as {session_id:string;label:string}[];
}

try{
 const rex=await start('native',['-mode','both','-rex-listen','127.0.0.1:0']);
 assert(rex.native);
 const registry=join(scratch,'hosts.json');
 await writeFile(registry,JSON.stringify([{id:'same-machine',label:'Example server',endpoint:'http://'+rex.native}]),{mode:0o600});
 const service=await start('gateway',['-hosts-file',registry,'-local-host-group','same-machine']);
 const [native]=await list(rex.web);
 const [local]=await list(service.web);
 assert.notEqual(native.session_id,local.session_id);
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--no-proxy-server']});
 const page=await browser.newPage();
 await page.goto(service.web);
 await page.waitForURL(url=>url.searchParams.get('host')==='same-machine'&&url.searchParams.get('session')===native.session_id);
 const host=page.locator('.host-group[data-host="same-machine"]');
 const localRow=host.locator(`[data-session-id="${local.session_id}"]`);
 await localRow.waitFor();
 assert.equal(await page.locator('.host-group').count(),1);
 assert.equal(await localRow.locator('.host-group-caption').getAttribute('title'),`Built-in shell · ${local.label}`);
 await localRow.locator('.host-group-caption').click();
 await page.waitForURL(url=>!url.searchParams.has('host')&&url.searchParams.get('session')===local.session_id);
 await localRow.locator('.window-tab[data-active="true"]').waitFor();
 await page.reload();
 await localRow.locator('.window-tab[data-active="true"]').waitFor();
 await host.locator('.host-group-row').hover();
 await host.getByRole('button',{name:'New session on Example server'}).click();
 await page.locator('#action-name').fill('New native session');
 await page.getByRole('button',{name:'Create session',exact:true}).click();
 await page.waitForURL(url=>url.searchParams.get('host')==='same-machine');
 assert((await list(rex.web)).some(item=>item.label==='New native session'));
 assert.equal((await list(service.web)).length,1);
 console.log('One host group, both backends reachable, and new sessions routed to native Rex.');
}finally{
 if(browser)await browser.close();
 for(const child of children.reverse()){
  if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
 }
 await rm(scratch,{recursive:true,force:true});
}
