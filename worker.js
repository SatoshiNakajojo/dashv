/**
 * Watchlist & Thèses — Cloudflare Worker v39
 * (Worker JCGI v53)
 *
 * Variables d'environnement requises :
 *   - AUTH_KEY          : secret partagé (doit correspondre à CF_AUTH_KEY côté front)
 *   - GDB_KV            : binding KV namespace
 *   - FMP_API_KEY       : clé API FinancialModelingPrep (SECRET — `wrangler secret put FMP_API_KEY`)
 *   - GEMINI_API_KEY    : clé API Google Gemini (SECRET, gratuite sur aistudio.google.com/apikey)
 *                         — utilisée UNIQUEMENT côté serveur par /screener_scan
 *                         (recherche par conditions, onglet Tracking)
 *
 * Nouveautés v39 :
 *   - Clé KV `cgi_watchlist` ajoutée dans /read et /write-bases
 *     (stocke la watchlist : tickers + thèses + alertes de prix)
 *   - Clé FMP lue uniquement depuis env.FMP_API_KEY (plus aucune clé en dur)
 */

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Key",
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    // #90 — no-store : /read (et toutes les réponses API) ne doivent JAMAIS être mises en cache,
    // sinon le PC relit au boot une ancienne valeur du cloud (le cash matelas modifié ailleurs
    // n'apparaissait pas). L'iPhone contournait déjà via cache-buster ; on le garantit ici pour tous.
    headers: Object.assign({}, CORS_HEADERS, {"Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate"}),
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  #14 — BENCHMARKS : récupère S&P500 / Nasdaq / MSCI World (+ BTC/ETH) et
//  construit la série cgi_bench = [date, BTC, ETH, SP500, Nasdaq, MSCI].
//  Le graphe base-100 de l'app rebase lui-même ces valeurs.
// ════════════════════════════════════════════════════════════════════════════
const _YH_HDRS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};

// Closes quotidiens d'un symbole -> { "YYYY-MM-DD": close }
async function fetchYahooDailyCloses(sym, range) {
  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym)
    + "?interval=1d&range=" + (range || "2y") + "&includePrePost=false";
  var r = await fetch(url, { headers: _YH_HDRS });
  if (!r.ok) { url = url.replace("query1", "query2"); r = await fetch(url, { headers: _YH_HDRS }); }
  if (!r.ok) throw new Error("yahoo " + sym + " " + r.status);
  var d = await r.json();
  var res = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res) throw new Error("no data " + sym);
  var ts = res.timestamp || [];
  var close = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  var out = {};
  for (var i = 0; i < ts.length; i++) {
    if (close[i] != null) {
      var ds = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      out[ds] = Math.round(close[i] * 100) / 100;
    }
  }
  return out;
}

// Construit et stocke cgi_bench
async function buildAndStoreBench(range) {
  var SYMS = { btc: "BTC-USD", eth: "ETH-USD", sp: "SPY", nq: "QQQ", ms: "URTH" };
  var series = {};
  var errors = [];
  for (var k in SYMS) {
    try { series[k] = await fetchYahooDailyCloses(SYMS[k], range || "5y"); }
    catch (e) { series[k] = {}; errors.push(k + ":" + e.message); }
  }
  // Union des dates
  var dateSet = {};
  for (var k2 in series) for (var ds in series[k2]) dateSet[ds] = 1;
  var dates = Object.keys(dateSet).sort();
  var rows = [];
  var last = { btc: null, eth: null, sp: null, nq: null, ms: null };
  for (var di = 0; di < dates.length; di++) {
    var ds2 = dates[di];
    ["btc", "eth", "sp", "nq", "ms"].forEach(function (kk) {
      if (series[kk][ds2] != null) last[kk] = series[kk][ds2];
    });
    rows.push([ds2, last.btc, last.eth, last.sp, last.nq, last.ms]);
  }
  await GDB_KV.put("cgi_bench", JSON.stringify(rows));
  return { ok: true, count: rows.length, first: rows[0] && rows[0][0], last: rows[rows.length - 1] && rows[rows.length - 1][0], errors: errors };
}

// ════════════════════════════════════════════════════════════════════════════
//  #2 — TELEGRAM : notifications hors-ligne (cron). Identifiants via variables
//  d'environnement du Worker : TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID.
// ════════════════════════════════════════════════════════════════════════════
function _tgConfigured() {
  return typeof TELEGRAM_BOT_TOKEN !== "undefined" && TELEGRAM_BOT_TOKEN
      && typeof TELEGRAM_CHAT_ID !== "undefined" && TELEGRAM_CHAT_ID;
}
async function sendTelegram(text) {
  if (!_tgConfigured()) return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID non configurés" };
  var url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
  var r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  var j = await r.json().catch(function () { return {}; });
  return { ok: r.ok && j.ok, status: r.status, resp: j };
}

// Dernier cours d'un symbole (close le plus récent)
async function lastPrice(sym) {
  try {
    var cl = await fetchYahooDailyCloses(sym, "5d");
    var ks = Object.keys(cl).sort();
    return ks.length ? cl[ks[ks.length - 1]] : null;
  } catch (e) { return null; }
}

// #2.6 — Prix + DEVISE réelle depuis Yahoo (meta.currency) — même méthode que l'app.
// Corrige la valorisation des places étrangères : IWDA.L cote en USD (pas en EUR !),
// d'autres titres londoniens cotent en GBp (pence). L'heuristique par suffixe est
// conservée en repli uniquement si la méta est absente.
async function lastPriceCur(sym) {
  try {
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym)
      + "?interval=1d&range=5d&includePrePost=false";
    var r = await fetch(url, { headers: _YH_HDRS });
    if (!r.ok) { url = url.replace("query1", "query2"); r = await fetch(url, { headers: _YH_HDRS }); }
    if (!r.ok) return null;
    var d = await r.json();
    var res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res) return null;
    var close = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
    var px = null;
    for (var i = close.length - 1; i >= 0; i--) { if (close[i] != null) { px = Math.round(close[i] * 100) / 100; break; } }
    if (px == null && res.meta && res.meta.regularMarketPrice != null) px = res.meta.regularMarketPrice;
    return px == null ? null : { px: px, cur: (res.meta && res.meta.currency) || null };
  } catch (e) { return null; }
}

// Conversion valeur native → USD selon la devise (GBPUSD chargé paresseusement via _fxCache)
async function _toUSD(valNative, cur, eurusd, _fxCache) {
  if (cur === "EUR") return valNative * eurusd;
  if (cur === "GBP") {
    if (_fxCache.gbpusd == null) { _fxCache.gbpusd = (await lastPrice("GBPUSD=X")) || 1.30; }
    return valNative * _fxCache.gbpusd;
  }
  return valNative; // USD ou devise inconnue → tel quel
}

// Résumé patrimoine EN LIVE (#36) — prix Yahoo actuels × quantités, repli sur valeur stockée.
// Valeurs live du portefeuille (réutilisé par le résumé texte ET le baromètre image)
async function buildPortfolioNumbers() {
  var get = async function (k) { try { var v = await GDB_KV.get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  var port = await get("cgi_portfolio");
  var yfmap = (await get("cgi_yfmap")) || {};
  var items = (port && port.items) || [];
  var eurusd = 1 / 0.92;
  var fx = await lastPrice("EURUSD=X"); if (fx) eurusd = fx;
  var usdEur = 1 / eurusd;
  var cryptoUSD = 0, stocksUSD = 0, cashUSD = 0, bankEUR = 0, live = 0, fallback = 0;
  // #NEW — KuCoin isolé du reste du cash : il appartient au fonds CGIC (crypto), alors que
  // le cash de plateforme (USD/EURO/STRC) appartient à CGIS. Sans cette ventilation, la NAV
  // par part des deux fonds ne peut pas être recalculée côté Worker.
  var kucoinUSD = 0, cashOtherUSD = 0;
  var _fxCache = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.cat === "Cash Matelas") { bankEUR += (it.valEUR || 0); continue; }
    if (it.cat === "Cash" || ["USD", "EURO", "KUCOIN", "CASH"].indexOf((it.t || "").toUpperCase()) >= 0) {
      var _cv = (it.val != null ? it.val : (it.qty || 0));
      cashUSD += _cv;                                                   // cash $ — poste séparé
      if ((it.t || "").toUpperCase() === "KUCOIN") kucoinUSD += _cv; else cashOtherUSD += _cv;
      continue;
    }
    var sym = yfmap[it.t] || (it.cat === "Crypto" ? it.t + "-USD" : it.t);
    var pc = await lastPriceCur(sym);
    if (!pc || pc.px == null) { if (it.cat === "Crypto") cryptoUSD += (it.val || 0); else stocksUSD += (it.val || 0); fallback++; continue; }
    var px = pc.px;
    var cur = pc.cur || (/\.(AS|PA|MI|DE|BR)$/i.test(sym) ? "EUR" : "USD"); // repli heuristique si méta absente
    if (cur === "GBp") { px = px / 100; cur = "GBP"; }                      // pence → livres
    var valUSD = await _toUSD((it.qty || 0) * px, cur, eurusd, _fxCache);
    if (it.cat === "Crypto") cryptoUSD += valUSD; else stocksUSD += valUSD;
    live++;
  }
  var bankUSD = Math.round(bankEUR * eurusd);
  var totalUSD = Math.round(cryptoUSD + stocksUSD + cashUSD + bankUSD);
  return { totalUSD: totalUSD, totalEUR: Math.round(totalUSD * usdEur), cryptoUSD: Math.round(cryptoUSD),
    stocksUSD: Math.round(stocksUSD), cashUSD: Math.round(cashUSD), bankEUR: Math.round(bankEUR), usdEur: usdEur, live: live, fallback: fallback,
    kucoinUSD: Math.round(kucoinUSD), cashOtherUSD: Math.round(cashOtherUSD) };
}

// #NEW — Parts et capitaux investis lus DIRECTEMENT depuis cgi_inv (le registre des
// mouvements de parts, synchronisé en continu par l'app). Avant, ces valeurs ne venaient
// que de cgi_fund_stats.tsFunds, écrit uniquement par l'onglet JCGI : sans visite de cet
// onglet, la NAV et le P&L des fonds affichés sur le baromètre restaient figés (constaté :
// 30 jours de retard). Les lire ici rend le baromètre autonome.
async function _fundsFromInv() {
  var inv = null;
  try { var raw = await GDB_KV.get("cgi_inv"); if (raw) inv = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(inv) || !inv.length) return null;
  var shC = 0, shS = 0, mC = 0, mS = 0;
  inv.forEach(function (m) {
    if (!m || !m.fonds) return;
    var sign = String(m.io || "IN").toUpperCase() === "OUT" ? -1 : 1;
    var sh = (typeof m.shares === "number") ? m.shares : 0;
    var mt = (typeof m.montant === "number") ? m.montant : 0;
    if (m.fonds === "CGIC") { shC += sh; mC += sign * mt; }
    else if (m.fonds === "CGIS") { shS += sh; mS += sign * mt; }
  });
  return { shC: shC > 0 ? shC : null, shS: shS > 0 ? shS : null,
           mEurC: mC > 0 ? mC : null, mEurS: mS > 0 ? mS : null };
}

async function buildPortfolioSummary() {
  var n = await buildPortfolioNumbers();
  var date = new Date().toISOString().slice(0, 16).replace("T", " ");
  var fmt = function (x) { return Math.round(x || 0).toLocaleString("fr-FR"); };
  return "<b>J.C. GLOBAL INVESTMENTS</b>\n" +
    "🕐 " + date + " UTC\n\n" +
    "💼 Patrimoine : <b>$" + fmt(n.totalUSD) + "</b>  (" + fmt(n.totalEUR) + " €)\n" +
    "₿ Crypto : $" + fmt(n.cryptoUSD) + "\n" +
    "📈 Actions : $" + fmt(n.stocksUSD) + "\n" +
    "💵 Cash : $" + fmt(n.cashUSD) + "\n" +
    "🏦 Banque : " + fmt(n.bankEUR) + " €\n" +
    "<i>" + n.live + " positions live" + (n.fallback ? " · " + n.fallback + " en cache" : "") + "</i>";
}

var BARO_LOGO = "data:image/png;base64,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";
var BARO_FONT = "data:font/ttf;base64,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AeoAIQHqACEB6gAhAnQAIQHUACECof/0Ae4ADQHuAA0B7gANAaQALQHmACEB9QAHAaQALgHqACEBpAAtAZ4AIQEKABUB5gAhAfUABwHqACEC7gAhAzsAFgJbABYEZQAWA4UAFgRjABYDYwAWA2kAFgRVABYDYQAWBF0AFgOdABYEUAAWAzkAFgI/ABYDKwAWAzMAFgJzABYDJwAWAsQABgNdACwCpgAtAo0AHAJFABwCOQAWAjcAFgISABUDbQAUA3cAGwOoACECTAAXAkwAFwIt//kCLf/5Ai3/+QIt//kCLf/5Ai3/+QIt//kCrP/YAgQAHgIVACACFQAgAjcAHgI3AB4B0AAeAdAAHgHQAB4B0AAeAdAAHgGnAB4CKQAgAnUAHgEsACQBLAAkASwAJAEsABsBLAAkASwAFQEPABgCJQAeAdIAHgHSAB4CrgAXAjYADQI2AA0COgAgAjoAIAI6ACACOgAgAjoAIAI6ACACOgAgAdQAHgHSAB4COgAgAh4AHgGcADACGQAEAfQAGQI7ABcCOwAXAjsAFwI7ABcCOwAXAf7//ALf//wCEQANAe0ABAHtAAQB7QAEAcQAJgEPABgBDwAYASwAJAEPABgCHgAeAQ8AGAIt//kB0AAeASwAJAI6ACACOwAXASwAJAEPABgCOgAgAi3/+QIt//kCLf/5AdAAHgHQAB4B0AAeASwAJAEsACQBLAAkAjoAIAI6ACACOgAgAjsAFwI7ABcCOwAXAe0ABAIy//kCMv/5AgQAHgInAB4CQwAgAhwAHgJdAB8CXQAfAl0AHwJdAB8CXQAfAl0AHwJdAB8CXQAfAl0AHwJdAB8C1//8Ai3/+QI6ACACOwAXAeAANgHgADYB4AA2AeAANgHgADYB4AA2AeAANgKEACwBwAAgAcAAIAHAACABwAAgAcAAIAOMAB4CUgAeAlIAHgF6ABoCXQAfAl0AHwJdAB8CXQAfAl0AHwH///wB///8Af///AEsACQBDwAYAqz/2AHQAB4B0AAeAdAAHgHQAB4B0AAeAacAHgIt//kCLf/5Ai3/+QHQAB4B0AAeAdAAHgEsACQBLAAkASwAJAI6ACACOgAgAjoAIAI7ABcCOwAXAjsAFwHtAAQCLf/5AdAAHgEsACQCOgAgAjsAFwI6ACACHAAeAl0AHwI6ACACOgAgAjoAIAJdAB8CMv/5Al0AHwJdAB8B4AA2AeAANgHAACACXQAfAeAANgHgADYB4AA2AcAAIAHAACABwAAgAf///AI7ABcCLf/5AdAAHgEsACQCOgAgAjsAFwJdAB8CXQAfAl0AHwJdAB8CXQAfAl0AHwHgADYB4AA2AeAANgHAACABwAAgAcAAIAJdAB8CXQAfAl0AHwH///wB0AAeAdAAHgHQAB4B4AA2AcAAIAJdAB8CXQAfAl0AHwJdAB8B4AA2AcAAIAJdAB8BHQAdAUIAHQHdAB0BkgAhAYgAHQHGABUBmQA4AdEAKAGtABAB6QAoAdEAHQHdAB0B9QAoAYcAKgG9ABgBswAjAdgADAHAAC8B7QA5Aa0AFQHtACgB6QAoAiMAJQFYACsBwQAhAbwAHAHgAA0BsQA3AfUAMQHcACICOwA9AfUALgFMACsB6wAjAesATgHrADUB6wBMAesAJgHrAEYB6wA5AesARAHrACgB6wAwAesAJAHrAFkB6wBjAesALAHrAGgB6wA6AesAMwHrACQB6wAwAfUAKAH1ACgCIwAlAiMAJQHrACMB6wB7AesAJAEpABUBBgAaAPwAFwD7ABUBDQAMAQIAHAEUABkA8gAWARQAGAEZABkBKQAVAQYAGgD8ABcA+wAVAQ0ADAECABwBFAAZAPIAFgEUABgBGQAZAmMAGgJdABoCUgAVAnsAGgJwABUCdwAcAmcAFgEpABUBBgAaAPwAFwD7ABUBDQAMAQIAHAEUABkA8gAWARQAGAEZABkBKQAVAQYAGgD8ABYA+wAVAQ0ADAECABwBFAAZAPIAFgEUABgBGQAZAOoAAADqAAAAyAAAAMwAMADeACsAzAAwAOUAMQEBAEIBUAAiAMMAKgHAADECDgA6AVwAGgFcABoA/gA/AUcAJQE5ABoBQgAjAMwAMAIOADoBlgAaAZYAGQDMADAA4QAuAMwAMADPADIAzwAyAM8AMgDPADIBQwAbAgMAHQM+AB0BjgAdAW0AFwIOAB0CsgAdARoAGwIDAB0DPgAdAKAAIwCgAAUBNQAzATUAHQEhAB0BGwAdARIASgESACMAoAAjAKAABQESADUBEAAdASEAHQEbAB0BEgBNAQ8AIwE1ADMBNQAdASEAHQEhACMBEgBLARIAIwC+AB4AvAAdAScAIQCTACEBHAAhAJYAIQDeADIA3gArAtYAQwLFAEEAqAA/A18ADQLmADcEDAAaAtYAQwIiACkAqAA/AaIANAJLACcCAwBHAq0AMwGOAB0BjgAdAYkAPQGOAB0B1AAdAZcAHgGXAB8BuwAvAYgAOQI+ABUBjgAdAcgAHQHIAB0BiQA9AcgAHQHUAB0BlwAeAZcAHwIlADoCrQAVAY4AHQGOAB0BiQA9AY4AHQHUAB0BlwAeAZcAHwHEAC8BiAA5Aj4AFQDVAB0BEgAQABAAAAABAAADnP7hAAAFFv+Y/QIFrQPoAAAAAAAAAAAAAAAAAAACvAAEAiICWAAFAAACigJYAAAASwKKAlgAAAFeADIA6AAAAAAAAAAAAAAAAIAAAAMAAABCAAAAAAAAAABOT05FAMAAICISA5z+4QAABEkBGwAAAAEAAAAAAYICcQAAACAAAwAAAAIAAAADAAAAFAADAAEAAAAUAAQBngAAABQAEAADAAQAfgCgALcA/yAJIBQgGSCsIhL//wAAACAAoAC3AMAgCSATIBggrCIS//8AAAGrAZwAAOJD4lXib+Ht4IsAAQAUAAAAAADMAAAAAAAAAAAAAAAAAkoCUQKJAlUCmAKlApACigJzAnQCVAKcAk4CZwJNAlYB4gIAAeMB5AHlAeYB5wHoAekB6gJPAlACogKgAqECUgKPAEYAAgBNAAMABQAKAE8ACwAMABEAEgATABUAFgAYAB8AIQBQACIAIwAkACkAKgArACwALgJ3AlcCeAKkAmoCugC9AIYAhwCJAMUAiwDKAIwAjQCTAJQAlQCXAJgAmgChAKMApAClAKYApwCsAK0ArgCvALICdQKRAnYCowBKAEcASABMAEkASwABAE4ACQAGAAcACAAQAA0ADgAPAAQAFwAcABkAGgAeABsCngAdACgAJQAmACcALQAgAMsAwQC+AL8AwwDAAMIAxACIAMkAxgDHAMgAkgCOAI8AkACKAJkAngCbAJwAoACdAp8AnwCrAKgAqQCqALAAogCxAAC4Af+FsASNAAAAAAsAigADAAEECQAAAKQAAAADAAEECQABADYApAADAAEECQACAA4A2gADAAEECQADAEoA6AADAAEECQAEADYApAADAAEECQAFABoBMgADAAEECQAGADQBTAADAAEECQEHABABgAADAAEECQELAAwBkAADAAEECQEMAAwBnAADAAEECQENAAoBqABDAG8AcAB5AHIAaQBn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AAAAAP/pAAAAAAAAAAD/vf+uAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MAAAAAAAAAAAAA/8YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/7UAAAAA/+0AAAAXAAAAFAAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9P/0AAAAAAAAAAAAAAAAAAAAAAAA/+kAAP/OAAAAAP/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/0f/R/7oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/pAAAAAAAA/8n/wP/xAAD/3QAvAAAAAAAXAAMAFwAXABcAIwAXAAAAAP/pAAAAAAAA/+kAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAA//oAAAAAAAAAAAAAAAAAAP/6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+4AAP/pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/uAAAAAAAAAAAAAAAAAAAAAAAA/+kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+7/3QAA/+kAAAAAAAAAAP/rAAAAAAAAAAD/xgAAAAAAAAAAAAAAAAAA//0AAP/GAAAAAAAAAAD/6wAAAAAAAAAAAAAAAP/OAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/3QAA/8YAAAAA/+X/6f/d/+n/3QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/7//0AAAAAAAAAAAAFwAAABQAAAAAAAAAAAAAAAD//v/0AAAACf/RAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/dAAD/9AAAAAAAAAAAAAAAAAAAAAAAAP/0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/4AAAAAAAAAAAAAAAAAAAAAP/dAAAAAAAAAAAAAAAAABcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/d/8b/3f+6/+MAAP+l/6r/yv/d/9H/kwAA/9EAFwAA/8YAAAAAAAAAAP/Y/93/qP+aAAD/6f+0/7r/6QAA/5MAAAAAAAAAAAAAAAD/xgAAAAD/9gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/6f/JAAD/xv/lAAD/tf+N/6L/6f/d/7b/5//RABcAAP/pAAAAAAAAAAAAAP/Y/7T/rgAAAAD/l//R/+kAAP+2/+EAAAAAAAAAAAAA/+YAAAAA/93/4P/u/9H/y//pAAAAAAAAAAD/7v/AAAD/xgAA/9H/3f/G/7r/rv/XAAAAAAAA/+7/0QAAAAAAAAAA/+4AAAAAAAAAAAAAAAD/0QAA/93/xv/d/9H/8AAA/67/ov+6/93/3f+uAAD/ugAjAAD/rgAAAAAAAAAAAAD/3f+u/7oAAP/p/7r/xgAAAAD/rgAAAAAAAAAAAAAAAP+uAAAAAP/lAAAAAAAAAAAAAP/pAAAAAAAAAAAAEwAAAC8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/0AAAALAAAAAAAAAAA//QAAAAAAAAAAAAAABIAIwAAAAAAAAAA//oAAAAAAAAAAAAAAAAAAP/6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//0AAAAAAAAAAAAAAAD/+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//QAAAAAAAD/7gAAAAAAAAAA//0AAAAAAAAAAAAAAAAAAP/wAAAAAAAAAAAAAAAA/+4AAAAAAAAAAAAAAAD//QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/vf+uAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9AAAAAAAAAAAAAAAAAAA//QAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//T/8gAAAAD/3QAAAAAAAP/0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIwAAAAAAAAAAAAAAAAAA/+kAAP+1/4L/xgAAAAAABgAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+kAAAAAAAAAAAAAAAAAAAAA/9cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9AAAAAAAAAAA//f/xv/L/+IAAP/pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/j/+MAAAAA/8YAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+n/6f/xAAD/7QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/rAAAAAP/GAAAAAAAA/+0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQUAAgADAAQACgARABIAEwAUABgAGQAaABsAHAAdAB4AHwAgACEAIwAkACUAJgAnACgAKQAqACsALAAtADAAMQAyADUANgA4ADkAOgA7AD0APgA/AEAARgBHAEgASQBKAEsATABQAFYAWABZAFoAWwBcAGMAZABlAGYAZwBoAGkAawBsAG0AbgBxAHQAdwB4AHkAggCDAIQAhQCGAIcAiACMAJAAlACXAJgAmQCaAJ8AoQCiAKMApAClAKcArACtAK8AsACxALQAtQC8AL0AxADFAMYAxwDIAMkAygDMANMA1QDfAOUA5wDpAOwA7gDwAPEA8wD0APYA+AD7AP8BAAEBAQQBBQEGAQcBCAEJAQoBDQEOAQ8BEAEWASABIQEiASYBJwEoASkBKgErASwBLQEvATABMwE0ATUBNgE3ATgBOQE6ATwBPQE+AUEBRAFGAUkBSgFNAU4BTwFQAVcBWAFZAVoBWwFcAV0BXgFfAWEBYgFjAW4BcAGIAYkBigGTAZQBlQGWAZ0BngGfAaABoQGiAaMBpAGnAagBqQGqAawBrQGuAbUBvQG/AcIBwwHTAdgB3gHiAkACQQJCAkMCRAJFAkYCRwJIAkkCTQJOAlICUwJUAlYCXAJiAmMCZQJnAmgCaQJqAmsCbAJtAm4CbwJwAnkCegKHAogCiQKKAosCjAKNAo4CowKmAq4AAgCQAAIAAgAoAAMABAABAAoACgApABEAEQAdABIAEgAPABMAFAAQABgAHgABAB8AHwAkACAAIQABACMAIwAYACQAKAADACkAKgAWACsAKwAiACwALQAUADAAMAAdADEAMgABADUANQABADYANgADADgAOAAdADkAOQABADoAOwAFAD0APQAdAD4APgAPAD8APwABAEAAQAAXAEYATAAFAFAAUAAXAFYAVgAWAFgAWAABAFkAWQADAFoAXAAFAGMAZQABAGYAaAADAGkAaQAUAGsAawABAGwAbAAXAG0AbQAFAG4AbgABAHEAcQAFAHQAdAAFAHcAdwABAHgAeAADAHkAeQABAIIAggARAIMAgwAYAIQAhAAHAIUAhQADAIYAhgAGAIcAhwAbAIgAiAAMAIwAjAAHAJAAkAAnAJQAlAANAJcAmQAHAJoAmgAGAJ8AnwAGAKEAogAGAKMAowArAKQApAAfAKUApQAhAKcApwASAKwArQARAK8ArwARALAAsQAcALQAtAAqALUAtQAMALwAvAAaAL0AvQASAMQAxQAbAMYAyQAMAMoAygAaAMwAzAASANMA0wAbANUA1QARAN8A3wAMAOUA5QAGAOcA5wAGAOkA6QAHAOwA7AANAO4A7gAGAPAA8AASAPEA8QAHAPMA8wANAPQA9AAGAPYA9gASAPgA+AAGAPsA+wANAP8BAQAaAQQBCgAEAQ0BDgAVARYBFgAmASABIAAOASEBIgAQAS0BLQAjATABMAAJATMBMwATATQBOAACATkBOgAIATwBPgAZAUEBQQAdAUQBRAAJAUYBRgAEAUoBSgACAU4BUAAEAVoBXAACAV0BXQAZAV4BXwAEAWEBYQAOAWMBYwAJAW4BbgAIAYgBigAIAZMBkwAmAZQBlgAEAaABogACAaMBowAZAaQBpAAEAagBqAACAaoBqgAJAbUBtQAlAb0BvQAIAb8BvwAEAcMBwwACAdMB0wAIAdgB2AAlAd4B3gAlAeIB4gAeAkACSQALAk0CTgAgAlICUgAsAlMCUwAKAlQCVAALAlYCVgALAlwCXAAKAmICYgAKAmMCYwAgAmUCZQAgAmcCaQAKAmoCagAgAmsCcAAKAnkCegALAocCjgALAqMCowAKAqYCpgALAq4CrgAKAAIA1QABAAEACQAYAB4ABQAhACEABQAiACIAGgAjACMAFQAkACgABgApACoAFAArACsAHwAsAC0AEwAuAC4AIwAxADIABQA1ADUABQA2ADYABgA5ADkABQA6ADsACQA/AD8ABQBBAEUABgBGAEwACQBNAE8ABQBRAFUABgBWAFYAFABXAFcACQBYAFgABQBZAFkABgBaAFwACQBjAGUABQBmAGgABgBpAGkAEwBqAGoABgBrAGsABQBtAG0ACQBuAG4ABQBwAHAABgBxAHEACQByAHMABgB0AHQACQB3AHcABQB4AHgABgB5AHkABQB6AIEABgCCAIIABQCDAIQAFQCFAIUABgCGAIYAEACHAIcADACIAIgABACJAIkADACKAIoABACMAIwAEACNAI4AIQCQAJAAJQCTAJMAJgCUAJYAEACXAJgABwCaAJoADACbAJ4ABACfAJ8ADACgAKAABAChAKEABwCiAKIAEACjAKMADACkAKQABwClAKUAHQCmAKgABwCsAK0AEQCuAK4ABwCvAK8AJwCwALEAGwCyALIABwC1ALUABAC2ALYAIQC3ALcABAC5ALkAIQC6ALoAJgC7ALsADAC8ALwAGAC9AL0AGQC+AMMACgDEAMQAGQDFAMUADADGAMkABADKAMoAGADMAMwADADNANIABADTANQADADVANUAEQDWANYABwDZANkACgDaANoABADcANwACgDdAN0ABADeAN4ACgDfAN8ABADgAOAAIQDhAOEABADjAOMABADkAOQADAD3APcABwD4APkAHQD7APsABwD/AQAAGAEBAQEADAECAQMAAQEEAQsACAEMAQwAAQENAQ4AAgEPARYAAQEXARcAAgEYARkAAQEfASUAAQEmASwAAgEtAS4AAQEvAS8AAgEwATAAAQExATEAFwEzATMAEgE0ATgAAwE5AToADQE8AT4AFgFBAUUAAQFGAUYACAFHAUcAAQFJAUkAAgFKAUoAAwFLAUwAAQFNAU0AAgFOAVAACAFRAVMAAQFXAVkAAgFaAVwAAwFdAV0AFgFeAV8ACAFhAWEAAQFiAWIAAgFjAWMAAQFkAW0AAwFuAW4ADQFvAW8ACAFwAXAAAgFxAXEAAwFyAXkACwF6AX4AAgF/AYEAAQGDAYcAAwGIAYoADQGNAY0ACAGOAZMAAQGUAZYACAGXAZkAAQGdAZ8AAgGgAaIAAwGjAaMAFgGkAaQACAGlAaUAAQGnAacAAgGoAagAAwGpAakAAgGqAaoAAQGrAasAAwGsAa4AAgGvAa8AAwGwAbAACAGxAbIAAwGzAbQACwG1AbUAAgG2AbYAAwG3AbkACwG6AbwAAgG9Ab0ADQG+Ab4AAwG/Ab8ACAHAAcAAAQHCAcIAAgHDAckAAwHKAcwACwHNAc8AAgHQAdIAAwHTAdMADQHUAdYAAQHXAdcACwHYAdgAAgHZAdwAAwHdAd0ACwHeAd4AAgHfAd8AAwHiAeIAIAHkAeQAIgHlAeUAJAHmAeYAIgHoAegAIgH6AfoAJAH7AfsAIgJAAkkADwJNAk4AHAJPAlAAHgJTAlMADgJUAlQADwJWAlYAHAJcAlwADgJgAmEAHgJiAmIADgJjAmMAHAJkAmQAHgJlAmUAHAJmAmYAHgJnAmkADgJqAmoAHAJrAnAADgJ5AnoADwKHAo4ADwKjAqMADgKmAqYADwKuAq4ADgACAAgAAQAIAAIAoAAEAAABBgFwAAgACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOv/pAAD/3QAA/8YAAAAAAAD/6QAAAAAAAAAAAAAAAAAAAAD/6QA6AAAAAP/pAAAAAAAAAAAAAP/dAAAAAAAA/9QAAAAAAAAAAAAAAAAAAP/2AAAAAAAAAAAAAP/pAAAAAAAAAAAAAAAAAAAALAAAAAAAAAAAAAAAAAABADEB4gHlAegB8wH1Af0CQAJBAkICQwJEAkUCRgJHAkgCSQJNAk4CUgJTAlQCVgJcAmICYwJlAmcCaAJpAmoCawJsAm0CbgJvAnACeQJ6AocCiAKJAooCiwKMAo0CjgKjAqYCrgACABEB4gHiAAIB5QHlAAUB6AHoAAQB8wHzAAQB9QH1AAYB/QH9AAQCQAJJAAECTQJOAAMCUgJSAAcCVAJUAAECVgJWAAECYwJjAAMCZQJlAAMCagJqAAMCeQJ6AAEChwKOAAECpgKmAAEAAgAdAeIB4gAFAeQB5AAGAeUB5QAHAeYB5gAGAegB6AAGAfoB+gAHAfsB+wAGAh8CHwAIAkACSQACAk0CTgADAk8CUAAEAlMCUwABAlQCVAACAlYCVgADAlwCXAABAmACYQAEAmICYgABAmMCYwADAmQCZAAEAmUCZQADAmYCZgAEAmcCaQABAmoCagADAmsCcAABAnkCegACAocCjgACAqMCowABAqYCpgACAq4CrgABAAEAAAAKAwIE4gADREZMVAAUY3lybAAUbGF0bgAYAD4AAAA6AAlBWkUgAHxDQVQgAMBDUlQgAQRIVU4gAUhLQVogAYxOTEQgAdBQTEsgAhRUQVQgAlhUUksgApwAAP//AB4AAAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANABcAGAAZABoAGwAcAB0AHgAfACAAIQAiACMAJAAlACYAAP//AB8AAAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANAA4AFwAYABkAGgAbABwAHQAeAB8AIAAhACIAIwAkACUAJgAA//8AHwAAAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0ADwAXABgAGQAaABsAHAAdAB4AHwAgACEAIgAjACQAJQAmAAD//wAfAAAAAQACAAMABAAFAAYABwAIAAkACgALAAwADQAQABcAGAAZABoAGwAcAB0AHgAfACAAIQAiACMAJAAlACYAAP//AB8AAAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANABEAFwAYABkAGgAbABwAHQAeAB8AIAAhACIAIwAkACUAJgAA//8AHwAAAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0AEgAXABgAGQAaABsAHAAdAB4AHwAgACEAIgAjACQAJQAmAAD//wAfAAAAAQACAAMABAAFAAYABwAIAAkACgALAAwADQATABcAGAAZABoAGwAcAB0AHgAfACAAIQAiACMAJAAlACYAAP//AB8AAAABAAIAAwAEAAUABgAHAAgACQAKAAsADAANABQAFwAYABkAGgAbABwAHQAeAB8AIAAhACIAIwAkACUAJgAA//8AHwAAAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0AFQAXABgAGQAaABsAHAAdAB4AHwAgACEAIgAjACQAJQAmAAD//wAfAAAAAQACAAMABAAFAAYABwAIAAkACgALAAwADQAWABcAGAAZABoAGwAcAB0AHgAfACAAIQAiACMAJAAlACYAJ2FhbHQA7GMyc2MA9GNhbHQA+mNhc2UBBGNjbXABCmN2MDEBEmN2MDIBGGN2MDUBHmRsaWcBJGRub20BKmZyYWMBMGhsaWcBNmxpZ2EBPGxudW0BQmxvY2wBSGxvY2wBTmxvY2wBVGxvY2wBWmxvY2wBYGxvY2wBZmxvY2wBbGxvY2wBcmxvY2wBeG51bXIBfm9udW0BhG9yZG4BinNpbmYBknNtY3ABmHNzMDEBnnNzMDMBpHNzMDQBqnNzMDUBsHNzMDYBtnNzMTIBvHNzMTMBwnN1YnMByHN1cHMBznRudW0B1Hplcm8B2gAAAAIAAAABAAAAAQAjAAAAAwAdAB8AIQAAAAEAJQAAAAIAAgAEAAAAAQAoAAAAAQApAAAAAQAqAAAAAQArAAAAAQAVAAAAAQAWAAAAAQAmAAAAAQAsAAAAAQAaAAAAAQAGAAAAAQAOAAAAAQAHAAAAAQALAAAAAQAIAAAAAQAMAAAAAQANAAAAAQAJAAAAAQAKAAAAAQAUAAAAAQAcAAAAAgAXABkAAAABABIAAAABACQAAAABAC0AAAABAC4AAAABAC8AAAABADAAAAABADEAAAABADIAAAABADMAAAABABEAAAABABMAAAABABsAAAABACcANABqA+QKGgpoCjQKaAp8CnwKfAp8CnwKkArKCuwLAAtCC2ILgguCC74MAgwkDEYMtgz8DR4NQA2GDeIOTA/wEAoQLBBAEIoQqBIsE2YUTBRsFJIUoBS0FMgVeBZWFugXbhfAGGoYhBiwAAEAAAABAAgAAgG6ANoBCwEPARABEQEUARYBGAEcASEBIgEjASQBJQErASwBLQEuATEBMwE5ATsBPAE/AUABQQFCAHEAegB7AHIAfAEJAQoBDQEOARcAfQB+AHMAfwFOAU8BUAFRAVIBUwFUAVUBVgFXAVgBWQFaAVsBXAFdAIAAgQGkAaUBpgGnAagBAwEMAQ0BDgEPARABGAEbARwBHQEeASABIQEiASMBJAElASgBKgErASwBLQEuATABMQEzATQBNgE4ATkBOwE/AUUBSwGuAREBEwEUARUBMgDjAaQBpQGmAacBqAEDAXcBeAFgAZMBiwGaAZsBnAGMAWEBfwGAAYEBnQGeAXABnwFiAWMBggFuAYgBigGqAcEBwgFFAbcBuAG5AboBuwG8Ab0BsAHEAcUBsQHGAccByAGyAckBvgHKAcsBswHMAc0BzgHPAdAB0QHSAdMB1AHVAdYB1wHYAdsBqQGsAdwB2QHaAd0B3gHfAhcCGQIMAg0CDgIPAhACEQISAhMB7gHvAfAB8QHyAfMB9AH1AesB7QJhAlgCWQJdAmUCZgKNAo4CiwKMApYClwKUApICmgKbApgCmQK4AAEA2gABAAMABAAFAAgACgALAA8AEwAUABUAFgAXAB0AHgAfACAAIgAjACkAKwAsAC4ALwAwADcAOwBCAEMARABFAEsATABNAE4ATwBSAFMAVABVAFoAWwBcAF0AXgBfAGAAYQBiAGMAZABlAGYAZwBoAGkAagBwAHQAdQB2AHcAeACFAIYAhwCIAIkAigCMAI8AkACRAJIAlACVAJYAlwCYAJkAnACeAJ8AoAChAKIApAClAKYApwCpAKsArACuALIAswC5ALsAxQDHAMgAyQDLAN0A3gDfAOAA4QDiAP4BCQEKAQwBFgEZARoBGwEeAR8BIAEjASQBJQEnASgBKQEqAS8BMAEzAToBPAE+AUQBSAFJAUwBTgFPAVABUQFSAVMBXQFfAWUBZgFnAWgBagFrAWwBbQFxAXMBdAF1AXYBewF8AX4BhAGFAYcBiQGPAZABkgGkAaUBqwGtAa4BrwGxAbIBtAG1AbYB9gICAgMCBAIFAgYCBwIIAgkCCgIMAg0CDgIPAhACEQISAhMCFAIZAlACUQJSAlUCYwJkAocCiAKJAooCkAKRApIClAKYApkCmgKbAqQAAwAAAAEACAABBRgAiQEYAR4BJgEsATIBOAFAAUYBTAFWAkIBXAFmAWwBcgF4AYQBjAGYAaIBrAG2AbwBwgHIAc4B1AHeAeQB6gHyAfoCAAIIAg4CFgIcAiICKAIuAjYCPAJCAkgCTgJUAloCYAJmAmwCcgJ4An4ChAKKApAClgKcAqQCrAKyAroCwALGAswC0gLYAuAC6ALuAvQC+gMAAwgDDgMUAxoDIgMqAzADOANAA0oDVANeA2gDbgN0A3oDhAOWA6YDtgPGA9YD5gP2BAYEFgQcBCQEKgQwBDYEPARCBEgETgRUBFoEagRwBHYEfASEBIoEkASWBJwEogSoBLIEvATCBMgEzgTUBNoE4gToBO4E9AT6BQAFBgUMBRIAAgEMADwAAwAzARIAXQACARMAXgACARUAXwACADcBGQADADQBGgBgAAIBGwBhAAIBHgBiAAQAOAEfADAAPQACASAAPgAEADUAOQEnAGMAAgEoAGQAAgEpAFgAAgEqAGUABQBuAS8AMQAyAD8AAwE0AEEAUQAFADYBNQBCAFIAZgAEATYAQwBTAGcABAE3AEQAVABZAAQBOABFAFUAaAACAToAVgACAT0AaQACAUcAdQACAUgAdgACAUkAdwAEAUoAagBwAHgAAgAvAUMAAgFNAHkAAwHgAQQAOgADAG0BBQBaAAIBBgBbAAMBBwA7AFcAAgEIAFwAAwBvATAAQAACAUYAdAACAa0AawACAUQAbAACARYAtAADAJEAuQEZAAIAtgEaAAIAugEfAAIB4QEmAAIAtwEnAAIBKQDaAAIAuwEvAAIAuAE1AAIBNwDbAAIBOgDVAAIBPADWAAIBPQDXAAIBPgDYAAIBRwDfAAIBSADgAAIBSQDhAAIBSgDiAAIAswFMAAMB4AEEAMwAAwDcAQUAzQACAQYAzgADAQcAzwDZAAIBCADQAAIBCQDRAAIBCgDSAAIBCwDTAAIAtQESAAMBFwC8ANQAAwFGAN0A3gACAP8BAQACAV4BcgACAXMBlAACAXQBlQADAV8BbwF1AAIBdgGWAAIBeQGNAAIBegGOAAMBewGPAZcAAwF8AZABmAACAX0BkQADAX4BkgGZAAMBZAFpAYMABAFlAWoBhAGgAAQBZgFrAYUBoQAEAWcBbAFxAYYABAFoAW0BhwGiAAIBiQGjAAIBtAG/AAIBtQHAAAQBqwGvAbYBwwAIAjYCQAIlAhsB7AILAfYB6wAHAjgCQgInAh0B7gIMAfgABwI5AkMCKAIeAe8CDQH5AAcCOgJEAikCHwHwAg4B+gAHAjsCRQIqAiAB8QIPAfsABwI8AkYCKwIhAfICEAH8AAcCPQJHAiwCIgHzAhEB/QAHAj4CSAItAiMB9AISAf4ABwI/AkkCLgIkAfUCEwH/AAICFAIWAAMCAQHiAhUAAgICAgAAAgIDAeMAAgIEAeQAAgIFAeUAAgIGAeYAAgIHAecAAgIIAegAAgIJAekAAgIKAeoABwI3AkECJgIcAe0CGQH3AAICCwIYAAIB7AIaAAICZQJjAAMCZgJgAmQAAgJiAlwAAgJaAl4AAgJbAl8AAgJuAmsAAgJvAmwAAgJwAm0ABAJxAnkCewKBAAQCcgJ6AnwCggACAn0CgwACAn4ChAACAn8ChQACAoAChgACApUCkwADAqYCsAKnAAICsQKoAAICsgKpAAICswKqAAICtAKrAAICtQKsAAICtgKtAAICtwKuAAICuQKvAAICvAK7AAEAiQACAAYABwAJAAwADQAOABAAEQASABgAGQAaABsAHAAhACQAJQAmACcAKAAqAC0AMwA0ADUANgA4ADkARgBHAEgASQBKAFAAbQBuAG8AiwCNAI4AkwCaAJsAnQCjAKgAqgCtAK8AsACxALUAtgC3ALgAugC9AL4AvwDAAMEAwgDDAMQAxgDKANwBAAEEAQUBBgEHAQgBCwERARIBEwEUARUBNAE1ATYBNwE4AT0BRgFHAUoB4gHjAeQB5QHmAecB6AHpAeoB6wHsAe0B7gHvAfAB8QHyAfMB9AH1AgACAQILAk0CTwJTAlYCVwJnAmgCaQJzAnQCdQJ2AncCeAKPApwCnQKeAp8CoAKhAqICowKlAroABgAAAAEACAADAAEAQAABAFQAAAABAAAAAwAGAAAAAgAKABwAAwAAAAEAOAABACQAAQAAAAUAAwABABIAAQAmAAAAAQAAAAUAAQABArsAAQAAAAEACAABAAYAAQABAAECugABAAAAAQAIAAEABgAEAAEAAQCNAAEAAAABAAgAAgAaAAoAMwA0ADUANgBtALYAtwC4ANwAtQABAAoABgANABkAJQBHAI4AmwCoAL4AxgABAAAAAQAIAAIADgAEADcAOAC5ALoAAQAEAAwAEQCNAJMAAQAAAAEACAABAAYAIAABAAEAGQAGAAAAAQAIAAEACgACABIAJgABAAIAEwCVAAEABAAAAAICUwABABMAAQAAABAAAQAEAAAAAgJTAAEAlQABAAAADwAEAAAAAQAIAAEAEgABAAgAAQAEAJYAAgJTAAEAAQCVAAQAAAABAAgAAQASAAEACAABAAQAFAACAlMAAQABABMAAQAAAAEACAACAB4ADAI2AjgCOQI6AjsCPAI9Aj4CPwI3AnECcgACAAMB4gHqAAACAAIAAAkCcwJ0AAoAAQAAAAEACAACACAADQJAAkICQwJEAkUCRgJHAkgCSQJBAnkCegKmAAIABAHiAeoAAAIAAgAACQJzAnQACgKcApwADAABAAAAAQAIAAIA4gAKAiUCJwIoAikCKgIrAiwCLQIuAiYAAQAAAAEACAACAMAACgIbAh0CHgIfAiACIQIiAiMCJAIcAAQAAAABAAgAAQBcAAQADgAkADAAPAACAAYADgIzAAMCVgHpAjEAAwJWAeUAAQAEAjQAAwJWAekAAQAEAjUAAwJWAekAAwAIABAAGAIyAAMCVgHpAjAAAwJWAeUCLwADAlYB4wABAAQB5AHmAegCAAAGAAAAAgAKACQAAwABACwAAQASAAAAAQAAABgAAQACAEYAvQADAAEAEgABAkQAAAABAAAAGAACAAIB4gHqAAACAAIAAAkAAQAAAAEACAACAA4ABAHhAeAB4QHgAAEABAAYAEYAmgC9AAQAAAABAAgAAQAUAAEACAABAAQCkgADAJoCTQABAAEAFgABAAAAAQAIAAIAIgAOAewB7gHvAfAB8QHyAfMB9AH1AhQB7QKUApoCmwACAAQB4gHrAAACAAIAAAoCkgKSAAsCmAKZAAwAAQAAAAEACAACADIAFgILAgwCDQIOAg8CEAIRAhICEwIBAgICAwIEAgUCBgIHAggCCQIKAhkCZQJmAAIABQHiAeoAAAHsAfUACQIAAgAAEwJNAk0AFAJPAk8AFQABAAAAAQAIAAIAOgAaAeICAAHjAeQB5QHmAecB6AHpAeoCCwIZAgwCDQIOAg8CEAIRAhICEwHrAmUCZgKSApgCmQACAAYB7AH1AAACAQIKAAoCFAIUABQCYwJkABUClAKUABcCmgKbABgABgAAAA4AIgA8AFYAcgCMAKYAwADaAPQBDAEkAUIBXAF+AAMAAAABBkAAAQASAAEAAAAeAAEAAgAkAKcAAwAAAAEGJgABABIAAQAAAB4AAQACACUAqAADAAAAAQYMAAEAEgABAAAAHgABAAMAOgBGAL0AAwAAAAEF8AABABIAAQAAAB4AAQACAEcAvgADAAAAAQXWAAEAEgABAAAAHgABAAIABQDFAAMAAAABBbwAAQASAAEAAAAeAAEAAgAGAMYAAwAAAAEFogABABIAAQAAAB4AAQACABgAmgADAAAAAQWIAAEAEgABAAAAHgABAAIAGQCbAAMAAAABBW4AAQASAAEAAAAeAAEAAQAsAAMAAAABBVYAAQASAAEAAAAeAAEAAQAtAAMAAAABBT4AAQASAAEAAAAeAAEABAApACoArACtAAMAAAABBSAAAQASAAEAAAAeAAEAAgBQAKQAAwAAAAEANAABABIAAQAAAB4AAQAGAJoAmwC9AL4AxQDGAAMAAAABABIAAQAYAAEAAAAeAAEAAQCjAAEABQCkAKcAqACsAK0AAQAAAAEACAACAAoAAgBuALsAAQACACEAowAGAAAAAQAIAAMAAAABACgAAQASAAEAAAAgAAEAAgABAFAAAQAAAAEACAABAAYAHwABAAEAUAAGAAAAAQAIAAEAVgADAAwAHgAwAAEABAABAA0AAQAAAAEAAAAiAAEABAABAI4AAQAAAAEAAAAiAAEABAABARoAAQAAAAEAAAAiAAEAAAABAAgAAgAMAAMALwCzAUUAAQADADgAugFMAAEAAAABAAgAAgESAIYBCwEMAQ8BEAERARIBEwEUARUBFgEYARkBGgEbARwBHgEfASABIQEiASMBJAElASYBJwEoASkBKgErASwBLQEuAS8BMQEzATQBNQE2ATcBOAE5AToBOwE8AT0BPwFAAUEBRwFIAUkBSgFCAUMBTQEEAQUBBgEHAQgBCQEKAQ0BDgEXATABTgFPAVABUQFSAVMBVAFVAVYBVwFYAVkBWgFbAVwBXQFGAa0BRAGkAaUBpgGnAagBAwH2AfgB+QH6AfsB/AH9Af4B/wIWAfcCYAJhAlgCWQJiAloCWwJuAm8CcAJ7AnwCfQJ+An8CgAKLAowClQKWApcCsAKxArICswK0ArUCtgK3ArgCuQK8AAIAEQABADAAAAAzADkAMABGAFAANwBaAGkAQgBtAG8AUgB0AHgAVQCFAIUAWgHiAesAWwIAAgAAZQJPAlMAZgJWAlcAawJnAmkAbQJzAngAcAKJAooAdgKPApEAeAKcAqUAewK6AroAhQABAAAAAQAIAAIA2gBqAQwBDQEOAQ8BEAEWARgBGQEaARsBHAEdAR4BHwEgASEBIgEjASQBJQEmAScBKAEpASoBKwEsAS0BLgEvATABMQEzATQBNQE2ATcBOAE5AToBOwE8AT0BPgE/AUUBRwFIAUkBSgFLAUwBrgEEAQUBBgEHAQgBCQEKAQsBEQESARMBFAEVARcBMgFGAaQBpQGmAacBqAEDAfYB+AH5AfoB+wH8Af0B/gH/AhYB9wJgAmECYgJuAm8CcAKVApYClwKwArECsgKzArQCtQK2ArcCuAK5ArwAAgAOAIYAswAAALUAuwAuAL0AywA1ANwA3ABEAN4A4gBFAP4A/gBKAeIB6wBLAgACAABVAk8CUABWAlMCUwBYAmcCaQBZAo8CkQBcApwCpQBfAroCugBpAAEAAAABAAgAAgBwADUAMAHsAe4B7wHwAfEB8gHzAfQB9QIUAe0B7AHuAe8B8AHxAfIB8wH0AfUB7QJjAmQCXAJdAl4CXwJrAmwCbQKBAoICgwKEAoUChgKNAo4CkwKUApoCmwKnAqgCqQKqAqsCrAKtAq4CrwK7AAEANQARAeIB4wHkAeUB5gHnAegB6QHqAesCAAILAgwCDQIOAg8CEAIRAhICEwIZAk0CTwJTAlUCVgJXAmcCaAJpAnMCdAJ1AnYCdwJ4AocCiAKPApICmAKZApwCnQKeAp8CoAKhAqICowKlAroABAAAAAEACAABABIAAQAIAAEABAD7AAIAsgABAAEApgABAAAAAQAIAAIAEAAFAesCFQIXAhgCGgABAAUB4gHsAfYCAQILAAEAAAABAAgAAQAUABAAAQAAAAEACAABAAYAEQABAAEAIQABAAAAAQAIAAEABgApAAEAAQCLAAQAAAABAAgAAQCQAAoAGgAkAC4AOABMAFYAaAByAHwAhgABAAQAggACAK8AAQAEAIUAAgA4AAEABADkAAIApgACAAYADgDwAAMAiwCnAPYAAgCnAAEABAD3AAIApgACAAYADAD4AAIAoQD5AAIApgABAAQA+gACAKYAAQAEAP4AAgC6AAEABAECAAIBQwABAAQBAgACAUwAAQAKACEANwCHAIsApAClAKYAuQFCAUsABAAAAAEACAABAMwAAwAMAB4AwgACAAYADACDAAIAIwCEAAIAjAASACYALgA2AD4ARgBOAFYAXgBmAG4AdAB6AIAAhgCMAJIAmACeAOcAAwCLAIYA6AADAIsAiwDpAAMAiwCMAOoAAwCLAI0A6wADAIsAkwDsAAMAiwCUAO0AAwCLAJUA7gADAIsAogDvAAMAiwCmAOUAAgCGAOYAAgCLAPEAAgCMAPIAAgCTAPMAAgCUAPQAAgCiAPUAAgCmAPwAAgCNAP0AAgCVAAEABAEAAAIAygABAAMAIwCLAMoAAQAAAAEACAACAEYAIAA8AD0APgA/AEEAQgBDAEQARQBqADoAOwBAAGsAbAC8AP8BXgFfAWABYQFiAWMBZAFlAWYBZwFoAaoBqwGpAawAAQAgAAIAEQASACEAJAAlACYAJwAoADYARgBJAFAAbgBvAMoBAAEEAQcBDAEgAS8BMAE0ATUBNgE3ATgBRAFKAa0BrgABAAAAAQAIAAIAQAAdAFEAUgBTAFQAVQBWAHAA1QDWANcA2ADMAM0AzgDPANAA0QDSANMA1ADdAQEBaQFqAWsBbAFtAW4BrwABAB0AJAAlACYAJwAoACoANgCtAK8AsACxAL0AvgC/AMAAwQDCAMMAxADKANwBAAE0ATUBNgE3ATgBOgFKAAEAAAABAAgAAgAmABAAWABZAHEAcgBXAHMA2gDbANkBbwFwAXEBsAGxAbIBswABABAAGwAnADsARABJAFQAnQCqAMABBwEpATcBXwFnAWwBdQABAAAAAQAIAAIAVgAoAXIBcwF0AXUBdgF3AXgBeQF6AXsBfAF9AX4BfwGAAYEBggGDAYQBhQGGAYcBiAGJAYoBtAG1AbYBtwG4AbkBugG7AbwBvQG+AdcB2AHZAdoAAgAMAQQBCwAAAREBFQAIASMBJQANATMBOAAQATwBPgAWAUYBRwAZAUoBSgAbAU4BUwAcAV0BXQAiAXEBcQAjAaQBpQAkAbEBsgAmAAEAAAABAAgAAgAKAAIBiwGMAAEAAgEZAR8AAQAAAAEACAACABQABwGNAY4BjwGQAZEBkgGTAAIAAgELAQsAAAERARYAAQABAAAAAQAIAAIAqABRAF0AXgBfAGAAYQBiAGMAZABlAGYAZwBoAGkAdQB2AHcAeAB5AHoAewB8AFoAWwBcAH0AfgB/AIAAdACBAN8A4ADhAOIA3gDjAZQBlQGWAZcBmAGZAZoBmwGcAZ0BngGfAaABoQGiAaMBvwHAAcEBwgHDAcQBxQHGAccByAHJAcoBywHMAc0BzgHPAdAB0QHSAdMB1AHVAdYB2wHcAd0B3gHfAAEAUQAGAAcACQANAA4AEAAZABoAHAAlACYAKAAtADMANAA1ADYAOQBCAEMARQBHAEgASgBSAFMAVQBqAG0AcAC1ALYAtwC4ANwA3QEFAQYBCAESARMBFQEaARsBHgEnASgBKgE1ATYBOAE9AUYBRwFIAUkBSgFlAWYBaAFqAWsBbQFzAXQBdgF7AXwBfgGEAYUBhwGJAY8BkAGSAasBrwG0AbUBtgABAAEACAACAAAAFAACAAAAJAACd2dodAELAABpdGFsAQwAAQAEABAAAQAAAAABBwJYAAAAAwABAAIBDQAAAAAAAQAA";
// ── #50 — Image SVG « JCGI WEALTH BAROMETER » ──────────────────────────────
function _fmtUSD(n){ return "$ " + Math.round(n||0).toLocaleString("en-US"); }
function _fmtPct(p){ if(p==null) return "—"; return (p>=0?"+":"") + p.toFixed(2) + " %"; }
function _pctColor(p){ if(p==null) return "#9aa3b2"; return p>=0 ? "#22C55E" : "#EF4444"; }
function _emblem(cx, top, s){ // emblème dessiné (couronne + écu + 3 épis) — robuste au rendu PNG
  var gold="#C9A86A", goldD="#8C7544", blue="#4d5e76";
  var g='';
  // couronne
  g+='<g transform="translate('+cx+','+top+')">';
  g+='<rect x="-40" y="14" width="80" height="11" rx="2" fill="'+gold+'"/>';
  g+='<path d="M-40,16 L-26,-6 L-13,12 L0,-12 L13,12 L26,-6 L40,16 Z" fill="'+gold+'" stroke="'+goldD+'" stroke-width="1"/>';
  g+='<circle cx="-40" cy="-8" r="5" fill="'+gold+'"/><circle cx="0" cy="-15" r="5" fill="'+gold+'"/><circle cx="40" cy="-8" r="5" fill="'+gold+'"/>';
  g+='</g>';
  // écu
  g+='<path d="M'+(cx-46)+','+(top+34)+' L'+(cx+46)+','+(top+34)+' L'+(cx+46)+','+(top+90)+' Q'+(cx+46)+','+(top+128)+' '+cx+','+(top+150)+' Q'+(cx-46)+','+(top+128)+' '+(cx-46)+','+(top+90)+' Z" fill="'+blue+'" stroke="'+gold+'" stroke-width="3"/>';
  // 3 épis (tiges + grains)
  function epi(x,y,h){ var e='<line x1="'+x+'" y1="'+y+'" x2="'+x+'" y2="'+(y-h)+'" stroke="'+gold+'" stroke-width="2.5"/>';
    for(var k=0;k<4;k++){ var yy=y-h+6+k*7; e+='<path d="M'+x+','+yy+' q7,-3 9,-9" stroke="'+gold+'" stroke-width="2" fill="none"/><path d="M'+x+','+yy+' q-7,-3 -9,-9" stroke="'+gold+'" stroke-width="2" fill="none"/>'; } return e; }
  g+=epi(cx-18,top+128,52)+epi(cx+18,top+128,52)+epi(cx,top+138,46);
  return g;
}
function barometerSVG(d, aud){
  var invest = (aud==="invest");
  // Hauteur ajustée au nombre de lignes de fonds : sans cela, la variante investisseurs
  // (2 lignes, pas de poste liquidités) laissait un grand vide avant le pied de page.
  var _caUSD = invest ? 0 : Math.round((d.bankEUR||0)/(d.usdEur||0.92));
  var _nRows = 2 + ((!invest && _caUSD>0) ? 1 : 0);
  var W=900, H=1240 - (3-_nRows)*86;
  // Palette resserrée : encre chaude sur fond nuit, un seul métal (or), accents de performance discrets.
  var bg="#0A0A0C", ink="#EDE7DB", sub="#8B8375", faint="#565143",
      gold="#C6A86B", goldDim="#8E7440", hair="#211D16", hair2="#171410",
      pos="#8FBCA4", neg="#C98A8A", cr="#C08B4F", st="#7891B4", ca="#615C4E";
  var serif="'Cormorant Garamond','Georgia',serif", sans="'Helvetica Neue','Arial',sans-serif";
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function money(n){ return "$" + Math.round(n||0).toLocaleString("en-US").replace(/,/g," "); }
  function pcol(p){ return p==null?sub:(p>=0?pos:neg); }
  function fp(p){ if(p==null) return "—"; return (p>=0?"+":"−") + Math.abs(p).toFixed(1) + "%"; }
  function arrow(p){ return p==null?"":(p>=0?"▴":"▾"); }
  // Petites capitales espacées : la signature typographique des relevés de banque privée.
  function label(x,y,t,anchor,size,fill){
    return '<text x="'+x+'" y="'+y+'" text-anchor="'+(anchor||"middle")+'" fill="'+(fill||sub)
      +'" font-family="'+sans+'" font-size="'+(size||9.5)+'" letter-spacing="3.4">'+esc(t)+'</text>';
  }
  function rule(x1,y,x2,col){ return '<line x1="'+x1+'" y1="'+y+'" x2="'+x2+'" y2="'+y+'" stroke="'+(col||hair)+'"/>'; }

  var cr$=d.cryptoUSD||0, st$=d.stocksUSD||0, ca$=_caUSD;
  var aum = invest ? (cr$+st$) : (d.totalUSD||0);
  var base = (cr$+st$+ca$)||1;
  var wC=cr$/base, wS=st$/base, wA=ca$/base;
  var h=(d&&d.health)||{label:"—",color:gold};
  var ML=84, MR=W-84, CW=MR-ML;
  var now=new Date(Date.now()+3600e3), dd=now.toISOString().slice(0,10), hh=now.toISOString().slice(11,16);
  var MOIS=["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
  var dLong = now.getUTCDate()+" "+MOIS[now.getUTCMonth()]+" "+now.getUTCFullYear();

  var S='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">';
  S+='<defs>'
   +'<style>@font-face{font-family:"Cormorant Garamond";src:url('+BARO_FONT+') format("truetype");font-weight:400 700;}</style>'
   +'<radialGradient id="vg" cx="50%" cy="16%" r="95%"><stop offset="0" stop-color="#15131A"/><stop offset="1" stop-color="'+bg+'"/></radialGradient>'
   +'<linearGradient id="au" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="'+bg+'"/><stop offset=".5" stop-color="'+gold+'"/><stop offset="1" stop-color="'+bg+'"/></linearGradient>'
   +'<linearGradient id="spk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+gold+'" stop-opacity=".22"/><stop offset="1" stop-color="'+gold+'" stop-opacity="0"/></linearGradient>'
   +'</defs>';
  S+='<rect width="'+W+'" height="'+H+'" fill="url(#vg)"/>';
  // Double filet : le liseré d'un papier à en-tête gravé.
  S+='<rect x="24" y="24" width="'+(W-48)+'" height="'+(H-48)+'" rx="2" fill="none" stroke="'+hair+'"/>';
  S+='<rect x="30" y="30" width="'+(W-60)+'" height="'+(H-60)+'" rx="1.5" fill="none" stroke="'+hair2+'"/>';

  // ── En-tête ────────────────────────────────────────────────────────────────
  S+='<image href="'+BARO_LOGO+'" x="'+(W/2-46)+'" y="66" width="92" height="72" preserveAspectRatio="xMidYMid meet"/>';
  S+='<text x="'+(W/2)+'" y="180" text-anchor="middle" fill="'+ink+'" font-family="'+serif+'" font-size="27" letter-spacing="7" font-weight="600">J.C. GLOBAL INVESTMENTS</text>';
  S+=label(W/2,204,invest?"RELEVÉ DES PORTEURS DE PARTS":"RELEVÉ DE PATRIMOINE PRIVÉ",null,10,gold);
  S+='<line x1="'+(W/2-56)+'" y1="224" x2="'+(W/2+56)+'" y2="224" stroke="url(#au)" stroke-width="1"/>';
  S+='<text x="'+(W/2)+'" y="248" text-anchor="middle" fill="'+faint+'" font-family="'+serif+'" font-size="15" font-style="italic">Arrêté au '+esc(dLong)+'</text>';

  // ── Actifs sous gestion — chiffre d'ouverture ──────────────────────────────
  var uy=300;
  S+=label(W/2,uy,invest?"ACTIFS DES FONDS SOUS GESTION":"ACTIFS SOUS GESTION",null,10);
  S+='<text x="'+(W/2)+'" y="'+(uy+52)+'" text-anchor="middle" fill="'+ink+'" font-family="'+serif+'" font-size="54" font-weight="600" letter-spacing="1">'+money(aum)+'</text>';
  var _ueA=(d.ueApp||d.usdEur||0.92);
  var _meur=function(x){ return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g," ")+" €"; };
  S+='<text x="'+(W/2)+'" y="'+(uy+76)+'" text-anchor="middle" fill="'+faint+'" font-family="'+sans+'" font-size="12.5" letter-spacing="1.2">&#8776;&#160;'+_meur(aum*_ueA)+'</text>';
  // Indice de vitalité — pastille sobre, sans cadre
  S+='<text x="'+(W/2)+'" y="'+(uy+104)+'" text-anchor="middle" font-family="'+sans+'" font-size="10.5" letter-spacing="3.4">'
    +'<tspan fill="'+(h.color||gold)+'">&#9679;&#160;&#160;</tspan><tspan fill="'+sub+'">'+esc(h.label||"—")+'</tspan></text>';

  // ── Évolution sur 30 jours ─────────────────────────────────────────────────
  var sy=452, sh=104;
  var sp=(d.spark||[]).filter(function(v){ return typeof v==="number" && isFinite(v) && v>0; });
  if(sp.length>=3){
    var smin=Math.min.apply(null,sp), smax=Math.max.apply(null,sp);
    if(smin===smax){ smin*=0.995; smax*=1.005; }
    var sx=function(i){ return ML + i*CW/(sp.length-1); };
    var syf=function(v){ return sy+sh - (v-smin)/(smax-smin)*(sh-14) - 7; };
    var pts=sp.map(function(v,i){ return sx(i).toFixed(1)+","+syf(v).toFixed(1); }).join(" ");
    S+=label(ML,sy-14,"ÉVOLUTION SUR 30 JOURS","start",9.5);
    S+='<text x="'+MR+'" y="'+(sy-14)+'" text-anchor="end" font-family="'+sans+'" font-size="9.5" letter-spacing="1.4" fill="'+faint+'">'
      +esc(_meur(smin*_ueA))+' &#8212; '+esc(_meur(smax*_ueA))+'</text>';
    S+='<polygon points="'+ML+','+(sy+sh)+' '+pts+' '+MR+','+(sy+sh)+'" fill="url(#spk)"/>';
    S+='<polyline points="'+pts+'" fill="none" stroke="'+gold+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
    S+='<circle cx="'+sx(sp.length-1).toFixed(1)+'" cy="'+syf(sp[sp.length-1]).toFixed(1)+'" r="3.2" fill="'+gold+'"/>';
    S+=rule(ML,sy+sh,MR,hair2);
  }

  // ── Performance ────────────────────────────────────────────────────────────
  var py=606;
  S+=rule(ML,py,MR);
  var perf=[["24 HEURES",d.p24],["7 JOURS",d.p7],["TENDANCE",d.M]];
  var colW=CW/3;
  perf.forEach(function(c,i){
    var cx=ML+colW*i+colW/2;
    if(i>0) S+='<line x1="'+(ML+colW*i)+'" y1="'+(py+18)+'" x2="'+(ML+colW*i)+'" y2="'+(py+82)+'" stroke="'+hair+'"/>';
    S+=label(cx,py+38,c[0],null,9.5);
    S+='<text x="'+cx+'" y="'+(py+76)+'" text-anchor="middle" fill="'+pcol(c[1])+'" font-family="'+serif+'" font-size="34" font-weight="600">'+fp(c[1])+'</text>';
  });
  S+=rule(ML,py+102,MR);

  // ── Les fonds ──────────────────────────────────────────────────────────────
  var ay=756;
  S+='<text x="'+(W/2)+'" y="'+ay+'" text-anchor="middle" fill="'+ink+'" font-family="'+serif+'" font-size="30" letter-spacing="2" font-weight="600">Allocation du fonds</text>';
  S+=label(W/2,ay+24,"RÉPARTITION DES PÔLES · VALEUR DE PART · PERFORMANCE",null,9.5);
  // Ruban d'allocation : un seul trait épais, segments jointifs, légende sous chaque part
  var barY=ay+48, barH=10, gap=2.5;
  var segs=[[wC,cr,"JCGIC"],[wS,st,"JCGIS"]]; if(!invest && wA>0) segs.push([wA,ca,"LIQUIDITÉS"]);
  var x=ML;
  segs.forEach(function(s){ var sw=Math.max(0,(s[0]*CW)-gap);
    S+='<rect x="'+x.toFixed(1)+'" y="'+barY+'" width="'+sw.toFixed(1)+'" height="'+barH+'" rx="1.5" fill="'+s[1]+'"/>';
    if(s[0]>0.07) S+='<text x="'+(x+sw/2).toFixed(1)+'" y="'+(barY+26)+'" text-anchor="middle" fill="'+faint+'" font-family="'+sans+'" font-size="9.5" letter-spacing="1.6">'+Math.round(s[0]*100)+'%</text>';
    x+=s[0]*CW; });

  var rows=[["JCGIC","Pôle numérique",cr,cr$,wC,d.cgicNavUSD,d.cgicPnl,d.cgicNav]];
  rows.push(["JCGIS","Pôle actions",st,st$,wS,d.cgisNavUSD,d.cgisPnl,d.cgisNav]);
  if(!invest && ca$>0) rows.push(["LIQUIDITÉS","Matelas de sécurité",ca,ca$,wA,null,null,null]);
  var ry=barY+64;
  rows.forEach(function(r,i){
    var y=ry+i*86, hasNav=(r[5]!=null);
    S+=rule(ML,y-26,MR,hair2);
    S+='<rect x="'+ML+'" y="'+(y-11)+'" width="3" height="14" fill="'+r[2]+'"/>';
    S+='<text x="'+(ML+16)+'" y="'+y+'" fill="'+ink+'" font-family="'+sans+'" font-size="15" letter-spacing="2.6" font-weight="600">'+esc(r[0])+'</text>';
    S+='<text x="'+(ML+16)+'" y="'+(y+20)+'" fill="'+faint+'" font-family="'+serif+'" font-size="15" font-style="italic">'+esc(r[1])+'</text>';
    if(hasNav){
      // Valeur liquidative : le chiffre que le porteur de parts vient chercher.
      S+='<text x="'+MR+'" y="'+y+'" text-anchor="end" fill="'+gold+'" font-family="'+serif+'" font-size="34" font-weight="600">'+r[5].toFixed(2)
        +'<tspan font-family="'+sans+'" font-size="11.5" fill="'+sub+'" font-weight="400" letter-spacing="1.4"> $ / PART</tspan></text>';
      var bits=[];
      if(r[7]!=null) bits.push('<tspan fill="'+faint+'">'+r[7].toFixed(2)+'&#160;€</tspan>');
      bits.push('<tspan fill="'+sub+'">'+money(r[3])+'</tspan>');
      bits.push('<tspan fill="'+faint+'">'+Math.round(r[4]*100)+'%&#160;du fonds</tspan>');
      S+='<text x="'+MR+'" y="'+(y+20)+'" xml:space="preserve" text-anchor="end" font-family="'+sans+'" font-size="11.5" letter-spacing="0.4">'
        +bits.join('<tspan fill="'+hair+'">&#160;&#160;|&#160;&#160;</tspan>')+'</text>';
      if(r[6]!=null){
        S+='<text x="'+MR+'" y="'+(y+40)+'" xml:space="preserve" text-anchor="end" font-family="'+sans+'" font-size="11.5" letter-spacing="0.4">'
          +'<tspan fill="'+faint+'">Depuis l\'origine&#160;&#160;</tspan><tspan fill="'+pcol(r[6])+'" font-weight="700">'+fp(r[6])+'</tspan></text>';
      }
    } else {
      S+='<text x="'+MR+'" y="'+y+'" text-anchor="end" fill="'+gold+'" font-family="'+serif+'" font-size="34" font-weight="600">'+money(r[3])+'</text>';
      S+='<text x="'+MR+'" y="'+(y+20)+'" text-anchor="end" fill="'+faint+'" font-family="'+sans+'" font-size="11.5" letter-spacing="0.4">'+Math.round(r[4]*100)+'% du total</text>';
    }
  });

  // ── Pied de page ───────────────────────────────────────────────────────────
  var fy=H-124;
  S+=rule(ML,fy,MR);
  S+='<text x="'+(W/2)+'" y="'+(fy+26)+'" text-anchor="middle" fill="'+faint+'" font-family="'+serif+'" font-size="14" font-style="italic">Établi le '+dd+' à '+hh+' CET &#183; Document confidentiel</text>';
  var foot = invest
    ? "Relevé destiné aux porteurs de parts des fonds JCGIC & JCGIS. Document indicatif sans valeur contractuelle. Les performances passées ne préjugent pas des performances futures."
    : "Véhicule patrimonial privé. Relevé strictement confidentiel, sans valeur contractuelle ni conseil en investissement. Les performances passées ne préjugent pas des performances futures.";
  var words=foot.split(" "), lns=[], cur="";
  words.forEach(function(wd){ if((cur+" "+wd).length>96){ lns.push(cur); cur=wd; } else cur=(cur?cur+" ":"")+wd; });
  if(cur) lns.push(cur);
  lns.slice(0,3).forEach(function(l,i){ S+='<text x="'+(W/2)+'" y="'+(fy+52+i*16)+'" text-anchor="middle" fill="'+faint+'" font-family="'+sans+'" font-size="10">'+esc(l)+'</text>'; });
  S+='</svg>';
  return S;
}
async function pushBaroHistory(totalUSD) {
  var hist = [];
  try { var raw = await GDB_KV.get("cgi_baro_hist"); if (raw) hist = JSON.parse(raw) || []; } catch (e) {}
  hist.push({ ts: Date.now(), v: totalUSD });
  var cutoff = Date.now() - 31 * 864e5;
  hist = hist.filter(function (h) { return h.ts >= cutoff; });
  try { await GDB_KV.put("cgi_baro_hist", JSON.stringify(hist)); } catch (e) {}
  return hist;
}
function _perfSince(hist, nowVal, msAgo) {
  if (!hist || !hist.length) return null;
  var target = Date.now() - msAgo, best = null, bestDt = Infinity;
  hist.forEach(function (h) { var d = Math.abs(h.ts - target); if (d < bestDt) { bestDt = d; best = h; } });
  if (!best || !best.v) return null;
  if (bestDt > Math.max(msAgo * 0.6, 6 * 3600e3)) return null;
  return (nowVal - best.v) / best.v * 100;
}
function _healthFromM(M) {
  if (M == null) return { key: "NA", label: "EN COLLECTE", color: "#9aa3b2", emoji: "⚪" };
  if (M >= 1.5)  return { key: "OPTIMAL",   label: "OPTIMAL",   color: "#22C55E", emoji: "🟢" };
  if (M >= 0)    return { key: "SOLIDE",    label: "SOLIDE",    color: "#4A90D9", emoji: "🔵" };
  if (M > -2.5)  return { key: "VIGILANCE", label: "VIGILANCE", color: "#EAB308", emoji: "🟡" };
  return         { key: "CRITIQUE",  label: "CRITIQUE",  color: "#EF4444", emoji: "🔴" };
}
async function buildBaroData() {
  // #2.5 — LIVE D'ABORD : le Worker recalcule les pôles à chaque envoi (prix Yahoo + positions
  // cgi_portfolio). Le snapshot cgi_fund_stats ne fournit plus que les valeurs LENTES (parts sh,
  // capitaux investis mEUR — resynchronisées à chaque ouverture de l'app) et sert de repli complet
  // si les prix live échouent. → les baromètres restent à jour sans ouvrir l'application.
  var snap = null;
  try { var sr = await GDB_KV.get("cgi_fund_stats"); if (sr) snap = JSON.parse(sr); } catch (e) {}
  var n = null;
  try { n = await buildPortfolioNumbers(); } catch (e) { n = null; }
  var liveOk = !!(n && n.totalUSD > 0 && n.live > 0);
  if (liveOk) { n.src = "live"; }
  else if (snap && snap.totalUSD) {
    var ue = snap.usdEur || (snap.totalEUR && snap.totalUSD ? snap.totalEUR / snap.totalUSD : 0.92);
    n = { totalUSD: Math.round(snap.totalUSD), totalEUR: Math.round(snap.totalEUR != null ? snap.totalEUR : snap.totalUSD * ue),
      cryptoUSD: Math.round(snap.cryptoUSD || 0), stocksUSD: Math.round(snap.stocksUSD || 0),
      cashUSD: Math.round(snap.cashUSD || 0), bankEUR: Math.round(snap.bankEUR || 0), usdEur: ue, live: 0, fallback: 0, src: "app" };
  } else if (!n) { n = { totalUSD: 0, totalEUR: 0, cryptoUSD: 0, stocksUSD: 0, cashUSD: 0, bankEUR: 0, usdEur: 0.92, live: 0, fallback: 0, src: "worker" }; }
  else { n.src = "worker"; }
  var hist = [];
  try { var raw = await GDB_KV.get("cgi_baro_hist"); if (raw) hist = JSON.parse(raw) || []; } catch (e) {}
  var pMaj = (hist.length ? (n.totalUSD - hist[hist.length - 1].v) / hist[hist.length - 1].v * 100 : null);
  var p24 = _perfSince(hist, n.totalUSD, 864e5);
  var p7 = _perfSince(hist, n.totalUSD, 7 * 864e5);
  var parts = [pMaj, p24, p7].filter(function (x) { return x != null; });
  var M = parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : null;
  // #2.7 — NAV & P&L « même méthode que l'app » : on repart des valeurs PUBLIÉES par l'app
  // (nav €, pnlPct, valueUSD au moment du push) et on les fait DÉRIVER par le ratio
  // valeur_live / valeur_au_push du pôle. Exact pour le money-weighted (val/m − 1 → ×ratio),
  // et insensible aux conventions d'unités (€/$) comme au taux de change retenu par l'app.
  // #2.7/#135a — NAV & P&L « même méthode que l'app », dérive PÉRIMÈTRE-COHÉRENTE.
  // AVANT : r = pôle_live / fund.valueUSD — or le périmètre du FONDS (ex. CGIS = actions + cash dip,
  // 31 k$) diffère du PÔLE live (actions seules, 23 k$) → r≈0,75 → part CGIS affichée 128,94 $ dans le
  // relevé alors que l'app dit 171,57 $. DÉSORMAIS : la valeur live du fonds = valeur au push + (delta
  // du pôle qui bouge) — le cash du fonds est inerte entre deux pushes. Exact au premier ordre et
  // insensible aux différences de périmètre entre worker et app.
  var cgicNav = null, cgisNav = null, cgicPnl = null, cgisPnl = null;
  var cgicNavUSD = null, cgisNavUSD = null;
  var ueApp = (snap && snap.ue) || n.usdEur;   // taux €/$ retenu par l'app (affichage € cohérent)
  var _drift = function (fund, poleLiveUSD, poleSnapUSD) {
    if (!fund) return null;
    var r = 1;
    if (n.src !== "app" && fund.valueUSD > 0 && poleLiveUSD > 0 && poleSnapUSD > 0) {
      var liveFund = fund.valueUSD + (poleLiveUSD - poleSnapUSD);
      if (liveFund > 0) r = liveFund / fund.valueUSD;
    }
    var nUSD = (fund.navUSD != null) ? fund.navUSD * r
             : (fund.nav != null && ueApp > 0) ? (fund.nav / ueApp) * r : null;   // repli : nav € / taux
    return { navUSD: nUSD,
             nav: (nUSD != null) ? nUSD * ueApp : ((fund.nav != null) ? fund.nav * r : null),
             pnl: (fund.pnlPct != null) ? ((1 + fund.pnlPct / 100) * r - 1) * 100 : null };
  };
  var _dc = _drift(snap && snap.cgic, n.cryptoUSD, snap && snap.cryptoUSD), _ds = _drift(snap && snap.cgis, n.stocksUSD, snap && snap.stocksUSD);
  if (_dc) { cgicNav = _dc.nav; cgicPnl = _dc.pnl; cgicNavUSD = _dc.navUSD; }
  if (_ds) { cgisNav = _ds.nav; cgisPnl = _ds.pnl; cgisNavUSD = _ds.navUSD; }
  // Replis (snapshot ancien sans valueUSD) : parts + capitaux investis, puis parts par défaut
  var PARTS = { C: 1033, S: 181 };   // repli si snapshot absent — mis à jour 2026-07 (source de vérité = cgi_fund_stats)
  var shC = (snap && snap.cgic && snap.cgic.sh > 0) ? snap.cgic.sh : PARTS.C;
  var shS = (snap && snap.cgis && snap.cgis.sh > 0) ? snap.cgis.sh : PARTS.S;
  if (cgicNavUSD == null) cgicNavUSD = n.cryptoUSD / shC;
  if (cgisNavUSD == null) cgisNavUSD = n.stocksUSD / shS;
  if (cgicNav == null) cgicNav = cgicNavUSD * ueApp;
  if (cgisNav == null) cgisNav = cgisNavUSD * ueApp;
  if (cgicPnl == null && snap && snap.cgic) {
    if (snap.cgic.mEUR > 0) cgicPnl = (n.cryptoUSD * n.usdEur / snap.cgic.mEUR - 1) * 100;
    else if (snap.cgic.pnlPct != null) cgicPnl = snap.cgic.pnlPct;
  }
  if (cgisPnl == null && snap && snap.cgis) {
    if (snap.cgis.mEUR > 0) cgisPnl = (n.stocksUSD * n.usdEur / snap.cgis.mEUR - 1) * 100;
    else if (snap.cgis.pnlPct != null) cgisPnl = snap.cgis.pnlPct;
  }
  // #NEW — CALCUL AUTONOME (prioritaire quand les prix live sont disponibles) : NAV et P&L des
  // fonds recalculés ici à partir des pôles live et de cgi_inv, au lieu d'être dérivés d'un
  // cgi_fund_stats que seul l'onglet JCGI rafraîchit. Périmètres identiques à l'app :
  //   CGIC = crypto + KuCoin    ·    CGIS = actions + cash de plateforme (hors matelas bancaire)
  var fundsSrc = "snapshot";
  try {
    if (liveOk) {
      var fi = await _fundsFromInv();
      var shC2 = (fi && fi.shC) || (snap && snap.cgic && snap.cgic.sh > 0 ? snap.cgic.sh : PARTS.C);
      var shS2 = (fi && fi.shS) || (snap && snap.cgis && snap.cgis.sh > 0 ? snap.cgis.sh : PARTS.S);
      var mC2 = (fi && fi.mEurC) || (snap && snap.cgic && snap.cgic.mEUR) || null;
      var mS2 = (fi && fi.mEurS) || (snap && snap.cgis && snap.cgis.mEUR) || null;
      var fundCusd = n.cryptoUSD + (n.kucoinUSD || 0);
      var fundSusd = n.stocksUSD + (n.cashOtherUSD || 0);
      if (shC2 > 0 && fundCusd > 0) {
        cgicNavUSD = fundCusd / shC2; cgicNav = cgicNavUSD * n.usdEur;
        if (mC2 > 0) cgicPnl = (fundCusd * n.usdEur / mC2 - 1) * 100;
      }
      if (shS2 > 0 && fundSusd > 0) {
        cgisNavUSD = fundSusd / shS2; cgisNav = cgisNavUSD * n.usdEur;
        if (mS2 > 0) cgisPnl = (fundSusd * n.usdEur / mS2 - 1) * 100;
      }
      fundsSrc = fi ? "live+inv" : "live";
    }
  } catch (e) {}
  return Object.assign(n, { pMaj: pMaj, p24: p24, p7: p7, M: M, health: _healthFromM(M),
    cgicNav: cgicNav, cgisNav: cgisNav, cgicPnl: cgicPnl, cgisPnl: cgisPnl,
    cgicNavUSD: cgicNavUSD, cgisNavUSD: cgisNavUSD, ueApp: ueApp, fundsSrc: fundsSrc,
    spark: hist.map(function (h) { return h.v; }) });
}

// URL publique du Worker (pour que wsrv.nl récupère le SVG)
var SELF_URL = "https://blue-firefly-2075watchlist-api.jcgi.workers.dev";
// Upload direct des octets PNG à Telegram (évite "wrong type of the web page content")
var _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
async function sendPhotoUpload(pngBuf, caption, chatId) {
  if (!_tgConfigured()) return { ok: false, error: "TELEGRAM non configurés" };
  var fd = new FormData();
  fd.append("chat_id", String(chatId || TELEGRAM_CHAT_ID));
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
  fd.append("photo", new Blob([pngBuf], { type: "image/png" }), "barometer.png");
  var r = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendPhoto", { method: "POST", body: fd });
  var j = await r.json().catch(function () { return {}; });
  return { ok: r.ok && j.ok, status: r.status, resp: j };
}
// Envoi photo en MODE URL (Telegram va chercher l'image lui-même)
async function sendPhotoByUrl(photoUrl, caption, chatId) {
  if (!_tgConfigured()) return { ok: false, error: "TELEGRAM non configurés" };
  var r = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendPhoto", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId || TELEGRAM_CHAT_ID, photo: photoUrl, caption: caption || "", parse_mode: "HTML" }) });
  var j = await r.json().catch(function () { return {}; });
  return { ok: r.ok && j.ok, status: r.status, resp: j, mode: "url" };
}
function _wsrvHeaders() {
  return { "User-Agent": _UA, "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8", "Referer": "https://wsrv.nl/",
    "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site" };
}
// #50/#56 — Baromètre en image. Stratégies en cascade pour contourner les blocages serveur de wsrv.
async function sendBarometer(aud) {
  var d = await buildBaroData();
  if (aud !== "invest") await pushBaroHistory(d.totalUSD);
  var svgUrl = SELF_URL + "/barometer.svg?k=" + AUTH_KEY + (aud === "invest" ? "&aud=invest" : "") + "&t=" + Date.now(); // cache-buster : wsrv et Telegram cachent par URL → sans lui, la même image figée est resservie
  var pngUrl = "https://wsrv.nl/?url=" + encodeURIComponent(svgUrl) + "&output=png&w=1290";
  var cap = "<b>JCGI WEALTH BAROMETER</b> · " + d.health.label + (aud === "invest" ? " · Relevé investisseurs" : "");
  var chat = (aud === "invest" && typeof TELEGRAM_INVEST_CHAT_ID !== "undefined" && TELEGRAM_INVEST_CHAT_ID) ? TELEGRAM_INVEST_CHAT_ID : null;
  var res = { ok: false }, tries = [];
  // 1) MODE URL : Telegram récupère wsrv (ses serveurs passent souvent là où le Worker est bloqué)
  try { res = await sendPhotoByUrl(pngUrl, cap, chat); tries.push({ url: res.status || (res.resp && res.resp.description) }); } catch (e) { tries.push({ url: e.message }); }
  // 2) UPLOAD OCTETS : le Worker télécharge le PNG (headers navigateur) puis l'envoie
  if (!res.ok) {
    try {
      var imgR = await fetch(pngUrl, { headers: _wsrvHeaders() });
      if (imgR.ok) { var buf = await imgR.arrayBuffer(); res = await sendPhotoUpload(buf, cap, chat); res.mode = "upload"; tries.push({ upload: res.status }); }
      else { tries.push({ upload: "wsrv " + imgR.status }); }
    } catch (e) { tries.push({ upload: e.message }); }
  }
  // 3) repli texte (perso uniquement)
  if (!res.ok && aud !== "invest") { try { await sendTelegram(await buildPortfolioSummary()); res.fallbackText = true; } catch (e) {} }
  res.tries = tries;
  return res;
}

// Handler cron — résumé quotidien + rafraîchissement des benchmarks
// ═══ #67 — Synchronisation automatique des positions depuis IBKR (Flex Web Service) ═══
// Prérequis (Cloudflare → Worker → Settings → Variables) : IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID.
// La Flex Query (Portail IBKR → Performance & Reports → Flex Queries) doit inclure la section
// « Open Positions » au format XML, période « Last Business Day ». Sans ces variables, tout est no-op.
var IBKR_FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
function _ibkrConfigured() { return (typeof IBKR_FLEX_TOKEN !== "undefined") && (typeof IBKR_FLEX_QUERY_ID !== "undefined"); }
async function ibkrFetchStatement() {
  if (!_ibkrConfigured()) return { ok: false, error: "IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID non configurés (variables Cloudflare)" };
  var r1 = await fetch(IBKR_FLEX_BASE + "/SendRequest?t=" + IBKR_FLEX_TOKEN + "&q=" + IBKR_FLEX_QUERY_ID + "&v=3", { headers: { "User-Agent": _UA } });
  var t1 = await r1.text();
  var mCode = t1.match(/<ReferenceCode>(\d+)<\/ReferenceCode>/);
  if (!mCode) { var mE1 = t1.match(/<ErrorMessage>([\s\S]*?)<\/ErrorMessage>/); return { ok: false, error: "SendRequest: " + (mE1 ? mE1[1] : t1.slice(0, 200)) }; }
  var xml = null;                       // IBKR génère le rapport en asynchrone → tentatives espacées
  for (var a = 0; a < 5; a++) {
    await new Promise(function (res) { setTimeout(res, a === 0 ? 1200 : 2500); });
    var r2 = await fetch(IBKR_FLEX_BASE + "/GetStatement?t=" + IBKR_FLEX_TOKEN + "&q=" + mCode[1] + "&v=3", { headers: { "User-Agent": _UA } });
    var t2 = await r2.text();
    if (t2.indexOf("<FlexQueryResponse") >= 0) { xml = t2; break; }
    if (t2.indexOf("<ErrorMessage>") >= 0 && t2.indexOf("progress") < 0) {
      var mE2 = t2.match(/<ErrorMessage>([\s\S]*?)<\/ErrorMessage>/); return { ok: false, error: "GetStatement: " + (mE2 ? mE2[1] : "?") };
    }
  }
  if (!xml) return { ok: false, error: "rapport IBKR non prêt — réessayer dans une minute" };
  return { ok: true, xml: xml };
}
function _ibkrAttr(tag, k) { var mm = tag.match(new RegExp(k + '="([^"]*)"')); return mm ? mm[1] : null; }
function ibkrParsePositions(xml) {
  var out = [], re = /<OpenPosition\b[^>]*>/g, mo;
  while ((mo = re.exec(xml))) {
    var tag = mo[0], lvl = _ibkrAttr(tag, "levelOfDetail");
    if (lvl && lvl !== "SUMMARY") continue;   // éviter les doublons par lot
    out.push({ symbol: _ibkrAttr(tag, "symbol"), qty: parseFloat(_ibkrAttr(tag, "position") || "0"),
      currency: _ibkrAttr(tag, "currency"), assetCategory: _ibkrAttr(tag, "assetCategory") });
  }
  return out;
}
function ibkrParseTrades(xml) {
  var out = [], re = /<Trade\b[^>]*>/g, mo;
  while ((mo = re.exec(xml))) {
    var tag = mo[0], lvl = _ibkrAttr(tag, "levelOfDetail");
    if (lvl && lvl !== "EXECUTION") continue;
    var dt = _ibkrAttr(tag, "tradeDate") || (_ibkrAttr(tag, "dateTime") || "").split(";")[0];
    if (dt && dt.length === 8) dt = dt.slice(0, 4) + "-" + dt.slice(4, 6) + "-" + dt.slice(6, 8);
    var q = parseFloat(_ibkrAttr(tag, "quantity") || "0");
    out.push({ tradeID: _ibkrAttr(tag, "tradeID"), date: dt, symbol: _ibkrAttr(tag, "symbol"),
      side: (_ibkrAttr(tag, "buySell") || (q >= 0 ? "BUY" : "SELL")).toUpperCase(),
      qty: Math.abs(q), price: parseFloat(_ibkrAttr(tag, "tradePrice") || "0"),
      currency: _ibkrAttr(tag, "currency") || "USD", assetCategory: _ibkrAttr(tag, "assetCategory") });
  }
  return out;
}
// #67d — Cash Report IBKR : soldes de trésorerie par devise (section « Cash Report » de la Flex Query).
// Sert à tenir à jour le « Cash Dip » (ticker USD) sans saisie manuelle.
function ibkrParseCash(xml) {
  var out = {}, re = /<CashReportCurrency\b[^>]*>/g, mo;
  while ((mo = re.exec(xml))) {
    var tag = mo[0], cur = _ibkrAttr(tag, "currency");
    var end = parseFloat(_ibkrAttr(tag, "endingCash") || "NaN");
    if (cur && cur !== "BASE_SUMMARY" && !isNaN(end)) out[cur] = Math.round(end * 100) / 100;
  }
  return out;
}
// #67c — RÉCONCILIATION DES TRANSACTIONS. cgi_txns est la source de vérité des positions :
// l'app reconstruit les positions depuis les txns à chaque actualisation (« vérité unique » #61).
// On n'injecte donc JAMAIS les exécutions brutes IBKR (elles doublonnent les saisies manuelles
// qui agrègent les fills partiels) ; on compare le NET par ticker (ΣBUY−ΣSELL) à la position
// IBKR et on ajoute UN trade d'ajustement du delta. Idempotent : au passage suivant, delta = 0.
// Purge aussi les exécutions brutes "ibkr_*" injectées par la v60 (rollback intégré).
async function ibkrReconcileTxns(positions, dry) {
  var raw = await GDB_KV.get("cgi_txns");
  var txns = []; try { txns = raw ? (JSON.parse(raw) || []) : []; } catch (e) {}
  var before = txns.length;
  txns = txns.filter(function (t) { return !(t && typeof t.id === "string" && t.id.indexOf("ibkr_") === 0); });
  var rollback = before - txns.length;
  var repaired = 0;   // #67f — réparer les ajustements écrits sans valueUSD (computeOpenPositions en dépend)
  txns.forEach(function (t) {
    if (t && t.src === "ibkr_adj" && t.valueUSD == null && t.price != null && t.qty != null) {
      t.valueUSD = Math.round(t.qty * t.price * 100) / 100; repaired++;
    }
  });
  var CRYPTO_HINT = { BTC: 1, ETH: 1, SOL: 1, XRP: 1, ADA: 1, DOGE: 1, DOT: 1, AVAX: 1, LINK: 1, MATIC: 1, LTC: 1, BCH: 1, BNB: 1 };
  var CASHLIKE = { USD: 1, EURO: 1, KUCOIN: 1, CASH: 1, LCL: 1, BCI: 1, DEBLOCK: 1 };
  var net = {}, lastPx = {}, catOf = {};
  txns.forEach(function (t) {
    if (!t || !t.ticker) return;
    var k = t.ticker.toUpperCase();
    if (t.cat) catOf[k] = t.cat;
    var q = parseFloat(t.qty) || 0;
    net[k] = (net[k] || 0) + (((t.side || "").toUpperCase() === "SELL") ? -q : q);
    if (t.price) lastPx[k] = t.price;
  });
  var ibkrQty = {};
  positions.forEach(function (p) {
    if (!p.symbol || p.assetCategory === "CRYPTO" || p.assetCategory === "CASH") return;
    ibkrQty[p.symbol.split(" ")[0].toUpperCase()] = p.qty;
  });
  var scope = {};
  Object.keys(ibkrQty).forEach(function (k) { scope[k] = 1; });
  Object.keys(net).forEach(function (k) {
    if (!CRYPTO_HINT[k] && !CASHLIKE[k] && catOf[k] !== "Crypto" && catOf[k] !== "Cash" && catOf[k] !== "Cash Matelas") scope[k] = 1;
  });
  var yfm = {}; try { var ym = await GDB_KV.get("cgi_yfmap"); if (ym) yfm = JSON.parse(ym) || {}; } catch (e) {}
  var eurusd = (await lastPrice("EURUSD=X")) || (1 / 0.92);
  var _fx = {}, adj = [], ignores = [];
  var today = new Date().toISOString().slice(0, 10);
  for (var k in scope) {
    var d = (ibkrQty[k] || 0) - (net[k] || 0);
    if (Math.abs(d) < 1e-6) continue;
    var pxUSD = null;
    var pc = await lastPriceCur(yfm[k] || k);
    if (pc && pc.px != null) {
      var px = pc.px, cur = pc.cur || "USD";
      if (cur === "GBp") { px = px / 100; cur = "GBP"; }
      pxUSD = await _toUSD(px, cur, eurusd, _fx);
    }
    if (pxUSD == null) pxUSD = lastPx[k] || null;
    if (pxUSD == null) { ignores.push(k + " (prix introuvable)"); continue; }
    adj.push({ id: "ibkradj_" + k + "_" + today.replace(/-/g, "") + "_" + Math.floor(Math.random() * 1e4),
      date: today, side: d > 0 ? "BUY" : "SELL", ticker: k, cat: catOf[k] || "Picking",
      qty: Math.round(Math.abs(d) * 1e6) / 1e6, price: Math.round(pxUSD * 100) / 100,
      priceRaw: Math.round(pxUSD * 100) / 100, currency: "USD",
      valueUSD: Math.round(Math.abs(d) * pxUSD * 100) / 100,
      note: "Ajustement automatique IBKR — alignement de la position (" + (net[k] || 0) + " → " + (ibkrQty[k] || 0) + ")",
      bank: "IBKR", src: "ibkr_adj" });
  }
  if (!dry && (rollback > 0 || adj.length || repaired > 0)) {
    var full = txns.concat(adj);
    full.sort(function (a, b) { return (a.date || "") < (b.date || "") ? -1 : 1; });
    await GDB_KV.put("cgi_txns", JSON.stringify(full));
  }
  return { executionsBrutesPurgees: rollback, ajustementsRepares: repaired,
    ajustements: adj.map(function (a) { return { t: a.ticker, side: a.side, qty: a.qty, prixUSD: a.price }; }),
    ignores: ignores, dry: !!dry };
}
// Les exécutions brutes restent consultables dans une clé séparée (jamais dans cgi_txns)
async function ibkrStoreTrades(trades) {
  try { await GDB_KV.put("cgi_ibkr_trades", JSON.stringify({ ts: Date.now(), n: trades.length, trades: trades })); return trades.length; }
  catch (e) { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// #54 — SYNCHRONISATION KUCOIN (trades FUTURS, pas d'import d'historique).
// Le worker interroge l'API KuCoin (fills récents), mappe en transactions et les stocke dans la clé
// KV `cgi_kucoin_trades` (dédupliquées par tradeId). L'app lit cette clé et l'ajoute aux positions
// crypto (socle + txns postérieures, #102) et à History — exactement comme cgi_ibkr_trades.
// Prérequis (Cloudflare → Worker → Settings → Variables, en "Encrypt") :
//   KUCOIN_KEY, KUCOIN_SECRET, KUCOIN_PASSPHRASE  (clé API en LECTURE SEULE — aucun droit de trade/retrait)
//   KUCOIN_KEY_VERSION (optionnel, "2" par défaut ; "3" si clé v3)
var KUCOIN_BASE = "https://api.kucoin.com";
function _kucoinConfigured() { return (typeof KUCOIN_KEY !== "undefined") && (typeof KUCOIN_SECRET !== "undefined") && (typeof KUCOIN_PASSPHRASE !== "undefined"); }
// HMAC-SHA256 → base64 (Web Crypto)
async function _hmacB64(secret, msg) {
  var key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  var sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  var bytes = new Uint8Array(sig), bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
// Requête privée signée KuCoin (GET). endpoint doit inclure la query string.
async function _kucoinGet(endpoint) {
  var ts = Date.now().toString();
  var sign = await _hmacB64(KUCOIN_SECRET, ts + "GET" + endpoint + "");     // body = "" pour GET
  var pass = await _hmacB64(KUCOIN_SECRET, KUCOIN_PASSPHRASE);              // passphrase hashée (clé v2/v3)
  var kv = (typeof KUCOIN_KEY_VERSION !== "undefined") ? String(KUCOIN_KEY_VERSION) : "2";
  var r = await fetch(KUCOIN_BASE + endpoint, {
    headers: {
      "KC-API-KEY": KUCOIN_KEY, "KC-API-SIGN": sign, "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": pass, "KC-API-KEY-VERSION": kv, "Content-Type": "application/json", "User-Agent": _UA
    }
  });
  var txt = await r.text(), j = null; try { j = JSON.parse(txt); } catch (e) { }
  if (!j) return { ok: false, error: "réponse KuCoin illisible (HTTP " + r.status + ")" };
  if (j.code !== "200000") return { ok: false, error: "KuCoin " + j.code + " " + (j.msg || "") };
  return { ok: true, data: j.data };
}
// Récupère les fills récents (7 derniers jours max via cet endpoint) et les mappe en transactions.
async function kucoinSync() {
  if (!_kucoinConfigured()) return { ok: false, error: "KUCOIN_KEY / KUCOIN_SECRET / KUCOIN_PASSPHRASE non configurés (variables Cloudflare)" };
  var res = await _kucoinGet("/api/v1/fills?pageSize=500&tradeType=TRADE");
  if (!res.ok) return res;
  var items = (res.data && res.data.items) || [];
  var mapped = items.map(function (f) {
    var base = String(f.symbol || "").split("-")[0].toUpperCase();          // "BTC-USDT" → "BTC"
    var qty = parseFloat(f.size) || 0, price = parseFloat(f.price) || 0;
    var created = Number(f.createdAt) || Date.now();
    var dateISO = new Date(created).toISOString().slice(0, 10);
    return {
      id: "kucoin_" + (f.tradeId || f.orderId || (created + "_" + f.symbol)),
      ticker: base, side: (String(f.side || "").toUpperCase() === "SELL") ? "SELL" : "BUY",
      qty: qty, price: price, date: dateISO,
      valueUSD: Math.round(qty * price * 100) / 100, currency: "USD",
      src: "kucoin", createdAt: created
    };
  }).filter(function (t) { return t.ticker && t.qty > 0; });
  // Fusion dans cgi_kucoin_trades, dédup par id, fenêtre glissante (500 dernières).
  var raw = null; try { raw = await GDB_KV.get("cgi_kucoin_trades"); } catch (e) { }
  var existing = []; try { existing = raw ? (JSON.parse(raw).trades || []) : []; } catch (e) { }
  var byId = {}; existing.forEach(function (t) { if (t && t.id != null) byId[t.id] = t; });
  var added = 0;
  mapped.forEach(function (t) { if (!byId[t.id]) { byId[t.id] = t; added++; } });
  var all = Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  if (all.length > 500) all = all.slice(all.length - 500);
  try { await GDB_KV.put("cgi_kucoin_trades", JSON.stringify({ ts: Date.now(), n: all.length, added: added, trades: all })); }
  catch (e) { return { ok: false, error: "écriture KV échouée : " + e.message }; }
  return { ok: true, fetched: mapped.length, added: added, total: all.length };
}

// Synchronisation complète : quantités KV (baromètre) + réconciliation txns + archive des exécutions.
// dry=true → aucune écriture, rapport seulement.
async function ibkrSyncPortfolio(purge, dry) {
  var st = await ibkrFetchStatement();
  if (!st.ok) return st;
  var positions = ibkrParsePositions(st.xml);
  if (!positions.length) return { ok: false, error: "rapport IBKR sans section Open Positions — vérifier la Flex Query" };
  var now = Date.now(), today = new Date().toISOString().slice(0, 10);
  var ibkrByBase = {};
  positions.forEach(function (p) { if (p.symbol) ibkrByBase[p.symbol.split(" ")[0].toUpperCase()] = p; });
  var updated = [], inconnusIBKR = [], soldees = [];
  var cashMap = ibkrParseCash(st.xml), cashDip = null;
  var syncOne = async function (key, report) {
    var raw = await GDB_KV.get(key);
    var base = null; try { base = raw ? JSON.parse(raw) : null; } catch (e) {}
    if (!base || !base.items) return null;
    var seen = {};
    base.items.forEach(function (it) {
      var cat = it.cat || "", t = (it.t || "").toUpperCase();
      if (cat === "Cash Matelas" || cat === "Cash" || ["USD", "EURO", "KUCOIN", "CASH", "LCL", "BCI", "DEBLOCK"].indexOf(t) >= 0) return;
      var p = ibkrByBase[t];
      if (p) { seen[t] = 1; if ((it.qty || 0) !== p.qty) { if (report) updated.push({ t: it.t, avant: it.qty || 0, apres: p.qty }); it.qty = p.qty; } }
      else if (cat !== "Crypto") {
        if (purge && (it.qty || 0) !== 0) { if (report) soldees.push(it.t); it.qty = 0; it.val = 0; }
        else if ((it.qty || 0) !== 0 && report) soldees.push(it.t + " (sera soldé par la réconciliation txns)");
      }
    });
    // #67d — Cash Dip : aligner le poste USD sur le solde de trésorerie IBKR (si section Cash Report présente)
    if (cashMap && cashMap.USD != null) {
      base.items.forEach(function (it) {
        if ((it.t || "").toUpperCase() === "USD") {
          if (report && (it.val || 0) !== cashMap.USD) cashDip = { avant: it.val || 0, apres: cashMap.USD };
          it.val = cashMap.USD; if (it.qty != null) it.qty = cashMap.USD;
        }
      });
    }
    if (report) Object.keys(ibkrByBase).forEach(function (k) { if (!seen[k]) inconnusIBKR.push(k); });
    if (!dry) { base.date = today; base.ibkrSync = now; await GDB_KV.put(key, JSON.stringify(base)); }
    return true;
  };
  var okPort = await syncOne("cgi_portfolio", true);
  if (!okPort) return { ok: false, error: "cgi_portfolio absent en KV" };
  await syncOne("cgi_stocks", false);
  await syncOne("cgi_crypto", false);
  // #67e — enregistrer les tickers IBKR absents de cgi_yfmap (l'app pourra rafraîchir leurs prix)
  var yfmapAjoutes = [];
  if (!dry) {
    try {
      var ymRaw = await GDB_KV.get("cgi_yfmap"); var ym = {}; try { ym = ymRaw ? (JSON.parse(ymRaw) || {}) : {}; } catch (e) {}
      Object.keys(ibkrByBase).forEach(function (k) {
        if (ibkrByBase[k].assetCategory !== "CRYPTO" && !ym[k]) { ym[k] = k; yfmapAjoutes.push(k); }
      });
      if (yfmapAjoutes.length) await GDB_KV.put("cgi_yfmap", JSON.stringify(ym));
    } catch (e) {}
  }
  var rec = await ibkrReconcileTxns(positions, dry);
  // #67i — mémoriser la VÉRITÉ IBKR : quantités par ticker (actions) + cash USD, horodatées.
  // /write-bases s'en sert pour SUPERPOSER ces valeurs à toute écriture entrante : une app
  // dont l'état local est périmé ne peut plus dégrader le cloud (fin de la boucle boot→clobber).
  if (!dry) {
    try {
      var truthQty = {};
      positions.forEach(function (p) {
        if (p.symbol && p.assetCategory !== "CRYPTO" && p.assetCategory !== "CASH") truthQty[p.symbol.split(" ")[0].toUpperCase()] = p.qty;
      });
      await GDB_KV.put("cgi_ibkr_truth", JSON.stringify({ ts: now, qty: truthQty,
        cashUSD: (cashMap && cashMap.USD != null) ? cashMap.USD : null }));
    } catch (e) {}
  }
  var nTr = dry ? 0 : await ibkrStoreTrades(ibkrParseTrades(st.xml));
  return { ok: true, dry: !!dry, misesAJourQuantites: updated, absentsDuRapport: soldees,
    presentsIBKRseulement: inconnusIBKR, reconciliationTxns: rec, executionsArchivees: nTr,
    yfmapAjoutes: yfmapAjoutes, cashIBKR: cashMap, cashDip: cashDip || "inchangé (ou section Cash Report absente de la Flex Query)", date: today };
}

// ═══ #103/#120 — DIGEST quotidien : alertes en attente + news des positions détenues ═══
// Envoyé en MESSAGE TEXTE (HTML) juste après le baromètre image. Deux sections :
//  🔔 Alertes — la file cgi_pending_alerts (alimentée par l'app quand une alerte de prix pop),
//     incluse puis VIDÉE (chaque alerte n'apparaît que dans un seul message).
//  📰 News — 2 titres récents par position (top 6 par valeur, portefeuille + fonds), via la
//     recherche Yahoo déjà utilisée par /yahoo-chart. Crypto mappée en -USD.
// #NEW — Yahoo /search renvoie par PERTINENCE, pas par date : sans tri ni fenêtre de
// fraîcheur, un vieil article "pertinent" peut remonter en boucle et sembler périmé.
// On récupère plus large (8), on trie par date décroissante, et on ignore tout ce qui
// dépasse 96 h.
async function _digestNewsFor(sym) {
  try {
    // YH est local au handler /yahoo-chart → headers autonomes ici (mêmes essentiels anti-blocage Yahoo)
    var H = { "User-Agent": _UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://finance.yahoo.com/" };
    var nUrl = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(sym)
      + "&newsCount=8&quotesCount=0&enableFuzzyQuery=false&lang=en-US";
    var nr = await fetch(nUrl, { headers: H });
    if (!nr.ok) { nUrl = nUrl.replace("query1","query2"); nr = await fetch(nUrl, { headers: H }); }
    if (!nr.ok) return [];
    var nd = await nr.json();
    var items = (nd && nd.news || []).filter(function (n) { return n.title && n.link; }).map(function (n) {
      return { title: n.title, publisher: n.publisher || "", url: n.link, ts: n.providerPublishTime ? n.providerPublishTime * 1000 : 0 };
    });
    items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var cutoff = Date.now() - 96 * 3600 * 1000;
    items = items.filter(function (n) { return !n.ts || n.ts >= cutoff; });
    return items.slice(0, 3);
  } catch (e) { return []; }
}
function _digestEsc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// ── Habillage éditorial du relevé (registre feutré, jamais tape-à-l'œil) ──
var _DIGEST_RULE = "━━━━━━━━━━━━━━━━━━━━";
var _DIGEST_MOIS_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
function _digestFrDate() {
  var d = new Date(Date.now() + 11 * 3600 * 1000); // même convention horaire (UTC+11) que le reste de l'app
  return d.getDate() + " " + _DIGEST_MOIS_FR[d.getMonth()] + " " + d.getFullYear();
}
function _digestRelTime(ts) {
  if (!ts) return "";
  var h = (Date.now() - ts) / 36e5;
  if (h < 1) return "à l'instant";
  if (h < 24) return "il y a " + Math.round(h) + " h";
  return "il y a " + Math.round(h / 24) + " j";
}
async function sendHoldingsDigest() {
  var parts = [];
  // ── Alertes en attente (puis purge) ──
  var alerts = [];
  try { var rawA = await GDB_KV.get("cgi_pending_alerts"); if (rawA) alerts = JSON.parse(rawA) || []; } catch (e) {}
  if (alerts.length) {
    var la = alerts.slice(-10).map(function (a) {
      var sens = a.kind === "vente" ? "de vente" : "d'achat";
      return "▪ <b>" + _digestEsc(a.ticker) + "</b> — seuil " + sens + " franchi à <code>$" + (Math.round((a.price || 0) * 100) / 100) + "</code> <i>(seuil $" + a.level + ")</i>";
    });
    parts.push("<b>ALERTES DE PRIX</b>\n" + la.join("\n"));
    try { await GDB_KV.put("cgi_pending_alerts", "[]"); } catch (e) {}
  }
  // ── News des positions (top 6 par valeur, crypto + actions) ──
  try {
    var items = [];
    try { var rawP = await GDB_KV.get("cgi_portfolio"); if (rawP) { var pf = JSON.parse(rawP); items = (pf && pf.items) || []; } } catch (e) {}
    var held = items.filter(function (x) { return x && x.t && (x.qty || 0) > 0 && x.cat !== "Cash Matelas" && x.cat !== "Cash"; })
                    .sort(function (a, b) { return (b.val || 0) - (a.val || 0); }).slice(0, 6);
    var yfmap = {}; try { var rawM = await GDB_KV.get("cgi_yfmap"); if (rawM) yfmap = JSON.parse(rawM) || {}; } catch (e) {}
    var CRY = { BTC: 1, ETH: 1, SOL: 1, XRP: 1, ADA: 1, DOGE: 1, BNB: 1, LTC: 1, DOT: 1, AVAX: 1, LINK: 1 };
    // #NEW — dédup PERSISTANTE (inter-jours, via KV) : un article déjà publié dans un
    // relevé précédent ne revient plus jamais, même si Yahoo le remonte à nouveau demain.
    var sentSet = {};
    try { var rawS = await GDB_KV.get("cgi_digest_sent_news"); if (rawS) (JSON.parse(rawS) || []).forEach(function (u) { sentSet[u] = 1; }); } catch (e) {}
    var newlySent = [], newsBlocks = [];
    for (var i = 0; i < held.length; i++) {
      var t = held[i].t.toUpperCase();
      var sym = yfmap[t] || (CRY[t] || held[i].cat === "Crypto" ? t + "-USD" : t);
      var ns = await _digestNewsFor(sym);
      var picked = ns.filter(function (n) { return n.url && !sentSet[n.url]; });
      if (picked.length) {
        picked.forEach(function (n) { newlySent.push(n.url); });
        newsBlocks.push("<b>" + _digestEsc(t) + "</b>\n" + picked.map(function (n) {
          var rel = _digestRelTime(n.ts);
          return "· <a href=\"" + n.url + "\">" + _digestEsc(n.title) + "</a>" + (n.publisher || rel ? "  <i>" + [_digestEsc(n.publisher), rel].filter(Boolean).join(" · ") + "</i>" : "");
        }).join("\n"));
      }
    }
    if (newsBlocks.length) parts.push("<b>ACTUALITÉS DES POSITIONS</b>\n\n" + newsBlocks.join("\n\n"));
    if (newlySent.length) {
      try { await GDB_KV.put("cgi_digest_sent_news", JSON.stringify(newlySent.concat(Object.keys(sentSet)).slice(0, 300))); } catch (e) {}
    }
  } catch (e) {}
  if (!parts.length) return { ok: true, skipped: "rien à envoyer" };
  var header = "🏛 <b>J.C. GLOBAL INVESTMENTS</b>\n<i>Revue quotidienne — " + _digestFrDate() + "</i>\n" + _DIGEST_RULE + "\n\n";
  var footer = "\n\n" + _DIGEST_RULE + "\n<i>Relevé automatique</i>";
  return await sendTelegram(header + parts.join("\n\n") + footer);
}

async function handleScheduled(event) {
  try { await buildAndStoreBench("5y"); } catch (e) {}
  // #67 — positions IBKR rafraîchies avant chaque envoi (no-op si variables absentes ; jamais de purge en cron)
  try { if (_ibkrConfigured()) await ibkrSyncPortfolio(false, false); } catch (e) {}
  // #54 — trades KuCoin récents synchronisés à chaque cron (no-op si variables absentes)
  try { if (_kucoinConfigured()) await kucoinSync(); } catch (e) {}
  var cron = (event && event.cron) || "";
  try {
    if (cron === "0 19 * * *") {
      await sendBarometer("invest");   // #56 — relevé investisseurs quotidien (21 h Paris été)
    } else {
      await sendBarometer();           // #50 — relevé personnel (repli texte intégré)
    }
  } catch (e) {
    try { await sendTelegram("⚠️ Échec du baromètre : " + e.message); } catch (x) {}
  }
  // #103/#120 — digest complémentaire : alertes en attente + news des positions
  try { await sendHoldingsDigest(); } catch (e) {}
  // #172 — bilans : snapshot quotidien (historique) + alerte Telegram si une catégorie
  // ou un actif suivi/détenu a changé de zone (Acheter/Accumuler/Conserver/Alléger/Vendre)
  try { var _bsnap = await buildBilanSnapshot(); await checkBilanAlerts(_bsnap); } catch (e) {}
}
addEventListener("scheduled", function (event) {
  event.waitUntil(handleScheduled(event));
});


// ════════════════════════════════════════════════════════════════════════════
//  #140 — MARKET TAB : routes consommées par MarketDash (app.jsx) — jusqu'ici
//  inexistantes côté serveur, d'où le "Erreur : Not found" / 404 observés dans
//  l'onglet Market. Cache KV léger (5-15 min selon coût), bypass via ?no_cache=1,
//  exactement comme le reste de l'API (cf. /coingecko-coin).
// ════════════════════════════════════════════════════════════════════════════
async function _cachedJson(cacheKey, ttlSec, noCache, builder) {
  if (!noCache) {
    try { var c = await GDB_KV.get(cacheKey); if (c) return JSON.parse(c); } catch (e) {}
  }
  var fresh = await builder();
  try { await GDB_KV.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ttlSec }); } catch (e) {}
  return fresh;
}
async function _yhLastAndPct(sym) {
  var cl = await fetchYahooDailyCloses(sym, "5d");
  var ks = Object.keys(cl).sort();
  if (!ks.length) return { last: null, pct: null };
  var last = cl[ks[ks.length - 1]];
  var prev = ks.length > 1 ? cl[ks[ks.length - 2]] : null;
  var pct = (last != null && prev) ? (last - prev) / prev * 100 : null;
  return { last: last, pct: pct };
}

// ── /market/overview : VIX, dominance BTC, taux souverains US, secteurs S&P500 ──
var SECTOR_ETFS = [
  ["XLK", "Technologie"], ["XLF", "Finance"], ["XLV", "Santé"], ["XLY", "Conso. discrétionnaire"],
  ["XLP", "Conso. de base"], ["XLE", "Énergie"], ["XLI", "Industrie"], ["XLB", "Matériaux"],
  ["XLU", "Services publics"], ["XLRE", "Immobilier"], ["XLC", "Communication"],
];
var TREASURY_SYMS = [["^IRX", "3 mois"], ["^FVX", "5 ans"], ["^TNX", "10 ans"], ["^TYX", "30 ans"]];

async function buildMarketOverview() {
  var vixP = _yhLastAndPct("^VIX");
  var treasuryP = Promise.all(TREASURY_SYMS.map(function (t) {
    return _yhLastAndPct(t[0]).then(function (r) {
      // Yahoo cote ^IRX/^FVX/^TNX/^TYX à 10× le rendement réel (ex. 42.5 => 4,25 %)
      return { symbol: t[0], label: t[1], price: r.last != null ? r.last / 10 : null, pct: r.pct };
    });
  }));
  var sectorsP = Promise.all(SECTOR_ETFS.map(function (s) {
    return _yhLastAndPct(s[0]).then(function (r) { return { symbol: s[0], name: s[1], pct: r.pct }; });
  }));
  var btcDomP = (async function () {
    try {
      var gr = await fetch("https://api.coingecko.com/api/v3/global", { headers: { "Accept": "application/json", "User-Agent": _UA } });
      if (gr.ok) { var gd = await gr.json(); return (gd.data && gd.data.market_cap_percentage && gd.data.market_cap_percentage.btc) || null; }
    } catch (e) {}
    return null;
  })();
  var vix = await vixP, treasury = await treasuryP, sectors = await sectorsP, btcDominance = await btcDomP;
  return { pulse: { vix: vix.last, vixPct: vix.pct, btcDominance: btcDominance }, treasury: treasury, sectors: sectors, ts: Date.now() };
}

// #170 — /market/movers restreint désormais les actions US aux constituants S&P 500 /
// Nasdaq-100, plus les tickers que l'utilisateur suit ou détient (cgi_watchlist /
// cgi_portfolio) : les screeners Yahoo "day_gainers"/"day_losers" bruts remontaient
// des micro-caps ou penny stocks sans rapport avec l'univers de l'app. Listes figées
// (composition des indices, à rafraîchir périodiquement — approximation suffisante
// pour un filtre d'affichage, pas pour un usage réglementaire).
var SP500_TICKERS = ("AAPL,MSFT,NVDA,AMZN,GOOGL,GOOG,META,BRK-B,AVGO,TSLA,LLY,JPM,V,XOM,UNH,MA,PG,COST,JNJ,HD,MRK,ABBV,WMT,KO,CVX,PEP,ADBE,CRM,BAC,NFLX,TMO,MCD,ACN,LIN,ORCL,CSCO,ABT,DHR,WFC,TXN,AMD,PM,NEE,DIS,VZ,INTU,CAT,IBM,GE,NOW,AMGN,CMCSA,QCOM,UNP,COP,LOW,BX,SPGI,RTX,HON,INTC,T,AMAT,BKNG,ISRG,GS,DE,MS,ELV,PLD,UBER,SYK,LMT,BLK,MDT,ETN,AXP,TJX,ADI,VRTX,GILD,BSX,PGR,C,SCHW,MU,LRCX,PANW,REGN,CB,MMC,KLAC,SBUX,ADP,BMY,CI,FI,MO,ANET,SO,ZTS,DUK,PYPL,SNPS,CDNS,EQIX,ICE,SLB,WM,CME,SHW,ITW,PH,MCK,CL,TT,USB,PNC,AON,MCO,HCA,EOG,GD,APH,NKE,EMR,CTAS,MAR,CSX,ORLY,FDX,ECL,PSA,AJG,NOC,WELL,AIG,TDG,ROP,MSI,CARR,FTNT,ADSK,HLT,TFC,NSC,TRV,SPG,OXY,F,GM,AZO,PCAR,MET,AEP,KMB,DHI,PAYX,JCI,SRE,MNST,D,AFL,PSX,CPRT,EW,DXCM,KMI,ALL,VLO,HES,GWW,YUM,LEN,IDXX,CTVA,KDP,MPWR,A,HUM,EXC,IQV,FIS,PRU,KVUE,DFS,MSCI,KHC,LULU,CMI,PWR,XEL,VMC,MLM,FICO,CTSH,DOW,GEHC,TEL,EA,HSY,ROK,ODFL,VRSK,WEC,RSG,SYY,CBRE,EBAY,MPC,ED,GIS,WMB,HPQ,IT,TSCO,EFX,ANSS,DVN,PPG,FAST,VICI,KEYS,GLW,ACGL,CDW,NEM,ON,RMD,ROST,ETR,ZBH,DD,WTW,MTD,CSGP,WBD,IRM,WY,EIX,STZ,APTV,DAL,CHTR,FANG,MCHP,AME,GPN,HAL,DLTR,HIG,NDAQ,LYB,ALGN,AWK,BKR,CAH,LHX,FTV,WAB,ULTA,TROW,XYL,CHD,DTE,EXR,ES,FE,PPL,AEE,CNP,ATO,NI,LNT,EVRG,PNW,GPC,PFG,STE,TYL,J,DOV,HPE,MAA,UDR,ESS,CPT,ARE,KIM,REG,HST,BXP,VTR,AVB,EQR,INVH,SBAC,O,DLR,AMT,CCI,EXPD,JBHT,LDOS,HII,TXT,MAS,ALLE,SNA,SWK,PNR,URI,GNRC,IR,IEX,NDSN,WAT,TECH,INCY,VTRS,COR,CNC,MOH,BIIB,ILMN,DGX,LH,RVTY,WST,HOLX,MTCH,IPG,OMC,LYV,FOXA,FOX,NWSA,NWS,PARA,TTWO,RL,TPR,DECK,GPS,HAS,WHR,MHK,LEG,BWA,LKQ,APA,CTRA,EQT,TRGP,OKE,MRO,FMC,ALB,CF,MOS,IFF,EMN,CE,PKG,IP,AVY,BALL,AMCR,GEN,AKAM,JNPR,FFIV,TER,ZBRA,PTC,EPAM,GDDY,PAYC,BR,JKHY,FLT,WEX,BEN,IVZ,NTRS,STT,BK,FITB,HBAN,RF,CFG,KEY,MTB,ZION,CMA,WBS,PB,CBSH,WAL,SNV,PACW,VNOM,PR,CRK,MTDR,OVV,AR,SM,RRC,DVN,EQT,BG,ADM,K,CAG,CPB,SJM,HRL,TAP,TSN,CLX,CHD,KMB,GIS,MKC,SYY,DG,TGT,EL,KVUE,LKQ,WBA").split(",");
var NASDAQ100_TICKERS = ("AAPL,MSFT,NVDA,AMZN,GOOGL,GOOG,META,AVGO,TSLA,COST,NFLX,ADBE,PEP,AMD,CSCO,TMUS,LIN,INTU,QCOM,TXN,AMGN,ISRG,HON,BKNG,AMAT,VRTX,PANW,ADP,SBUX,GILD,MU,ADI,LRCX,REGN,MDLZ,PYPL,KLAC,SNPS,CDNS,MELI,CTAS,MAR,ORLY,CSX,ABNB,PCAR,CRWD,ROP,NXPI,MRVL,FTNT,DASH,WDAY,CPRT,MNST,ODFL,PAYX,ROST,KDP,AEP,EXC,XEL,FANG,IDXX,VRSK,EA,CTSH,BIIB,GEHC,DXCM,ON,CSGP,CHTR,TTD,ANSS,ZS,TEAM,DDOG,MDB,ILMN,GFS,WBD,SIRI,LULU,MCHP,FAST,KHC,DLTR,ALGN,ENPH,ASML,BIDU,NTES,ARM,APP,PLTR,AXON,CDW").split(",");
// #171 — version détaillée (ticker + cat quand connue, ex. portfolio) : réutilisée à
// la fois par le filtre Top/Flop (juste les tickers) et par le calcul des bilans par
// actif (a besoin de cat pour résoudre le bon symbole Yahoo, cf. _resolveYahooSymbol).
var USER_TICKERS_DETAILED_CACHE = { ts: 0, list: null };
async function _userTrackedTickersDetailed() {
  var now = Date.now();
  if (USER_TICKERS_DETAILED_CACHE.list && (now - USER_TICKERS_DETAILED_CACHE.ts) < 5 * 60 * 1000) return USER_TICKERS_DETAILED_CACHE.list;
  var map = {};
  try {
    var rawP = await GDB_KV.get("cgi_portfolio");
    if (rawP) { var pf = JSON.parse(rawP); ((pf && pf.items) || []).forEach(function (it) { if (it && it.t) { var tk = String(it.t).toUpperCase(); if (!map[tk]) map[tk] = { ticker: tk, cat: it.cat || null }; } }); }
  } catch (e) {}
  try {
    var rawW = await GDB_KV.get("cgi_watchlist");
    if (rawW) { var wl = JSON.parse(rawW); (Array.isArray(wl) ? wl : []).forEach(function (e) { if (e && e.ticker) { var tk = String(e.ticker).toUpperCase(); if (!map[tk]) map[tk] = { ticker: tk, cat: null }; } }); }
  } catch (e) {}
  var list = Object.keys(map).map(function (k) { return map[k]; });
  USER_TICKERS_DETAILED_CACHE = { ts: now, list: list };
  return list;
}
async function _userTrackedTickers() {
  var list = await _userTrackedTickersDetailed();
  var set = {};
  list.forEach(function (o) { set[o.ticker] = 1; });
  return set;
}
async function _allowedStockTickers() {
  var allowed = {};
  SP500_TICKERS.forEach(function (t) { allowed[t] = 1; });
  NASDAQ100_TICKERS.forEach(function (t) { allowed[t] = 1; });
  var userSet = await _userTrackedTickers();
  Object.keys(userSet).forEach(function (t) { allowed[t] = 1; });
  return allowed;
}
async function _yhScreener(scrId, count) {
  var url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=" + scrId + "&count=" + (count || 8);
  var r = await fetch(url, { headers: _YH_HDRS });
  if (!r.ok) { url = url.replace("query1", "query2"); r = await fetch(url, { headers: _YH_HDRS }); }
  if (!r.ok) return [];
  var d = await r.json();
  var res = d && d.finance && d.finance.result && d.finance.result[0];
  var quotes = (res && res.quotes) || [];
  return quotes.map(function (q) { return { symbol: q.symbol, pct: q.regularMarketChangePercent != null ? q.regularMarketChangePercent : null }; });
}
async function buildMarketMovers() {
  var cryptoGainers = [], cryptoLosers = [], stockGainers = [], stockLosers = [];
  try {
    var cgUrl = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h&sparkline=false";
    var cr = await fetch(cgUrl, { headers: { "Accept": "application/json", "User-Agent": _UA } });
    if (cr.ok) {
      var cd = await cr.json();
      var list = (cd || []).filter(function (c) { return c.price_change_percentage_24h != null; })
        .map(function (c) { return { symbol: (c.symbol || "").toUpperCase(), pct: c.price_change_percentage_24h }; });
      var sorted = list.slice().sort(function (a, b) { return b.pct - a.pct; });
      cryptoGainers = sorted.slice(0, 6);
      cryptoLosers = sorted.slice(-6).reverse();
    }
  } catch (e) {}
  try {
    var allowed = await _allowedStockTickers();
    var rawGainers = await _yhScreener("day_gainers", 250);
    var rawLosers = await _yhScreener("day_losers", 250);
    stockGainers = rawGainers.filter(function (q) { return allowed[q.symbol]; }).slice(0, 6);
    stockLosers = rawLosers.filter(function (q) { return allowed[q.symbol]; }).slice(0, 6);
  } catch (e) {}
  return { crypto: { gainers: cryptoGainers, losers: cryptoLosers }, stocks: { gainers: stockGainers, losers: stockLosers }, ts: Date.now() };
}

// ── /funding : taux de financement perpétuels BTC/ETH (Bybit + OKX) + basis NQ ──
async function _bybitFunding(sym) {
  try {
    var r = await fetch("https://api.bybit.com/v5/market/tickers?category=linear&symbol=" + sym, { headers: { "User-Agent": _UA } });
    if (!r.ok) return null;
    var d = await r.json();
    var t = d && d.result && d.result.list && d.result.list[0];
    if (!t) return null;
    var fr = parseFloat(t.fundingRate); // taux par période (8h chez Bybit)
    var apr = isFinite(fr) ? fr * 3 * 365 : null; // 3 paiements/jour × 365 = annualisation
    return { name: "Bybit", apr: apr, oiUsd: parseFloat(t.openInterestValue) || null, volUsd: parseFloat(t.turnover24h) || null, intervalH: 8 };
  } catch (e) { return null; }
}
async function _okxFunding(instId) {
  try {
    var r1 = await fetch("https://www.okx.com/api/v5/public/funding-rate?instId=" + instId, { headers: { "User-Agent": _UA } });
    var d1 = r1.ok ? await r1.json() : null;
    var f = d1 && d1.data && d1.data[0];
    if (!f) return null;
    var fr = parseFloat(f.fundingRate);
    var apr = isFinite(fr) ? fr * 3 * 365 : null;
    var oiUsd = null, volUsd = null;
    try {
      var r2 = await fetch("https://www.okx.com/api/v5/public/open-interest?instId=" + instId, { headers: { "User-Agent": _UA } });
      var d2 = r2.ok ? await r2.json() : null;
      var oi = d2 && d2.data && d2.data[0];
      var r3 = await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + instId, { headers: { "User-Agent": _UA } });
      var d3 = r3.ok ? await r3.json() : null;
      var tk = d3 && d3.data && d3.data[0];
      var px = tk ? parseFloat(tk.last) : null;
      if (oi && px) oiUsd = parseFloat(oi.oiCcy) * px;
      if (tk) volUsd = parseFloat(tk.volCcy24h) || null;
    } catch (e2) {}
    return { name: "OKX", apr: apr, oiUsd: oiUsd, volUsd: volUsd, intervalH: 8 };
  } catch (e) { return null; }
}
function _weightedApr(platforms) {
  var sw = 0, swa = 0;
  platforms.forEach(function (p) { if (p && p.apr != null && p.oiUsd) { sw += p.oiUsd; swa += p.apr * p.oiUsd; } });
  if (sw > 0) return swa / sw;
  var withApr = platforms.filter(function (p) { return p && p.apr != null; });
  return withApr.length ? withApr.reduce(function (a, p) { return a + p.apr; }, 0) / withApr.length : null;
}
async function _cryptoFundingBlock(bybitSym, okxInst) {
  var results = await Promise.all([_bybitFunding(bybitSym), _okxFunding(okxInst)]);
  var platforms = results.filter(Boolean);
  var totalOi = platforms.reduce(function (a, p) { return a + (p.oiUsd || 0); }, 0);
  var totalVol = platforms.reduce(function (a, p) { return a + (p.volUsd || 0); }, 0);
  return { aggApr: _weightedApr(platforms), nPlatforms: platforms.length, totalOiUsd: totalOi || null, totalVolUsd: totalVol || null, platforms: platforms };
}
function _thirdFriday(year, monthIdx0) {
  var d = new Date(Date.UTC(year, monthIdx0, 1));
  var dow = d.getUTCDay();
  var firstFriday = 1 + ((5 - dow + 7) % 7);
  return new Date(Date.UTC(year, monthIdx0, firstFriday + 14));
}
function _nextQuarterlyExpiry(d) {
  var months = [2, 5, 8, 11]; // échéances trimestrielles standard des futures NQ : mars/juin/sept/déc
  var y = d.getUTCFullYear();
  for (var i = 0; i < months.length; i++) { var f = _thirdFriday(y, months[i]); if (f > d) return f; }
  return _thirdFriday(y + 1, 2);
}
async function buildFunding() {
  var btc = await _cryptoFundingBlock("BTCUSDT", "BTC-USDT-SWAP");
  var eth = await _cryptoFundingBlock("ETHUSDT", "ETH-USDT-SWAP");
  var nq = null;
  try {
    var fut = await _yhLastAndPct("NQ=F"), spot = await _yhLastAndPct("^NDX");
    if (fut.last && spot.last) {
      var basisPct = (fut.last - spot.last) / spot.last * 100;
      var now = new Date(), expiry = _nextQuarterlyExpiry(now);
      var days = Math.max(1, Math.round((expiry - now) / 864e5));
      nq = { basisPct: basisPct, annualizedPct: basisPct * (365 / days), expiry: expiry.toISOString().slice(0, 10), daysToExpiry: days };
    }
  } catch (e) {}
  return { btc: btc, eth: eth, nq_basis: nq, ts: Date.now() };
}

// ── /market/flows : momentum multi-actifs (proxies ETF/futures) 1sem/1mois/3mois ──
// #169 — étoffe la liste (8 → 20 classes) : ajoute les 11 secteurs S&P 500, les
// marchés internationaux (zone euro, émergents), le crédit et l'argent métal,
// pour une vue de rotation beaucoup plus complète qu'un simple momentum multi-actifs.
var ASSET_CLASSES = [
  ["SPY", "Actions US (S&P 500)", "📈"], ["QQQ", "Tech US (Nasdaq)", "💻"], ["IWM", "Small caps US", "🏭"],
  ["EFA", "Actions zone euro/Japon", "🌍"], ["EEM", "Marchés émergents", "🌏"],
  ["TLT", "Obligations US 20y+", "🏦"], ["HYG", "Crédit high-yield", "💳"],
  ["DX-Y.NYB", "Dollar (DXY)", "💵"], ["GLD", "Or", "🥇"], ["SLV", "Argent", "🥈"], ["USO", "Pétrole", "🛢️"],
  ["BTC-USD", "Bitcoin", "₿"],
  ["XLK", "Secteur Tech", "🖥️"], ["XLF", "Secteur Finance", "🏛️"], ["XLE", "Secteur Énergie", "⚡"],
  ["XLV", "Secteur Santé", "💊"], ["XLI", "Secteur Industrie", "🏗️"], ["XLP", "Secteur Conso. de base", "🛒"],
  ["XLY", "Secteur Conso. discrétionnaire", "🛍️"], ["XLU", "Secteur Utilities", "💡"],
];
function _perfFromCloses(cl, days) {
  var ks = Object.keys(cl).sort();
  if (!ks.length) return null;
  var last = cl[ks[ks.length - 1]];
  var targetTs = Date.now() - days * 864e5;
  var best = null, bestDt = Infinity;
  ks.forEach(function (k) { var dt = Math.abs(new Date(k + "T00:00:00Z").getTime() - targetTs); if (dt < bestDt) { bestDt = dt; best = cl[k]; } });
  if (best == null || !last) return null;
  return (last - best) / best * 100;
}
async function buildMarketFlows() {
  // #169 — étend l'historique à 2 ans (au lieu de 6 mois) pour pouvoir calculer
  // les nouvelles fenêtres 6 mois / 1 an / 2 ans, en plus de 1 semaine/1 mois/3 mois.
  var classes = await Promise.all(ASSET_CLASSES.map(async function (a) {
    try {
      var cl = await fetchYahooDailyCloses(a[0], "2y");
      return { symbol: a[0], name: a[1], emoji: a[2], perf: {
        w1: _perfFromCloses(cl, 7), m1: _perfFromCloses(cl, 30), m3: _perfFromCloses(cl, 90),
        m6: _perfFromCloses(cl, 180), y1: _perfFromCloses(cl, 365), y2: _perfFromCloses(cl, 730)
      } };
    } catch (e) { return { symbol: a[0], name: a[1], emoji: a[2], perf: {} }; }
  }));
  return { classes: classes, ts: Date.now() };
}

// ── /btc-signals : indicateurs de cycle Bitcoin (prix + hashrate + Fear&Greed) ──
// Les 7 métriques on-chain avancées (MVRV-Z, NUPL, Reserve Risk, RHODL, STH-MVRV,
// aSOPR, VDD) sont recalculées CÔTÉ CLIENT depuis bitcoin-data.com (gratuit, sans
// clé, cf. fetchOnchainBtc dans app.jsx) — ce endpoint fournit un placeholder pour
// ces 7 clés (affiché "—" si l'appel client échoue) + tout ce qui se déduit du
// seul historique de prix + hashrate + sentiment social, calculable côté serveur.
function _sma(arr, n, idx) { if (idx + 1 < n) return null; var s = 0; for (var i = idx - n + 1; i <= idx; i++) s += arr[i]; return s / n; }
function _ema(arr, n) {
  if (arr.length < n) return null;
  var k = 2 / (n + 1), e = arr.slice(0, n).reduce(function (a, b) { return a + b; }, 0) / n;
  for (var i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function _rsi(arr, n) {
  if (arr.length < n + 1) return null;
  var gains = 0, losses = 0;
  for (var i = arr.length - n; i < arr.length; i++) { var d = arr[i] - arr[i - 1]; if (d > 0) gains += d; else losses -= d; }
  var ag = gains / n, al = losses / n;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function _weeklyCloses(dailyCloses) {
  var ks = Object.keys(dailyCloses).sort(), out = [];
  for (var i = 0; i < ks.length; i += 7) out.push(dailyCloses[ks[Math.min(i + 6, ks.length - 1)]]);
  return out;
}
// ════════════════════════════════════════════════════════════════════════════
//  #144 — Dominance BTC avec repli KV : CoinGecko rate-limite agressivement les
//  IP partagées des Workers Cloudflare (429 fréquent), ce qui faisait afficher
//  "—" côté client la plupart du temps. On garde la dernière valeur connue en
//  KV et on ne renvoie null que si on n'a JAMAIS réussi à en obtenir une.
// ════════════════════════════════════════════════════════════════════════════
async function _getBtcDominance() {
  var cacheKey = "cgi_btc_dom_cache";
  var fresh = null;
  try {
    var gr = await fetch("https://api.coingecko.com/api/v3/global", { headers: { "Accept": "application/json", "User-Agent": _UA } });
    if (gr.ok) {
      var gd = await gr.json();
      var v = gd.data && gd.data.market_cap_percentage && gd.data.market_cap_percentage.btc;
      if (typeof v === "number") fresh = v;
    }
  } catch (e) {}
  if (fresh != null) {
    try { await GDB_KV.put(cacheKey, JSON.stringify({ v: fresh, ts: Date.now() })); } catch (e) {}
    return fresh;
  }
  try {
    var cached = await GDB_KV.get(cacheKey);
    if (cached) { var cd = JSON.parse(cached); if (typeof cd.v === "number") return cd.v; }
  } catch (e) {}
  return null;
}

// ── Helpers partagés pour les nouveaux indicateurs Actions / Santé globale ──
async function _relativeMomentum(symA, symB, days) {
  try {
    var clA = await fetchYahooDailyCloses(symA, "1y");
    var clB = await fetchYahooDailyCloses(symB, "1y");
    var pA = _perfFromCloses(clA, days), pB = _perfFromCloses(clB, days);
    return (pA != null && pB != null) ? (pA - pB) : null;
  } catch (e) { return null; }
}

// Dernière valeur (+ variation sur 1 an) d'une série FRED via l'export CSV public
// (fred.stlouisfed.org/graph/fredgraph.csv?id=...) — endpoint sans clé API, utilisé
// par le widget de graphique FRED lui-même, donc stable et non soumis à un quota.
async function _fredLatest(seriesId) {
  try {
    var r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + seriesId, { headers: { "User-Agent": _UA } });
    if (!r.ok) return null;
    var text = await r.text();
    var lines = text.trim().split("\n");
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var parts = lines[i].split(",");
      var v = parseFloat(parts[1]);
      if (parts[0] && isFinite(v)) rows.push([parts[0], v]);
    }
    if (!rows.length) return null;
    var last = rows[rows.length - 1];
    var targetTs = new Date(last[0]).getTime() - 365 * 864e5;
    var best = null, bestDt = Infinity;
    rows.forEach(function (row) { var dt = Math.abs(new Date(row[0]).getTime() - targetTs); if (dt < bestDt) { bestDt = dt; best = row; } });
    var yoy = (best && best[1]) ? (last[1] - best[1]) / Math.abs(best[1]) * 100 : null;
    return { value: last[1], yoy: yoy, date: last[0] };
  } catch (e) { return null; }
}

// ── Catégorie "Actions" : indicateurs de cycle/valorisation/momentum du S&P 500 ──
async function buildActionsSignals() {
  var indicators = [];
  function add(key, name, weight, value, heat, zone, explain) { indicators.push({ key: key, name: name, weight: weight, value: value, heat: heat, zone: zone, explain: explain }); }
  var cl2 = function (v, lo, hi) { return v == null ? null : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };

  try {
    var cl = await fetchYahooDailyCloses("SPY", "5y");
    var ks = Object.keys(cl).sort();
    var closes = ks.map(function (k) { return cl[k]; });
    var price = closes.length ? closes[closes.length - 1] : null;
    var idx = closes.length - 1;

    var sma200 = _sma(closes, 200, idx);
    var mayer = (price && sma200) ? price / sma200 : null;
    add("act_mayer", "Mayer Multiple (S&P 500)", 3, mayer != null ? mayer.toFixed(2) : "—", cl2(mayer, 0.82, 1.22),
      mayer == null ? "" : (mayer < 0.9 ? "Sous la SMA200 — repli marqué" : mayer > 1.15 ? "Extension haussière prononcée" : "Neutre"),
      "Prix du S&P 500 (SPY) / moyenne mobile 200 jours. Version actions du Mayer Multiple, recalibrée à la volatilité plus faible des indices actions.");

    var sma730 = _sma(closes, 730, idx);
    var ma2y = (price && sma730) ? price / sma730 : null;
    add("act_ma2y", "MA Multiplier (2 ans)", 2, ma2y != null ? ma2y.toFixed(2) : "—", cl2(ma2y, 0.85, 1.35),
      ma2y == null ? "" : (ma2y < 0.95 ? "Proche/sous la MA 2 ans — accumulation" : ma2y > 1.25 ? "Bien au-dessus — cycle avancé" : "Neutre"),
      "Prix / moyenne mobile 730 jours (2 ans) du S&P 500.");

    var sma1400 = _sma(closes, 1400, idx);
    var ma200w = (price && sma1400) ? price / sma1400 : null;
    add("act_ma200w", "MA 200 semaines", 2, ma200w != null ? ma200w.toFixed(2) : "—", cl2(ma200w, 0.9, 1.5),
      ma200w == null ? "" : (ma200w < 1 ? "Sous la MA 200 semaines — signal rare, historiquement baissier majeur" : "Au-dessus — tendance de fond haussière"),
      "Prix / moyenne mobile 200 semaines (~1400 jours). Le S&P 500 n'est repassé sous ce seuil qu'en 2008-2009 et 2020.");

    var sma111 = _sma(closes, 111, idx), sma350 = _sma(closes, 350, idx);
    var piTop = (sma111 && sma350) ? sma111 / (sma350 * 2) : null;
    add("act_picycle", "Pi Cycle Top", 1, piTop != null ? piTop.toFixed(2) : "—", cl2(piTop, 0.6, 1),
      piTop == null ? "" : (piTop >= 1 ? "Croisement effectif — signal de surchauffe" : "Éloigné du signal"),
      "SMA 111 jours vs 2× SMA 350 jours, adapté du modèle Bitcoin au S&P 500.");

    var sma150 = _sma(closes, 150, idx), sma471 = _sma(closes, 471, idx);
    var piBot = (sma150 && sma471) ? sma150 / (sma471 * 0.745) : null;
    add("act_picyclebot", "Pi Cycle Bottom", 1, piBot != null ? piBot.toFixed(2) : "—", cl2(piBot, 0.85, 1.15),
      piBot == null ? "" : (piBot <= 1 ? "Croisement effectif — signal de creux" : "Éloigné du signal"),
      "SMA 150 jours vs 0,745× SMA 471 jours, adapté du modèle Bitcoin au S&P 500.");

    var weekly = _weeklyCloses(cl);
    var rsiw = _rsi(weekly, 14);
    add("act_rsiw", "RSI hebdomadaire", 2, rsiw != null ? rsiw.toFixed(0) : "—", rsiw,
      rsiw == null ? "" : (rsiw > 70 ? "Surachat hebdomadaire" : rsiw < 30 ? "Survente hebdomadaire" : "Neutre"),
      "Force relative sur clôtures hebdomadaires du S&P 500.");

    var rsid = _rsi(closes, 14);
    add("act_rsid", "RSI quotidien", 1, rsid != null ? rsid.toFixed(0) : "—", rsid,
      rsid == null ? "" : (rsid > 70 ? "Surachat court terme" : rsid < 30 ? "Survente court terme" : "Neutre"),
      "Force relative sur clôtures quotidiennes du S&P 500 — signal plus réactif que la version hebdomadaire.");

    var sma20w = _sma(weekly, 20, weekly.length - 1);
    var ema21w = _ema(weekly.slice(-Math.min(weekly.length, 200)), 21);
    var bmsbMid = (sma20w && ema21w) ? (sma20w + ema21w) / 2 : null;
    var bmsbRatio = (price && bmsbMid) ? price / bmsbMid : null;
    add("act_bmsb", "Bull Market Support Band", 2, bmsbRatio != null ? bmsbRatio.toFixed(2) : "—", cl2(bmsbRatio, 0.85, 1.25),
      bmsbRatio == null ? "" : (bmsbRatio < 1 ? "Prix sous la bande — test de support" : "Prix au-dessus de la bande"),
      "Position du prix par rapport à la bande SMA 20 semaines / EMA 21 semaines du S&P 500.");

    var ema9 = _ema(closes.slice(-60), 9), ema18 = _ema(closes.slice(-60), 18);
    var ema918 = (ema9 && ema18) ? ema9 / ema18 : null;
    add("act_ema918", "Croisement EMA 9/18", 1, ema918 != null ? ema918.toFixed(3) : "—", cl2(ema918, 0.96, 1.04),
      ema918 == null ? "" : (ema918 > 1 ? "Momentum haussier court terme" : "Momentum baissier court terme"),
      "Moyennes mobiles exponentielles 9 et 18 jours du S&P 500.");

    var mom1m = _perfFromCloses(cl, 30), mom3m = _perfFromCloses(cl, 90);
    add("act_mom1m", "Momentum 1 mois", 2, mom1m != null ? ((mom1m >= 0 ? "+" : "") + mom1m.toFixed(1) + "%") : "—", cl2(mom1m, -10, 10),
      mom1m == null ? "" : (mom1m < -5 ? "Correction en cours" : mom1m > 5 ? "Rallye marqué" : "Neutre"),
      "Performance du S&P 500 sur les 30 derniers jours.");
    add("act_mom3m", "Momentum 3 mois", 2, mom3m != null ? ((mom3m >= 0 ? "+" : "") + mom3m.toFixed(1) + "%") : "—", cl2(mom3m, -15, 15),
      mom3m == null ? "" : (mom3m < -10 ? "Tendance baissière installée" : mom3m > 10 ? "Tendance haussière forte" : "Neutre"),
      "Performance du S&P 500 sur les 90 derniers jours.");

    var win = closes.slice(-Math.min(252, closes.length));
    var hi = Math.max.apply(null, win), lo = Math.min.apply(null, win);
    var rangePos = (hi > lo && price != null) ? (price - lo) / (hi - lo) * 100 : null;
    add("act_range52", "Position 52 semaines", 1, rangePos != null ? rangePos.toFixed(0) + "%" : "—", rangePos,
      rangePos == null ? "" : (rangePos > 90 ? "Proche des plus hauts annuels" : rangePos < 10 ? "Proche des plus bas annuels" : "Neutre"),
      "Position du prix dans son range des 52 dernières semaines (0% = plus bas, 100% = plus haut).");

    var ath = Math.max.apply(null, closes);
    var drawdown = (price != null && ath) ? (price - ath) / ath * 100 : null;
    add("act_drawdown", "Écart au plus haut historique", 2, drawdown != null ? drawdown.toFixed(1) + "%" : "—", cl2(drawdown, -35, 0),
      drawdown == null ? "" : (drawdown < -20 ? "Correction sévère en cours" : drawdown > -3 ? "Proche des plus hauts historiques" : "Neutre"),
      "Écart du S&P 500 par rapport à son plus haut historique sur la période observée (5 ans).");
  } catch (e) {}

  try {
    var vixR = await _yhLastAndPct("^VIX");
    if (vixR.last != null) {
      add("act_vix", "VIX (volatilité implicite)", 3, vixR.last.toFixed(1), cl2(vixR.last, 11, 35),
        vixR.last > 28 ? "Stress de marché élevé" : vixR.last < 14 ? "Complaisance" : "Neutre",
        "Volatilité implicite des options sur le S&P 500 (indice de la peur). Au-dessus de 28 : stress ; sous 14 : complaisance.");
    }
    var vix3mR = await _yhLastAndPct("^VIX3M");
    if (vixR.last != null && vix3mR.last != null) {
      var ts2 = vixR.last / vix3mR.last;
      add("act_vixts", "Structure à terme VIX", 2, ts2.toFixed(3), cl2(ts2, 0.8, 1.1),
        ts2 >= 1 ? "Backwardation — stress à court terme" : "Contango — régime normal",
        "Ratio VIX / VIX à 3 mois. Au-dessus de 1 (backwardation), le marché anticipe un stress immédiat — situation rare, associée aux phases de panique.");
    }
  } catch (e) {}

  try {
    var smallVsLarge = await _relativeMomentum("IWM", "SPY", 63);
    add("act_smallcap", "Small caps vs Large caps", 2, smallVsLarge != null ? ((smallVsLarge >= 0 ? "+" : "") + smallVsLarge.toFixed(1) + " pts") : "—", cl2(smallVsLarge, -10, 10),
      smallVsLarge == null ? "" : (smallVsLarge < -5 ? "Fuite vers la qualité" : smallVsLarge > 5 ? "Appétit pour le risque" : "Neutre"),
      "Écart de performance 3 mois entre les small caps (IWM) et le S&P 500 (SPY). Une sous-performance persistante signale une préférence pour la qualité.");

    var nqVsSp = await _relativeMomentum("QQQ", "SPY", 63);
    add("act_nasdaq", "Nasdaq vs S&P 500", 2, nqVsSp != null ? ((nqVsSp >= 0 ? "+" : "") + nqVsSp.toFixed(1) + " pts") : "—", cl2(nqVsSp, -10, 10),
      nqVsSp == null ? "" : (nqVsSp > 5 ? "Leadership tech/croissance" : nqVsSp < -5 ? "Rotation vers la value" : "Neutre"),
      "Écart de performance 3 mois entre le Nasdaq 100 (QQQ) et le S&P 500 (SPY).");

    var eqwVsCap = await _relativeMomentum("RSP", "SPY", 63);
    add("act_eqw", "Équipondéré vs cap-pondéré", 2, eqwVsCap != null ? ((eqwVsCap >= 0 ? "+" : "") + eqwVsCap.toFixed(1) + " pts") : "—", cl2(eqwVsCap, -8, 8),
      eqwVsCap == null ? "" : (eqwVsCap < -4 ? "Hausse concentrée sur quelques poids lourds — fragilité" : "Hausse large — participation saine"),
      "Écart de performance 3 mois entre le S&P 500 équipondéré (RSP) et le S&P 500 cap-pondéré (SPY). Un fort écart négatif signale une hausse concentrée sur peu de titres.");

    var cyclDef = await _relativeMomentum("XLY", "XLP", 63);
    add("act_rotation", "Rotation cyclique vs défensive", 1, cyclDef != null ? ((cyclDef >= 0 ? "+" : "") + cyclDef.toFixed(1) + " pts") : "—", cl2(cyclDef, -10, 10),
      cyclDef == null ? "" : (cyclDef > 5 ? "Appétit pour le risque (cyclique)" : cyclDef < -5 ? "Prudence (défensif)" : "Neutre"),
      "Écart de performance 3 mois entre la consommation discrétionnaire (XLY, cyclique) et la consommation de base (XLP, défensive).");
  } catch (e) {}

  try {
    var breadthSyms = ["XLK", "XLF", "XLV", "XLY", "XLP", "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC"];
    var above = 0, total = 0;
    for (var i = 0; i < breadthSyms.length; i++) {
      try {
        var bc = await fetchYahooDailyCloses(breadthSyms[i], "1y");
        var bks = Object.keys(bc).sort();
        var bcloses = bks.map(function (k) { return bc[k]; });
        var bidx = bcloses.length - 1;
        var bsma = _sma(bcloses, 200, bidx);
        if (bsma && bcloses.length) { total++; if (bcloses[bidx] > bsma) above++; }
      } catch (e2) {}
    }
    if (total > 0) {
      var breadthPct = above / total * 100;
      add("act_breadth", "Largeur de marché (proxy)", 2, Math.round(breadthPct) + "%", breadthPct,
        breadthPct >= 80 ? "Participation large — tendance saine" : breadthPct <= 30 ? "Participation étroite — tendance fragile" : "Neutre",
        above + "/" + total + " secteurs S&P 500 au-dessus de leur moyenne mobile 200 jours — proxy de largeur de marché en l'absence de données de breadth par titre.");
    }
  } catch (e) {}

  return indicators;
}

// ── Catégorie "Santé globale du marché" : taux, banques centrales, crédit, macro ──
async function buildMacroSignals() {
  var indicators = [];
  function add(key, name, weight, value, heat, zone, explain) { indicators.push({ key: key, name: name, weight: weight, value: value, heat: heat, zone: zone, explain: explain }); }
  var cl2 = function (v, lo, hi) { return v == null ? null : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };

  var treasuryVals = {};
  try {
    var TSYMS = [["^IRX", "3 mois"], ["^FVX", "5 ans"], ["^TNX", "10 ans"], ["^TYX", "30 ans"]];
    for (var i = 0; i < TSYMS.length; i++) {
      var t = TSYMS[i];
      var r = await _yhLastAndPct(t[0]);
      var v = r.last != null ? r.last / 10 : null;
      treasuryVals[t[0]] = v;
      add("macro_" + t[0].replace(/[^A-Za-z]/g, ""), "Taux " + t[1], 2, v != null ? v.toFixed(2) + "%" : "—", cl2(v, 0, 6),
        "", "Rendement du Trésor américain à " + t[1] + " (Yahoo Finance).");
    }
    var irx = treasuryVals["^IRX"], tnx = treasuryVals["^TNX"], tyx = treasuryVals["^TYX"];
    if (irx != null && tnx != null) {
      var spread1 = tnx - irx;
      add("macro_curve_10y3m", "Spread 10 ans - 3 mois", 3, (spread1 >= 0 ? "+" : "") + spread1.toFixed(2) + " pts", cl2(spread1, -1.5, 2),
        spread1 < 0 ? "Courbe inversée — signal de récession historiquement fiable" : "Courbe normale",
        "Écart entre le rendement à 10 ans et à 3 mois. Une inversion (valeur négative) a précédé chacune des dernières récessions américaines avec 6 à 18 mois d'avance.");
    }
    if (tyx != null && tnx != null) {
      var spread2 = tyx - tnx;
      add("macro_curve_30y10y", "Spread 30 ans - 10 ans", 1, (spread2 >= 0 ? "+" : "") + spread2.toFixed(2) + " pts", cl2(spread2, -0.3, 1),
        spread2 < 0 ? "Partie longue inversée — anticipation de désinflation durable" : "Courbe longue normale",
        "Écart entre le rendement à 30 ans et à 10 ans.");
    }
  } catch (e) {}

  try {
    var dxy = await _yhLastAndPct("DX-Y.NYB");
    add("macro_dxy", "Indice dollar (DXY)", 2, dxy.last != null ? dxy.last.toFixed(1) : "—", null,
      dxy.pct != null ? ((dxy.pct >= 0 ? "+" : "") + dxy.pct.toFixed(2) + "% sur la séance") : "",
      "Force du dollar américain face à un panier de devises. Un dollar fort resserre les conditions financières mondiales.");
    var gld = await _yhLastAndPct("GLD");
    add("macro_gold", "Or (momentum)", 1, gld.pct != null ? ((gld.pct >= 0 ? "+" : "") + gld.pct.toFixed(2) + "%") : "—", null,
      "", "Variation quotidienne du cours de l'or — indicateur de flux vers les valeurs refuges.");
    var uso = await _yhLastAndPct("USO");
    add("macro_oil", "Pétrole (momentum)", 1, uso.pct != null ? ((uso.pct >= 0 ? "+" : "") + uso.pct.toFixed(2) + "%") : "—", null,
      "", "Variation quotidienne du pétrole (USO) — pression inflationniste potentielle sur les coûts de l'énergie.");
  } catch (e) {}

  try {
    var hyMom = await _relativeMomentum("HYG", "IEF", 63);
    add("macro_hy", "Spread crédit high-yield", 2, hyMom != null ? ((hyMom >= 0 ? "+" : "") + hyMom.toFixed(1) + " pts") : "—", cl2(hyMom, -8, 8),
      hyMom == null ? "" : (hyMom < -4 ? "Écartement du crédit — aversion au risque" : "Resserrement du crédit — appétit pour le risque"),
      "Écart de performance 3 mois entre les obligations high-yield (HYG) et les bons du Trésor (IEF). Une sous-performance du high-yield signale un écartement des spreads de crédit.");
    var igMom = await _relativeMomentum("LQD", "IEF", 63);
    add("macro_ig", "Spread crédit investment-grade", 1, igMom != null ? ((igMom >= 0 ? "+" : "") + igMom.toFixed(1) + " pts") : "—", cl2(igMom, -6, 6),
      "", "Écart de performance 3 mois entre les obligations investment-grade (LQD) et les bons du Trésor (IEF).");
  } catch (e) {}

  try {
    var tltCl = await fetchYahooDailyCloses("TLT", "6mo");
    var tks = Object.keys(tltCl).sort();
    var tcloses = tks.map(function (k) { return tltCl[k]; });
    if (tcloses.length > 21) {
      var rets = [];
      for (var i2 = tcloses.length - 20; i2 < tcloses.length; i2++) rets.push((tcloses[i2] - tcloses[i2 - 1]) / tcloses[i2 - 1]);
      var meanR = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
      var variance = rets.reduce(function (a, b) { return a + (b - meanR) * (b - meanR); }, 0) / rets.length;
      var vol = Math.sqrt(variance) * Math.sqrt(252) * 100;
      add("macro_bondvol", "Volatilité obligataire (proxy)", 1, vol.toFixed(1) + "%", cl2(vol, 5, 20),
        vol > 15 ? "Tensions sur le marché obligataire" : "Calme obligataire",
        "Volatilité annualisée réalisée sur 20 séances des obligations du Trésor long terme (TLT) — proxy de l'indice MOVE.");
    }
  } catch (e) {}

  try {
    var spyCl = await fetchYahooDailyCloses("SPY", "6mo");
    var tltCl2 = await fetchYahooDailyCloses("TLT", "6mo");
    var dates = Object.keys(spyCl).filter(function (dt) { return tltCl2[dt] != null; }).sort().slice(-60);
    if (dates.length > 20) {
      var spyRets = [], tltRets = [];
      for (var j = 1; j < dates.length; j++) {
        spyRets.push((spyCl[dates[j]] - spyCl[dates[j - 1]]) / spyCl[dates[j - 1]]);
        tltRets.push((tltCl2[dates[j]] - tltCl2[dates[j - 1]]) / tltCl2[dates[j - 1]]);
      }
      var n = spyRets.length;
      var meanS = spyRets.reduce(function (a, b) { return a + b; }, 0) / n;
      var meanT = tltRets.reduce(function (a, b) { return a + b; }, 0) / n;
      var cov = 0, varS = 0, varT = 0;
      for (var k = 0; k < n; k++) { cov += (spyRets[k] - meanS) * (tltRets[k] - meanT); varS += Math.pow(spyRets[k] - meanS, 2); varT += Math.pow(tltRets[k] - meanT, 2); }
      var corr = (varS > 0 && varT > 0) ? cov / Math.sqrt(varS * varT) : null;
      if (corr != null) {
        add("macro_corr", "Corrélation actions/obligations", 2, corr.toFixed(2), cl2(corr, -0.5, 0.5),
          corr > 0.2 ? "Corrélation positive — régime inhabituel, diversification actions/obligations réduite" : "Corrélation négative — régime classique",
          "Corrélation glissante 60 jours entre le S&P 500 (SPY) et les obligations longues (TLT). Historiquement négative ; une bascule positive prolongée signale un changement de régime macro (ex. 2022).");
      }
    }
  } catch (e) {}

  try {
    var ff = await _fredLatest("FEDFUNDS");
    if (ff) add("macro_fedfunds", "Taux Fed Funds", 3, ff.value.toFixed(2) + "%", cl2(ff.value, 0, 6),
      ff.value > 4.5 ? "Politique restrictive" : ff.value < 1 ? "Politique accommodante" : "Neutre",
      "Taux directeur effectif de la Réserve fédérale américaine (FRED, série FEDFUNDS, " + ff.date + ").");

    var cpi = await _fredLatest("CPIAUCSL");
    if (cpi && cpi.yoy != null) {
      add("macro_cpi", "Inflation CPI (YoY)", 3, (cpi.yoy >= 0 ? "+" : "") + cpi.yoy.toFixed(1) + "%", cl2(cpi.yoy, 0, 6),
        cpi.yoy > 3 ? "Inflation au-dessus de la cible de la Fed" : cpi.yoy < 1 ? "Désinflation marquée" : "Proche de la cible (~2%)",
        "Indice des prix à la consommation américain, variation sur un an (FRED, série CPIAUCSL, " + cpi.date + ").");
      if (tnx != null) {
        var realYield = tnx - cpi.yoy;
        add("macro_realyield", "Taux réel 10 ans (approx.)", 2, (realYield >= 0 ? "+" : "") + realYield.toFixed(2) + " pts", cl2(realYield, -2, 3),
          realYield < 0 ? "Taux réel négatif — conditions financières accommodantes" : "Taux réel positif — conditions plus restrictives",
          "Rendement nominal à 10 ans moins l'inflation CPI sur un an. Approxime le rendement réel offert aux investisseurs obligataires.");
      }
    }

    var un = await _fredLatest("UNRATE");
    if (un) add("macro_unrate", "Taux de chômage US", 2, un.value.toFixed(1) + "%", cl2(un.value, 3, 8),
      un.value > 5 ? "Marché du travail qui se dégrade" : "Marché du travail tendu",
      "Taux de chômage américain (FRED, série UNRATE, " + un.date + ").");

    var umc = await _fredLatest("UMCSENT");
    if (umc) add("macro_umcsent", "Confiance des consommateurs (UMich)", 1, Math.round(umc.value).toString(), cl2(umc.value, 55, 100),
      umc.value < 70 ? "Confiance dégradée" : umc.value > 90 ? "Confiance élevée" : "Neutre",
      "Indice de confiance des consommateurs de l'Université du Michigan (FRED, série UMCSENT, " + umc.date + ").");

    var indpro = await _fredLatest("INDPRO");
    if (indpro && indpro.yoy != null) add("macro_indpro", "Production industrielle (YoY)", 1, (indpro.yoy >= 0 ? "+" : "") + indpro.yoy.toFixed(1) + "%", cl2(indpro.yoy, -5, 5),
      indpro.yoy < 0 ? "Contraction de l'activité industrielle" : "Expansion de l'activité industrielle",
      "Indice de production industrielle américain, variation sur un an (FRED, série INDPRO, " + indpro.date + ").");
  } catch (e) {}

  try {
    var copperGold = await _relativeMomentum("CPER", "GLD", 63);
    add("macro_coppergold", "Ratio cuivre/or (croissance)", 2, copperGold != null ? ((copperGold >= 0 ? "+" : "") + copperGold.toFixed(1) + " pts") : "—", cl2(copperGold, -10, 10),
      copperGold == null ? "" : (copperGold < -5 ? "Anticipation de ralentissement — flux vers les valeurs refuges" : copperGold > 5 ? "Anticipation de croissance — appétit pour le risque" : "Neutre"),
      "Écart de performance 3 mois entre le cuivre (CPER, sensible à la demande industrielle) et l'or (GLD, valeur refuge) — le \"Dr. Copper\" est suivi comme baromètre de la croissance mondiale.");
  } catch (e) {}

  return indicators;
}

async function buildBtcSignals() {
  var indicators = [];
  function add(key, name, weight, value, heat, zone, explain) {
    indicators.push({ key: key, name: name, weight: weight, value: value, heat: heat, zone: zone, explain: explain });
  }
  var price = null;
  try {
    var cl = await fetchYahooDailyCloses("BTC-USD", "5y");
    var ks = Object.keys(cl).sort();
    var closes = ks.map(function (k) { return cl[k]; });
    price = closes.length ? closes[closes.length - 1] : null;
    var idx = closes.length - 1;
    var cl2 = function (v, lo, hi) { return v == null ? null : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };

    var sma200 = _sma(closes, 200, idx);
    var mayer = (price && sma200) ? price / sma200 : null;
    add("mayer", "Mayer Multiple", 3, mayer != null ? mayer.toFixed(2) : "—", cl2(mayer, 0.6, 2.4),
      mayer == null ? "" : (mayer < 1 ? "Sous-évalué (< SMA200)" : mayer > 2.4 ? "Historiquement en zone de bulle" : "Neutre"),
      "Prix / moyenne mobile 200 jours. Zone d'achat historique sous 1, zone de bulle au-dessus de 2,4 (seuil de Trace Mayer).");

    var sma730 = _sma(closes, 730, idx);
    var ma2y = (price && sma730) ? price / sma730 : null;
    add("ma2y", "MA Multiplier (2 ans)", 3, ma2y != null ? ma2y.toFixed(2) : "—", cl2(ma2y, 0.9, 5),
      ma2y == null ? "" : (ma2y < 1.2 ? "Proche de la bande basse — accumulation" : ma2y > 4 ? "Proche de la bande haute — euphorie" : "Neutre"),
      "Prix / moyenne mobile 730 jours (2 ans). Les creux de cycle se produisent historiquement près de la MA, les sommets à 3-5× la MA.");

    var sma1400 = _sma(closes, 1400, idx);
    var ma200w = (price && sma1400) ? price / sma1400 : null;
    add("ma200w", "MA 200 semaines", 3, ma200w != null ? ma200w.toFixed(2) : "—", cl2(ma200w, 1, 3),
      ma200w == null ? "" : (ma200w < 1.3 ? "Proche du plancher historique de cycle" : ma200w > 2.5 ? "Bien au-dessus — cycle avancé" : "Neutre"),
      "Prix / moyenne mobile 200 semaines (~1400 jours). Le prix n'a historiquement jamais durablement cassé cette moyenne à la baisse.");

    var sma111 = _sma(closes, 111, idx), sma350 = _sma(closes, 350, idx);
    var piTop = (sma111 && sma350) ? sma111 / (sma350 * 2) : null;
    add("picycle", "Pi Cycle Top", 2, piTop != null ? piTop.toFixed(2) : "—", cl2(piTop, 0.5, 1),
      piTop == null ? "" : (piTop >= 1 ? "Croisement effectif — signal de sommet historique" : piTop > 0.9 ? "Approche du croisement" : "Éloigné du signal"),
      "SMA 111 jours vs 2× SMA 350 jours. Le croisement à la hausse a marqué chacun des 3 précédents sommets de cycle (2013, 2017, 2021).");

    var sma150 = _sma(closes, 150, idx), sma471 = _sma(closes, 471, idx);
    var piBot = (sma150 && sma471) ? sma150 / (sma471 * 0.745) : null;
    add("picyclebot", "Pi Cycle Bottom", 2, piBot != null ? piBot.toFixed(2) : "—", cl2(piBot, 0.8, 1.3),
      piBot == null ? "" : (piBot <= 1 ? "Croisement effectif — signal de creux historique" : "Éloigné du signal"),
      "SMA 150 jours vs 0,745× SMA 471 jours. Le croisement à la baisse a historiquement approché les creux de cycle.");

    var GENESIS = Date.UTC(2009, 0, 3);
    var daysSinceGenesis = Math.floor((Date.now() - GENESIS) / 864e5);
    var fitPrice = Math.pow(10, 5.84 * Math.log10(Math.max(1, daysSinceGenesis)) - 17.01);
    var ahr999 = (price && sma200 && fitPrice) ? (price / sma200) * (price / fitPrice) : null;
    add("ahr999", "AHR999", 2, ahr999 != null ? ahr999.toFixed(2) : "—", cl2(ahr999, 0.45, 4.5),
      ahr999 == null ? "" : (ahr999 < 0.45 ? "Zone d'accumulation historique" : ahr999 > 4.5 ? "Zone de surchauffe" : "Neutre"),
      "Combine l'écart au coût moyen 200 jours et à un modèle de croissance exponentielle. Sous 0,45 : accumulation ; au-dessus de 4,5 : surchauffe (seuils communément admis).");

    var weekly = _weeklyCloses(cl);
    var sma20w = _sma(weekly, 20, weekly.length - 1);
    var ema21w = _ema(weekly.slice(-Math.min(weekly.length, 200)), 21);
    var bmsbMid = (sma20w && ema21w) ? (sma20w + ema21w) / 2 : null;
    var bmsbRatio = (price && bmsbMid) ? price / bmsbMid : null;
    add("bmsb", "Bull Market Support Band", 2, bmsbRatio != null ? bmsbRatio.toFixed(2) : "—", cl2(bmsbRatio, 0.7, 1.6),
      bmsbRatio == null ? "" : (bmsbRatio < 1 ? "Prix sous la bande — test de support majeur" : "Prix au-dessus de la bande"),
      "Position du prix par rapport à la bande SMA 20 semaines / EMA 21 semaines — support historique des marchés haussiers.");

    var ema9 = _ema(closes.slice(-60), 9), ema18 = _ema(closes.slice(-60), 18);
    var ema918 = (ema9 && ema18) ? ema9 / ema18 : null;
    add("ema918", "Croisement EMA 9/18", 1, ema918 != null ? ema918.toFixed(3) : "—", cl2(ema918, 0.92, 1.08),
      ema918 == null ? "" : (ema918 > 1 ? "EMA9 > EMA18 — momentum haussier" : "EMA9 < EMA18 — momentum baissier"),
      "Moyennes mobiles exponentielles 9 et 18 jours. Un croisement à la hausse indique un regain de momentum court terme.");

    var rsiw = _rsi(weekly, 14);
    add("rsiw", "RSI hebdomadaire", 2, rsiw != null ? rsiw.toFixed(0) : "—", rsiw,
      rsiw == null ? "" : (rsiw > 70 ? "Surachat hebdomadaire" : rsiw < 30 ? "Survente hebdomadaire" : "Neutre"),
      "Force relative calculée sur clôtures hebdomadaires. Au-dessus de 70 : surachat ; en dessous de 30 : survente.");

    var sma365 = _sma(closes, 365, idx);
    var puell = (price && sma365) ? price / sma365 : null;
    add("puell", "Puell Multiple (proxy)", 2, puell != null ? puell.toFixed(2) : "—", cl2(puell, 0.5, 4),
      puell == null ? "" : (puell < 0.5 ? "Revenus des mineurs très bas — historiquement un creux" : puell > 4 ? "Revenus des mineurs extrêmes — historiquement un sommet" : "Neutre"),
      "Proxy prix / SMA 365 jours du prix (la production quotidienne de BTC étant quasi constante hors halving, ce ratio suit fidèlement le Puell Multiple officiel).");
  } catch (e) {}

  try {
    var hr = await fetch("https://api.blockchain.info/charts/hash-rate?timespan=200days&format=json&cors=true", { headers: { "User-Agent": _UA } });
    if (hr.ok) {
      var hd = await hr.json();
      var vals = ((hd && hd.values) || []).map(function (v) { return v.y; });
      if (vals.length >= 60) {
        var s30 = _sma(vals, 30, vals.length - 1), s60 = _sma(vals, 60, vals.length - 1);
        var s30prev = _sma(vals, 30, vals.length - 2), s60prev = _sma(vals, 60, vals.length - 2);
        var ratio = (s30 && s60) ? s30 / s60 : null;
        var justCrossedUp = (s30prev != null && s60prev != null && s30prev <= s60prev && s30 > s60);
        add("hashribbons", "Hash Ribbons", 2, ratio != null ? ratio.toFixed(3) : "—",
          ratio != null ? Math.max(0, Math.min(100, (1 - ratio) * 200)) : null,
          ratio == null ? "" : (ratio < 1 ? "Capitulation des mineurs en cours" : justCrossedUp ? "Sortie de capitulation — signal d'achat historique" : "Pas de capitulation"),
          "SMA 30j vs SMA 60j du hashrate réseau. La sortie de capitulation a historiquement précédé des reprises durables.");
      }
    }
  } catch (e) {}

  try {
    var fgR = await fetch("https://api.alternative.me/fng/?limit=1", { headers: { "Accept": "application/json" } });
    if (fgR.ok) {
      var fgD = await fgR.json();
      var fg = fgD && fgD.data && fgD.data[0];
      if (fg) {
        var v = parseInt(fg.value);
        add("feargreed", "Fear & Greed Index", 2, String(v), v, fg.value_classification || "",
          "Indice composite de sentiment (volatilité, momentum, réseaux sociaux, dominance, tendances de recherche). Publié par alternative.me.");
      }
    }
  } catch (e) {}

  try {
    var dom = await _getBtcDominance();
    if (dom != null) {
      var cl2b = function (v, lo, hi) { return v == null ? null : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };
      add("btcdom", "Dominance BTC", 2, dom.toFixed(1) + "%", cl2b(dom, 38, 65),
        dom > 58 ? "Dominance élevée — capital concentré sur BTC" : dom < 42 ? "Dominance basse — rotation vers les altcoins (\"alt season\")" : "Neutre",
        "Part de Bitcoin dans la capitalisation totale du marché crypto (CoinGecko). Une dominance en baisse marque historiquement des phases de \"alt season\".");
    }
  } catch (e) {}

  [
    ["mvrvz", "MVRV Z-Score", 3, "Écart entre valeur de marché et valeur réalisée, normalisé par l'écart-type. Sous 0 : sous-évalué historique ; au-dessus de 7 : sommet historique."],
    ["nupl", "NUPL", 2, "Net Unrealized Profit/Loss : part de la capitalisation en profit latent net. Phases : capitulation, espoir, optimisme, croyance, euphorie."],
    ["reserverisk", "Reserve Risk", 2, "Rapport entre le prix et la conviction des détenteurs de long terme. Bas : confiance forte à prix bas — zone d'achat historique."],
    ["rhodl", "RHODL Ratio", 1, "Compare la richesse détenue depuis 1 semaine à celle détenue depuis 1-2 ans, pondérée par l'âge. Pics historiques en fin de cycle haussier."],
    ["sthmvrv", "STH-MVRV", 2, "MVRV des détenteurs court terme (< 155 jours) — mesure si les acheteurs récents sont en moyenne en gain ou en perte."],
    ["asopr", "aSOPR", 2, "Adjusted Spent Output Profit Ratio : ratio moyen profit/perte des pièces dépensées (hors UTXO < 1h). Sous 1 : vente à perte dominante."],
    ["vdd", "VDD Multiple", 1, "Réactivation de pièces anciennes pondérée par leur valeur, lissée. Pics historiques en fin de cycle."],
  ].forEach(function (row) {
    indicators.push({ key: row[0], name: row[1], weight: row[2], value: "—", heat: null, zone: "", explain: row[3] });
  });

  var indicatorsActions = [], indicatorsMacro = [];
  try { indicatorsActions = await buildActionsSignals(); } catch (e) {}
  try { indicatorsMacro = await buildMacroSignals(); } catch (e) {}

  return { price: price, indicators: indicators, indicatorsActions: indicatorsActions, indicatorsMacro: indicatorsMacro, ts: Date.now() };
}

// ════════════════════════════════════════════════════════════════════════════
// #172 — BILANS : historique quotidien (température par catégorie + par actif
// suivi/détenu) et alerte Telegram quand une catégorie ou un actif change de
// zone (Acheter/Accumuler/Conserver/Alléger/Vendre). Réutilise EXACTEMENT le
// même calcul de heat pondéré que le client (buildCategoryBilan côté app.jsx)
// et la même formule de score technique générique que fetchGenericTechnical
// côté app.jsx — même seuils partout, un seul et même langage entre le Worker
// et l'app.
// NOTE : les 7 indicateurs on-chain avancés (mvrvz, nupl, reserverisk, rhodl,
// sthmvrv, asopr, vdd) restent "heat: null" ici car ils ne sont enrichis que
// côté client (bitcoin-data.com, cf. fetchOnchainBtc dans app.jsx) — le bilan
// crypto calculé par le Worker est donc légèrement moins complet (poids en
// moins) que celui affiché en direct dans l'app, sans être faux pour autant.
// ════════════════════════════════════════════════════════════════════════════
function _weightedHeatReco(items) {
  var sw = 0, swh = 0, n = 0;
  (items || []).forEach(function (o) {
    if (o && o.heat != null && isFinite(o.heat)) { var w = o.weight || 1; sw += w; swh += o.heat * w; n++; }
  });
  if (sw <= 0) return { heat: null, reco: null, n: n, total: (items || []).length };
  var heat = swh / sw;
  var reco = heat < 25 ? "Acheter" : heat < 40 ? "Accumuler" : heat < 60 ? "Conserver" : heat < 80 ? "Alléger" : "Vendre";
  return { heat: heat, reco: reco, n: n, total: (items || []).length };
}
async function _genericTechnicalHeat(sym) {
  try {
    var cl = await fetchYahooDailyCloses(sym, "1y");
    var ks = Object.keys(cl).sort();
    var closes = ks.map(function (k) { return cl[k]; });
    var n = closes.length;
    if (n < 30) return null;
    var last = closes[n - 1];
    var rsi = _rsi(closes, 14);
    var smaN = Math.min(200, n);
    var sma = closes.slice(n - smaN).reduce(function (a, b) { return a + b; }, 0) / smaN;
    var smaRatio = sma ? last / sma : null;
    var smaHeat = smaRatio == null ? null : Math.max(0, Math.min(100, (smaRatio - 0.75) / (1.35 - 0.75) * 100));
    var win = closes.slice(-Math.min(252, n));
    var hi = Math.max.apply(null, win), lo = Math.min.apply(null, win);
    var rangePos = hi > lo ? (last - lo) / (hi - lo) * 100 : null;
    var idxM = Math.max(0, n - 22), ref = closes[idxM];
    var mom = ref ? (last - ref) / ref * 100 : null;
    var momHeat = mom == null ? null : Math.max(0, Math.min(100, (mom + 20) / 40 * 100));
    var parts = [rsi, smaHeat, rangePos, momHeat].filter(function (v) { return v != null; });
    return parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : null;
  } catch (e) { return null; }
}
var _BILAN_CRY_HINT = { BTC: 1, ETH: 1, SOL: 1, XRP: 1, ADA: 1, DOGE: 1, BNB: 1, LTC: 1, DOT: 1, AVAX: 1, LINK: 1, MATIC: 1, TRX: 1, ATOM: 1, UNI: 1, ETC: 1, XLM: 1, NEAR: 1, APT: 1, ARB: 1, OP: 1, SUI: 1, SHIB: 1, PEPE: 1 };
async function _resolveYahooSymbol(ticker, cat) {
  var yfmap = {};
  try { var rawM = await GDB_KV.get("cgi_yfmap"); if (rawM) yfmap = JSON.parse(rawM) || {}; } catch (e) {}
  if (yfmap[ticker]) return yfmap[ticker];
  var isCrypto = cat === "Crypto" || (!cat && _BILAN_CRY_HINT[ticker]);
  return isCrypto ? ticker + "-USD" : ticker;
}
var _BILAN_CASHLIKE = { USD: 1, EURO: 1, KUCOIN: 1, CASH: 1, LCL: 1, BCI: 1, DEBLOCK: 1 };
async function buildBilanSnapshot() {
  var sig = await buildBtcSignals();
  var cryptoWR = _weightedHeatReco(sig.indicators);
  var actionsWR = _weightedHeatReco(sig.indicatorsActions);
  var macroWR = _weightedHeatReco(sig.indicatorsMacro);

  var detailed = await _userTrackedTickersDetailed();
  var candidates = detailed.filter(function (o) { return !_BILAN_CASHLIKE[o.ticker]; }).slice(0, 20);
  var assets = {};
  for (var i = 0; i < candidates.length; i++) {
    var o = candidates[i];
    try {
      var sym = await _resolveYahooSymbol(o.ticker, o.cat);
      var heat = await _genericTechnicalHeat(sym);
      if (heat != null) {
        var reco = heat < 25 ? "Acheter" : heat < 40 ? "Accumuler" : heat < 60 ? "Conserver" : heat < 80 ? "Alléger" : "Vendre";
        assets[o.ticker] = { heat: heat, reco: reco };
      }
    } catch (e) {}
  }

  var today = new Date().toISOString().slice(0, 10);
  var snap = {
    d: today,
    crypto: { heat: cryptoWR.heat, reco: cryptoWR.reco },
    actions: { heat: actionsWR.heat, reco: actionsWR.reco },
    macro: { heat: macroWR.heat, reco: macroWR.reco },
    assets: assets,
    ts: Date.now(),
  };

  try {
    var raw = await GDB_KV.get("cgi_bilan_history");
    var hist = []; try { hist = raw ? JSON.parse(raw) : []; } catch (e2) {}
    if (!Array.isArray(hist)) hist = [];
    var idx = hist.findIndex(function (h) { return h && h.d === today; });
    if (idx >= 0) hist[idx] = snap; else hist.push(snap);
    hist.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    if (hist.length > 400) hist = hist.slice(-400);
    await GDB_KV.put("cgi_bilan_history", JSON.stringify(hist));
  } catch (e) {}

  return snap;
}
async function checkBilanAlerts(snap) {
  var prev = null;
  try { var raw = await GDB_KV.get("cgi_bilan_state"); if (raw) prev = JSON.parse(raw); } catch (e) {}
  var lines = [];
  [["crypto", "Crypto"], ["actions", "Actions"], ["macro", "Santé globale du marché"]].forEach(function (c) {
    var key = c[0], label = c[1];
    var newReco = snap[key] && snap[key].reco;
    var oldReco = prev && prev[key] && prev[key].reco;
    if (newReco && oldReco && newReco !== oldReco) {
      lines.push("📊 <b>" + _digestEsc(label) + "</b> : " + _digestEsc(oldReco) + " → <b>" + _digestEsc(newReco) + "</b>");
    }
  });
  var prevAssets = (prev && prev.assets) || {};
  Object.keys(snap.assets || {}).forEach(function (tk) {
    var newReco = snap.assets[tk].reco;
    var oldReco = prevAssets[tk] && prevAssets[tk].reco;
    if (newReco && oldReco && newReco !== oldReco) {
      lines.push("🎯 <b>" + _digestEsc(tk) + "</b> : " + _digestEsc(oldReco) + " → <b>" + _digestEsc(newReco) + "</b>");
    }
  });
  if (lines.length) {
    try { await sendTelegram("🌡️ <b>Changement de zone</b>\n" + lines.join("\n")); } catch (e) {}
  }
  try {
    var toSave = { crypto: snap.crypto, actions: snap.actions, macro: snap.macro, assets: snap.assets, ts: snap.ts };
    await GDB_KV.put("cgi_bilan_state", JSON.stringify(toSave));
  } catch (e) {}
  return { changed: lines.length, lines: lines };
}

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // ── /version — diagnostic sans auth ────────────────────────────────────────
  if (path === "/version") {
    return json({ version: "v82-cgi", ok: true, note: "Ce worker utilise les clés cgi_* (version correcte)" });
  }

  // ── /ping — pas d'auth requise (diagnostic) ───────────────────────────────
  if (path === "/ping") {
    return json({
      ok: true,
      ts: Date.now(),
      hasKV: typeof GDB_KV !== "undefined",
      hasAuth: typeof AUTH_KEY !== "undefined",
      version: "v82-cgi",
      keys_format: "cgi_*",
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const clientKey = request.headers.get("X-Auth-Key") || url.searchParams.get("k");
  if (typeof AUTH_KEY === "undefined" || clientKey !== AUTH_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (typeof GDB_KV === "undefined") {
    return json({ error: "KV namespace not bound — check Cloudflare Worker settings" }, 500);
  }

  // ── #50 — GET /barometer.svg : image SVG du baromètre (prévisualisable au navigateur)
  if (path === "/barometer.svg") {
    if (url.searchParams.get("k") !== AUTH_KEY && request.headers.get("X-Auth-Key") !== AUTH_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      var bd = await buildBaroData();
      return new Response(barometerSVG(bd, url.searchParams.get("aud")), { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    } catch (e) { return new Response("err: " + e.message, { status: 500 }); }
  }
  // ── #50 — GET /barometer_send : envoie le baromètre en image sur Telegram (test)
  if (path === "/barometer_send") {    try { return json(await sendBarometer(url.searchParams.get("aud"))); }
    catch (e) { return json({ ok: false, error: e.message, stack: (e.stack||"").slice(0,400) }, 500); }
  }

  // ── #67 — GET /ibkr_sync : synchronise cgi_portfolio depuis IBKR (&purge=1 pour solder les vendus)
  if (path === "/ibkr_sync") {
    try { return json(await ibkrSyncPortfolio(url.searchParams.get("purge") === "1", url.searchParams.get("dry") === "1")); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── #54 — GET /kucoin_sync : récupère les fills KuCoin récents → cgi_kucoin_trades (dédup par tradeId)
  if (path === "/kucoin_sync") {
    try { return json(await kucoinSync()); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── #109 — GET /txns_remove?ids=a,b,c : SUPPRESSION RÉELLE de transactions par id.
  // Nécessaire car l'écriture normale de cgi_txns fusionne par id (garde-fou #67g) et
  // RÉ-AJOUTE tout id manquant depuis le KV → une suppression côté app ne se propage jamais.
  // Ici on écrit directement le tableau filtré (aucune fusion). Auth via le garde global (?k=).
  // ── #103/#120 — GET /digest_test : envoie le digest (alertes + news) immédiatement (test manuel)
  if (path === "/digest_test") {
    try { var dg = await sendHoldingsDigest(); return json(dg); } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  if (path === "/txns_remove") {
    try {
      var rmParam = url.searchParams.get("ids") || "";
      var rmIds = rmParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!rmIds.length) return json({ ok: false, error: "paramètre ids manquant (ids=id1,id2)" }, 400);
      var rmRaw = await GDB_KV.get("cgi_txns");
      var rmTx = []; try { rmTx = rmRaw ? (JSON.parse(rmRaw) || []) : []; } catch (e) {}
      var rmSet = {}; rmIds.forEach(function (i) { rmSet[String(i)] = 1; });
      var rmKept = rmTx.filter(function (t) { return !(t && t.id != null && rmSet[String(t.id)]); });
      var removed = rmTx.length - rmKept.length;
      var removedIds = rmTx.filter(function (t) { return t && t.id != null && rmSet[String(t.id)]; }).map(function (t) { return t.id; });
      if (removed > 0) await GDB_KV.put("cgi_txns", JSON.stringify(rmKept));
      // #138 — TOMBSTONES : tout id demandé à la suppression est mémorisé (même si déjà absent du KV)
      try {
        var tbRaw = await GDB_KV.get("cgi_txns_tombstones"); var tb = tbRaw ? (JSON.parse(tbRaw) || []) : [];
        rmIds.forEach(function (i) { if (tb.indexOf(String(i)) < 0) tb.push(String(i)); });
        await GDB_KV.put("cgi_txns_tombstones","cgi_bank_hist", JSON.stringify(tb.slice(-500)));
      } catch (e) {}
      return json({ ok: true, before: rmTx.length, after: rmKept.length, removed: removed, removedIds: removedIds, notFound: rmIds.filter(function (i) { return removedIds.map(String).indexOf(String(i)) < 0; }) });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── #67 — GET /txns_debug : état de cgi_txns (ajustements, net par ticker, vérité IBKR)
  if (path === "/txns_debug") {
    try {
      var tdRaw = await GDB_KV.get("cgi_txns");
      var tdTx = []; try { tdTx = tdRaw ? (JSON.parse(tdRaw) || []) : []; } catch (e) {}
      var tdNet = {}, tdAdj = [];
      tdTx.forEach(function (t) {
        if (!t || !t.ticker) return;
        var k = t.ticker.toUpperCase(), q = parseFloat(t.qty) || 0;
        tdNet[k] = Math.round(((tdNet[k] || 0) + (((t.side || "").toUpperCase() === "SELL") ? -q : q)) * 1e6) / 1e6;
        if (typeof t.id === "string" && t.id.indexOf("ibkradj_") === 0) tdAdj.push({ id: t.id, date: t.date, side: t.side, t: k, qty: t.qty, valueUSD: t.valueUSD != null ? t.valueUSD : null });
      });
      var tdTruth = null; try { var tdTR = await GDB_KV.get("cgi_ibkr_truth"); tdTruth = tdTR ? JSON.parse(tdTR) : null; } catch (e) {}
      return json({ total: tdTx.length, ajustements: tdAdj, netParTicker: tdNet,
        veriteIBKR: tdTruth ? { ageHeures: Math.round((Date.now() - tdTruth.ts) / 36e5), qty: tdTruth.qty, cashUSD: tdTruth.cashUSD } : null });
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── /baro_debug — diagnostic complet du pipeline baromètre (auth requise) ──
  // Révèle POURQUOI les données seraient périmées : snapshot vs live, prix Yahoo
  // par symbole, présence des positions en KV. Aucune écriture, aucun envoi Telegram.
  if (path === "/baro_debug") {
    var dbg = { now: new Date().toISOString(), workerVersion: "v82-cgi" };
    try {
      var snapRaw = await GDB_KV.get("cgi_fund_stats");
      var snapD = null; try { snapD = snapRaw ? JSON.parse(snapRaw) : null; } catch (e) {}
      dbg.snapshot = snapD ? { present: true, tsFunds: snapD.tsFunds || null,
        ageHeures: snapD.tsFunds ? Math.round((Date.now() - snapD.tsFunds) / 36e5) : null,
        ue: snapD.ue || null, cgic: snapD.cgic || null, cgis: snapD.cgis || null } : { present: false };
      var portRaw = await GDB_KV.get("cgi_portfolio");
      var portD = null; try { portD = portRaw ? JSON.parse(portRaw) : null; } catch (e) {}
      var itemsD = (portD && portD.items) || [];
      dbg.portfolio = { present: !!portD, items: itemsD.length, date: (portD && portD.date) || null };
      var yfmD = {}; try { var ymD = await GDB_KV.get("cgi_yfmap"); if (ymD) yfmD = JSON.parse(ymD) || {}; } catch (e) {}
      try { dbg.eurusd = await lastPrice("EURUSD=X"); } catch (e) { dbg.eurusd = "ERR " + e.message; }
      dbg.prices = [];
      var _fxD = {}; var _euD = dbg.eurusd && typeof dbg.eurusd === "number" ? dbg.eurusd : (1 / 0.92);
      var _sumD = { cryptoUSD: 0, stocksUSD: 0, cashUSD: 0, bankEUR: 0 };
      for (var di = 0; di < itemsD.length && di < 25; di++) {
        var itD = itemsD[di];
        if (itD.cat === "Cash Matelas") { _sumD.bankEUR += (itD.valEUR || 0); dbg.prices.push({ t: itD.t, cat: itD.cat, skip: "banque", valEUR: itD.valEUR || 0 }); continue; }
        if (itD.cat === "Cash" || ["USD", "EURO", "KUCOIN", "CASH"].indexOf((itD.t || "").toUpperCase()) >= 0) {
          var cvD = (itD.val != null ? itD.val : (itD.qty || 0)); _sumD.cashUSD += cvD;
          dbg.prices.push({ t: itD.t, cat: itD.cat, skip: "cash", valUSD: Math.round(cvD) }); continue;
        }
        var symD = yfmD[itD.t] || (itD.cat === "Crypto" ? itD.t + "-USD" : itD.t);
        var pcD = await lastPriceCur(symD);
        if (!pcD || pcD.px == null) {
          dbg.prices.push({ t: itD.t, cat: itD.cat, sym: symD, qty: itD.qty || 0, error: "prix indisponible", valStockee: itD.val || 0 });
          if (itD.cat === "Crypto") _sumD.cryptoUSD += (itD.val || 0); else _sumD.stocksUSD += (itD.val || 0);
          continue;
        }
        var pxD = pcD.px, curD = pcD.cur || (/\.(AS|PA|MI|DE|BR)$/i.test(symD) ? "EUR" : "USD");
        if (curD === "GBp") { pxD = pxD / 100; curD = "GBP"; }
        var vUSD = await _toUSD((itD.qty || 0) * pxD, curD, _euD, _fxD);
        if (itD.cat === "Crypto") _sumD.cryptoUSD += vUSD; else _sumD.stocksUSD += vUSD;
        dbg.prices.push({ t: itD.t, cat: itD.cat, sym: symD, qty: itD.qty || 0, px: pcD.px, devise: pcD.cur || "(méta absente)", valUSD: Math.round(vUSD) });
      }
      dbg.totauxCalcules = { cryptoUSD: Math.round(_sumD.cryptoUSD), stocksUSD: Math.round(_sumD.stocksUSD),
        cashUSD: Math.round(_sumD.cashUSD), bankEUR: Math.round(_sumD.bankEUR), gbpusd: _fxD.gbpusd || null };
      var bdD = await buildBaroData();
      dbg.result = { src: bdD.src, live: bdD.live, fallback: bdD.fallback,
        totalUSD: bdD.totalUSD, cryptoUSD: bdD.cryptoUSD, stocksUSD: bdD.stocksUSD, cashUSD: bdD.cashUSD, bankEUR: bdD.bankEUR,
        usdEur: bdD.usdEur, ueApp: bdD.ueApp, cgicNavUSD: bdD.cgicNavUSD, cgisNavUSD: bdD.cgisNavUSD,
        cgicNav: bdD.cgicNav, cgicPnl: bdD.cgicPnl, cgisNav: bdD.cgisNav, cgisPnl: bdD.cgisPnl,
        p24: bdD.p24, p7: bdD.p7, M: bdD.M, sante: bdD.health && bdD.health.label };
    } catch (e) { dbg.error = e.message; dbg.stack = (e.stack || "").slice(0, 400); }
    return json(dbg);
  }

  if (path === "/build_bench") {
    var rangeQ = url.searchParams.get("range") || "5y";
    try { return json(await buildAndStoreBench(rangeQ)); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── #2 — GET /notify_test : envoie un message Telegram de test ──────────────
  if (path === "/notify_test") {
    try {
      var msgT = await buildPortfolioSummary();
      var resT = await sendTelegram("✅ Test notification\n\n" + msgT);
      return json(resT);
    } catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  // ── #2 — GET /notify_now : déclenche le résumé quotidien manuellement ───────
  if (path === "/notify_now") {
    await handleScheduled(null);
    return json({ ok: true, note: "Résumé + benchmarks déclenchés" });
  }

  // ── #172 — GET /bilan_check : force un snapshot + vérif d'alerte immédiate (test manuel) ──
  if (path === "/bilan_check") {
    try { var _bs2 = await buildBilanSnapshot(); var _r2 = await checkBilanAlerts(_bs2); return json({ ok: true, snap: _bs2, alerts: _r2 }); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
  }
  // ── #172 — GET /bilan-history : historique quotidien des bilans (pour les mini-courbes) ──
  if (path === "/bilan-history" && request.method === "GET") {
    try {
      var _rawH = await GDB_KV.get("cgi_bilan_history");
      var _histOut = _rawH ? JSON.parse(_rawH) : [];
      return json({ history: Array.isArray(_histOut) ? _histOut : [], ts: Date.now() });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // ── GET /read ─────────────────────────────────────────────────────────────
  if (path === "/read" && request.method === "GET") {
    const KEYS = [
      "cgi_data","cgi_txns","cgi_dd","cgi_snapshots","cgi_gdbs","cgi_gc","cgi_gsb",
      "cgi_cm","cgi_sm","cgi_tm",
      "cgi_portfolio","cgi_crypto","cgi_stocks","cgi_bank",
      "cgi_yfmap","cgi_icons","cgi_bench",
      "cgi_watchlist","cgi_inv","cgi_futures","cgi_ibkr_annex","cgi_fund_stats",
      "cgi_devices","cgi_ibkr_trades","cgi_ibkr_truth","cgi_pin","cgi_draws","cgi_alloc_targets","cgi_alloc_templates","cgi_kucoin_trades","cgi_cex_trades","cgi_manual_closed","cgi_pending_alerts","cgi_bank_moves","cgi_txns_tombstones","cgi_bank_hist",
    ];
    const result = { _ok: true };
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      try {
        var raw = await GDB_KV.get(k);
        result[k] = raw ? JSON.parse(raw) : null;
      } catch (e) {
        result[k] = null;
        result["_err_"+k] = e.message;
      }
    }
    return json(result);
  }

  // ── POST /write ───────────────────────────────────────────────────────────
  if (path === "/write" && request.method === "POST") {
    try {
      var body = await request.text();
      JSON.parse(body); // validate JSON
      await GDB_KV.put("cgi_data", body);
      return json({ ok: true, key: "cgi_data" });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── POST /write-bases ─────────────────────────────────────────────────────
  if (path === "/write-bases" && request.method === "POST") {
    try {
      var body2 = await request.text();
      var bases = JSON.parse(body2);
      var ALLOWED = [
        "cgi_txns","cgi_dd","cgi_snapshots","cgi_gdbs","cgi_gc","cgi_gsb",
        "cgi_cm","cgi_sm","cgi_tm",
        "cgi_portfolio","cgi_crypto","cgi_stocks","cgi_bank",
        "cgi_yfmap","cgi_icons","cgi_bench",
        "cgi_watchlist","cgi_inv","cgi_futures","cgi_ibkr_annex","cgi_fund_stats",
        "cgi_devices","cgi_pin","cgi_draws","cgi_alloc_targets","cgi_alloc_templates","cgi_cex_trades","cgi_manual_closed","cgi_pending_alerts","cgi_bank_moves","cgi_txns_tombstones",
      ];
      var written = [];
      var errors2 = [];
      // Écriture parallèle pour réduire le temps total
      await Promise.all(ALLOWED.map(async function(key) {
        if (bases[key] !== undefined && bases[key] !== null) {
          try {
            var payload = bases[key];
            // #67g — cgi_txns : FUSION par id côté serveur, jamais de remplacement sec.
            // Un appareil dont les txns locales sont périmées ne peut plus effacer les
            // ajustements IBKR (ibkradj_*) ni les saisies d'un autre appareil : à id égal
            // la version entrante gagne, les ids présents uniquement en KV sont conservés,
            // et les exécutions brutes "ibkr_*" sont filtrées des deux côtés.
            // #67i — superposition de la vérité IBKR (< 48 h) sur les écritures de positions :
            // quantités des tickers actions + valeur du poste USD (Cash Dip). Le reste du
            // payload (crypto, banque, catégories, prix live) reste piloté par l'app.
            if ((key === "cgi_portfolio" || key === "cgi_stocks") && payload && Array.isArray(payload.items)) {
              try {
                var trRaw = await GDB_KV.get("cgi_ibkr_truth");
                var tr = null; try { tr = trRaw ? JSON.parse(trRaw) : null; } catch (e5) {}
                if (tr && tr.ts && (Date.now() - tr.ts) < 48 * 36e5) {
                  var corriges = 0;
                  payload.items.forEach(function (it) {
                    var t = (it.t || "").toUpperCase();
                    if (t === "USD" && tr.cashUSD != null) {
                      if ((it.val || 0) !== tr.cashUSD) { it.val = tr.cashUSD; if (it.qty != null) it.qty = tr.cashUSD; corriges++; }
                    } else if (tr.qty && tr.qty[t] != null && (it.cat === "Picking" || it.cat === "Indices" || (it.cat || "") === "")) {
                      if ((it.qty || 0) !== tr.qty[t]) { it.qty = tr.qty[t]; corriges++; }
                    }
                  });
                  if (corriges > 0) written.push(key + ":" + corriges + " champ(s) réalignés sur IBKR");
                }
              } catch (e6) {}
            }
            // #62 — cgi_pin : garder la version au savedAt le plus récent (multi-appareils)
            if (key === "cgi_pin" && payload && typeof payload === "object") {
              try {
                var pRaw = await GDB_KV.get("cgi_pin");
                var pEx = pRaw ? JSON.parse(pRaw) : null;
                var pin = payload.savedAt || 0, pex = (pEx && pEx.savedAt) || 0;
                if (pEx && pex > pin) { written.push("cgi_pin:conservé (plus récent)"); return; }
              } catch (eP) {}
            }
            // #90 — cgi_bank : garde-fou par HORODATAGE. On conserve l'existant si son savedAt est
            // strictement plus récent que l'entrant. C'est SÛR car : (a) les ÉDITIONS passent par
            // __cgiSetMatelas qui LIT d'abord le savedAt du cloud et écrit AU-DESSUS → elles gagnent
            // toujours, indépendamment de l'horloge ; (b) les écritures NON-éditrices (snapshot, rebuild,
            // observateur) PRÉSERVENT le savedAt existant → elles ne peuvent JAMAIS écraser une édition
            // plus récente. (Le garde-fou « par contenu » précédent laissait au contraire une ancienne
            // valeur d'un autre appareil écraser l'édition fraîche — bug corrigé ici.)
            if (key === "cgi_bank" && payload && typeof payload === "object") {
              try {
                var bRaw = await GDB_KV.get("cgi_bank");
                var bEx = bRaw ? JSON.parse(bRaw) : null;
                var inTs = payload.savedAt || 0, exTs = (bEx && bEx.savedAt) || 0;
                if (bEx && exTs > inTs) { written.push("cgi_bank:conservé (savedAt KV plus récent)"); return; }
              } catch (eB) {}
            }
            if (key === "cgi_txns" && Array.isArray(payload)) {
              try {
                var exRaw = await GDB_KV.get("cgi_txns");
                var ex = []; try { ex = exRaw ? (JSON.parse(exRaw) || []) : []; } catch (e3) {}
                var isRaw = function (t) { return t && typeof t.id === "string" && t.id.indexOf("ibkr_") === 0; };
                var seenIds = {}, mergedTx = [];
                payload.forEach(function (t) { if (t && t.id != null && !isRaw(t) && !seenIds[t.id]) { seenIds[t.id] = 1; mergedTx.push(t); } });
                var conserves = 0;
                ex.forEach(function (t) { if (t && t.id != null && !isRaw(t) && !seenIds[t.id]) { seenIds[t.id] = 1; mergedTx.push(t); conserves++; } });
                // #138 — TOMBSTONES : un id supprimé via /txns_remove ne revient JAMAIS, même poussé
                // par un appareil au cache périmé ou re-généré depuis le miroir legacy (cgi_data).
                try {
                  var tbRaw2 = await GDB_KV.get("cgi_txns_tombstones"); var tb2 = tbRaw2 ? (JSON.parse(tbRaw2) || []) : [];
                  if (tb2.length) { var tbSet = {}; tb2.forEach(function (i) { tbSet[String(i)] = 1; }); var avant = mergedTx.length; mergedTx = mergedTx.filter(function (t) { return !(t && t.id != null && tbSet[String(t.id)]); }); if (mergedTx.length < avant) written.push("cgi_txns:-" + (avant - mergedTx.length) + " tombstonée(s)"); }
                } catch (e6) {}
                mergedTx.sort(function (a, b) { return (a.date || "") < (b.date || "") ? -1 : 1; });
                payload = mergedTx;
                if (conserves > 0) written.push("cgi_txns:+" + conserves + " conservée(s) du cloud");
              } catch (e4) {}
            }
            await GDB_KV.put(key, JSON.stringify(payload));
            written.push(key);
          } catch (e2) {
            errors2.push(key + ": " + e2.message);
          }
        }
      }));
      return json({ ok: errors2.length === 0, written: written, errors: errors2 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /search?q= — Yahoo Finance autocomplete ────────────────────────
  if (path === "/search" && request.method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q) return json({ error: "Missing q param" }, 400);
    const SH = {
      "User-Agent":   "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept":       "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer":      "https://finance.yahoo.com/",
      "Origin":       "https://finance.yahoo.com",
    };
    try {
      var sUrl = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(q)
        + "&lang=en&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query";
      var sr = await fetch(sUrl, { headers: SH });
      if (!sr.ok) {
        sUrl = sUrl.replace("query1", "query2");
        sr = await fetch(sUrl, { headers: SH });
      }
      if (!sr.ok) return json({ error: "Yahoo search HTTP " + sr.status, quotes: [] }, 502);
      const sData = await sr.json();
      // Structure Yahoo : { quotes: [...] } à la racine (pas finance.result[0].quotes)
      const raw = sData.quotes || sData?.finance?.result?.[0]?.quotes || [];
      const quotes = raw
        .filter(x => x.symbol && ["EQUITY","ETF","CRYPTOCURRENCY","MUTUALFUND","INDEX"].includes(x.quoteType))
        .slice(0, 5)
        .map(x => ({
          symbol:    x.symbol,
          shortname: x.shortname || x.longname || x.symbol,
          exchange:  x.exchange || x.fullExchangeName || "",
          quoteType: x.quoteType,
        }));
      return json({ quotes, _raw_count: raw.length });
    } catch(e) {
      return json({ error: e.message, quotes: [] }, 500);
    }
  }

  // ── POST /screener_scan — Recherche par conditions (scan IA du marché mondial) ──
  // Body: { conditions: string[] } (jusqu'à 10 conditions libres, texte).
  // Appelle Gemini (Google) côté serveur pour proposer, à partir de ses
  // connaissances, des tickers RÉELS (actions + crypto, marchés mondiaux)
  // correspondant aux conditions. Pas d'outil de recherche web ici (le grounding
  // google_search a un quota gratuit trop restreint) — la clé API n'est JAMAIS
  // exposée au client. La vérification chiffrée des critères mesurables (% ATH,
  // ancienneté, tendance) est refaite côté app avec de vraies données Yahoo
  // Finance, qui rattrape aussi les tickers proposés par erreur/radiés — cet
  // endpoint ne renvoie qu'une liste de candidats.
  if (path === "/screener_scan" && request.method === "POST") {
    try {
      var _sKey = (typeof GEMINI_API_KEY !== "undefined") ? GEMINI_API_KEY : null;
      if (!_sKey) return json({ ok: false, error: "GEMINI_API_KEY non configurée sur le Worker" }, 500);
      var sBody = {};
      try { sBody = JSON.parse(await request.text()); } catch (eB) {}
      var sConds = Array.isArray(sBody.conditions)
        ? sBody.conditions.map(function (c) { return String(c || "").trim(); }).filter(Boolean).slice(0, 10)
        : [];
      if (!sConds.length) return json({ ok: false, error: "Aucune condition fournie" }, 400);

      var condLines = sConds.map(function (c, i) { return (i + 1) + ". " + c; }).join("\n");
      var sPrompt = "Tu es un analyste financier qui aide à découvrir des tickers (actions ET cryptomonnaies, marchés mondiaux — pas seulement américains) correspondant À TOUTES les conditions suivantes :\n\n"
        + condLines + "\n\n"
        + "Base-toi sur tes connaissances pour proposer des tickers RÉELS, actuellement cotés/tradables, correspondant raisonnablement à l'ensemble des conditions (pas de recherche web disponible ici). Pour les conditions chiffrées (prix vs ATH, ancienneté de l'historique, tendance...), une estimation raisonnable suffit : elles seront revérifiées ensuite avec de vraies données de marché à jour — ne propose donc que des tickers dont tu es raisonnablement sûr qu'ils existent encore.\n"
        + "Propose entre 5 et 12 tickers, aussi divers que possible (pas uniquement des méga-capitalisations déjà évidentes), en évitant les doublons d'un même groupe.\n\n"
        + "Réponds UNIQUEMENT avec un bloc JSON strict (rien avant, rien après), un tableau d'objets avec exactement ces champs :\n"
        + "[{\"ticker\":\"NVDA\",\"yahooSymbol\":\"NVDA\",\"market\":\"stock\",\"name\":\"NVIDIA Corporation\",\"exchange\":\"NASDAQ\",\"country\":\"US\",\"sector\":\"Intelligence artificielle / semi-conducteurs\",\"note\":\"1 phrase expliquant pourquoi ce ticker correspond aux conditions\"}]\n"
        + "Pour une cryptomonnaie : \"market\":\"crypto\" et \"yahooSymbol\" au format \"BTC-USD\".";

      var _geminiModel = "gemini-3.6-flash";
      var aResp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + _geminiModel + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": _sKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: sPrompt }] }],
        }),
        signal: AbortSignal.timeout(55000),
      });
      var aData = await aResp.json();
      if (!aResp.ok) {
        var aErr = (aData && aData.error && aData.error.message) || JSON.stringify(aData).slice(0, 300);
        return json({ ok: false, error: "Gemini API " + aResp.status + " : " + aErr }, 502);
      }

      var textOut = "";
      var _cand0 = aData.candidates && aData.candidates[0];
      var _parts = (_cand0 && _cand0.content && _cand0.content.parts) || [];
      _parts.forEach(function (part) { if (part && typeof part.text === "string") textOut += part.text; });
      var sClean = textOut.replace(/```json/gi, "").replace(/```/g, "").trim();
      var sMatch = sClean.match(/\[[\s\S]*\]/);
      var candidates = [];
      if (sMatch) { try { candidates = JSON.parse(sMatch[0]); } catch (eJ) {} }
      if (!Array.isArray(candidates)) candidates = [];
      candidates = candidates.filter(function (c) { return c && c.ticker; }).slice(0, 12).map(function (c) {
        return {
          ticker: String(c.ticker).toUpperCase().trim(),
          yahooSymbol: c.yahooSymbol ? String(c.yahooSymbol).trim() : null,
          market: (String(c.market || "stock").toLowerCase() === "crypto") ? "crypto" : "stock",
          name: c.name ? String(c.name).trim() : null,
          exchange: c.exchange ? String(c.exchange).trim() : null,
          country: c.country ? String(c.country).trim() : null,
          sector: c.sector ? String(c.sector).trim() : null,
          note: c.note ? String(c.note).trim() : null,
        };
      });
      return json({ ok: true, candidates: candidates });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // ── GET /yahoo?symbol= ────────────────────────────────────────────────────
  if (path === "/yahoo" && request.method === "GET") {
    var symbol = url.searchParams.get("symbol");
    if (!symbol) return json({ error: "symbol required" }, 400);
    try {
      var yahooUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=5d";
      var res = await fetch(yahooUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        yahooUrl = yahooUrl.replace("query1", "query2");
        res = await fetch(yahooUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      }
      var data = await res.json();
      var result2 = data && data.chart && data.chart.result && data.chart.result[0];
      if (!result2) return json({ symbol: symbol, price: null });
      var meta = result2.meta || {};
      var live2 = meta.regularMarketPrice;
      var quotes = result2.indicators && result2.indicators.quote && result2.indicators.quote[0];
      var closes = quotes && quotes.close ? quotes.close.filter(function(v){ return v != null; }) : [];
      var price = (live2 && live2 > 0) ? live2 : (closes.length ? closes[closes.length-1] : null);
      var prevClose = meta.chartPreviousClose || meta.previousClose || (closes.length>1 ? closes[closes.length-2] : null);
      var pct1d = (price!=null && prevClose) ? (price-prevClose)/prevClose : null;
      return json({ symbol: symbol, price: price, prevClose: prevClose, pct1d: pct1d });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /yahoo-chart?symbol=AAPL&interval=1d&range=1mo ───────────────────
  // Retourne OHLC + meta (name, marketCap, currency, prevClose, price, news)
  if (path === "/yahoo-chart" && request.method === "GET") {
    var sym    = url.searchParams.get("symbol");
    var interv = url.searchParams.get("interval") || "1d";
    var range  = url.searchParams.get("range")    || "1mo";
    var noLogo = url.searchParams.get("no_logo")  === "1"; // skip FMP si logo déjà en base côté client
    if (!sym) return json({ error: "symbol required" }, 400);

    // Headers simulant un vrai browser — essentiels pour Yahoo
    var YH = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://finance.yahoo.com",
      "Referer": "https://finance.yahoo.com/",
    };

    try {
      // ── 1. CHART (OHLC + prix live) ────────────────────────────────────────
      var chartUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym)
        + "?interval=" + interv + "&range=" + range + "&includePrePost=false";
      var cr = await fetch(chartUrl, { headers: YH });
      if (!cr.ok) {
        chartUrl = chartUrl.replace("query1", "query2");
        cr = await fetch(chartUrl, { headers: YH });
      }
      var cd = await cr.json();
      var res = cd && cd.chart && cd.chart.result && cd.chart.result[0];
      if (!res) return json({ error: "no chart data", symbol: sym }, 404);

      var meta   = res.meta || {};
      var quotes = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      var ts     = res.timestamp || [];
      var candles = [];
      for (var i = 0; i < ts.length; i++) {
        if (quotes.close && quotes.close[i] != null) {
          candles.push({ t: ts[i]*1000, o: quotes.open&&quotes.open[i], h: quotes.high&&quotes.high[i], l: quotes.low&&quotes.low[i], c: quotes.close[i], v: quotes.volume&&quotes.volume[i] });
        }
      }

      // ── 2. Données enrichies — Yahoo prioritaire, FMP désactivé (mode debug Yahoo) ──
      var quoteResult = null;
      var longName = null, marketCap = null, sector = null, industry = null, quoteType = "", exchFull2 = null;
      var marketHours = null, logoUrl = null, marketState = null, exchangeTz = null;
      var volAvg = null, lastDiv = null, lastDivDate = null;
      var change1d = null, changePct1d = null;
      var topHoldings = null, etfCategory = null;
      // FMP — uniquement pour le logo (250 calls/jour) — sauté si no_logo=1
      var fmpError = null, fmpStatus = null;
      if(!noLogo){
        try {
          // Clé FMP lue UNIQUEMENT depuis la variable secrète (aucune clé en dur).
          var _fmpKey = (typeof FMP_API_KEY !== "undefined") ? FMP_API_KEY : null;
          if (_fmpKey) {
            var _fmpUrl = "https://financialmodelingprep.com/stable/profile?symbol=" + encodeURIComponent(sym) + "&apikey=" + _fmpKey;
            var _fmpR = await fetch(_fmpUrl);
            fmpStatus = _fmpR.status;
            if (_fmpR.ok) {
              var _fmpD = await _fmpR.json();
              var _fmpP = Array.isArray(_fmpD) ? _fmpD[0] : null;
              if (_fmpP) logoUrl = _fmpP.image || _fmpP.logo || null;
            }
          } else {
            fmpError = "FMP_API_KEY non définie (env)";
          }
        } catch(efmp) { fmpError = efmp.message; }
      }
      var yahooDebug = {};

      // ── A. Yahoo quoteSummary — source principale pour tous les fundamentals ──
      // Modules utilisés :
      //   summaryDetail  → marketCap, averageVolume, dividendRate, exDividendDate
      //   assetProfile   → sector, industry (stocks)
      //   quoteType      → quoteType, longName, symbol
      // Note: logo, CIK, ISIN → non disponibles dans Yahoo (FMP uniquement)
      try {
        // Étape 1: cookie via fc.yahoo.com
        yahooDebug.step = "cookie";
        var yCookieVal = "";
        var yFcResp = await fetch("https://fc.yahoo.com", {
          headers: { "User-Agent": YH["User-Agent"] }, redirect: "follow",
        }).catch(function(){ return null; });
        if (yFcResp) {
          var yFcCookie = yFcResp.headers.get("set-cookie") || "";
          if (yFcCookie) yCookieVal = yFcCookie.split(";")[0];
          yahooDebug.fcStatus = yFcResp.status;
        }

        // Étape 2 : crumb
        yahooDebug.step = "crumb";
        var yCrumb = null;
        for (var _ci = 0; _ci < 2 && !yCrumb; _ci++) {
          var _cHost = _ci === 0 ? "query1" : "query2";
          var _cResp = await fetch("https://" + _cHost + ".finance.yahoo.com/v1/test/getcrumb", {
            headers: Object.assign({}, YH, yCookieVal ? { "Cookie": yCookieVal } : {}),
          }).catch(function(){ return null; });
          if (_cResp && _cResp.ok) {
            var _ct = (await _cResp.text()).trim();
            if (_ct && _ct.length > 2 && !_ct.includes("{")) {
              yCrumb = _ct;
              var _cc = _cResp.headers.get("set-cookie");
              if (_cc) yCookieVal = _cc.split(";")[0];
            }
          }
          yahooDebug["crumbStatus" + _ci] = _cResp ? _cResp.status : 0;
        }
        yahooDebug.crumb = yCrumb ? yCrumb.slice(0,6) + "..." : "null";

        // Étape 3 : quoteSummary avec tous les modules utiles
        yahooDebug.step = "quoteSummary";
        var _qsModules = "summaryDetail,assetProfile,summaryProfile,quoteType,price,defaultKeyStatistics,topHoldings,fundProfile";
        var _qsUrl = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
          + encodeURIComponent(sym)
          + "?modules=" + encodeURIComponent(_qsModules)
          + "&formatted=false"
          + (yCrumb ? "&crumb=" + encodeURIComponent(yCrumb) : "");
        var _qsHeaders = Object.assign({}, YH, yCookieVal ? { "Cookie": yCookieVal } : {});
        var _qsResp = await fetch(_qsUrl, { headers: _qsHeaders });
        if (!_qsResp.ok) _qsResp = await fetch(_qsUrl.replace("query1","query2"), { headers: _qsHeaders });
        yahooDebug.qsStatus = _qsResp.status;

        if (_qsResp.ok) {
          var _qsRaw = await _qsResp.text();
          yahooDebug.qsLen = _qsRaw.length;
          var _qsData = JSON.parse(_qsRaw);
          var _qsErr  = _qsData && _qsData.quoteSummary && _qsData.quoteSummary.error;
          if (_qsErr) yahooDebug.qsErr = JSON.stringify(_qsErr).slice(0,100);
          var _qsRes  = _qsData && _qsData.quoteSummary && _qsData.quoteSummary.result && _qsData.quoteSummary.result[0];
          yahooDebug.hasResult = !!_qsRes;

          if (_qsRes) {
            var _sd  = _qsRes.summaryDetail        || {};
            var _ap  = _qsRes.assetProfile          || {};  // sector/industry pour stocks
            var _sp  = _qsRes.summaryProfile        || {};  // sector/industry fallback
            var _qt  = _qsRes.quoteType             || {};
            var _th  = _qsRes.topHoldings           || {};
            var _fp2 = _qsRes.fundProfile           || {};
            var _pr  = _qsRes.price                 || {};
            var _dks = _qsRes.defaultKeyStatistics  || {};  // marketState, regularMarketChange

            // Helper : Yahoo retourne parfois {raw, fmt} même avec formatted=false
            var _raw = function(v) {
              if (v == null) return null;
              if (typeof v === "object" && v.raw != null) return v.raw;
              return v;
            };

            // Identité
            longName  = _qt.longName || _qt.shortName || null;
            quoteType = _qt.quoteType || "";
            exchFull2 = _qt.exchange  || null;

            // État du marché depuis price module (REGULAR/PRE/POST/CLOSED)
            marketState = _pr.marketState || null;
            exchangeTz  = _pr.exchangeTimezoneName || _qt.timeZoneFullName || null;
            yahooDebug.marketState = marketState || "null";
            yahooDebug.longName  = longName;
            yahooDebug.quoteType = quoteType;

            // Log les clés disponibles pour diagnostic

            // Fondamentaux financiers — extraire .raw si nécessaire
            // marketCap : summaryDetail pour stocks, price module pour ETF
            // ETF : totalAssets (AUM) = équivalent market cap dans defaultKeyStatistics
            marketCap = _raw(_sd.marketCap) || _raw(_pr.marketCap) || _raw(_dks.totalAssets) || null;
            // volume : summaryDetail.averageVolume ou averageVolume10days
            volAvg    = _raw(_sd.averageVolume) || _raw(_sd.averageVolume10days)
                     || _raw(_pr.averageDailyVolume3Month) || _raw(_pr.averageDailyVolume10Day) || null;
            yahooDebug.marketCap = marketCap ? "ok:" + Math.round(marketCap/1e9) + "B" : "null";
            yahooDebug.volAvg    = volAvg ? "ok" : "null";
            // Log sdKeys + prKeys pour diagnostiquer les champs disponibles
            yahooDebug.sdKeys = Object.keys(_sd).slice(0,15).join(",");
            yahooDebug.prKeys = Object.keys(_pr).slice(0,15).join(",");

            // Dividende : summaryDetail ou price (ETF)
            var _divRate = _raw(_sd.dividendRate) || _raw(_sd.trailingAnnualDividendRate)
                        || _raw(_pr.trailingAnnualDividendRate) || null;
            var _divDate = _raw(_sd.exDividendDate) || _raw(_pr.exDividendDate) || null;
            if (_divDate && typeof _divDate === "number") _divDate = new Date(_divDate * 1000).toISOString().slice(0,10);
            lastDiv = _divRate; lastDivDate = _divDate;
            yahooDebug.divRate = _divRate != null ? String(_divRate) : "null";
            yahooDebug.divDate = _divDate || "null";

            // Variation du jour — depuis summaryDetail ou price (déjà déclaré plus haut)
            var _change    = _raw(_pr.regularMarketChange)        || _raw(_sd.regularMarketChange)    || null;
            var _changePct = _raw(_pr.regularMarketChangePercent) || _raw(_sd.regularMarketChangePercent) || null;
            if (_changePct && Math.abs(_changePct) < 1) _changePct = _changePct * 100; // Yahoo retourne 0.09 pour 9%
            yahooDebug.change = _change != null ? "ok" : "null";

            // Secteur/Industrie : assetProfile/summaryProfile (stocks) ou fundProfile (ETF)
            sector   = _ap.sector   || _sp.sector   || _fp2.categoryName || null;
            industry = _ap.industry || _sp.industry || _fp2.fundFamily   || null;
            yahooDebug.sector   = sector   || "null";
            yahooDebug.industry = industry || "null";

            // ETF : categoryName + holdings
            etfCategory = _fp2.categoryName || _fp2.fundFamily || null;
            yahooDebug.etfCategory = etfCategory || "null";
            if (_th.holdings && _th.holdings.length > 0) {
              topHoldings = _th.holdings.slice(0, 10).map(function(h) {
                return {
                  symbol: h.symbol || "",
                  name:   h.holdingName || h.symbol || "",
                  pct:    h.holdingPercent != null ? Math.round(h.holdingPercent * 1000) / 10 : null,
                };
              });
              yahooDebug.holdingsCount = topHoldings.length;
            } else {
              yahooDebug.holdingsCount = 0;
            }
          }
        } else {
          yahooDebug.step = "qs_http_fail";
          yahooDebug.body = await _qsResp.text().then(function(t){ return t.slice(0,150); }).catch(function(){ return ""; });
        }
      } catch(eyh) {
        yahooDebug.step = "exception";
        yahooDebug.error = eyh.message || String(eyh);
      }

      // ── B. Yahoo /v7/quote — fallback si quoteSummary a raté le longName/quoteType ──
      try {
        if (!longName || !quoteType || !marketState) {
          var _v7url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(sym)
            + "&fields=longName,shortName,quoteType,fullExchangeName,marketState,exchangeTimezoneName,exchangeTimezoneShortName";
          var _v7r = await fetch(_v7url, { headers: YH });
          if (!_v7r.ok) _v7r = await fetch(_v7url.replace("query1","query2"), { headers: YH });
          if (_v7r.ok) {
            var _v7d = await _v7r.json();
            var _v7i = _v7d && _v7d.quoteResponse && _v7d.quoteResponse.result && _v7d.quoteResponse.result[0];
            if (_v7i) {
              if (!longName)    longName    = _v7i.longName || _v7i.shortName;
              if (!quoteType)   quoteType   = _v7i.quoteType || "";
              if (!exchFull2)   exchFull2   = _v7i.fullExchangeName;
              if (!marketState) marketState = _v7i.marketState || null;
              if (!exchangeTz)  exchangeTz  = _v7i.exchangeTimezoneName || null;
            }
          }
          yahooDebug.v7 = "used";
        }
      } catch(ev7) { yahooDebug.v7err = ev7.message; }

      quoteResult = { longName, marketCap, sector, industry, quoteType, fullExchangeName: exchFull2 };

      // ── 3. NEWS via /v1/finance/search ────────────────────────────────────
      var newsItems = [];
      try {
        var nUrl = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(sym)
          + "&newsCount=8&quotesCount=0&enableFuzzyQuery=false&lang=en-US";
        var nr = await fetch(nUrl, { headers: YH });
        if (!nr.ok) { nUrl = nUrl.replace("query1","query2"); nr = await fetch(nUrl, { headers: YH }); }
        if (nr.ok) {
          var nd = await nr.json();
          var rawNews = nd && nd.news || [];
          newsItems = rawNews.slice(0,8).map(function(n){ return {
            title:     n.title || "",
            publisher: n.publisher || "",
            url:       n.link || "",
            time:      n.providerPublishTime ? n.providerPublishTime * 1000 : null,
            thumbnail: n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url || null,
          };});
        }
      } catch(e4) {}

      // ── 4. Exchange → pays ────────────────────────────────────────────────
      var EXCHANGE_MAP = {
        "NYQ":{cc:"US",city:"New York (NYSE)"},"NMS":{cc:"US",city:"New York (NASDAQ)"},
        "NGM":{cc:"US",city:"New York (NASDAQ)"},"PCX":{cc:"US",city:"NYSE Arca"},
        "LSE":{cc:"GB",city:"Londres (LSE)"},"PAR":{cc:"FR",city:"Paris (Euronext)"},
        "MIL":{cc:"IT",city:"Milan (Euronext)"},"FRA":{cc:"DE",city:"Francfort (XETRA)"},
        "GER":{cc:"DE",city:"Francfort (XETRA)"},"AMS":{cc:"NL",city:"Amsterdam (Euronext)"},
        "BRU":{cc:"BE",city:"Bruxelles (Euronext)"},"TSX":{cc:"CA",city:"Toronto (TSX)"},
        "TOR":{cc:"CA",city:"Toronto (TSX)"},"ASX":{cc:"AU",city:"Sydney (ASX)"},
        "HKG":{cc:"HK",city:"Hong Kong (HKEX)"},"CCC":{cc:"CRYPTO",city:"Crypto"},
      };
      var exchCode = (quoteResult && quoteResult.fullExchangeName) || meta.exchangeName || "";
      // Map fullExchangeName string → cc
      var ccMap = {"NASDAQ":"US","NYSE":"US","NYSE Arca":"US","LSE":"GB","Paris":"FR","Milan":"IT","XETRA":"DE","Amsterdam":"NL","Toronto":"CA","Crypto":"CRYPTO"};
      var exInfo = EXCHANGE_MAP[exchCode] || { cc: ccMap[exchCode] || "US", city: exchCode };

      // ── Prix spot robuste ──────────────────────────────────────────────────
      // Quand le marché est fermé (marketState !== "REGULAR"), on privilégie
      // le close du dernier candle OHLC — plus fiable que regularMarketPrice
      // qui peut être le pre/post-market ou une valeur décalée pour les EU.
      var allCloses = [];
      for(var ci = 0; ci < candles.length; ci++){
        if(candles[ci].c != null) allCloses.push(candles[ci].c);
      }
      var lastCandleClose = allCloses.length ? allCloses[allCloses.length-1] : null;
      var prevCandleClose = allCloses.length > 1 ? allCloses[allCloses.length-2] : null;
      var metaPrice       = meta.regularMarketPrice || null;
      var metaPrevClose   = meta.chartPreviousClose || meta.previousClose || null;
      var mktState        = marketState || meta.marketState || "CLOSED";

      var spotPrice, spotPrevClose;
      if(mktState !== "REGULAR" && lastCandleClose){
        // Marché fermé → close OHLC prioritaire
        spotPrice     = lastCandleClose;
        spotPrevClose = prevCandleClose || metaPrevClose;
      } else if(lastCandleClose && metaPrice){
        // Marché ouvert → vérifier cohérence (ratio ±50%)
        var ratio = metaPrice / lastCandleClose;
        spotPrice     = (ratio < 0.5 || ratio > 2.0) ? lastCandleClose : metaPrice;
        spotPrevClose = (ratio < 0.5 || ratio > 2.0) ? (prevCandleClose || metaPrevClose) : (metaPrevClose || prevCandleClose);
      } else {
        spotPrice     = metaPrice || lastCandleClose;
        spotPrevClose = metaPrevClose || prevCandleClose;
      }

      return json({
        symbol:      sym,
        name:        (quoteResult && (quoteResult.longName||quoteResult.shortName)) || meta.longName || meta.shortName || sym,
        currency:    meta.currency || "USD",
        price:       spotPrice,
        prevClose:   spotPrevClose,
        marketCap:   (quoteResult && quoteResult.marketCap) || null,
        exchange:    exchCode,
        exchangeCC:  exInfo.cc,
        exchangeCity:exInfo.city,
        quoteType:   (quoteResult && quoteResult.quoteType) || (function(){
          // Yahoo retourne "EQUITY" pour les ETC/ETF EU quand quoteSummary échoue
          // 1. Essai via instrumentType du meta
          var it = meta.instrumentType || "";
          if(it === "ETF" || it === "ETC") return "ETF";
          if(it === "MUTUALFUND") return "MUTUALFUND";
          // 2. Heuristique : ETC/ETF identifiés par le nom (Amundi, iShares, Lyxor, Xtrackers…)
          var longN = (meta.longName || meta.shortName || "").toLowerCase();
          var etfKeywords = ["etc ", "etf", "amundi", "ishares", "lyxor", "xtrackers",
            "physical", "tracker", "ucits", "index fund", "world index"];
          for (var ki = 0; ki < etfKeywords.length; ki++){
            if(longN.indexOf(etfKeywords[ki]) >= 0) return "ETF";
          }
          return it || "";
        })(),
        sector:      (quoteResult && quoteResult.sector)    || "",
        industry:    (quoteResult && quoteResult.industry)  || "",
        logoUrl:     logoUrl     || null,
        marketState: marketState || null,
        exchangeTz:  exchangeTz  || null,
        etfCategory: etfCategory || null,
        topHoldings: topHoldings || null,
        _yahooDebug: yahooDebug,
        volAvg:      volAvg      || null,
        lastDiv:     lastDiv     || null,
        lastDivDate: lastDivDate || null,
        change1d:    change1d    || null,
        changePct1d: changePct1d || null,
        marketHours: marketHours || null,
        _fmpDebug: {
          status:      fmpStatus,
          error:       fmpError,
          hasKey:      false, // FMP désactivé
          fields: {
            marketCap:   marketCap   != null ? "ok" : "null",
            sector:      sector      ? "ok" : "null",
            industry:    industry    ? "ok" : "null",
            logoUrl:     logoUrl     ? "ok" : "null",
            volAvg:      volAvg      != null ? "ok" : "null",
            lastDiv:     lastDiv     != null ? "ok" : "null",
            lastDivDate: lastDivDate ? "ok" : "null",
            marketHours: marketHours ? "ok" : "null",
          }
        },
        candles:     candles,
        news:        newsItems,
      });
    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /coingecko-coin?id=bitcoin&symbol=BTC ────────────────────────────
  // Métriques complètes (marketCap, ATH, supply, rank, logo, categories, news)
  // Résultat mis en cache KV 1h pour éviter le rate-limit CoinGecko (429)
  if (path === "/coingecko-coin" && request.method === "GET") {
    var cgId  = url.searchParams.get("id");
    var cgSym = url.searchParams.get("symbol") || "";
    var noCache = url.searchParams.get("no_cache") === "1";
    if (!cgId) return json({ error: "id required" }, 400);

    var CG = {
      "Accept":          "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Referer":         "https://www.coingecko.com/",
      "Origin":          "https://www.coingecko.com",
    };
    var CG_BASE = "https://api.coingecko.com/api/v3";
    var cacheKey = "cg_coin_" + cgId;

    try {
      // ── Lecture cache KV (TTL 1h) ──────────────────────────────────────────
      if (!noCache && typeof GDB_KV !== "undefined") {
        var cached = await GDB_KV.get(cacheKey);
        if (cached) {
          var cachedData = JSON.parse(cached);
          // Ajouter les news fraîches (pas cachées)
          cachedData._fromCache = true;
          return json(cachedData);
        }
      }

      // ── 1. Métriques /coins/{id} ──────────────────────────────────────────
      var coinUrl = CG_BASE + "/coins/" + encodeURIComponent(cgId)
        + "?localization=false&tickers=false&market_data=true&community_data=false"
        + "&developer_data=false&sparkline=false";
      var cr = await fetch(coinUrl, { headers: CG });
      if (!cr.ok) return json({ error: "CoinGecko coin error: " + cr.status + " (id: " + cgId + ")" }, 502);
      var coin = await cr.json();
      var md = coin.market_data || {};

      // ── 2. News Yahoo Finance ──────────────────────────────────────────────
      var newsItems = [];
      var newsQuery = cgSym || cgId;
      try {
        var nUrl = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(newsQuery)
          + "&newsCount=8&quotesCount=0&enableFuzzyQuery=false&lang=en-US";
        var nr = await fetch(nUrl, { headers: { "User-Agent":"Mozilla/5.0","Accept":"application/json","Origin":"https://finance.yahoo.com","Referer":"https://finance.yahoo.com/" } });
        if (!nr.ok) { nUrl = nUrl.replace("query1","query2"); nr = await fetch(nUrl); }
        if (nr.ok) {
          var nd = await nr.json();
          newsItems = (nd.news || []).slice(0,8).map(function(n){ return {
            title: n.title||"", publisher: n.publisher||"", url: n.link||"",
            time: n.providerPublishTime ? n.providerPublishTime*1000 : null,
            thumbnail: n.thumbnail&&n.thumbnail.resolutions&&n.thumbnail.resolutions[0]&&n.thumbnail.resolutions[0].url||null,
          };});
        }
      } catch(en) {}

      // ── 3. Dominance BTC ──────────────────────────────────────────────────
      var btcDominance = null;
      if (cgId === "bitcoin") {
        try {
          var gr = await fetch(CG_BASE + "/global", { headers: CG });
          if (gr.ok) { var gd = await gr.json(); btcDominance = gd.data&&gd.data.market_cap_percentage&&gd.data.market_cap_percentage.btc||null; }
        } catch(eg) {}
      }

      // ── 4. Catégories ─────────────────────────────────────────────────────
      var categories = Array.isArray(coin.categories) ? coin.categories.filter(function(c){return c&&c.length>0;}) : [];

      // ── Prix spot depuis market_data ───────────────────────────────────────
      var spotPrice  = md.current_price&&md.current_price.usd||null;
      var prevClose  = spotPrice&&md.price_change_24h ? spotPrice-md.price_change_24h : null;

      var result = {
        name:              coin.name||cgId,
        symbol:            (coin.symbol||"").toUpperCase(),
        rank:              coin.market_cap_rank||null,
        logoUrl:           coin.image&&(coin.image.large||coin.image.small)||null,
        price:             spotPrice,
        prevClose:         prevClose,
        currency:          "USD",
        pct1d:             md.price_change_percentage_24h||null,
        marketCap:         md.market_cap&&md.market_cap.usd||null,
        volume24h:         md.total_volume&&md.total_volume.usd||null,
        ath:               md.ath&&md.ath.usd||null,
        athChangesPct:     md.ath_change_percentage&&md.ath_change_percentage.usd||null,
        athDate:           md.ath_date&&md.ath_date.usd||null,
        circulatingSupply: md.circulating_supply||null,
        maxSupply:         md.max_supply||null,
        totalSupply:       md.total_supply||null,
        sector:            categories[0]||null,
        industry:          categories[1]||null,
        quoteType:         "CRYPTO",
        btcDominance:      btcDominance,
        news:              newsItems,
        _cgDebug: { id:cgId, hasMarketData:!!md.current_price, newsCount:newsItems.length, categories:categories.slice(0,5) },
      };

      // ── Mise en cache KV 1h ───────────────────────────────────────────────
      if (typeof GDB_KV !== "undefined") {
        await GDB_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
      }

      return json(result);
    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /coingecko-ohlc?id=bitcoin&days=7 ────────────────────────────────
  // OHLC seulement — appelé à chaque changement de timeframe (léger, pas de cache)
  if (path === "/coingecko-ohlc" && request.method === "GET") {
    var oId   = url.searchParams.get("id");
    var oDays = url.searchParams.get("days") || "7";
    if (!oId) return json({ error: "id required" }, 400);

    var CGO = {
      "Accept":          "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Referer":         "https://www.coingecko.com/",
      "Origin":          "https://www.coingecko.com",
    };
    var CGOB = "https://api.coingecko.com/api/v3";

    // days valides pour OHLC : 1, 7, 14, 30, 90, 180, 365, max
    var validD = [1,7,14,30,90,180,365,"max"];
    var dNum = parseInt(oDays);
    var ohlcDays = oDays === "max" ? "max" : (function(){
      for (var di=0; di<validD.length; di++){
        if(validD[di]!=="max" && dNum<=validD[di]) return validD[di];
      }
      return "max";
    })();

    try {
      var oUrl = CGOB + "/coins/" + encodeURIComponent(oId) + "/ohlc?vs_currency=usd&days=" + ohlcDays;
      var or2 = await fetch(oUrl, { headers: CGO });
      if (!or2.ok) return json({ error: "OHLC error: " + or2.status }, 502);
      var oRaw = await or2.json();
      var candles = Array.isArray(oRaw) ? oRaw.map(function(r){return{t:r[0],o:r[1],h:r[2],l:r[3],c:r[4]};}) : [];
      return json({ candles: candles, ohlcDays: ohlcDays });
    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }

    if (path === "/market/overview" && request.method === "GET") {
      try { return json(await _cachedJson("cgi_mkt_overview", 300, url.searchParams.get("no_cache")==="1", buildMarketOverview)); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    if (path === "/market/movers" && request.method === "GET") {
      try { return json(await _cachedJson("cgi_mkt_movers", 300, url.searchParams.get("no_cache")==="1", buildMarketMovers)); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    if (path === "/funding" && request.method === "GET") {
      try { return json(await _cachedJson("cgi_funding", 600, url.searchParams.get("no_cache")==="1", buildFunding)); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    if (path === "/market/flows" && request.method === "GET") {
      try { return json(await _cachedJson("cgi_mkt_flows", 900, url.searchParams.get("no_cache")==="1", buildMarketFlows)); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    if (path === "/btc-signals" && request.method === "GET") {
      try { return json(await _cachedJson("cgi_btc_signals", 900, url.searchParams.get("no_cache")==="1", buildBtcSignals)); }
      catch (e) { return json({ error: e.message }, 500); }
    }

  // ── POST /delete ──────────────────────────────────────────────────────────  // ── POST /delete ──────────────────────────────────────────────────────────
  // Body: { keys: ["cgi_dd", ...] } ou { all: true }
  if (path === "/delete" && request.method === "POST") {
    try {
      var body3 = await request.text();
      var payload = JSON.parse(body3);
      var ALLOWED = ["cgi_data","cgi_txns","cgi_dd","cgi_gdbs","cgi_gc","cgi_gsb","cgi_bench","cgi_cm","cgi_sm","cgi_tm","cgi_portfolio","cgi_crypto","cgi_stocks","cgi_bank","cgi_yfmap","cgi_icons","cgi_snapshots","cgi_watchlist","cgi_devices"];
      var toDelete = payload.all ? ALLOWED : (payload.keys || []).filter(function(k){ return ALLOWED.indexOf(k) >= 0; });
      var deleted = []; var delErrors = [];
      await Promise.all(toDelete.map(async function(key) {
        try { await GDB_KV.delete(key); deleted.push(key); }
        catch(e) { delErrors.push(key + ": " + e.message); }
      }));
      return json({ ok: delErrors.length === 0, deleted: deleted, errors: delErrors });
    } catch(e) {
      return json({ error: e.message }, 500);
    }
  }

  // ── POST /migrate-kv ─────────────────────────────────────────────────────
  // Migration one-shot : lit les anciennes clés gdb_* et réécrit sous cgi_*
  // puis supprime les gdb_*. Idempotent (skip si cgi_* déjà rempli).
  if (path === "/migrate-kv" && request.method === "POST") {
    var MIGRATE_MAP = {
      "gdb_snapshots": "cgi_snapshots",
      "gdb_txns":      "cgi_txns",
      "gdb_dd":        "cgi_dd",
      "gdb_gdbs":      "cgi_gdbs",
      "gdb_cm":        "cgi_cm",
      "gdb_sm":        "cgi_sm",
      "gdb_tm":        "cgi_tm",
      "gdb_portfolio": "cgi_portfolio",
      "gdb_crypto":    "cgi_crypto",
      "gdb_stocks":    "cgi_stocks",
      "gdb_bank":      "cgi_bank",
      "gdb_yfmap":     "cgi_yfmap",
      "gdb_icons":     "cgi_icons",
      "gdb_watchlist": "cgi_watchlist",
      "gdb_gc":        "cgi_gc",
      "gdb_gsb":       "cgi_gsb",
      "gdb_bench":     "cgi_bench",
    };
    var migrated = [], skipped = [], errors = [];
    await Promise.all(Object.entries(MIGRATE_MAP).map(async function([oldKey, newKey]) {
      try {
        // Si cgi_* existe déjà et non vide → skip (idempotent)
        var existing = await GDB_KV.get(newKey);
        if (existing && existing !== "null") {
          // cgi_* déjà rempli — supprimer quand même l'ancien gdb_*
          try { await GDB_KV.delete(oldKey); } catch(e){}
          skipped.push(newKey + " (déjà présent)");
          return;
        }
        var val = await GDB_KV.get(oldKey);
        if (val === null) {
          skipped.push(oldKey + " (vide)");
          return;
        }
        await GDB_KV.put(newKey, val);
        await GDB_KV.delete(oldKey);
        migrated.push(oldKey + " → " + newKey);
      } catch(e) {
        errors.push(oldKey + ": " + e.message);
      }
    }));
    return json({
      ok: errors.length === 0,
      migrated: migrated,
      skipped: skipped,
      errors: errors,
      summary: migrated.length + " clés migrées, " + skipped.length + " sautées, " + errors.length + " erreurs"
    });
  }

  return json({ error: "Not found", path: path }, 404);
}
