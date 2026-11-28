import {hosts,localHost,selectedHost,selectHost,preferredSession,hostDescription,type Host} from './hosts';

export interface NavigationWindow {
  window_id: string;
  label: string;
  focused_block_id?: string;
  layers?: {blocks: {block_id: string; label: string}[] | null}[] | null;
}
export interface NavigationView {
  session_id:string;label:string;active_window_id?:string;windows:NavigationWindow[]|null;
  terminal_metadata?:Record<string,{title:string}>;
}
const rail=document.querySelector<HTMLElement>('#sidebar-hosts')!;
const horizontal=document.querySelector<HTMLElement>('#horizontal-tabs')!;
const tabs=document.querySelector<HTMLElement>('#windows')!;
const connection=document.querySelector<HTMLElement>('.connection-picker')!;
const toggle=document.querySelector<HTMLButtonElement>('#layout-toggle')!;
const footer=document.querySelector<HTMLElement>('#sidebar-footer')!;
const currentHostCreate=document.querySelector<HTMLButtonElement>('#current-host-create')!;
const groups=new Map<string,{element:HTMLElement;caption:HTMLElement;items:HTMLElement;summary?:string}>();
const views=new Map<string,NavigationView>();
const loaded=new Map<string,{at:number;endpoint:string;session?:string}>();
const SUMMARY_MAX_AGE=30_000;
let current:NavigationView|undefined;
let vertical=false;
let controller:AbortController|undefined;
let groupSignature='';
let viewportVisible=true;

function icon(name:string){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('icon');svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href',`#icon-${name}`);svg.append(use);return svg;
}
export function windowTitle(window: NavigationWindow, metadata?: NavigationView["terminal_metadata"]) {
  const label = window.label?.trim();
  if (label && !/^(?:terminal|window(?:\s+#?(?:\d+|[0-9a-f]{8}(?:-[0-9a-f-]+)?))?)$/i.test(label)) return label;
  const title = metadata?.[window.focused_block_id ?? ""]?.title?.trim();
  if (title) return title;
  for (const layer of window.layers ?? []) {
    const block = window.focused_block_id
      ? layer.blocks?.find(candidate => candidate.block_id === window.focused_block_id)
      : layer.blocks?.[0];
    const name = block?.label?.trim();
    if (name) return name;
  }
  return "Terminal";
}
function groupHosts():Host[]{return [localHost,...hosts];}
function requestSessionCreation(host:string){
  window.dispatchEvent(new CustomEvent('rexweb:create-session',{detail:host}));
}
currentHostCreate.addEventListener('click',()=>requestSessionCreation(selectedHost));
function mountCurrentTabs(group:{items:HTMLElement}){
  // A selected host replaces its cached summary with the one live tab strip.
  // Leave it attached on ordinary refreshes to preserve focus and node identity.
  if(group.items.childNodes.length!==1||group.items.firstChild!==tabs)group.items.replaceChildren(tabs);
}
function backgroundTabs(host:Host){
  const group=groups.get(host.id)!;
  if(host.id===selectedHost){mountCurrentTabs(group);group.caption.textContent=current?.label??'Sessions';return;}
  const view=views.get(host.id);
  group.caption.textContent=view?.label??'Select a workspace';
  const summary=JSON.stringify([view?.session_id,view?.label,view?.windows?.map(w=>[w.window_id,windowTitle(w,view.terminal_metadata)])]);
  if(group.summary===summary&&!group.items.contains(tabs)&&group.items.children.length===(view?.windows?.length??0))return;
  group.summary=summary;group.items.replaceChildren();
  for(const entry of view?.windows??[]){
    const row=document.createElement('div');row.className='window-tab';row.dataset.active='false';
    const button=document.createElement('button');button.className='tab-select';
    const name=document.createElement('span');name.className='tab-label';name.textContent=windowTitle(entry,view?.terminal_metadata);
    button.append(icon('terminal'),name);button.title=name.textContent;
    button.addEventListener('click',()=>selectHost(host.id,{session:view!.session_id,window:entry.window_id}));
    const close=document.createElement('button');close.className='tab-close';close.append(icon('close'));
    close.setAttribute('aria-label',`Close tab: ${name.textContent}`);close.title='Close tab and its terminals';
    close.addEventListener('click',()=>void (async()=>{
      close.disabled=true;
      try{
        await request(host.id,'api/action',{op:'close-window',session:view!.session_id,window:entry.window_id});
        views.set(host.id,await request(host.id,'api/session?'+new URLSearchParams({session:view!.session_id})));
        if(vertical)backgroundTabs(host);
      }catch{group.caption.textContent='Could not close tab';close.disabled=false;}
    })());
    row.append(button,close);group.items.append(row);
  }
}
function renderGroups(){
  if(!vertical)return;
  const all=groupHosts();
  const signature=JSON.stringify(all);
  if(signature!==groupSignature){
    // Keep the actual tab strip alive while its group containers change.
    horizontal.append(tabs);rail.replaceChildren();groups.clear();groupSignature=signature;
    for(const host of all){
      const element=document.createElement('section');element.className='host-group';element.dataset.host=host.id;
      const button=document.createElement('button');button.className='host-group-heading';
      const name=document.createElement('span');name.textContent=host.label;
      button.append(icon(host.id?'globe':'device'),name);
      button.title=`${host.label} · ${hostDescription(host)}`;
      button.addEventListener('click',()=>selectHost(host.id));
      const caption=document.createElement('div');caption.className='host-group-caption';
      const sessionBar=document.createElement('div');sessionBar.className='host-session-bar';
      const create=document.createElement('button');
      create.type='button';create.className='host-session-create';
      create.title=`New session on ${host.label}`;
      create.setAttribute('aria-label',create.title);
      create.setAttribute('aria-haspopup','dialog');
      create.append(icon('plus'),'New session');
      create.addEventListener('click',()=>requestSessionCreation(host.id));
      sessionBar.append(caption,create);
      const items=document.createElement('div');items.className='host-group-tabs';
      element.append(button,sessionBar,items);rail.append(element);groups.set(host.id,{element,caption,items});
    }
  }
  for(const host of all)backgroundTabs(host);
}
async function request(host:string,path:string,body?:Record<string,unknown>,signal?:AbortSignal){
  const url=new URL(path,document.baseURI);if(host)url.searchParams.set('host',host);
  const response=await fetch(url,{signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error(`HTTP ${response.status}`);return response.json();
}
async function loadBackground(){
  controller?.abort();
  if(!vertical||document.hidden||!viewportVisible)return;
  controller=new AbortController();const signal=controller.signal;
  // Read only the preferred/first session for each inactive host. No terminal
  // data connections, mutations, automatic retries or background polling.
  const queue=groupHosts().filter(h=>{
    if(h.id===selectedHost)return false;
    const cached=loaded.get(h.id),preferred=preferredSession(h.id);
    return !cached||cached.endpoint!==h.endpoint||performance.now()-cached.at>=SUMMARY_MAX_AGE||(preferred!==undefined&&cached.session!==preferred);
  });
  await Promise.allSettled(Array.from({length:Math.min(4,queue.length)},async()=>{
    while(queue.length&&!signal.aborted){
      const host=queue.shift()!;
      try{
        const result=await request(host.id,'api/sessions',undefined,signal);
        const sessions:{session_id:string;label:string}[]=result.sessions??[];
        const session=sessions.find(s=>s.session_id===preferredSession(host.id))??sessions[0];
        if(session){const view=await request(host.id,'api/session?'+new URLSearchParams({session:session.session_id}),undefined,signal);if(!signal.aborted)views.set(host.id,view);}
        else if(!signal.aborted)views.delete(host.id);
        if(!signal.aborted)loaded.set(host.id,{at:performance.now(),endpoint:host.endpoint,session:session?.session_id});
        if(!signal.aborted&&vertical&&host.id!==selectedHost)backgroundTabs(host);
      }catch{const group=groups.get(host.id);if(!signal.aborted&&host.id!==selectedHost&&group)group.caption.textContent='Connection unavailable';}
    }
  }));
}
export function updateNavigation(view?:NavigationView){
  current=view;if(view){
    views.set(selectedHost,view);
    loaded.set(selectedHost,{at:performance.now(),endpoint:hosts.find(h=>h.id===selectedHost)?.endpoint??'',session:view.session_id});
  }
  const active=view?.windows?.find(w=>w.window_id===view.active_window_id);
  const appTitle = view?.terminal_metadata?.[active?.focused_block_id ?? ""]?.title?.trim();
  document.querySelector('#content-title')!.textContent = appTitle || (active ? windowTitle(active,view?.terminal_metadata) : "Terminal");
  if(vertical){
    const group=groups.get(selectedHost);
    if(group){mountCurrentTabs(group);group.caption.textContent=view?.label??'Sessions';}
  }
}
function setLayout(value:boolean, remember:boolean){
  vertical=value;document.body.dataset.layout=value?'vertical':'horizontal';
  toggle.setAttribute('aria-pressed',String(value));
  toggle.setAttribute('aria-label',value?'Use horizontal tabs':'Use vertical tabs');toggle.title=toggle.getAttribute('aria-label')!;
  rail.hidden=!value;footer.hidden=!value;
  if(value){document.querySelector('#sidebar-connection')!.append(connection);renderGroups();void loadBackground();}
  else{controller?.abort();horizontal.append(tabs);document.querySelector('.tab-bar')!.insertBefore(connection,horizontal);}
  if (remember) {
    try { localStorage.setItem('rexweb:tab-layout', value ? 'vertical' : 'horizontal'); } catch {}
  }
  window.dispatchEvent(new Event('rexweb:layout'));
}
toggle.addEventListener('click',()=>setLayout(!vertical,true));
window.addEventListener('rexweb:hosts-changed',()=>{
  const present=new Set(groupHosts().map(host=>host.id));
  for(const id of views.keys())if(!present.has(id)){views.delete(id);loaded.delete(id);}
  if(vertical){renderGroups();void loadBackground();}
});
window.addEventListener('rexweb:navigate',()=>{
  current=undefined;
  if(vertical){renderGroups();void loadBackground();}
});
window.addEventListener('rexweb:visibility',event=>{
  viewportVisible=!!(event as CustomEvent<boolean>).detail;
  if(viewportVisible)void loadBackground();else controller?.abort();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)controller?.abort();else void loadBackground();});
window.addEventListener('pagehide',()=>controller?.abort());
let preference: string | null = null;
try { preference = localStorage.getItem('rexweb:tab-layout'); } catch {}
setLayout(preference !== 'horizontal', false);
