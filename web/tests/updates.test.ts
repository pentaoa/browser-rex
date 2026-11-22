import {describe,expect,test} from 'bun:test';
import {WorkspaceUpdates} from '../src/updates';

function environment(){
  const originalWindow=globalThis.window,originalDocument=globalThis.document;
  const timers=new Map<number,()=>void>();let serial=0;
  const visibility={hidden:false};
  globalThis.window={setTimeout:(fn:()=>void)=>{timers.set(++serial,fn);return serial;},clearTimeout:(id:number)=>timers.delete(id)} as unknown as Window & typeof globalThis;
  globalThis.document=visibility as Document;
  return {visibility,timers,restore:()=>{globalThis.window=originalWindow;globalThis.document=originalDocument;}};
}

describe('workspace update lifecycle',()=>{
  test('switching hosts aborts old long polls and ignores their late results',async()=>{
    const env=environment();let refreshes=0;
    const pending:{resolve:(value:string)=>void;signal:AbortSignal}[]=[];
    const updates=new WorkspaceUpdates(async()=>{refreshes++;},(_,signal)=>new Promise(resolve=>pending.push({resolve,signal})));
    try{
      updates.start();updates.start();
      expect(pending.length).toBe(2);expect(pending[0]!.signal.aborted).toBe(true);
      pending[0]!.resolve('old-host');await Bun.sleep(0);expect(refreshes).toBe(0);
      pending[1]!.resolve('new-host');await Bun.sleep(0);expect(refreshes).toBe(1);
      expect(pending.length).toBe(3);
    }finally{updates.stop();pending.at(-1)?.resolve('stopped');await Bun.sleep(0);env.restore();}
  });

  test('hidden pages start no requests and stopping updates cancels the error backoff',async()=>{
    const env=environment();let refreshes=0,reads=0;
    const updates=new WorkspaceUpdates(async()=>{refreshes++;},async()=>{reads++;throw Error('disconnected');});
    try{
      env.visibility.hidden=true;updates.start();updates.start();await Bun.sleep(0);
      expect(refreshes).toBe(0);expect(reads).toBe(0);expect(env.timers.size).toBe(0);
      env.visibility.hidden=false;updates.start();await Bun.sleep(0);
      expect(refreshes).toBe(1);expect(env.timers.size).toBe(1);
      updates.stop();expect(env.timers.size).toBe(0);
    }finally{updates.stop();env.restore();}
  });
});
