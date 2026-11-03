/* صفحة جرد الهويات: تصوير وجه الهوية وظهرها بالكاميرا مباشرة، وفحص كل لقطة قبل قبولها
   (الهوية تملأ الإطار على ورقة بيضاء، صورة واضحة بلا انعكاس، وباركود الظهر يطابق رقم الحاسبة)،
   ثم تجميعها في صورة واحدة يرسلها الموظف بالواتساب. لا تحفظ الصفحة ولا ترسل أي بيانات بنفسها.

   الصورة المجمّعة يقرؤها برنامج الشعبة عند الاستيراد، فأبعادها ثابتة (يجب أن تطابق app/badges/census.py):
   عرض 1600، رأس 220 فيه رمز QR نصه PRDC1|رقم الحاسبة|الهاتف|الإجابة|تحقق الوجه (1 أو 0)، ثم الوجه 1600×1010، فراغ 20،
   ثم الظهر 1600×1010.

   الترتيب: الظهر أولاً (باركوده يثبت أن الهوية للموظف)، ثم الوجه، ولا يُقبل الوجه إلا إذا قُرئ عليه رقم الحاسبة نفسه،
   حتى لا يُصوَّر ظهر هوية الشركة مع وجه هوية أخرى. */
(() => {
  "use strict";
  const CFG = window.CENSUS_CONFIG || {};
  const W = 1600, HDR = 220, CH = 1010, GAP = 20;
  const RATIO = 85.6 / 54;           // مقاس الهوية
  const SHARP_MIN = 250;             // حدة الصورة (تباين لابلاس على عرض 480)
  const NEED = { front: 1, back: 1 };  // لقطات خضراء متتالية قبل الالتقاط التلقائي (قراءة الباركود أو الرقم تكفي دليلاً)
  const SKIP_AFTER = 16;             // محاولات لا يُقرأ فيها رقم الوجه قبل السماح بالتقاطه دون تحقق
  const SHEEN_MAX = 0.55;             // أكبر نسبة لمعان مقبولة في خلية من الهوية (glareScore)
  const SHEEN_WAIT = 25;              // لقطات ننتظر فيها هوية بلا لمعان قبل القبول (بضع ثوانٍ)
  const ROI = { x0: 0.12, x1: 0.62, y0: 0.62, y1: 0.82 };  // موضع «رقم الحاسبة» على وجه هوية الشركة
  const ANSWERS = { have: "هويتي معي", none: "لا أملك هوية", lost: "هويتي مفقودة" };

  const $ = (id) => document.getElementById(id);
  const state = { emp: "", phone: "", answer: "", side: "back", front: null, back: null, stream: null,
                  running: false, okRun: 0, lastOk: false, image: null, frontVerified: true, misses: 0 };

  ZXingWASM.setZXingModuleOverrides({
    locateFile: (path, prefix) => path.endsWith(".wasm") ? new URL("vendor/zxing_full.wasm", location.href).href : prefix + path,
  });

  // ---------- الخطوة 1: البيانات ----------
  $("title").textContent = CFG.title || "جرد الهويات";
  $("subtitle").textContent = CFG.subtitle || "";
  $("wa-num").textContent = CFG.whatsappDisplay || "";
  try {
    const saved = JSON.parse(sessionStorage.getItem("census") || "{}");
    $("emp").value = saved.emp || ""; $("phone").value = saved.phone || "";
    if (saved.answer) pickAnswer(saved.answer);
  } catch (e) { /* التخزين غير متاح: لا بأس */ }

  function pickAnswer(v) {
    state.answer = v;
    document.querySelectorAll("#answer button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  }
  document.querySelectorAll("#answer button").forEach((b) => b.addEventListener("click", () => pickAnswer(b.dataset.v)));
  $("emp").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); });
  $("phone").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, ""); });

  $("info-next").addEventListener("click", async () => {
    const emp = $("emp").value.trim(), phone = $("phone").value.trim();
    const err = !/^\d{1,7}$/.test(emp) ? "اكتب رقم الحاسبة (أرقام فقط)."
      : !/^07\d{9}$/.test(phone) ? "رقم الهاتف 11 رقماً ويبدأ بـ 07."
      : !state.answer ? "اختر: هل هويتك الدائمية معك؟" : "";
    $("info-err").textContent = err;
    if (err) return;
    // قبل التصوير: هل الرقم في قائمة الموظفين، وهل أرسل جرده سابقاً (إن تعذر الفحص يكمل، والسكربت يتحقق عند الإرسال)
    const chk = await precheck(emp, phone);
    if (chk && chk.known === false) { $("info-err").textContent = "رقم الحاسبة غير موجود في قائمة الموظفين. تأكد من الرقم أو راجع وحدة المعلومات."; return; }
    if (chk && chk.done && (chk.done === "have" || state.answer !== "have")) {
      $("info-err").textContent = "تم استلام جردك سابقاً، ولا حاجة لإعادة الإرسال. للتصحيح راجع وحدة المعلومات.";
      return;
    }
    state.emp = emp; state.phone = phone;
    try { sessionStorage.setItem("census", JSON.stringify({ emp, phone, answer: state.answer })); } catch (e) { /* */ }
    if (state.answer === "have") {
      state.front = state.back = null;
      openCamera("back");
    } else {
      await finish();
    }
  });

  async function precheck(emp, phone) {
    if (!CFG.uploadUrl) return null;
    const btn = $("info-next");
    btn.disabled = true; btn.textContent = "جارٍ التحقق…";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(CFG.uploadUrl + "?emp=" + encodeURIComponent(emp) + "&phone=" + encodeURIComponent(phone) + "&answer=" + encodeURIComponent(state.answer || ""), { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) {
      return null;
    } finally {
      btn.disabled = false; btn.textContent = "التالي";
    }
  }

  function show(id) {
    ["step-info", "step-cam", "step-send"].forEach((s) => $(s).classList.toggle("hidden", s !== id));
    window.scrollTo(0, 0);
  }

  // ---------- الخطوة 2: الكاميرا ----------
  const video = $("video");
  const work = document.createElement("canvas");
  const wctx = work.getContext("2d", { willReadFrequently: true });
  let geo = null;  // موضع الإطار بإحداثيات الفيديو

  async function openCamera(side) {
    state.side = side;
    state.okRun = 0;
    $("cam-title").textContent = side === "front" ? "صورة وجه الهوية" : "صورة ظهر الهوية (الباركود)";
    $("cam-step").textContent = side === "back" ? "1 من 2" : "2 من 2";
    state.misses = 0;
    state.sheenWait = 0;
    $("cam-skip").classList.add("hidden");
    $("flip").classList.add("hidden");
    if (side === "back") ocrWorker();  // تحميل قارئ الأرقام مسبقاً أثناء تصوير الظهر
    setHint("جارٍ تشغيل الكاميرا…", "");
    $("cam-shot").disabled = true;
    show("step-cam");
    if (!state.stream) {
      try {
        await startStream(null);
        await pickMainCamera();
      } catch (e) {
        setHint("لم يُسمح بفتح الكاميرا. اسمح للمتصفح باستخدام الكاميرا ثم أعد تحميل الصفحة.", "bad");
        return;
      }
    }
    layout();
    if (!state.running) { state.running = true; loop(); }
  }

  async function startStream(deviceId) {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: "environment" }, ...size },
    });
    const track = state.stream.getVideoTracks()[0];
    state.deviceId = deviceId || (track.getSettings && track.getSettings().deviceId) || null;
    try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { /* غير مدعوم */ }
    // بعض الهواتف تفتح بتقريب 0.5 (العدسة الواسعة) التي لا تركّز عن قرب: نثبّت التقريب على 1
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.zoom && caps.zoom.min < 1 && caps.zoom.max >= 1) await track.applyConstraints({ advanced: [{ zoom: 1 }] });
    } catch (e) { /* غير مدعوم */ }
    video.srcObject = state.stream;
    await new Promise((r) => (video.readyState >= 1 ? r() : (video.onloadedmetadata = r)));
    try { await video.play(); } catch (e) { /* */ }
  }

  // الكاميرات الخلفية مرتبة: الرئيسية أولاً (في أندرويد اسمها camera2 0، والواسعة والمقربة أرقام أكبر)
  async function backCameras() {
    let list = [];
    try { list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch (e) { return []; }
    const back = list.filter((d) => /back|rear|environment|خلف/i.test(d.label));
    const num = (d) => { const m = /camera2?\s*(\d+)/i.exec(d.label); return m ? +m[1] : 99; };
    const wide = (d) => (/ultra|wide|0[.,]5/i.test(d.label) ? 1 : 0);
    return back.sort((a, b) => wide(a) - wide(b) || num(a) - num(b));
  }

  async function pickMainCamera() {
    const cams = await backCameras();
    state.cams = cams;
    $("cam-switch").classList.toggle("hidden", cams.length < 2);
    if (cams.length < 2) return;
    let want = cams[0].deviceId;
    try { const saved = localStorage.getItem("census-cam"); if (saved && cams.some((c) => c.deviceId === saved)) want = saved; } catch (e) { /* */ }
    if (want !== state.deviceId) await startStream(want);
  }

  $("cam-switch").addEventListener("click", async () => {
    const cams = state.cams || [];
    if (cams.length < 2) return;
    const i = cams.findIndex((c) => c.deviceId === state.deviceId);
    const next = cams[(i + 1) % cams.length].deviceId;
    try { localStorage.setItem("census-cam", next); } catch (e) { /* */ }
    state.okRun = 0;
    try { await startStream(next); layout(); } catch (e) { setHint("تعذر تبديل الكاميرا.", "bad"); }
  });

  function layout() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const gw = Math.min(vw * 0.86, vh * 0.88 * RATIO), gh = gw / RATIO;
    geo = { vw, vh, gx: (vw - gw) / 2, gy: (vh - gh) / 2, gw, gh };
    const viewer = $("viewer");
    viewer.style.aspectRatio = `${vw} / ${vh}`;
    viewer.style.maxWidth = `calc(62vh * ${vw / vh})`;
    const g = $("guide").style;
    g.left = `${(geo.gx / vw) * 100}%`; g.top = `${(geo.gy / vh) * 100}%`;
    g.width = `${(gw / vw) * 100}%`; g.height = `${(gh / vh) * 100}%`;
  }
  video.addEventListener("resize", layout);

  function stopCamera() {
    state.running = false;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
  }

  function setHint(text, kind) {
    const h = $("cam-hint");
    h.textContent = text;
    h.className = "hint " + (kind || "");
    $("guide").className = "guide " + (kind || "");
  }

  async function loop() {
    while (state.running) {
      if (geo && video.readyState >= 2) {
        let res;
        try { res = await analyse(); } catch (e) { res = { ok: false, msg: "تعذر فحص الصورة، حاول مرة أخرى." }; }
        if (!state.running) break;
        state.lastOk = res.ok;
        state.okRun = res.ok ? state.okRun + 1 : 0;
        setHint(res.msg, res.ok ? "ok" : "bad");
        $("cam-shot").disabled = !res.ok;
        if (res.ok && state.okRun >= NEED[state.side]) { capture(res); continue; }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  // يقص من الفيديو منطقة الإطار موسّعة بنسبة pad من كل جهة، بالدقة الكاملة أو بعرض محدد
  function grab(pad, width) {
    const { gx, gy, gw, gh, vw, vh } = geo;
    const px = gw * pad, py = gh * pad;
    const sx = Math.max(0, gx - px), sy = Math.max(0, gy - py);
    const sw = Math.min(vw, gx + gw + px) - sx, sh = Math.min(vh, gy + gh + py) - sy;
    const scale = width ? width / sw : 1;
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return { canvas: c, scale, ox: (gx - sx) * scale, oy: (gy - sy) * scale, gw: gw * scale, gh: gh * scale };
  }

  function gray(canvas) {
    const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const g = new Float32Array(canvas.width * canvas.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return g;
  }

  function stripMean(g, w, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(w, Math.round(x1)); y1 = Math.min(g.length / w, Math.round(y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { s += g[y * w + x]; n++; }
    return s / n;
  }

  // الهوية تملأ الإطار: داخل حافة الإطار أغمق بوضوح من الورقة البيضاء خارجها، في كل جهة يُرى خارجها
  function fills(a) {
    const g = gray(a.canvas), w = a.canvas.width;
    const { ox, oy, gw, gh } = a;
    const ix = gw * 0.1, iy = gh * 0.1, o0x = gw * 0.02, o1x = gw * 0.08, o0y = gh * 0.03, o1y = gh * 0.12;
    const sides = [
      [stripMean(g, w, ox, oy + iy, ox + ix, oy + gh - iy), stripMean(g, w, ox - o1x, oy + iy, ox - o0x, oy + gh - iy)],
      [stripMean(g, w, ox + gw - ix, oy + iy, ox + gw, oy + gh - iy), stripMean(g, w, ox + gw + o0x, oy + iy, ox + gw + o1x, oy + gh - iy)],
      [stripMean(g, w, ox + ix, oy, ox + gw - ix, oy + iy), stripMean(g, w, ox + ix, oy - o1y, ox + gw - ix, oy - o0y)],
      [stripMean(g, w, ox + ix, oy + gh - iy, ox + gw - ix, oy + gh), stripMean(g, w, ox + ix, oy + gh + o0y, ox + gw - ix, oy + gh + o1y)],
    ].filter(([inn, out]) => inn !== null && out !== null);
    if (!sides.length) return { ok: true };
    const outside = sides.map(([, out]) => out), inside = sides.map(([inn]) => inn);
    // جهة واحدة يُسمح لها بالتساهل (ظل أو حافة ورقة) ما دامت البقية مطابقة
    const good = sides.filter(([inn, out]) => out - inn >= 14).length;
    if (good >= Math.max(1, sides.length - 1)) return { ok: true };
    const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    if (avg(outside) < 150) return { ok: false, msg: "ضع الهوية على ورقة بيضاء." };
    if (avg(inside) >= avg(outside) - 10) return { ok: false, msg: "قرّب الهاتف حتى تملأ الهوية الإطار." };
    return { ok: false, msg: "طابق حواف الهوية مع الإطار (لا تخرج عنه ولا تصغر داخله)." };
  }

  // انعكاس الضوء على اللمينيت: بقع أفتح بوضوح من محيطها وبلا لون (تبيضّ الألوان تحتها).
  // يعيد أكبر نسبة من هذه البقع في خلية من شبكة 8×6 على الهوية
  function glareScore(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const V = new Float32Array(w * h), S = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      V[j] = mx; S[j] = mx ? (mx - mn) * 255 / mx : 0;
    }
    const integral = (a) => {
      const I = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += a[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
      return I;
    };
    const IV = integral(V), IS = integral(S);
    const box = (I, x, y, r) => {
      const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
      return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    };
    const cols = 8, rows = 6, hit = new Float32Array(cols * rows), cnt = new Float32Array(cols * rows);
    const big = Math.round(w / 12);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const vs = box(IV, x, y, 3), c = Math.min(rows - 1, (y * rows / h) | 0) * cols + Math.min(cols - 1, (x * cols / w) | 0);
      cnt[c]++;
      if (vs > 170 && vs - box(IV, x, y, big) > 15 && box(IS, x, y, 3) < 45) hit[c]++;
    }
    let worst = 0;
    for (let c = 0; c < hit.length; c++) if (cnt[c]) worst = Math.max(worst, hit[c] / cnt[c]);
    return worst;
  }

  function sharpness(a) {
    const s = grab(0, 480).canvas, w = s.width, h = s.height, g = gray(s);
    let sum = 0, sum2 = 0, n = 0, glare = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = g[i];
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * v;
      sum += l; sum2 += l * l; n++;
      if (v >= 253) glare++;
    }
    return { sharp: sum2 / n - (sum / n) ** 2, glare: glare / n, sheen: glareScore(s) };
  }

  // يقص جزءاً من الإطار (نِسَب من الهوية) مكبّراً بعامل معين
  function cropCard(full, r, k) {
    const { canvas, ox, oy, gw, gh } = full;
    const sx = Math.max(0, ox + gw * r.x0), sy = Math.max(0, oy + gh * r.y0);
    const sw = Math.min(canvas.width - sx, gw * (r.x1 - r.x0)), sh = Math.min(canvas.height - sy, gh * (r.y1 - r.y0));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  // موضع الباركود على ظهر الهوية (والهوية مقلوبة). بعض الهويات باركودها صغير، فيُقص ويُكبّر حتى يُقرأ
  const CODE_ROI = [{ x0: 0.15, x1: 0.88, y0: 0.62, y1: 1 }, { x0: 0.12, x1: 0.85, y0: 0, y1: 0.38 }];

  // يقرأ الباركود من نسخة مصغرة أولاً (أسرع)، ثم من موضع الباركود مكبّراً، ثم من الصورة كاملة (إلا في الفحص السريع)
  async function readCode(full, quick) {
    const canvas = full.canvas;
    const tries = [];
    if (canvas.width > 1100) {
      const c = document.createElement("canvas");
      c.width = 1000; c.height = Math.round(canvas.height * 1000 / canvas.width);
      c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
      tries.push(c);
    } else tries.push(canvas);
    if (!quick) {
      // القراءة حساسة لمقدار التكبير، فيُجرَّب حجمان
      for (const roi of CODE_ROI) for (const tw of [1100, 1500])
        tries.push(() => cropCard(full, roi, Math.min(3, tw / (full.gw * (roi.x1 - roi.x0)))));
      if (canvas.width > 1100) tries.push(canvas);
    }
    let r = null;
    for (const t of tries) {
      const c = typeof t === "function" ? t() : t;
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      const out = await ZXingWASM.readBarcodes(data, { formats: ["PDF417"], tryHarder: !quick, maxNumberOfSymbols: 1 });
      r = out.find((x) => x.isValid);
      if (r) break;
    }
    if (!r) return null;
    let parts = r.text.split(",").map((p) => p.trim());
    // هويات أقدم بلا فواصل: رقم الحاسبة والاسم ورقم الهوية والتاريخ ملتصقة
    const glued = parts.length === 1 && /^(\d+)\s*(\D*?\D)\s*(\d+)\s*(\d{2}\/\d{2}\/\d{4})$/.exec(parts[0]);
    if (glued) parts = glued.slice(1).map((p) => p.trim());
    return { raw: r.text, emp: /^\d+$/.test(parts[0] || "") ? String(parseInt(parts[0], 10)) : null, card: parts[2] || "" };
  }

  // ---------- قراءة رقم الحاسبة من وجه الهوية ----------
  let ocr = null;
  function ocrWorker() {
    if (ocr || !window.Tesseract) return ocr;
    const base = new URL("vendor/tesseract/", location.href).href;
    ocr = Tesseract.createWorker("eng", 1, {
      workerPath: base + "worker.min.js", corePath: base, langPath: base.replace(/\/$/, ""), gzip: true,
    }).then(async (w) => {
      await w.setParameters({ tessedit_char_whitelist: "0123456789:/", tessedit_pageseg_mode: "11" });
      return w;
    }).catch(() => null);
    return ocr;
  }

  // يقص موضع رقم الحاسبة من الهوية (أو من الهوية مقلوبة) ويحوّله أبيض وأسود بعتبة معينة
  function roiCanvas(full, flip, cut) {
    const { canvas, ox, oy, gw, gh } = full;
    const r = flip ? { x0: 1 - ROI.x1, x1: 1 - ROI.x0, y0: 1 - ROI.y1, y1: 1 - ROI.y0 } : ROI;
    const sx = ox + gw * r.x0, sy = oy + gh * r.y0, sw = gw * (r.x1 - r.x0), sh = gh * (r.y1 - r.y0);
    const c = document.createElement("canvas");
    c.width = 520; c.height = Math.round(520 * sh / sw);
    const x = c.getContext("2d");
    if (flip) { x.translate(c.width, c.height); x.rotate(Math.PI); }
    x.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < cut ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.putImageData(img, 0, 0);
    return c;
  }

  // true إن قُرئ رقم الحاسبة نفسه على الوجه، false إن لم يُقرأ، null إن لم يجهز القارئ بعد
  async function frontNumber(full) {
    const w = await Promise.race([ocrWorker(), new Promise((r) => setTimeout(() => r(undefined), 50))]);
    if (!w) return w === null ? false : null;
    const emp = String(parseInt(state.emp, 10));
    // عتبة واحدة في كل لقطة (تتبدل بين اللقطات) حتى تبقى الاستجابة سريعة
    const cut = [90, 70, 115][state.misses % 3];
    for (const flip of [false, true]) {
      const { data } = await w.recognize(roiCanvas(full, flip, cut));
      const runs = (data.text.match(/\d+/g) || []);
      if (runs.some((r) => r === emp || (r.length === emp.length + 1 && (r.startsWith(emp) || r.endsWith(emp)))))
        return true;
    }
    return false;
  }

  async function analyse() {
    const fill = fills(grab(0.14, 640));
    if (!fill.ok) return fill;
    const q = sharpness();
    if (q.glare > 0.06) return { ok: false, msg: "يوجد انعكاس ضوء على الهوية. غيّر زاوية الهاتف أو ابتعد عن المصباح." };
    // انعكاس أخف (لمعان اللمينيت): ننتظر لقطة أنظف لثوانٍ قليلة، ثم نقبل حتى لا يعلق الموظف
    if (q.sheen > SHEEN_MAX && state.sheenWait < SHEEN_WAIT) {
      state.sheenWait++;
      return { ok: false, msg: "يوجد لمعان ضوء على الهوية. أمِل الهاتف قليلاً أو ابتعد عن المصباح، ولا تستخدم الفلاش." };
    }
    // الحدة لا تمنع وحدها: إن قُرئ الباركود أو الرقم فالصورة واضحة بما يكفي، وتُستعمل لرسالة التنبيه فقط
    const blurry = q.sharp < SHARP_MIN;
    const full = grab(0.03);
    const code = await readCode(full, state.side === "front");
    if (state.side === "front") {
      if (code) return { ok: false, msg: "هذا ظهر الهوية. اقلبها وصوّر الوجه الذي فيه صورتك." };
      const num = await frontNumber(full);
      if (num === true) return { ok: true, msg: "رقم الحاسبة على الوجه مطابق ✓", canvas: full.canvas, verified: true };
      state.misses++;
      if (state.misses >= SKIP_AFTER) $("cam-skip").classList.remove("hidden");
      state.lastCanvas = full.canvas;
      if (num === null) return { ok: false, msg: "جارٍ تجهيز قراءة رقم الحاسبة…" };
      if (blurry) return { ok: false, msg: "الصورة غير واضحة. ثبّت الهاتف قليلاً." };
      return { ok: false, msg: `لم يُقرأ رقم الحاسبة ${state.emp} على وجه الهوية. صوّر وجه الهوية نفسها التي صوّرت ظهرها، وثبّت الهاتف في إضاءة جيدة.` };
    }
    if (!code && blurry) return { ok: false, msg: "الصورة غير واضحة. ثبّت الهاتف قليلاً." };
    if (!code) return { ok: false, msg: "لم يُقرأ الباركود بعد. ثبّت الهاتف حتى يظهر الباركود كاملاً وواضحاً." };
    if (code.emp !== String(parseInt(state.emp, 10)))
      return { ok: false, msg: `هذه الهوية تعود لرقم الحاسبة ${code.emp || "غير معروف"}، وليست لرقم ${state.emp}. صوّر هويتك أنت.` };
    return { ok: true, msg: `الباركود مطابق · رقم الهوية ${code.card || "-"}`, canvas: full.canvas, code };
  }

  async function capture(res) {
    state.running = false;
    state[state.side] = res.canvas;
    if (state.side === "back") {
      setHint("تم تصوير الظهر ✓ الآن اقلب الهوية وصوّر الوجه.", "ok");
      try { navigator.vibrate && navigator.vibrate(150); } catch (e) { /* */ }
      // هوية متحركة تنقلب تبقى ظاهرة لحظات (أو حتى يلمسها الموظف) قبل بدء تصوير الوجه
      $("cam-title").textContent = "صورة وجه الهوية"; $("cam-step").textContent = "2 من 2";
      $("flip").classList.remove("hidden");
      await new Promise((r) => { const t = setTimeout(r, 2600); $("flip").onclick = () => { clearTimeout(t); r(); }; });
      $("flip").classList.add("hidden");
      openCamera("front");
      return;
    }
    state.frontVerified = res.verified !== false;
    stopCamera();
    await finish();
  }

  $("cam-shot").addEventListener("click", async () => {
    if (!state.lastOk) return;
    state.running = false;
    const res = await analyse();
    if (res.ok) capture(res); else { setHint(res.msg, "bad"); state.running = true; loop(); }
  });
  $("cam-skip").addEventListener("click", () => {
    if (!state.lastCanvas) return;
    capture({ canvas: state.lastCanvas, verified: false });
  });
  $("cam-back").addEventListener("click", () => {
    stopCamera();
    if (state.side === "front" && state.back) { state.back = null; openCamera("back"); return; }
    show("step-info");
  });

  // ---------- الخطوة 3: تجميع الصورة وإرسالها ----------
  async function qrBitmap(text) {
    const r = await ZXingWASM.writeBarcode(text, { format: "QRCode", scale: 6, ecLevel: "M" });
    if (!r.image) throw new Error(r.error || "QR");
    return createImageBitmap(r.image);
  }

  async function compose() {
    const have = state.answer === "have";
    const c = document.createElement("canvas");
    c.width = W; c.height = have ? HDR + CH + GAP + CH : HDR + 260;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    const fv = have && !state.frontVerified ? 0 : 1;
    state.payload = `PRDC1|${state.emp}|${state.phone}|${state.answer}|${fv}`;
    const qr = await qrBitmap(state.payload);
    x.imageSmoothingEnabled = false;
    x.drawImage(qr, 20, 20, 180, 180);
    x.imageSmoothingEnabled = true;
    x.direction = "rtl"; x.textAlign = "right"; x.fillStyle = "#1d2b3a";
    x.font = "800 46px Almarai, sans-serif";
    x.fillText(`${CFG.title || "جرد الهويات"} · رقم الحاسبة ${state.emp}`, W - 30, 78);
    x.font = "400 34px Almarai, sans-serif";
    x.fillText(`الهاتف ${state.phone} · ${ANSWERS[state.answer]}${fv ? "" : " · الوجه لم يُتحقق منه"}`, W - 30, 136);
    x.fillStyle = "#687991"; x.font = "400 26px Almarai, sans-serif";
    x.fillText(new Date().toLocaleString("ar-IQ"), W - 30, 186);
    if (have) {
      x.drawImage(state.front, 0, HDR, W, CH);
      x.drawImage(state.back, 0, HDR + CH + GAP, W, CH);
    } else {
      x.fillStyle = "#1d2b3a"; x.textAlign = "center"; x.font = "800 64px Almarai, sans-serif";
      x.fillText(ANSWERS[state.answer], W / 2, HDR + 150);
    }
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  }

  async function finish() {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* */ } }
    const blob = await compose();
    const name = `census-${state.emp}.jpg`;
    state.image = new File([blob], name, { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    $("result").src = url;
    $("save").href = url; $("save").download = name;
    const msg = `جرد الهويات\nرقم الحاسبة: ${state.emp}\n${ANSWERS[state.answer]}`;
    $("wa-chat").href = `https://wa.me/${CFG.whatsappIntl}?text=${encodeURIComponent(msg)}`;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [state.image] }));
    $("share").classList.toggle("hidden", !canShare);
    if (!canShare)
      $("share-note").textContent = "هاتفك لا يدعم الإرسال المباشر: احفظ الصورة، ثم افتح محادثة وحدة المعلومات وأرفقها من الاستوديو.";
    const direct = !!CFG.uploadUrl;
    $("direct").classList.toggle("hidden", !direct);
    $("done").classList.add("hidden");
    $("upload").disabled = false;
    $("upload-msg").textContent = ""; $("upload-msg").className = "hint";
    $("wa").classList.toggle("hidden", direct);
    show("step-send");
  }

  // الإرسال المباشر إلى Google Drive عبر سكربت الوحدة؛ إن فشل يظهر الإرسال بالواتساب بديلاً
  $("upload").addEventListener("click", async () => {
    const btn = $("upload"), msg = $("upload-msg");
    btn.disabled = true; msg.className = "hint"; msg.textContent = "جارٍ الإرسال…";
    try {
      const image = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(state.image);
      });
      const res = await fetch(CFG.uploadUrl, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ payload: state.payload, image }),
      });
      const out = await res.json();
      if (!out.ok) throw Object.assign(new Error(out.error || "تعذر الإرسال"), { fromServer: true, done: !!out.done });
      $("direct").classList.add("hidden");
      $("done").classList.remove("hidden");
      $("again").classList.add("hidden");
      try { sessionStorage.removeItem("census"); } catch (e) { /* */ }
    } catch (e) {
      msg.className = "hint bad";
      if (e && e.fromServer) {  // رفض من السكربت (رقم غير موجود، أُرسل سابقاً…): لا بديل بالواتساب
        btn.disabled = !!e.done;
        msg.textContent = e.message;
        return;
      }
      btn.disabled = false;
      msg.textContent = "تعذر الإرسال. تأكد من الإنترنت وأعد المحاولة، أو أرسلها بالواتساب من الأسفل.";
      $("wa").classList.remove("hidden");
    }
  });

  $("share").addEventListener("click", async () => {
    try { await navigator.share({ files: [state.image], text: `جرد الهويات · رقم الحاسبة ${state.emp}` }); }
    catch (e) { /* أغلق الموظف نافذة المشاركة */ }
  });
  $("again").addEventListener("click", () => {
    $("again").classList.remove("hidden");
    if (state.answer === "have") { state.front = state.back = null; openCamera("back"); } else show("step-info");
  });
})();
