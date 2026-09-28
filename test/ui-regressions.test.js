import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('Android swipe surfaces do not block gesture transforms',async()=>{
  const css=await read('public/android-stability.css');
  assert.doesNotMatch(css,/body\.native-android #messages,body\.native-android #lobby,body\.native-android \.tab-view\{[^}]*transform\s*:\s*none\s*!important/i);
});

test('navigation layer ignores caller-owned incoming call payloads',async()=>{
  const js=await read('public/navigation-polish.js');
  assert.match(js,/payload\?\.by&&payload\.by===user/);
});

test('native notification service ignores caller own ring',async()=>{
  const java=await read('android/app/src/main/java/com/raunak/liverooms/NotificationService.java');
  assert.match(java,/if\(username\.equals\(caller\)\)return;/);
});

test('incoming call actions have explicit accept and decline colors',async()=>{
  const css=await read('public/navigation-polish.css');
  assert.match(css,/#active-call\.incoming #answer-call\{background:#20b86a!important/);
  assert.match(css,/#active-call\.incoming #end-call\{background:#e64d50!important/);
});

test('manifest exposes refreshed Live Rooms icon',async()=>{
  const manifest=JSON.parse(await read('public/manifest.webmanifest'));
  assert.equal(manifest.name,'Live Rooms');
  assert.ok(manifest.icons.some(icon=>icon.src==='/favicon.svg'&&icon.type==='image/svg+xml'));
});
