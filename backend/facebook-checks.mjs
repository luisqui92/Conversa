import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { openStore } from './store.mjs';
import { makeServer } from './server.mjs';
import { openInstagramAutomation } from './instagram-automation.mjs';
import { openFacebookAutomation, createFacebookWorker, sendFacebookPhase, renderFacebookReply } from './facebook-automation.mjs';
import { resolveFacebookPage, subscribeFacebookPage } from './facebook-connection.mjs';

const pageId='309667913276491', postId=pageId+'_123456789012345', commentId='123456789012345_987654321012345';
const publicText='Te mandé información por Messenger', dmText='hola soy yo yo puedo con todo';
const userToken='test-user-secret', pageToken='test-page-secret';
const ok=data=>({ok:true,status:200,json:async()=>data});
test('Obtención privada del token de página y suscripción de Facebook',async t=>{
  await t.test('El token de usuario solo obtiene la página elegida y se comprueba su identidad',async()=>{
    const calls=[];
    const result=await resolveFacebookPage(userToken,pageId,async(url,options)=>{
      calls.push({url,options}); assert.ok(!url.includes(userToken)); assert.ok(!url.includes(pageToken));
      if(url.includes('/me/accounts?')){
        assert.equal(options.headers.Authorization,'Bearer '+userToken);
        return ok({data:[{id:'99999999',name:'Otra',tasks:['MODERATE','MESSAGING'],access_token:'other-secret'},{id:pageId,name:'Página de prueba',tasks:['MODERATE','MESSAGING','MANAGE'],access_token:pageToken}]});
      }
      assert.equal(options.headers.Authorization,'Bearer '+pageToken); return ok({id:pageId,name:'Página de prueba'});
    });
    assert.equal(calls.length,2); assert.equal(result.accessToken,pageToken); assert.equal(result.accountId,pageId);
    assert.ok(!JSON.stringify(result).includes(userToken)); assert.ok(!JSON.stringify(result).includes('other-secret'));
  });
  await t.test('Rechaza página ausente, tareas insuficientes e identidad distinta',async()=>{
    await assert.rejects(resolveFacebookPage(userToken,pageId,async()=>ok({data:[]})),/no aparece/);
    await assert.rejects(resolveFacebookPage(userToken,pageId,async()=>ok({data:[{id:pageId,name:'Prueba',tasks:['ANALYZE'],access_token:pageToken}]})),/MODERATE/);
    let n=0;
    await assert.rejects(resolveFacebookPage(userToken,pageId,async()=>++n===1?ok({data:[{id:pageId,name:'Prueba',tasks:['MODERATE','MESSAGING'],access_token:pageToken}]}):ok({id:'99999999'})),/no corresponde/);
  });
  await t.test('No imprime cuerpos de error ni credenciales del proveedor',async()=>{
    await assert.rejects(resolveFacebookPage(userToken,pageId,async()=>({ok:false,status:400,json:async()=>({error:{code:190,message:userToken}})})),error=>error.message.includes('190')&&!error.message.includes(userToken));
    await assert.rejects(resolveFacebookPage(userToken,pageId,async()=>{throw new Error(userToken);}),error=>!error.message.includes(userToken));
  });
  await t.test('Suscribe la página con su token y exige confirmación del proveedor',async()=>{
    assert.equal(await subscribeFacebookPage({accountId:pageId,accessToken:pageToken},async(url,options)=>{
      assert.ok(url.endsWith('/'+pageId+'/subscribed_apps')); assert.ok(!url.includes(pageToken));
      assert.equal(options.method,'POST'); assert.equal(options.headers.Authorization,'Bearer '+pageToken);
      assert.equal(new URLSearchParams(options.body).get('subscribed_fields'),'feed,messages,messaging_postbacks'); return ok({success:true});
    }),true);
    await assert.rejects(subscribeFacebookPage({accountId:pageId,accessToken:pageToken},async()=>ok({success:false})),/no confirmó/);
  });
});

test('Webhook de Page, reglas y Messenger aislados de Instagram',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'conversa-facebook-')), path=join(dir,'test.sqlite');
  let now=Date.now();
  const store=openStore(path,{now:()=>now});
  store.setPassword('owner@example.test','test-password-123',true); store.setPassword('other@example.test','test-password-456',true);
  const owner=store.userByEmail('owner@example.test');
  const config={accountId:pageId,username:'Página de prueba',ownerId:owner.id,accessToken:pageToken,appSecret:'facebook-test-secret',verifyToken:'facebook-verification'};
  const instagramConfig={...config,appSecret:'instagram-test-secret',verifyToken:'instagram-verification'};
  const facebook=openFacebookAutomation(path,{now:()=>now}), instagram=openInstagramAutomation(path,{now:()=>now});
  const server=makeServer({store,facebook:()=>config,facebookAutomation:facebook,instagram:()=>instagramConfig,automation:instagram});
  const entry=(id=commentId,overrides={})=>({id:pageId,time:Math.floor(now/1000),changes:[{field:'feed',value:{item:'comment',verb:'add',comment_id:id,post_id:postId,parent_id:postId,from:{id:'333333333333',name:'Prueba'},message:'Info',created_time:Math.floor(now/1000),...overrides}}]});
  function request(method,url,body='',headers={}){
    return new Promise(resolve=>{
      const req=Readable.from([Buffer.from(body)]); Object.assign(req,{method,url,headers,socket:{remoteAddress:'test'}});
      const res={headersSent:false,destroyed:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){resolve({status:this.status,headers:this.headers,body});}};
      server.emit('request',req,res);
    });
  }
  async function hook(entries,secret=config.appSecret,object='page',url='/api/webhooks/facebook'){
    const body=JSON.stringify({object,entry:entries});
    return request('POST',url,body,{'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')});
  }
  try{
    await t.test('La verificación de Facebook no acepta el token de Instagram',async()=>{
      assert.equal((await request('GET','/api/webhooks/facebook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=instagram-verification')).status,403);
      const result=await request('GET','/api/webhooks/facebook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=facebook-verification');
      assert.equal(result.status,200); assert.equal(result.body,'123');
    });
    await t.test('Rechaza firmas cruzadas, objetos de otro proveedor y páginas no elegidas',async()=>{
      assert.equal((await hook([entry()],instagramConfig.appSecret)).status,403);
      assert.equal((await hook([entry()],config.appSecret,'instagram')).status,400);
      assert.equal((await hook([{...entry(),id:'99999999'}])).status,200);
      assert.equal(store.facebookEventCount(owner.id),0);
    });
    await t.test('Recibe el comentario, deduplica y no crea envíos sin una regla',async()=>{
      assert.equal((await hook([entry()])).status,200); await hook([entry()]);
      assert.equal(store.facebookEventCount(owner.id),1); assert.equal(store.instagramEventCount(owner.id),0);
      assert.equal(facebook.report(owner.id).actions.length,0);
    });
    facebook.enable(config,postId,publicText,dmText);
    await t.test('Ignora ediciones, respuestas, comentarios propios, identidad ausente y otra publicación',()=>{
      const entries=[entry('22222222_44444444',{verb:'edited'}),entry('22222222_44444445',{parent_id:commentId}),entry('22222222_44444446',{from:{id:pageId}}),entry('22222222_44444447',{from:{}}),entry('22222222_44444448',{post_id:'99999999_88888888',parent_id:'99999999_88888888'})];
      assert.equal(facebook.enqueue(config,entries),0);
    });
    await t.test('Encola IDs compuestos de Facebook sin tocar las tablas de Instagram',async()=>{
      now+=1000;
      assert.equal((await hook([entry('123456789012345_987654321012346')])).status,200);
      assert.equal(facebook.report(owner.id).actions[0].status,'pending');
      assert.deepEqual(instagram.report(owner.id),{rules:[],actions:[]});
      assert.equal(facebook.enqueue(config,[entry('123456789012345_987654321012346')]),0);
    });
    await t.test('El trabajador confirma primero el comentario y después envía Messenger por comment_id',async()=>{
      const calls=[];
      const worker=createFacebookWorker({automation:facebook,facebook:()=>config,request:async(url,options)=>{
        assert.ok(url.startsWith('https://graph.facebook.com/v26.0/')); assert.equal(options.headers.Authorization,'Bearer '+pageToken); assert.ok(!url.includes(pageToken));
        calls.push({url,body:JSON.parse(options.body)}); return url.endsWith('/comments')?ok({id:'public-facebook-id'}):ok({message_id:'facebook-private-id'});
      }});
      await worker.tick(); assert.equal(calls.length,1); assert.ok(calls[0].url.endsWith('/123456789012345_987654321012346/comments'));
      assert.deepEqual(calls[0].body,{message:publicText}); assert.equal(facebook.report(owner.id).actions[0].status,'public_done');
      await worker.tick(); assert.equal(calls.length,2);
      assert.deepEqual(calls[1].body,{recipient:{comment_id:'123456789012345_987654321012346'},message:{text:dmText}});
      assert.equal(facebook.report(owner.id).actions[0].status,'sent'); await worker.tick(); assert.equal(calls.length,2);
    });
    await t.test('Otros usuarios no ven la conexión, eventos o reglas; los endpoints no exponen tokens',async()=>{
      for(const route of ['/api/integrations/facebook','/api/integrations/facebook/events','/api/integrations/facebook/automation']) assert.equal((await request('GET',route)).status,401);
      const a=store.login('owner@example.test','test-password-123','test'),b=store.login('other@example.test','test-password-456','test');
      const get=(route,session)=>request('GET',route,'',{cookie:'__Host-conversa='+session.token});
      assert.deepEqual(JSON.parse((await get('/api/integrations/facebook',b)).body),{configured:false});
      assert.deepEqual(JSON.parse((await get('/api/integrations/facebook/events',b)).body),{events:[]});
      assert.deepEqual(JSON.parse((await get('/api/integrations/facebook/automation',b)).body),{rules:[],actions:[]});
      const own=await get('/api/integrations/facebook',a); assert.equal(JSON.parse(own.body).configured,true); assert.ok(!own.body.includes(pageToken)); assert.ok(!own.body.includes(config.appSecret));
    });
    await t.test('Errores y resultados inciertos de Messenger conservan solo diagnósticos seguros',async()=>{
      const job={comment_id:commentId,status:'dm_sending',public_text:publicText,dm_text:dmText};
      const rejected=await sendFacebookPhase(config,job,async()=>({ok:false,status:400,json:async()=>({error:{code:10,message:pageToken}})}));
      assert.equal(rejected.uncertain,false); assert.ok(!rejected.error.includes(pageToken));
      const unknown=await sendFacebookPhase(config,job,async()=>{throw new Error(pageToken);}); assert.equal(unknown.uncertain,true);
      const empty=await sendFacebookPhase(config,job,async()=>ok({success:true})); assert.equal(empty.uncertain,true);
    });
    await t.test('La regla con {autor} usa al autor del webhook firmado antes del comentario y conserva el DM',async()=>{
      now+=1000;
      const template='{autor} '+publicText, newId='123456789012345_987654321012349';
      facebook.enable(config,postId,template,dmText); now+=1000;
      assert.equal((await hook([entry(newId,{from:{id:'444444444444',name:'No usar como etiqueta'}})])).status,200);
      const calls=[];
      const worker=createFacebookWorker({automation:facebook,facebook:()=>config,request:async(url,options)=>{
        calls.push({url,body:JSON.parse(options.body)});
        return url.endsWith('/comments')?ok({id:'mention-public-id'}):ok({message_id:'mention-private-id'});
      }});
      await worker.tick();
      assert.deepEqual(calls[0].body,{message:'@[444444444444] '+publicText});
      assert.ok(calls[0].url.endsWith('/'+newId+'/comments'));
      await worker.tick();
      assert.deepEqual(calls[1].body,{recipient:{comment_id:newId},message:{text:dmText}});
      assert.equal(facebook.enqueue(config,[entry(newId)]),0);
      await worker.tick(); assert.equal(calls.length,2);
      assert.equal(facebook.report(owner.id).rules[0].public_text,template);
    });
    await t.test('Cada comentario conserva su propio autor y texto al reabrir la cola',()=>{
      now+=1000;
      facebook.enqueue(config,[entry('123456789012345_987654321012350',{from:{id:'555555555555'}}),
        entry('123456789012345_987654321012351',{from:{id:'666666666666'}})]);
      const reopened=openFacebookAutomation(path,{now:()=>now});
      try {
        const first=reopened.claim(config);
        assert.equal(first.public_text,'@[555555555555] '+publicText);
        reopened.fail(first,false,'Prueba local');
        const second=reopened.claim(config);
        assert.equal(second.public_text,'@[666666666666] '+publicText);
        reopened.fail(second,false,'Prueba local');
      }finally{reopened.close();}
    });
    await t.test('No publica etiquetas con identidad mal formada ni textos expandidos excesivos',()=>{
      assert.equal(renderFacebookReply(publicText,{from:{id:'bad'}}),publicText);
      assert.equal(renderFacebookReply('{autor} Hola',{from:{id:'bad'}}),null);
      assert.equal(facebook.enqueue(config,[entry('123456789012345_987654321012352',{from:{id:'123] texto'}})]),0);
      now+=1000; facebook.enable(config,postId,'{autor} '+'x'.repeat(991),dmText); now+=1000;
      assert.equal(facebook.enqueue(config,[entry('123456789012345_987654321012353')]),0);
    });
  }finally{server.close();facebook.close();instagram.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
