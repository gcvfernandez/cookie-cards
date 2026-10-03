(() => {
  const root = document.getElementById('root');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(url, opts = {}) {
    if (opts.json !== undefined) {
      opts = { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.json) };
    }
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
    return j;
  }

  // Shrink a photo in the browser so uploads are quick and every phone can show it.
  function toJpeg(source, w, h, max = 1600) {
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read that picture.'))), 'image/jpeg', 0.88));
  }

  async function photoBlob(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bmp) throw new Error(`${file.name}: this browser can't read that image type. Convert it to JPEG first.`);
    return toJpeg(bmp, bmp.width, bmp.height);
  }

  // Grab one still frame from a video: the cartoon portrait is drawn from it.
  function videoFrame(file) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = URL.createObjectURL(file);
      const fail = () => rej(new Error(`${file.name}: this browser can't play that video. Try MP4 (H.264).`));
      v.onerror = fail;
      v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
      v.onseeked = () => toJpeg(v, v.videoWidth, v.videoHeight).then(res, rej).finally(() => URL.revokeObjectURL(v.src));
      setTimeout(fail, 20000);
    });
  }

  // ---- "Created" date from the file's own metadata ----
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const sane = (y, m, d) => y >= 1995 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const localYmd = (dt) => ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  const latin = (buf) => new TextDecoder('latin1').decode(buf);

  // Photos: EXIF stores dates as plain text "YYYY:MM:DD HH:MM:SS". The earliest one is when it was taken.
  async function photoDate(file) {
    const text = latin(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
    const found = [];
    for (const m of text.matchAll(/(\d{4}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}/g)) {
      if (sane(+m[1], +m[2], +m[3])) found.push(ymd(+m[1], +m[2], +m[3]));
    }
    return found.sort()[0] || null;
  }

  // Videos (MP4/MOV): Apple's creation-date tag if present, else the movie header's creation time.
  async function videoDate(file) {
    const chunk = 6 * 1024 * 1024;
    const parts = [await file.slice(0, chunk).arrayBuffer()];
    if (file.size > chunk) parts.push(await file.slice(Math.max(chunk, file.size - chunk)).arrayBuffer());
    for (const buf of parts) {
      const m = latin(buf).match(/(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}[+-]\d{2}:?\d{2}/);
      if (m && sane(+m[1], +m[2], +m[3])) return ymd(+m[1], +m[2], +m[3]);
    }
    for (const buf of parts) {
      const at = latin(buf).indexOf('mvhd');
      if (at < 0 || at + 16 > buf.byteLength) continue;
      const v = new DataView(buf, at + 4);
      const secs = v.getUint8(0) === 1 ? Number(v.getBigUint64(4)) : v.getUint32(4);
      if (!secs) continue;
      const dt = new Date(Date.UTC(1904, 0, 1) + secs * 1000);
      if (sane(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())) return localYmd(dt);
    }
    return null;
  }

  async function createdDate(file, isVideo) {
    const fromMeta = await (isVideo ? videoDate(file) : photoDate(file)).catch(() => null);
    if (fromMeta) return fromMeta;
    return file.lastModified ? localYmd(new Date(file.lastModified)) : null;
  }

  function login(msg) {
    root.innerHTML = `<h1>Cookie's Cards · Admin</h1>
      <form class="box"><label>Admin password<input type="password" id="pw" autocomplete="current-password" required></label>
      <button class="primary">Sign in</button><p class="err" role="alert">${esc(msg || '')}</p></form>`;
    root.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('/api/admin/login', { json: { password: document.getElementById('pw').value } }); load(); }
      catch (e) { login(e.message); }
    };
  }

  function cardBox(c) {
    const orig = c.kind === 'video'
      ? `<video src="${esc(c.original)}" poster="${esc(c.poster)}" controls muted playsinline preload="none"></video>`
      : `<img src="${esc(c.original)}" alt="Original" loading="lazy">`;
    const toon = c.cartoon ? `<img src="${esc(c.cartoon)}" alt="Cartoon" loading="lazy">` : '<div class="none">No cartoon yet</div>';
    return `<div class="c" data-id="${c.id}">
      <span class="tag ${c.status}">${c.status === 'live' ? 'Live' : 'Draft'} · ${c.kind === 'video' ? 'Shiny video' : 'Photo'}</span>
      <div class="pics"><figure>${toon}Cartoon (front)</figure><figure>${orig}Original (back)</figure></div>
      ${c.error ? `<p class="err">${esc(c.error)}</p>` : ''}
      <label>Title<input type="text" data-f="title" maxlength="60" value="${esc(c.title)}"></label>
      <label>Date taken<input type="date" data-f="taken_on" value="${esc((c.taken_on || '').slice(0, 10))}"></label>
      <div class="row">
        <button data-do="save">Save</button>
        <button data-do="${c.status === 'live' ? 'draft' : 'live'}" class="primary">${c.status === 'live' ? 'Unpublish' : 'Publish'}</button>
        <button data-do="regen">New cartoon</button>
        <button data-do="delete">Delete</button>
      </div>
    </div>`;
  }

  async function load() {
    let d;
    try { d = await api('/api/admin/cards'); }
    catch (e) { return e.status === 401 ? login() : (root.innerHTML = `<p class="err">${esc(e.message)}</p>`); }
    const live = d.cards.filter((c) => c.status === 'live').length;
    root.innerHTML = `<h1>Cookie's Cards · Admin</h1>
      <div class="box">
        <h2>Add memories</h2>
        <p class="muted">Choose photos and videos of Cookie. Each one gets a cartoon version and a title, then waits here as a draft until you publish it.</p>
        ${d.aiReady ? '' : '<p class="err">GEMINI_API_KEY is not set, so cartoons and titles can\'t be made yet.</p>'}
        <div class="row"><input type="file" id="files" accept="image/*,video/*" multiple><button class="primary" id="go">Upload</button></div>
        <p class="muted" id="status" role="status"></p>
      </div>
      <div class="box"><h2>Cards · ${live} live, ${d.cards.length - live} draft</h2>
        <div class="cards">${d.cards.map(cardBox).join('') || '<p class="muted">Nothing uploaded yet.</p>'}</div></div>
      <div class="box"><h2>People</h2>
        <table><tr><th>Name</th><th>Cards found</th><th>Joined</th></tr>
        ${d.people.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.owned} of ${live}</td><td>${esc(new Date(p.created_at).toLocaleDateString())}</td></tr>`).join('') || '<tr><td colspan="3">Nobody has tapped yet.</td></tr>'}
        </table></div>
      <div class="box"><h2>Testing</h2>
        <p class="muted">While you are signed in here, the app on this same browser has no daily limit, so you can open packs back to back. Everyone else still gets one a day.</p>
        <div class="row"><button id="reset">Empty my own collection</button></div>
        <p class="muted" id="resetmsg" role="status"></p></div>`;
    document.getElementById('reset').onclick = async () => {
      if (!confirm('Remove every card from your own collection so you can open them again?')) return;
      try { const r = await api('/api/admin/reset-me', { json: {} }); await load(); document.getElementById('resetmsg').textContent = `${r.name}'s collection is empty again.`; }
      catch (e) { document.getElementById('resetmsg').textContent = e.message; }
    };

    const status = document.getElementById('status');
    document.getElementById('go').onclick = async (ev) => {
      const files = [...document.getElementById('files').files];
      if (!files.length) return (status.textContent = 'Choose at least one file first.');
      ev.target.disabled = true;
      const problems = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        status.textContent = `Working on ${i + 1} of ${files.length}: ${f.name} (drawing the cartoon can take a minute)`;
        try {
          const fd = new FormData();
          const isVideo = f.type.startsWith('video/');
          fd.append('kind', isVideo ? 'video' : 'photo');
          const taken = await createdDate(f, isVideo);
          if (taken) fd.append('taken_on', taken);
          if (isVideo) { fd.append('file', f, f.name); fd.append('poster', await videoFrame(f), 'poster.jpg'); }
          else fd.append('file', await photoBlob(f), 'photo.jpg');
          await api('/api/admin/upload', { method: 'POST', body: fd });
        } catch (e) { problems.push(e.message); }
      }
      await load();
      if (problems.length) document.getElementById('status').textContent = 'Some files failed: ' + problems.join(' ');
    };

    root.querySelectorAll('.c').forEach((box) => {
      const id = box.dataset.id;
      const val = (f) => box.querySelector(`[data-f="${f}"]`).value;
      box.querySelectorAll('[data-do]').forEach((b) => (b.onclick = async () => {
        const what = b.dataset.do;
        b.disabled = true;
        try {
          if (what === 'delete') {
            if (!confirm('Delete this card for everyone? This cannot be undone.')) return (b.disabled = false);
            await api(`/api/admin/cards/${id}`, { method: 'DELETE' });
          } else if (what === 'regen') {
            b.textContent = 'Drawing…';
            await api(`/api/admin/cards/${id}/regenerate`, { json: { title: !val('title') } });
          } else {
            const json = { title: val('title'), taken_on: val('taken_on') };
            if (what !== 'save') json.status = what;
            await api(`/api/admin/cards/${id}`, { json });
          }
          load();
        } catch (e) { alert(e.message); b.disabled = false; }
      }));
    });
  }
  load();
})();
