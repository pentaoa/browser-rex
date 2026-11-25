import type { WebTerminal } from "./webterm/terminal";
import { bindWorkspaceViewport } from "./viewport";
import { previewSplit, type Layout, type Rect } from "./layout";
import { selectedHost, hostDialogOpen, hostPickerOpen, openHosts } from "./hosts";
import { updateNavigation, windowTitle } from "./navigation";
import { WorkspaceUpdates } from "./updates";
import { bindDialog, dismissDialog } from "./dialog";

bindWorkspaceViewport();
let terminalClass: typeof WebTerminal | undefined;

const endpoint = (path: string) => {
  const url = new URL(path.replace(/^\//, ""), document.baseURI);
  if (selectedHost) url.searchParams.set("host", selectedHost);
  return url.href;
};

interface Block {
  block_id: string;
  label: string;
}

interface Session {
  session_id: string;
  label: string;
}

interface WorkspaceWindow {
  window_id: string;
  label: string;
  focused_block_id?: string;
  layers: { kind: string; layout: Layout | null; blocks: Block[] | null }[] | null;
}

interface TerminalMetadata { title:string; pwd:string; revision:number; state:string; app?:string; message?:string; status_title?:string; progress?:number; }
interface View extends Session {
  terminal_metadata?:Record<string,TerminalMetadata>;
  revision: number;
  active_window_id?: string;
  windows: WorkspaceWindow[] | null;
}

const sessionLabel = document.querySelector<HTMLElement>("#session-label")!;
const windows = document.querySelector<HTMLElement>("#windows")!;
const workspace = document.querySelector<HTMLElement>("#workspace")!;
const sessionLoading = document.querySelector<HTMLElement>("#session-loading")!;
const status = document.querySelector<HTMLElement>("#status")!;
const chooser = document.querySelector<HTMLDialogElement>("#chooser")!;
const filter = document.querySelector<HTMLInputElement>("#chooser-filter")!;
const chooserItems = document.querySelector<HTMLElement>("#chooser-items")!;
const actionDialog = document.querySelector<HTMLDialogElement>("#action-dialog")!;
const actionName = document.querySelector<HTMLInputElement>("#action-name")!;

const panes = new Map<string, { element: HTMLElement; terminal?: WebTerminal }>();
const rendererChoice = new URLSearchParams(location.search).get('renderer') === 'webgpu' ? 'webgpu' : 'canvas';
const bidiEnabled = new URLSearchParams(location.search).get('bidi') === '1';
function chooseBidi() {
  const url = new URL(location.href);
  if (bidiEnabled) url.searchParams.delete('bidi'); else url.searchParams.set('bidi', '1');
  if (sessionId) url.searchParams.set('session', sessionId);
  location.assign(url.href);
}
function chooseRenderer(renderer: 'canvas' | 'webgpu') {
  const url = new URL(location.href);
  if (renderer === 'canvas') url.searchParams.delete('renderer'); else url.searchParams.set('renderer', renderer);
  if (sessionId) url.searchParams.set('session', sessionId);
  location.assign(url.href);
}
let sessionId = new URLSearchParams(location.search).get("session") ?? "";
let view: View | undefined;
let activeWindow: WorkspaceWindow | undefined;
let loading = false;
let acting = false;
let dragging = false;
let sessionList: Session[] = [];
let chooserMode: "sessions" | "commands" = "sessions";
let pendingAction: (() => void) | undefined;
let navigating = true;
let refreshPending = false;
let refreshController: AbortController | undefined;
let refreshGeneration = 0;
let presentation = "";
let requestedWindow: string | undefined;
let viewportVisible = true;
const visible=()=>viewportVisible&&!document.hidden;
const tabs = new Map<string, HTMLElement>();
const workspaceMenu = document.querySelector<HTMLDetailsElement>("#workspace-menu")!;
workspaceMenu.addEventListener("click", (event) => {
  if ((event.target as Element).closest("button")) workspaceMenu.open = false;
});
document.addEventListener("pointerdown", (event) => {
  if (!workspaceMenu.contains(event.target as Node)) workspaceMenu.open = false;
});
workspaceMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation();
    workspaceMenu.open = false; focusTerminal();
  }
});

const searchBar = document.querySelector<HTMLElement>("#search-bar")!;
const searchText = document.querySelector<HTMLInputElement>("#search-text")!;
const searchResults =
  document.querySelector<HTMLOutputElement>("#search-results")!;
const searchCase=document.querySelector<HTMLInputElement>('#search-case')!;
const searchWord=document.querySelector<HTMLInputElement>('#search-word')!;
const searchRegex=document.querySelector<HTMLInputElement>('#search-regex')!;
let searchTerminal: WebTerminal | undefined;
let searchTimer: number | undefined;

function runSearch(older?: boolean) {
  if (searchBar.hidden) return;
  const target = panes.get(activeWindow?.focused_block_id ?? "")?.terminal;
  if (target !== searchTerminal) {
    searchTerminal?.clearSearch();
    searchTerminal = target;
  }
  if (!target) {
    searchResults.textContent = "No active pane";
    return;
  }
  target.search(searchText.value, older, (result) => {
    if (searchBar.hidden || target !== searchTerminal) return;
    searchResults.textContent=result.error?'Invalid expression':result.pending?'Searching…':result.resultCount?`${result.resultIndex+1} / ${result.resultCount}${result.truncated?'+':''}`:'0 matches';
    searchResults.title=result.error??(result.truncated?'Search limit reached; results are partial.':'');
  },{regex:searchRegex.checked,caseSensitive:searchCase.checked,wholeWord:searchWord.checked});
}
for(const option of [searchCase,searchWord,searchRegex])option.addEventListener('change',()=>runSearch());

function openSearch() {
  if (chooser.open || actionDialog.open || hostDialogOpen()) return;
  searchBar.hidden = false;
  runSearch();
  searchText.focus();
  searchText.select();
}
function closeSearch() {
  searchBar.hidden = true;
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = undefined;
  searchTerminal?.clearSearch();
  searchTerminal = undefined;
  focusTerminal();
}
document.querySelector("#find-pane")!.addEventListener("click", openSearch);
document.querySelector("#search-close")!.addEventListener("click", closeSearch);
document
  .querySelector("#search-older")!
  .addEventListener("click", () => runSearch(true));
document
  .querySelector("#search-newer")!
  .addEventListener("click", () => runSearch(false));
searchText.addEventListener("input", () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined;
    runSearch();
  }, 80);
});
searchText.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch(!event.shiftKey);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
  }
});

async function exportFocused(format: 'text'|'html'|'vt') {
  const block=activeWindow?.focused_block_id;
  if(!block)return;
  try {
    const query=new URLSearchParams({session:sessionId,block,format,trim:'true'});
    const response=await fetch(endpoint('/api/capture?'+query));
    if(!response.ok){const error=await response.json();throw new Error(error.message??'Capture failed');}
    const url=URL.createObjectURL(await response.blob());
    const link=document.createElement('a');link.href=url;link.download=`terminal.${format==='text'?'txt':format}`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch(error){status.textContent=String(error);}
}

let uploadsEnabled=false;
const uploadInput=document.querySelector<HTMLInputElement>('#upload-file')!;
async function loadCapabilities() {
  const host=selectedHost;
  uploadsEnabled=false;
  try {const value=await api<{uploads:boolean}>('/api/capabilities');if(host===selectedHost)uploadsEnabled=!!value.uploads;}catch{}
}
async function uploadToPane(file:File,session:string,block:string):Promise<string> {
  if(!uploadsEnabled)throw new Error('Uploads are disabled; configure -uploads with web password authentication.');
  const body=new FormData();body.append('file',file,file.name);
  const response=await fetch(endpoint('/api/upload?'+new URLSearchParams({session,block})),{method:'POST',body});
  const result=await response.json();if(!response.ok)throw new Error(result.message??'Upload failed');
  status.textContent=`Uploaded ${result.display_name||result.name}`;return result.path;
}
uploadInput.addEventListener('change',()=>{
  const terminal=panes.get(activeWindow?.focused_block_id??'')?.terminal;
  const files=Array.from(uploadInput.files??[]);uploadInput.value='';
  if(files.length>8){status.textContent='Select at most eight files.';return;}
  if(terminal)void (async()=>{for(const file of files)await terminal.uploadFile(file)})().catch(error=>{status.textContent=String(error);});
});
workspace.addEventListener('upload-error',event=>{status.textContent=(event as CustomEvent).detail;});

function icon(name: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function terminalTheme() {
  const root = document.documentElement;
  const colors = getComputedStyle(root);
  const color = (token: string) => colors.getPropertyValue(token).trim();
  const dark = root.dataset.theme === "dark";
  const preset = root.dataset.palette === "ocean" ? "tokyo" : root.dataset.palette === "graphite" ? "github" : "catppuccin";
  const background = color("--surface");
  return {
    ...terminalClass?.getTheme(dark ? preset : "tango"),
    background,
    foreground: color("--text"),
    cursor: color("--accent"),
    cursorAccent: background,
    selectionBackground: color("--terminal-selection"),
    selectionForeground: color("--terminal-selection-text"),
  };
}

function focusTerminal() {
  if (!workspaceMenu.open && !chooser.open && !actionDialog.open && !hostDialogOpen() && !hostPickerOpen() && searchBar.hidden) {
    panes.get(activeWindow?.focused_block_id ?? "")?.terminal?.focus();
  }
}

async function api<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint(path), {
    signal,
    ...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function updateMetadata(next:View) {
  for (const entry of next.windows ?? []) {
    const label = tabs.get(entry.window_id)?.querySelector('.tab-label');
    if (label) {
      const title=windowTitle(next,entry);label.textContent=title;
      const tab=tabs.get(entry.window_id)!;
      tab.querySelector<HTMLButtonElement>('.tab-select')!.title=title;
      tab.querySelector('.tab-close')!.setAttribute('aria-label',`Close tab: ${title}`);
    }
  }
  updateNavigation(next);
  for(const [id,metadata] of Object.entries(next.terminal_metadata??{})){
    const pane=panes.get(id);if(!pane)continue;
    const label=pane.element.querySelector<HTMLElement>('.pane-label');
    if(label){label.textContent=metadata.title||'Shell';label.title=metadata.pwd||'';}
    const badge=pane.element.querySelector<HTMLElement>('.pane-status');
    if(badge){badge.hidden=!metadata.state||metadata.state==='idle';badge.dataset.state=metadata.state;badge.textContent=metadata.state+(metadata.progress!==undefined?` ${metadata.progress}%`:'');badge.title=metadata.message||metadata.status_title||metadata.app||metadata.state;}
  }
}

function setSessionLoading(busy: boolean) {
  sessionLoading.hidden = !busy;
  workspace.setAttribute("aria-busy", String(busy));
}

function selectSession(id: string) {
  if (id === sessionId) return;
  sessionId = id;
  view = undefined;
  navigating = true;
  status.textContent = "";
  render();
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

async function refresh() {
  if(!visible())return;
  if (loading || acting || dragging) {refreshPending=true;return;}
  loading = true;
  refreshPending=false;
  const generation=refreshGeneration;
  const controller=new AbortController();refreshController=controller;
  try {
    const { sessions: available } = await api<{ sessions: Session[] | null }>("/api/sessions",undefined,controller.signal);
    if(generation!==refreshGeneration)return;
    const list = available ?? [];
    if (!list.some((entry) => entry.session_id === sessionId)) {
      selectSession(list[0]?.session_id ?? "");
    }
    sessionList = list;
    sessionLabel.textContent = list.find((entry) => entry.session_id === sessionId)?.label || "Sessions";
    const id = sessionId;
    if (id) {
      const next = await api<View>(`/api/session?${new URLSearchParams({ session: id })}`,undefined,controller.signal);
      if(generation!==refreshGeneration)return;
      if (!dragging && id === sessionId && (!view || next.revision !== view.revision)) {
        view = next;
        navigating=false;
        renderIfChanged();
      }
      updateMetadata(next);
    }
    navigating=false;
    setSessionLoading(false);
    if(!id)renderIfChanged();
    status.textContent = id ? "" : "Create or select a session.";
    return true;
  } catch (error) {
    if(controller.signal.aborted||generation!==refreshGeneration)return;
    setSessionLoading(false);
    status.textContent = String(error);
    return false;
  } finally {
    loading = false;
    if(refreshController===controller)refreshController=undefined;
    if(generation===refreshGeneration&&requestedWindow&&view?.windows?.some(w=>w.window_id===requestedWindow)){
      const target=requestedWindow;requestedWindow=undefined;
      if(view.active_window_id!==target)void act('focus-window',{window:target});
    }
    if(refreshPending&&!acting&&!dragging&&visible()){refreshPending=false;queueMicrotask(()=>void refresh());}
  }
}

async function act(op: string, args: Record<string, unknown> = {}) {
  if (acting||navigating) return;
  acting = true;
  const generation=refreshGeneration;
  refreshController?.abort();
  try {
    const result = await api<{ session_id?: string }>("/api/action", { op, session: sessionId, ...args });
    if(generation===refreshGeneration&&op === "create" && result.session_id) selectSession(result.session_id);
  } catch (error) {
    if(generation===refreshGeneration)status.textContent = String(error);
    return;
  } finally {
    acting = false;
    if(refreshPending&&visible())queueMicrotask(()=>{if(!loading&&!acting&&!dragging)void refresh();});
  }
  await refresh();
  focusTerminal();
}

function place(element: HTMLElement, [x, y, width, height]: Rect) {
  Object.assign(element.style, {
    left: `${100 * x}%`, top: `${100 * y}%`,
    width: `${100 * width}%`, height: `${100 * height}%`,
  });
}

function mountPane(block: Block, rect: Rect, keep: Set<string>) {
  const id = block.block_id;
  keep.add(id);
  let pane = panes.get(id);
  if (!pane) {
    const element = document.createElement("section");
    element.className = "pane";
    const header = document.createElement("header");
    header.className = "pane-header";
    const title = document.createElement("div");
    title.className = "pane-title";
    const label = document.createElement("span");
    label.className = "pane-label";
    const badge=document.createElement('span');badge.className='pane-status';badge.hidden=true;
    title.append(icon("terminal"), label, badge);
    const actions = document.createElement("div");
    actions.className = "pane-actions";
    for (const [op, name, glyph] of [
      ["split-right", "Split right", "right"],
      ["split-down", "Split down", "down"],
      ["close-block", "Close pane", "close"],
    ]) {
      const button = document.createElement("button");
      button.className = "icon-button";
      button.title = name;
      button.setAttribute("aria-label", name);
      button.append(icon(glyph));
      button.addEventListener("click", () => runCommand(op, id));
      actions.append(button);
    }
    header.append(title, actions);
    const terminal = document.createElement("div");
    terminal.className = "webterm-terminal";
    const viewport = document.createElement("div");
    viewport.className = "terminal-viewport";
    const loader = document.createElement("div");
    loader.className = "terminal-loading";
    loader.setAttribute("role", "status");
    loader.textContent = "Loading terminal…";
    const errorMessage = document.createElement("span");
    errorMessage.className = "terminal-load-error";
    errorMessage.setAttribute("role", "status");
    errorMessage.textContent = "Could not connect to the terminal.";
    viewport.append(terminal, loader, errorMessage);
    element.append(header, viewport);
    workspace.append(element);
    pane = { element };
    panes.set(id, pane);
    element.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button")) return;
      if (event.pointerType === "mouse") panes.get(id)?.terminal?.focus(true);
      if (activeWindow?.focused_block_id !== id) void act("focus-block", { block: id });
    });
    const url = new URL("api/terminal", document.baseURI);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ session: sessionId, block: id }).toString();
    if (selectedHost) url.searchParams.set("host", selectedHost);
    const mounted = pane;
    const ownerSession=sessionId;
    const appearanceKey = () => {
      const {theme, palette} = document.documentElement.dataset;
      return theme === "dark" ? `dark:${palette}` : "light";
    };
    let initialAppearance: string;
    void import('./webterm/terminal').then(({WebTerminal})=>{
      if(panes.get(id)!==mounted)return;
      terminalClass=WebTerminal;
      initialAppearance = appearanceKey();
      return WebTerminal.create(terminal, url.href, { autofocus: false, fontSize: 14, renderer: rendererChoice, bidi: bidiEnabled, theme: terminalTheme(), uploadFile:file=>uploadToPane(file,ownerSession,id) });
    }).then((instance) => {
      if(!instance)return;
      if (panes.get(id) === mounted) {
        mounted.terminal = instance;
        // Appearance may have changed while the renderer or WASM was loading.
        if (initialAppearance !== appearanceKey()) instance.setTheme(terminalTheme());
        if (activeWindow?.focused_block_id === id) { focusTerminal(); runSearch(); }
      }
      else instance.dispose();
    }).catch(() => {
      errorMessage.textContent = "Could not initialize the terminal renderer.";
      terminal.classList.add("-load-error");
    });
  }
  pane.element.querySelector(".pane-label")!.textContent = block.label || "Shell";
  pane.element.classList.toggle("active", activeWindow?.focused_block_id === id);
  place(pane.element, rect);
}

function firstBlock(node: Layout): string | null {
  return node.split ? firstBlock(node.split.before) : node.block_id ?? null;
}

function placeDivider(divider: HTMLElement, node: Layout) {
  const { direction, ratio } = node.split!;
  const [x, y, width, height] = node.rect;
  const horizontal = direction === "horizontal";
  place(divider, horizontal ? [x + width * ratio, y, 0, height] : [x, y + height * ratio, width, 0]);
  Object.assign(divider.style, horizontal ?
    { width: "9px", marginLeft: "-4px", cursor: "col-resize" } :
    { height: "9px", marginTop: "-4px", cursor: "row-resize" });
  divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
}

function placePreview(node: Layout) {
  if (node.split) {
    const divider = workspace.querySelector<HTMLElement>(`[data-split="${CSS.escape(node.split.split_id)}"]`);
    if (divider) placeDivider(divider, node);
    placePreview(node.split.before);
    placePreview(node.split.after);
  } else if (node.block_id) {
    const pane = panes.get(node.block_id);
    if (pane) place(pane.element, node.rect);
  }
}

function renderLayout(node: Layout, blocks: Map<string, Block>, keep: Set<string>) {
  if (!node.split) {
    const block = node.block_id && blocks.get(node.block_id);
    if (block) mountPane(block, node.rect, keep);
    return;
  }

  const { before, after, direction, ratio, split_id } = node.split;
  renderLayout(before, blocks, keep);
  renderLayout(after, blocks, keep);

  const horizontal = direction === "horizontal";
  const [x, y, width, height] = node.rect;
  const divider = document.createElement("div");
  divider.className = "divider";
  divider.dataset.split = split_id;
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "Resize split");
  divider.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
  placeDivider(divider, node);

  let pausedUpdates=false;
  const resize = async (next: number) => {
    const beforeId = firstBlock(before);
    const afterId = firstBlock(after);
    if (beforeId && afterId) {
      try{
        await act("resize-split", {
          before: beforeId, after: afterId, direction,
          ratio: Math.min(.95, Math.max(.05, next)),
        });
        // Reconcile the preview with the daemon, including a rejected resize.
        if (!dragging) render();
      }finally{if(pausedUpdates){pausedUpdates=false;resumeUpdates();}}
    }
  };
  let pointerId: number | undefined;
  let previewFrame: number | undefined;
  let previewRatio = ratio;
  const paintPreview = () => {
    previewFrame = undefined;
    placePreview(previewSplit(node, previewRatio));
  };
  const pointerRatio = (event: PointerEvent) => {
    const box = workspace.getBoundingClientRect();
    return Math.min(.95, Math.max(.05, horizontal ? ((event.clientX - box.left) / box.width - x) / width :
      ((event.clientY - box.top) / box.height - y) / height));
  };
  const endDrag = (commit = false) => {
    if (pointerId === undefined) return;
    const captured = pointerId;
    pointerId = undefined;
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
    if (!commit) placePreview(node);
    dragging = false;
    document.body.classList.remove("resizing-columns", "resizing-rows");
    window.removeEventListener("blur", cancelDrag);
    if (divider.hasPointerCapture(captured)) divider.releasePointerCapture(captured);
    if(!commit&&pausedUpdates){pausedUpdates=false;resumeUpdates();}
  };
  const cancelDrag = () => endDrag();
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragging) return;
    event.preventDefault();
    pointerId = event.pointerId;
    dragging = true;
    pausedUpdates=true;updates.stop();
    for(const pane of panes.values())for(const animation of pane.element.getAnimations())animation.cancel();
    document.body.classList.add(horizontal ? "resizing-columns" : "resizing-rows");
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    window.addEventListener("blur", cancelDrag);
  });
  divider.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    previewRatio = pointerRatio(event);
    if (previewFrame === undefined) previewFrame = requestAnimationFrame(paintPreview);
  });
  divider.addEventListener("lostpointercapture", cancelDrag);
  divider.addEventListener("pointercancel", cancelDrag);
  divider.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    previewRatio = pointerRatio(event);
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    paintPreview();
    endDrag(true);
    void resize(previewRatio);
  });
  divider.addEventListener("keydown", (event) => {
    const step = event.key === (horizontal ? "ArrowLeft" : "ArrowUp") ? -.05 :
      event.key === (horizontal ? "ArrowRight" : "ArrowDown") ? .05 : 0;
    if (step) {
      event.preventDefault();
      void resize(ratio + step);
    }
  });
  workspace.append(divider);
}

function render() {
  const previousBlock = activeWindow?.focused_block_id;
  activeWindow = view?.windows?.find((entry) => entry.window_id === view?.active_window_id);
  const keepTabs=new Set<string>();let cursor=windows.firstElementChild;
  for(const entry of view?.windows??[]){
    keepTabs.add(entry.window_id);
    let tab=tabs.get(entry.window_id);
    if(!tab){
      tab=document.createElement('div');tab.className='window-tab';
      const select=document.createElement('button');select.className='tab-select';
      const name=document.createElement('span');name.className='tab-label';
      select.append(icon('terminal'),name);
      select.addEventListener('click',()=>void act('focus-window',{window:entry.window_id}));
      const close=document.createElement('button');close.className='tab-close';
      close.append(icon('close'));
      close.addEventListener('click',()=>void act('close-window',{window:entry.window_id}));
      close.addEventListener('pointerdown',event=>event.stopPropagation());
      tab.append(select,close);
      tabs.set(entry.window_id,tab);
    }
    const label=windowTitle(view!,entry);
    const name=tab.querySelector('.tab-label')!;
    if(name.textContent!==label)name.textContent=label;
    const select=tab.querySelector('button')!;
    select.title=label;
    select.setAttribute("aria-current",String(entry===activeWindow));
    tab.dataset.active=String(entry===activeWindow);
    const close=tab.querySelector<HTMLButtonElement>('.tab-close')!;
    close.setAttribute('aria-label',`Close tab: ${label}`);
    close.title=`Close ${label} and its terminals`;
    if(tab!==cursor)windows.insertBefore(tab,cursor);else cursor=cursor.nextElementSibling;
  }
  for(const [id,button] of tabs)if(!keepTabs.has(id)){button.remove();tabs.delete(id);}
  const focusedSplit = (document.activeElement as HTMLElement | null)?.dataset.split;
  for (const divider of workspace.querySelectorAll(".divider")) divider.remove();
  const keep = new Set<string>();
  for (const layer of activeWindow?.layers ?? []) {
    if (layer.kind === "tiled" && layer.layout) {
      renderLayout(layer.layout, new Map(layer.blocks?.map((block) => [block.block_id, block])), keep);
    }
  }
  for (const [id, pane] of panes) {
    if (keep.has(id)) continue;
    pane.terminal?.dispose();
    pane.element.remove();
    panes.delete(id);
  }
  workspace.classList.toggle('has-splits',keep.size>1);
  updateNavigation(view);
  workspace.querySelector(".empty-state")?.remove();
  setSessionLoading(navigating);
  if (!keep.size && !navigating) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const label = document.createElement("p");
    label.textContent = view ? "Open a terminal to get started" : "Your sessions, ready when you are";
    const button = document.createElement("button");
    button.className = "primary";
    button.textContent = view ? "New tab" : "New session";
    button.addEventListener("click", () => runCommand(view ? "new-window" : "create"));
    empty.append(icon("terminal"), label, button);
    workspace.append(empty);
  }
  if (focusedSplit) {
    workspace.querySelector<HTMLElement>(`[data-split="${CSS.escape(focusedSplit)}"]`)?.focus();
  }
  document.querySelectorAll<HTMLButtonElement>("[data-session]").forEach((button) => {
    button.disabled = !view;
  });
  if (previousBlock !== activeWindow?.focused_block_id) { focusTerminal(); runSearch(); }
}

function renderIfChanged(){
  // Owner/client events advance native revisions without changing visible layout.
  const key=JSON.stringify({navigating,session:sessionId,active:view?.active_window_id,windows:view?.windows?.map(w=>({id:w.window_id,label:w.label,focus:w.focused_block_id,layers:w.layers?.filter(l=>l.kind==='tiled').map(l=>({layout:l.layout,blocks:l.blocks?.map(b=>({id:b.block_id,label:b.label}))}))}))});
  if(key===presentation)return;presentation=key;render();
}

function runCommand(op: string, block = activeWindow?.focused_block_id, initialName = "") {
  chooser.close();
  if(op==='upload-file'){uploadInput.click();return;}
  if(op==='previous-prompt'||op==='next-prompt'){
    if(!panes.get(block??'')?.terminal?.navigatePrompt(op==='previous-prompt'))status.textContent='No retained prompt in that direction.';
    focusTerminal();return;
  }
  if(op==='export-text'||op==='export-html'||op==='export-vt'){void exportFocused(op.slice(7) as 'text'|'html'|'vt');return;}
  if (op === "create" || op === "rename" || op === "destroy" || op === "close-block") {
    const naming = op === "create" || op === "rename";
    const label = op === "create" ? "New session" : op === "rename" ? "Rename session" :
      op === "destroy" ? "End session?" : "Close pane?";
    document.querySelector("#action-title")!.textContent = label;
    document.querySelector("#action-description")!.textContent = naming ?
      (op === "create" ? "Start a new terminal workspace." : "Choose a name for this workspace.") :
      (op === "destroy" ? `This will end “${view?.label || "this session"}” and its running programs.` :
        "This will close this terminal and its running program.");
    document.querySelector<HTMLElement>("#action-label")!.hidden = !naming;
    actionName.hidden = !naming;
    actionName.disabled = !naming;
    actionName.value = op === "rename" ? view?.label ?? "" : initialName;
    const submit = document.querySelector<HTMLButtonElement>("#action-submit")!;
    submit.textContent = op === "create" ? "Create session" : op === "rename" ? "Save name" :
      op === "destroy" ? "End session" : "Close pane";
    submit.classList.toggle("danger", !naming);
    const targetSession = sessionId;
    pendingAction = () => void act(op, { session: targetSession, block, ...(naming ? { label: actionName.value.trim() } : {}) });
    actionDialog.showModal();
    if (naming) { actionName.focus(); actionName.select(); }
    else actionDialog.querySelector<HTMLButtonElement>("[data-dismiss]")!.focus();
    return;
  }
  if (op === "split-right" || op === "split-down") {
    void act("split", { block, direction: op === "split-right" ? "horizontal" : "vertical" });
  } else void act(op);
}

type Choice = { label: string; glyph: string; run: () => void; current?: boolean; hint?: string; danger?: boolean };

function renderChooser() {
  const query = filter.value.trim().toLocaleLowerCase();
  chooserItems.replaceChildren();
  let choices: Choice[];
  if (chooserMode === "sessions") {
    choices = sessionList.map((session) => ({
      label: session.label || "Shell", glyph: "terminal", current: session.session_id === sessionId,
      hint: session.session_id === sessionId ? "Current" : undefined,
      run: () => {
        chooser.close();
        if (session.session_id === sessionId) { focusTerminal(); return; }
        refreshGeneration++;
        refreshController?.abort();
        requestedWindow = undefined;
        selectSession(session.session_id);
        void refresh();
      },
    }));
  } else {
    choices = [
      { label: "Manage hosts", glyph: "plus", run: () => { chooser.close(); openHosts(); } },
      { label: "Find in pane", glyph: "search", run: () => { chooser.close(); openSearch(); } },
      { label: "Change session", glyph: "session", run: () => openChooser("sessions"), hint: "⌘K / Ctrl+K" },
      { label: "New session", glyph: "plus", run: () => runCommand("create") },
      ...(view ? [
        { label: "New tab", glyph: "plus", run: () => runCommand("new-window") },
        { label: rendererChoice === 'webgpu' ? 'Use Canvas renderer (reload)' : 'Try WebGPU compositor (reload)', glyph: 'terminal', run: () => chooseRenderer(rendererChoice === 'webgpu' ? 'canvas' : 'webgpu') },
        { label: bidiEnabled ? 'Disable RTL/BiDi (reload)' : 'Enable RTL/BiDi (reload)', glyph: 'terminal', run: chooseBidi },
        ...(uploadsEnabled?[{label:'Upload files…',glyph:'plus',run:()=>runCommand('upload-file')}]:[]),
        { label: "Previous prompt", glyph: "terminal", run: () => runCommand("previous-prompt") },
        { label: "Next prompt", glyph: "terminal", run: () => runCommand("next-prompt") },
        { label: "Export terminal as text", glyph: "terminal", run: () => runCommand("export-text") },
        { label: "Export terminal as HTML", glyph: "terminal", run: () => runCommand("export-html") },
        { label: "Export terminal as VT", glyph: "terminal", run: () => runCommand("export-vt") },
        { label: "Rename session", glyph: "session", run: () => runCommand("rename") },
        { label: "End session", glyph: "close", run: () => runCommand("destroy"), danger: true },
      ] : []),
      ...(activeWindow?.focused_block_id ? [
        { label: "Split right", glyph: "right", run: () => runCommand("split-right") },
        { label: "Split down", glyph: "down", run: () => runCommand("split-down") },
        { label: "Close pane", glyph: "close", run: () => runCommand("close-block"), danger: true },
      ] : []),
    ];
  }
  choices = choices.filter((choice) => choice.label.toLocaleLowerCase().includes(query));
  const appendChoice = (choice: Choice) => {
    const button = document.createElement("button");
    button.className = "chooser-item";
    if (choice.danger) button.classList.add("danger");
    if (choice.current) button.setAttribute("aria-current", "true");
    const label = document.createElement("span");
    label.textContent = choice.label;
    button.append(icon(choice.glyph), label);
    if (choice.hint) {
      const hint = document.createElement("small");
      hint.textContent = choice.hint;
      button.append(hint);
    }
    button.addEventListener("click", choice.run);
    chooserItems.append(button);
  };
  choices.forEach(appendChoice);
  if (chooserMode === "sessions") {
    const divider = document.createElement("div");
    divider.className = "chooser-divider";
    chooserItems.append(divider);
    appendChoice({ label: query ? `Create “${filter.value.trim()}”` : "New session", glyph: "plus",
      run: () => runCommand("create", undefined, filter.value.trim()) });
    if (!query && view) {
      appendChoice({ label: "Rename session", glyph: "session", run: () => runCommand("rename") });
      appendChoice({ label: "End session", glyph: "close", run: () => runCommand("destroy"), danger: true });
    }
  } else if (!choices.length) {
    const empty = document.createElement("p");
    empty.className = "chooser-empty";
    empty.textContent = "No matching commands";
    chooserItems.append(empty);
  }
}

function openChooser(mode: typeof chooserMode) {
  if (actionDialog.open || hostDialogOpen()) return;
  chooserMode = mode;
  document.querySelector("#chooser-title")!.textContent = mode === "sessions" ? "Sessions" : "Commands";
  document.querySelector("#chooser-hint")!.textContent = mode === "sessions" ? "Select a session to resume it" : "↑ ↓ to navigate · enter to run";
  filter.placeholder = mode === "sessions" ? "Filter or create…" : "Type a command…";
  filter.setAttribute("aria-label", mode === "sessions" ? "Filter sessions" : "Filter commands");
  filter.value = "";
  renderChooser();
  if (!chooser.open) chooser.showModal();
  filter.focus();
}

filter.addEventListener("input", renderChooser);
chooser.addEventListener("keydown", (event) => {
  const buttons = [...chooserItems.querySelectorAll<HTMLButtonElement>("button")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length :
      (index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length);
    buttons[next]?.focus();
  } else if (event.key === "Enter" && document.activeElement === filter) {
    event.preventDefault();
    buttons[0]?.click();
  }
});
document.querySelector("#action-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = pendingAction;
  actionDialog.close();
  action?.();
});
for (const dialog of [chooser, actionDialog]) {
  bindDialog(dialog);
  dialog.querySelectorAll("[data-dismiss]").forEach((button) => button.addEventListener("click", () => dismissDialog(dialog)));
  dialog.addEventListener("click", (event) => { if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismissDialog(dialog);
  } });
  dialog.addEventListener("close", () => { if (dialog === actionDialog) pendingAction = undefined; focusTerminal(); });
}
document.querySelector("#session-switcher")!.addEventListener("click", () => openChooser("sessions"));
document.querySelector("#command-palette")!.addEventListener("click", () => openChooser("commands"));
document.querySelector("#hosts-dialog")!.addEventListener("close", focusTerminal);
document.querySelectorAll<HTMLButtonElement>("[data-op]").forEach((button) => {
  button.addEventListener("click", () => runCommand(button.dataset.op!));
});
document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if(key==='f'&&!event.shiftKey&&!chooser.open&&!actionDialog.open){event.preventDefault();event.stopPropagation();openSearch();return;}
  if ((key === "k" && !event.shiftKey) || (key === "p" && event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    openChooser(key === "k" ? "sessions" : "commands");
  }
}, true);
window.addEventListener("rexweb:theme", event => {
  if (terminalClass) {
    const theme = terminalTheme();
    for (const pane of panes.values()) pane.terminal?.setTheme(theme);
  }
  if ((event as CustomEvent<{userInitiated: boolean}>).detail?.userInitiated) focusTerminal();
});

render();
const updates=new WorkspaceUpdates(refresh,async(since,signal)=>{
  const result=await api<{version:string}>('/api/updates?'+new URLSearchParams({since}),undefined,signal);
  return result.version;
});

function resumeUpdates(){
  if(!visible()){updates.stop();return;}
  updates.start();
}
window.addEventListener('rexweb:navigate',(event)=>{
  requestedWindow=(event as CustomEvent<{window?:string}>).detail?.window;
  updates.stop();refreshController?.abort();refreshGeneration++;
  sessionId=new URLSearchParams(location.search).get('session')??'';
  view=undefined;activeWindow=undefined;presentation='';navigating=true;
  status.textContent = "";
  sessionLabel.textContent='Sessions';
  render();void loadCapabilities();resumeUpdates();
});
window.addEventListener('rexweb:focus-window',event=>void act('focus-window',{window:(event as CustomEvent<string>).detail}));
window.addEventListener('rexweb:picker-dismiss',focusTerminal);
window.addEventListener('rexweb:layout',()=>{workspaceMenu.open=false;focusTerminal();});
function syncVisibility(){
  window.dispatchEvent(new CustomEvent('rexweb:visibility',{detail:visible()}));
  if(!visible()){updates.stop();refreshController?.abort();}else resumeUpdates();
}
document.addEventListener('visibilitychange',syncVisibility);
const visibilityObserver=new IntersectionObserver(([entry])=>{
  if(!entry||viewportVisible===entry.isIntersecting)return;
  viewportVisible=entry.isIntersecting;syncVisibility();
});
visibilityObserver.observe(workspace);
window.addEventListener('pagehide',()=>{updates.stop();refreshController?.abort();});
window.addEventListener('pageshow',event=>{if(event.persisted)resumeUpdates();});
void loadCapabilities();resumeUpdates();
