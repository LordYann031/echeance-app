(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const FIELDS = ["record_type","expense_id","name","category","amount","currency","start_date","next_due_date","end_date","frequency","payment_method","provider","notes","status","paid_date","due_date","amount_paid","occurrence_key","created_at","updated_at","logo_ref"];
  const STORAGE = {preferences:"echeance-preferences-v1"};
  const MAX_RECORDS = 20000; // limite de sécurité (l'ancienne limite Canva de 999 n'existe plus ici)
  const STATUS = {upcoming:"À venir",today:"À payer aujourd’hui",paid:"Payée",overdue:"En retard",cancelled:"Résiliée"};
  const HEADINGS = {home:["Vue d’ensemble","Gardez une longueur d’avance sur vos échéances."],calendar:["Calendrier","Chaque échéance, au bon moment."],expenses:["Mes dépenses","Retrouvez et gérez vos dépenses récurrentes."],history:["Historique","Les paiements que vous avez enregistrés."],settings:["Paramètres","Personnalisez votre espace."]};
  const blank = () => Object.fromEntries(FIELDS.map(k => [k, ["amount","amount_paid"].includes(k) ? 0 : ""]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let backendRecords=[], expenses=[], payments=[], loaded=false, loadTimer, activeView="home", editingId=null, deletingId=null, paymentTarget=null, selectedPayment=null, focusBeforeDialog=null, toastTimer;
  let prefs={currency:"XOF",theme:"dark",budget:0,reminderDays:1,notify:false}, calendarMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1), selectedDay=normaliserDateLocale(new Date());
  let writeChain=Promise.resolve(), lastWriteAt=0;
  const rowMaps={upcoming:new Map(),recent:new Map(),expenses:new Map(),selected:new Map(),history:new Map()};
  const pendingKeys=new Set();

  // Dates civiles locales : la comparaison par jours civils évite les décalages UTC et les changements d’heure.
  function normaliserDateLocale(value) {
    if(value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-${String(value.getDate()).padStart(2,"0")}`;
    if(typeof value!=="string"||! /^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y,m,d]=value.split("-").map(Number), date=new Date(y,m-1,d);
    return date.getFullYear()===y&&date.getMonth()===m-1&&date.getDate()===d ? value : null;
  }
  function parse(s){const v=normaliserDateLocale(s);if(!v)return null;const [y,m,d]=v.split("-").map(Number);return new Date(y,m-1,d)}
  function differenceEnJours(a,b=normaliserDateLocale(new Date())) {
    const x=parse(a),y=parse(b);if(!x||!y)return 0;
    return Math.round((Date.UTC(x.getFullYear(),x.getMonth(),x.getDate())-Date.UTC(y.getFullYear(),y.getMonth(),y.getDate()))/86400000);
  }
  function calculerProchaineEcheance(anchor,frequency,index=1) {
    const d=parse(anchor);if(!d||index<0)return null;if(index===0)return anchor;
    if(frequency==="once")return null;
    if(frequency==="daily"||frequency==="weekly"){d.setDate(d.getDate()+index*(frequency==="weekly"?7:1));return normaliserDateLocale(d)}
    if(frequency==="monthly"||frequency==="yearly"){
      // Fin de mois : 29/30/31 est ramené au dernier jour disponible du mois cible.
      // Chaque projection repart de l’ancre d’origine, sans dérive permanente après février.
      const target=new Date(d.getFullYear(),d.getMonth()+index*(frequency==="yearly"?12:1),1);
      return normaliserDateLocale(new Date(target.getFullYear(),target.getMonth(),Math.min(d.getDate(),new Date(target.getFullYear(),target.getMonth()+1,0).getDate())));
    }
    return null;
  }
  const keyFor=(id,date)=>`${id}|${date}`;
  function générerOccurrence(expense,dueDate) {return {expense,dueDate,key:keyFor(expense.expense_id,dueDate),payment:paymentFor(expense.expense_id,dueDate)}}
  function paymentFor(id,date){return payments.find(p=>p.occurrence_key===keyFor(id,date))||null}
  function calculerStatut(occurrence){
    if(occurrence.payment)return "paid";
    if(occurrence.expense.status==="cancelled")return "cancelled";
    const days=differenceEnJours(occurrence.dueDate);
    return days<0?"overdue":days===0?"today":"upcoming";
  }
  function dateLabel(s){const d=parse(s);return d?new Intl.DateTimeFormat("fr-FR",{day:"numeric",month:"short",year:"numeric"}).format(d):"Date inconnue"}
  function money(n,c="XOF"){try{return new Intl.NumberFormat("fr-FR",{style:"currency",currency:c,maximumFractionDigits:c==="XOF"?0:2}).format(Number(n)||0)}catch{return `${n} ${c}`}}
  function dueText(date){const n=differenceEnJours(date);return n<0?`En retard de ${-n} j`:n===0?"Aujourd’hui":`Dans ${n} j`}
  const SERVICE_LOGOS={netflix:"N",spotify:"S",youtube:"YT",chatgpt:"C",disney:"D+",canva:"C",icloud:"iC"};
  const CATEGORY_ICONS={Logement:"⌂",Internet:"@",Télécommunications:"@",Factures:"▤",Services:"▤",Transport:"⌁", "Vie quotidienne":"✦",Autre:"•"};
  function initialsFor(expense){const words=expense.name.trim().split(/\s+/).filter(Boolean);return (words.length>1?words.slice(0,2).map(word=>word[0]):[expense.name.trim().slice(0,2)]).join("").toUpperCase()||"•"}
  function logoRef(expense){const requested=expense.logo_ref||"auto";if(requested!=="auto"&&requested!=="category")return requested;const hay=`${expense.name} ${expense.provider}`.toLocaleLowerCase("fr");for(const key of Object.keys(SERVICE_LOGOS))if(hay.includes(key)||key==="youtube"&&hay.includes("premium"))return key;return "category"}
  function logoLabel(expense){const ref=logoRef(expense);if(ref==="category")return initialsFor(expense);return SERVICE_LOGOS[ref]||initialsFor(expense)}
  function logoClass(expense){const ref=logoRef(expense);if(ref!=="category")return `logo-mark ${ref}`;const category=(expense.category||"Autre").toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g,"-");return `logo-mark category category-${["logement","internet","energie","divertissement","transport"].includes(category)?category:"autre"}`}
  function validExpense(r){return r&&typeof r.name==="string"&&r.name.trim()&&Number.isFinite(Number(r.amount))&&Number(r.amount)>0&&normaliserDateLocale(r.next_due_date)}
  function normalizeExpense(r){
    if(!validExpense(r))return null;
    return {...r,record_type:"expense",expense_id:r.expense_id||`legacy-${r.__backendId}`,currency:["XOF","EUR","USD"].includes(r.currency)?r.currency:"XOF",frequency:["once","daily","weekly","monthly","yearly"].includes(r.frequency)?r.frequency:"once",end_date:normaliserDateLocale(r.end_date)||"",start_date:normaliserDateLocale(r.start_date)||r.next_due_date,status:r.status==="cancelled"?"cancelled":"upcoming",amount:Number(r.amount),notes:r.notes||"",provider:r.provider||"",category:r.category||"Autre",payment_method:r.payment_method||"Autre",logo_ref:r.logo_ref||"category"};
  }
  function normalizePayment(r){
    if(!r||r.record_type!=="payment"||!r.expense_id||!normaliserDateLocale(r.due_date)||!normaliserDateLocale(r.paid_date))return null;
    return {...r,occurrence_key:r.occurrence_key||keyFor(r.expense_id,r.due_date),amount:Number(r.amount)||0,amount_paid:Number(r.amount_paid)||0};
  }
  function reconcile(data){
    backendRecords=Array.isArray(data)?data:[];
    expenses=backendRecords.filter(r=>r.record_type!=="payment").map(normalizeExpense).filter(Boolean);
    payments=backendRecords.map(normalizePayment).filter(Boolean);
    // Compatibilité Phase 1 : exposer l’ancien paiement sans écrire de migration au chargement.
    for(const r of backendRecords.filter(r=>r.record_type!=="payment"&&r.status==="paid"&&normaliserDateLocale(r.paid_date))){
      const e=expenses.find(x=>x.__backendId===r.__backendId);if(!e)continue;
      const due=normaliserDateLocale(r.next_due_date);
      if(!paymentFor(e.expense_id,due))payments.push({...blank(),record_type:"payment",expense_id:e.expense_id,due_date:due,paid_date:r.paid_date,amount:e.amount,amount_paid:e.amount,payment_method:e.payment_method,occurrence_key:keyFor(e.expense_id,due),created_at:r.created_at||"",__legacy:true,__backendId:r.__backendId});
    }
  }
  function occurrenceAt(expense,index){
    const date=calculerProchaineEcheance(expense.next_due_date,expense.frequency,index);
    if(!date||expense.end_date&&date>expense.end_date)return null;
    return générerOccurrence(expense,date);
  }
  function currentOccurrence(expense){
    if(expense.status==="cancelled")return occurrenceAt(expense,0);
    for(let i=0;i<5000;i++){const item=occurrenceAt(expense,i);if(!item)return null;if(!item.payment)return item}
    return null;
  }
  function monthOccurrences(year,month){
    const start=normaliserDateLocale(new Date(year,month,1)),end=normaliserDateLocale(new Date(year,month+1,0));
    const found=[];
    for(const e of expenses){
      for(let i=0;i<5000;i++){
        const item=occurrenceAt(e,i);if(!item||item.dueDate>end)break;
        if(item.dueDate>=start&&(e.status!=="cancelled"||item.payment))found.push(item);
      }
    }
    // Les paiements anciens restent visibles dans le calendrier même après modification de la fréquence.
    for(const p of payments){
      if(p.due_date<start||p.due_date>end||found.some(o=>o.key===p.occurrence_key))continue;
      const e=expenses.find(x=>x.expense_id===p.expense_id);
      if(e)found.push({...générerOccurrence(e,p.due_date),payment:p});
    }
    return found.sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  }

  // Couche de stockage : préférences validées et écritures sérialisées.
  function readPrefs(){try{const raw=JSON.parse(localStorage.getItem(STORAGE.preferences)||"{}");if(["XOF","EUR","USD"].includes(raw.currency))prefs.currency=raw.currency;if(["dark","light"].includes(raw.theme))prefs.theme=raw.theme;if(Number.isFinite(Number(raw.budget))&&Number(raw.budget)>=0)prefs.budget=Number(raw.budget);if([0,1,3,7].includes(Number(raw.reminderDays)))prefs.reminderDays=Number(raw.reminderDays);prefs.notify=raw.notify===true}catch{notify("Préférences illisibles : valeurs par défaut utilisées.",true)}}
  function savePrefs(){try{localStorage.setItem(STORAGE.preferences,JSON.stringify(prefs));return true}catch{notify("Impossible de sauvegarder les préférences sur cet appareil.",true);return false}}
  function applyPrefs(){document.body.classList.toggle("light",prefs.theme==="light");$("currency-setting").value=prefs.currency;$("theme-setting").value=prefs.theme;$("budget-setting").value=prefs.budget>0?prefs.budget:"";$("reminder-setting").value=String(prefs.reminderDays);const themeColor=document.querySelector('meta[name="theme-color"]');if(themeColor)themeColor.content=prefs.theme==="light"?"#f1f6f0":"#091310"}
  function cleanRecord(data){return Object.fromEntries(FIELDS.map(k=>[k,data[k]??(["amount","amount_paid"].includes(k)?0:"")]))}
  function enqueueWrite(action){
    const task=writeChain.catch(()=>{}).then(async()=>{const wait=Math.max(0,550-(Date.now()-lastWriteAt));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));lastWriteAt=Date.now();return action()});
    writeChain=task.catch(()=>{});return task;
  }
  async function mutate(method,record){
    const result=await enqueueWrite(()=>window.dataSdk[method](record));
    if(!result.isOk)throw new Error("Impossible de confirmer l’enregistrement. Vérifiez vos données avant de réessayer.");
  }
  function raw(id){return backendRecords.find(r=>String(r.__backendId)===String(id))}
  function notify(message,error=false){const el=$("toast");el.textContent=message;el.style.borderColor=error?"var(--danger)":"var(--accent)";el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,5500)}
  function loadError(message){loaded=false;clearTimeout(loadTimer);$("app-views").hidden=true;$("load-state").hidden=false;$("load-message").textContent=message;$("retry-load").classList.remove("hidden")}
  async function initialize(){
    loaded=false;clearTimeout(loadTimer);$("load-state").hidden=false;$("app-views").hidden=true;$("load-message").textContent="Chargement de vos dépenses…";$("retry-load").classList.add("hidden");
    loadTimer=setTimeout(()=>{if(!loaded)loadError("Le chargement a échoué. Réessayez.")},8000);
    try{
      const result=await window.dataSdk.init({onDataChanged(data){
        if(!Array.isArray(data)){loadError("Données reçues illisibles. Réessayez.");return}
        reconcile(data);loaded=true;clearTimeout(loadTimer);$("load-state").hidden=true;$("app-views").hidden=false;render();
        const invalid=data.filter(r=>r.record_type==="payment"?!normalizePayment(r):!validExpense(r)).length;
        if(invalid)notify(`${invalid} ligne(s) illisible(s) ignorée(s), sans suppression.`,true);
      }});
      if(!result.isOk)loadError("Impossible de charger vos données. Réessayez.");
    }catch{loadError("Impossible de charger vos données. Réessayez.")}
  }

  // Composants de listes : les lignes existantes sont mises à jour en place.
  function empty(container,text){let el=container.querySelector(".empty-message");if(!el){el=document.createElement("p");el.className="empty-message muted py-7";container.appendChild(el)}el.textContent=text}
  function syncExpenseRows(id,mapName,items,actions=false){
    const parent=$(id),map=rowMaps[mapName],used=new Set();
    for(const item of items){
      const idKey=item.key;used.add(idKey);let row=map.get(idKey);
      if(!row){
        row=$("expense-row-template").content.firstElementChild.cloneNode(true);map.set(idKey,row);row.classList.add("row-enter");
        if(actions){
          row.querySelector(".row-actions").hidden=false;
          row.querySelector(".row-pay").addEventListener("click",()=>openPayment(row.dataset.expenseId,row.dataset.due));
          row.querySelector(".row-edit").addEventListener("click",()=>openForm(row.dataset.backendId));
          row.querySelector(".row-delete").addEventListener("click",()=>openDelete(row.dataset.backendId));
        }
        parent.appendChild(row);if(window.lucide)lucide.createIcons();
      }
      const e=item.expense,status=calculerStatut(item);
      row.dataset.expenseId=e.expense_id;row.dataset.backendId=e.__backendId;row.dataset.due=item.dueDate;
      const logo=row.querySelector(".logo-mark");logo.textContent=logoLabel(e);logo.className=logoClass(e);logo.setAttribute("aria-label",`${e.name}, ${logoLabel(e)}`);logo.title=`${e.name} — ${logoLabel(e)}`;
      row.querySelector(".row-name").textContent=e.name;
      row.querySelector(".row-meta").textContent=`${e.category} · ${dateLabel(item.dueDate)}${e.provider?" · "+e.provider:""}`;
      row.querySelector(".row-amount").textContent=money(e.amount,e.currency);
      row.querySelector(".row-days").textContent=status==="paid"?`Payée le ${dateLabel(item.payment.paid_date)}`:status==="cancelled"?"Résiliée":dueText(item.dueDate);
      const badge=row.querySelector(".row-badge");badge.textContent=STATUS[status];badge.className=`row-badge badge mt-2 ${status}`;
      if(actions)row.querySelector(".row-pay").hidden=status==="paid"||status==="cancelled";
      parent.appendChild(row);
    }
    for(const [key,row] of map)if(!used.has(key)){row.remove();map.delete(key)}
    if(items.length)parent.querySelector(".empty-message")?.remove();
  }
  function renderDashboard(){
    const now=new Date(),items=monthOccurrences(now.getFullYear(),now.getMonth()),currency=prefs.currency;
    const relevant=items.filter(o=>o.expense.currency===currency),month=normaliserDateLocale(now).slice(0,7);
    const planned=relevant.reduce((sum,o)=>sum+o.expense.amount,0);
    animateNumber($("metric-planned"),planned,v=>money(v,currency));
    animateNumber($("metric-paid"),payments.filter(p=>p.paid_date.slice(0,7)===month&&(expenses.find(e=>e.expense_id===p.expense_id)?.currency||"XOF")===currency).reduce((sum,p)=>sum+p.amount_paid,0),v=>money(v,currency));
    animateNumber($("metric-remaining"),relevant.filter(o=>!o.payment&&o.expense.status!=="cancelled").reduce((sum,o)=>sum+o.expense.amount,0),v=>money(v,currency));
    const current=expenses.map(currentOccurrence).filter(Boolean),active=current.filter(o=>o.expense.status!=="cancelled");
    animateNumber($("metric-upcoming"),active.filter(o=>differenceEnJours(o.dueDate)>=0).length,v=>String(Math.round(v)));
    $("overdue-count").textContent=`${active.filter(o=>calculerStatut(o)==="overdue").length} échéance(s) en retard · Totaux en ${currency}, sans conversion`;
    renderBudget(planned,currency);renderReminders(active);renderStats(relevant,currency);
    const upcoming=active.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).slice(0,5);
    syncExpenseRows("upcoming-list","upcoming",upcoming);
    if(!upcoming.length)empty($("upcoming-list"),"Aucune échéance active.");
    const recent=[...expenses].sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||"")).slice(0,4).map(e=>currentOccurrence(e)||occurrenceAt(e,0)).filter(Boolean);
    syncExpenseRows("recent-list","recent",recent);if(!recent.length)empty($("recent-list"),"Aucune dépense enregistrée.");
  }
  function renderCalendar(){
    const y=calendarMonth.getFullYear(),m=calendarMonth.getMonth(),first=new Date(y,m,1),items=monthOccurrences(y,m);
    $("calendar-month").textContent=new Intl.DateTimeFormat("fr-FR",{month:"long",year:"numeric"}).format(first);
    const grouped=new Map();for(const item of items){if(!grouped.has(item.dueDate))grouped.set(item.dueDate,[]);grouped.get(item.dueDate).push(item)}
    const grid=$("calendar-days");grid.replaceChildren();
    for(let i=0;i<(first.getDay()+6)%7;i++){const blank=document.createElement("span");blank.setAttribute("aria-hidden","true");grid.appendChild(blank)}
    for(let day=1;day<=new Date(y,m+1,0).getDate();day++){
      const date=normaliserDateLocale(new Date(y,m,day)),entries=grouped.get(date)||[],button=document.createElement("button");
      button.type="button";button.className="day";button.setAttribute("aria-label",`${dateLabel(date)}, ${entries.length} échéance(s)`);button.setAttribute("aria-pressed",String(date===selectedDay));
      if(date===normaliserDateLocale(new Date()))button.classList.add("today");if(date===selectedDay)button.classList.add("selected");
      const num=document.createElement("span");num.textContent=day;button.appendChild(num);
      const dots=document.createElement("span");dots.className="day-dots";for(const item of entries.slice(0,5)){const dot=document.createElement("span");dot.className=`day-dot ${calculerStatut(item)}`;dots.appendChild(dot)}button.appendChild(dots);
      button.addEventListener("click",()=>{selectedDay=date;renderCalendar()});grid.appendChild(button);
    }
    const selected=grouped.get(selectedDay)||[];
    $("selected-date").textContent=new Intl.DateTimeFormat("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(parse(selectedDay));
    $("selected-total").textContent=`${selected.length} échéance(s)`;
    syncExpenseRows("selected-expenses","selected",selected);if(!selected.length)empty($("selected-expenses"),"Aucune échéance prévue pour cette date.");
  }
  function renderExpenses(){
    const search=$("expense-search").value.trim().toLocaleLowerCase("fr"),category=$("category-filter").value,status=$("status-filter").value;
    const items=expenses.map(e=>currentOccurrence(e)||occurrenceAt(e,0)).filter(Boolean).filter(o=>
      o.expense.name.toLocaleLowerCase("fr").includes(search)&&(!category||o.expense.category===category)&&(!status||calculerStatut(o)===status)
    ).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    $("expense-count").textContent=`${items.length} dépense(s)`;syncExpenseRows("expense-list","expenses",items,true);
    if(!items.length)empty($("expense-list"),"Aucune dépense ne correspond à votre recherche.");
  }
  function paymentName(p){return expenses.find(e=>e.expense_id===p.expense_id)?.name||"Dépense supprimée"}
  function renderHistory(){
    const search=$("history-search").value.trim().toLocaleLowerCase("fr"),month=$("history-month").value,method=$("history-method").value;
    const items=[...payments].filter(p=>paymentName(p).toLocaleLowerCase("fr").includes(search)&&(!month||p.paid_date.startsWith(month))&&(!method||p.payment_method===method)).sort((a,b)=>b.paid_date.localeCompare(a.paid_date)||(b.created_at||"").localeCompare(a.created_at||""));
    const parent=$("history-list"),map=rowMaps.history,used=new Set();
    for(const p of items){
      const key=p.__legacy?`legacy-${p.__backendId}`:String(p.__backendId);used.add(key);let row=map.get(key);
      if(!row){row=$("history-row-template").content.firstElementChild.cloneNode(true);map.set(key,row);row.classList.add("row-enter");row.querySelector(".history-open").addEventListener("click",()=>openPaymentRecord(row.dataset.paymentKey));parent.appendChild(row);if(window.lucide)lucide.createIcons()}
      row.dataset.paymentKey=key;row.querySelector(".history-name").textContent=paymentName(p);
      row.querySelector(".history-meta").textContent=`Prévue le ${dateLabel(p.due_date)} · payée le ${dateLabel(p.paid_date)} · ${p.payment_method||"Autre"}`;
      const currency=expenses.find(e=>e.expense_id===p.expense_id)?.currency||"XOF";
      row.querySelector(".history-amount").textContent=money(p.amount_paid,currency);
      row.querySelector(".history-planned").textContent=`Prévu : ${money(p.amount,currency)}`;
      parent.appendChild(row);
    }
    for(const [key,row] of map)if(!used.has(key)){row.remove();map.delete(key)}
    if(items.length)parent.querySelector(".empty-message")?.remove();else empty(parent,"Aucun paiement enregistré.");
  }
  // ---------- Animations, budget, rappels, statistiques ----------
  const reduceMotion=()=>window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  function animateNumber(el,to,format){
    const from=Number(el.dataset.value||0);el.dataset.value=String(to);cancelAnimationFrame(el._raf||0);
    if(reduceMotion()||from===to){el.textContent=format(to);return}
    const start=performance.now(),duration=700;
    const step=now=>{const t=Math.min(1,(now-start)/duration),eased=1-Math.pow(1-t,3);el.textContent=format(from+(to-from)*eased);if(t<1)el._raf=requestAnimationFrame(step);else el.textContent=format(to)};
    el._raf=requestAnimationFrame(step);
  }
  function renderBudget(planned,currency){
    const card=$("budget-card"),budget=Number(prefs.budget)||0;
    card.hidden=budget<=0;if(budget<=0)return;
    const ratio=planned/budget,bar=$("budget-bar"),track=bar.parentElement;
    track.classList.toggle("warn",ratio>=.8&&ratio<=1);track.classList.toggle("over",ratio>1);
    track.setAttribute("aria-valuenow",String(Math.min(100,Math.round(ratio*100))));
    $("budget-text").textContent=`${money(planned,currency)} prévus sur ${money(budget,currency)} (${Math.round(ratio*100)} %)`;
    $("budget-hint").textContent=ratio>1?`Vous dépassez votre budget de ${money(planned-budget,currency)}.`:`Il vous reste ${money(budget-planned,currency)} de marge ce mois-ci.`;
    requestAnimationFrame(()=>{bar.style.width=Math.min(100,ratio*100)+"%"});
  }
  function reminderNames(list){return list.slice(0,3).map(o=>`${o.expense.name} (${dueText(o.dueDate).toLocaleLowerCase("fr")})`).join(", ")+(list.length>3?` et ${list.length-3} autre(s)`:"")}
  function renderReminders(active){
    const banner=$("reminder-banner"),days=Number(prefs.reminderDays)||0;
    const late=active.filter(o=>calculerStatut(o)==="overdue").sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    const soon=active.filter(o=>{const n=differenceEnJours(o.dueDate);return n>=0&&n<=days}).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    if(!late.length&&!soon.length){banner.hidden=true;return}
    const parts=[];
    if(late.length)parts.push(`${late.length} échéance(s) en retard : ${reminderNames(late)}.`);
    if(soon.length)parts.push(`${late.length?"Bientôt":"À payer bientôt"} : ${reminderNames(soon)}.`);
    banner.classList.toggle("late",late.length>0);
    $("reminder-text").textContent=parts.join(" ");banner.hidden=false;
    maybeNotify(parts.join(" "));
  }
  function maybeNotify(body){
    if(!prefs.notify||!("Notification" in window)||Notification.permission!=="granted")return;
    const prefix="echeance-notified-",key=prefix+normaliserDateLocale(new Date());
    try{
      if(localStorage.getItem(key))return;
      for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i);if(k&&k.startsWith(prefix)&&k!==key)localStorage.removeItem(k)}
      localStorage.setItem(key,"1");
    }catch{}
    const options={body,icon:"icon-192.png",badge:"icon-192.png",tag:"echeance-daily"};
    const fallback=()=>{try{new Notification("Échéance",options)}catch{}};
    if("serviceWorker" in navigator)navigator.serviceWorker.getRegistration().then(reg=>reg?reg.showNotification("Échéance",options):fallback()).catch(fallback);
    else fallback();
  }
  const CATEGORY_COLORS={Logement:"#c9a063",Internet:"#5aa9e6",Énergie:"#e9c44c",Divertissement:"#b57ee0",Transport:"#4fc9b7",Autre:"#8a9a90"};
  function renderStats(relevant,currency){
    const byCat=new Map();for(const o of relevant)byCat.set(o.expense.category,(byCat.get(o.expense.category)||0)+o.expense.amount);
    const cats=[...byCat].sort((a,b)=>b[1]-a[1]),box=$("stats-category");box.replaceChildren();
    if(!cats.length){const p=document.createElement("p");p.className="muted py-3";p.textContent="Pas encore de données ce mois-ci.";box.appendChild(p)}
    const max=cats[0]?.[1]||1,total=cats.reduce((s,c)=>s+c[1],0)||1;
    for(const [name,value] of cats){
      const row=document.createElement("div");row.className="bar-row";row.title=`${name} : ${Math.round(value/total*100)} % du total`;
      const label=document.createElement("span");label.className="bar-label";label.textContent=name;
      const track=document.createElement("span");track.className="bar-track";
      const fill=document.createElement("span");fill.className="bar-fill";fill.style.background=CATEGORY_COLORS[name]||CATEGORY_COLORS.Autre;track.appendChild(fill);
      const val=document.createElement("span");val.className="bar-value";val.textContent=money(value,currency);
      row.append(label,track,val);box.appendChild(row);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.width=(value/max*100)+"%"}));
    }
    const chart=$("stats-months");chart.replaceChildren();
    const now=new Date(),months=[];
    for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);months.push({key:normaliserDateLocale(d).slice(0,7),date:d,total:0})}
    for(const p of payments){
      const m=months.find(x=>x.key===p.paid_date.slice(0,7));if(!m)continue;
      if((expenses.find(e=>e.expense_id===p.expense_id)?.currency||"XOF")===currency)m.total+=p.amount_paid;
    }
    const peak=Math.max(...months.map(m=>m.total),0),compact=new Intl.NumberFormat("fr-FR",{notation:"compact",maximumFractionDigits:1});
    months.forEach((m,i)=>{
      const col=document.createElement("div");col.className="month-col";
      const val=document.createElement("span");val.className="month-val";val.textContent=m.total?compact.format(m.total):"–";
      const bar=document.createElement("span");bar.className="month-bar"+(i===months.length-1?" current":"")+(m.total?"":" zero");
      bar.style.height=(m.total&&peak?Math.max(6,m.total/peak*100):4)+"px";bar.style.animationDelay=(i*60)+"ms";
      bar.title=`${new Intl.DateTimeFormat("fr-FR",{month:"long",year:"numeric"}).format(m.date)} : ${money(m.total,currency)}`;
      const name=document.createElement("span");name.className="month-name";name.textContent=new Intl.DateTimeFormat("fr-FR",{month:"short"}).format(m.date);
      col.append(val,bar,name);chart.appendChild(col);
    });
  }

  // ---------- Sauvegarde : état, export, import ----------
  function updateStorageStatus(){
    const el=$("storage-status");if(!el||!window.dataSdk||!window.dataSdk.info)return;
    const info=window.dataSdk.info(),when=info.savedAt?new Date(info.savedAt).toLocaleString("fr-FR",{dateStyle:"medium",timeStyle:"short"}):"—";
    el.textContent=`${info.count} enregistrement(s) conservé(s) sur cet appareil, avec copie de secours${info.persisted?" et stockage protégé":""}. Dernière sauvegarde : ${when}.`;
  }
  function downloadFile(name,text,type){
    const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  function backupPayload(){return JSON.stringify({app:"echeance",version:1,exported_at:new Date().toISOString(),records:window.dataSdk.getAll()},null,2)}
  function exportJson(){downloadFile(`echeance-sauvegarde-${normaliserDateLocale(new Date())}.json`,backupPayload(),"application/json");notify("Sauvegarde exportée.")}
  const csvCell=v=>{let s=String(v??"");if(/^[=+\-@\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`};
  function exportCsv(){
    const rows=[["Dépense","Catégorie","Échéance prévue","Date de paiement","Montant prévu","Montant payé","Devise","Mode de paiement","Note"]];
    for(const p of [...payments].sort((a,b)=>b.paid_date.localeCompare(a.paid_date))){
      const e=expenses.find(x=>x.expense_id===p.expense_id);
      rows.push([paymentName(p),e?.category||"",p.due_date,p.paid_date,p.amount,p.amount_paid,e?.currency||"XOF",p.payment_method||"",p.notes||""]);
    }
    downloadFile(`echeance-historique-${normaliserDateLocale(new Date())}.csv`,"﻿"+rows.map(r=>r.map(csvCell).join(";")).join("\r\n"),"text/csv;charset=utf-8");
    notify(payments.length?"Historique exporté.":"Aucun paiement à exporter pour l’instant.");
  }
  let pendingImport=null;
  function readImport(file){
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const data=JSON.parse(String(reader.result)),list=Array.isArray(data)?data:data&&data.records;
        if(!Array.isArray(list))throw new Error("format");
        const valid=list.filter(r=>r&&typeof r==="object"&&(r.record_type==="payment"?r.expense_id&&r.paid_date:typeof r.name==="string"&&r.name.trim()))
          .map(r=>({...cleanRecord(r),...(r.__backendId?{__backendId:String(r.__backendId)}:{})}));
        if(!valid.length)throw new Error("vide");
        pendingImport=valid;
        const pay=valid.filter(r=>r.record_type==="payment").length;
        $("import-summary").textContent=`${valid.length} enregistrement(s) trouvé(s) : ${valid.length-pay} dépense(s) et ${pay} paiement(s). « Fusionner » ajoute ce qui manque et garde vos données. « Remplacer » efface vos données actuelles (une sauvegarde automatique est d’abord téléchargée).`;
        $("import-confirm").hidden=false;
      }catch{pendingImport=null;$("import-confirm").hidden=true;notify("Fichier illisible : choisissez une sauvegarde Échéance (.json).",true)}
    };
    reader.onerror=()=>notify("Impossible de lire le fichier.",true);
    reader.readAsText(file);
  }
  async function applyImport(mode){
    if(!pendingImport)return;
    const buttons=[$("import-merge"),$("import-replace")];buttons.forEach(b=>b.disabled=true);
    try{
      if(mode==="replace"){
        if(pendingImport.length>MAX_RECORDS)throw new Error("Trop d’enregistrements dans ce fichier.");
        downloadFile(`echeance-avant-remplacement-${normaliserDateLocale(new Date())}.json`,backupPayload(),"application/json");
        const result=await window.dataSdk.replaceAll(pendingImport);if(!result.isOk)throw new Error("L’import a échoué. Vos données n’ont pas été modifiées.");
        notify(`${pendingImport.length} enregistrement(s) importé(s).`);
      }else{
        const haveExpense=new Set(expenses.map(e=>e.expense_id)),havePayment=new Set(payments.map(p=>p.occurrence_key));
        const fresh=pendingImport.filter(r=>r.record_type==="payment"?!havePayment.has(r.occurrence_key||keyFor(r.expense_id,r.due_date)):!haveExpense.has(r.expense_id));
        if(backendRecords.length+fresh.length>MAX_RECORDS)throw new Error("Trop d’enregistrements au total.");
        const result=await window.dataSdk.mergeAll(fresh);if(!result.isOk)throw new Error("L’import a échoué. Vos données n’ont pas été modifiées.");
        notify(result.added?`${result.added} enregistrement(s) ajouté(s).`:"Rien de nouveau : tout était déjà présent.");
      }
      pendingImport=null;$("import-confirm").hidden=true;
    }catch(e){notify(e.message||"L’import a échoué.",true)}finally{buttons.forEach(b=>b.disabled=false)}
  }

  // ---------- Notifications et installation ----------
  function updateNotifyLabel(){
    const label=$("notify-label");if(!label)return;
    if(!("Notification" in window)){label.textContent="Notifications indisponibles sur ce navigateur";$("notify-setting").disabled=true;return}
    label.textContent=prefs.notify&&Notification.permission==="granted"?"Désactiver les notifications":"Activer les notifications du navigateur";
  }
  async function toggleNotifications(){
    if(!("Notification" in window))return;
    if(prefs.notify&&Notification.permission==="granted"){prefs.notify=false;savePrefs();updateNotifyLabel();notify("Notifications désactivées.");return}
    let permission=Notification.permission;
    if(permission==="default"){try{permission=await Notification.requestPermission()}catch{}}
    if(permission==="granted"){prefs.notify=true;savePrefs();updateNotifyLabel();notify("Notifications activées.");render()}
    else notify("Autorisation refusée : autorisez les notifications dans les réglages du navigateur.",true);
  }
  let installEvent=null;
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvent=e;const b=$("install-btn");if(b)b.hidden=false});
  window.addEventListener("appinstalled",()=>{installEvent=null;const b=$("install-btn");if(b)b.hidden=true;notify("Application installée.")});

  function render(){if(!loaded)return;renderDashboard();renderCalendar();renderExpenses();renderHistory();updateStorageStatus()}
  function showView(view){
    activeView=view;document.querySelectorAll("[data-view]").forEach(b=>{const active=b.dataset.view===view;b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current")});
    for(const key of Object.keys(HEADINGS))$("view-"+key).hidden=key!==view;
    const shown=$("view-"+view);shown.classList.remove("view-enter");void shown.offsetWidth;shown.classList.add("view-enter");window.scrollTo({top:0});
    $("view-title").textContent=HEADINGS[view][0];$("view-subtitle").textContent=HEADINGS[view][1];
    $("header-add").hidden=view==="settings";$("floating-add").hidden=view==="settings";if(loaded)render();
  }

  // Formulaires et confirmations.
  function openDialog(id){focusBeforeDialog=document.activeElement;$(id).hidden=false;document.body.style.overflow="hidden";$(id).querySelector("input:not([hidden]),button")?.focus()}
  function closeDialog(id){$(id).hidden=true;document.body.style.overflow="";focusBeforeDialog?.focus()}
  function openForm(id=null){
    if(!loaded)return notify("Attendez la fin du chargement.",true);
    const e=id?expenses.find(x=>String(x.__backendId)===String(id)):null;editingId=e?.__backendId??null;
    $("expense-form").reset();$("form-error").hidden=true;$("form-title").textContent=e?"Modifier la dépense":"Nouvelle dépense";
    for(const [field,value] of Object.entries({name:e?.name||"",category:e?.category||"",amount:e?.amount??"",currency:e?.currency||prefs.currency,frequency:e?.frequency||"monthly",start:e?.start_date||normaliserDateLocale(new Date()),due:e?.next_due_date||normaliserDateLocale(new Date()),end:e?.end_date||"",method:e?.payment_method||"Espèces",provider:e?.provider||"",logo:e?.logo_ref||"category",status:e?.status||"upcoming",notes:e?.notes||""}))$("f-"+field).value=value;
    openDialog("expense-overlay");
  }
  function expenseInput(existing){
    const old=existing?raw(existing.__backendId):null,now=new Date().toISOString();
    return {...blank(),...old,record_type:"expense",expense_id:existing?.expense_id||uid(),name:$("f-name").value.trim(),category:$("f-category").value,amount:Number($("f-amount").value),currency:$("f-currency").value,start_date:$("f-start").value,next_due_date:$("f-due").value,end_date:$("f-end").value,frequency:$("f-frequency").value,payment_method:$("f-method").value,provider:$("f-provider").value.trim(),notes:$("f-notes").value.trim(),status:$("f-status").value,logo_ref:$("f-logo").value||"category",created_at:existing?.created_at||now,updated_at:now};
  }
  async function saveExpense(event){
    event.preventDefault();const button=event.submitter||$("expense-form").querySelector('[type="submit"]');if(button.disabled)return;
    const existing=editingId!==null?expenses.find(e=>String(e.__backendId)===String(editingId)):null,record=expenseInput(existing);
    const error=$("form-error");
    if(editingId!==null&&!existing||!record.name||!record.category||!Number.isFinite(record.amount)||record.amount<=0||!record.provider||!normaliserDateLocale(record.start_date)||!normaliserDateLocale(record.next_due_date)||record.end_date&&(!normaliserDateLocale(record.end_date)||record.end_date<record.next_due_date)){
      error.textContent="Vérifiez les champs obligatoires et les dates, notamment la date de fin.";error.hidden=false;return;
    }
    if(!existing&&backendRecords.length>=MAX_RECORDS)return showLimit(error);
    error.hidden=true;button.disabled=true;
    try{await mutate(existing?"update":"create",existing?{...raw(existing.__backendId),...cleanRecord(record)}:cleanRecord(record));closeDialog("expense-overlay");notify(existing?"Dépense modifiée.":"Dépense enregistrée.")}
    catch(e){error.textContent=e.message;error.hidden=false}finally{button.disabled=false}
  }
  function showLimit(el){el.textContent=`Limite de ${MAX_RECORDS} enregistrements atteinte.`;el.hidden=false}
  function openPayment(id,date){
    const expense=expenses.find(e=>e.expense_id===id);if(!expense)return notify("Dépense introuvable.",true);
    const item=générerOccurrence(expense,date);
    if(item.payment||expense.status==="cancelled")return notify("Cette échéance ne peut plus être payée.",true);
    paymentTarget={id,date};selectedPayment=null;$("payment-form").reset();$("payment-error").hidden=true;
    $("payment-title").textContent="Enregistrer un paiement";
    $("payment-context").textContent=`${expense.name} · prévu le ${dateLabel(date)} · ${money(expense.amount,expense.currency)}. Aucun paiement Mobile Money n’est vérifié automatiquement.`;
    $("p-amount").value=expense.amount;$("p-date").value=normaliserDateLocale(new Date());$("p-method").value=expense.payment_method;
    openDialog("payment-overlay");
  }
  function openPaymentRecord(key){
    const p=payments.find(x=>(x.__legacy?`legacy-${x.__backendId}`:String(x.__backendId))===key);
    if(!p)return notify("Paiement introuvable.",true);
    selectedPayment=p;paymentTarget=null;$("payment-form").reset();$("payment-error").hidden=true;
    $("payment-title").textContent="Consulter ou corriger un paiement";
    $("payment-context").textContent=`${paymentName(p)} · échéance prévue le ${dateLabel(p.due_date)} · montant prévu ${money(p.amount,expenses.find(e=>e.expense_id===p.expense_id)?.currency||"XOF")}.`;
    $("p-amount").value=p.amount_paid;$("p-date").value=p.paid_date;$("p-method").value=p.payment_method||"Autre";$("p-note").value=p.notes||"";
    openDialog("payment-overlay");
  }
  async function savePayment(event){
    event.preventDefault();const button=event.submitter||$("payment-form").querySelector('[type="submit"]');if(button.disabled)return;
    const error=$("payment-error"),amount=Number($("p-amount").value),date=$("p-date").value;
    if(!Number.isFinite(amount)||amount<=0||!normaliserDateLocale(date)){error.textContent="Indiquez un montant positif et une date réelle valide.";error.hidden=false;return}
    const existing=selectedPayment,expense=paymentTarget?expenses.find(e=>e.expense_id===paymentTarget.id):expenses.find(e=>e.expense_id===existing?.expense_id);
    const key=existing?.occurrence_key||keyFor(paymentTarget.id,paymentTarget.date);
    if(pendingKeys.has(key))return;
    if(!existing&&paymentFor(paymentTarget.id,paymentTarget.date)){error.textContent="Cette échéance possède déjà un paiement.";error.hidden=false;return}
    if(!existing&&backendRecords.length>=MAX_RECORDS)return showLimit(error);
    if(existing&&!existing.__legacy&&!raw(existing.__backendId)){error.textContent="Ce paiement n’est plus disponible.";error.hidden=false;return}
    if(existing?.__legacy&&!raw(existing.__backendId)){error.textContent="Cette ancienne dépense n’est plus disponible.";error.hidden=false;return}
    pendingKeys.add(key);button.disabled=true;error.hidden=true;
    try{
      const now=new Date().toISOString(),notes=$("p-note").value.trim(),method=$("p-method").value;
      if(existing?.__legacy){
        if(backendRecords.length>=MAX_RECORDS)return showLimit(error);
        const legacy=raw(existing.__backendId),record=cleanRecord({...blank(),record_type:"payment",expense_id:existing.expense_id,due_date:existing.due_date,paid_date:date,amount:existing.amount,amount_paid:amount,payment_method:method,notes,occurrence_key:key,created_at:now,updated_at:now,status:"paid"});
        await mutate("create",record);
        // La ligne ancienne est conservée ; le nouveau paiement prend priorité à la lecture.
      }else if(existing){
        await mutate("update",{...raw(existing.__backendId),paid_date:date,amount_paid:amount,payment_method:method,notes,updated_at:now});
      }else{
        if(!expense)throw new Error("La dépense n’est plus disponible.");
        await mutate("create",cleanRecord({...blank(),record_type:"payment",expense_id:expense.expense_id,due_date:paymentTarget.date,paid_date:date,amount:expense.amount,amount_paid:amount,payment_method:method,notes,occurrence_key:key,status:"paid",created_at:now,updated_at:now}));
      }
      closeDialog("payment-overlay");notify(existing?"Paiement corrigé.":"Paiement enregistré.");
    }catch(e){error.textContent=e.message;error.hidden=false}finally{pendingKeys.delete(key);button.disabled=false}
  }
  function openDelete(id){deletingId=id;openDialog("delete-overlay")}
  async function confirmDelete(event){
    const button=event.currentTarget,record=raw(deletingId);if(!record)return notify("Dépense introuvable.",true);
    button.disabled=true;try{await mutate("delete",record);closeDialog("delete-overlay");notify("Dépense supprimée ; ses paiements restent dans l’historique.")}catch(e){notify(e.message,true)}finally{button.disabled=false}
  }
  function requestPaymentDelete(){
    if(!selectedPayment)return;
    closeDialog("payment-overlay");openDialog("payment-delete-overlay");
  }
  async function confirmPaymentDelete(event){
    const button=event.currentTarget,p=selectedPayment;if(!p)return;
    button.disabled=true;
    try{
      if(p.__legacy){
        const old=raw(p.__backendId);if(!old)throw new Error("Ancienne dépense introuvable.");
        await mutate("update",{...old,status:"upcoming",paid_date:"",updated_at:new Date().toISOString()});
      }else{const record=raw(p.__backendId);if(!record)throw new Error("Paiement introuvable.");await mutate("delete",record)}
      closeDialog("payment-delete-overlay");notify("Paiement supprimé.");
    }catch(e){notify(e.message,true)}finally{button.disabled=false}
  }
  // L’action n’efface jamais les lignes non marquées comme démonstration.
  async function resetDemo(event){
    const button=event.currentTarget,demos=backendRecords.filter(r=>r.notes==="[DEMO]"||r.notes?.startsWith("[DEMO] "));
    button.disabled=true;
    try{
      for(const record of demos)await mutate("delete",record);
      $("reset-confirm").hidden=true;notify(demos.length?`${demos.length} exemple(s) supprimé(s).`:"Aucun exemple identifié. Vos données sont intactes.");
    }catch(e){notify(`${e.message} Vérifiez la liste avant toute nouvelle tentative.`,true)}finally{button.disabled=false}
  }

  document.addEventListener("DOMContentLoaded",()=>{
    readPrefs();applyPrefs();if(window.lucide)lucide.createIcons();
    document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
    ["header-add","floating-add","quick-add"].forEach(id=>$(id).addEventListener("click",()=>openForm()));
    document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeDialog(b.dataset.close)));
    $("expense-form").addEventListener("submit",saveExpense);$("payment-form").addEventListener("submit",savePayment);
    $("expense-search").addEventListener("input",renderExpenses);
    ["category-filter","status-filter"].forEach(id=>$(id).addEventListener("change",renderExpenses));
    $("history-search").addEventListener("input",renderHistory);
    ["history-month","history-method"].forEach(id=>$(id).addEventListener("change",renderHistory));
    $("prev-month").addEventListener("click",()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()-1,1);selectedDay=normaliserDateLocale(calendarMonth);renderCalendar()});
    $("next-month").addEventListener("click",()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,1);selectedDay=normaliserDateLocale(calendarMonth);renderCalendar()});
    $("today-month").addEventListener("click",()=>{const now=new Date();calendarMonth=new Date(now.getFullYear(),now.getMonth(),1);selectedDay=normaliserDateLocale(now);renderCalendar()});
    $("currency-setting").addEventListener("change",e=>{prefs.currency=e.target.value;if(savePrefs()){render();notify("Devise principale enregistrée.")}});
    $("theme-setting").addEventListener("change",e=>{prefs.theme=e.target.value;applyPrefs();if(savePrefs())notify("Apparence enregistrée.")});
    $("reset-demo").addEventListener("click",()=>{$("reset-confirm").hidden=false;$("confirm-reset").focus()});
    $("cancel-reset").addEventListener("click",()=>{$("reset-confirm").hidden=true;$("reset-demo").focus()});
    $("confirm-reset").addEventListener("click",resetDemo);
    $("confirm-delete").addEventListener("click",confirmDelete);
    $("confirm-payment-delete").addEventListener("click",confirmPaymentDelete);
    $("retry-load").addEventListener("click",initialize);
    // Le bouton de suppression du paiement apparaît uniquement en consultation.
    const deletePaymentButton=document.createElement("button");
    deletePaymentButton.type="button";deletePaymentButton.id="request-payment-delete";deletePaymentButton.className="secondary danger mt-4";
    deletePaymentButton.textContent="Supprimer ce paiement";
    $("payment-form").appendChild(deletePaymentButton);
    deletePaymentButton.addEventListener("click",requestPaymentDelete);
    new MutationObserver(()=>{deletePaymentButton.hidden=!selectedPayment}).observe($("payment-overlay"),{attributes:true,attributeFilter:["hidden"]});
    deletePaymentButton.hidden=true;
    document.querySelectorAll(".dialog-backdrop").forEach(overlay=>overlay.addEventListener("click",e=>{if(e.target===overlay)closeDialog(overlay.id)}));
    document.addEventListener("keydown",e=>{
      const overlay=[...document.querySelectorAll(".dialog-backdrop")].find(x=>!x.hidden);if(!overlay)return;
      if(e.key==="Escape"){closeDialog(overlay.id);return}
      if(e.key!=="Tab")return;
      const controls=[...overlay.querySelectorAll("button,input,select,textarea")].filter(x=>!x.disabled&&!x.hidden);
      if(!controls.length)return;
      if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1).focus()}
      else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0].focus()}
    });
    // Budget, rappels, notifications
    $("budget-setting").addEventListener("change",e=>{prefs.budget=Math.max(0,Number(e.target.value)||0);e.target.value=prefs.budget>0?prefs.budget:"";if(savePrefs()){render();notify(prefs.budget>0?"Budget mensuel enregistré.":"Budget désactivé.")}});
    $("reminder-setting").addEventListener("change",e=>{prefs.reminderDays=Number(e.target.value);if(savePrefs()){render();notify("Rappel enregistré.")}});
    $("notify-setting").addEventListener("click",toggleNotifications);updateNotifyLabel();
    // Sauvegarde
    $("export-json").addEventListener("click",exportJson);
    $("export-csv").addEventListener("click",exportCsv);
    $("import-json").addEventListener("click",()=>$("import-file").click());
    $("import-file").addEventListener("change",e=>{const file=e.target.files&&e.target.files[0];if(file)readImport(file);e.target.value=""});
    $("import-merge").addEventListener("click",()=>applyImport("merge"));
    $("import-replace").addEventListener("click",()=>applyImport("replace"));
    $("import-cancel").addEventListener("click",()=>{pendingImport=null;$("import-confirm").hidden=true});
    // Installation sur l'écran d'accueil
    const installButton=$("install-btn");
    installButton.hidden=!installEvent;
    installButton.addEventListener("click",async()=>{if(!installEvent)return;installEvent.prompt();try{await installEvent.userChoice}catch{}installEvent=null;installButton.hidden=true});
    // Statuts à jour quand on revient sur l'application (passage à minuit, etc.)
    document.addEventListener("visibilitychange",()=>{if(!document.hidden&&loaded)render()});
    // Mode hors connexion
    if("serviceWorker" in navigator&&location.protocol!=="file:")navigator.serviceWorker.register("sw.js").catch(()=>{});
    $("view-home").classList.add("view-enter");
    if(window.dataSdk&&window.dataSdk.onStatus)window.dataSdk.onStatus(updateStorageStatus);
    initialize();
  });
})();
