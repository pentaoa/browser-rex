const closing = new WeakMap<HTMLDialogElement, Animation>();

export function dismissDialog(dialog: HTMLDialogElement) {
  if (!dialog.open || closing.has(dialog)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return; }
  const animation=dialog.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(4px)'}],{duration:120,easing:'ease-in'});
  closing.set(dialog,animation);dialog.classList.add('is-closing');
  animation.onfinish=()=>{if(closing.get(dialog)===animation){dialog.close();animation.cancel();closing.delete(dialog);dialog.classList.remove('is-closing');}};
}

export function bindDialog(dialog: HTMLDialogElement) {
  dialog.addEventListener('cancel',event=>{event.preventDefault();dismissDialog(dialog);});
  dialog.addEventListener('close',()=>{closing.get(dialog)?.cancel();closing.delete(dialog);dialog.classList.remove('is-closing');});
}
