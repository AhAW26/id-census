/**
 * استقبال صور جرد الهويات من صفحة الجرد وحفظها في Google Drive.
 *
 * التفعيل (مرة واحدة): script.google.com ← مشروع جديد ← الصق هذا الملف ← Deploy ← New deployment
 * ← النوع Web app ← Execute as: Me ← Who has access: Anyone ← Deploy، ثم ضع رابط Web app في config.js.
 *
 * كل صورة تُحفظ في مجلد «جرد الهويات» باسم census-<رقم الحاسبة>-<الوقت>.jpg.
 * لاستيرادها: نزّل المجلد من Drive (يُنزّل ملفاً مضغوطاً) واختره في البرنامج:
 * جرد الهويات ← استيراد صور الجرد.
 */
const FOLDER_NAME = "جرد الهويات";
const MAX_BYTES = 8 * 1024 * 1024;   // أكبر صورة مقبولة
const MAX_PER_HOUR = 10;             // أقصى إرسال لرقم الحاسبة الواحد في الساعة

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const payload = String(body.payload || "");
    const parts = payload.split("|");
    if (parts[0] !== "PRDC1" || !/^\d{1,7}$/.test(parts[1] || "") || !/^07\d{9}$/.test(parts[2] || "")) {
      return reply_({ ok: false, error: "بيانات غير صحيحة" });
    }
    const emp = parts[1];
    const bytes = Utilities.base64Decode(String(body.image || ""));
    if (!bytes.length || bytes.length > MAX_BYTES || bytes[0] !== -1 || bytes[1] !== -40) {  // JPEG يبدأ بـ FF D8
      return reply_({ ok: false, error: "الصورة غير صالحة" });
    }
    const cache = CacheService.getScriptCache();
    const key = "n" + emp;
    const count = Number(cache.get(key) || 0);
    if (count >= MAX_PER_HOUR) return reply_({ ok: false, error: "أرسلت مرات كثيرة. حاول بعد ساعة." });
    cache.put(key, String(count + 1), 3600);

    const stamp = Utilities.formatDate(new Date(), "Asia/Baghdad", "yyyyMMdd-HHmmss");
    const name = "census-" + emp + "-" + stamp + ".jpg";
    folder_().createFile(Utilities.newBlob(bytes, "image/jpeg", name));
    return reply_({ ok: true, name: name });
  } catch (err) {
    return reply_({ ok: false, error: "تعذر الحفظ" });
  }
}

function doGet() {
  return reply_({ ok: true, service: "id-census" });
}

function folder_() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
