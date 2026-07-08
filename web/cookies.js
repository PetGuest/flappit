/* Flappit — consentimiento de cookies + carga condicional de Google Analytics 4.
   GA solo se carga si el visitante pulsa "Aceptar". Si rechaza, no se carga nada
   y la elección se recuerda en localStorage (flappitConsent: "yes" | "no"). */
(function(){
  "use strict";
  var GA_ID = "G-PGB79DSRXV";
  var KEY = "flappitConsent";
  var EN = location.pathname === "/en" || location.pathname.indexOf("/en/") === 0;

  function loadGA(){
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){ dataLayer.push(arguments); };
    gtag("js", new Date());
    gtag("config", GA_ID, { anonymize_ip: true });
  }

  var choice = null;
  try { choice = localStorage.getItem(KEY); } catch(e){}
  if (choice === "yes") { loadGA(); return; }
  if (choice === "no") return;

  var t = EN ? {
    txt: "We use one optional analytics cookie (Google Analytics) to understand visits. No ads, no cross-site tracking. ",
    more: "More info", accept: "Accept", reject: "Reject"
  } : {
    txt: "Usamos una única cookie opcional de analítica (Google Analytics) para entender las visitas. Sin publicidad ni rastreo entre sitios. ",
    more: "Más información", accept: "Aceptar", reject: "Rechazar"
  };
  var legalHref = EN ? "/en/legal.html#cookies" : "/legal.html#cookies";

  function ready(fn){
    if (document.body) fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function(){
    var bar = document.createElement("div");
    bar.id = "cookieBar";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", EN ? "Cookie notice" : "Aviso de cookies");
    bar.innerHTML =
        '<style>#cookieBar{position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;'
      + 'background:#131316;color:#f4f4f0;border:1px solid #2c2c33;border-radius:12px;'
      + 'padding:14px 16px;font:14px/1.5 -apple-system,"SF Pro Text","Inter",system-ui,sans-serif;'
      + 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;max-width:720px;margin:0 auto;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.45)}'
      + '#cookieBar a{color:#d7e021;text-decoration:none}'
      + '#cookieBar .cbTxt{flex:1 1 300px}'
      + '#cookieBar button{border:0;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer;'
      + 'font-family:inherit;font-size:13px}'
      + '#cookieBar .cbOk{background:#d7e021;color:#0a0a0c}'
      + '#cookieBar .cbNo{background:#26262b;color:#f4f4f0}</style>'
      + '<div class="cbTxt">' + t.txt + '<a href="' + legalHref + '">' + t.more + '</a></div>'
      + '<button class="cbNo" id="cbNo">' + t.reject + '</button>'
      + '<button class="cbOk" id="cbOk">' + t.accept + '</button>';
    document.body.appendChild(bar);
    document.getElementById("cbOk").addEventListener("click", function(){
      try { localStorage.setItem(KEY, "yes"); } catch(e){}
      bar.remove(); loadGA();
    });
    document.getElementById("cbNo").addEventListener("click", function(){
      try { localStorage.setItem(KEY, "no"); } catch(e){}
      bar.remove();
    });
  });
})();
