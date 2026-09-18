import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Android download, background push and call alert regression guards',()=>{
  const index=read('public/index.html');
  const fixes=read('public/platform-fixes.js');
  const sw=read('public/sw.js');
  const app=read('public/app.js');
  const activity=read('android/app/src/main/java/com/raunak/liverooms/MainActivity.java');
  const manifest=JSON.parse(read('public/manifest.webmanifest'));

  assert.match(index,/platform-fixes\.js\?v=mobile-alerts-3/);
  assert.doesNotThrow(()=>new Function(fixes));
  assert.doesNotThrow(()=>new Function(sw));

  assert.match(fixes,/sameApplicationServerKey/);
  assert.match(fixes,/pushManager\.getSubscription/);
  assert.match(fixes,/subscription\.unsubscribe/);
  assert.match(index,/href="\/LiveRooms\.apk"/);
  assert.match(index,/download="LiveRooms\.apk"/);
  assert.match(fixes,/install-app'\)\.hidden=true/);
  assert.doesNotMatch(fixes,/Installing…|Add to Home screen/);
  assert.match(fixes,/setInterval\(vibrate,3000\)/);
  assert.match(fixes,/push-received/);

  assert.match(sw,/requireInteraction:isCall/);
  assert.match(sw,/silent:false/);
  assert.match(sw,/vibrate:isCall/);
  assert.match(sw,/platform-fixes\.js\?v=mobile-alerts-3/);
  assert.match(sw,/whatsapp\.css\?v=premium-ui-4/);
  assert.match(index,/id="theme-picker"/);
  assert.match(index,/id="chat-bg-color"/);
  assert.match(index,/id="profile-photo-edit"/);
  assert.match(index,/id="scroll-latest"/);
  assert.match(app,/window\.handleNativeBack/);
  assert.match(app,/data-palette/);
  assert.match(app,/delete:chat/);
  assert.match(app,/Notification\.permission!==['"]default['"]/);
  assert.match(activity,/evaluateJavascript/);
  assert.match(activity,/handleNativeBack/);
  assert.match(activity,/POST_NOTIFICATIONS/);
  assert.match(activity,/NOTIFICATION_PERMISSION_REQUEST/);
  assert.doesNotMatch(activity,/super\.onBackPressed/);

  assert.equal(manifest.id,'/');
  assert.equal(manifest.start_url,'/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));
  assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512'));
});
