// ==UserScript==
// @name         Заправыч
// @namespace    zapravych
// @version      3.12.3
// @description  Заправыч — ловит QR на топливо и присылает его тебе в Telegram. Один номер, низкий профиль.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ales-ctrl-1998/qr-helper/main/solo.user.js
// @downloadURL  https://raw.githubusercontent.com/ales-ctrl-1998/qr-helper/main/solo.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ───── НАСТРОЙКИ ─────
  const CONFIG = {
    pollFastMs: 1000,         // опрос /fuel-types раз в секунду в горячем окне
    pollIdleMs: 15000,        // вне окна — раз в 15с (чтобы не спамить сервер весь день)
    hotFrom: '21:30',
    hotTo:   '23:50',
    pollTimeoutMs: 4000,      // таймаут на опрос /fuel-types
    checkTimeoutMs: 3000,     // короткий таймаут на /plate/check (в шторм НЕ блокируем грэб на 9с)
    reauthTimeoutMs: 6000,    // /session/max: в шторм 9с слишком долго — дохлую реавторизацию обрываем быстрее и повторяем
    createTimeoutMs: 9000,    // таймаут на прочие POST
    createHotMs: 6000,        // даём запросу «подышать» — НЕ обрывать рано (меньше повторов = меньше похоже на бота)
    retryDelayMs: 600,        // человеческая пауза между попытками /create (джиттер сверху)
    stockRefreshMs: 3000,     // как часто обновляем остатки во время грэба (реже = тише)
    grabMaxMs: 4 * 60 * 1000, // сколько максимум пробуем за один заход
    // 🕶 СРЕДНИЙ-НИЗКИЙ ПРОФИЛЬ: «чуть бодрее, но не пушка» (выбор пользователя 26.06).
    // 3 параллельных /create с человеческими паузами+джиттером и неровным опросом — компромисс
    // между «не палиться» и шансом пробить 5xx-стену на /create (26.06 у двоих с живой сессией
    // стена не пробилась ни разу за ~70с; ставка — ранний выстрел T+0 + умеренная параллель).
    workers: 3,
    reauthHotMs: 75000,       // тихая реавторизация в горячем окне (cookie ttl=900с)
    reauthIdleMs: 300000,
    preflightMs: 2500,        // первая тихая реавторизация после старта
    prearmSec: 75,            // за сколько секунд до объявленного времени форсить опрос+реавторизацию
  };
  // ─────────────────────

  // @match стоит на ВСЕ сайты (чтобы скрипт был виден/управляем с любой вкладки),
  // но работаем ТОЛЬКО на домене топлива и только если на странице есть его формы — иначе сразу выходим.
  if (!/\.?sevtech\.org$/i.test(location.hostname)) return;
  if (!document.querySelector('[data-out-of-stock-message], [data-wait-message], [data-plate-form]')) return;

  const API = '/fuel/qr';
  const PLATE_LATIN = 'ABEKMHOPCTYX';
  const PLATE_CYR   = 'АВЕКМНОРСТУХ';
  const PLATE_STD   = /^[АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2}[0-9]{2,3}$/;
  const PLATE_RX    = /^([АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2})([0-9]{2,3})$/;
  const LOG_KEY = 'fuelLog';
  const LOG_CAP = 300000; // ~300 КБ — страховка на офлайн (онлайн буфер вычищается после заливки на сервер)
  const CONTACT_KEY = 'fuelSavedContact';
  const PLATE_KEY = 'fuelSoloPlate';
  const FUELS_KEY = 'fuelSoloFuels';
  const TG_KEY    = 'fuelTgToken';       // код привязки к боту Заправыч (вставляет юзер)
  const TG_BASE_KEY = 'fuelTgRelayBase'; // кэш адреса relay-туннеля (узнаём из указателя)
  // указатель: маленький файл на GitHub с ЖИВЫМ адресом туннеля (сервер сам его обновляет)
  const TG_POINTER = 'https://raw.githubusercontent.com/ales-ctrl-1998/qr-helper/main/relay.txt';
  const VERSION = '3.12.3';   // держать в синхроне с @version
  const FUEL_LABELS = { a95_plus: '95+', a95: '95', a92: '92', a100: '100', dt: 'ДТ', dt_plus: 'ДТ+' };
  const prettyPref = (arr) => (arr || []).map((id) => FUEL_LABELS[id] || id).join(' → ');
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ───── СТИЛЬ UI (светлая «стеклянная» тема под админку sev-tsifra.ru) ─────
  function plateHTML(plate, small) {
    const cls = 'fq-plate' + (small ? ' sm' : '');
    const m = PLATE_RX.exec(plate || '');
    if (!m) return '<span class="' + cls + '"><span class="pm">' + escHtml(plate || '—') + '</span></span>';
    const main = m[1][0] + ' ' + m[1].slice(1, 4) + ' ' + m[1].slice(4);
    return '<span class="' + cls + '"><span class="pm">' + main + '</span>' +
      '<span class="pr"><span class="rn">' + m[2] + '</span><span class="ru"><span class="fl"></span>RUS</span></span></span>';
  }
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    const css = `
.fq-ov{position:fixed;inset:0;z-index:100020;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:13px;padding:22px 14px;overflow:auto;
  background:rgba(16,22,46,.78);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.fq-ov.center>*{margin-top:auto;margin-bottom:auto}
.fq-card{width:100%;max-width:440px;background:#ffffff!important;color:#1a1f2e!important;
  border:1px solid #e2e6f0;border-radius:20px;box-shadow:0 18px 50px rgba(10,16,46,.5);padding:18px}
.fq-h{font:800 18px/1.25 system-ui,sans-serif;color:#1a1f2e;text-align:center}
.fq-sub{font:500 13.5px/1.45 system-ui,sans-serif;color:#5a6172;text-align:center}
.fq-btn{border:0;border-radius:12px;font:700 15px/1 system-ui,sans-serif;cursor:pointer;padding:13px 18px;color:#fff;
  transition:transform .1s,box-shadow .14s,background .14s}
.fq-btn:active{transform:scale(.97)}
.fq-btn.primary{background:#3b6ef5;box-shadow:0 4px 14px rgba(59,110,245,.34)}
.fq-btn.primary:hover{background:#2f57d6}
.fq-btn.ok{background:#1f9d57;box-shadow:0 4px 14px rgba(31,157,87,.3)}
.fq-btn.ok:hover{background:#198048}
.fq-btn.ghost{background:#eef1f7!important;color:#1a1f2e!important;border:1px solid #c4ccde}
.fq-btn[disabled]{opacity:.5;cursor:default}
.fq-input{width:100%;box-sizing:border-box;padding:14px 14px;border-radius:13px;border:2px solid rgba(120,134,184,.5);
  background:#fff!important;color:#11151f!important;font:800 22px/1 "Helvetica Neue",Arial,sans-serif;letter-spacing:2.5px;
  text-align:center;text-transform:uppercase;outline:none}
.fq-input:focus{border-color:#3b6ef5;box-shadow:0 0 0 3px rgba(59,110,245,.18)}
.fq-plate{display:inline-flex;align-items:stretch;background:#fff!important;border:2px solid #11151f;border-radius:7px;overflow:hidden;
  font-family:"Helvetica Neue",Arial,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.18);height:38px;vertical-align:middle}
.fq-plate .pm{display:flex;align-items:center;padding:0 10px;font:700 22px/1 "Helvetica Neue",Arial,sans-serif;letter-spacing:1.5px;white-space:nowrap;color:#11151f!important}
.fq-plate .pr{display:flex;flex-direction:column;align-items:center;justify-content:center;border-left:2px solid #11151f;padding:0 7px;min-width:44px}
.fq-plate .pr .rn{font:700 16px/1 "Helvetica Neue",Arial,sans-serif;color:#11151f!important}
.fq-plate .pr .ru{display:flex;align-items:center;gap:2px;font:700 7px/1 "Helvetica Neue",Arial,sans-serif;letter-spacing:.4px;margin-top:1px;color:#11151f!important}
.fq-plate .pr .fl{width:11px;height:7px;border:.5px solid #b9bfca;border-radius:1px;background:linear-gradient(to bottom,#fff 0 33.3%,#0039a6 33.3% 66.6%,#d52b1e 66.6% 100%)}
.fq-plate.sm{height:32px}.fq-plate.sm .pm{font-size:18px;padding:0 8px}.fq-plate.sm .pr{min-width:38px;padding:0 6px}.fq-plate.sm .pr .rn{font-size:13px}
.fq-chip{padding:13px 16px;border-radius:12px;border:2px solid rgba(120,134,184,.5);background:#fff!important;font:700 15px system-ui,sans-serif;cursor:pointer;color:#1a1f2e!important;min-width:78px;text-align:center}
.fq-chip.on{background:#e9f9f0!important;border-color:#1f9d57;color:#1f9d57!important}
.fq-ord{font:700 15px system-ui,sans-serif;color:#1f9d57;min-height:20px;text-align:center}
.fq-tools{position:fixed;top:8px;right:8px;z-index:100000;display:flex;gap:6px;flex-wrap:nowrap}
.fq-tool{background:#ffffff!important;color:#1a1f2e!important;
  border:1px solid #c4ccde;border-radius:11px;padding:7px 10px;font:700 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(20,30,80,.18);white-space:nowrap}
.fq-tool:active{transform:scale(.95)}
.fq-badge{position:fixed;top:48px;left:8px;right:8px;z-index:99999;background:#ffffff!important;color:#1a1f2e!important;
  border:1px solid #c4ccde;
  font:700 13px/1.35 system-ui,sans-serif;padding:8px 12px;border-radius:12px;box-shadow:0 6px 20px rgba(20,30,80,.2);word-break:break-word}
.fq-qr{background:#eaf9f0!important;border:1px solid #1f9d57;border-radius:14px;padding:16px;min-width:260px;text-align:center}
.fq-qr img{width:230px;height:230px;max-width:78vw;background:#fff;border-radius:10px;padding:8px;margin:12px auto 0;display:block}
`;
    try { const st = document.createElement('style'); st.id = 'fq-styles'; st.textContent = css; (document.head || document.documentElement).appendChild(st); } catch (e) {}
  }

  // ───── состояние (ОДНА цель) ─────
  const STATE = { plate: '', fuels: [], confirmed: false, running: false, busy: false,
    grabbed: false, dropped: false, ticket: null, timer: null, dropTime: null, prearmHandled: false };
  let everAuthed = false, sessionDead = false, sessionUp = false, manualReauth = false;
  let grabGen = 0;

  const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.3);
  // неровный интервал опроса ±15% — чтобы не выглядело роботизированно-ровным (раз в ровно 1000мс = подпись бота)
  const jitterPoll = (ms) => Math.max(450, ms + Math.floor((Math.random() - 0.5) * ms * 0.3));

  // ───── ЛОГ ─────
  function log(tag, msg) {
    const line = new Date().toISOString() + ' [' + tag + '] ' + msg;
    try { console.log('[fuelLog]', line); } catch (e) {}
    try { const prev = localStorage.getItem(LOG_KEY) || ''; localStorage.setItem(LOG_KEY, (prev + line + '\n').slice(-LOG_CAP)); } catch (e) {}
  }
  function downloadLog() {
    let text = ''; try { text = localStorage.getItem(LOG_KEY) || ''; } catch (e) {}
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'fuel-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ───── РЕПОРТ СТАТИСТИКИ (мониторинг sev-tsifra.ru) ─────
  // НИЗКИЙ ПРОФИЛЬ: в момент раздачи НИЧЕГО не шлём (нагрузку на боевой не добавляем, не палимся).
  // Репорт идёт ТОЛЬКО по итогу захода (успех/кулдаун/блок/разобрали) + лог по кнопке. Fire-and-forget,
  // другой домен, ошибки глушим — мониторинг не должен влиять на грэб. POST text/plain → без CORS-preflight.
  const RPT = {
    url: 'https://sev-tsifra.ru/admin/fuel/api.php',
    key: '3c62aad852f3a9f8f58aebe1ef9a1f2c6497fd0c2a0ecea0',
  };
  function myPhone() { const c = loadContact(); return (c && c.phone) ? String(c.phone) : ''; }
  function rptPost(action, payload) {
    const phone = myPhone();
    if (!phone) { log('RPT', action + ' пропущен — нет телефона (контакт не пойман)'); return Promise.resolve(false); }
    const body = JSON.stringify(Object.assign({ key: RPT.key, phone }, payload));
    return fetch(RPT.url + '?action=' + action, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
      .then((r) => r.json()).then((d) => { log('RPT', action + ' → ' + (d && d.status)); return d && d.status === 'ok'; })
      .catch((e) => { log('RPT', action + ' ошибка: ' + (e && e.message || e)); return false; });
  }
  // СТАТУС НОМЕРА (на сервере хранится по авто): wait(ожидаем) → success(успех)/fail(облом). Приоритет — на сервере.
  // По одному разу каждого рода на заход (сброс в applyTarget / при F5). Низкий профиль: при старте/по итогу, не в шторм.
  let reportedSuccess = false, reportedFail = false, reportedWait = false;
  function rptEvent(extra) {
    rptPost('event', Object.assign({ plate: STATE.plate || '', ts: new Date().toISOString() }, extra));
  }
  function reportWait() {   // номер запущен — «⏳ ожидаем» (виден в «Машинах», но не исход)
    if (reportedWait || reportedFail || reportedSuccess) return;
    reportedWait = true;
    rptEvent({ status: 'wait' });
    relayLog();   // заливаем лог уже при старте — чтобы он был виден по каждому запущенному телефону (не только по итогу)
  }
  function reportFail(reason) {   // раздача прошла, код не взяли — «❌ облом»
    if (reportedFail || reportedSuccess) return;
    reportedFail = true;
    rptEvent({ status: 'fail', reason: reason || '' });
    tgSend({ status: 'fail' });
    relayLog();
  }
  async function reportSuccess(ticket, fuel) {   // взяли код — «✅ успех» (+ узнаём next_create_at: когда снова можно)
    if (reportedSuccess) return;
    reportedSuccess = true;
    const fuelCode = (fuel && fuel.code) || '';
    const fuelTitle = (ticket && ticket.fuel_type_title) || (fuel && (fuel.title || fuel.code)) || '';
    let next = '';
    try {   // у номера теперь есть код → /plate/check вернёт active_own + next_create_at (недельный кулдаун)
      const chk = await api('/plate/check', { method: 'POST', body: JSON.stringify({ car_plate: STATE.plate, plate_format_confirmed: STATE.confirmed }) }, CONFIG.checkTimeoutMs);
      if (chk && chk.next_create_at) next = String(chk.next_create_at);
    } catch (e) {}
    rptEvent({ status: 'success', fuel: fuelCode, fuel_title: fuelTitle, next_create_at: next });
    tgSend({ status: 'success', fuel: fuelCode, fuel_title: fuelTitle,
             deeplink: (ticket && ticket.deeplink) || '', qr_png_base64: (ticket && ticket.qr_png_base64) || '' });
    relayLog();
  }
  function reportRelease(plate) {   // сменили номер на этом телефоне → отвязать старый (обнулить его «ожидаем»)
    if (!plate) return;
    rptPost('release', { plate });
  }

  // ───── ДОСТАВКА В TELEGRAM-БОТА «Заправыч» (QR/итог прилетает в чат) ─────
  // Код привязки хранится в TG_KEY. Адрес relay-туннеля берём из указателя на GitHub
  // (сервер сам обновляет его при смене туннеля → самолечение). Fire-and-forget, на грэб НЕ влияет.
  function getTgToken() { try { return (localStorage.getItem(TG_KEY) || '').trim(); } catch (e) { return ''; } }
  function setTgToken(t) { try { localStorage.setItem(TG_KEY, String(t || '').trim()); } catch (e) {} }
  let _relayBase = '', _relayAt = 0;
  async function relayBase() {
    const now = Date.now();
    if (_relayBase && (now - _relayAt) < 300000) return _relayBase;   // кэш 5 мин
    try {
      const r = await fetch(TG_POINTER + '?t=' + now, { cache: 'no-store' });
      const txt = (await r.text()).trim();
      if (/^https:\/\/[a-z0-9.\-]+/i.test(txt)) {
        _relayBase = txt.replace(/\/+$/, ''); _relayAt = now;
        try { localStorage.setItem(TG_BASE_KEY, _relayBase); } catch (e) {}
        return _relayBase;
      }
    } catch (e) { log('TG', 'указатель недоступен: ' + (e && e.message || e)); }
    try { const c = localStorage.getItem(TG_BASE_KEY); if (c) { _relayBase = c; return c; } } catch (e) {}
    return '';
  }
  async function tgSend(payload) {
    const tg = getTgToken();
    if (!tg) return;   // не привязан — молчим
    const base = await relayBase();
    if (!base) { log('TG', 'нет адреса relay — доставка пропущена'); return; }
    const body = JSON.stringify(Object.assign({ tg, plate: STATE.plate || '', ts: new Date().toISOString() }, payload));
    fetch(base + '/e', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
      .then((r) => r.json()).then((d) => log('TG', 'доставка → ' + (d && d.ok ? 'ok' : 'fail')))
      .catch((e) => log('TG', 'доставка ошибка: ' + (e && e.message || e)));
  }

  // ───── ВОРОТА: «1 Telegram-код = 1 активный скрипт» ─────
  function getSid() {
    let s = ''; try { s = localStorage.getItem('fuelTgSid') || ''; } catch (e) {}
    if (!s) { s = (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 16);
      try { localStorage.setItem('fuelTgSid', s); } catch (e) {} }
    return s;
  }
  function verLt(a, b) {   // a старее b?
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x < y) return true; if (x > y) return false;
    }
    return false;
  }
  async function tgPost(path, payload) {
    const base = await relayBase();
    if (!base) return { ok: false, reason: 'offline' };
    try {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
      return await r.json();
    } catch (e) { return { ok: false, reason: 'offline' }; }
  }
  function tgClaimReq(token, sid) { return tgPost('/claim', { tg: token, sid }); }
  function tgHeartbeatReq(token, sid) { return tgPost('/heartbeat', { tg: token, sid }); }
  function tgNotify(payload) {   // отбивка в бота (старт / номер / смена номера); fire-and-forget
    const tg = getTgToken(); if (!tg) return;
    tgPost('/notify', Object.assign({ tg }, payload));
  }
  // ───── ЛОГ → наш сервер (раскладка по дням), с вычисткой локального буфера ─────
  let logFlushing = false;
  async function relayLog() {
    const tg = getTgToken(); if (!tg || logFlushing) return;
    let snap = ''; try { snap = localStorage.getItem(LOG_KEY) || ''; } catch (e) {}
    if (!snap) return;
    logFlushing = true;
    const res = await tgPost('/log', { tg, log: snap });
    logFlushing = false;
    if (res && res.ok) {   // отправленное вырезаем — на устройстве лог не копится
      try { const cur = localStorage.getItem(LOG_KEY) || ''; localStorage.setItem(LOG_KEY, cur.slice(snap.length)); } catch (e) {}
    }
  }
  setInterval(() => { relayLog(); }, 60000);   // периодический сброс лога на сервер
  function tgRelease() {
    const tg = getTgToken(); if (!tg) return;
    const sid = getSid();
    relayBase().then((base) => {
      if (!base) return;
      const body = JSON.stringify({ tg, sid });
      try {
        if (navigator.sendBeacon) navigator.sendBeacon(base + '/release', body);
        else fetch(base + '/release', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true });
      } catch (e) {}
    });
  }
  // блокирующее окно ввода кода
  function tgGateUI(message, preset) {
    return new Promise((resolve) => {
      injectStyles();
      const old = document.getElementById('fuelGate'); if (old) old.remove();
      const wrap = document.createElement('div'); wrap.id = 'fuelGate'; wrap.className = 'fq-ov center'; wrap.style.zIndex = '100040';
      const card = document.createElement('div'); card.className = 'fq-card';
      card.innerHTML = '<div class="fq-h">✈️ Код привязки к боту «Заправыч»</div>' +
        '<div class="fq-sub" style="margin:8px 0 12px">' + escHtml(message) + '</div>';
      const input = document.createElement('input');
      input.value = preset || ''; input.placeholder = 'код из бота';
      input.autocapitalize = 'off'; input.autocomplete = 'off'; input.spellcheck = false;
      input.style.cssText = 'width:100%;padding:13px;font-size:18px;border:1px solid #cbd5e8;border-radius:12px;text-align:center;letter-spacing:2px;box-sizing:border-box';
      const btn = document.createElement('button'); btn.className = 'fq-btn ok'; btn.textContent = 'Подключить'; btn.style.cssText = 'margin-top:12px;width:100%';
      btn.onclick = () => { const v = (input.value || '').replace(/[^a-zA-Z0-9]/g, ''); if (!v) { input.focus(); return; } wrap.remove(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      card.appendChild(input); card.appendChild(btn);
      wrap.appendChild(card); document.body.appendChild(wrap);
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
    });
  }
  // вернуть валидный, занятый ЗА НАМИ код (блокирует, пока не получится)
  async function tgEnsureClaim() {
    const sid = getSid();
    let entered = false;   // код введён руками в этот заход → шлём «✅ Код привязан»
    for (;;) {
      let token = getTgToken();
      if (!token) { token = await tgGateUI('Введи код привязки из бота «Заправыч» (/start → скопируй код).'); setTgToken(token); entered = true; }
      setBadge('✈️ проверяю код привязки…');
      const res = await tgClaimReq(token, sid);
      if (res && res.ok) { log('TG', 'код подтверждён, владение получено'); if (entered) tgNotify({ kind: 'bind' }); return { token, sid, latest: res.latest, update_url: res.update_url }; }
      const reason = (res && res.reason) || 'offline';
      if (reason === 'unknown') { setTgToken(''); const t = await tgGateUI('❌ Код не найден. Открой бота «Заправыч» → /start, скопируй СВОЙ код и введи снова.'); setTgToken(t); entered = true; continue; }
      if (reason === 'suspended') { setBadge('🚫 доступ приостановлен'); const t = await tgGateUI('🚫 Доступ приостановлен. Обратись к тому, кто выдал тебе код. После возобновления нажми «Подключить».', token); setTgToken(t); continue; }
      if (reason === 'busy') { const t = await tgGateUI('⛔ Этот код уже работает в ДРУГОМ браузере. Один Telegram — один скрипт. Закрой тот браузер или введи другой код.', ''); setTgToken(t); entered = true; continue; }
      await tgGateUI('⚠️ Нет связи с сервером привязки. Проверь интернет и нажми «Подключить» ещё раз.', token); continue;
    }
  }
  // heartbeat: держим владение; если код перехватили — стоп до повторной привязки
  let tgHbRunning = false;
  function startHeartbeat(sid) {
    if (tgHbRunning) return; tgHbRunning = true;
    (async function loop() {
      for (;;) {
        await new Promise((r) => setTimeout(r, 15000));
        const token = getTgToken(); if (!token) continue;
        const res = await tgHeartbeatReq(token, sid);
        if (res && res.ok === false && (res.reason === 'busy' || res.reason === 'unknown' || res.reason === 'suspended')) {
          log('TG', 'heartbeat ' + res.reason + ' — стоп');
          STATE.running = false; STATE.paused = true; grabGen++; clearTimeout(STATE.timer); STATE.busy = false;
          if (res.reason === 'unknown') { setTgToken(''); setBadge('⛔ код недействителен — введи новый'); }
          else if (res.reason === 'suspended') setBadge('🚫 доступ приостановлен');
          else setBadge('⛔ код перехвачен другим браузером');
          await tgEnsureClaim();   // покажет окно: «не найден»/«занят» → ввод кода
          STATE.paused = false;
          if (STATE.plate && STATE.fuels.length) begin();
        }
      }
    })();
  }

  function normalizePlate(v) {
    let s = String(v || '').trim().toUpperCase(), out = '';
    for (const ch of s) { const i = PLATE_LATIN.indexOf(ch); out += i >= 0 ? PLATE_CYR[i] : ch; }
    return out.replace(/[^0-9A-ZА-ЯЁ]/g, '');
  }
  // маска госномера РФ: буква · 3 цифры · 2 буквы · 2–3 цифры региона (латиница→кириллица, строго по позициям)
  function maskPlate(v) {
    let out = '';
    for (let ch of String(v || '').toUpperCase()) {
      const li = PLATE_LATIN.indexOf(ch); if (li >= 0) ch = PLATE_CYR[li];
      const pos = out.length;
      const isLetter = PLATE_CYR.indexOf(ch) >= 0;
      const isDigit = ch >= '0' && ch <= '9';
      if (pos === 0) { if (isLetter) out += ch; }          // буква
      else if (pos <= 3) { if (isDigit) out += ch; }        // 3 цифры
      else if (pos <= 5) { if (isLetter) out += ch; }       // 2 буквы
      else if (pos <= 8) { if (isDigit) out += ch; }        // 2–3 цифры региона
      if (out.length >= 9) break;
    }
    return out;
  }

  // ───── MAX WebApp / контакт / тихая реавторизация ─────
  function getWebApp() {
    try { if (window.WebApp) return window.WebApp; } catch (e) {}
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.WebApp) return unsafeWindow.WebApp; } catch (e) {}
    return null;
  }
  let maxScriptPromise = null;
  function loadMaxScript() {
    if (getWebApp()) return Promise.resolve(true);
    if (maxScriptPromise) return maxScriptPromise;
    maxScriptPromise = new Promise((resolve) => {
      const t0 = Date.now();
      const finish = (ok) => { const got = !!getWebApp(); if (!ok && !got) maxScriptPromise = null; resolve(got || ok); };
      if (document.querySelector('script[src*="max-web-app.js"]')) {
        const poll = () => getWebApp() ? finish(true) : (Date.now() - t0 > 10000 ? finish(false) : setTimeout(poll, 200));
        poll(); return;
      }
      let script; try { script = document.createElement('script'); } catch (e) { return finish(false); }
      const timer = setTimeout(() => finish(false), 10000);
      script.src = 'https://st.max.ru/js/max-web-app.js';
      script.async = true;
      script.onload = () => { clearTimeout(timer); finish(true); };
      script.onerror = () => { clearTimeout(timer); finish(false); };
      (document.head || document.documentElement).appendChild(script);
      log('SESSION', 'подгружаю MAX SDK (st.max.ru/js/max-web-app.js)');
    });
    return maxScriptPromise;
  }
  function clientId() { try { return localStorage.getItem('fuelQrClientId') || ''; } catch (e) { return ''; } }
  function loadContact() { try { return JSON.parse(localStorage.getItem(CONTACT_KEY) || 'null'); } catch (e) { return null; } }
  function saveContact(c) { try { localStorage.setItem(CONTACT_KEY, JSON.stringify(c)); } catch (e) {} }
  async function waitWebApp(ms) { const t0 = Date.now(); while (!getWebApp() && Date.now() - t0 < ms) await sleep(200); return getWebApp(); }

  function installContactSniffer() {
    const w = getWebApp();
    if (!w || w.__fuelSniffed || typeof w.requestContact !== 'function') return;
    const orig = w.requestContact.bind(w);
    w.requestContact = function () {
      return Promise.resolve(orig()).then((r) => {
        const c = (r && r.contact) ? r.contact : r;
        if (c && c.phone) { saveContact(c); log('SESSION', 'контакт пойман и сохранён'); }
        return r;
      });
    };
    w.__fuelSniffed = true;
  }
  async function requestFreshContact() {
    await loadMaxScript();
    const w = getWebApp();
    if (!w || typeof w.requestContact !== 'function') throw new Error('MAX WebApp недоступен');
    const r = await w.requestContact();
    const c = (r && r.contact) ? r.contact : r;
    if (!c || !c.phone) throw new Error('контакт не получен');
    saveContact(c); return c;
  }
  let reauthInflight = null;
  function silentReauth(force) {
    if (reauthInflight && !force) return reauthInflight;
    reauthInflight = (async () => {
      await loadMaxScript();
      const w = getWebApp(); const c = loadContact();
      if (!w || !w.initData || !c) return false;
      try {
        const d = await api('/session/max', { method: 'POST', body: JSON.stringify({
          client_id: clientId(), init_data: w.initData, contact: c, platform: w.platform, version: w.version }) }, CONFIG.reauthTimeoutMs);
        everAuthed = true; sessionDead = false;
        log('SESSION', 'тихая реавторизация ok, ttl ' + (d && d.ttl));
        return true;
      } catch (e) { log('SESSION', 'тихая реавторизация НЕ удалась: ' + (e.message || e)); return false; }
    })();
    const p = reauthInflight;
    p.finally(() => { if (reauthInflight === p) reauthInflight = null; });
    return p;
  }

  // Матч по code (a95_plus/a95/a92). В /create уходит числовой type.id.
  function matchFuel(type, pref) {
    const p = String(pref).toLowerCase();
    if (String(type.code || '').toLowerCase() === p) return true;
    if (String(type.id   || '').toLowerCase() === p) return true;
    const t = String(type.title || '').toUpperCase().replace(/\s+/g, '');
    const P = p.toUpperCase().replace(/\s+/g, '');
    const i = t.indexOf(P);
    if (i < 0) return false;
    if (P.endsWith('+')) return true;
    return t.charAt(i + P.length) !== '+';
  }
  function pickStockFuel(types) {
    for (const pref of STATE.fuels) { const f = (types || []).find((x) => matchFuel(x, pref)); if (f) return f; }
    return null;
  }

  async function api(path, options = {}, timeoutMs) {
    const method = options.method || 'GET';
    const t0 = Date.now();
    log('REQ', method + ' ' + path);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || CONFIG.createTimeoutMs);
    const p = Object.assign({}, options);
    p.headers = Object.assign({ 'Content-Type': 'application/json' }, p.headers || {});
    p.credentials = 'same-origin';
    p.signal = ctrl.signal;
    let responded = false;
    try {
      const res = await fetch(API + path, p);
      let json; try { json = await res.json(); } catch { json = { status: 'fail', message: 'некорректный ответ сервера' }; }
      responded = true;
      log('RES', method + ' ' + path + ' → ' + res.status + ' (' + (Date.now() - t0) + 'мс): ' + JSON.stringify(json));
      if (res.status === 401 || (res.status === 403 && json.message && json.message.indexOf('Сесси') >= 0)) {
        const e = new Error(json.message || 'сессия истекла'); e.sessionExpired = true; throw e;
      }
      if (!res.ok || json.status !== 'ok') throw new Error(json.message || ('ошибка сервера (' + res.status + ')'));
      return json.data || {};
    } catch (e) {
      if (!responded) log('ERR', method + ' ' + path + ' (' + (Date.now() - t0) + 'мс): ' + (e.name === 'AbortError' ? 'ТАЙМАУТ' : String(e.message || e)));
      throw e;
    } finally { clearTimeout(to); }
  }
  function serverPollMs(data) { const v = data && data.wait && Number(data.wait.poll_after_ms); return (isFinite(v) && v > 0) ? v : 0; }

  // ───── кулдаун/блок + время раздачи ─────
  function parseServerDate(s) {
    if (!s) return null;
    let t = String(s).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    const d = new Date(t); return isNaN(d.getTime()) ? null : d;
  }
  function isFutureDate(s) { const d = parseServerDate(s); return !!(d && d.getTime() > Date.now()); }
  // местная дата ГГГГ-ММ-ДД (для отличия «сегодня вечером» от настоящего недельного кулдауна)
  function todayLocalISO() { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); }
  // дата next_create_at — это БУДУЩИЙ ДЕНЬ (а не «сегодня 22:00»). Будущий день = настоящий недельный кулдаун → дроп.
  function isFutureDay(s) { const d = String(s || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > todayLocalISO(); }
  // дневной лимит «не более N QR-кода в день» — НЕ кулдаун: к следующей раздаче сбросится, номер не дропаем
  function isDailyLimit(chk) {
    const r = String((chk && chk.block_reason) || '').toLowerCase();
    if (/daily|per_day|in_day/.test(r)) return true;
    return /в\s*день|в\s*сутки|за\s*сутки/i.test(String((chk && chk.message) || ''));
  }
  function cooldownFromCheck(chk) {
    if (!chk) return null;
    if (chk.state === 'active' || chk.state === 'active_own') return null;
    if (chk.block_reason === 'registration_not_open' || chk.registration_state === 'not_open') return null;
    if (chk.can_create === false && isFutureDate(chk.next_create_at)) return { until: chk.next_create_at };
    return null;
  }
  function parseDropTime(msg) {
    if (!msg) return null;
    const m = /после\s+(\d{1,2})[:.](\d{2})/i.exec(String(msg));
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function nearDrop() {
    if (STATE.dropTime == null) return false;
    const n = new Date(), cur = n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds(), tgt = STATE.dropTime * 60;
    return tgt - cur <= CONFIG.prearmSec && tgt - cur > -120;
  }
  function dropTimeBadge() {
    if (STATE.dropTime == null) return '';
    const hh = String(Math.floor(STATE.dropTime / 60)).padStart(2, '0'), mm = String(STATE.dropTime % 60).padStart(2, '0');
    const n = new Date(), diff = STATE.dropTime - (n.getHours() * 60 + n.getMinutes());
    const rel = diff > 0 ? ' (через ' + diff + 'м)' : (diff > -3 ? ' (вот-вот)' : '');
    return ' · 🎯 ' + hh + ':' + mm + rel;
  }
  function inHotWindow() {
    const now = new Date(), cur = now.getHours() * 60 + now.getMinutes();
    const [fh, fm] = CONFIG.hotFrom.split(':').map(Number);
    const [th, tm] = CONFIG.hotTo.split(':').map(Number);
    return cur >= fh * 60 + fm && cur <= th * 60 + tm;
  }
  function schedule(ms) { clearTimeout(STATE.timer); STATE.timer = setTimeout(tick, ms); }

  // ───── проактивная тихая реавторизация ─────
  async function reauthLoop() {
    if (STATE.grabbed) return;
    if (manualReauth) { setTimeout(reauthLoop, 4000); return; }
    const ok = await silentReauth();
    if (!ok) {
      const w = getWebApp();
      if (!w || typeof w.requestContact !== 'function') sessionAlarm('окно MAX не подключено — ПЕРЕОТКРОЙ миниапп из БОТА MAX (не F5)');
      else if (!loadContact()) sessionAlarm('нет привязанного номера');
      else if (everAuthed || inHotWindow()) sessionAlarm('контакт устарел');
    }
    setTimeout(reauthLoop, ok && inHotWindow() ? CONFIG.reauthHotMs : (ok ? CONFIG.reauthIdleMs : 8000));
  }
  let alarmShown = false;
  function sessionAlarm(reason) {
    setBadge('🔑 сессия: ' + reason + ' — жми «📱 номер» вверху и поделись');
    if (alarmShown) return;
    alarmShown = true;
    if (inHotWindow()) { beep(); setTimeout(beep, 600); }
    document.title = '🔑 ПРИВЯЖИ НОМЕР';
  }
  async function ensureSession() {
    setBadge('🔑 проверяю сессию…');
    if (await silentReauth()) return true;
    setBadge('🔑 поделись номером в окне MAX (один раз) — для авто-реавторизации');
    try { await requestFreshContact(); } catch (e) { log('SESSION', 'requestContact: ' + (e.message || e)); }
    if (await silentReauth()) return true;
    sessionAlarm('не привязан номер');
    return false;
  }

  // ───── опрос топлива ─────
  async function tick() {
    if (STATE.grabbed || STATE.dropped || STATE.busy || sessionDead || !STATE.running) return;
    try {
      const data = await api('/fuel-types', { method: 'GET', headers: {} }, CONFIG.pollTimeoutMs);
      everAuthed = true;
      const types = data.fuel_types || [];
      const srv = serverPollMs(data);
      if (!types.length) {
        const dt = parseDropTime(data.wait && data.wait.message);
        if (dt != null) STATE.dropTime = dt;
        setBadge('⏳ жду топливо…' + dropTimeBadge() + (srv ? ' (сервер ' + srv + 'мс)' : ''));
        let delay = inHotWindow() ? jitterPoll(CONFIG.pollFastMs) : Math.max(srv, CONFIG.pollIdleMs);
        if (nearDrop()) {
          delay = Math.min(delay || 1000, jitterPoll(700));
          if (!STATE.prearmHandled) { STATE.prearmHandled = true; silentReauth(true); log('SESSION', 'pre-arm: до раздачи <' + CONFIG.prearmSec + 'с — частый опрос + свежая реавторизация'); }
        } else STATE.prearmHandled = false;
        schedule(delay);
        return;
      }
      log('STOCK', 'доступно: ' + types.map((t) => t.title + ' (' + t.code + ' #' + t.id + ')').join(', '));
      const f = pickStockFuel(types);
      if (!f) { setBadge('⛽ есть топливо, но не наше — жду нужное…'); schedule(jitterPoll(CONFIG.pollFastMs)); return; }
      setBadge('🔥 ' + (f.title || f.code) + ' появилось — беру…');
      await grab(types);
    } catch (e) {
      if (e.sessionExpired) { await silentReauth(); schedule(600); return; }
      setBadge('⚠️ ' + e.message + ' (сервер лагает, притормаживаю)');
      schedule(inHotWindow() ? CONFIG.pollFastMs * 2.5 : CONFIG.pollIdleMs);
    }
  }

  // классификация ответа /plate/check. Возвращает true, если номер «закрыт» (взят или недоступен).
  function handleCheck(chk) {
    if ((chk.state === 'active' || chk.state === 'active_own') && chk.ticket) { markGrabbed(chk.ticket, null, true); return true; }
    if (chk.block_reason === 'registration_not_open' || chk.registration_state === 'not_open') return false; // раздача не идёт — нормально, ждём
    // ДНЕВНОЙ ЛИМИТ («не более 1 QR в день») — НЕ дроп: сегодня код уже взял, но к СЛЕДУЮЩЕЙ раздаче сбросится.
    // Продолжаем спокойно следить (без модалки и без репорта) — иначе скрипт бросил бы номер и не попытался вечером.
    if (chk.state === 'blocked' && isDailyLimit(chk)) {
      setBadge('☑️ сегодня код уже брал — жду следующую раздачу (лимит сбросится)');
      return false;   // статус «ожидаем» уже выставлен в begin() — не дропаем, продолжаем следить
    }
    if (chk.state === 'blocked' && chk.block_reason) {
      STATE.dropped = true;
      setBadge('⛔ недоступен: ' + (chk.message || chk.block_reason));
      infoDialog('⛔ Номер недоступен сегодня', escHtml(chk.message || chk.block_reason));
      return true;
    }
    const cd = cooldownFromCheck(chk);
    if (cd) {
      if (!isFutureDay(cd.until)) {
        // next_create_at = СЕГОДНЯ (раздача ещё не открылась) — номер ЧИСТ, кода нет, просто ждём открытия.
        setBadge('⏳ жду раздачу (откроется сегодня) — номер свободен');
        return false;   // статус «ожидаем» уже в begin()
      }
      STATE.dropped = true;          // настоящий недельный кулдаун (будущий ДЕНЬ) — дроп, статус не трогаем
      setBadge('⏳ кулдаун до ' + cd.until);
      infoDialog('⏳ Номер на кулдауне', 'Следующий код по этому номеру будет доступен с <b>' + escHtml(cd.until) + '</b>.<br><br>Можешь сменить номер кнопкой «🚗 номер» вверху.');
      return true;
    }
    return false; // can_create — долбим
  }

  // ───── ГРЭБ (средний профиль: 3 воркера, человеческие паузы+джиттер) ─────
  async function grab(initialTypes) {
    if (STATE.grabbed || STATE.dropped || STATE.busy) return;
    STATE.busy = true;
    const myGen = ++grabGen;
    const deadline = Date.now() + CONFIG.grabMaxMs;
    let latestTypes = initialTypes || [];
    let emptyStreak = 0, attempt = 0;

    log('GRAB', 'беру ' + STATE.plate + ' [' + prettyPref(STATE.fuels) + '] — воркеров ' + CONFIG.workers);

    // guard НЕ блокирует грэб: /create уходит немедленно (T+0), а /plate/check крутится ПАРАЛЛЕЛЬНО
    // (короткий таймаут, пара попыток) — ловит «код уже есть»/кулдаун/блок и гасит воркеров.
    // Прошлая версия блокировала старт на 9с (ведущий plate/check) — стрелять надо в первые секунды, до пика шторма.
    (async function guard() {
      for (let i = 0; i < 4 && myGen === grabGen && !STATE.grabbed && !STATE.dropped && Date.now() < deadline; i++) {
        try {
          const chk = await api('/plate/check', { method: 'POST', body: JSON.stringify({ car_plate: STATE.plate, plate_format_confirmed: STATE.confirmed }) }, CONFIG.checkTimeoutMs);
          if (handleCheck(chk) && STATE.grabbed) finalOverlay();
          return; // получили внятный ответ — дальше дело воркеров (или уже закрыли номер)
        } catch (e) { if (e.sessionExpired) await silentReauth(); else await sleep(jitter(CONFIG.retryDelayMs)); }
      }
    })();

    // фоновый рефрешер остатков
    (async function refresher() {
      while (myGen === grabGen && !STATE.grabbed && !STATE.dropped && !STATE.paused && Date.now() < deadline) {
        await sleep(jitter(CONFIG.stockRefreshMs));
        try {
          const d = await api('/fuel-types', { method: 'GET', headers: {} }, CONFIG.pollTimeoutMs);
          latestTypes = d.fuel_types || [];
          if (!latestTypes.length) { if (++emptyStreak >= 5) return; } else emptyStreak = 0;
        } catch (e) { if (e.sessionExpired) await silentReauth(); }
      }
    })();

    // воркер(ы): спокойно пробуем /create по нужному топливу (по умолчанию 1 — без параллельных залпов)
    async function worker() {
      while (myGen === grabGen && !STATE.grabbed && !STATE.dropped && Date.now() < deadline) {
        const f = pickStockFuel(latestTypes);
        if (!f) {                       // нашего топлива сейчас в стоке нет
          if (!latestTypes.length && emptyStreak >= 5) break;   // топливо кончилось совсем — выходим
          await sleep(jitter(CONFIG.retryDelayMs));
          continue;
        }
        attempt++;
        try {
          const cr = await api('/create', { method: 'POST', body: JSON.stringify({ car_plate: STATE.plate, fuel_type_id: f.id, plate_format_confirmed: STATE.confirmed }) }, CONFIG.createHotMs);
          markGrabbed(cr.ticket || cr, f, (cr.ticket || cr).reused);
          return;
        } catch (e) {
          if (e.sessionExpired) {
            setBadge('🔑 401 — тихо реавторизуюсь и долблю дальше…');
            const ok = await silentReauth();
            if (!ok) { sessionAlarm('реавторизация не прошла'); await sleep(jitter(CONFIG.retryDelayMs)); }
            continue;
          }
          setBadge('⚠️ ' + (f.title || f.code) + ': ' + e.message + ' — долблю…');
          await sleep(jitter(CONFIG.retryDelayMs));
        }
      }
    }
    const pool = [];
    for (let i = 0; i < CONFIG.workers; i++) pool.push(worker());
    await Promise.all(pool);

    STATE.busy = false;
    if (STATE.grabbed) { finalOverlay(); return; }
    if (!STATE.dropped && myGen === grabGen && !sessionDead && !STATE.paused) {
      log('GRAB', 'заход окончен, попыток ' + attempt + ' — топливо разобрали или кончилось; продолжаю следить');
      if (attempt > 0) reportFail('не успел (' + attempt + ' попыток) — разобрали');   // реально стреляли, но не взяли → «облом»
      schedule(CONFIG.pollFastMs);
    }
  }

  function markGrabbed(ticket, fuel, reused) {
    if (STATE.grabbed) return;
    STATE.grabbed = true; STATE.ticket = ticket;
    log('SUCCESS', STATE.plate + ' | ' + JSON.stringify({ fuel: ticket && ticket.fuel_type_title, deeplink: ticket && ticket.deeplink, reused: !!reused }));
    beep();
    document.title = '✅ QR ГОТОВ';
    setBadge('✅ QR получен: ' + ((ticket && ticket.fuel_type_title) || (fuel && (fuel.title || fuel.code)) || ''));
    reportSuccess(ticket, fuel);   // статус «успех» + узнаём next_create_at (когда снова можно)
  }

  // ───── индикатор / сигнал / оверлеи ─────
  let badge;
  function setBadge(text) {
    log('UI', text);
    if (!badge) { badge = document.createElement('div'); badge.className = 'fq-badge'; document.body.appendChild(badge); }
    badge.textContent = text;
  }
  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < 3; i++) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.connect(g); g.connect(ac.destination);
        o.frequency.value = 880; o.type = 'square'; g.gain.value = 0.15;
        o.start(ac.currentTime + i * 0.25); o.stop(ac.currentTime + i * 0.25 + 0.18);
      }
    } catch (e) {}
  }
  function infoDialog(title, text) {
    injectStyles();
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'fq-ov center'; wrap.style.zIndex = '100030';
      const card = document.createElement('div'); card.className = 'fq-card'; card.style.maxWidth = '380px';
      card.innerHTML = '<div class="fq-h" style="margin-bottom:10px">' + title + '</div>' +
        '<div class="fq-sub" style="margin-bottom:16px">' + (text || '') + '</div>';
      const ok = document.createElement('button');
      ok.textContent = 'OK'; ok.className = 'fq-btn ok'; ok.style.width = '100%';
      ok.onclick = () => { wrap.remove(); resolve(); };
      card.appendChild(ok); wrap.appendChild(card); document.body.appendChild(wrap);
    });
  }
  function finalOverlay(force) {
    if (!force && !STATE.grabbed) return;
    injectStyles();
    const old = document.getElementById('fuelFinal'); if (old) old.remove();
    if (!STATE.grabbed) { infoDialog('Кода ещё нет', 'Как только поймаю QR — он появится здесь, я пикну и сменю заголовок вкладки на «✅ QR ГОТОВ».'); return; }
    const tk = STATE.ticket || {};
    const w = document.createElement('div');
    w.id = 'fuelFinal'; w.className = 'fq-ov center'; w.style.zIndex = '100025';
    const qr = tk.qr_png_base64 ? '<img alt="QR" src="data:image/png;base64,' + tk.qr_png_base64 + '">' : '';
    const link = tk.deeplink ? '<a href="' + escHtml(tk.deeplink) + '" target="_blank" rel="noopener" class="fq-btn ok" style="display:inline-block;margin-top:12px;text-decoration:none">🔗 Открыть QR</a>' : '';
    w.innerHTML = '<div class="fq-h" style="color:#fff;font-size:22px">✅ QR-код готов</div>' +
      '<div class="fq-qr">' + plateHTML(STATE.plate) +
      '<div style="color:#1a1f2e;font:700 15px system-ui,sans-serif;margin-top:8px">' + escHtml(tk.fuel_type_title || '') + (tk.reused ? ' · был ранее' : '') + '</div>' +
      qr + link + '</div>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'fq-btn ghost'; closeBtn.textContent = 'Закрыть';
    closeBtn.onclick = () => w.remove();
    w.appendChild(closeBtn);
    document.body.appendChild(w);
  }

  // ───── верхние кнопки ─────
  function addTopButtons() {
    const tools = document.createElement('div'); tools.className = 'fq-tools'; document.body.appendChild(tools);

    const rebind = document.createElement('button');
    rebind.textContent = '📱 номер'; rebind.title = 'Поделиться номером телефона в MAX (реавторизация)'; rebind.className = 'fq-tool';
    rebind.onclick = async () => {
      if (manualReauth) return;
      manualReauth = true;
      try {
        setBadge('🔑 подгружаю мост MAX…');
        await loadMaxScript();
        const w = getWebApp();
        if (!w || typeof w.requestContact !== 'function') {
          await infoDialog('⚠️ Окно MAX не найдено', 'Миниапп не видит мост MAX. Закрой миниапп и открой заново из бота MAX, потом снова жми «📱 номер».');
          return;
        }
        setBadge('🔑 открываю окно MAX — поделись номером…');
        await requestFreshContact();
        const ok = await silentReauth(true);
        alarmShown = false; document.title = '';
        await infoDialog(ok ? '✅ Номер привязан' : '⚠️ Реавторизация не прошла',
          ok ? 'Сессия жива — скрипт продолжает работу.' : 'Номер получен, но сервер не принял сессию. Подожди минуту и нажми «📱 номер» ещё раз.');
        if (ok && STATE.running && !STATE.grabbed && !STATE.dropped) schedule(300);
      } catch (e) {
        await infoDialog('⚠️ Не вышло', escHtml(String(e.message || e)) + '<br><br>Если окно «поделиться номером» не появилось — закрой и открой миниапп заново из бота MAX.');
      } finally { manualReauth = false; }
    };

    const codeBtn = document.createElement('button');
    codeBtn.textContent = '🎫 код'; codeBtn.className = 'fq-tool'; codeBtn.onclick = () => finalOverlay(true);

    const editBtn = document.createElement('button');
    editBtn.textContent = '🚗 номер'; editBtn.title = 'Сменить номер авто / топливо'; editBtn.className = 'fq-tool'; editBtn.onclick = openSetup;

    const tgBtn = document.createElement('button');
    const tgLabel = () => getTgToken() ? '✈️ TG ✓' : '✈️ Telegram';
    tgBtn.textContent = tgLabel(); tgBtn.title = 'Привязать Telegram-бота «Заправыч» (QR придёт в чат)'; tgBtn.className = 'fq-tool';
    tgBtn.onclick = async () => {
      const t = await tgGateUI('Введи новый код привязки из бота «Заправыч».', getTgToken());
      setTgToken(t); _relayBase = '';
      const res = await tgClaimReq(t, getSid());
      tgBtn.textContent = tgLabel();
      if (res && res.ok) { tgNotify({ kind: 'bind' }); await infoDialog('✈️ Telegram привязан', 'Код подтверждён — QR будет приходить тебе в бота.'); }
      else if (res && res.reason === 'unknown') await infoDialog('❌ Код не найден', 'Проверь код в боте «Заправыч» (/start).');
      else if (res && res.reason === 'suspended') await infoDialog('🚫 Доступ приостановлен', 'Обратись к тому, кто выдал тебе код.');
      else if (res && res.reason === 'busy') await infoDialog('⛔ Код занят', 'Этот код уже работает в другом браузере.');
      else await infoDialog('⚠️ Нет связи', 'Не удалось проверить код — попробуй позже.');
    };

    tools.appendChild(rebind); tools.appendChild(codeBtn); tools.appendChild(editBtn); tools.appendChild(tgBtn);
  }

  // ───── НАСТРОЙКА: ввод номера ПРЯМО в панели + выбор топлива ─────
  const FUEL_CHOICES = [
    { code: 'a95_plus', label: 'АИ-95+' },
    { code: 'a95',      label: 'АИ-95'  },
    { code: 'a92',      label: 'АИ-92'  },
    { code: 'a100',     label: 'АИ-100' },
    { code: 'dt',       label: 'ДТ'     },
    { code: 'dt_plus',  label: 'ДТ+'    },
  ];
  function setupUI() {
    return new Promise((resolve) => {
      injectStyles();
      const savedPlate = (() => { try { return localStorage.getItem(PLATE_KEY) || STATE.plate || ''; } catch (e) { return STATE.plate || ''; } })();
      const savedFuels = STATE.fuels.length ? STATE.fuels.slice()
        : (() => { try { return (localStorage.getItem(FUELS_KEY) || '').split(',').filter(Boolean); } catch (e) { return []; } })();
      const order = savedFuels.slice();

      const wrap = document.createElement('div');
      wrap.className = 'fq-ov center'; wrap.style.zIndex = '100030';
      const card = document.createElement('div'); card.className = 'fq-card';

      const title = document.createElement('div');
      title.className = 'fq-h'; title.style.marginBottom = '4px'; title.textContent = '🚗 Один QR — настройка';

      const hint = document.createElement('div');
      hint.className = 'fq-sub'; hint.style.margin = '0 0 12px';
      hint.textContent = 'Введи госномер (можно латиницей — переведу) и выбери топливо.';

      const input = document.createElement('input');
      input.className = 'fq-input'; input.placeholder = 'А123ВС777';
      input.value = maskPlate(savedPlate); input.maxLength = 9;
      input.autocapitalize = 'characters'; input.autocomplete = 'off'; input.spellcheck = false;

      const preview = document.createElement('div');
      preview.style.cssText = 'text-align:center;margin:12px 0 4px;min-height:40px';

      const fuelLbl = document.createElement('div');
      fuelLbl.className = 'fq-sub'; fuelLbl.style.cssText = 'margin:10px 0 8px;font-weight:700;color:#1a1f2e';
      fuelLbl.textContent = 'Топливо по приоритету (жми по очереди):';

      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:9px;justify-content:center';
      const chipMap = {};
      FUEL_CHOICES.forEach((f) => {
        const b = document.createElement('button'); b.className = 'fq-chip';
        b.onclick = () => { const i = order.indexOf(f.code); if (i >= 0) order.splice(i, 1); else order.push(f.code); render(); };
        chipMap[f.code] = b; chips.appendChild(b);
      });

      const ordLine = document.createElement('div');
      ordLine.className = 'fq-ord'; ordLine.style.margin = '12px 0 4px';

      const acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:9px;justify-content:center;margin-top:14px';
      const go = document.createElement('button'); go.className = 'fq-btn ok';
      go.onclick = () => {
        const plate = normalizePlate(input.value);
        if (!plate || !order.length) return;
        try { localStorage.setItem(PLATE_KEY, plate); localStorage.setItem(FUELS_KEY, order.join(',')); } catch (e) {}
        wrap.remove();
        resolve({ plate, fuels: order.slice() });
      };
      const cancel = document.createElement('button'); cancel.className = 'fq-btn ghost'; cancel.textContent = '↩︎ Отмена';
      cancel.title = 'Закрыть без изменений';
      cancel.onclick = () => { wrap.remove(); resolve(null); };
      acts.appendChild(go); acts.appendChild(cancel);

      input.addEventListener('input', () => {
        const masked = maskPlate(input.value);
        if (input.value !== masked) {
          input.value = masked;
          try { input.setSelectionRange(masked.length, masked.length); } catch (e) {}
        }
        render();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });

      function render() {
        const plate = normalizePlate(input.value);
        preview.innerHTML = plate ? plateHTML(plate) : '<span class="fq-sub">— превью плашки —</span>';
        FUEL_CHOICES.forEach((f) => {
          const pos = order.indexOf(f.code), b = chipMap[f.code];
          b.className = 'fq-chip' + (pos >= 0 ? ' on' : '');
          b.textContent = (pos >= 0 ? (pos + 1) + '. ' : '') + f.label;
        });
        ordLine.textContent = order.length ? 'Порядок: ' + prettyPref(order) : 'топливо не выбрано';
        const okPlate = !!plate, okFuel = order.length > 0;
        go.disabled = !(okPlate && okFuel);
        go.textContent = '🚀 Старт';
      }

      card.appendChild(title); card.appendChild(hint); card.appendChild(input);
      card.appendChild(preview); card.appendChild(fuelLbl); card.appendChild(chips);
      card.appendChild(ordLine); card.appendChild(acts);
      wrap.appendChild(card); document.body.appendChild(wrap);
      render();
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
    });
  }

  // стартовая проверка номера (1× /plate/check): закрыть если код уже есть / поймать блок-кулдаун заранее
  async function initialCheck() {
    if (STATE.grabbed || STATE.dropped) return;
    try {
      const chk = await api('/plate/check', { method: 'POST', body: JSON.stringify({ car_plate: STATE.plate, plate_format_confirmed: STATE.confirmed }) }, CONFIG.checkTimeoutMs);
      handleCheck(chk);
    } catch (e) { if (e.sessionExpired) await silentReauth(); }
    if (STATE.grabbed) finalOverlay();
  }

  function plateShort() { return STATE.plate.slice(0, 8); }

  // применить цель и начать слежение
  async function begin() {
    if (!STATE.plate || !STATE.fuels.length) { setBadge('⛔ номер/топливо не заданы — жми «🚗 номер»'); return; }
    setBadge('▶️ ' + plateShort() + ' · ' + prettyPref(STATE.fuels) + (sessionUp ? ' — слежу за топливом раз в сек' : ' — поднимаю сессию…'));
    if (sessionUp) await initialCheck();
    if (STATE.grabbed) { finalOverlay(); return; }
    if (STATE.dropped) return;
    STATE.running = true;
    reportWait();   // номер запущен и взят в работу → статус «⏳ ожидаем» в «Машинах» (раз на заход)
    setBadge('▶️ активен · ' + plateShort() + ' · ' + prettyPref(STATE.fuels) + ' — опрос раз в сек');
    schedule(500);
  }

  function applyTarget(r) {
    const prev = STATE.plate;
    if (prev && prev !== r.plate) reportRelease(prev);   // сменили номер на этом телефоне → обнулить «ожидаем» у старого
    STATE.plate = r.plate; STATE.fuels = r.fuels; STATE.confirmed = !PLATE_STD.test(r.plate);
    STATE.grabbed = false; STATE.dropped = false; STATE.ticket = null;
    reportedSuccess = false; reportedFail = false; reportedWait = false;   // новый номер/заход → можно снова отчитаться
    if (prev && prev !== r.plate) tgNotify({ kind: 'change', old: prev, new: r.plate, fuels_pretty: prettyPref(r.fuels) });
    else tgNotify({ kind: 'target', plate: r.plate, fuels_pretty: prettyPref(r.fuels) });
    log('START', 'цель: ' + STATE.plate + ' [' + STATE.fuels.join(',') + '], настройки: ' + JSON.stringify(CONFIG));
    begin();
  }

  // 🚗 сменить номер авто/топливо: пауза → панель → применить
  let editorOpen = false;
  async function openSetup() {
    if (editorOpen) return;
    // защита от само-саботажа: не прерывать активный захват случайным тапом (это убило раздачу 26.06)
    if (STATE.busy && !confirm('⏳ Идёт ЗАХВАТ кода прямо сейчас! Прервать и открыть настройку?')) return;
    editorOpen = true;
    STATE.running = false; STATE.paused = true; grabGen++; clearTimeout(STATE.timer); STATE.busy = false;
    setBadge('⏸ пауза · настройка номера');
    const r = await setupUI();
    editorOpen = false; STATE.paused = false; STATE.busy = false;
    if (r === null) { STATE.running = true; begin(); return; } // отмена — продолжаем как было
    applyTarget(r);
  }

  // ───── старт ─────
  (async function start() {
    log('START', '=== запуск v3.8-solo (один номер, ручной ввод в панели, опрос раз в сек) ===');
    injectStyles();
    addTopButtons();

    // ВОРОТА: без валидного кода привязки (и если он занят другим браузером) — НЕ запускаемся
    const cl = await tgEnsureClaim();
    startHeartbeat(cl.sid);
    tgNotify({ kind: 'start', version: VERSION });   // отбивка «скрипт запущен + версия»
    // проверка версии: если устарела — окно со ссылкой на инструкцию (не блокируем работу)
    if (cl.latest && verLt(VERSION, cl.latest)) {
      const url = cl.update_url || '';
      infoDialog('⚠️ Доступно обновление',
        'Установлена устаревшая версия <b>' + escHtml(VERSION) + '</b>. Актуальная — <b>' + escHtml(cl.latest) + '</b>.<br>'
        + 'Старая версия может работать неправильно — обнови.<br><br>'
        + (url ? '<a href="' + escHtml(url) + '" target="_blank" rel="noopener" class="fq-btn ok" style="display:inline-block;text-decoration:none">🔄 Открыть инструкцию по обновлению</a>'
              + '<br><br><span class="fq-sub">или ссылкой: ' + escHtml(url) + '</span>'
              : 'Спроси ссылку у того, кто дал бота.'));
    }
    window.addEventListener('pagehide', tgRelease);
    window.addEventListener('beforeunload', tgRelease);

    const sessionP = (async () => {
      await loadMaxScript();
      await waitWebApp(8000);
      installContactSniffer();
      sessionUp = await ensureSession();
      return sessionUp;
    })();

    const savedPlate = (() => { try { return localStorage.getItem(PLATE_KEY) || ''; } catch (e) { return ''; } })();
    const savedFuels = (() => { try { return (localStorage.getItem(FUELS_KEY) || '').split(',').filter(Boolean); } catch (e) { return []; } })();

    if (savedPlate && savedFuels.length) {
      // авто-старт со старым номером — F5 = мгновенное продолжение
      STATE.plate = savedPlate; STATE.fuels = savedFuels; STATE.confirmed = !PLATE_STD.test(savedPlate);
      log('START', 'АВТО-старт, номер: ' + STATE.plate + ' [' + STATE.fuels.join(',') + ']');
      setBadge('▶️ ' + plateShort() + ' · ' + prettyPref(STATE.fuels) + ' — поднимаю сессию… (правка — «🚗 номер»)');
      await sessionP;
      await begin();
    } else {
      // первый запуск — настроить вручную в панели
      await sessionP;
      const r = await setupUI();
      if (r) applyTarget(r);
      else setBadge('⛔ номер не задан — жми «🚗 номер» вверху');
    }
    setTimeout(reauthLoop, CONFIG.preflightMs);
  })();
})();
