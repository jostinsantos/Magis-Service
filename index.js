/*
 * Magis Service Catalog - versión optimizada (menos memoria, menos crashes)
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
let rateQueue = Promise.resolve();

// ---------- CACHÉS CON LÍMITE DE TAMAÑO ----------
const MAX_CACHE = 120;
const MAX_MAP = 400;

const responseCache = new Map();
const inFlight = new Map();
const categoryKinds = new Map();
const itemKinds = new Map();
const episodeContentIds = new Map();

const CACHE_TTL = {
  getHome: 4 * 60e3,
  getNextColumns: 4 * 60e3,
  'v3/getShelveData': 2 * 60e3,
  'v3/getRecommends': 6 * 60e3,
  'v3/searchByName': 25e3,
  'v4/getItemData': 6 * 60e3,
  'v14/getSlbInfo': 8 * 60e3
};

function limitMap(map, max) {
  while (map.size > max) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function cacheKey(path, bean) {
  return path + ':' + JSON.stringify(bean || {});
}

async function cached(key, ttl, work) {
  const now = Date.now();
  const hit = responseCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit) responseCache.delete(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const task = Promise.resolve()
    .then(work)
    .then(value => {
      if (ttl > 0) {
        responseCache.set(key, { value, expires: Date.now() + ttl });
        limitMap(responseCache, MAX_CACHE);
      }
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

function timeoutError(e) {
  const m = String(e && (e.name || e.message) || e).toLowerCase();
  return m.includes('abort') || m.includes('timeout');
}

async function rateTurn() {
  let release;
  const previous = rateQueue;
  rateQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, 320 - (Date.now() - lastCallAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
  } finally {
    release();
  }
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
  if (typeof CryptoJS === 'undefined' || !CryptoJS.TripleDES) {
    throw new Error('CryptoJS no está disponible en el runtime');
  }
  return CryptoJS;
}

function encryptBody(value) {
  const c = config(), C = cryptoJS();
  const key = C.enc.Hex.parse(c.desKeyHex);
  const encrypted = C.TripleDES.encrypt(String(value), key, {
    mode: C.mode.ECB,
    padding: C.pad.Pkcs7
  });
  const b64 = encrypted.ciphertext.toString(C.enc.Base64);
  return C.enc.Utf8.parse(b64).toString(C.enc.Hex);
}

function decryptBlob(wire) {
  const C = cryptoJS();
  const b64 = C.enc.Utf8.stringify(C.enc.Hex.parse(String(wire)));
  const params = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(b64) });
  return C.TripleDES.decrypt(params, C.enc.Hex.parse(config().desKeyHex), {
    mode: C.mode.ECB,
    padding: C.pad.Pkcs7
  }).toString(C.enc.Utf8);
}

function randHex(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

function randMac() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
}

function md5(s) {
  return cryptoJS().MD5(String(s)).toString().toLowerCase();
}

function deviceDict(sn) {
  return {
    loginType: '2',
    appLanguage: 'en',
    apkVersion: config().apkVersion,
    sysVersion: SPKG_VERSION,
    appId: config().appId,
    hardwareInfo: 'ranchu',
    model: 'sdk_gphone64_arm64',
    product: 'sdk_gphone64_arm64',
    cpu: 'arm64-v8a',
    B29: '',
    reserve1: '',
    deviceToken: '',
    sn: sn || (session && session.sn) || '',
    drmId: '',
    sdkVer: 36
  };
}

function hardwareFingerprint() {
  return {
    androidId: randHex(8),
    board: 'goldfish_arm64',
    brand: 'google',
    cpuAbi: 'arm64-v8a',
    cpuId: randHex(8),
    device: 'emu64a',
    diskInfo: '8GB',
    display: 'sdk_gphone64_arm64',
    etheMac: randMac(),
    fingerprint: 'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys',
    gatewayMac: randMac(),
    hardware: 'ranchu',
    host: 'abfarm',
    manufacturer: 'Google',
    ramSize: '4GB',
    romSize: '8GB',
    serialNumber: randHex(8),
    tags: 'release-keys',
    verId: '',
    wifiMac: randMac()
  };
}

async function portal(path, bean, baseFields = true) {
  await rateTurn();
  const c = config();
  const body = Object.assign(
    {},
    baseFields ? { portalCode: PORTAL_CODE, userId: session?.userId || '', userToken: session?.userToken || '' } : {},
    bean || {},
    deviceDict()
  );
  const wire = encryptBody(JSON.stringify(body));
  let lastError = 'No se pudo conectar con los hosts configurados';
  const hosts = preferredHost ? [preferredHost, ...c.hosts.filter(h => h !== preferredHost)] : c.hosts;

  for (const host of hosts) {
    try {
      const opts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          apk: c.appId,
          apkVer: API_VERSION,
          spkgVer: SPKG_VERSION,
          'User-Agent': 'okhttp/3.12.12'
        },
        body: wire
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        opts.signal = AbortSignal.timeout(6500);
      }
      const response = await fetch(`${c.scheme}://${host}/api/portalCore/${path}`, opts);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const json = await response.json();
      const code = String(json.returnCode ?? '');
      if (code && code !== '0') throw new Error(String(json.errorMessage || json.msg || `Portal ${code}`));
      preferredHost = host;
      let data = json.data;
      if (typeof data === 'string' && data) {
        try {
          data = JSON.parse(decryptBlob(data));
        } catch (_) {}
      }
      return data && typeof data === 'object' ? data : json;
    } catch (e) {
      lastError = String(e && e.message || e);
      if (timeoutError(e)) break;
    }
  }
  throw new Error(`${path}: ${lastError}`);
}

async function ensureSession() {
  if (session && session.userToken) return;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (typeof CryptoJS === 'undefined') {
      throw new Error('El runtime no ha cargado CryptoJS; revisa que index.js incluya la palabra CryptoJS.');
    }
    const tokenResponse = await portal('v3/snToken', hardwareFingerprint(), false);
    const snToken = String(tokenResponse.snToken || '');
    if (!snToken) throw new Error('El servicio no devolvió snToken');
    const sn = String(tokenResponse.sn || md5(snToken + SN_SALT)).toLowerCase();
    session = { sn, userId: '', userToken: '', jwtToken: '' };
    const active = await portal('v8/active', {
      snToken,
      authVersion: '',
      authCode: '',
      preCode: '',
      macAddr: FIXED_MAC,
      reserve1: '',
      openNum: 4,
      channel: 'default',
      matadata: '',
      signdata: ''
    }, false);
    if (!active.userToken) {
      session = null;
      throw new Error('La activación no devolvió userToken');
    }
    session.userId = String(active.userId || '');
    session.userToken = String(active.userToken || '');
    session.jwtToken = String(active.jwtToken || '');
  })();

  try {
    await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

async function api(path, bean) {
  const ttl = CACHE_TTL[path] || 0;
  if (!ttl) {
    await ensureSession();
    return portal(path, bean, true);
  }
  return cached(cacheKey(path, bean), ttl, async () => {
    await ensureSession();
    return portal(path, bean, true);
  });
}

// ---------- Helpers de normalización (iguales pero un poco más seguros) ----------
function listFrom(o, keys) {
  for (const k of keys) if (o && Array.isArray(o[k])) return o[k];
  if (o && o.data && typeof o.data === 'object' && o.data !== o) return listFrom(o.data, keys);
  if (o && o.result && typeof o.result === 'object' && o.result !== o) return listFrom(o.result, keys);
  return [];
}

function flattenItems(data, forcedType) {
  if (!data || typeof data !== 'object') return [];
  if (!Array.isArray(data) && data.data && typeof data.data === 'object' && !Array.isArray(data.assetList) && !Array.isArray(data.columnList)) {
    const nested = flattenItems(data.data, forcedType);
    if (nested.length) return nested;
  }
  if (!Array.isArray(data) && data.result && typeof data.result === 'object') {
    const nested = flattenItems(data.result, forcedType);
    if (nested.length) return nested;
  }
  if (Array.isArray(data)) {
    return data.filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
  }
  for (const key of ['assetList', 'itemList', 'contentList', 'movieList', 'programList', 'list', 'results', 'items']) {
    if (Array.isArray(data[key])) {
      return data[key].filter(x => x && typeof x === 'object').map(x => normalizeItem(x, forcedType));
    }
  }
  const groups = listFrom(data, ['searchItemList', 'recommendList', 'columnList', 'homeColumnList', 'rowList', 'columns', 'childColumnList', 'nextColumnList']);
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    out.push(...flattenItems(g, forcedType));
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
    if (!poster && ['icon', 'h_poster', 'v_poster', 'cover', 'thumb'].includes(kind)) poster = url;
    if (!backdrop && kind === 'poster') backdrop = url;
    if (!poster) poster = url;
  }
  const programType = String(raw.programType || raw.contentType || raw.type || raw.mediaType || 'movie').toLowerCase();
  const explicitMovie = ['movie', 'film', '1', 'cinema', 'feature'].includes(programType);
  let type = forcedType || (!explicitMovie && ['teleplay', 'series', 'variety', '0'].includes(programType) ? 'series' : 'movie');
  if (type === 'movies') type = 'movie';
  if (type === 'animation') type = 'anime';

  const name = String(raw.name || raw.viewPoint || raw.alias || raw.title || raw.contentName || raw.programName || raw.assetName || raw.contentId || raw.id || raw.assetId || raw.programId || 'Sin título');
  const release = String(raw.releaseTime || raw.year || raw.releaseDate || raw.publishTime || raw.firstAirDate || '');
  const genres = raw.genres || raw.genreList || raw.categoryList || raw.categoryNameList || raw.categoryName || raw.genre || raw.tags || [];

  const item = Object.assign({}, raw, {
    id: String(raw.contentId || raw.id || raw.assetId || raw.programId || raw.videoId || ''),
    contentId: String(raw.contentId || raw.id || raw.assetId || raw.programId || raw.videoId || ''),
    title: name,
    name,
    type,
    media_type: type,
    year: /^\d{4}/.test(release) ? release.slice(0, 4) : release,
    poster,
    image: poster,
    backdrop,
    background: backdrop,
    description: String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || raw.assetDesc || raw.brief || ''),
    overview: String(raw.description || raw.desc || raw.introduction || raw.intro || raw.summary || raw.plot || raw.contentDesc || raw.programDesc || raw.assetDesc || raw.brief || ''),
    genres: Array.isArray(genres)
      ? genres.map(g => (typeof g === 'object' ? String(g.name || g.title || '') : String(g))).filter(Boolean)
      : String(genres || '').split(/[,|;]/).map(x => x.trim()).filter(Boolean),
    programType: type === 'series' ? 'series' : type === 'anime' ? (programType || 'anime') : 'movie'
  });

  if (raw.score != null && item.rating == null) item.rating = Number(raw.score) || null;
  if (item.id) {
    itemKinds.set(item.id, item.type);
    limitMap(itemKinds, MAX_MAP);
  }
  return item;
}

function rowName(row, fallback) {
  return String(row.name || row.columnName || row.title || row.recommendName || fallback);
}

function normalizeRows(data, fallback, forcedType) {
  if (data && data.data && typeof data.data === 'object' && !Array.isArray(data.data)) data = data.data;
  let rows = listFrom(data, ['columnList', 'homeColumnList', 'rowList', 'list', 'columns', 'childColumnList', 'nextColumnList', 'columnInfoList']);
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.recommendList)) rows = data.recommendList;
  if (!rows.length && data && typeof data === 'object' && Array.isArray(data.assetList)) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{ id: String(data.columnId || ''), code: String(data.columnCode || ''), title: rowName(data, fallback), name: rowName(data, fallback), items }] : [];
  }
  if (!rows.length) {
    const items = flattenItems(data, forcedType);
    return items.length ? [{ id: String(data.columnId || ''), code: String(data.columnCode || ''), title: fallback, name: fallback, items }] : [];
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object') continue;
    const title = rowName(r, `${fallback} ${i + 1}`);
    const items = flattenItems(r, forcedType);
    const id = String(r.columnId || r.id || '');
    const code = String(r.columnCode || r.recommendCode || '');
    if (!items.length && !id && !code) continue;
    out.push({ id, code, title, name: title, items });
  }
  return out;
}

function unique(items) {
  const seen = new Set();
  return items.filter(it => {
    const id = String(it.contentId || it.id || it.title);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function categoryKindsFromRows(rows, kind) {
  for (const row of rows) {
    if (row.id) {
      categoryKinds.set(String(row.id), kind);
      limitMap(categoryKinds, MAX_MAP);
    }
    if (row.code) {
      categoryKinds.set(String(row.code), kind);
      limitMap(categoryKinds, MAX_MAP);
    }
    for (const item of row.items || []) {
      const id = String(item.contentId || item.id || '');
      if (id) {
        itemKinds.set(id, kind === 'movies' ? 'movie' : kind === 'series' ? 'series' : 'anime');
        limitMap(itemKinds, MAX_MAP);
      }
    }
  }
}

function kindLabel(kind) {
  return kind === 'series' ? 'Series' : kind === 'anime' ? 'Animación' : 'Películas';
}

async function homeRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  return cached('homeRows:' + kind, CACHE_TTL.getHome, async () => {
    try {
      const data = await api('getHome', { homePageCode: code, version: '' });
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) {
        categoryKindsFromRows(rows, kind);
        return rows;
      }
    } catch (e) {
      if (timeoutError(e)) return [];
    }
    try {
      const data = await api('getNextColumns', { columnCode: code, pageNum: 1, pageSize: 30, version: '' });
      const rows = normalizeRows(data, kindLabel(kind), forcedType);
      if (rows.length) {
        categoryKindsFromRows(rows, kind);
        return rows;
      }
    } catch (e) {
      if (timeoutError(e)) return [];
    }
    try {
      const rootId = ROOT[kind] || ROOT.movies;
      const data = await api('v3/getShelveData', {
        columnId: rootId,
        columnType: '2',
        pageNum: 1,
        pageSize: 30,
        encryptVersion: 0
      });
      const items = flattenItems(data, forcedType);
      if (items.length) return [{ id: rootId, code, title: kindLabel(kind), name: kindLabel(kind), items }];
    } catch (_) {}
    return [];
  });
}

async function featured() {
  return cached('featured-items', CACHE_TTL['v3/getRecommends'], async () => {
    try {
      const data = await api('v3/getRecommends', {
        recommendCodeArr: Array.from({ length: 6 }, (_, i) => `masnew_featured${String(i + 1).padStart(2, '0')}`)
      });
      const items = unique(flattenItems(data));
      if (items.length) return items;
    } catch (_) {}
    let cachedMovies = responseCache.get('homeRows:movies')?.value || [];
    let cachedSeries = responseCache.get('homeRows:series')?.value || [];
    if (!cachedMovies.length) cachedMovies = await homeRows('movies').catch(() => []);
    if (!cachedSeries.length && cachedMovies.flatMap(r => r.items).length < 8) {
      cachedSeries = await homeRows('series').catch(() => []);
    }
    return unique([...cachedMovies.flatMap(r => r.items), ...cachedSeries.flatMap(r => r.items)]).slice(0, 20);
  });
}

function isAnime(item) {
  const text = `${item.type || ''} ${item.programType || ''} ${item.name || ''} ${item.category || ''} ${item.columnName || ''}`.toLowerCase();
  return /anime|animaci|donghua|masnew_anime/.test(text);
}

function itemType(item) {
  return item.type === 'anime' || isAnime(item)
    ? 'anime'
    : item.type === 'series' || item.programType === 'series' || item.programType === 'teleplay' || item.programType === '0'
      ? 'series'
      : 'movie';
}

async function _getNews() {
  const limit = Math.max(1, Math.min(16, parseInt(config().newsLimit, 10) || 12));
  const items = await featured();
  return unique(items).slice(0, limit).map((it, i) => Object.assign({}, it, { section: 'novedades', news: true, newsRank: i + 1 }));
}

async function _getHome() {
  // Secuencial en vez de Promise.all para no saturar el runtime
  const kinds = ['movies', 'series', 'anime'];
  const rows = [];
  for (const kind of kinds) {
    try {
      const result = await homeRows(kind);
      for (const row of result) {
        rows.push(Object.assign({}, row, {
          type: 'row',
          categoryType: kind === 'movies' ? 'movie' : kind,
          category: row.title,
          imageStyle: 'poster'
        }));
      }
    } catch (_) {}
  }
  const news = await getNews().catch(() => []);
  if (news.length) {
    rows.unshift({
      id: 'novedades',
      code: 'novedades',
      title: 'Novedades',
      name: 'Novedades',
      type: 'hero',
      imageStyle: 'backdrop',
      items: news
    });
  }
  return rows;
}

async function getCatalogs() {
  return [
    { id: 'peliculas', title: 'Películas', name: 'Películas', type: 'movie', kinds: ['movie'], extra: { kind: 'movies' } },
    { id: 'series', title: 'Series', name: 'Series', type: 'series', kinds: ['series'], extra: { kind: 'series' } },
    { id: 'animacion', title: 'Animación', name: 'Animación', type: 'anime', kinds: ['anime'], extra: { kind: 'anime' } }
  ];
}

async function getCatalog(catalogId, options) {
  const id = String(catalogId || '').toLowerCase();
  const opts = options && typeof options === 'object' ? options : {};
  const kind = id.includes('anime') || id.includes('anim') ? 'anime' : id.includes('series') ? 'series' : 'movies';
  return getDiscover(Object.assign({}, opts, { kind }));
}

async function categoryRows(kind) {
  const code = HOME[kind] || HOME.movies;
  const forcedType = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
  try {
    const data = await api('getNextColumns', { columnCode: code, pageNum: 1, pageSize: 40, version: '' });
    const rows = normalizeRows(data, kindLabel(kind), forcedType);
    const usable = rows.filter(r => r.id || r.code);
    if (usable.length) {
      categoryKindsFromRows(usable, kind);
      return usable;
    }
  } catch (_) {}
  const rows = await homeRows(kind).catch(() => []);
  categoryKindsFromRows(rows, kind);
  return rows.filter(r => r.id || r.code);
}

async function _getDiscoverFilters(filters) {
  const opts = filters && typeof filters === 'object' ? filters : {};
  const rawType = String(opts.type || opts.kind || 'movie').toLowerCase();
  const kind = rawType.includes('anime') || rawType.includes('anim') ? 'anime' : rawType.includes('series') ? 'series' : rawType.includes('all') ? 'all' : 'movies';
  const types = [
    { id: 'movie', label: 'Películas' },
    { id: 'series', label: 'Series' },
    { id: 'anime', label: 'Animación' }
  ];
  const kinds = kind === 'all' ? ['movies', 'series', 'anime'] : [kind];
  const rowsByKind = [];
  for (const k of kinds) {
    rowsByKind.push(await categoryRows(k).catch(() => []));
  }
  const options = [{ id: 'all', label: 'Todas las categorías' }];
  const seen = new Set(['all']);
  for (let i = 0; i < kinds.length; i++) {
    for (const row of rowsByKind[i]) {
      const id = String(row.id || '');
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      categoryKinds.set(id, kinds[i]);
      limitMap(categoryKinds, MAX_MAP);
      if (row.code) {
        categoryKinds.set(String(row.code), kinds[i]);
        limitMap(categoryKinds, MAX_MAP);
      }
      options.push({
        id,
        label: row.title || row.name || kindLabel(kinds[i]),
        columnId: String(row.id || ''),
        columnCode: String(row.code || ''),
        type: kinds[i] === 'movies' ? 'movie' : kinds[i]
      });
    }
  }
  return [
    { id: 'type', name: 'Tipo', label: 'Tipo', type: 'select', options: types },
    { id: 'category', name: 'Categoría', label: 'Categoría', type: 'select', options }
  ];
}

async function _getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requested = String(opts.type || opts.kind || 'movie').toLowerCase();
  const kind = requested.includes('anime') || requested.includes('anim') ? 'anime' : requested.includes('series') ? 'series' : requested.includes('all') ? 'all' : 'movies';
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const pageSize = 20;
  let selected = String(opts.columnId || opts.categoryId || opts.category || opts.genre || opts.filter || '');
  if (selected === 'all' || selected === 'Todas las categorías') selected = '';

  if (selected && !opts.columnId && !opts.categoryId) {
    const mapped = categoryKinds.get(selected);
    const searchKinds = mapped ? [mapped] : (kind === 'all' ? ['movies', 'series', 'anime'] : [kind]);
    for (const k of searchKinds) {
      const rows = await categoryRows(k).catch(() => []);
      const found = rows.find(r => String(r.id) === selected || String(r.code) === selected || r.title === selected || r.name === selected);
      if (found && /^\d+$/.test(String(found.id || ''))) {
        selected = String(found.id);
        categoryKinds.set(selected, k);
        limitMap(categoryKinds, MAX_MAP);
        break;
      }
    }
  }

  if (selected) {
    if (!/^\d+$/.test(selected)) return { items: [], page, hasMore: false, total: 0, error: 'La categoría no contiene un columnId válido' };
    const mapped = categoryKinds.get(selected);
    const inferred = mapped || (kind === 'all' ? '' : kind);
    try {
      const data = await api('v3/getShelveData', {
        columnId: selected,
        columnType: '2',
        pageNum: page,
        pageSize,
        encryptVersion: 0
      });
      let items = flattenItems(data, inferred === 'anime' ? 'anime' : inferred === 'series' ? 'series' : inferred === 'movies' ? 'movie' : undefined);
      if (!items.length) {
        items = normalizeRows(data, 'Catálogo', inferred === 'anime' ? 'anime' : inferred === 'series' ? 'series' : inferred === 'movies' ? 'movie' : undefined).flatMap(r => r.items);
      }
      items = unique(items).map(it => {
        const t = inferred === 'anime' ? 'anime' : inferred === 'series' ? 'series' : inferred === 'movies' ? 'movie' : itemType(it);
        if (it.id) {
          itemKinds.set(it.id, t);
          limitMap(itemKinds, MAX_MAP);
        }
        return Object.assign({}, it, { type: t, media_type: t });
      });
      const totalRaw = data.assetListTotalSize ?? data.listTotalSize ?? data.totalSize ?? data.total ?? data.count;
      const total = Number(totalRaw || items.length);
      const start = (page - 1) * pageSize;
      const pageItems = items.length > pageSize ? items.slice(start, start + pageSize) : items;
      const hasMore = totalRaw != null ? page * pageSize < total : items.length >= pageSize;
      return { items: pageItems, page, hasMore, total };
    } catch (_) {
      return { items: [], page, hasMore: false, total: 0 };
    }
  }

  if (kind === 'all') {
    const results = [];
    for (const k of ['movies', 'series', 'anime']) {
      results.push(await categoryRows(k).catch(() => []));
    }
    const rows = results.flat();
    const items = unique(rows.flatMap(r => r.items)).map(it => Object.assign({}, it, { type: itemType(it), media_type: itemType(it) }));
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      page,
      hasMore: start + pageSize < items.length,
      total: items.length,
      categories: rows.map(r => ({ id: r.id, name: r.name, code: r.code }))
    };
  }

  const rootId = ROOT[kind] || ROOT.movies;
  try {
    const data = await api('v3/getShelveData', {
      columnId: rootId,
      columnType: '2',
      pageNum: page,
      pageSize,
      encryptVersion: 0
    });
    let items = flattenItems(data, kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie');
    if (!items.length) {
      items = normalizeRows(data, kindLabel(kind), kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie').flatMap(r => r.items);
    }
    items = unique(items).map(it => {
      const t = kind === 'series' ? 'series' : kind === 'anime' ? 'anime' : 'movie';
      if (it.id) {
        itemKinds.set(it.id, t);
        limitMap(itemKinds, MAX_MAP);
      }
      return Object.assign({}, it, { type: t, media_type: t });
    });
    const totalRaw = data.assetListTotalSize ?? data.listTotalSize ?? data.totalSize ?? data.total ?? data.count;
    const total = Number(totalRaw || items.length);
    const start = (page - 1) * pageSize;
    const pageItems = items.length > pageSize ? items.slice(start, start + pageSize) : items;
    const hasMore = totalRaw != null ? page * pageSize < total : items.length >= pageSize;
    if (items.length || total) return { items: pageItems, page, hasMore, total };
  } catch (_) {}

  const rows = await homeRows(kind).catch(() => []);
  const all = unique(rows.flatMap(r => r.items));
  const start = (page - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page,
    hasMore: start + pageSize < all.length,
    total: all.length,
    categories: rows.map(r => ({ id: r.id, name: r.name, code: r.code }))
  };
}

async function search(query, options) {
  const q = String(query || '').trim();
  if (!q) return [];
  const opts = options && typeof options === 'object' ? options : {};
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const requested = String(opts.type || '').toLowerCase();
  return cached('search:' + q.toLowerCase() + ':' + requested + ':' + page, 25e3, async () => {
    const find = async type => unique(flattenItems(await api('v3/searchByName', {
      value: q,
      type,
      columnId: '',
      filter: '',
      pageNum: page,
      pageSize: 20
    })));
    const remember = (items, kind) => items.map(it => {
      const id = String(it.contentId || it.id || '');
      if (id) {
        itemKinds.set(id, kind);
        limitMap(itemKinds, MAX_MAP);
      }
      return Object.assign(it, { type: kind, media_type: kind });
    });
    if (requested === 'anime' || requested === 'animacion' || requested === 'animation') {
      try {
        return remember((await find('0')).filter(it => isAnime(it)), 'anime');
      } catch (_) {
        return [];
      }
    }
    if (requested === 'movie' || requested === 'movies') {
      try {
        return remember(await find('1'), 'movie');
      } catch (_) {
        return [];
      }
    }
    if (requested === 'series') {
      try {
        return remember(await find('0'), 'series');
      } catch (_) {
        return [];
      }
    }
    const results = await Promise.all([find('1').catch(() => []), find('0').catch(() => [])]);
    return unique([...results[0], ...results[1]]).map(it => {
      const kind = itemType(it);
      const id = String(it.contentId || it.id || '');
      if (id) {
        itemKinds.set(id, kind);
        limitMap(itemKinds, MAX_MAP);
      }
      return Object.assign(it, { type: kind, media_type: kind });
    });
  });
}

function unwrapDetail(response) {
  let data = response;
  for (let i = 0; i < 5 && data && typeof data === 'object'; i++) {
    if (data.assetData && typeof data.assetData === 'object') {
      data = data.assetData;
      continue;
    }
    if (data.item && typeof data.item === 'object') {
      data = data.item;
      continue;
    }
    if (data.result && typeof data.result === 'object') {
      data = data.result;
      continue;
    }
    if (data.data && typeof data.data === 'object' && !data.contentId && !data.name && !data.title && !data.programType) {
      data = data.data;
      continue;
    }
    break;
  }
  return data && typeof data === 'object' ? data : {};
}

function episodeRows(data, seriesId, defaultSeason) {
  const raw = listFrom(data, ['simpleProgramList', 'episodeList', 'episodes', 'programList', 'movieList', 'assetList']);
  return raw.map((ep, j) => {
    const e = normalizeItem(ep);
    const number = Number(ep.seriesNumber || ep.episodeNum || ep.episodeNo || ep.episode || ep.number || j + 1) || j + 1;
    const id = String(ep.contentId || ep.id || ep.movieId || ep.assetId || '');
    if (!id) return null;
    return {
      number,
      episode: number,
      id,
      contentId: id,
      title: String(ep.name || ep.viewPoint || ep.alias || ep.title || `Capítulo ${number}`),
      name: String(ep.name || ep.viewPoint || ep.alias || ep.title || `Capítulo ${number}`),
      overview: String(ep.description || ep.desc || ep.introduction || ''),
      description: String(ep.description || ep.desc || ep.introduction || ''),
      still: String(ep.poster || ep.posterUrl || e.poster || e.backdrop || ''),
      poster: String(ep.poster || ep.posterUrl || e.poster || ''),
      season: Number(ep.seasonNumber || ep.seasonNum || ep.season || defaultSeason || 1) || 1,
      seriesContentId: String(ep.seriesContentId || seriesId || '')
    };
  }).filter(Boolean);
}

function parseSeasonFromName(name) {
  const m = String(name || '').match(/(?:temporada|season|temp\.?|\bT|\bS)\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

async function _getMeta(id, options) {
  const opts = options && typeof options === 'object' ? options : (typeof options === 'string' ? { type: options } : {});
  const contentId = String(id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || id.programId) : id || '').trim();
  if (!contentId) return null;
  const seed = id && typeof id === 'object' ? normalizeItem(id) : null;
  let knownType = String((seed && seed.type) || itemKinds.get(contentId) || '');
  const explicit = String(opts.type || '').toLowerCase();
  let preferred = explicit || (knownType === 'series' || knownType === 'anime' ? '0' : knownType === 'movie' ? '1' : '');
  if (preferred === 'movie' || preferred === 'movies') preferred = '1';
  if (preferred === 'series' || preferred === 'anime' || preferred === 'tv') preferred = '0';
  const types = preferred ? [preferred, preferred === '0' ? '1' : '0'] : ['1', '0'];

  return cached('meta:' + contentId + ':' + (preferred || 'auto'), CACHE_TTL['v4/getItemData'], async () => {
    let data = {}, fetchedType = preferred || '1';
    for (const t of types) {
      try {
        const response = await api('v4/getItemData', {
          contentId,
          type: t,
          sortType: '0',
          language: 'en',
          macAddr: FIXED_MAC
        });
        const candidate = unwrapDetail(response);
        const hasIdentity = !!(candidate.contentId || candidate.id || candidate.name || candidate.title || candidate.viewPoint || candidate.assetName);
        const hasDetail = !!(candidate.description || candidate.introduction || candidate.desc || candidate.posterList || candidate.simpleProgramList || candidate.sameSeasonSeriesList);
        if (hasIdentity || hasDetail) {
          data = candidate;
          fetchedType = t;
          if (t === '0' || candidate.simpleProgramList || candidate.sameSeasonSeriesList) break;
        }
      } catch (_) {}
    }

    const merged = Object.assign({}, seed || {}, data);
    merged.contentId = String(data.contentId || data.id || contentId);
    if (!(data.name || data.title || data.viewPoint || data.alias) && seed) {
      merged.name = seed.title || seed.name;
    }
    const detailTitleForSeason = String(data.name || data.viewPoint || data.alias || data.title || '');
    const defaultSeason = Number(data.seasonNumber || data.season || parseSeasonFromName(detailTitleForSeason) || 1) || 1;
    const simple = episodeRows(data, contentId, defaultSeason);
    const ptype = String(data.programType || data.contentType || data.type || '').toLowerCase();
    const isSeries = ['teleplay', 'series', 'variety', '0', 'tv'].includes(ptype) || fetchedType === '0' || simple.length > 1 || Array.isArray(data.sameSeasonSeriesList);
    const type = isSeries ? (knownType === 'anime' ? 'anime' : 'series') : 'movie';
    const item = normalizeItem(merged, type);
    item.type = type;
    item.media_type = type;
    item.programType = isSeries ? 'series' : 'movie';
    item.id = String(data.contentId || data.id || contentId);
    item.contentId = item.id;
    item.title = String(data.name || data.viewPoint || data.alias || data.title || data.contentName || data.programName || item.title || contentId);
    item.name = item.title;
    item.description = String(data.description || data.introduction || data.desc || data.contentDesc || data.programDesc || item.description || '');
    item.overview = item.description;
    item.details = data;

    const bySeason = new Map();
    for (const ep of simple) {
      const n = Number(ep.season || 1);
      if (!bySeason.has(n)) bySeason.set(n, []);
      bySeason.get(n).push(ep);
    }

    const siblings = Array.isArray(data.sameSeasonSeriesList) ? data.sameSeasonSeriesList : [];
    const currentSeason = Number(data.seasonNumber || data.season || parseSeasonFromName(item.title) || defaultSeason || 1) || 1;

    if (isSeries) {
      for (const ep of simple) {
        const sn = Number(ep.season || currentSeason) || currentSeason;
        episodeContentIds.set(`${contentId}:${sn}:${Number(ep.number)}`, String(ep.id));
        limitMap(episodeContentIds, MAX_MAP);
      }
    }

    if (isSeries && !bySeason.has(currentSeason) && simple.length) {
      bySeason.set(currentSeason, simple);
    }

    const seasons = [];
    for (const [number, episodes] of Array.from(bySeason.entries()).sort((a, b) => a[0] - b[0])) {
      seasons.push({
        number,
        season: number,
        name: `Temporada ${number}`,
        title: `Temporada ${number}`,
        episodes: episodes.sort((a, b) => a.number - b.number)
      });
    }

    if (isSeries && siblings.length) {
      const links = [];
      const seen = new Set([item.id]);
      for (const sibling of siblings) {
        const sid = String(sibling.contentId || sibling.id || '').trim();
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        const sn = Number(sibling.seasonNumber || sibling.season || parseSeasonFromName(sibling.name || sibling.title || '') || 0) || 0;
        links.push({
          id: sid,
          number: sn,
          name: String(sibling.name || sibling.viewPoint || sibling.title || (sn ? `Temporada ${sn}` : 'Temporada')),
          poster: sibling.poster || sibling.posterUrl || ''
        });
      }
      // Máximo 4 temporadas extra (antes era 6)
      for (const link of links.slice(0, 4)) {
        try {
          const sr = await api('v4/getItemData', {
            contentId: link.id,
            type: '0',
            sortType: '0',
            language: 'en',
            macAddr: FIXED_MAC
          });
          const sd = unwrapDetail(sr);
          const eps = episodeRows(sd, link.id, link.number || Number(sd.seasonNumber || sd.season || parseSeasonFromName(link.name) || 1));
          const n = link.number || Number(sd.seasonNumber || sd.season || parseSeasonFromName(link.name) || seasons.length + 1);
          for (const ep of eps) {
            episodeContentIds.set(`${item.id}:${n}:${Number(ep.number)}`, String(ep.id));
            limitMap(episodeContentIds, MAX_MAP);
          }
          const existing = seasons.find(x => x.number === n);
          if (existing) {
            if (!existing.episodes.length) existing.episodes = eps;
          } else {
            seasons.push({
              number: n,
              season: n,
              name: link.name || `Temporada ${n}`,
              title: link.name || `Temporada ${n}`,
              episodes: eps
            });
          }
        } catch (_) {}
      }
      if (!seasons.length) {
        for (const link of links) {
          seasons.push({
            number: link.number || seasons.length + 1,
            season: link.number || seasons.length + 1,
            name: link.name,
            episodes: []
          });
        }
      }
    }

    if (isSeries && !seasons.length) {
      seasons.push({
        number: currentSeason,
        season: currentSeason,
        name: `Temporada ${currentSeason}`,
        episodes: simple
      });
    }

    seasons.sort((a, b) => Number(a.number) - Number(b.number));
    item.seasons = seasons;
    item.episodes = simple;
    item.seasonSiblings = siblings;
    item.genres = item.genres || [];
    if (item.id) {
      itemKinds.set(item.id, type);
      limitMap(itemKinds, MAX_MAP);
    }
    return item;
  });
}

async function _getStreams(id, type, season, episode) {
  const parentId = String(id && typeof id === 'object' ? (id.contentId || id.id || id.assetId) : id || '').trim();
  if (!parentId) return [];
  const itemTypeHint = String(type || (id && id.type) || itemKinds.get(parentId) || 'movie').toLowerCase();
  const isSeries = ['series', 'anime', 'tv', 'teleplay', '0'].includes(itemTypeHint);
  let playableId = parentId;
  let seriesContentId = '';

  if (isSeries) {
    seriesContentId = String((id && id.seriesContentId) || parentId);
    const sn = Number(season || 1) || 1;
    const en = Number(episode || 1) || 1;
    const key = `${seriesContentId}:${sn}:${en}`;
    playableId = episodeContentIds.get(key) || '';
    if (!playableId) {
      try {
        const meta = await getMeta(seriesContentId, { type: 'series' });
        const foundSeason = (meta && Array.isArray(meta.seasons) ? meta.seasons : []).find(x => Number(x.number) === sn);
        const foundEpisode = foundSeason && Array.isArray(foundSeason.episodes)
          ? foundSeason.episodes.find(x => Number(x.number) === en)
          : null;
        if (foundEpisode && foundEpisode.id) playableId = String(foundEpisode.id);
      } catch (_) {}
    }
    if (!playableId) return [];
    episodeContentIds.set(key, playableId);
    limitMap(episodeContentIds, MAX_MAP);
  }

  const play = await api('v10/startPlayVOD', {
    contentId: playableId,
    seriesContentId,
    type: '1',
    startTime: 0,
    columnId: 0,
    authType: ''
  });

  let mediaCandidates = [];
  const episodeList = listFrom(play, ['episodeList']);
  if (episodeList.length) {
    const wanted = Number(episode || 0);
    let selectedEpisode = episodeList.find(ep => Number(ep.seriesNumber || ep.episodeNum || ep.episode || ep.number || 0) === wanted);
    if (!selectedEpisode && playableId) {
      selectedEpisode = episodeList.find(ep => String(ep.contentId || ep.id || '') === playableId);
    }
    if (!selectedEpisode) selectedEpisode = episodeList[0];
    for (const group of listFrom(selectedEpisode, ['totalMovieList'])) {
      mediaCandidates.push(...listFrom(group, ['movieList']));
    }
  }
  if (!mediaCandidates.length) mediaCandidates = listFrom(play, ['mediaList', 'movieList']);
  if (!mediaCandidates.length && play && play.contentId && play.licenseList) mediaCandidates = [play];
  if (!mediaCandidates.length) return [];

  mediaCandidates.sort((a, b) => {
    const score = m => (String(m.encodeFormat || '').toLowerCase() === 'h264' ? 0 : 2) + (String(m.videoFormat || '').toLowerCase() === 'mp4' ? 0 : 1);
    return score(a) - score(b);
  });

  const media = mediaCandidates[0];
  const licenses = listFrom(media, ['licenseList']);
  const license = licenses.length ? String(licenses[0].license || '') : '';
  if (!license) return [];

  const slb = await api('v14/getSlbInfo', {
    hasPay: '0',
    userIdentity: '1',
    type: 'merge',
    appVer: config().apkVersion,
    lang: 'es',
    encMediaSupported: 1,
    liveCodeList: ['masnew_live'],
    appParams: '',
    reserve1: FIXED_MAC,
    pipFlag: '0'
  });

  const cdns = listFrom(slb, ['cdn_list']);
  let chosen = null;
  for (const cdn of cdns) {
    if (String(cdn.tag) !== 'vod') continue;
    for (const u of listFrom(cdn, ['url_list'])) {
      const url = String(u.url || '');
      if (String(u.tag) === 'free' && (url.includes('cfl') || String(u.sign_type) === 'cfl')) {
        chosen = { cdn, u };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) return [];

  const base = String(chosen.cdn.main_addr || '').replace(/\/$/, '');
  const ext = String(media.videoFormat || '').toLowerCase() === 'ts' ? 'ts' : 'mp4';
  const mediaId = String(media.contentId || playableId || parentId);
  const url = `${base}/vod/${mediaId}_media.${ext}`;

  return [{
    name: 'Magis Service',
    title: 'Magis Service',
    url,
    quality: String(media.definition || media.resolution || 'Auto'),
    type: ext,
    mimeType: ext === 'mp4' ? 'video/mp4' : 'video/mp2t',
    headers: {
      'Content-Auth': String(chosen.u.url),
      'Content-License': license,
      'User-Agent': 'Ranger/4.9.4-17294ac0',
      App: config().appId,
      'App-Version': config().apkVersion
    },
    language: 'Español',
    isHls: false
  }];
}

// ---------- API pública con caché corta ----------
async function getNews() {
  return cached('public:getNews', 90e3, () => _getNews());
}
async function getHome() {
  return cached('public:getHome', 50e3, () => _getHome());
}
async function getDiscoverFilters(filters) {
  const opts = filters && typeof filters === 'object' ? filters : {};
  const type = String(opts.type || opts.kind || 'movie').toLowerCase();
  return cached('public:getDiscoverFilters:' + type, 8 * 60e3, () => _getDiscoverFilters(opts));
}
async function getDiscover(options) {
  const opts = options && typeof options === 'object' ? options : {};
  return cached('public:getDiscover:' + JSON.stringify(opts), 40e3, () => _getDiscover(opts));
}
async function getMeta(id, options) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || id.programId || JSON.stringify(id)) : String(id || '');
  const opts = options && typeof options === 'object' ? options : (typeof options === 'string' ? { type: options } : {});
  return cached('public:getMeta:' + String(keyId) + ':' + JSON.stringify(opts), 4 * 60e3, () => _getMeta(id, opts));
}
async function getStreams(id, type, season, episode) {
  const keyId = id && typeof id === 'object' ? (id.contentId || id.id || id.assetId || JSON.stringify(id)) : String(id || '');
  const key = ['public:getStreams', keyId, type || '', season || '', episode || ''].join(':');
  return cached(key, 18e3, () => _getStreams(id, type, season, episode));
}

module.exports = {
  getNews,
  getHome,
  getDiscoverFilters,
  getDiscover,
  getCatalog,
  search,
  getMeta,
  getStreams,
  getCatalogs
};
