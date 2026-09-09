/* ============================================================================
 * BB TRACKER - tracker.js
 * ----------------------------------------------------------------------------
 * Tracker de funil (advertorial / quiz / VSL) que envia eventos direto pro
 * PostHog (regiao EU). Sem dependencias. ES5-safe (trafego pago = navegadores
 * mobile antigos).
 *
 * Ordem OBRIGATORIA no <head> da pagina:
 *   1. snippet oficial do posthog-js   -> define window.posthog
 *   2. window.BB_TRACKER_CONFIG = { pageType, pageId }
 *   3. este arquivo (tracker.js)
 *
 * Eventos automaticos (nomes EXATOS, nao mude ou o dashboard fica vazio):
 *   page_init      - UTMs + referrer + device
 *   utm_captured   - so quando ha UTM na URL
 *   scroll_depth   - marcos 25 / 50 / 75 / 100
 *   time_on_page   - HEARTBEAT a cada 5s de tempo ativo (bucket 5/10/15...) +
 *                    1 tick final { final:true } no unload/navegacao (sendBeacon)
 *   cta_clicked    - clique em [data-bb-cta]  (pack / text / href)
 *
 * Todos os eventos carregam as super properties  pageType  e  pageId.
 *
 * POSTHOG_KEY abaixo e a *Project API Key* (phc_...), publicavel por design -
 * pode ficar no client. NUNCA coloque aqui a Personal API Key (phx_...).
 * ========================================================================== */
(function () {
  "use strict";

  var CFG = window.BB_TRACKER_CONFIG || {};
  var PAGE_TYPE = CFG.pageType || "unknown";
  var PAGE_ID = CFG.pageId || "unknown";

  var POSTHOG_KEY = CFG.posthogKey || "phc_ruQiTTyRKK4kUWmrXgSgPE6ZihS8PvV6WTaQsjNV4YpD";
  var POSTHOG_HOST = "https://eu.i.posthog.com";

  var LS_USER = "bb_user_id";
  var LS_UTMS = "bb_utms";

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  var _panel = null;
  function log() {
    if (!CFG.debug) return;
    var args = [].slice.call(arguments);
    try { if (window.console) console.log.apply(console, ["[bb-tracker]"].concat(args)); } catch (e) {}
    try {
      if (!_panel && document.body) {
        _panel = document.createElement("div");
        _panel.id = "bb-debug";
        _panel.setAttribute("style",
          "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:46vw;max-height:44vh;" +
          "overflow:auto;background:rgba(0,0,0,.86);color:#0f0;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;" +
          "padding:8px 10px;border-radius:8px;white-space:pre-wrap;pointer-events:auto;");
        _panel.textContent = "[bb-tracker] debug\n";
        document.body.appendChild(_panel);
      }
      if (_panel) {
        var line = args.map(function (a) {
          return (a && typeof a === "object") ? (function () { try { return JSON.stringify(a); } catch (e) { return String(a); } })() : String(a);
        }).join(" ");
        _panel.textContent += (new Date().toISOString().slice(11, 19)) + "  " + line + "\n";
        _panel.scrollTop = _panel.scrollHeight;
      }
    } catch (e) {}
  }

  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
      }
    }
    return out;
  }

  // capture com fallback de erro. opts:
  //   { send_instantly: true }        -> XHR imediato (nao espera o batch de ~3s)
  //   { transport: "sendBeacon" }     -> sobrevive a navegacao/unload da pagina
  function cap(name, props, opts) {
    try { posthog.capture(name, props, opts); log("capture:", name, opts || ""); }
    catch (e) { log("capture FALHOU:", name, e); }
  }

  function uuid() {
    return "bb_" + Date.now().toString(36) +
      "_" + Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6);
  }

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  function getQuery() {
    var q = {}, s = window.location.search.replace(/^\?/, "");
    if (!s) return q;
    var parts = s.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      var key = decodeURIComponent(kv[0] || "");
      if (!key) continue;
      q[key] = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
    }
    return q;
  }

  function refDomain() {
    if (!document.referrer) return null;
    try { return document.referrer.split("/")[2] || null; } catch (e) { return null; }
  }

  function deviceInfo() {
    var ua = navigator.userAgent || "";
    var type = "desktop";
    if (/\b(iPad|Tablet)\b/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) type = "tablet";
    else if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) type = "mobile";
    return {
      device_type: type,
      user_agent: ua,
      screen_width: (window.screen && window.screen.width) || null,
      screen_height: (window.screen && window.screen.height) || null,
      viewport_width: window.innerWidth || null,
      viewport_height: window.innerHeight || null,
      language: navigator.language || null,
      timezone: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; }
      })()
    };
  }

  // -------------------------------------------------------------------------
  // guarda: posthog-js precisa ter carregado antes deste arquivo
  // -------------------------------------------------------------------------
  if (!window.posthog || typeof window.posthog.init !== "function") {
    log("posthog-js nao encontrado - o snippet oficial precisa vir ANTES do tracker.js. Abortando.");
    return;
  }
  var posthog = window.posthog;

  // -------------------------------------------------------------------------
  // user_id persistente  ->  init  ->  identify
  // -------------------------------------------------------------------------
  var userId = lsGet(LS_USER);
  if (!userId) { userId = uuid(); lsSet(LS_USER, userId); }

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    debug: CFG.debug === true,
    person_profiles: "always",          // cria pessoa mesmo pra anonimo -> unicos por person_id
    autocapture: false,                 // so eventos nomeados; dashboard depende dos nomes exatos
    capture_pageview: false,            // usamos page_init
    capture_pageleave: false,           // usamos time_on_page
    request_batching: false,            // cada evento = 1 request imediato (nada preso num batch que morre no unload)
    disable_session_recording: CFG.disableSessionRecording === true,
    persistence: "localStorage+cookie",
    loaded: function (ph) {
      try { ph.identify(userId); } catch (e) {}
      log("posthog loaded; identify=", userId);
    }
  });

  // super properties em TODOS os eventos
  posthog.register({
    pageType: PAGE_TYPE,
    pageId: PAGE_ID,
    bb_user_id: userId
  });

  // -------------------------------------------------------------------------
  // page_init  +  utm_captured
  // -------------------------------------------------------------------------
  var Q = getQuery();
  var UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
  var CLICK_IDS = ["ttclid", "fbclid", "gclid"];

  var utms = {}, hasUtm = false;
  for (var a = 0; a < UTM_FIELDS.length; a++) {
    var f = UTM_FIELDS[a];
    if (Q[f]) { utms[f] = Q[f]; hasUtm = true; }
  }
  var clickIds = {};
  for (var b = 0; b < CLICK_IDS.length; b++) {
    if (Q[CLICK_IDS[b]]) clickIds[CLICK_IDS[b]] = Q[CLICK_IDS[b]];
  }

  // persiste UTMs pra reidratar em navegacao posterior no mesmo dominio
  if (hasUtm) lsSet(LS_UTMS, JSON.stringify(utms));
  var storedUtms = {};
  try { storedUtms = JSON.parse(lsGet(LS_UTMS) || "{}") || {}; } catch (e) {}
  var effectiveUtms = hasUtm ? utms : storedUtms;

  var dev = deviceInfo();

  cap("page_init", merge({
    url: window.location.href,
    path: window.location.pathname,
    title: document.title || null,
    referrer: document.referrer || null,
    referring_domain: refDomain()
  }, effectiveUtms, clickIds, dev), { send_instantly: true });

  if (hasUtm) {
    cap("utm_captured", merge({ url: window.location.href }, utms, clickIds), { send_instantly: true });
  }

  // scrollPct e usado por scroll_depth E time_on_page
  function scrollPct() {
    try {
      var d = document.documentElement, bd = document.body || d;
      var top = window.pageYOffset || d.scrollTop || bd.scrollTop || 0;
      var height = Math.max(
        bd.scrollHeight, d.scrollHeight,
        bd.offsetHeight, d.offsetHeight,
        bd.clientHeight, d.clientHeight
      );
      var vh = window.innerHeight || d.clientHeight || 0;
      var denom = height - vh;
      return denom > 0 ? Math.min(100, Math.round((top / denom) * 100)) : 100;
    } catch (e) { return 0; }
  }

  // -------------------------------------------------------------------------
  // time_on_page  -- HEARTBEAT: 1 evento a cada HB_STEP seg na pagina
  //   heartbeat -> { heartbeat:true, final:false, bucket:5|10|15..., seconds:bucket }
  //   fim (saida/navegacao) -> { final:true, heartbeat:false, seconds:<exato> }
  //   Contagem = wall-clock desde o load (simples e a prova de bug). posthog-js
  //   troca sozinho pra sendBeacon quando a pagina esta saindo.
  //   Dashboard (Etapa 4): curva de retencao = count(DISTINCT person_id) por bucket.
  // -------------------------------------------------------------------------
  var HB_STEP = Math.max(1, CFG.heartbeatSeconds || 5);
  var HB_MAX  = Math.max(HB_STEP, CFG.heartbeatMaxSeconds || 300);
  var loadTs = Date.now();
  var lastBucketSent = 0;
  var endSent = false;
  var hbTimer = null;

  function elapsedSecs() { return Math.floor((Date.now() - loadTs) / 1000); }

  function timeTick(isFinal) {
    var secs = elapsedSecs();
    var bucket = Math.floor(secs / HB_STEP) * HB_STEP;
    if (isFinal) {
      if (endSent) return;
      endSent = true;
      cap("time_on_page", { seconds: secs, bucket: bucket, final: true, heartbeat: false, max_scroll_percent: scrollPct() });
      return;
    }
    if (bucket > HB_MAX) { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } return; }
    if (bucket < HB_STEP || bucket === lastBucketSent) return;
    lastBucketSent = bucket;
    cap("time_on_page", { seconds: bucket, bucket: bucket, final: false, heartbeat: true, max_scroll_percent: scrollPct() });
  }

  hbTimer = setInterval(function () {
    var s = elapsedSecs();
    if (CFG.debug && s % 5 === 0 && s > 0) log("tick: elapsed=" + s + "s scroll=" + scrollPct() + "%");
    timeTick(false);
  }, 1000);
  log("heartbeat armado (step=" + HB_STEP + "s, max=" + HB_MAX + "s)");

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") timeTick(true);
  });
  window.addEventListener("pagehide", function () { timeTick(true); });
  window.addEventListener("beforeunload", function () { timeTick(true); });

  // -------------------------------------------------------------------------
  // cta_clicked  (clique em [data-bb-cta])  -- dispara logo antes de navegar
  // -------------------------------------------------------------------------
  function findCta(node) {
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.hasAttribute && node.hasAttribute("data-bb-cta")) return node;
      node = node.parentNode;
    }
    return null;
  }
  document.addEventListener("click", function (ev) {
    var el = findCta(ev.target);
    if (!el) return;
    var href = el.getAttribute("href") || el.getAttribute("data-href") || null;
    var text = (el.textContent || el.value || "")
      .replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, 200);
    var pack = el.getAttribute("data-bb-pack") || null;
    log("cta_clicked -> pack", pack, href || "");

    // Se e um link normal que vai navegar, segura 250ms pro evento sair primeiro.
    var isPlainNav =
      el.tagName === "A" && href && href.charAt(0) !== "#" &&
      !ev.defaultPrevented && ev.button === 0 &&
      !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey &&
      (!el.target || el.target === "" || el.target === "_self");

    cap("cta_clicked", {
      pack: pack, text: text || null, href: href,
      element_id: el.id || null, element_tag: (el.tagName || "").toLowerCase() || null
    });

    if (isPlainNav) {
      ev.preventDefault();
      setTimeout(function () { window.location.href = href; }, 250);
    }
  }, true);

  // -------------------------------------------------------------------------
  // scroll_depth  (25 / 50 / 75 / 100)
  // -------------------------------------------------------------------------
  var MARKS = [25, 50, 75, 100];
  var firedMark = {};

  function checkScroll() {
    var p = scrollPct();
    for (var i = 0; i < MARKS.length; i++) {
      var m = MARKS[i];
      if (p >= m && !firedMark[m]) {
        firedMark[m] = true;
        log("scroll_depth ->", m, "(" + p + "%)");
        cap("scroll_depth", { depth: m, percent: p });
      }
    }
  }

  var scrollTimer = null;
  var scrollLogged = 0;
  function onScroll() {
    if (CFG.debug && Date.now() - scrollLogged > 1500) { scrollLogged = Date.now(); log("onScroll p=" + scrollPct() + "%"); }
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () { scrollTimer = null; checkScroll(); }, 200);
  }
  if (window.addEventListener) {
    try { window.addEventListener("scroll", onScroll, { passive: true }); }
    catch (e) { window.addEventListener("scroll", onScroll, false); }
  }
  checkScroll(); // pagina curta ou ja aberta rolada

  log("iniciado", { pageType: PAGE_TYPE, pageId: PAGE_ID, userId: userId });
})();
