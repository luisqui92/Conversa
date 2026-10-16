import { makeId, processCampaignComment, PLANS, CHANNELS, LEAD_STAGES } from './engine.mjs';

export function isValidState(state) {
 const plain=value=>value && typeof value==='object' && !Array.isArray(value);
 const safeId=id=>typeof id==='string' && /^[a-zA-Z0-9_-]+$/.test(id) && !['__proto__','constructor','prototype'].includes(id);
 const validMessage=m=>plain(m) && ['public','dm'].includes(m.type) && ['business','contact'].includes(m.sender) && typeof m.text==='string' && typeof m.at==='string' && !Number.isNaN(new Date(m.at).getTime());
 const validCampaign=c=>plain(c) && typeof c.id==='string' && CHANNELS.includes(c.channel) && Array.isArray(c.keywords) && c.keywords.every(k=>typeof k==='string') && ['title','postId','product','price','description','hours','privateTemplate','publicTemplate','fallbackTemplate'].every(k=>typeof c[k]==='string');
 const validEvent=(e,id)=>plain(e) && e.workspaceId===id && typeof e.id==='string' && typeof e.name==='string' && typeof e.text==='string' && CHANNELS.includes(e.channel) && (!e.leadStage||Object.hasOwn(LEAD_STAGES,e.leadStage)) && ['pending','automatic','manual','ignored'].includes(e.status) && ['pending','awaiting_team','awaiting_contact','blocked','public_only','closed'].includes(e.conversation) && ['comment','dm'].includes(e.source) && typeof e.at==='string' && !Number.isNaN(new Date(e.at).getTime()) && Array.isArray(e.messages) && e.messages.every(validMessage) && Array.isArray(e.timeline) && e.timeline.every(t=>plain(t)&&typeof t.text==='string'&&typeof t.at==='string'&&!Number.isNaN(new Date(t.at).getTime())) && (e.snapshot==null || validCampaign(e.snapshot));
 return Boolean(state?.version===2 && safeId(state.current) && plain(state.workspaces) && Object.hasOwn(state.workspaces,state.current) && Object.entries(state.workspaces).every(([id,w])=>safeId(id) && plain(w) && w.id===id && typeof w.label==='string' && Object.hasOwn(PLANS,w.plan) && Array.isArray(w.campaigns) && w.campaigns.every(validCampaign) && Array.isArray(w.events) && w.events.every(e=>validEvent(e,id))));
}

export function newCampaign(channel='Instagram',vertical='general') {
 const campaign={id:makeId(),channel,vertical,title:'',postId:'',product:'',price:'',currency:'Bs',description:'',hours:'',bookingUrl:'',expiresAt:'',
 keywords:['precio','cuanto cuesta','info','menu'],anyComment:false,active:true,autoFollowup:true,action:'both',
 privateTemplate:'¡Hola, {nombre}! En la publicación de {producto}, el precio es {moneda}{precio}. {detalle} Horario: {horario}. {reserva}',
 publicTemplate:'¡Hola, {nombre}! Te enviamos los detalles de esta publicación por privado 💬',
 fallbackTemplate:'¡Hola, {nombre}! Escríbenos «{producto}» por privado y te compartimos los detalles de esta publicación.'};
 if (vertical==='realestate') Object.assign(campaign,{currency:'USD',operation:'Venta',propertyType:'Departamento',location:'',area:'',bedrooms:'',bathrooms:'',availability:'available',keywords:['precio','cuanto cuesta','info','informacion','detalles'],privateTemplate:'¡Hola, {nombre}! Te compartimos la ficha de {producto}. Operación: {operacion}. Precio: {moneda}{precio}. Zona: {zona}. Superficie: {superficie} m²; {dormitorios} dormitorios y {banos} baños. {detalle} {reserva}',publicTemplate:'¡Hola, {nombre}! Te enviamos la ficha de este inmueble por privado 🏡'});
 return campaign;
}
export function initialRestaurant(id,label,style='andina') {
 const lunch={...newCampaign(),id:`${id}-lunch`,title:style==='andina'?'Almuerzo de la casa':'Menú de mediodía',postId:`${id}-ig-001`,product:style==='andina'?'Almuerzo de la casa':'Menú de mediodía',price:'35',description:'Incluye sopa, plato principal y refresco. Promoción de ejemplo.',hours:'Lunes a viernes, de 12:00 a 15:00'};
 const dinner={...newCampaign('Facebook'),id:`${id}-dinner`,title:style==='andina'?'Cena para dos':'Combo sushi para dos',postId:`${id}-fb-002`,product:style==='andina'?'Cena para dos':'Combo sushi para dos',price:style==='andina'?'120':'89',description:style==='andina'?'Dos platos principales y dos bebidas. Menú de ejemplo.':'20 piezas de sushi y dos bebidas. Menú de ejemplo.',hours:'Viernes y sábado, de 19:00 a 22:00'};
 const tiktok={...newCampaign('TikTok'),id:`${id}-tiktok`,title:'Promoción del fin de semana',postId:`${id}-tt-003`,product:'Promoción del fin de semana',price:'49',description:'Un plato especial y una bebida. Promoción de ejemplo.',hours:'Sábado y domingo, de 12:00 a 16:00'};
 const ws={id,label,kind:'restaurant',plan:'negocio',campaigns:[lunch,dinner,tiktok],events:[],metaRecovery:true};
 const inputs=[
 {name:'María López',initials:'ML',campaign:lunch,text:'¿Cuánto cuesta el almuerzo?'},
 {name:'Daniel Rojas',initials:'DR',campaign:dinner,text:'Info de la cena para dos 🙌'},
 {name:'Valentina Díaz',initials:'VD',campaign:tiktok,text:'Precio por favor'},
 {name:'Sofía Torres',initials:'ST',campaign:lunch,text:'¿Tienen opciones sin gluten?'},
 {name:'Andrés Pérez',initials:'AP',campaign:dinner,text:'¿Cuánto cuesta?',delivery:'rejected'}
 ];
 for (const [i,entry] of inputs.entries()) {
   const {campaign,...person}=entry;
   const event=processCampaignComment(ws,{...person,id:`${id}-event-${i}`,externalId:`demo-comment-${i}`,workspaceId:id,channel:campaign.channel,postId:campaign.postId},{delivery:entry.delivery || 'success'}).event;
   ws.events.push(event);
 }
 return ws;
}
export function initialRealEstate() {
 const id='inmobiliaria';
 const apartment={...newCampaign('Instagram','realestate'),id:'inmo-apartamento',title:'Departamento en Equipetrol',postId:'demo-ig-inmueble-001',product:'Departamento en Equipetrol',price:'125000',operation:'Venta',location:'Equipetrol, Santa Cruz',area:'120',bedrooms:'3',bathrooms:'2',description:'Balcón y un parqueo. Inmueble y datos de ejemplo.',hours:'Lunes a sábado, de 09:00 a 18:00'};
 const house={...newCampaign('Facebook','realestate'),id:'inmo-casa',title:'Casa en alquiler · Zona Norte',postId:'demo-fb-inmueble-002',product:'Casa en Zona Norte',price:'4500',currency:'Bs',operation:'Alquiler',propertyType:'Casa',location:'Zona Norte, Santa Cruz',area:'180',bedrooms:'3',bathrooms:'2',description:'Jardín y dos parqueos. Canon mensual de ejemplo.',hours:'Lunes a sábado, de 09:00 a 18:00',privateTemplate:'¡Hola, {nombre}! {producto} está en {operacion}. Precio: {moneda}{precio} por mes. Zona: {zona}. Superficie: {superficie} m²; {dormitorios} dormitorios y {banos} baños. {detalle} {reserva}'};
 const anticretico={...newCampaign('TikTok','realestate'),id:'inmo-anticretico',title:'Departamento en anticrético',postId:'demo-tt-inmueble-003',product:'Departamento en Sopocachi',price:'35000',operation:'Anticrético',location:'Sopocachi, La Paz',area:'85',bedrooms:'2',bathrooms:'1',description:'Cocina equipada. Condiciones de ejemplo; un asesor revisará la documentación.',hours:'Lunes a viernes, de 09:00 a 18:00'};
 const ws={id,label:'Inmobiliaria · Demo',kind:'realestate',plan:'negocio',campaigns:[apartment,house,anticretico],events:[],metaRecovery:true};
 for (const [i,entry] of [{name:'María López',initials:'ML',campaign:apartment,text:'¿Cuánto cuesta?'},{name:'Daniel Rojas',initials:'DR',campaign:house,text:'Info de esta casa por favor'},{name:'Valentina Díaz',initials:'VD',campaign:anticretico,text:'Precio del anticrético'},{name:'Sofía Torres',initials:'ST',campaign:apartment,text:'¿Aceptan crédito bancario?'}].entries()) {
   const {campaign,...person}=entry;
   ws.events.push(processCampaignComment(ws,{...person,id:`inmo-event-${i}`,externalId:`demo-inmo-comment-${i}`,workspaceId:id,channel:campaign.channel,postId:campaign.postId}).event);
 }
 return ws;
}
export function upgradeIndustry(state) {
 if (!state.workspaces.inmobiliaria) {state.workspaces.inmobiliaria=initialRealEstate();state.current='inmobiliaria';}
 for (const [id,w] of Object.entries(state.workspaces)) if (!w.kind) w.kind=['casa','sakura'].includes(id)?'restaurant':'general';
 return state;
}
export const createState = () => ({version:2,current:'inmobiliaria',workspaces:{inmobiliaria:initialRealEstate(),casa:initialRestaurant('casa','Casa Andina'),sakura:initialRestaurant('sakura','Sakura Sushi','sakura')}});
export function migrateLegacy(old) {
 const state=createState();
 state.legacyV1=old;
 for (const [key,entry] of Object.entries(old?.workspaces || {})) {
   if (!entry || typeof entry !== 'object') continue;
   const id=`anterior-${key}`;
   const ws={id,label:`${entry.label || key} · anterior`,plan:'negocio',campaigns:[],events:[],legacyRules:entry.rules || [],legacyComments:entry.comments || []};
   for (const channel of ['Instagram','Facebook','TikTok']) {
    const rule=(entry.rules || []).find(r=>r.channel===channel || r.channel==='Todos');
    if (!rule) continue;
    ws.campaigns.push({...newCampaign(channel),id:`${id}-${channel}`,title:entry.post || 'Publicación anterior',postId:`legacy-${channel}`,product:entry.label || key,price:'0',description:'Datos importados del prototipo anterior; edita antes de activar.',hours:'Por confirmar',action:'public',active:false,keywords:rule.keywords || ['info'],publicTemplate:rule.reply || 'Nuestro equipo te ayudará.'});
   }
   ws.events=(entry.comments || []).map(c=>({...c,id:`${id}-${c.id}`,workspaceId:id,externalId:String(c.id),source:'comment',postId:`legacy-${c.channel}`,postTitle:c.post,messages:c.reply?[{id:makeId(),type:'public',sender:'business',origin:c.status==='automatic'?'automation':'manual',text:c.reply,at:c.at || new Date().toISOString(),demo:true}]:[],snapshot:null,conversation:c.reply?'public_only':'pending',timeline:[],reason:'Importado del prototipo anterior.',demo:true}));
   state.workspaces[id]=ws;
 }
 return state;
}
