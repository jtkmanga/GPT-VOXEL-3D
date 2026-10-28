#!/usr/bin/env node
'use strict';
// Local simulation of WebSocket client scheduling; this server is NOT Cloudflare
// and cannot establish real Durable Objects, Firebase or 10K server capacity.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const ROOT=path.resolve(__dirname,'../..');
const users=Number(process.env.LOCAL_BOT_COUNT || 250);
if(!Number.isSafeInteger(users)||users<1||users>10000)
  throw Error('Local smoke permits 1..10000 actual loopback sockets');
const folder=path.join(ROOT,'work','load');
fs.mkdirSync(folder,{recursive:true});
const tokenFile=path.join(folder,'loopback-v2-tokens.json');
const reportFile=path.join(folder,'loopback-v2-report.json');
const fakeUsers=Array.from({length:users},(_,i)=>({
  uid:'loopback-load-'+String(i).padStart(5,'0'),
  idToken:'local-only-nonfirebase-token-'+String(i).padStart(5,'0')+'x'.repeat(120)
}));
const server=new WebSocket.Server({
  host:'127.0.0.1',port:0,path:'/play',
  perMessageDeflate:false,maxPayload:10000
});
let accepted=0,acks=0;
server.on('connection',socket=>{
  let authed=false;
  socket.on('message',buffer=>{
    let msg;try{msg=JSON.parse(String(buffer))}catch{return;}
    if(msg.type==='auth'){
      authed=true;accepted++;
      socket.send(JSON.stringify({type:'welcome',spawn:{x:0,z:0},movement:{lastSeq:-1}}));
    }else if(authed&&msg.type==='move'&&Number.isSafeInteger(msg.seq)){
      acks++;
      socket.send(JSON.stringify({type:'move',ack:msg.seq,applied:true,
        player:{x:0,y:0,z:0}}));
    }
  });
});
server.on('listening',()=>{
  fs.writeFileSync(tokenFile,JSON.stringify({users:fakeUsers}));
  const port=server.address().port;
  const env={...process.env,
    TARGET:'loopback', BOT_COUNT:String(users),DURATION_SEC:'10',MOVE_HZ:users>=5000?'1':'2',
    CONNECT_RATE_PER_SEC:users>=5000?'500':'100',MIN_ACK_RATE:'0.95',MIN_WELCOME_RATE:'0.995',
    WS_URL:'ws://127.0.0.1:'+port+'/play',ORIGIN:'https://loopback.invalid',
    TOKEN_FILE:'work/load/loopback-v2-tokens.json',
    LOAD_REPORT_FILE:'work/load/loopback-v2-report.json',
    MAX_ESTIMATED_DO_REQUESTS:'10000000'
  };
  const child=spawn(process.execPath,[path.join(ROOT,'scripts/load/live-10k-v2.cjs')],{
    cwd:ROOT,env,stdio:'inherit'
  });
  const stop=setTimeout(()=>child.kill('SIGTERM'),200000);
  child.on('error',error=>{console.error(error);process.exitCode=1;});
  child.on('exit',(code,signal)=>{
    clearTimeout(stop);
    try{
      const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
      if(!report.result.passed||report.stats.welcomed!==users||
          report.stats.moveAcks<users||report.scheduler?.mode!=='pooled-40ms')
        throw Error('Loopback v2 WebSocket scheduler regression');
      console.log('PASS v2 actual local WebSocket handshakes='+accepted+
        ' ACKs='+acks+' pooled scheduler; no external provider/Cloudflare traffic');
    }catch(error){console.error(error.message);process.exitCode=1;}
    if(code!==0||signal)process.exitCode=1;
    fs.rmSync(tokenFile,{force:true});
    for(const socket of server.clients)socket.terminate();
    server.close();
  });
});
