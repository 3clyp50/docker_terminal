import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function load() {
  const source = readFileSync(new URL('../webui/terminal-store.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export const store', 'const store');
  return vm.runInNewContext(`${source}\nstore`, {
    createStore:(_, value)=>value, window:{}, innerHeight:1000, navigator:{platform:'Linux'},
    requestAnimationFrame: callback=>callback(), console,
  });
}

test('host handoff serializes old cleanup before opening the next terminal', async () => {
  const store=load(), events=[];
  let release;
  store.panelOpen=true;
  store._loadConfig=async()=>{};
  store._openPanel=async()=>{events.push('open'); await new Promise(resolve=>{release=resolve;});};
  store.cleanup=async()=>{events.push('cleanup');};
  const first={isConnected:true}, second={isConnected:true};
  const opening=store.mountPanel(first);
  await new Promise(resolve=>setImmediate(resolve));
  const cleanup=store.unmountPanel(first);
  const reopening=store.mountPanel(second);
  release(); await opening; await cleanup;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.join(','),'open,cleanup,open');
  release(); await reopening;
  assert.equal(store.loading,false);
  store.unmountPanel(first);
  assert.equal(events.join(','),'open,cleanup,open');
});

test('closing while assets are loading never creates a terminal session', async () => {
  const store=load();
  let release;
  store.panelOpen=true;
  store._loadConfig=async()=>{};
  store._loadXterm=()=>new Promise(resolve=>{release=resolve;});
  store._resetPanelState=()=>{throw Error('Must not initialize a detached host');};
  store.cleanup=async()=>{};
  const element={isConnected:true};
  const opening=store.mountPanel(element);
  await new Promise(resolve=>setImmediate(resolve));
  store.panelOpen=false;
  const cleanup=store.unmountPanel(element);
  release(); await opening; await cleanup;
  assert.equal(store.loading,false);
});

test('snapshot restoration does not steal keyboard focus', async () => {
  const store=load();let activated;
  store.panelOpen=true;
  store._activate=async(id,focus)=>{activated={id,focus};};
  await store._applySnapshot([{id:0,buffer:'retained'}],{refreshTerms:false});
  assert.deepEqual(activated,{id:0,focus:false});
});

test('handoff preserves sessions even when explicit hide is configured to close them', async () => {
  const store=load();let closed=0;
  store.config.preserve_sessions_on_hide=false;
  store.sessions=[{id:0}];store.activeSessionId=0;
  store._endDrag=store._unbindSocketEvents=store._disposeAllTerms=()=>{};
  store._request=async()=>{closed++;};
  store.panelOpen=true;
  await store.cleanup();
  assert.equal(closed,0);assert.equal(store._cachedCount,1);
  store.panelOpen=false;
  await store.cleanup();
  assert.equal(closed,1);
});
