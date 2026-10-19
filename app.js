/* صفحة جرد الهويات: تصوير وجه الهوية وظهرها بالكاميرا مباشرة، وفحص كل لقطة قبل قبولها
   (الهوية تملأ الإطار على ورقة بيضاء، صورة واضحة بلا انعكاس، وباركود الظهر يطابق رقم الحاسبة)،
   ثم تجميعها في صورة واحدة يرسلها الموظف بالواتساب. لا تحفظ الصفحة ولا ترسل أي بيانات بنفسها.

   الصورة المجمّعة يقرؤها برنامج الشعبة عند الاستيراد، فأبعادها ثابتة (يجب أن تطابق app/badges/census.py):
   عرض 1600، رأس 220 فيه رمز QR نصه PRDC1|رقم الحاسبة|الهاتف|الإجابة، ثم الوجه 1600×1010، فراغ 20، ثم الظهر 1600×1010. */
(() => {
  "use strict";
  const CFG = window.CENSUS_CONFIG || {};
  const W = 1600, HDR = 220, CH = 1010, GAP = 20;
  const RATIO = 85.6 / 54;           // مقاس الهوية
  const SHARP_MIN = 250;             // حدة الصورة (تباين لابلاس على عرض 480)
  const NEED = { front: 3, back: 2 };  // لقطات خضراء متتالية قبل الالتقاط التلقائي
  const ANSWERS = { have: "هويتي معي", none: "لا أملك هوية", lost: "هويتي مفقودة" };

  const $ = (id) => document.getElementById(id);
  const state = { emp: "", phone: "", answer: "", side: "front", front: null, back: null, stream: null,
                  running: false, okRun: 0, lastOk: false, image: null };

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
      openCamera("front");
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
    $("cam-step").textContent = side === "front" ? "1 من 2" : "2 من 2";
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
      return { ok: true, msg: "ممتاز، ثبّت الهاتف…", canvas: full.canvas };
    }
    if (!code) return { ok: false, msg: "لم يُقرأ الباركود بعد. ثبّت الهاتف حتى يظهر الباركود كاملاً وواضحاً." };
    if (code.emp !== String(parseInt(state.emp, 10)))
      return { ok: false, msg: `هذه الهوية تعود لرقم الحاسبة ${code.emp || "غير معروف"}، وليست لرقم ${state.emp}. صوّر هويتك أنت.` };
    return { ok: true, msg: `الباركود مطابق · رقم الهوية ${code.card || "-"}`, canvas: full.canvas, code };
  }

  async function capture(res) {
    state.running = false;
    state[state.side] = res.canvas;
    if (state.side === "front") {
      setHint("تم تصوير الوجه ✓ الآن اقلب الهوية وصوّر الظهر.", "ok");
      await new Promise((r) => setTimeout(r, 900));
      openCamera("back");
      return;
    }
    stopCamera();
    await finish();
  }

  $("cam-shot").addEventListener("click", async () => {
    if (!state.lastOk) return;
    state.running = false;
    const res = await analyse();
    if (res.ok) capture(res); else { setHint(res.msg, "bad"); state.running = true; loop(); }
  });
  $("cam-back").addEventListener("click", () => {
    stopCamera();
    if (state.side === "back" && state.front) { state.front = null; openCamera("front"); return; }
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
    const qr = await qrBitmap(`PRDC1|${state.emp}|${state.phone}|${state.answer}`);
    x.imageSmoothingEnabled = false;
    x.drawImage(qr, 20, 20, 180, 180);
    x.imageSmoothingEnabled = true;
    x.direction = "rtl"; x.textAlign = "right"; x.fillStyle = "#1d2b3a";
    x.font = "800 46px Almarai, sans-serif";
    x.fillText(`${CFG.title || "جرد الهويات"} · رقم الحاسبة ${state.emp}`, W - 30, 78);
    x.font = "400 34px Almarai, sans-serif";
    x.fillText(`الهاتف ${state.phone} · ${ANSWERS[state.answer]}`, W - 30, 136);
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
    const msg = `جرد الهويات\nرقم الحاسبة: ${state.emp}\n${ANSWERS[state.answer]}\nسأرسل الصورة الآن.`;
    $("wa-chat").href = `https://wa.me/${CFG.whatsappIntl}?text=${encodeURIComponent(msg)}`;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [state.image] }));
    $("share").classList.toggle("hidden", !canShare);
    $("share-note").textContent = canShare
      ? "إن لم يظهر الواتساب في قائمة المشاركة، احفظ الصورة ثم أرفقها في المحادثة من الاستوديو."
      : "هاتفك لا يدعم الإرسال المباشر: احفظ الصورة ثم أرفقها في محادثة الوحدة من الاستوديو.";
    show("step-send");
  }

  $("share").addEventListener("click", async () => {
    try { await navigator.share({ files: [state.image], text: `جرد الهويات · رقم الحاسبة ${state.emp}` }); }
    catch (e) { /* أغلق الموظف نافذة المشاركة */ }
  });
  $("again").addEventListener("click", () => {
    if (state.answer === "have") { state.front = state.back = null; openCamera("front"); } else show("step-info");
  });
})();
