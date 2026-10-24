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
let preferredHost = null;
let lastCallAt = 0;
let slbCache = null;

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
  const now = Date.now();
  const wait = Math.max(0, 400 - (now - lastCallAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  const c = config();
  const body = Object.assign({}, baseFields ? {portalCode:PORTAL_CODE,userId:session?.userId || '',userToken:session?.userToken || ''} : {}, bean || {}, deviceDict());
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar con los hosts configurados';
  const hosts = preferredHost ? [preferredHost, ...c.hosts.filter(h => h !== preferredHost)] : c.hosts;
  for (const host of hosts) {
    try {
      const response = await fetch(`${c.scheme}://${host}/api/portalCore/${path}`, {
        method:'POST', headers:{'Content-Type':'application/json; charset=utf-8','apk':c.appId,'apkVer':API_VERSION,'spkgVer':SPKG_VERSION,'User-Agent':'okhttp/3.12.12'},
        body:wire
      });
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      let json = await response.json();
      const code = String(json.returnCode ?? '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || `Portal ${code}`));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) {
        try { data = JSON.parse(decryptBlob(data)); } catch (_) { /* some responses are already plain */ }
      }
      return data && typeof data === 'object' ? data : json;
    } catch (e) { lastError = String(e && e.message || e); }
  }
  throw new Error(`${path}: ${lastError}`);
}
async function ensureSession() {
  if (session && session.userToken) return;
  if (typeof CryptoJS === 'undefined') throw new Error('El runtime no ha cargado CryptoJS; revisa que index.js incluya la palabra CryptoJS.');
  const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
  const snToken = String(tokenResponse.snToken || '');
  if (!snToken) throw new Error('El servicio no devolvió snToken');
  const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
  session = {sn, userId:'', userToken:'', jwtToken:''};
  const active = await portal('v8/active', {snToken,authVersion:'',authCode:'',preCode:'',macAddr:FIXED_MAC,
    reserve1:'',openNum:4,channel:'default',matadata:'',signdata:''}, false);
  if (!active.userToken) throw new Error('La activación no devolvió userToken');
  session.userId = String(active.userId || '');
  session.userToken = String(active.userToken || '');
  session.jwtToken = String(active.jwtToken || '');
}
async function api(path, bean) { await ensureSession(); return portal(path, bean, true); }
function listFrom(o, keys) { for (const k of keys) if (o && Array.isArray(o[k])) return o[k]; return []; }
function flattenItems(data) {
  if (Array.isArray(data)) return data.filter(x => x && typeof x === 'object').map(normalizeItem);
  if (!data || typeof data !== 'object') return [];
  const direct = listFrom(data, ['assetList','itemList','list','programList','contentList','results','items']);
  if (direct.length) return direct.filter(x => x && typeof x === 'object').map(normalizeItem);
  const groups = listFrom(data, ['searchItemList','recommendList','columnList','homeColumnList','rowList']);
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const nested = listFrom(g, ['itemList','assetList','contentList','list']);
    out.push(...nested.filter(x => x && typeof x === 'object').map(normalizeItem));
  }
  return out;
}
function normalizeItem(raw) {
  const images = Array.isArray(raw.posterList || raw.posters || raw.imageList) ? (raw.posterList || raw.posters || raw.imageList) : [];
  let poster = raw.poster || raw.posterUrl || raw.pic || raw.cover || raw.image || '';
  let backdrop = raw.backdrop || raw.backdropUrl || '';
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const kind = String(img.fileType || img.type || '').toLowerCase();
    const url = String(img.fileUrl || img.url || img.picUrl || '');
    if (!url) continue;
    if (!poster && ['icon','h_poster','v_poster','cover','thumb'].includes(kind)) poster = url;
    if (!backdrop && kind === 'poster') backdrop = url;
    if (!poster) poster = url;
  }
  const programType = String(raw.programType || raw.type || raw.contentType || 'movie').toLowerCase();
  const type = ['teleplay','series','variety','0'].includes(programType) ? 'series' : (String(raw.type) === 'anime' ? 'anime' : 'movie');
  const name = String(raw.name || raw.viewPoint || raw.alias || raw.title || raw.contentId || raw.id || 'Sin título');
  const release = String(raw.releaseTime || raw.year || '');
  const item = Object.assign({}, raw, {
    id:String(raw.contentId || raw.id || ''), contentId:String(raw.contentId || raw.id || ''),
    title:name, name, type, year:/^\d{4}/.test(release) ? release.slice(0,4) : release,
    poster, image:poster, backdrop, description:String(raw.description || raw.desc || raw.introduction || ''),
    programType: type === 'series' ? 'series' : 'movie'
  });
  return item;
}
function rowName(row, fallback) { return String(row.name || row.columnName || row.title || row.recommendName || fallback); }
function normalizeRows(data, fallback) {
  let rows = listFrom(data, ['columnList','homeColumnList','rowList','list','data']);
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.recommendList)) rows = data.recommendList;
  if (!rows.length) {
    const items = flattenItems(data);
    return items.length ? [{id:String(data.columnId || ''), title:fallback, name:fallback, items}] : [];
  }
  return rows.map((r, i) => ({ id:String(r.columnId || r.id || r.recommendCode || ''), code:String(r.columnCode || r.recommendCode || ''),
    title:rowName(r, `${fallback} ${i+1}`), name:rowName(r, `${fallback} ${i+1}`), items:flattenItems(r) })).filter(r => r.items.length);
}
function unique(items) { const seen = new Set(); return items.filter(it => { const id = String(it.contentId || it.id || it.title); if (!id || seen.has(id)) return false; seen.add(id); return true; }); }
async function homeRows(kind) {
  const code = HOME[kind] || HOME.movies;
  try { const data = await api('getHome', {homePageCode:code,version:''}); const rows = normalizeRows(data, kindLabel(kind)); if (rows.length) return rows; } catch (_) {}
  try { const data = await api('getNextColumns', {columnCode:code,pageNum:1,pageSize:50,version:''}); const rows = normalizeRows(data, kindLabel(kind)); if (rows.length) return rows; } catch (_) {}
  const rootId = ROOT[kind] || ROOT.movies;
  try { const data = await api('v3/getShelveData', {columnId:rootId,columnType:'2',pageNum:1,pageSize:40,encryptVersion:0}); const items = flattenItems(data); if (items.length) return [{id:rootId,code,title:kindLabel(kind),name:kindLabel(kind),items}]; } catch (_) {}
  return [];
}
function kindLabel(kind) { return kind === 'series' ? 'Series' : kind === 'anime' ? 'Animación' : 'Películas'; }
async function featured() {
  try {
    const data = await api('v3/getRecommends', {recommendCodeArr:Array.from({length:6},(_,i)=>`masnew_featured${String(i+1).padStart(2,'0')}`)});
    const items = unique(flattenItems(data)); if (items.length) return items;
  } catch (_) {}
  const rows = await homeRows('movies');
  const series = await homeRows('series');
  return unique([...rows.flatMap(r=>r.items), ...series.flatMap(r=>r.items)]).slice(0,20);
}
function isAnime(item) {
  const text = `${item.type||''} ${item.programType||''} ${item.name||''} ${item.category||''} ${item.columnName||''}`.toLowerCase();
  return /anime|animaci|donghua|masnew_anime/.test(text);
}
function itemType(item) { return isAnime(item) ? 'anime' : item.type === 'series' || item.programType === 'series' ? 'series' : 'movie'; }

async function getNews() {
  const limit = Math.max(1, Math.min(50, parseInt(config().newsLimit,10) || 12));
  const items = await featured();
  return unique(items).slice(0, limit).map((it, i) => Object.assign({}, it, {section:'novedades', news:true, newsRank:i+1}));
}
async function getHome() {
  const rows = [];
  for (const kind of ['movies','series','anime']) {
    const found = await homeRows(kind);
    for (const row of found) rows.push(Object.assign({}, row, {type:kind === 'movies' ? 'movie' : kind, categoryType:kind, category:row.title}));
  }
  // Novedades es una fila propia; no fusionarla con las filas de cada tipo.
  const news = await getNews().catch(()=>[]);
  if (news.length) rows.unshift({id:'novedades',code:'novedades',title:'Novedades',name:'Novedades',type:'news',categoryType:'news',items:news});
  return rows;
}
async function getCatalogs() {
  return [
    {id:'peliculas', name:'Películas', type:'movie', kinds:['movie'], extra:{kind:'movies'}},
    {id:'series', name:'Series', type:'series', kinds:['series'], extra:{kind:'series'}},
    {id:'animacion', name:'Animación', type:'anime', kinds:['anime'], extra:{kind:'anime'}}
  ];
}
async function getDiscoverFilters() {
  return [
    {id:'type', name:'Tipo', type:'select', options:[{id:'movie',label:'Películas'},{id:'series',label:'Series'},{id:'anime',label:'Animación'}]},
    {id:'category', name:'Categoría', type:'select', options:[]}
  ];
}
async function getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requested = String(opts.type || opts.kind || opts.filter || opts.genre || 'movie').toLowerCase();
  const kind = requested.includes('anime') || requested.includes('anim') ? 'anime' : requested.includes('series') ? 'series' : 'movies';
  const page = Math.max(1, parseInt(opts.page,10) || 1);
  const columnId = String(opts.columnId || opts.categoryId || '');
  if (columnId) {
    const data = await api('v3/getShelveData', {columnId,columnType:'2',pageNum:page,pageSize:40,encryptVersion:0});
    const items = flattenItems(data);
    const total = Number(data.assetListTotalSize || data.totalSize || data.total || items.length);
    return {items:items.map(it=>Object.assign(it,{type:itemType(it)})),page,hasMore:page*40<total,total};
  }
  const rows = await homeRows(kind);
  const all = unique(rows.flatMap(r=>r.items)).map(it=>Object.assign(it,{type:itemType(it)}));
  const start = (page-1)*40;
  return {items:all.slice(start,start+40),page,hasMore:start+40<all.length,total:all.length,categories:rows.map(r=>({id:r.id,name:r.name,code:r.code}))};
}
async function search(query, options) {
  const q = String(query || '').trim(); if (!q) return [];
  const opts = options && typeof options === 'object' ? options : {};
  const page = Math.max(1, parseInt(opts.page,10) || 1);
  const requested = String(opts.type || '').toLowerCase();
  if (requested === 'anime' || requested === 'animacion' || requested === 'animation') {
    const r = await api('v3/searchByName',{value:q,type:'0',columnId:'',filter:'',pageNum:page,pageSize:20});
    return unique(flattenItems(r)).filter(it=>isAnime(it)).map(it=>Object.assign(it,{type:'anime'}));
  }
  const types = requested === 'movie' || requested === 'movies' ? ['1'] : requested === 'series' ? ['0'] : ['1','0'];
  const out = [];
  for (const t of types) {
    try { const r = await api('v3/searchByName',{value:q,type:t,columnId:'',filter:'',pageNum:page,pageSize:20}); out.push(...flattenItems(r)); } catch (_) {}
  }
  return unique(out).map(it=>Object.assign(it,{type:itemType(it)}));
}
async function getMeta(id, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const contentId = String(id && typeof id === 'object' ? (id.contentId || id.id) : id || '').trim();
  if (!contentId) return null;
  const seed = id && typeof id === 'object' ? normalizeItem(id) : null;
  let type = String(opts.type || (seed && seed.type === 'series' ? '0' : '1'));
  if (type === 'movie') type = '1'; if (type === 'series' || type === 'anime') type = '0';
  const data = await api('v4/getItemData',{contentId,type,sortType:'0',language:'en',macAddr:FIXED_MAC});
  const item = normalizeItem(Object.assign({}, seed || {}, data, {contentId, id:contentId}));
  item.details = data;
  item.seasons = listFrom(data,['seasonList','seasons','seriesList']);
  item.episodes = listFrom(data,['episodeList','episodes','movieList']);
  item.type = type === '0' ? (seed && seed.type === 'anime' ? 'anime' : 'series') : 'movie';
  return item;
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
module.exports = { getNews, getHome, getDiscoverFilters, getDiscover, search, getMeta, getStreams, getCatalogs };
