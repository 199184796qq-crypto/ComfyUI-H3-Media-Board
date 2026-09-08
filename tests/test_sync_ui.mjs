import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const adapter = await readFile(new URL("../web/timeline_sync_adapter.js",import.meta.url),"utf8");
const adapterURL = `data:text/javascript;base64,${Buffer.from(adapter).toString("base64")}`;
let extension;
globalThis.syncTestApp = {registerExtension(value){extension=value;}};
globalThis.syncTestApi = {async fetchApi(url,options){
  const body = JSON.parse(options.body);
  if(url.endsWith("/import")) {
    assert.deepEqual(Object.keys(body.manifest).sort(),["audio","image","video"]);
    assert.equal(body.settings.duration,8);
    return {ok:true,json:async()=>({items:[{kind:"image",slot:0,filename:"test.png",name:"test"}],settings:{width:864,height:480,duration:8}})};
  }
  return {ok:true,json:async()=>({filename:"test.png",width:32,height:32})};
}};
let code = await readFile(new URL("../web/h3_material_sync.js",import.meta.url),"utf8");
code = code.replace('import {app} from "../../../scripts/app.js";','const app=globalThis.syncTestApp;')
  .replace('import {api} from "../../../scripts/api.js";','const api=globalThis.syncTestApi;')
  .replace('"./timeline_sync_adapter.js"',JSON.stringify(adapterURL));
await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
class Node {
  constructor(){this.widgets=[];this.properties={};this.inputs=[{name:"media_board",link:10}];}
  addWidget(type,name,value,callback,options){const w={type,name,value,callback,options};this.widgets.push(w);return w;}
  computeSize(){return [380,220];}
}
await extension.beforeRegisterNodeDef(Node,{name:"H3MaterialSync"});
const source = {id:1,widgets:Object.entries({media_manifest:JSON.stringify({image:[{path:"h3_media_board/test.png"}],prompt:"do not copy"}),duration:8,aspect_ratio:"16:9",megapixels:0.4,multiple:32}).map(([name,value])=>({name,value}))};
const destination = {id:2,type:"MiniMaxH3TimelinePlanner",widgets:[{name:"width",value:640},{name:"height",value:384},{name:"generation_seconds",value:5}]};
const timeline = {version:4,selection:{start:3,duration:5},images:[],audios:[],videoClips:[],segmentConfig:{count:0,segments:[]}};
destination.__m3td={state:timeline,widget:{value:""},sync(){this.widget.value=JSON.stringify(this.state);destination.widgets[2].value=this.state.selection.duration;},render(){}};
const bridge = new Node();
bridge.graph={_nodes:[source,destination],links:{10:{origin_id:1}},getNodeById(id){return [source,destination].find(n=>String(n.id)===String(id));}};
bridge.onNodeCreated();
try {
  bridge.widgets.find(w=>w.name==="目标时间线").callback("2 · Target");
  await bridge.widgets.find(w=>w.name==="同步素材").callback();
  assert.match(bridge.widgets.find(w=>w.name==="状态").value,/已同步/);
  assert.deepEqual(destination.widgets.map(w=>w.value),[864,480,8]);
  assert.equal(destination.__m3td.state.selection.start,3);
  assert.equal(destination.__m3td.state.images.length,1);
  assert.equal(destination.__m3td.state.prompt,undefined);
  await bridge.widgets.find(w=>w.name==="同步素材").callback();
  assert.equal(destination.__m3td.state.images.length,1);
  destination.inputs=[{name:"width",link:99}];
  await bridge.widgets.find(w=>w.name==="同步素材").callback();
  assert.match(bridge.widgets.find(w=>w.name==="状态").value,/连线控制/);
  destination.inputs=[{name:"timeline_data",link:100}];
  const saved = destination.__m3td.widget.value;
  await bridge.widgets.find(w=>w.name==="同步素材").callback();
  assert.match(bridge.widgets.find(w=>w.name==="状态").value,/timeline_data/);
  assert.equal(destination.__m3td.widget.value,saved);
  bridge.outputs=[{name:"导入素材清单",links:[100]}];
  bridge.removeOutput=function(index){this.outputs.splice(index,1);destination.inputs[0].link=null;};
  bridge.onConfigure();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(bridge.outputs.length,0);
  assert.equal(destination.inputs[0].link,null);
  console.log("PASS: sync button imports media and width/height/duration only; deduplicates; protects connected dimensions");
} finally {bridge.onRemoved();}
