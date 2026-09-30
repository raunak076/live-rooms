import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat } from '../server.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const folder=mkdtempSync(join(tmpdir(),'live-ui-')),chat=createChat({dbPath:join(folder,'chat.db')});
await new Promise(resolve=>chat.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+chat.server.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.goto(url);
  await page.locator('#username').fill('ui_alice');await page.locator('#password').fill('strong-password');await page.locator('button[value=register]').click();await page.locator('#lobby').waitFor({state:'visible'});
  await page.locator('#home-menu-button').click();await page.locator('#toolbar-create').click();await page.locator('#room-name').fill('UI group');await page.locator('#create-form button[type=submit]').click();await page.locator('#chat').waitFor({state:'visible'});
  await page.locator('#message').fill('working message');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('.message.own:not(.pending)'));
  assert.equal(await page.locator('.message.own .receipt').getAttribute('title'),'Sent');
  await page.locator('#message').fill('saved draft');await page.reload();await page.locator('#chat').waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('message').value==='saved draft');
  await page.evaluate(()=>socket.disconnect());await context.setOffline(true);await page.locator('#message').fill('offline message');await page.locator('#send').click();assert.ok(await page.locator('.message.pending').count());
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lr-outbox-'+user)).length),1);
  await context.setOffline(false);await page.reload();await page.locator('#chat').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.message.pending')&&document.getElementById('messages').textContent.includes('offline message'));
  assert.equal(await page.locator('.message.own').count(),2);
  await page.locator('.chat-header-copy').click();await page.locator('dialog[open]').waitFor({state:'visible'});assert.match(await page.locator('dialog[open]').innerText(),/Admin/);await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('#chat-menu-button').click();await page.getByRole('button',{name:'Search messages',exact:true}).click();await page.locator('dialog textarea').fill('offline');await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.search-result')?.textContent.includes('offline message'));await page.getByRole('button',{name:'Close',exact:true}).click();
  // Long press -> app-styled edit dialog.
  await page.evaluate(()=>{const m=currentRoom.messages.find(m=>m.text==='working message');openMessageActions(m,document.getElementById('msg-'+m.id));});await page.locator('#action-edit').click();await page.locator('dialog textarea').fill('edited in app');await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForFunction(()=>document.getElementById('messages').textContent.includes('edited in app'));
  // The original note is kept locally until explicit Send voice.
  await page.evaluate(()=>startVoiceNote());await page.locator('#recording-controls').waitFor({state:'visible'});await page.waitForTimeout(700);await page.getByRole('button',{name:'Stop & preview',exact:true}).click();await page.locator('#voice-preview').waitFor({state:'visible'});assert.equal(await page.locator('.attachment audio').count(),0);await page.getByRole('button',{name:'Send voice',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.attachment audio'));assert.equal(await page.locator('#voice-preview').count(),0);
  const layout=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,send:document.getElementById('send').getBoundingClientRect().bottom,height:innerHeight}));assert.ok(layout.width<=layout.viewport+1);assert.ok(layout.send<=layout.height+1);
  await page.screenshot({path:'/tmp/live-rooms-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('UI smoke passed: mobile registration, send states, saved draft, offline resend, chat info, search, edit and recording preview.');
}finally{await browser?.close();await new Promise(resolve=>chat.io.close(resolve));rmSync(folder,{recursive:true,force:true});}
