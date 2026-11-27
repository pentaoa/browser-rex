import {visibleFrame} from './viewport';
export let selectedHost = new URLSearchParams(location.search).get("host") ?? "";
const lastSessions=new Map<string,string>();
const initialSession=new URLSearchParams(location.search).get('session');
if(initialSession)lastSessions.set(selectedHost,initialSession);

export interface Host { id: string; label: string; endpoint: string }
const dialog = document.querySelector<HTMLDialogElement>("#hosts-dialog")!;
const picker = document.querySelector<HTMLButtonElement>("#host-picker")!;
const create = document.querySelector<HTMLButtonElement>("#current-host-create")!;
const popover = document.querySelector<HTMLElement>("#host-popover")!;
const hostFilter = document.querySelector<HTMLInputElement>("#host-filter")!;
const options = document.querySelector<HTMLElement>("#host-options")!;
export let hosts: Host[] = [];
export const hostPickerOpen = () => popover.matches(":popover-open");
export const preferredSession = (host: string) => lastSessions.get(host);
let filtered: Host[] = [];
let highlighted = 0;

function hostIcon(id: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#icon-${id}`); svg.append(use); return svg;
}
export function hostDescription(host: Host) {
  return host.id ? new URL(host.endpoint).host : "This server";
}
function updatePicker() {
  const host = [{id:"",label:"Local",endpoint:""}, ...hosts].find(h => h.id === selectedHost);
  picker.dataset.value = selectedHost;
  document.querySelector("#host-label")!.textContent = host?.label ?? "Unavailable host";
  document.querySelector("#host-detail")!.textContent = host ? hostDescription(host) : selectedHost;
  picker.querySelector(".host-symbol use")!.setAttribute("href", selectedHost ? "#icon-globe" : "#icon-device");
  picker.title = host ? `${host.label} · ${hostDescription(host)}` : "Choose host";
  create.title = `New session on ${selectedHost ? host?.label ?? selectedHost : "This server"}`;
  create.setAttribute("aria-label", create.title);
}
function highlight(index: number) {
  highlighted = Math.max(0, Math.min(filtered.length - 1, index));
  options.querySelectorAll<HTMLElement>(".host-option").forEach((row,i) => row.dataset.focused = String(i === highlighted));
  const row = options.children[highlighted] as HTMLElement | undefined;
  if (row) { hostFilter.setAttribute("aria-activedescendant", row.id); row.scrollIntoView({block:"nearest"}); }
  else hostFilter.removeAttribute("aria-activedescendant");
}
function renderOptions() {
  const query = hostFilter.value.trim().toLocaleLowerCase();
  filtered = [{id:"",label:"Local",endpoint:""}, ...hosts].filter(h => `${h.label} ${h.endpoint}`.toLocaleLowerCase().includes(query));
  options.replaceChildren();
  filtered.forEach((host,i) => {
    const row = document.createElement("button"); row.type = "button";
    row.className = "host-option"; row.id = `host-option-${i}`; row.tabIndex = -1;
    row.dataset.host = host.id; row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(host.id === selectedHost));
    const text = document.createElement("span"); text.className = "host-option-text";
    const title = document.createElement("strong"); title.textContent = host.label;
    const detail = document.createElement("small"); detail.textContent = hostDescription(host);
    text.append(title,detail); row.append(hostIcon(host.id ? "globe" : "device"),text);
    if (host.id === selectedHost) row.append(hostIcon("check"));
    row.addEventListener("pointermove",()=>highlight(i));
    row.addEventListener("click",()=>selectHost(host.id)); options.append(row);
  });
  document.querySelector<HTMLElement>("#host-empty")!.hidden = filtered.length > 0;
  highlight(Math.max(0,filtered.findIndex(h => h.id === selectedHost)));
}
function positionPicker() {
  if (!hostPickerOpen()) return;
  const rect = picker.getBoundingClientRect();
  const frame = visibleFrame(innerWidth,innerHeight,window.visualViewport);
  const width = Math.min(336,Math.max(1,frame.width - 16));
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(32,frame.height - 16)}px`;
  const height = popover.getBoundingClientRect().height;
  const bottom = frame.top + frame.height;
  popover.style.left = `${Math.max(frame.left + 8,Math.min(frame.left + frame.width - width - 8,rect.left))}px`;
  popover.style.top = `${Math.max(frame.top + 8,Math.min(bottom - height - 8,rect.bottom + height + 8 > bottom ? rect.top - height - 6 : rect.bottom + 6))}px`;
}
function closePicker(restore = false) {
  if (hostPickerOpen()) popover.hidePopover();
  if (restore) window.dispatchEvent(new Event("rexweb:picker-dismiss"));
}
picker.addEventListener("click",()=>{
  if (hostPickerOpen()) { closePicker(true); return; }
  hostFilter.value = ""; renderOptions(); popover.showPopover(); positionPicker(); highlight(highlighted); hostFilter.focus();
});
popover.addEventListener("toggle",()=>{
  const open = hostPickerOpen(); picker.setAttribute("aria-expanded",String(open)); hostFilter.setAttribute("aria-expanded",String(open));
});
hostFilter.addEventListener("input",()=>{renderOptions();positionPicker();});
popover.addEventListener("keydown",event=>{
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePicker(true); }
  if (event.target !== hostFilter) return;
  if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
    event.preventDefault(); highlight(event.key === "Home" ? 0 : event.key === "End" ? filtered.length - 1 : highlighted + (event.key === "ArrowDown" ? 1 : -1));
  }
  if (event.key === "Enter") { event.preventDefault(); const host = filtered[highlighted]; if (host) selectHost(host.id); }
});
window.addEventListener("resize",positionPicker);
window.visualViewport?.addEventListener('resize',positionPicker);
window.visualViewport?.addEventListener('scroll',positionPicker);
const form = document.querySelector<HTMLFormElement>("#host-form")!;
const name = document.querySelector<HTMLInputElement>("#host-name")!;
const address = document.querySelector<HTMLInputElement>("#host-address")!;
const message = document.querySelector<HTMLOutputElement>("#host-message")!;
const list = document.querySelector<HTMLElement>("#host-list")!;
let editing = "";
let busy = false;
export const hostDialogOpen = () => dialog.open;

export function selectHost(id: string, target?: {session: string; window?: string}) {
  closePicker();
  if(id===selectedHost && (!target || target.session===new URLSearchParams(location.search).get('session'))){
    dialog.close();
    if (target?.window) window.dispatchEvent(new CustomEvent('rexweb:focus-window',{detail:target.window}));
    else window.dispatchEvent(new Event('rexweb:picker-dismiss'));
    return;
  }
  const url = new URL(location.href);
  const currentSession=url.searchParams.get('session');
  if(currentSession)lastSessions.set(selectedHost,currentSession);
  if (id) url.searchParams.set("host", id); else url.searchParams.delete("host");
  const session=target?.session ?? lastSessions.get(id);
  if(session)url.searchParams.set('session',session);else url.searchParams.delete('session');
  selectedHost=id;
  history.pushState(null,"",url);
  updatePicker();
  dialog.close();
  window.dispatchEvent(new CustomEvent("rexweb:navigate",{detail:{window:target?.window}}));
}

window.addEventListener("popstate",()=>{
  selectedHost=new URLSearchParams(location.search).get("host")??"";
  updatePicker();
  window.dispatchEvent(new Event("rexweb:navigate"));
});

async function request(body?: Record<string, unknown>) {
  const response = await fetch(new URL("api/hosts", document.baseURI), body && {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "Host operation failed");
  return result;
}

function reset() { editing = ""; form.reset(); message.textContent = ""; }

async function load() {
  try {
    const result: { hosts: Host[]; enabled: boolean } = await request();
    hosts = result.hosts;
    updatePicker(); renderOptions();
    window.dispatchEvent(new Event("rexweb:hosts-changed"));
    list.replaceChildren();
    for (const host of result.hosts) {
      const row = document.createElement("div"); row.className = "host-row";
      const details = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = host.label;
      const url = document.createElement("small"); url.textContent = host.endpoint;
      details.append(title, url);
      const actions = document.createElement("div"); actions.className = "host-actions";
      const use = document.createElement("button"); use.type = "button"; use.textContent = "Connect";
      use.addEventListener("click", () => selectHost(host.id));
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        editing = host.id; name.value = host.label; address.value = host.endpoint;
        message.textContent = "Editing connection"; name.focus();
      });
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove";
      remove.addEventListener("click", () => void operation(async () => {
        await request({ op: "remove", id: host.id });
        if (editing === host.id) reset();
        await load(); message.textContent = "Connection removed. Remote sessions keep running.";
      }));
      actions.append(use, edit, remove); row.append(details, actions); list.append(row);
    }
    form.hidden = !result.enabled;
    if (!result.enabled) message.textContent = "Remote hosts are disabled on this server.";
  } catch (error) { message.textContent = String(error); }
}

async function operation(run: () => Promise<void>) {
  if (busy) return;
  busy = true;
  const buttons = dialog.querySelectorAll<HTMLButtonElement>("button:not([data-dismiss])");
  buttons.forEach(button => button.disabled = true);
  try { await run(); } catch (error) { message.textContent = String(error); }
  finally { busy = false; buttons.forEach(button => button.disabled = false); }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  void operation(async () => {
    await request({ op: "save", id: editing, label: name.value, endpoint: address.value });
    reset(); await load(); message.textContent = "Connection saved. Choose Connect to open it.";
  });
});
document.querySelector("#host-test")!.addEventListener("click", () => {
  if (!form.reportValidity()) return;
  void operation(async () => {
    message.textContent = "Connecting…";
    const result = await request({ op: "check", label: name.value, endpoint: address.value });
    message.textContent = `Connected to Rex (API ${result.api_revision}).`;
  });
});
document.querySelector("#host-new")!.addEventListener("click", () => { reset(); name.focus(); });
export function openHosts() {
  closePicker(); reset(); dialog.showModal(); void load();
}
document.querySelector("#manage-hosts")!.addEventListener("click", openHosts);
bindDialog(dialog);
dialog.querySelector("[data-dismiss]")!.addEventListener("click", () => dismissDialog(dialog));
document.querySelector("#picker-manage-hosts")!.addEventListener("click",openHosts);
void load();
import {bindDialog,dismissDialog} from './dialog';
