'use strict';
(() => {
  const keys={repair_token_admin:'admin',repair_token_super:'superadmin',repair_token_technician:'technician'};
  const own=location.pathname.startsWith('/chaojishouji')?'repair_token_super':location.pathname.startsWith('/shifu')?'repair_token_technician':'repair_token_admin';
  function activate(key){
    for(const [other,client] of Object.entries(keys)){
      if(other===key)continue;
      const token=localStorage.getItem(other);
      localStorage.removeItem(other);
      if(token)fetch('/repair-api/logout',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Repair-Client':client}}).catch(()=>{});
    }
  }
  window.repairSession={activate};
  window.addEventListener('storage',event=>{
    if(event.key===own&&event.oldValue!==null){
      window.dispatchEvent(new Event('repair-session-replaced'));
    }
  });
})();
