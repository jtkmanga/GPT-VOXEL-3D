"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, "Inline game script is present");
assert.ok(html.includes('name="viewport"'), "Mobile viewport is present");
assert.ok(html.includes("ต้นแบบออฟไลน์"), "Offline prototype is clearly labeled");
assert.doesNotMatch(match[1], /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/, "No backend request is issued");
const events = new Map();
const nodes = new Map();
function node(name) {
  return {
    id:name,style:{},hidden:false,textContent:"",className:"",children:[],
    classList:{add(){},remove(){}},
    appendChild(child){this.children.push(child);},
    append(...children){this.children.push(...children);},
    replaceChildren(){this.children=[];},
    addEventListener(type,handler){events.set(name+":"+type,handler);},
    querySelector(){return {focus(){}};},
    focus(){},setPointerCapture(){},
    getBoundingClientRect(){return {left:0,top:0,width:116,height:116};},
    clientWidth:400,clientHeight:400
  };
}
const document = {
  getElementById(id){if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);},
  createElement(tag){return node("new:"+tag);},
  addEventListener(type,handler){events.set("document:"+type,handler);}
};
const canvasContext = new Proxy({},{
  get(target,key){if(key in target)return target[key];return ()=>{};},
  set(target,key,val){target[key]=val;return true;}
});
nodes.set("scene",{...node("scene"),getContext:()=>canvasContext});
const window = {devicePixelRatio:1,addEventListener(type,handler){events.set("window:"+type,handler);}};
const performance = {now:()=>1000};
let frame;
const source = match[1].replace(
  "buildWorld(0);state.last=performance.now();requestAnimationFrame(frame);",
  "globalThis.__probe = {state,collect,reset,buildWorld,walkable,finish}; buildWorld(0);state.last=performance.now();requestAnimationFrame(frame);"
);
assert.notEqual(source,match[1], "Test-only injection point is present");
const context = {document,window,performance,requestAnimationFrame:fn=>{frame=fn;}};
vm.createContext(context);
vm.runInContext(source,context,{timeout:2000});
const game=context.__probe;
assert.equal(game.state.coins.length,82,"Map contains expected number of coins");
assert.ok(game.state.chest,"One chest exists");
assert.equal(game.walkable(0,0),false,"Map boundary is solid");
events.get("newRun:click")();
assert.equal(game.state.run,true,"A new run starts");
assert.equal(game.state.score,0,"Score resets on new run");
const coin=game.state.coins[0];
game.state.player={x:coin.x,y:coin.y};
game.collect();
assert.equal(game.state.score,10,"Nearby coin gives ten points");
assert.equal(game.state.wallet,1,"Coin also changes local wallet");
assert.ok(coin.respawnAt>performance.now(),"Coin does not immediately respawn");
game.state.player={x:game.state.chest.x,y:game.state.chest.y};
game.collect();
assert.equal(game.state.score,110,"Chest awards demo points");
const once=game.state.score;
game.collect();
assert.equal(game.state.score,once,"Chest cannot be claimed twice in the same cooldown");
assert.equal(typeof frame,"function","Animation frame was scheduled");
frame(1017);
events.get("ranking:click")();
assert.equal(nodes.get("shade").hidden,false,"Ranking modal opens");
console.log("Treasure Hunt 2D offline prototype smoke checks PASS");
