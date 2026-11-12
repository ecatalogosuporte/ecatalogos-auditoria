/* eCatalogos Auditoria — acesso autenticado. */
import { openLocalStore, migrateLocalProjects } from './storage.js';
import { CloudStore, MAX_IMAGE_BYTES } from './cloud-store.js';
import { cloudClient, authMessage } from './auth.js';
import { loginEmail, displayLogin, isStudioLogin } from './login-identity.js';
'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = v => String(v || 'produto').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'produto';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+'-'+Math.random().toString(36).slice(2));
const state = {db:null,local:null,session:null,ready:false,initialized:false,recovery:false,authMode:'login',projects:[],pairs:[],projectId:null,editing:null,modalBlobs:{before:null,after:null},pasteSlot:null,modalURLs:[],cardURLs:[],reviewURLs:[],reviewFilter:"all",busy:false,toastTimer:null};
const mimeFor = n => ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[(n.split('.').pop()||'').toLowerCase()] || 'application/octet-stream');
const isImage = f => !!f && (/^image\/(png|jpeg|webp|gif)$/i.test(f.type)||/\.(png|jpe?g|webp|gif)$/i.test(f.name||''));
const extFor = (blob,name) => {const from=(name||'').split('.').pop().toLowerCase();return ['png','jpg','jpeg','webp','gif'].includes(from)?from:({'image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[blob?.type]||'png');};
const all=store=>state.db.all(store);
const put=(store,record)=>state.db.put(store,record);
const del=(store,id)=>state.db.del(store,id);
const projectStorageKey=()=>state.session?`ec-studio-project-${state.session.user.id}`:'ec-studio-project';
const canUseStudio=()=>Boolean(state.session&&state.ready&&state.db);
const current=()=>state.projects.find(p=>p.id===state.projectId);
function toast(message,error=false){const el=$('toast');el.textContent=message;el.style.background=error?'#a0443f':'#153f64';el.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove('show'),3800);}
function busy(on,label='Processando arquivos...'){state.busy=on;$('pairForm').inert=on;$('closeModal').disabled=on;$('cancelModal').disabled=on;$('studioShell').inert=on||!canUseStudio();$('reviewView').inert=on||!canUseStudio();['exportAll','downloadBackup','bulkImport','newPair','uploadBackup','savePair'].forEach(id=>$(id).disabled=on);const notice=$('notice');notice.hidden=!on;if(on)notice.textContent=label;}
async function run(task,label='Salvando alterações...'){if(state.busy)return;if(!canUseStudio())return toast('Entre na sua conta para acessar o eCatalogos Auditoria.',true);busy(true,label);try{return await task();}catch(error){toast(error.message,true);}finally{busy(false);}}
function download(blob,name){if(!canUseStudio())return;const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),45000);}
function objectURL(blob,collector){if(!blob)return null;const u=URL.createObjectURL(blob);collector.push(u);return u;}
function clearUrls(key){state[key].forEach(u=>URL.revokeObjectURL(u));state[key]=[];}
async function refresh(){
 if(!state.session||!state.db)throw new Error('Entre na sua conta para acessar o eCatalogos Auditoria.');
 const store=state.db,userId=state.session.user.id;
 const active=()=>state.db===store&&state.session?.user.id===userId;
 const projects=(await store.all('projects')).sort((a,b)=>a.created-b.created);
 if(!active())return;
 if(!projects.length){const p={id:uid(),name:'Minha primeira coleção',created:Date.now()};await store.put('projects',p);projects.push(p);}
 if(!active())return;
 const projectId=projects.some(p=>p.id===state.projectId)?state.projectId:projects[0].id;
 const pairs=(await store.getPairs(projectId)).sort((a,b)=>a.order-b.order||a.created-b.created);
 if(!active())return;
 state.projects=projects;state.projectId=projectId;state.pairs=pairs;
 try{localStorage.setItem(projectStorageKey(),projectId);}catch{}
 render();if(!$('reviewView').hidden)renderReview();
}
function render(){if(!state.session)return;const p=current();$('projectTitle').textContent=p?.name||'Comparativos';const ready=state.pairs.filter(p=>p.beforeBlob&&p.afterBlob).length;$('countPairs').textContent=state.pairs.length;$('countReady').textContent=ready;$('countPending').textContent=state.pairs.length-ready;$('galleryCount').textContent=`(${state.pairs.length})`;
 $('projectList').innerHTML=state.projects.map(pr=>`<button class="project ${pr.id===state.projectId?'active':''}" data-project="${esc(pr.id)}"><span class="folder">▱</span><span class="project-name" title="${esc(pr.name)}">${esc(pr.name)}</span><span class="project-count">${pr.id===state.projectId?state.pairs.length:''}</span></button>`).join('');
 clearUrls('cardURLs');const search=$('search').value.trim().toLocaleLowerCase();const shown=state.pairs.filter(pr=>pr.name.toLocaleLowerCase().includes(search));
 if(!shown.length){$('gallery').innerHTML=state.pairs.length?`<div class="empty-state"><div class="empty-art"><span></span><span></span></div><h3>Nenhum produto encontrado</h3><p>Tente buscar outro nome para localizar seu comparativo.</p></div>`:`<div class="empty-state"><div class="empty-art"><span></span><span></span></div><h3>Sua galeria começa aqui</h3><p>Adicione um par de imagens ou importe um lote de arquivos nomeados com _antes e _depois. Tudo ficará organizado neste projeto.</p><button class="button primary" data-action="new">＋ Adicionar primeiro comparativo</button></div>`;return;}
 $('gallery').innerHTML=shown.map(pr=>{const position=state.pairs.indexOf(pr),ok=pr.beforeBlob&&pr.afterBlob;const before=objectURL(pr.beforeBlob,state.cardURLs),after=objectURL(pr.afterBlob,state.cardURLs);
 return `<article class="pair-card" data-id="${esc(pr.id)}"><div class="pair-heading"><div class="heading-left"><span class="pair-no">${String(position+1).padStart(2,'0')}</span><span class="pair-name" title="${esc(pr.name)}">${esc(pr.name)}</span></div><div class="heading-right"><span class="status ${ok?'ready':'pending'}">${ok?'PRONTO PARA EXPORTAR':'AGUARDANDO IMAGEM'}</span><span class="card-meta">Layout antes/depois — 1068 × 1473 px</span></div></div><div class="comparison"><div class="comparison-col"><h3>ANTES</h3><div class="compare-image ${before?'':'empty'}">${before?`<img src="${before}" alt="Antes: ${esc(pr.name)}">`:'<b>＋</b><span>Sem imagem original</span>'}</div><button type="button" class="card-btn original-download" data-action="download-before" ${before?'':'disabled'}>⇩ Baixar antes</button></div><div class="comparison-col"><h3>DEPOIS</h3><div class="compare-image ${after?'':'empty'}">${after?`<img src="${after}" alt="Depois: ${esc(pr.name)}">`:'<b>＋</b><span>Sem imagem modificada</span>'}</div><button type="button" class="card-btn original-download" data-action="download-after" ${after?'':'disabled'}>⇩ Baixar depois</button></div></div><div class="pair-note">Imagens ajustadas sem distorção. Exporte o comparativo quando as duas estiverem prontas.</div><div class="pair-footer"><div class="pair-footer-left"><button class="card-btn" data-action="up" title="Mover para cima" ${position===0?'disabled':''}>↑ Subir</button><button class="card-btn" data-action="down" title="Mover para baixo" ${position===state.pairs.length-1?'disabled':''}>↓ Descer</button><button class="card-btn" data-action="edit">✎ Editar</button></div><div class="pair-footer-right"><button class="card-btn danger" data-action="delete" title="Excluir">Excluir</button><button class="card-btn export" data-action="download" ${ok?'':'disabled'}>⇩ PNG</button></div></div></article>`;}).join('');}
async function newProject(name){const p={id:uid(),name:name.slice(0,200),created:Date.now()};await put('projects',p);state.projectId=p.id;$('search').value='';await refresh();toast('Novo projeto criado.');}
async function chooseProject(id){if(!state.projects.find(p=>p.id===id))return;state.projectId=id;$('search').value='';$('sidebar').classList.remove('open');await refresh();}
async function deleteProject(){const p=current();if(!p)return;if(!confirm(`Excluir o projeto “${p.name}” e TODOS os seus ${state.pairs.length} comparativos?\n\nRecomendamos baixar um backup antes.`))return;await del('projects',p.id);state.projectId=null;await refresh();toast('Projeto excluído.');}
async function renameProject(){const p=current();if(!p)return;const name=prompt('Nome do projeto:',p.name);if(name===null)return;const cleaned=name.trim().slice(0,200);if(!cleaned)return toast('O nome não pode ficar vazio.',true);await put('projects',{...p,name:cleaned});await refresh();toast('Projeto renomeado.');}
function modalUpdate(slot){const blob=state.modalBlobs[slot],img=$(slot==='before'?'beforePreview':'afterPreview'),zone=$(slot==='before'?'beforeZone':'afterZone');const clr=$(slot==='before'?'clearBefore':'clearAfter');const placeholder=zone.querySelector('.zone-placeholder');if(blob){const u=objectURL(blob,state.modalURLs);img.src=u;img.hidden=false;placeholder.hidden=true;clr.hidden=false;}else{img.removeAttribute('src');img.hidden=true;placeholder.hidden=false;clr.hidden=true;}}
async function showModal(id=null){if(!canUseStudio())return;clearUrls('modalURLs');state.editing=id;const row=id?state.pairs.find(p=>p.id===id):null;state.modalBlobs={before:row?.beforeBlob||null,after:row?.afterBlob||null};$('dialogTitle').textContent=row?'Editar comparativo':'Novo comparativo';$('productName').value=row?.name||'';$('savePair').textContent=row?'Salvar alterações':'Salvar comparativo';['before','after'].forEach(modalUpdate);selectPasteSlot(null);$('modal').hidden=false;document.body.style.overflow='hidden';setTimeout(()=>$('productName').focus(),30);}
function closeModal(){if($('modal').hidden)return;$('modal').hidden=true;document.body.style.overflow='';clearUrls('modalURLs');state.editing=null;selectPasteSlot(null);}
function selectPasteSlot(slot){
 state.pasteSlot=slot;
 for(const name of ['before','after'])$(name+'Zone').classList.toggle('paste-target',slot===name);
}
function slotFile(slot,file){
 if(!isImage(file)){toast('Use uma imagem JPG, PNG, WebP ou GIF.',true);return false;}
 if(state.session&&file.size>MAX_IMAGE_BYTES){toast('Cada imagem pode ter até 20 MB para salvar na nuvem.',true);return false;}
 state.modalBlobs[slot]=file;selectPasteSlot(slot);clearUrls('modalURLs');['before','after'].forEach(modalUpdate);return true;
}
function pasteImage(event){
 if(!canUseStudio()||state.busy||$('modal').hidden)return;
 const clipboard=event.clipboardData;
 if(!clipboard)return;
 // Text copied into the product name should keep the browser's normal behavior.
 if(event.target.closest('input,textarea,[contenteditable]')&&clipboard.getData('text/plain')&&!state.pasteSlot)return;
 const files=Array.from(clipboard.files||[]);
 const image=files.find(file=>isImage(file)||file.type.startsWith('image/'))||
  Array.from(clipboard.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).find(Boolean);
 if(!image)return;
 event.preventDefault();
 const slot=state.pasteSlot||event.target.closest('[data-slot]')?.dataset.slot||(!state.modalBlobs.before?'before':!state.modalBlobs.after?'after':'before');
 const name=image.name||`imagem_${slot==='before'?'antes':'depois'}.${extFor(image,'')}`;
 const file=new File([image],name,{type:image.type||mimeFor(name)});
 if(slotFile(slot,file))toast(`Imagem colada em “${slot==='before'?'Antes':'Depois'}”.`);
}

async function savePair(e){e.preventDefault();const name=$('productName').value.trim();if(!name)return toast('Informe o nome do produto.',true);if(!state.modalBlobs.before&&!state.modalBlobs.after)return toast('Adicione pelo menos uma imagem.',true);const old=state.editing?state.pairs.find(p=>p.id===state.editing):null;
 const record={id:old?.id||uid(),projectId:state.projectId,name,order:old?.order??(state.pairs.length?Math.max(...state.pairs.map(p=>p.order))+1:0),created:old?.created||Date.now(),beforeBlob:state.modalBlobs.before,afterBlob:state.modalBlobs.after,beforeName:state.modalBlobs.before?.name||old?.beforeName||'',afterName:state.modalBlobs.after?.name||old?.afterName||'',reviewStatus:old&&state.modalBlobs.before===old.beforeBlob&&state.modalBlobs.after===old.afterBlob?(old.reviewStatus||null):null,reviewedAt:old&&state.modalBlobs.before===old.beforeBlob&&state.modalBlobs.after===old.afterBlob?(old.reviewedAt||null):null};
 await put('pairs',record);closeModal();await refresh();toast(old?'Comparativo atualizado.':'Comparativo adicionado.');}
async function deletePair(id){const p=state.pairs.find(p=>p.id===id);if(!p||!confirm(`Excluir “${p.name}”?`))return;await del('pairs',id);await refresh();toast('Comparativo excluído.');}
async function movePair(id,delta){const idx=state.pairs.findIndex(p=>p.id===id);const j=idx+delta;if(idx<0||j<0||j>=state.pairs.length)return;await state.db.movePairs(id,state.pairs[j].id);await refresh();}
function canvasText(ctx,text,maxWidth,x,y,maxSize=36){let size=maxSize;ctx.font=`800 ${size}px Arial,sans-serif`;while(size>19&&ctx.measureText(text).width>maxWidth){size-=1;ctx.font=`800 ${size}px Arial,sans-serif`;}ctx.fillText(text,x,y);}
async function loadImage(blob){const u=URL.createObjectURL(blob);try{const im=new Image();im.decoding='async';im.src=u;await im.decode();return im;}finally{URL.revokeObjectURL(u);}}
async function comparisonPNG(row,number){const w=1068,h=1473,c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.fillStyle='#192e31';ctx.textAlign='left';canvasText(ctx,`${String(number).padStart(2,'0')}  ${row.name.toLocaleUpperCase('pt-BR')}`,w-70,38,81,35);
 const xs=[26,539],cw=503,top=219,bottom=1347,ch=bottom-top;ctx.textAlign='center';ctx.font='800 36px Arial,sans-serif';ctx.fillText('ANTES',xs[0]+cw/2,168);ctx.fillText('DEPOIS',xs[1]+cw/2,168);ctx.strokeStyle='#e2e6e6';ctx.lineWidth=2;xs.forEach(x=>ctx.strokeRect(x,top,cw,ch));
 for(const [i,blob] of [row.beforeBlob,row.afterBlob].entries()){if(!blob)continue;const im=await loadImage(blob),pad=4,iw=cw-pad*2,ih=ch-pad*2;const scale=Math.min(iw/im.naturalWidth,ih/im.naturalHeight);const dw=im.naturalWidth*scale,dh=im.naturalHeight*scale;ctx.imageSmoothingQuality='high';ctx.drawImage(im,xs[i]+(cw-dw)/2,top+(ch-dh)/2,dw,dh);}ctx.textAlign='center';ctx.fillStyle='#a4b1b1';ctx.font='16px Arial,sans-serif';ctx.fillText('eCatalogos Auditoria  ·  Comparativos de imagens',w/2,1422);
 return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('Não foi possível criar o PNG.')),'image/png'));}
function crcTable(){const arr=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;arr[n]=c>>>0;}return arr;}
const CRC_TABLE=crcTable();function crc32(u){let c=0xffffffff;for(const b of u)c=CRC_TABLE[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function zipBytes(files){const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;for(const f of files){const name=enc.encode(f.name),data=f.bytes,crc=crc32(data),local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint16(8,0,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.byteLength,true);lv.setUint32(22,data.byteLength,true);lv.setUint16(26,name.length,true);local.set(name,30);locals.push(local,data);
 const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(10,0,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.byteLength,true);cv.setUint32(24,data.byteLength,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);central.set(name,46);centrals.push(central);offset+=local.length+data.byteLength;}
 const cds=centrals.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,cds,true);v.setUint32(16,offset,true);return new Blob([...locals,...centrals,end],{type:'application/zip'});}
async function makeZip(files){const items=[];for(const item of files)items.push({name:item.name,bytes:new Uint8Array(await item.blob.arrayBuffer())});return zipBytes(items);}
function downloadOriginal(id,slot) {
 if(!canUseStudio()||!['before','after'].includes(slot))return;
 const row=state.pairs.find(pair=>pair.id===id),blob=row?.[slot+'Blob'];
 if(!blob)return toast('Essa imagem ainda não foi adicionada.',true);
 const originalName=String(row[slot+'Name']||'').split(/[\\/]/).pop();
 const label=slot==='before'?'antes':'depois';
 download(blob,originalName||`${slug(row.name)}_${label}.${extFor(blob,'')}`);
 toast(`Imagem “${label}” baixada no formato original.`);
}
async function exportOne(id){if(!canUseStudio())return;const row=state.pairs.find(p=>p.id===id);if(!row?.beforeBlob||!row?.afterBlob)return toast('Este comparativo precisa das duas imagens.',true);busy(true,'Preparando imagem 1068 × 1473...');try{const blob=await comparisonPNG(row,state.pairs.indexOf(row)+1);download(blob,`${String(state.pairs.indexOf(row)+1).padStart(2,'0')}_${slug(row.name)}_antes-depois_1068x1473.png`);toast('PNG exportado com sucesso.');}catch(e){toast('Não foi possível exportar: '+e.message,true);}finally{busy(false);}}
async function exportAll(){if(!canUseStudio())return;const ready=state.pairs.filter(p=>p.beforeBlob&&p.afterBlob);if(!ready.length)return toast('Adicione pelo menos um par completo para exportar.',true);busy(true,`Preparando 0 de ${ready.length} imagens...`);try{const items=[];for(let i=0;i<ready.length;i++){const row=ready[i],num=state.pairs.indexOf(row)+1; $('notice').textContent=`Gerando comparativo ${i+1} de ${ready.length} (1068 × 1473 px)...`;items.push({name:`comparativos/${String(num).padStart(2,'0')}_${slug(row.name)}_antes-depois.png`,blob:await comparisonPNG(row,num)});await new Promise(r=>setTimeout(r,0));}items.push({name:'LEIA-ME.txt',blob:new Blob(['eCatalogos Auditoria\nFormato de cada PNG: 1068 x 1473 pixels\nProjeto: '+current().name+'\n'],{type:'text/plain'})});$('notice').textContent='Montando arquivo ZIP...';download(await makeZip(items),`${slug(current().name)}_comparativos.zip`);toast(`${ready.length} comparativos exportados em ZIP.`);}catch(e){toast('Falha na exportação: '+e.message,true);}finally{busy(false);}}
async function exportBackup(){if(!canUseStudio())return;if(!state.pairs.length)return toast('Adicione algum produto antes de criar um backup.',true);busy(true,'Preparando backup com as imagens originais...');try{const files=[],manifest={kind:'ecatalogos-image-studio',appName:'eCatalogos Auditoria',version:2,projectName:current().name,exportedAt:new Date().toISOString(),items:[]};for(const [index,p] of state.pairs.entries()){const id=String(index+1).padStart(3,'0'),it={name:p.name,order:index,before:null,after:null,reviewStatus:p.reviewStatus||null,reviewedAt:p.reviewedAt||null};for(const slot of ['before','after']){const blob=p[slot+'Blob'];if(!blob)continue;const path=`imagens/${id}_${slot==='before'?'antes':'depois'}.${extFor(blob,p[slot+'Name'])}`;files.push({name:path,blob});it[slot]=path;}manifest.items.push(it);}files.unshift({name:'projeto.json',blob:new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})});download(await makeZip(files),`${slug(current().name)}_backup.ecproj`);toast('Backup salvo. Guarde o arquivo para recuperar seu trabalho.');}catch(e){toast('Não foi possível exportar o backup: '+e.message,true);}finally{busy(false);}}
async function readZip(file){const array=await file.arrayBuffer(),data=new Uint8Array(array),v=new DataView(array),dec=new TextDecoder();let end=-1;for(let i=array.byteLength-22;i>=Math.max(0,array.byteLength-65557);i--){if(v.getUint32(i,true)===0x06054b50){end=i;break;}}if(end<0)throw Error('ZIP inválido ou incompleto.');const count=v.getUint16(end+10,true),start=v.getUint32(end+16,true),entries=[];let pos=start;for(let i=0;i<count;i++){if(v.getUint32(pos,true)!==0x02014b50)throw Error('Diretório ZIP inválido.');const method=v.getUint16(pos+10,true),size=v.getUint32(pos+20,true),nl=v.getUint16(pos+28,true),el=v.getUint16(pos+30,true),cl=v.getUint16(pos+32,true),offset=v.getUint32(pos+42,true),name=dec.decode(data.subarray(pos+46,pos+46+nl));pos+=46+nl+el+cl;if(name.endsWith('/'))continue;entries.push({name,method,size,offset});}if(entries.length>1500)throw Error('O ZIP contém arquivos demais.');const map=new Map();for(const e of entries){const lp=e.offset;if(v.getUint32(lp,true)!==0x04034b50)throw Error('Arquivo ZIP com cabeçalho inválido.');const p=lp+30+v.getUint16(lp+26,true)+v.getUint16(lp+28,true),payload=data.slice(p,p+e.size);let blob;if(e.method===0)blob=new Blob([payload]);else if(e.method===8){if(typeof DecompressionStream==='undefined')throw Error('Atualize para Chrome/Edge para importar ZIPs compactados.');const stream=new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));blob=await new Response(stream).blob();}else throw Error('Método de ZIP não suportado: '+e.method);map.set(e.name,blob);}return map;}
function parseFileName(filename){const n=(filename.split('/').pop()||'').replace(/\.[^.]+$/,'');let normal=n.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\s.-]+/g,'_');const match=normal.match(/^(.*?)_?(antes|depois|before|after|original|editada|editado)$/);if(!match||!match[1])return null;const slot=['antes','before','original'].includes(match[2])?'before':'after';const key=match[1].replace(/_+$/,'');if(!key)return null;const title=/^\d+$/.test(key)?`Produto ${key}`:key.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());return {key,slot,title};}
async function importPairsFromFiles(files,{projectName=null,names=[]}={}){const matched=new Map();let ignored=0;for(const file of files){if(!isImage(file)){ignored++;continue;}const info=parseFileName(file.name);if(!info){ignored++;continue;}if(!matched.has(info.key))matched.set(info.key,{name:info.title,before:null,after:null});matched.get(info.key)[info.slot]=file;}
 if(!matched.size)throw Error('Nenhuma imagem com “_antes” ou “_depois” no nome foi encontrada.');if(projectName){const p={id:uid(),name:String(projectName).slice(0,200),created:Date.now()};await put('projects',p);state.projectId=p.id;}
 let n=0,base=state.pairs.length?Math.max(...state.pairs.map(p=>p.order))+1:0;for(const [key,item] of matched){const num=parseInt(key,10);const title=Number.isInteger(num)&&num>0&&num<=names.length?names[num-1]:item.name;await put('pairs',{id:uid(),projectId:state.projectId,created:Date.now()+n,order:base+n,name:String(title).slice(0,200),beforeBlob:item.before,afterBlob:item.after,beforeName:item.before?.name||'',afterName:item.after?.name||''});n++;}await refresh();toast(`${n} comparativo(s) importado(s).${ignored?' '+ignored+' arquivo(s) ignorado(s).':''}`);}
async function importArchive(file){const entries=await readZip(file);const lookup=name=>entries.get(name)||entries.get([...entries.keys()].find(k=>k.endsWith('/'+name)));let manifest=null;for(const [name,blob] of entries){if(name==='projeto.json'||name.endsWith('/projeto.json')){try{manifest=JSON.parse(await blob.text());}catch{}break;}}
 if(manifest?.kind==='ecatalogos-image-studio'&&Array.isArray(manifest.items)){const p={id:uid(),name:String(manifest.projectName||file.name.replace(/\.(zip|ecproj)$/i,'')).slice(0,200),created:Date.now()};await put('projects',p);state.projectId=p.id;let i=0;for(const item of manifest.items){const bef=item.before?lookup(item.before):null,aft=item.after?lookup(item.after):null;const bname=item.before?.split('/').pop()||'',aname=item.after?.split('/').pop()||'';await put('pairs',{id:uid(),projectId:p.id,name:String(item.name||`Produto ${i+1}`).slice(0,200),order:i,created:Date.now()+i,beforeBlob:bef?new File([bef],bname,{type:mimeFor(bname)}):null,afterBlob:aft?new File([aft],aname,{type:mimeFor(aname)}):null,beforeName:bname,afterName:aname,reviewStatus:['approved','rejected'].includes(item.reviewStatus)?item.reviewStatus:null,reviewedAt:item.reviewedAt||null});i++;}await refresh();toast(`Backup restaurado: ${i} comparativos.`);return;}
 let names=[];for(const [name,blob] of entries){if(name.endsWith('manifest.json')){try{names=JSON.parse(await blob.text()).names||[];}catch{}break;}}
 const imageFiles=[];for(const [name,blob] of entries){if(!/\.(png|jpg|jpeg|webp|gif)$/i.test(name))continue;const only=name.split('/').pop();imageFiles.push(new File([blob],only,{type:mimeFor(name)}));}
 await importPairsFromFiles(imageFiles,{projectName:file.name.replace(/\.(zip|ecproj)$/i,'').replace(/[_-]+/g,' '),names});}
async function handleBulk(fileList){if(!canUseStudio())return;const fs=Array.from(fileList||[]);if(!fs.length)return;busy(true,`Importando ${fs.length} arquivo(s)...`);try{const archives=fs.filter(f=>/\.(zip|ecproj)$/i.test(f.name));for(const a of archives){$('notice').textContent=`Lendo ${a.name}...`;await importArchive(a);}const images=fs.filter(isImage);if(images.length)await importPairsFromFiles(images);}catch(e){await refresh().catch(()=>{});toast('Importação interrompida. Os itens já salvos foram mantidos: '+e.message,true);}finally{busy(false);}}

function setView(view){
  if(!canUseStudio()){$('studioShell').hidden=true;$('reviewView').hidden=true;return;}
  const review=view==='review';
  $('studioShell').hidden=review;
  $('reviewView').hidden=!review;
  if(review){renderReview();}
  else{clearUrls('reviewURLs');}
  window.scrollTo(0,0);
}
function navigateToReview(){if(location.hash!=='#revisao')location.hash='revisao';else setView('review');}
function navigateToStudio(){if(location.hash==='#revisao')location.hash='';else setView('studio');}
function syncViewFromHash(){if(!state.ready)return;setView(location.hash==='#revisao'?'review':'studio');}
function reviewCounts(){
 const approved=state.pairs.filter(p=>p.reviewStatus==='approved').length;
 const rejected=state.pairs.filter(p=>p.reviewStatus==='rejected').length;
 return {approved,rejected,pending:state.pairs.length-approved-rejected};
}
function renderReviewSummary(){
 const n=reviewCounts();
 $('reviewDescription').textContent=`${state.pairs.length} comparaç${state.pairs.length===1?'ão':'ões'} de produtos — ${current()?.name||'Coleção'}.`;
 $('reviewSummary').innerHTML=`<span><strong>${state.pairs.length}</strong> produtos</span><span><strong>${n.approved}</strong> aprovados</span><span><strong>${n.rejected}</strong> reprovados</span><span><strong>${n.pending}</strong> não avaliados</span>`;
}
function reviewLabel(status){return status==='approved'?'✓ Aprovado':status==='rejected'?'✕ Reprovado':'Aguardando avaliação';}
function renderReview(){
 if(!canUseStudio())return;
 renderReviewSummary();
 clearUrls('reviewURLs');
 const filtered=state.pairs.filter(p=>state.reviewFilter==='all'||(state.reviewFilter==='pending'?!['approved','rejected'].includes(p.reviewStatus):p.reviewStatus===state.reviewFilter));
 if(!filtered.length){
  $('reviewCards').innerHTML=state.pairs.length?'<div class="review-empty"><h2>Nenhum comparativo neste filtro</h2><p>Selecione “Todas” para rever as imagens desta coleção.</p></div>':'<div class="review-empty"><h2>Nenhum comparativo ainda</h2><p>Volte à Auditoria e adicione suas imagens “antes” e “depois”. Depois, retorne aqui para aprovar ou reprovar.</p><button type="button" class="review-back" id="reviewEmptyBack">Voltar à Auditoria</button></div>';
  return;
 }
 $('reviewCards').innerHTML=filtered.map(pr=>{
   const index=state.pairs.indexOf(pr);
   const before=objectURL(pr.beforeBlob,state.reviewURLs);
   const after=objectURL(pr.afterBlob,state.reviewURLs);
   const ready=Boolean(before&&after);
   const status=pr.reviewStatus||'pending';
   return `<section class="review-pair" data-id="${esc(pr.id)}">
     <div class="review-pair-heading"><span class="review-num">${String(index+1).padStart(2,'0')}</span><span>${esc(pr.name)}</span></div>
     <div class="review-photo-grid">
       <div><h3>ANTES</h3><div class="review-photo">${before?`<img loading="lazy" decoding="async" src="${before}" alt="Imagem original: ${esc(pr.name)}">`:'<span class="review-photo-missing">Imagem original não adicionada</span>'}</div><button type="button" class="card-btn original-download" data-download="before" ${before?'':'disabled'}>⇩ Baixar antes</button></div>
       <div><h3>DEPOIS</h3><div class="review-photo">${after?`<img loading="lazy" decoding="async" src="${after}" alt="Imagem modificada: ${esc(pr.name)}">`:'<span class="review-photo-missing">Imagem modificada não adicionada</span>'}</div><button type="button" class="card-btn original-download" data-download="after" ${after?'':'disabled'}>⇩ Baixar depois</button></div>
     </div>
     <div class="review-actions">
       <div class="review-decision" data-status="${esc(status)}" aria-live="polite">${reviewLabel(status)}</div>
       <div class="review-buttons">
         <button type="button" class="review-choice approve ${status==='approved'?'is-selected':''}" data-choice="approved" aria-pressed="${status==='approved'}" ${ready?'':'disabled title="É necessário ter as duas imagens para avaliar"'}>✓ Aprovar</button>
         <button type="button" class="review-choice reject ${status==='rejected'?'is-selected':''}" data-choice="rejected" aria-pressed="${status==='rejected'}" ${ready?'':'disabled title="É necessário ter as duas imagens para avaliar"'}>✕ Reprovar</button>
       </div>
     </div>
   </section>`;
 }).join('');
}
async function setReviewDecision(id,status){
 const row=state.pairs.find(p=>p.id===id);
 if(!row||!row.beforeBlob||!row.afterBlob)return;
 const previous=row.reviewStatus||null,previousDate=row.reviewedAt||null;
 row.reviewStatus=previous===status?null:status;
 row.reviewedAt=row.reviewStatus?new Date().toISOString():null;
 try{
  await put('pairs',row);
  const card=Array.from($('reviewCards').querySelectorAll('.review-pair')).find(el=>el.dataset.id===id);
  if(card){
   const flag=card.querySelector('.review-decision');flag.dataset.status=row.reviewStatus||'pending';flag.textContent=reviewLabel(row.reviewStatus);
   for(const b of card.querySelectorAll('[data-choice]')){const active=b.dataset.choice===row.reviewStatus;b.classList.toggle('is-selected',active);b.setAttribute('aria-pressed',String(active));}
  }
  renderReviewSummary();
  if(state.reviewFilter!=='all')renderReview();
  toast(row.reviewStatus==='approved'?'Comparativo aprovado.':row.reviewStatus==='rejected'?'Comparativo reprovado.':'Avaliação removida.');
 }catch(e){row.reviewStatus=previous;row.reviewedAt=previousDate;toast('Não foi possível salvar sua avaliação.',true);renderReview();}
}

function hook(){
 $('addProject').onclick=()=>{const name=prompt('Nome da nova coleção:',`Coleção ${state.projects.length+1}`);if(name?.trim())run(()=>newProject(name.trim()));};$('renameProject').onclick=()=>run(renameProject);$('deleteProject').onclick=()=>run(deleteProject);$('toggleSidebar').onclick=()=>$('sidebar').classList.toggle('open');
 $('openReview').onclick=navigateToReview; $('reviewSidebar').onclick=navigateToReview; $('backToStudio').onclick=navigateToStudio;window.addEventListener('hashchange',syncViewFromHash);
 $('reviewCards').addEventListener('click',e=>{if(!canUseStudio()||state.busy)return;const original=e.target.closest('[data-download]');if(original)return downloadOriginal(original.closest('.review-pair').dataset.id,original.dataset.download);if(e.target.closest('#reviewEmptyBack'))return navigateToStudio();const btn=e.target.closest('[data-choice]');const id=btn?.closest('.review-pair')?.dataset.id;if(btn&&id)run(()=>setReviewDecision(id,btn.dataset.choice));});
 $('reviewFilter').addEventListener('change',e=>{state.reviewFilter=e.target.value;renderReview();});
 $('projectList').onclick=e=>{const el=e.target.closest('[data-project]');if(el)run(()=>chooseProject(el.dataset.project),'Carregando projeto...');};$('search').addEventListener('input',render);
 $('newPair').onclick=()=>showModal();$('bulkImport').onclick=()=>$('bulkFiles').click();$('exportAll').onclick=exportAll;$('downloadBackup').onclick=exportBackup;$('uploadBackup').onclick=()=>$('archiveFile').click();$('printGallery').onclick=()=>window.print();
 $('gallery').onclick=async e=>{const el=e.target.closest('[data-action]');if(!el||state.busy||!canUseStudio())return;const action=el.dataset.action,id=el.closest('[data-id]')?.dataset.id;if(action==='new')return showModal();if(action==='edit')return showModal(id);if(action==='delete')return run(()=>deletePair(id));if(action==='download')return exportOne(id);if(action==='download-before'||action==='download-after')return downloadOriginal(id,action.slice('download-'.length));if(action==='up'||action==='down')return run(()=>movePair(id,action==='up'?-1:1));};
 $('closeModal').onclick=closeModal;$('cancelModal').onclick=closeModal;$('modal').addEventListener('click',e=>{if(e.target===$('modal')&&!state.busy)closeModal();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!state.busy)closeModal();});$('pairForm').addEventListener('submit',e=>{e.preventDefault();run(()=>savePair(e));});
 document.addEventListener('paste',pasteImage);$('productName').onfocus=()=>selectPasteSlot(null);
 for(const slot of ['before','after']){
  const zone=$(slot+'Zone'),input=$(slot+'File');
  zone.onfocus=()=>selectPasteSlot(slot);
  zone.onclick=e=>{if(e.target.closest('.choose-image'))return;selectPasteSlot(slot);zone.focus();};
  zone.onkeydown=e=>{if(e.target===zone&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectPasteSlot(slot);zone.focus();}};
  $(slot+'Choose').onclick=e=>{e.stopPropagation();selectPasteSlot(slot);input.click();};
  input.onchange=()=>{if(input.files?.[0])slotFile(slot,input.files[0]);input.value='';};
  zone.ondragover=e=>{e.preventDefault();zone.classList.add('dragover');};
  zone.ondragleave=()=>zone.classList.remove('dragover');
  zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragover');if(e.dataTransfer.files?.[0])slotFile(slot,e.dataTransfer.files[0]);};
  $(slot==='before'?'clearBefore':'clearAfter').onclick=()=>{state.modalBlobs[slot]=null;selectPasteSlot(slot);clearUrls('modalURLs');['before','after'].forEach(modalUpdate);};
 }
 $('bulkFiles').onchange=async e=>{await handleBulk(e.target.files);e.target.value='';};$('archiveFile').onchange=async e=>{await handleBulk(e.target.files);e.target.value='';};
}
function storageUI() {
 const cloud=Boolean(state.session);
 $('storageStatus').textContent=cloud?'Salvo na nuvem':'Login necessário';
 $('storageLabel').textContent='Projetos na sua conta';
 $('storageDescription').textContent='Imagens e aprovações salvas na sua conta. Acesse com o mesmo login em outro dispositivo.';
 $('openAuth').hidden=true;$('signOut').hidden=!cloud;$('refreshCloud').hidden=!cloud;
 $('accountEmail').hidden=!cloud;
 $('accountEmail').textContent=displayLogin(state.session?.user.email);
 $('migrateLocal').hidden=!cloud||!state.local;
}

function lockStudio() {
 state.ready=false;state.db=null;
 $('studioShell').hidden=true;$('reviewView').hidden=true;
 $('studioShell').inert=true;$('reviewView').inert=true;
 document.body.classList.add('auth-required');
 closeModal();
 ['cardURLs','reviewURLs','modalURLs'].forEach(clearUrls);
 state.projects=[];state.pairs=[];state.projectId=null;state.modalBlobs={before:null,after:null};
 $('projectList').replaceChildren();$('gallery').replaceChildren();$('reviewCards').replaceChildren();
 $('reviewSummary').replaceChildren();$('projectTitle').textContent='Comparativos';
 ['countPairs','countReady','countPending'].forEach(id=>$(id).textContent='0');
 $('galleryCount').textContent='(0)';$('search').value='';$('authEmail').value='';$('authPassword').value='';
 $('beforePreview').removeAttribute('src');$('afterPreview').removeAttribute('src');
 ['beforeFile','afterFile','bulkFiles','archiveFile'].forEach(id=>$(id).value='');
}

function showGateError(message) {
 $('authModal').hidden=false;$('closeAuth').hidden=true;
 $('authTitle').textContent='Não foi possível abrir o eCatalogos Auditoria.';
 $('authIntro').textContent=message;
 $('authForm').hidden=true;$('authTabs').hidden=true;
 $('retryAuth').hidden=false;$('gateSignOut').hidden=!state.session;
 document.body.classList.add('auth-required');
}

async function useSession(session) {
 lockStudio();state.session=session;storageUI();
 if(!session){
  if(cloudClient)showAuth();
  else showGateError('O acesso precisa ser configurado pelo responsável pelo eCatalogos Auditoria.');
  busy(false);return;
 }
 busy(true,'Carregando seus projetos...');
 $('authForm').inert=true;$('authTabs').inert=true;
 state.db=new CloudStore(cloudClient,session.user.id,message=>toast(message,true));
 const store=state.db;
 try {
  try{state.projectId=localStorage.getItem(projectStorageKey());}catch{}
  await refresh();if(state.db!==store||state.session?.user.id!==session.user.id)return;state.ready=true;
  document.body.classList.remove('auth-required');
  closeAuth();syncViewFromHash();
 }catch(error){if(state.db===store&&state.session?.user.id===session.user.id)showGateError(error.message);}
 finally{busy(false);}
}

function showAuth(mode='login') {
 if(!cloudClient)return;
 state.authMode=mode;$('authForm').hidden=false;$('authForm').inert=false;$('authTabs').inert=false;$('retryAuth').hidden=true;$('gateSignOut').hidden=true;$('closeAuth').hidden=!canUseStudio();
 const recovery=mode==='recovery',reset=mode==='reset';
 $('authTitle').textContent=recovery?'Escolha sua nova senha.':reset?'Recupere seu acesso.':mode==='signup'?'Crie sua conta.':'Entre no eCatalogos Auditoria.';
 $('authIntro').textContent=recovery?'Defina uma nova senha para sua conta.':reset?'Enviaremos um link de recuperação para o seu e-mail.':'Faça login para acessar seus projetos, imagens e aprovações.';
 $('authTabs').hidden=recovery||reset;
 $('authLogin').classList.toggle('active',mode==='login');
 $('authSignup').classList.toggle('active',mode==='signup');
 $('authEmailField').hidden=recovery;$('authEmail').required=!recovery;
 $('authEmail').type=mode==='login'?'text':'email';
 $('authEmail').autocomplete=mode==='login'?'username':'email';
 $('authEmail').placeholder=mode==='login'?'Digite seu e-mail ou usuário':'voce@empresa.com';
 $('authEmailLabel').textContent=mode==='login'?'E-mail ou usuário':'E-mail';
 $('authPasswordField').hidden=reset;$('authPassword').required=!reset;
 $('authPassword').value='';$('authPassword').minLength=mode==='login'?1:8;
 $('authPassword').autocomplete=mode==='login'?'current-password':'new-password';
 $('authSubmit').textContent=reset?'Enviar link de recuperação':recovery?'Salvar nova senha':mode==='signup'?'Criar minha conta':'Entrar na minha conta';
 $('authForgot').hidden=mode!=='login';$('authBack').hidden=!reset;
 $('authFeedback').hidden=true;$('authModal').hidden=false;
 document.body.style.overflow=canUseStudio()?'hidden':'';
 setTimeout(()=>(recovery?$('authPassword'):$('authEmail')).focus(),30);
}
function closeAuth() {
 if(!canUseStudio())return;
 $('authModal').hidden=true;$('authPassword').value='';document.body.style.overflow='';
}
async function submitAuth(event) {
 event.preventDefault();
 const button=$('authSubmit');if(button.disabled)return;
 const mode=state.authMode,login=$('authEmail').value.trim(),email=loginEmail(login),password=$('authPassword').value;
 const redirectTo=location.protocol==='file:'?undefined:location.origin+location.pathname;
 button.disabled=true;$('authForm').inert=true;$('closeAuth').disabled=true;$('authTabs').inert=true;
 $('authFeedback').hidden=true;
 try {
  if(isStudioLogin(login)&&mode==='signup')throw new Error('Esse usuário é criado pelo responsável pelo eCatalogos Auditoria. Depois, entre pela aba Entrar.');
  if(isStudioLogin(login)&&mode==='reset')throw new Error('Esse usuário não possui caixa de e-mail. Peça ao responsável pelo eCatalogos Auditoria para redefinir a senha.');
  let result;
  if(mode==='signup')result=await cloudClient.auth.signUp({email,password,options:{emailRedirectTo:redirectTo}});
  else if(mode==='reset')result=await cloudClient.auth.resetPasswordForEmail(email,{redirectTo});
  else if(mode==='recovery')result=await cloudClient.auth.updateUser({password});
  else result=await cloudClient.auth.signInWithPassword({email,password});
  if(result.error)throw result.error;
  if(mode==='reset'||(mode==='signup'&&!result.data.session)) {
   $('authFeedback').classList.remove('error');$('authFeedback').textContent=mode==='reset'?'Se o e-mail estiver cadastrado, você receberá um link para recuperar o acesso.':'Confira seu e-mail para confirmar o cadastro. Depois, entre com sua senha.';$('authFeedback').hidden=false;
  } else {
   if(result.data.session)await useSession(result.data.session);else closeAuth();
   if(mode==='recovery'){state.recovery=false;toast('Nova senha salva.');}
  }
 }catch(error){$('authFeedback').classList.add('error');$('authFeedback').textContent=authMessage(error);$('authFeedback').hidden=false;}
 finally{button.disabled=false;$('authForm').inert=false;$('closeAuth').disabled=false;$('authTabs').inert=false;}
}

function hookAccount() {
 $('openAuth').onclick=()=>showAuth();$('closeAuth').onclick=closeAuth;
 $('authLogin').onclick=()=>showAuth('login');$('authSignup').onclick=()=>showAuth('signup');
 $('authForgot').onclick=()=>{if(isStudioLogin($('authEmail').value))return toast('Esse usuário não possui caixa de e-mail. Peça ao responsável pelo eCatalogos Auditoria para redefinir a senha.',true);showAuth('reset');};$('authBack').onclick=()=>showAuth();
 $('authForm').onsubmit=submitAuth;
 $('refreshCloud').onclick=()=>useSession(state.session);$('retryAuth').onclick=()=>location.reload();$('gateSignOut').onclick=()=>$('signOut').click();
 $('signOut').onclick=async()=>{if(state.busy)return;busy(true,'Saindo da sua conta...');try{const {error}=await cloudClient.auth.signOut();if(error)throw error;await useSession(null);}catch(error){toast(authMessage(error),true);}finally{busy(false);}};
 $('migrateLocal').onclick=()=>run(async()=>{
  let count;
  try{count=await migrateLocalProjects(state.local,state.db,(n,name)=>{$('notice').textContent=`Copiando comparativo ${n} de “${name}”...`;});}finally{await refresh();}
  toast(count?`${count} comparativo(s) copiado(s) para sua conta. Os originais locais foram mantidos.`:'Todos os projetos locais já estão na sua conta.');
 },'Copiando projetos locais para sua conta...');
}

async function init() {
 hook();hookAccount();
 let authVersion=0,latestAuthSession;
 // Never await Supabase methods inside its auth callback (the SDK holds a lock).
 if(cloudClient)cloudClient.auth.onAuthStateChange((event,session)=>{
  const version=++authVersion;latestAuthSession=session;
  if(event==='PASSWORD_RECOVERY')state.recovery=true;
  const reconcile=()=>{
   if(version!==authVersion)return;
   if(!session&&state.session){useSession(null);return;}
   if(!state.initialized)return;
   if(state.busy){setTimeout(reconcile,100);return;}
   if((session?.user.id||null)!==(state.session?.user.id||null))useSession(session);
   if(state.recovery&&$('authModal').hidden)showAuth('recovery');
  };
  setTimeout(reconcile,0);
 });
 try {
  try{state.local=await openLocalStore();}catch(error){console.warn('Armazenamento local indisponível:',error.message);}
  let session=null;
  if(cloudClient){const result=await cloudClient.auth.getSession();if(result.error)throw result.error;session=latestAuthSession===undefined?result.data.session:latestAuthSession;}
  await useSession(session);
  state.initialized=true;
  if(state.recovery&&$('authModal').hidden)showAuth('recovery');
 }catch(error){lockStudio();busy(false);showGateError(error.message);}
}
init();
