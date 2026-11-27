"use strict";

function createRoomClient({getSettings, getBoat, onRace, onFleet, onClosed, prepareAudio, describe}) {
  const el=id=>document.getElementById(id);
  const entry=el("room-entry"), lobby=el("room-lobby"), form=el("room-form");
  const playerList=el("room-players"), start=el("room-start"), configure=el("room-configure"), status=el("room-status");
  let room=null, poll=null, busy=false, failures=0;

  let lastMessage="";
  function message(text) {
    status.hidden=!text;
    lastMessage=text;
    status.textContent=text.startsWith("Código da sala: ")?tr("Código da sala")+text.slice(13):tr(text);
  }
  async function request(action,body) {
    const response=await fetch("/api/rooms/"+action,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
      signal:AbortSignal.timeout(7000)
    });
    const data=await response.json().catch(()=>({}));
    if(response.status===401)location.assign("/login.html");
    if(!response.ok)throw Object.assign(new Error(data.error||"Não foi possível conectar à sala."),{status:response.status});
    return data;
  }
  function redraw() {
    entry.hidden=Boolean(room);
    lobby.hidden=!room;
    el("start").disabled=Boolean(room);
    if(!room)return;
    el("invite-code").textContent=room.code;
    el("room-summary").textContent=describe(room.settings)+" · "+room.players.length+"/6";
    start.hidden=room.players.find(player=>player.id===room.id)?.seat!==0;
    configure.hidden=start.hidden;
    start.disabled=configure.disabled=Boolean(room.starts);
    const items=room.players.map(player=>{
      const item=document.createElement("li");
      item.textContent=player.name+(player.seat===0?" · "+tr("Anfitrião"):"")+(player.online?"":" · "+tr("Desconectado"));
      return item;
    });
    const listText=items.map(item=>item.textContent).join("\n");
    if(playerList.dataset.players!==listText){
      playerList.replaceChildren(...items);
      playerList.dataset.players=listText;
    }
  }
  function accept(data, before) {
    const started=Boolean(room.starts);
    if((started&&!data.starts)||data.now<room.now)return;
    const offset=data.now-Date.now()+Math.min(700,(performance.now()-before)/2);
    // The starting gun is anchored once; later packets cannot shift the countdown.
    Object.assign(room,data);
    if(room.starts&&!started){
      const startAt=performance.now()+room.starts-(Date.now()+offset);
      onRace(room,startAt);
    }
    if(room.starts)onFleet(room.players);
    else redraw();
  }
  function schedule() {
    clearTimeout(poll);
    if(room)poll=setTimeout(sync,room.starts?230:1250);
  }
  async function sync() {
    const pending=room;
    if(!pending)return;
    const before=performance.now();
    try{
      const data=await request("sync",{code:pending.code,token:pending.token,boat:pending.starts?getBoat():null});
      if(room!==pending)return;
      if(failures>=3)message("");
      failures=0;
      accept(data,before);
    }catch(error){
      if(room!==pending)return;
      if(error.status===404){leave(false);onClosed(error.message);return;}
      if(++failures>=3)message("Tentando reconectar à sala…");
    }
    if(room===pending)schedule();
  }
  function leave(notify=true) {
    if(!room)return;
    const {code,token}=room;
    room=null;
    clearTimeout(poll);
    if(notify)request("leave",{code,token}).catch(()=>{});
    redraw();
    message("");
  }
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if(room||busy)return;
    const code=el("room-code").value.trim().toUpperCase();
    const action=event.submitter?.value||(code?"join":"create");
    if(action==="join"&&!/^[A-Z2-9]{7}$/.test(code)){message("Digite os 7 caracteres do código.");return;}
    prepareAudio();
    busy=true;
    el("room-create").disabled=el("room-join").disabled=true;
    message(action==="create"?"Criando sala…":"Entrando na sala…");
    try{
      const data=await request(action,{code,name:el("sailor-name").value,settings:action==="create"?getSettings():undefined});
      room=data;
      failures=0;
      redraw();
      message("");
      schedule();
    }catch(error){message(error.message);}
    finally{busy=false;el("room-create").disabled=el("room-join").disabled=false;}
  });
  async function updateRoom(action){
    if(!room||room.starts||busy)return;
    const pending=room, before=performance.now();
    busy=true;
    start.disabled=configure.disabled=true;
    try{
      const data=await request(action,{code:pending.code,token:pending.token,settings:getSettings()});
      if(room===pending){
        accept(data,before);
        if(action==="configure")message("Condições atualizadas para todos.");
        schedule();
      }
    }catch(error){if(room===pending){message(error.message);redraw();}}
    finally{busy=false;}
  }
  start.addEventListener("click",()=>updateRoom("start"));
  configure.addEventListener("click",()=>updateRoom("configure"));
  el("room-copy").addEventListener("click",async()=>{
    if(!room)return;
    try{await navigator.clipboard.writeText(room.code);message("Código copiado.");}
    catch{message("Código da sala: "+room.code);}
  });
  el("room-leave").addEventListener("click",()=>leave());
  return {leave, message, refreshLanguage(){ redraw(); message(lastMessage); }};
}
