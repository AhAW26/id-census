/**
 * استقبال صور جرد الهويات من صفحة الجرد وحفظها في Google Drive.
 *
 * التفعيل (مرة واحدة): script.google.com ← مشروع جديد ← الصق هذا الملف ← Deploy ← New deployment
 * ← النوع Web app ← Execute as: Me ← Who has access: Anyone ← Deploy، ثم ضع رابط Web app في config.js.
 * بعد تعديل هذا الملف: Deploy ← Manage deployments ← تعديل (القلم) ← Version: New version ← Deploy
 * (يبقى الرابط نفسه).
 *
 * كل صورة تُحفظ في مجلد «جرد الهويات» باسم census-<رقم الحاسبة>-<الوقت>.jpg.
 * وفي المجلد نفسه جدول «سجل جرد الهويات» فيه ورقتان:
 *  - «الموظفون»: أرقام الحاسبة المسموح لها بالإرسال (عمود A). إن تُركت فارغة يُقبل أي رقم.
 *  - «الإرسالات»: كل إرسال مقبول. لكل رقم حاسبة إرسال واحد؛ للسماح لموظف بالإعادة احذف صفه.
 * إرسال «هويتي معي» (باركوده مطابق) يحل محل إرسال سابق «لا أملك هوية» أو «مفقودة» للرقم نفسه.
 *
 * لاستيراد الصور: نزّل المجلد من Drive (يُنزّل ملفاً مضغوطاً) واختره في البرنامج:
 * جرد الهويات ← استيراد صور الجرد.
 */
const FOLDER_NAME = "جرد الهويات";
const BOOK_NAME = "سجل جرد الهويات";
const EMP_SHEET = "الموظفون";
const LOG_SHEET = "الإرسالات";
const MAX_BYTES = 8 * 1024 * 1024;   // أكبر صورة مقبولة
const MAX_PER_HOUR = 10;             // أقصى محاولات لرقم الحاسبة الواحد في الساعة
const DONE_MSG = "تم استلام جردك سابقاً، ولا حاجة لإعادة الإرسال. للتصحيح راجع وحدة المعلومات.";

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse(e.postData.contents);
    const parts = String(body.payload || "").split("|");
    if (parts[0] !== "PRDC1" || !/^\d{1,7}$/.test(parts[1] || "") || !/^07\d{9}$/.test(parts[2] || "")
        || ["have", "none", "lost"].indexOf(parts[3]) < 0) {
      return reply_({ ok: false, error: "بيانات غير صحيحة" });
    }
    const emp = String(parseInt(parts[1], 10)), answer = parts[3];
    const bytes = Utilities.base64Decode(String(body.image || ""));
    if (!bytes.length || bytes.length > MAX_BYTES || bytes[0] !== -1 || bytes[1] !== -40) {  // JPEG يبدأ بـ FF D8
      return reply_({ ok: false, error: "الصورة غير صالحة" });
    }
    const cache = CacheService.getScriptCache();
    const key = "n" + emp;
    const count = Number(cache.get(key) || 0);
    if (count >= MAX_PER_HOUR) return reply_({ ok: false, error: "أرسلت مرات كثيرة. حاول بعد ساعة." });
    cache.put(key, String(count + 1), 3600);
    if (!known_(emp)) return reply_({ ok: false, error: "رقم الحاسبة غير موجود في قائمة الموظفين. راجع وحدة المعلومات." });

    if (!lock.tryLock(15000)) return reply_({ ok: false, error: "الخدمة مشغولة، حاول بعد لحظات." });
    const prev = previous_(emp);
    if (prev && (prev.answer === "have" || answer !== "have")) return reply_({ ok: false, done: true, error: DONE_MSG });

    const stamp = Utilities.formatDate(new Date(), "Asia/Baghdad", "yyyyMMdd-HHmmss");
    const name = "census-" + emp + "-" + stamp + ".jpg";
    const file = folder_().createFile(Utilities.newBlob(bytes, "image/jpeg", name));
    const log = sheet_(LOG_SHEET);
    if (prev) {  // «هويتي معي» تحل محل جواب سابق بلا هوية
      try { DriveApp.getFileById(prev.fileId).setTrashed(true); } catch (err) { /* حُذف سابقاً */ }
      log.deleteRow(prev.row);
    }
    log.appendRow([new Date(), emp, "'" + parts[2], answer, parts[4] === "0" ? "لا" : "نعم", name, file.getId()]);
    return reply_({ ok: true, name: name });
  } catch (err) {
    return reply_({ ok: false, error: "تعذر الحفظ" });
  } finally {
    lock.releaseLock();
  }
}

// ?emp=رقم الحاسبة: هل الرقم في قائمة الموظفين، وهل أرسل سابقاً (وبأي جواب)
function doGet(e) {
  const emp = String((e && e.parameter && e.parameter.emp) || "");
  if (!/^\d{1,7}$/.test(emp)) return reply_({ ok: true, service: "id-census" });
  const n = String(parseInt(emp, 10));
  const prev = previous_(n);
  return reply_({ ok: true, known: known_(n), done: prev ? prev.answer : null });
}

function known_(emp) {
  const cache = CacheService.getScriptCache();
  let list = cache.get("emps");
  if (list === null) {
    const sh = sheet_(EMP_SHEET);
    const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
    list = "," + rows.map((r) => String(r[0]).trim()).filter((v) => /^\d+$/.test(v))
      .map((v) => String(parseInt(v, 10))).join(",") + ",";
    cache.put("emps", list, 600);  // تحديث القائمة يظهر خلال 10 دقائق
  }
  return list === ",," || list.indexOf("," + emp + ",") >= 0;
}

function previous_(emp) {
  const sh = sheet_(LOG_SHEET);
  const n = sh.getLastRow() - 1;
  if (n < 1) return null;
  const rows = sh.getRange(2, 1, n, 7).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]) === emp) return { row: i + 2, answer: String(rows[i][3]), fileId: String(rows[i][6]) };
  }
  return null;
}

function book_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("BOOK_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (err) { /* حُذف: يُنشأ من جديد */ } }
  const book = SpreadsheetApp.create(BOOK_NAME);
  book.getSheets()[0].setName(EMP_SHEET).appendRow(["رقم الحاسبة"]);
  book.insertSheet(LOG_SHEET).appendRow(["الوقت", "رقم الحاسبة", "الهاتف", "الجواب", "الوجه متحقق", "الملف", "معرّف الملف"]);
  DriveApp.getFileById(book.getId()).moveTo(folder_());
  props.setProperty("BOOK_ID", book.getId());
  return book;
}

function sheet_(name) {
  const book = book_();
  return book.getSheetByName(name) || book.insertSheet(name);
}

function folder_() {
  const found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

// شغّلها مرة واحدة من المحرر (Run) لإنشاء الجدول ومنح الصلاحيات
function setup() {
  Logger.log(book_().getUrl());
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
