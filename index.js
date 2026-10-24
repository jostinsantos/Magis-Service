/*
 * Magis Service Catalog - repo plugin for the host app's JsAddonRuntime.
 * API-compatible exports: getNews, getHome, getDiscoverFilters, getDiscover,
 * search, getMeta, getStreams, getCatalogs.
 *
 * The repository is intentionally independent of the host app. Configuration
 * is read from globalThis.__nuvioConfig[addonId] when the app provides it.
 */
'use strict';

const ADDON_ID = 'magis-service-catalog';
const DEFAULTS = {
  hosts: 'sqacjy.s5lm5aydc.xyz,osuhk.m3x8o50te.com',
  scheme: 'https',
  appId: 'com.android.msandroid',
  apkVersion: '49902',
  desKeyHex: 'e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8',
  newsLimit: '12'
};
const API_VERSION = '43404';
const SPKG_VERSION = '2025-08-07 05:40:11_36_16_';
const PORTAL_CODE = 'masnew';
const SN_SALT = 'ntFT65w6itH!lHCPw7D=@qnsFC5adD28';
const FIXED_MAC = '02:00:00:00:00:00';
const HOME = { movies: 'masnew_movies', series: 'masnew_series', anime: 'masnew_anime', featured: 'masnew_featured' };
const ROOT = { movies: '76263', series: '76235', anime: '76209' };
let session = null;
let sessionPromise = null;
let preferredHost = null;
let lastCallAt = 0;
let slbCache = null;
const responseCache = new Map();
const inFlight = new Map();
let rateQueue = Promise.resolve();
const categoryKinds = new Map();
const itemKinds = new Map();
const CACHE_TTL = { getHome: 5 * 60e3, getNextColumns: 5 * 60e3, 'v3/getShelveData': 3 * 60e3, 'v3/getRecommends': 10 * 60e3, 'v3/searchByName': 30e3, 'v4/getItemData': 10 * 60e3, 'v14/getSlbInfo': 10 * 60e3 };
function cacheKey(path, bean) { return path + ':' + JSON.stringify(bean || {}); }
async function cached(key, ttl, work) {
  const now = Date.now(), hit = responseCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const task = Promise.resolve().then(work).then(value => {
    if (ttl > 0) responseCache.set(key, {value, expires:Date.now()+ttl});
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
function timeoutError(e) { const m = String(e && (e.name || e.message) || e).toLowerCase(); return m.includes('abort') || m.includes('timeout'); }
async function rateTurn() {
  let release;
  const previous = rateQueue;
  rateQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, 400 - (Date.now() - lastCallAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  } finally { release(); }
}

function config() {
  let supplied = {};
  try {
    const all = globalThis.__nuvioConfig || {};
    supplied = all[ADDON_ID] || all.current || {};
  } catch (_) {}
  const c = Object.assign({}, DEFAULTS, supplied);
  c.hosts = String(c.hosts || DEFAULTS.hosts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  c.scheme = String(c.scheme || 'https').replace(':', '');
  return c;
}
function cryptoJS() {
  if (typeof CryptoJS === 'undefined' || !CryptoJS.TripleDES) throw new Error('CryptoJS no está disponible en el runtime');
  return CryptoJS;
}
function encryptBody(value) {
  const c = config(), C = cryptoJS();
  const key = C.enc.Hex.parse(c.desKeyHex);
  const encrypted = C.TripleDES.encrypt(String(value), key, { mode: C.mode.ECB, padding: C.pad.Pkcs7 });
  const b64 = encrypted.ciphertext.toString(C.enc.Base64);
  return C.enc.Utf8.parse(b64).toString(C.enc.Hex);
}
function decryptBlob(wire) {
  const C = cryptoJS();
  const b64 = C.enc.Utf8.stringify(C.enc.Hex.parse(String(wire)));
  const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(b64) });
  return C.TripleDES.decrypt(params, C.enc.Hex.parse(config().desKeyHex), { mode: C.mode.ECB, padding: C.pad.Pkcs7 }).toString(C.enc.Utf8);
}
function randHex(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}
function randMac() { return Array.from({length:6}, () => Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join(':'); }
function md5(s) { return cryptoJS().MD5(String(s)).toString().toLowerCase(); }
function deviceDict(sn) {
  return { loginType:'2', appLanguage:'en', apkVersion:config().apkVersion, sysVersion:SPKG_VERSION,
    appId:config().appId, hardwareInfo:'ranchu', model:'sdk_gphone64_arm64', product:'sdk_gphone64_arm64',
    cpu:'arm64-v8a', B29:'', reserve1:'', deviceToken:'', sn:sn || (session && session.sn) || '',
    drmId:'', sdkVer:36 };
}
function hardwareFingerprint() {
  return { androidId:randHex(8), board:'goldfish_arm64', brand:'google', cpuAbi:'arm64-v8a', cpuId:randHex(8),
    device:'emu64a', diskInfo:'8GB', display:'sdk_gphone64_arm64', etheMac:randMac(),
    fingerprint:'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys',
    gatewayMac:randMac(), hardware:'ranchu', host:'abfarm', manufacturer:'Google', ramSize:'4GB', romSize:'8GB',
    serialNumber:randHex(8), tags:'release-keys', verId:'', wifiMac:randMac() };
}
async function portal(path, bean, baseFields = true) {
  await rateTurn();
  const c = config();
  const body = Object.assign({}, baseFields ? {portalCode:PORTAL_CODE,userId:session?.userId || '',userToken:session?.userToken || ''} : {}, bean || {}, deviceDict());
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar con los hosts configurados';
  const hosts = preferredHost ? [preferredHost, ...c.hosts.filter(h => h !== preferredHost)] : c.hosts;
  for (const host of hosts) {
    try {
      const opts = { method:'POST', headers:{'Content-Type':'application/json; charset=utf-8','apk':c.appId,'apkVer':API_VERSION,'spkgVer':SPKG_VERSION,'User-Agent':'okhttp/3.12.12'}, body:wire };
      // The host runtime supports AbortSignal.timeout. A short deadline prevents a dead portal from holding the Home open.
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') opts.signal = AbortSignal.timeout(7000);
      const response = await fetch(`${c.scheme}://${host}/api/portalCore/${path}`, opts);
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      const json = await response.json();
      const code = String(json.returnCode ?? '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || `Portal ${code}`));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) {
        try { data = JSON.parse(decryptBlob(data)); } catch (_) { /* some responses are already plain */ }
      }
      return data && typeof data === 'object' ? data : json;
    } catch (e) {
      lastError = String(e && e.message || e);
      // Aborting the request is only a client-side deadline in some runtimes; don't launch another request while the first is still pending.
      if (timeoutError(e)) break;
    }
  }
  throw new Error(`${path}: ${lastError}`);
}
async function ensureSession() {
  if (session && session.userToken) return;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    if (typeof CryptoJS === 'undefined') throw new Error('El runtime no ha cargado CryptoJS; revisa que index.js incluya la palabra CryptoJS.');
    const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
    const snToken = String(tokenResponse.snToken || '');
    if (!snToken) throw new Error('El servicio no devolvió snToken');
    const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
    session = {sn, userId:'', userToken:'', jwtToken:''};
    const active = await portal('v8/active', {snToken,authVersion:'',authCode:'',preCode:'',macAddr:FIXED_MAC,
      reserve1:'',openNum:4,channel:'default',matadata:'',signdata:''}, false);
    if (!active.userToken) { session = null; throw new Error('La activación no devolvió userToken'); }
    session.userId = String(active.userId || '');
    session.userToken = String(active.userToken || '');
    session.jwtToken = String(active.jwtToken || '');
  })();
  try { await sessionPromise; } finally { sessionPromise = null; }
}
async function api(path, bean) {
  const ttl = CACHE_TTL[path] || 0;
  if (!ttl) { await ensureSession(); return portal(path, bean, true); }
  return cached(cacheKey(path, bean), ttl, async () => { await ensureSession(); return portal(path, bean, true); });
}
function listFrom(o, keys) {
  for (const k of keys) if (o && Array.isArray(o[k])) return o[k];
  if (o && o.data && typeof o.data === 'object' && o.data !== o) return listFrom(o.data, keys);
  if (o && o.result && typeof o.result === 'object' && o.result !== o) return listFrom(o.result, keys);
  return [];
}
function flattenItems(data, forcedType) {
  if (!data || typeof data !== 'object') return [];
  if (!Array.isArray(data) && data.data && typeof data.data === 'object' && !Array.isArray(data.assetList) && !Array.isArray(data.columnList)) {
    const nested = flattenItems(data.data, forcedType); if (nested.length) return nested;
  }
  if (!Array.isArray(data) && data.result && typeof data.result === 'object') {
    const nested = flattenItems(data.result, forcedType); if (nested.length) return nested;
  }
  if (Array.isArray(data)) return data.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
  for (const key of ['assetList','itemList','contentList','movieList','programList','list','results','items']) {
    if (Array.isArray(data[key])) return data[key].filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
  }
  const groups = listFrom(data, ['searchItemList','recommendList','columnList','homeColumnList','rowList','columns','childColumnList','nextColumnList']);
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const nested = flattenItems(g, forcedType);
    out.push(...nested);
  }
  return out;
}
function normalizeItem(raw, forcedType) {
  const images = Array.isArray(raw.posterList || raw.posters || raw.imageList) ? (raw.posterList || raw.posters || raw.imageList) : [];
  let poster = raw.poster || raw.posterUrl || raw.pic || raw.cover || raw.image || '';
  let backdrop = raw.backdrop || raw.backdropUrl || raw.background || '';
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const kind = String(img.fileType || img.type || '').toLowerCase();
    const url = String(img.fileUrl || img.url || img.picUrl || '');
    if (!url) continue;
    if (!poster && ['icon','h_poster','v_poster','cover','thumb'].includes(kind)) poster = url;
    if (!backdrop && kind === 'poster') backdrop = url;
    if (!poster) poster = url;
  }
  const programType = String(raw.programType || raw.contentType || raw.type || 'movie').toLowerCase();
  let type = forcedType || (['teleplay','series','variety','0'].includes(programType) ? 'series' : 'movie');
  if (type === 'movies') type = 'movie'; if (type === 'animation') type = 'anime';
  const name = String(raw.name || raw.contentName || raw.programName || raw.assetName || raw.viewPoint || raw.alias || raw.title || raw.contentId || raw.id || 'Sin título');
  const release = String(raw.releaseTime || raw.year || raw.releaseDate || '');
  const genres = raw.genres || raw.genreList || raw.categoryList || raw.categoryNameList || raw.categoryName || raw.genre || [];
  const item = Object.assign({}, raw, {
    id:String(raw.contentId || raw.id || raw.assetId || ''), contentId:String(raw.contentId || raw.id || raw.assetId || ''),
    title:name, name, type, media_type:type, year:/^\d{4}/.test(release) ? release.slice(0,4) : release,
    poster, image:poster, backdrop, background:backdrop,
    description:String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || ''),
    overview:String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || ''),
    genres:Array.isArray(genres) ? genres.map(g => typeof g === 'object' ? String(g.name || g.title || '') : String(g)).filter(Boolean) : String(genres || '').split(/[,|;]/).map(x=>x.trim()).filter(Boolean),
    programType: type === 'series' ? 'series' : type === 'anime' ? (programType || 'anime') : 'movie'
  });
  if (raw.score != null && item.rating == null) item.rating = Number(raw.score) || null;
  return item;
}
function rowName(row, fallback) { return String(row.name || row.columnName || row.title || row.recommendName || fallback); }
function normalizeRows(data, fallback, forcedType) {
  if (data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)) data = data.data;
  let rows = listFrom(data, ['columnList','homeColumnList','rowList','list','columns','childColumnList','nextColumnList','columnInfoList']);
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.recommendList)) rows = data.recommendList;
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.assetList)) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{id:String(data.columnId || ''), code:String(data.columnCode || ''), title:rowName(data, fallback), name:rowName(data, fallback), items}] : [];
  }
  if (!rows.length) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{id:String(data.columnId || ''),code:String(data.columnCode || ''),title:fallback,name:fallback,items}] : [];
  }
  const out = [];
  for (let i=0;i<rows.length;i++) {
    const r=rows[i]; if (!r || typeof r!=='object') continue;
    const title=rowName(r, `${fallback} ${i+1}`);
    const items=flattenItems(r, forcedType);
    const id=String(r.columnId || r.id || r.recommendCode || r.columnCode || '');
    const code=String(r.columnCode || r.recommendCode || '');
    // A category row can be a navigation node without containing items yet.
    if (!items.length && !id && !code) continue;
    out.push({id, code, title, name:title, items});
  }
  return out;
}
function unique(items) { const seen = new Set(); return items.filter(it => { const id = String(it.contentId || it.id || it.title); if (!id || seen.has(id)) return false; seen.add(id); return true; }); }
async function homeRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  return cached('homeRows:'+kind, CACHE_TTL.getHome, async () => {
    // First try the actual Home endpoint. Only fall back when it returns an empty shape,
    // not when a request times out, to avoid multiplying stalled network requests.
    try {
      const data = await api('getHome', {homePageCode:code,version:''});
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) { categoryKindsFromRows(rows, kind); return rows; }
    } catch (e) { if (timeoutError(e)) return []; }
    try {
      const data = await api('getNextColumns', {columnCode:code,pageNum:1,pageSize:30,version:''});
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) { categoryKindsFromRows(rows, kind); return rows; }
    } catch (e) { if (timeoutError(e)) return []; }
    // Final fallback mirrors MagisService.loadHomeRows: query the known root shelf.
    try {
      const rootId=ROOT[kind] || ROOT.movies;
      const data=await api('v3/getShelveData',{columnId:rootId,columnType:'2',pageNum:1,pageSize:30,encryptVersion:0});
      const items=flattenItems(data,forcedType);
      if(items.length) return [{id:rootId,code,title:kindLabel(kind),name:kindLabel(kind),items}];
    } catch (_) {}
    return [];
  });
}
function categoryKindsFromRows(rows, kind) {
  for (const row of rows) {
    if (row.id) categoryKinds.set(String(row.id), kind);
    if (row.code) categoryKinds.set(String(row.code), kind);
    for (const item of (row.items || [])) {
      const id=String(item.contentId || item.id || '');
      if (id) itemKinds.set(id, kind === 'movies' ? 'movie' : kind === 'series' ? 'series' : 'anime');
    }
  }
}
function kindLabel(kind) { return kind === 'series' ? 'Series' : kind === 'anime' ? 'Animación' : 'Películas'; }
async function featured() {
  return cached('featured-items', CACHE_TTL['v3/getRecommends'], async () => {
    try {
      const data = await api('v3/getRecommends', {recommendCodeArr:Array.from({length:6},(_,i)=>`masnew_featured${String(i+1).padStart(2,'0')}`)});
      const items = unique(flattenItems(data));
      if (items.length) return items;
    } catch (_) {}
    // Do not start extra network calls here; use already-loaded Home data only.
    let cachedMovies = responseCache.get('homeRows:movies')?.value || [];
    let cachedSeries = responseCache.get('homeRows:series')?.value || [];
    // When the launcher requests news before Home, make one bounded fallback request.
    if (!cachedMovies.length) cachedMovies = await homeRows('movies').catch(()=>[]);
    if (!cachedSeries.length && cachedMovies.flatMap(r=>r.items).length < 8) cachedSeries = await homeRows('series').catch(()=>[]);
    return unique([...cachedMovies.flatMap(r=>r.items), ...cachedSeries.flatMap(r=>r.items)]).slice(0,20);
  });
}
function isAnime(item) {
  const text = `${item.type||''} ${item.programType||''} ${item.name||''} ${item.category||''} ${item.columnName||''}`.toLowerCase();
  return /anime|animaci|donghua|masnew_anime/.test(text);
}
function itemType(item) { return item.type === 'anime' || isAnime(item) ? 'anime' : item.type === 'series' || item.programType === 'series' || item.programType === 'teleplay' || item.programType === '0' ? 'series' : 'movie'; }
async function getNews() {
  const limit = Math.max(1, Math.min(20, parseInt(config().newsLimit,10) || 12));
  const items = await featured();
  return unique(items).slice(0, limit).map((it, i) => Object.assign({}, it, {section:'novedades', news:true, newsRank:i+1}));
}
async function getHome() {
  const kinds = ['movies','series','anime'];
  const results = await Promise.all(kinds.map(kind => homeRows(kind).catch(()=>[])));
  const rows = [];
  for (let i=0;i<kinds.length;i++) {
    const kind=kinds[i];
    for (const row of results[i]) rows.push(Object.assign({}, row, {type:'row',categoryType:kind === 'movies' ? 'movie' : kind,category:row.title,imageStyle:'poster'}));
  }
  // Keep news as its own row; never merge it with the movie/series/anime carousels.
  const news = await getNews().catch(()=>[]);
  if (news.length) rows.unshift({id:'novedades',code:'novedades',title:'Novedades',name:'Novedades',type:'hero',imageStyle:'backdrop',items:news});
  return rows;
}
async function getCatalogs() {
  return [
    {id:'peliculas', title:'Películas', name:'Películas', type:'movie', kinds:['movie'], extra:{kind:'movies'}},
    {id:'series', title:'Series', name:'Series', type:'series', kinds:['series'], extra:{kind:'series'}},
    {id:'animacion', title:'Animación', name:'Animación', type:'anime', kinds:['anime'], extra:{kind:'anime'}}
  ];
}
async function getCatalog(catalogId, options) {
  const id=String(catalogId || '').toLowerCase();
  const opts=options && typeof options==='object' ? options : {};
  const kind=id.includes('anime') || id.includes('anim') ? 'anime' : id.includes('series') ? 'series' : 'movies';
  return getDiscover(Object.assign({}, opts, {kind}));
}
async function getDiscoverFilters() {
  const kinds=['movies','series','anime'];
  const results=await Promise.all(kinds.map(kind=>homeRows(kind).catch(()=>[])));
  const options=[{id:'all',label:'Todas las categorías'}];
  const seen=new Set(['all']);
  for(let i=0;i<kinds.length;i++) {
    for(const row of results[i]) {
      const id=String(row.id || row.code || '');
      if(!id || seen.has(id)) continue;
      seen.add(id); categoryKinds.set(id,kinds[i]);
      if (row.code) categoryKinds.set(String(row.code), kinds[i]);
      options.push({id,label:row.title || row.name || kindLabel(kinds[i])});
    }
  }
  return [
    {id:'type',name:'Tipo',label:'Tipo',type:'select',options:[{id:'movie',label:'Películas'},{id:'series',label:'Series'},{id:'anime',label:'Animación'}]},
    {id:'category',name:'Categoría',label:'Categoría',type:'select',options}
  ];
}
async function getDiscover(options) {
  const opts=options && typeof options==='object' ? options : {};
  const requested=String(opts.type || opts.kind || 'movie').toLowerCase();
  let kind=requested.includes('anime') || requested.includes('anim') ? 'anime' : requested.includes('series') ? 'series' : requested.includes('all') ? 'all' : 'movies';
  let columnId=String(opts.columnId || opts.categoryId || '');
  const category=String(opts.category || '');
  if (!columnId && category && category !== 'all') columnId=category;
  if (columnId) {
    const mapped=categoryKinds.get(columnId);
    // Some service rows expose a columnCode separately from the numeric columnId.
    // Prefer the known numeric ID when we can resolve it from cached Home rows.
    const wanted=columnId;
    for (const kindKey of ['movies','series','anime']) {
      const cachedRows=responseCache.get('homeRows:'+kindKey)?.value || [];
      const found=cachedRows.find(r=>String(r.code)===wanted || String(r.id)===wanted);
      if(found && found.id) { columnId=String(found.id); break; }
    }
    try {
      const data=await api('v3/getShelveData',{columnId,columnType:'2',pageNum:Math.max(1,parseInt(opts.page,10)||1),pageSize:40,encryptVersion:0});
      const inferred=mapped || (kind==='anime'?'anime':kind==='series'?'series':kind==='movies'?'movie':undefined);
      const items=flattenItems(data, inferred==='anime'?'anime':undefined).map(it=>{ const t=inferred || itemType(it); const iid=String(it.contentId||it.id||''); if(iid) itemKinds.set(iid,t); return Object.assign(it,{type:t,media_type:t}); });
      const total=Number(data.assetListTotalSize || data.totalSize || data.total || items.length);
      return {items,page:Math.max(1,parseInt(opts.page,10)||1),hasMore:(Math.max(1,parseInt(opts.page,10)||1)*40)<total,total};
    } catch (_) { return {items:[],page:Math.max(1,parseInt(opts.page,10)||1),hasMore:false,total:0}; }
  }
  let kinds=kind==='all'?['movies','series','anime']:[kind];
  const results=await Promise.all(kinds.map(k=>homeRows(k).catch(()=>[])));
  const rows=results.flat();
  const all=unique(rows.flatMap(r=>r.items)).map(it=>Object.assign({},it,{type:kind==='all'?itemType(it):kind==='anime'?'anime':itemType(it)}));
  const page=Math.max(1,parseInt(opts.page,10)||1), start=(page-1)*40;
  return {items:all.slice(start,start+40),page,hasMore:start+40<all.length,total:all.length,categories:rows.map(r=>({id:r.id,name:r.name,code:r.code}))};
}
async function search(query, options) {
  const q=String(query || '').trim(); if(!q) return [];
  const opts=options && typeof options==='object'?options:{};
  const page=Math.max(1,parseInt(opts.page,10)||1);
  const requested=String(opts.type || '').toLowerCase();
  return cached('search:'+q.toLowerCase()+':'+requested+':'+page,30e3,async()=>{
    const find=async type=>unique(flattenItems(await api('v3/searchByName',{value:q,type,columnId:'',filter:'',pageNum:page,pageSize:20})));
    const remember=(items, kind)=>items.map(it=>{ const id=String(it.contentId||it.id||''); if(id) itemKinds.set(id,kind); return Object.assign(it,{type:kind,media_type:kind}); });
    if(requested==='anime'||requested==='animacion'||requested==='animation') {
      try { return remember((await find('0')).filter(it=>isAnime(it)), 'anime'); } catch (_) { return []; }
    }
    if(requested==='movie'||requested==='movies') { try { return remember(await find('1'), 'movie'); } catch (_) { return []; } }
    if(requested==='series') { try { return remember(await find('0'), 'series'); } catch (_) { return []; } }
    const results=await Promise.all([find('1').catch(()=>[]),find('0').catch(()=>[])]);
    return unique([...results[0],...results[1]]).map(it=>{ const kind=itemType(it); const id=String(it.contentId||it.id||''); if(id) itemKinds.set(id,kind); return Object.assign(it,{type:kind,media_type:kind}); });
  });
}
async function getMeta(id, options) {
  const opts=options && typeof options==='object'?options:(typeof options==='string'?{type:options}:{});
  const contentId=String(id && typeof id==='object'?(id.contentId||id.id||id.assetId):id||'').trim();
  if(!contentId) return null;
  const seed=id && typeof id==='object'?normalizeItem(id):null;
  const knownType=String((seed && seed.type) || (itemKinds.get(contentId) || ''));
  let type=String(opts.type || (knownType==='series'||knownType==='anime'?'0':knownType==='movie'?'1':'1'));
  if(type==='movie') type='1'; if(type==='series'||type==='anime') type='0';
  return cached('meta:'+contentId+':'+type, CACHE_TTL['v4/getItemData'], async()=>{
    const response=await api('v4/getItemData',{contentId,type,sortType:'0',language:'en',macAddr:FIXED_MAC});
    let data=response;
    // Service versions wrap details differently: {item}, {data:{item}}, {result:{...}}.
    for(let i=0;i<4 && data && typeof data==='object';i++) {
      if(data.item && typeof data.item==='object') { data=data.item; continue; }
      if(data.result && typeof data.result==='object') { data=data.result; continue; }
      if(data.data && typeof data.data==='object' && !data.contentId && !data.assetId && !data.name && !data.title) { data=data.data; continue; }
      break;
    }
    if(!data || typeof data!=='object') data={};
    const item=normalizeItem(Object.assign({},data,seed||{},data,{contentId,id:contentId}));
    item.details=data;
    const rawSeasons=listFrom(data,['seasonList','seasons','seriesList']);
    item.seasons=rawSeasons.map((season,i)=>{
      const eps=listFrom(season,['episodeList','episodes','movieList','assetList']).map((ep,j)=>{
        const e=normalizeItem(ep, item.type==='anime'?'anime':undefined);
        return {number:Number(ep.episodeNo||ep.episodeNum||ep.episode||ep.number||j+1),id:String(ep.contentId||ep.id||ep.movieId||`${contentId}_e${j+1}`),title:String(ep.name||ep.title||ep.viewPoint||`Episodio ${j+1}`),overview:String(ep.description||ep.desc||''),still:ep.poster||ep.posterUrl||e.poster||item.backdrop||item.poster};
      });
      return {number:Number(season.seasonNo||season.seasonNum||season.seasonNumber||season.number||i+1),name:String(season.name||season.title||`Temporada ${i+1}`),episodes:eps};
    });
    const episodes=listFrom(data,['episodeList','episodes','movieList']);
    item.episodes=episodes;
    item.type=type==='0'?(knownType==='anime'?'anime':'series'):'movie';
    item.media_type=item.type;
    item.id=String(item.contentId || item.id || contentId);
    item.contentId=String(item.contentId || contentId);
    item.title=String(item.title || item.name || (seed && seed.title) || contentId);
    item.name=item.title;
    item.overview=String(item.overview || item.description || item.details?.description || item.details?.introduction || '');
    item.description=item.overview;
    if(item.id) itemKinds.set(item.id,item.type);
    item.media_type=item.type;
    return item;
  });
}
async function getStreams(id, type, season, episode) {
  const contentId = String(id && typeof id === 'object' ? (id.contentId || id.id) : id || '').trim();
  if (!contentId) return [];
  const itemTypeHint = String(type || (id && id.type) || 'movie').toLowerCase();
  const seriesContentId = itemTypeHint === 'series' || itemTypeHint === 'anime' ? contentId : '';
  const play = await api('v10/startPlayVOD',{contentId,seriesContentId,startTime:0,type:'1',columnId:0,authType:''});
  let media = null;
  const episodes = listFrom(play,['episodeList']);
  if (episodes.length) {
    const ep = episodes[0];
    const groups = listFrom(ep,['totalMovieList']);
    for (const g of groups) { const list = listFrom(g,['movieList']); if (list.length) { media = list[0]; break; } }
  }
  if (!media) media = listFrom(play,['mediaList','movieList'])[0] || (play.licenseList ? play : null);
  if (!media) return [];
  const licenses = listFrom(media,['licenseList']);
  const license = licenses.length ? String(licenses[0].license || '') : '';
  if (!license) return [];
  const slb = await api('v14/getSlbInfo',{hasPay:'0',userIdentity:'1',type:'merge',appVer:config().apkVersion,lang:'es',encMediaSupported:1,liveCodeList:['masnew_live'],appParams:'',reserve1:FIXED_MAC,pipFlag:'0'});
  const cdns = listFrom(slb,['cdn_list']);
  let chosen = null;
  for (const cdn of cdns) {
    if (String(cdn.tag) !== 'vod') continue;
    for (const u of listFrom(cdn,['url_list'])) {
      const url = String(u.url || '');
      if (String(u.tag) === 'free' && (url.includes('cfl') || String(u.sign_type)==='cfl')) { chosen={cdn,u}; break; }
    }
    if (chosen) break;
  }
  if (!chosen) return [];
  const base = String(chosen.cdn.main_addr || '').replace(/\/$/,'');
  const ext = String(media.videoFormat || '').toLowerCase() === 'ts' ? 'ts' : 'mp4';
  const url = `${base}/vod/${media.contentId || contentId}_media.${ext}`;
  return [{name:'Magis Service',title:'Magis Service',url,quality:String(media.definition || media.resolution || 'Auto'),type:ext==='mp4'?'mp4':'ts',mimeType:ext==='mp4'?'video/mp4':'video/mp2t',headers:{'Content-Auth':String(chosen.u.url),'Content-License':license,'User-Agent':'Ranger/4.9.4-17294ac0','App':config().appId,'App-Version':config().apkVersion},language:'Español',isHls:false}];
}
module.exports = { getNews, getHome, getDiscoverFilters, getDiscover, getCatalog, search, getMeta, getStreams, getCatalogs };
