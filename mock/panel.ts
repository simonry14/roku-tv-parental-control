/** Control panel for the mock TV (served at the control port). Plays "the kid with the remote". */
export const CONTROL_PANEL_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Roku TV</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --line:#2a2f3a; --text:#e8eaed; --muted:#9aa0aa; --accent:#7c5cff; --ok:#2fbf71; --warn:#f5a623; --bad:#ff5c5c; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 760px; margin: 0 auto; padding: 16px; display: grid; gap: 14px; }
  h1 { font-size: 18px; margin: 4px 0 0; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .screen { display:flex; gap:14px; align-items:center; }
  .tv { width: 132px; aspect-ratio: 16/9; border-radius: 8px; border: 3px solid #333; display:grid; place-items:center; background:#000; flex: none; overflow:hidden; }
  .tv img { width: 100%; height: 100%; object-fit: cover; }
  .tv.off { background:#050505; } .tv .label { font-size: 12px; color: var(--muted); }
  .kv { display:grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 14px; } .kv b { color: var(--muted); font-weight: 500; }
  .row { display:flex; flex-wrap:wrap; gap:8px; }
  button { font: inherit; color: var(--text); background: #232834; border: 1px solid var(--line); border-radius: 9px; padding: 8px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); } button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .apps { display:grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
  .apps button { display:flex; flex-direction:column; gap:6px; align-items:stretch; padding:6px; text-align:left; font-size: 13px; }
  .apps img { width:100%; aspect-ratio: 290/218; border-radius: 6px; background:#000; }
  .pill { display:inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; border:1px solid var(--line); }
  .pill.enabled { color: var(--ok); border-color: var(--ok); } .pill.limited { color: var(--warn); border-color: var(--warn); } .pill.disabled, .pill.offline { color: var(--bad); border-color: var(--bad); }
  ol { margin: 0; padding-left: 20px; font: 13px/1.6 ui-monospace, Consolas, monospace; max-height: 220px; overflow:auto; }
  .muted { color: var(--muted); font-size: 13px; }
  .tv .msg { padding: 6px; font-size: 11px; line-height: 1.25; color: #eef1f8; background: #10152a; width: 100%; height: 100%; display: grid; align-content: center; }
</style>
</head>
<body>
<main>
  <h1>Mock Roku TV <span class="muted" id="serial"></span></h1>
  <section class="screen">
    <div class="tv" id="tv"><span class="label">…</span></div>
    <div class="kv" id="kv"></div>
  </section>
  <section>
    <h2>Remote (the kid)</h2>
    <div class="row">
      <button data-key="PowerOn">Power on</button>
      <button data-key="PowerOff">Power off</button>
      <button data-key="Home">Home</button>
      <button data-key="Select">OK</button>
      <button id="ss">Screensaver</button>
    </div>
    <div class="apps" id="apps" style="margin-top:10px"></div>
  </section>
  <section>
    <h2>Control by mobile apps</h2>
    <div class="row" id="access">
      <button data-access="enabled">Enabled</button>
      <button data-access="limited">Limited</button>
      <button data-access="disabled">Disabled</button>
      <button id="offline">Unplug (offline)</button>
    </div>
    <p class="muted">Limited: queries work, keypress/icon get 403. Disabled: every ECP request gets 403 (discovery still answers), like a real Roku TV. Offline: requests time out and SSDP goes silent.</p>
  </section>
  <section>
    <h2>ECP commands received (newest first)</h2>
    <ol id="history" reversed></ol>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let state = null;
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) alertError(await r.text());
    await refresh();
  }
  function alertError(t) { console.warn(t); }
  function b64(v) {
    if (!v) return '';
    try { return new TextDecoder().decode(Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))); } catch { return v; }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  async function refresh() {
    try {
      state = await (await fetch('/api/state')).json();
      const hist = await (await fetch('/api/history')).json();
      render(state, hist);
    } catch (e) { $('kv').textContent = 'Mock not reachable'; }
  }
  function render(s, hist) {
    $('serial').textContent = s.serial;
    const app = s.apps.find((a) => a.id === s.activeAppId);
    const tv = $('tv');
    tv.className = 'tv' + (s.power === 'PowerOn' ? '' : ' off');
    const dm = s.activeAppId === 'dev' && s.devMessage && s.devMessage.t ? s.devMessage : null;
    tv.innerHTML = s.power !== 'PowerOn' ? '<span class="label">off</span>'
      : s.screensaver ? '<span class="label">screensaver</span>'
      : dm ? '<div class="msg"><b>' + esc(b64(dm.t)) + '</b>' + (dm.cd ? '<span>countdown ' + esc(dm.cd) + ' s</span>' : '') + '</div>'
      : app ? '<img alt="" src="http://' + location.hostname + ':' + s.ecpPort + '/query/icon/' + encodeURIComponent(app.id) + '" onerror="this.replaceWith(Object.assign(document.createElement(\\'span\\'),{className:\\'label\\',textContent:' + JSON.stringify(app.name) + '}))">'
      : '<span class="label">Home</span>';
    const access = s.offline ? '<span class="pill offline">offline</span>' : '<span class="pill ' + s.access + '">' + s.access + '</span>';
    $('kv').innerHTML = '<b>Power</b><span>' + s.power + '</span><b>Showing</b><span>' + esc(s.screensaver ? 'Screensaver' : app ? app.name + ' (' + app.id + ')' : 'Home') +
      '</span><b>ECP</b><span>' + access + ' port ' + s.ecpPort + (s.ecpListening ? '' : ' (closed)') + '</span>';
    $('apps').innerHTML = s.apps.map((a) => '<button data-launch="' + esc(a.id) + '" class="' + (a.id === s.activeAppId && s.power === 'PowerOn' ? 'on' : '') + '">' +
      '<img alt="" loading="lazy" src="http://' + location.hostname + ':' + s.ecpPort + '/query/icon/' + encodeURIComponent(a.id) + '"><span>' + esc(a.name) + '</span></button>').join('');
    document.querySelectorAll('[data-access]').forEach((b) => b.classList.toggle('on', b.dataset.access === s.access));
    $('offline').classList.toggle('on', s.offline);
    $('ss').classList.toggle('on', s.screensaver);
    $('history').innerHTML = hist.slice().reverse().slice(0, 50).map((h) => '<li>' + new Date(h.at).toLocaleTimeString() + '  ' + h.method + ' ' + esc(h.path) + (h.query && h.query.t ? '  “' + esc(b64(h.query.t)) + '”' : '') + ' → ' + h.status + '</li>').join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.key) post('/api/remote', { key: b.dataset.key });
    else if (b.dataset.launch) post('/api/remote', { launch: b.dataset.launch });
    else if (b.dataset.access) post('/api/state', { access: b.dataset.access });
    else if (b.id === 'offline') post('/api/state', { offline: !state.offline });
    else if (b.id === 'ss') post('/api/state', { screensaver: !state.screensaver, power: 'PowerOn' });
  });
  refresh(); setInterval(refresh, 1000);
</script>
</body>
</html>`;
