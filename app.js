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
  const NEED = { front: 1, back: 2 };  // لقطات خضراء متتالية قبل الالتقاط التلقائي (الوجه يمر بقراءة الرقم أصلاً)
  const SKIP_AFTER = 8;              // محاولات لا يُقرأ فيها رقم الوجه قبل السماح بالتقاطه دون تحقق
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
    state.emp = emp; state.phone = phone;
    try { sessionStorage.setItem("census", JSON.stringify({ emp, phone, answer: state.answer })); } catch (e) { /* */ }
    if (state.answer === "have") {
      state.front = state.back = null;
      openCamera("back");
    } else {
      await finish();
    }
  });

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
    $("cam-skip").classList.add("hidden");
    if (side === "back") ocrWorker();  // تحميل قارئ الأرقام مسبقاً أثناء تصوير الظهر
    setHint("جارٍ تشغيل الكاميرا…", "");
    $("cam-shot").disabled = true;
    show("step-cam");
    if (!state.stream) {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
      } catch (e) {
        setHint("لم يُسمح بفتح الكاميرا. اسمح للمتصفح باستخدام الكاميرا ثم أعد تحميل الصفحة.", "bad");
        return;
      }
      const track = state.stream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { /* غير مدعوم */ }
      video.srcObject = state.stream;
      await new Promise((r) => (video.readyState >= 1 ? r() : (video.onloadedmetadata = r)));
      try { await video.play(); } catch (e) { /* */ }
    }
    layout();
    if (!state.running) { state.running = true; loop(); }
  }

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
      await new Promise((r) => setTimeout(r, 180));
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
    const good = sides.filter(([inn, out]) => out - inn >= 18).length;
    if (good === sides.length) return { ok: true };
    const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    if (avg(outside) < 150) return { ok: false, msg: "ضع الهوية على ورقة بيضاء." };
    if (avg(inside) >= avg(outside) - 10) return { ok: false, msg: "قرّب الهاتف حتى تملأ الهوية الإطار." };
    return { ok: false, msg: "طابق حواف الهوية مع الإطار (لا تخرج عنه ولا تصغر داخله)." };
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
    return { sharp: sum2 / n - (sum / n) ** 2, glare: glare / n };
  }

  async function readCode(canvas) {
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = await ZXingWASM.readBarcodes(data, { formats: ["PDF417"], tryHarder: true, maxNumberOfSymbols: 1 });
    const r = out.find((x) => x.isValid);
    if (!r) return null;
    const parts = r.text.split(",").map((p) => p.trim());
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
    for (const flip of [false, true]) {
      for (const cut of [90, 70, 115]) {
        const { data } = await w.recognize(roiCanvas(full, flip, cut));
        const runs = (data.text.match(/\d+/g) || []);
        if (runs.some((r) => r === emp || (r.length === emp.length + 1 && (r.startsWith(emp) || r.endsWith(emp)))))
          return true;
      }
    }
    return false;
  }

  async function analyse() {
    const fill = fills(grab(0.14, 640));
    if (!fill.ok) return fill;
    const q = sharpness();
    if (q.glare > 0.06) return { ok: false, msg: "يوجد انعكاس ضوء على الهوية. غيّر زاوية الهاتف أو ابتعد عن المصباح." };
    if (q.sharp < SHARP_MIN) return { ok: false, msg: "الصورة غير واضحة. ثبّت الهاتف قليلاً." };
    const full = grab(0.03);
    const code = await readCode(full.canvas);
    if (state.side === "front") {
      if (code) return { ok: false, msg: "هذا ظهر الهوية. اقلبها وصوّر الوجه الذي فيه صورتك." };
      const num = await frontNumber(full);
      if (num === true) return { ok: true, msg: "رقم الحاسبة على الوجه مطابق ✓", canvas: full.canvas, verified: true };
      state.misses++;
      if (state.misses >= SKIP_AFTER) $("cam-skip").classList.remove("hidden");
      state.lastCanvas = full.canvas;
      if (num === null) return { ok: false, msg: "جارٍ تجهيز قراءة رقم الحاسبة…" };
      return { ok: false, msg: `لم يُقرأ رقم الحاسبة ${state.emp} على وجه الهوية. صوّر وجه الهوية نفسها التي صوّرت ظهرها، وثبّت الهاتف في إضاءة جيدة.` };
    }
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
      await new Promise((r) => setTimeout(r, 900));
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
      if (!out.ok) throw Object.assign(new Error(out.error || "تعذر الإرسال"), { fromServer: true });
      $("direct").classList.add("hidden");
      $("done").classList.remove("hidden");
      $("again").classList.add("hidden");
      try { sessionStorage.removeItem("census"); } catch (e) { /* */ }
    } catch (e) {
      btn.disabled = false;
      msg.className = "hint bad";
      msg.textContent = (e && e.fromServer ? e.message + ". " : "تعذر الإرسال. تأكد من الإنترنت وأعد المحاولة، ") + "أو أرسلها بالواتساب من الأسفل.";
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
