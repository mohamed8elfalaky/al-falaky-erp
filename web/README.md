# Al-Falaky Smart ERP — GitHub Pages Snapshot

نسخة ويب ثابتة (Static — بلا خطوة بناء وبلا خادم) من نظام الفلكي لإدارة قطع
غيار السيارات، جاهزة للنشر على GitHub Pages من مستودع
`mohamed8elfalaky/al-falaky-erp`.

## النشر على GitHub Pages

```bash
git add web/
git commit -m "Add static ERP snapshot (GitHub Pages)"
git push origin main
```

ثم في GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main → Folder: /web** — وسيُنشر الموقع على:

`https://mohamed8elfalaky.github.io/al-falaky-erp/`

## الملفات

| الملف | الوصف |
|---|---|
| `index.html` | هيكل التطبيق (RTL، عربي، خط Cairo) — شاشة دخول أولاً ثم لوحة التحكم |
| `styles.css` | التصميم الكحلي الداكن المطابق للصورة المرجعية |
| `app.js` | منطق التطبيق: Firebase Auth + Firestore + POS + مسح باركود/QR |
| `README.md` | هذا الملف |

## الاتصال بـ Firebase

المشروع: **al-falaky-erp** — Firestore في `eur3` بوضع الإنتاج، و
Email/Password مفعّل. الإعدادات مضمّنة في `app.js` (مفاتيح عميل عامة فقط —
ليست أسراراً، ولا يوجد أي service account في هذه الملفات).

## الدخول

- القفل الوحيد هو **Firebase Auth** — لا يوجد أي باسورد مشترك في الكود.
- التسجيل مغلق: الحسابات ينشئها المالك فقط من صفحة «إدارة الموظفين».
- أول مستخدم (المالك): `mo.elfalaky7@gmail.com` — دوره `owner`.
- قواعد Firestore تتطلب تصاريح مخصصة (`orgId` / `role` / `branchIds`) في
  الـ token؛ تُضبط بسكربت `../firebase/set-custom-claims.js`، وبعدها يسجّل
  المستخدم خروجاً ودخولاً من جديد.

## الصلاحيات

- **المالك** يرى كل الصفحات: لوحة التحكم، المبيعات، المشتريات، المخزون،
  الحسابات، التقارير، العملاء، الموردون، الفروع، الموظفون، الإعدادات.
- **الموظف** يرى فقط الواجهات المكتوبة في مستند `users` الخاص به
  (`interfaces` + `permissions`) — والإخفاء في الواجهة فقط؛ فرض الوصول
  الحقيقي للبيانات يتم عبر قواعد Firestore.

## ملاحظات مهمة

- كل الأرقام في لوحة التحكم والتقارير تأتي من استعلامات Firestore الحية؛
  عند عدم وجود بيانات تظهر حالات فارغة نظيفة (لا أرقام مثال مضمّنة).
- الفلوس بالقرش (integer piasters) في Firestore وتُعرض بالجنيه.
- البيع يكتب فاتورة + بنود + حركات مخزون في دفعة واحدة. رصيد
  `stockBalances` لا يُكتب من العميل (قواعد Firestore تمنع ذلك) — يُحدَّث
  من الخادم الموثوق / Cloud Function بناءً على حركات المخزون.
- المسح بالكاميرا يستخدم `BarcodeDetector` + `getUserMedia`، مع إدخال
  يدوي للكود كبديل، ومسار «إضافة منتج جديد» مملوء بالكود غير المسجّل.
- إيقاف موظف يمنعه من الدخول؛ «الحذف» يعني الإيقاف فقط — مبيعاته
  وسجلاته السابقة لا تُحذف أبداً.
