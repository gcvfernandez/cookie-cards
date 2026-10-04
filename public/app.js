(() => {
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(3, '0');
  const PAW = '<svg class="paw" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="16" rx="5" ry="4"/><circle cx="5.5" cy="10.5" r="2.2"/><circle cx="9.5" cy="6.5" r="2.2"/><circle cx="14.5" cy="6.5" r="2.2"/><circle cx="18.5" cy="10.5" r="2.2"/></svg>';
  const STAR = '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z"/>';

  let state = null;
  let timer = null;

  async function api(url, body, method) {
    const opts = body !== undefined
      ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: method || 'GET' };
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    return isNaN(dt) ? '' : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function cardHTML(c) {
    const shiny = c.kind === 'video';
    const back = shiny
      ? `<video src="${esc(c.original)}" poster="${esc(c.poster || '')}" muted loop playsinline preload="metadata"></video>`
      : `<img src="${esc(c.original)}" alt="The real photo">`;
    return `<div class="card${shiny ? ' shiny' : ''}" data-card role="button" tabindex="0" aria-label="Flip card">
      <div class="card-inner">
        <div class="face front">
          <div class="art"><img src="${esc(c.cartoon)}" alt="Cartoon of Cookie">${shiny ? `<span class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${STAR}</svg>Shiny</span>` : ''}</div>
          <div class="strip"><span class="nm">Cookie</span><span class="no">No. ${pad(c.no)}</span></div>
        </div>
        <div class="face back">
          <div class="backpanel">
            <div class="orig${shiny ? ' vid' : ''}">${back}</div>
            <div class="title">${esc(c.title)}</div>
            <div class="date">${esc(fmtDate(c.taken_on))}</div>
            ${PAW}
          </div>
        </div>
      </div>
    </div>`;
  }

  const soundBtn = (c) => (c.kind === 'video' ? '<button class="link" data-sound>Turn sound on</button>' : '');

  function shell(inner, tab, bg = 'bg-rays') {
    clearInterval(timer);
    app.className = bg;
    app.innerHTML = `<div class="screen">
      <div class="top"><div class="brand">Cookie's Cards</div>
        <button class="chip" data-act="whoami" aria-label="Signed in as ${esc(state.user.name)}. Tap to switch person.">${esc(state.user.name)}</button></div>
      ${inner}
      <div class="nav">
        <button data-act="today" ${tab === 'today' ? 'aria-current="page"' : ''}>Today</button>
        <button data-act="collection" ${tab === 'collection' ? 'aria-current="page"' : ''}>Collection</button>
      </div>
    </div>`;
  }

  function bare(inner, bg = 'bg-dots') {
    clearInterval(timer);
    app.className = bg;
    app.innerHTML = `<div class="screen">${inner}</div>`;
  }

  // ---------- PIN and name ----------

  // First visit on a phone: the intro video, then on to the PIN.
  function viewLanding() {
    bare(`<div class="landing">
      <div class="brand lockup">${PAW}Cookie's Cards</div>
      <div class="intro">
        <video src="/intro.mp4" poster="/intro.jpg" autoplay muted loop playsinline preload="auto" aria-label="Intro video: how Cookie's Cards works"></video>
        <button class="soundpill" data-intro-sound>Tap for sound</button>
      </div>
      <div><h1 class="h1">A memory of Cookie, every day</h1><p class="sub" style="margin-top:4px">Open one card a day and collect them all.</p></div>
      <button class="btn" data-start>Start my collection</button>
      <button class="link" data-start>I already have a PIN</button>
    </div>`, 'bg-rays');
    const vid = app.querySelector('video');
    const pill = app.querySelector('[data-intro-sound]');
    vid.play().catch(() => {});
    const toggle = () => {
      if (vid.muted) { vid.muted = false; vid.currentTime = 0; vid.play().catch(() => {}); pill.textContent = 'Mute'; }
      else { vid.muted = true; pill.textContent = 'Tap for sound'; }
    };
    pill.onclick = (ev) => { ev.stopPropagation(); toggle(); };
    vid.onclick = toggle;
    app.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => viewPin()));
  }

  function viewPin(message) {
    let pin = '';
    bare(`<div class="center" style="padding-top:calc(40px + env(safe-area-inset-top))">
      <div style="width:56px;height:56px">${PAW}</div>
      <div><h1 class="h1">Enter your PIN</h1><p class="sub" style="margin-top:6px">Just this once. This phone will remember you.</p></div>
      <div class="pin-boxes" aria-label="PIN digits entered">${'<div class="pin-box"></div>'.repeat(3)}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="key" data-key="${n}">${n}</button>`).join('')}</div>
      <button class="link" data-clear>Clear</button>
      <p class="error" role="alert">${esc(message || '')}</p>
      <p class="hint">First time? Pick any 3 digits and that becomes your PIN.</p>
    </div>`);
    const boxes = app.querySelectorAll('.pin-box');
    const err = app.querySelector('.error');
    const draw = () => boxes.forEach((b, i) => (b.textContent = pin[i] ? '•' : ''));
    app.querySelector('[data-clear]').onclick = () => { pin = ''; err.textContent = ''; draw(); };
    app.querySelectorAll('[data-key]').forEach((k) => (k.onclick = async () => {
      if (pin.length >= 3) return;
      pin += k.dataset.key;
      draw();
      if (pin.length < 3) return;
      try {
        const r = await api('/api/pin', { pin });
        if (r.isNew) viewName(pin); else load();
      } catch (e) { err.textContent = e.message; pin = ''; draw(); }
    }));
  }

  function viewName(pin) {
    bare(`<form class="center" style="padding-top:calc(40px + env(safe-area-inset-top))">
      <div style="width:56px;height:56px">${PAW}</div>
      <div><h1 class="h1">That's a new PIN</h1><p class="sub" style="margin-top:6px">What should Cookie call you?</p></div>
      <div class="field"><label for="nm">Your name</label><input id="nm" maxlength="24" autocomplete="given-name" required></div>
      <button class="btn" type="submit">Start my collection</button>
      <p class="error" role="alert"></p>
      <button class="link" type="button" data-back>I mistyped my PIN</button>
    </form>`);
    const form = app.querySelector('form');
    app.querySelector('[data-back]').onclick = () => viewPin();
    app.querySelector('#nm').focus();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('/api/register', { pin, name: app.querySelector('#nm').value }); load(); }
      catch (e) { app.querySelector('.error').textContent = e.message; }
    };
  }

  // ---------- Today ----------

  function viewToday() {
    const s = state;
    if (s.total === 0) {
      return shell(`<div class="center"><div class="panel"><h1 class="h1">No memories yet</h1><p class="sub">Cookie's cards are still being made. Come back soon.</p></div></div>`, 'today');
    }
    if (s.owned >= s.total) {
      return shell(`<div class="center">
        <div class="fan"><div></div><div></div><div></div></div>
        <div class="panel"><h1 class="h1">You found every memory of Cookie</h1><p class="sub">All ${s.total} cards are yours to keep.</p></div>
        <button class="btn" data-act="collection">Look through my collection</button>
      </div>`, 'today');
    }
    if (s.today) {
      shell(`<div class="center">
        ${cardHTML(s.today)}
        ${soundBtn(s.today)}
        <div class="panel"><h1 class="h1" style="font-size:24px">You've opened today's memory</h1><p class="sub" id="count"></p></div>
      </div>`, 'today');
      app.querySelector('.card').style.setProperty('--w', 'min(280px, 40dvh)');
      const until = Date.now() + s.msToNext;
      const tick = () => {
        const ms = until - Date.now();
        if (ms <= 0) return load();
        const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000);
        const el = document.getElementById('count');
        if (el) el.textContent = `Next card in ${h}h ${m}m`;
      };
      tick();
      timer = setInterval(tick, 20000);
      return;
    }
    shell(`<div class="center">
      <div class="pack bob"><div class="seal"></div>${PAW}<div class="word">COOKIE</div><div class="small">1 memory inside</div></div>
      <h1 class="h1">${s.unlimited ? 'Another memory is waiting' : "Today's memory is waiting"}</h1>
      <button class="btn" data-open>${s.unlimited ? 'Open a pack' : "Open today's pack"}</button>
      ${s.unlimited ? '<p class="hint">Admin mode: no daily limit on this browser</p>' : ''}
      <p class="error" role="alert"></p>
    </div>`, 'today');
    app.querySelector('[data-open]').onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        const r = await api('/api/open', {});
        if (!r.card) return load();
        // Make sure the art is ready before the pack tears, so the reveal never shows a blank card.
        await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = r.card.cartoon; setTimeout(done, 4000); });
        viewOpening(r.card);
      } catch (e) { app.querySelector('.error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  function viewOpening(card) {
    const shiny = card.kind === 'video';
    const sparks = shiny ? Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2, d = 150 + (i % 3) * 30;
      return `<svg class="spark" viewBox="0 0 24 24" style="--dx:${Math.round(Math.cos(a) * d)}px;--dy:${Math.round(Math.sin(a) * d)}px;animation-delay:${1.1 + (i % 4) * 0.08}s" aria-hidden="true">${STAR}</svg>`;
    }).join('') : '';
    shell(`<div class="center">
      <div class="stage">
        <div class="flash"></div>
        ${cardHTML(card)}
        ${sparks}
        <div class="drop"><div class="pack"><div class="seal"></div>${PAW}<div class="word">COOKIE</div></div></div>
      </div>
      <div class="after">
        <p class="hint">Tap the card to flip it and see the real ${shiny ? 'video' : 'photo'}</p>
        ${soundBtn(card)}
        ${state.unlimited ? '<button class="btn" data-act="today">Open another pack</button><button class="link" data-act="collection">See my collection</button>' : '<button class="btn" data-act="collection">See my collection</button>'}
      </div>
    </div>`, 'today');
    if (navigator.vibrate) setTimeout(() => navigator.vibrate(shiny ? [40, 60, 40, 60, 120] : 40), 1000);
    api('/api/state').then((s) => (state = s)).catch(() => {});
  }

  // ---------- Collection ----------

  async function viewCollection() {
    const c = await api('/api/collection');
    const byNo = new Map(c.cards.map((x) => [x.no, x]));
    const shinies = c.cards.filter((x) => x.kind === 'video').length;
    let cells = '';
    for (let n = 1; n <= c.total; n++) {
      const x = byNo.get(n);
      cells += x
        ? `<button class="mini${x.kind === 'video' ? ' shiny' : ''}" data-view="${n}" aria-label="Card ${n}: ${esc(x.title)}"><span class="pic"><img src="${esc(x.cartoon)}" alt="" loading="lazy"></span><span class="n">No. ${pad(n)}</span></button>`
        : `<div class="slot" aria-label="Card ${n}, not found yet">?</div>`;
    }
    shell(`<div class="coll-head"><h1 class="h1">My collection</h1>
      <p class="sub">${c.cards.length} of ${c.total} memories found${shinies ? ` · ${shinies} shiny` : ''}</p></div>
      <div class="grid">${cells}</div>`, 'collection', 'bg-dots');
    app.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
      const card = byNo.get(Number(b.dataset.view));
      const v = document.createElement('div');
      v.className = 'viewer';
      v.innerHTML = `${cardHTML(card)}<p class="hint">Tap the card to flip it</p>${soundBtn(card)}<button class="link" data-close>Close</button>`;
      v.addEventListener('click', (ev) => { if (ev.target === v || ev.target.closest('[data-close]')) v.remove(); });
      app.appendChild(v);
    }));
  }

  // ---------- shared interactions ----------

  function flip(card) {
    const on = card.classList.toggle('flipped');
    const vid = card.querySelector('video');
    if (vid) { if (on) vid.play().catch(() => {}); else vid.pause(); }
  }

  app.addEventListener('click', async (ev) => {
    const card = ev.target.closest('[data-card]');
    if (card) return flip(card);
    const sound = ev.target.closest('[data-sound]');
    if (sound) {
      const scope = sound.closest('.viewer') || app;
      const vid = scope.querySelector('video');
      if (!vid) return;
      vid.muted = !vid.muted;
      sound.textContent = vid.muted ? 'Turn sound on' : 'Turn sound off';
      const c = scope.querySelector('[data-card]');
      if (!vid.muted && c && !c.classList.contains('flipped')) flip(c);
      return;
    }
    const act = ev.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'today') load();
    if (a === 'collection') viewCollection().catch(() => load());
    if (a === 'whoami' && confirm(`Signed in as ${state.user.name}. Switch to a different person on this phone?`)) {
      await api('/api/logout', {}).catch(() => {});
      load();
    }
  });
  app.addEventListener('keydown', (ev) => {
    const card = ev.target.closest && ev.target.closest('[data-card]');
    if (card && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); flip(card); }
  });

  async function load() {
    try {
      state = await api('/api/state');
      if (!state.user) return viewLanding();
      viewToday();
    } catch (e) {
      bare(`<div class="center"><div class="panel"><h1 class="h1">Can't reach Cookie's cards</h1><p class="sub">Check your connection and try again.</p></div><button class="btn" id="retry">Try again</button></div>`);
      document.getElementById('retry').onclick = load;
    }
  }
  load();
})();
