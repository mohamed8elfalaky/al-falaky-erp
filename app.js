// ============================================================================
// Al-Falaky Smart ERP — GitHub Pages snapshot (static, no build step)
// الفلكي لقطع غيار السيارات
// ----------------------------------------------------------------------------
// • القفل الوحيد هو Firebase Auth — لا يوجد أي باسورد مشترك في هذا الكود.
// • كل الأرقام تأتي من استعلامات Firestore الحية — لا أرقام مثال مُضمّنة.
// • الفلوس بالقرش (integer piasters) في Firestore، وتُعرض بالجنيه (÷100).
// • المخزون يُحدَّث محلياً: البيع/الشراء يكتب فاتورة + بنود + حركات مخزون
//   + تحديث رصيد stockBalances، الكل في معاملة واحدة (revision 9).
// ============================================================================
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, limit,
  addDoc, setDoc, updateDoc, writeBatch, runTransaction, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// --- إعدادات مشروع Firebase (مفاتيح عميل عامة — ليست أسراراً) ---
const firebaseConfig = {
  apiKey: 'AIzaSyAwjkKIi1IhOuKaMSFc9FdF5nT5adFuHG0',
  authDomain: 'al-falaky-erp.firebaseapp.com',
  projectId: 'al-falaky-erp',
  storageBucket: 'al-falaky-erp.firebasestorage.app',
  messagingSenderId: '36476864001',
  appId: '1:36476864001:web:9e105f9dd07acfa74ee200'
};
const ORG_ID = 'org_alfalaky';          // يُستبدل بـ claims.orgId بعد الدخول
const DEFAULT_BRANCH = 'branch_main';   // الفرع الرئيسي (من ملف seed)

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- حالة الجلسة ---
let me = null;          // { uid, email, displayName, role, orgId, branchIds, interfaces, permissions, isActive }
let orgId = ORG_ID;
let branches = [];      // [{id, name_ar}]
let warehouses = [];
let categories = [];
let brands = [];
let vehicles = []; // revision 11e: لصفحة الكتالوج (حذف المركبات)
let suppliersCache = []; // [{id, name_ar}] — للمورد في نموذج المنتج وبطاقاته
let latestAlerts = [];   // تنبيهات لوحة التحكم الأخيرة (للجرس)
let dashRange = 6;       // مدى الرسم الخطي: 3 / 6 / 12 شهر
let branchRange = 'month'; // مدى أداء الفروع: month / quarter / all
let uiLang = 'ar';       // لغة الواجهة: ar / en (الكروم فقط)
let productsCache = []; // منتجات محملة للبحث السريع
let balancesCache = {}; // productId -> quantity
let currentPage = 'dashboard';
let posCart = [];       // [{product, qty}]
let charts = {};        // Chart.js instances (لتدميرها قبل إعادة الرسم)

// --- أدوات مساعدة ---
const $ = (id) => document.getElementById(id);
const fmtEGP = (piasters) => (Number(piasters || 0) / 100)
  .toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
const fmtEGPNum = (piasters) => (Number(piasters || 0) / 100)
  .toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString('ar-EG');
// نسب صحيحة مجموعها 100 دائماً (أكبر باقي — Largest Remainder)
function shares100(values) {
  const total = values.reduce((a, v) => a + Number(v || 0), 0);
  if (!total) return values.map(() => 0);
  const raw = values.map((v) => (Number(v || 0) / total) * 100);
  const base = raw.map((r) => Math.floor(r));
  let left = 100 - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - base[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < left; k++) base[order[k % order.length][1]]++;
  return base;
}
// عدّادات فخمة: عدّ تصاعدي لقيم KPI عند أول عرض للوحة (القيم النهائية لا تتغير أبداً)
let kpiCountUpDone = false;
function animateKpiCountUps() {
  if (kpiCountUpDone) return;
  kpiCountUpDone = true;
  const els = document.querySelectorAll('.kpi .value[data-countup]');
  if (!els.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // القيم النهائية معروضة أصلاً في القالب
  els.forEach((el) => {
    const target = Number(el.dataset.countup || 0);
    const kind = el.dataset.countupFmt || 'egp';
    const textNode = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!textNode) return;
    const format = (v) => kind === 'egp' ? fmtEGPNum(v) : kind === 'int-en' ? Math.round(v).toLocaleString('en-US') : fmtNum(v);
    const dur = 900;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      textNode.nodeValue = format(target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else textNode.nodeValue = format(target); // القيمة النهائية بالظبط
    };
    requestAnimationFrame(tick);
  });
}
// نسبة التغير بين الشهر الحالي والشهر السابق (من بيانات Firestore الحقيقية)
function pctDelta(cur, prev) {
  if (!prev || Number(prev) === 0) return { text: '—', cls: 'flat' };
  const d = Math.round(((Number(cur) - Number(prev)) / Number(prev)) * 100);
  if (d === 0) return { text: '0%', cls: 'flat' };
  return { text: `${d > 0 ? '↑' : '↓'} ${Math.abs(d)}%`, cls: d > 0 ? 'up' : 'down' };
}
// وقت نسبي بالعربي: منذ 5 دقائق / منذ ساعة / منذ يومين...
function relTime(t) {
  const d = tsToDate(t); if (!d || isNaN(d)) return 'الآن';
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} ${mins === 1 ? 'دقيقة' : mins === 2 ? 'دقيقتين' : 'دقيقة'}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ${hrs === 1 ? 'ساعة' : hrs === 2 ? 'ساعتين' : 'ساعة'}`;
  const days = Math.floor(hrs / 24);
  return `منذ ${days} ${days === 1 ? 'يوم' : days === 2 ? 'يومين' : 'يوم'}`;
}
// أيقونة حسب التصنيف (لصور مصغرة لقائمة الأكثر مبيعاً)
function categoryIcon(catId) {
  const name = categoryName(catId || '');
  if (/فرامل|brake/i.test(name)) return '🛑';
  if (/فلتر|filter/i.test(name)) return '🛢️';
  if (/محرك|engine/i.test(name)) return '⚙️';
  if (/كهرب|electr/i.test(name)) return '🔌';
  if (/تعليق|suspension/i.test(name)) return '🔩';
  if (/إطار|tire|tyre/i.test(name)) return '🛞';
  return '🔧';
}
const toPiasters = (egp) => Math.round(Number(egp || 0) * 100);
// --- تنبيه Toast غير مزعج (بديل للـ alert بعد الحفظ) ---
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// شارة «تجريبي» لأي مستند مُعلَّم isDemo:true في Firestore
const demoBadge = (d) => (d && d.isDemo) ? ' <span class="badge demo">🧪 تجريبي</span>' : '';
const tsToDate = (t) => (t && t.toDate) ? t.toDate() : (t instanceof Date ? t : new Date(t));
function showError(el, msg) { el.textContent = msg; el.classList.add('show'); }
function hideError(el) { el.textContent = ''; el.classList.remove('show'); }
function emptyState(text) { return `<div class="empty">${text}</div>`; }
function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

// ترجمة أخطاء Firebase إلى عربي واضح
function authErrorMessage(code) {
  return {
    'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحة. تأكد أنك كتبت كلمة مرور الحساب (ليست كلمة مرور فتح الواجهة — الفتح موجود في نسخة التطبيق الكاملة فقط، وهنا الدخول بكلمة مرور الحساب مباشرة).',
    'auth/user-not-found': 'لا يوجد حساب بهذا البريد الإلكتروني.',
    'auth/wrong-password': 'كلمة المرور غير صحيحة.',
    'auth/user-disabled': 'هذا الحساب موقوف — راجع المالك.',
    'auth/too-many-requests': 'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً.',
    'auth/network-request-failed': 'تعذّر الوصول لخدمة المصادقة من هذا المتصفح — تحقق من الإنترنت أو جرّب متصفحاً آخر (رسالة الشبكة، وليست خطأ في كلمة المرور).',
    'auth/email-already-in-use': 'هذا البريد مسجّل بالفعل.'
  }[code] || 'تعذّر تسجيل الدخول — حاول مجدداً.';
}
function firestoreErrorMessage(err) {
  if (err && err.message === 'NO_CASHBOX') {
    return 'لا يوجد صندوق نقدي نشط لهذا الفرع — اطلب من المالك تشغيل التهيئة (زر التهيئة في الإعدادات) لإنشاء الصندوق أولاً. لم يُسجَّل أي شيء.';
  }
  if (err && err.message === 'NO_BANK_ACCOUNT') {
    return 'لا يوجد حساب بنكي نشط لهذه المنظمة — اطلب من المالك تشغيل التهيئة (زر التهيئة في الإعدادات) لإنشاء الحساب البنكي أولاً. لم يُسجَّل أي شيء.';
  }
  if (err && err.message === 'NO_STOCK_BALANCE') {
    return 'لا يوجد رصيد مخزون مسجل لأحد الأصناف — اطلب من المالك تشغيل التهيئة (زر التهيئة في الإعدادات) لإنشاء سجل الرصيد أولاً. لم يُسجَّل أي شيء.';
  }
  if (err && err.message === 'INSUFFICIENT_STOCK') {
    return 'المخزون لا يكفي — الكمية المطلوبة أكبر من الرصيد المتاح لأحد الأصناف. لم يُسجَّل أي شيء.';
  }
  if (err && err.code === 'permission-denied') {
    // revision 11f: a denied read/write may mean the account was just
    // deleted/deactivated — re-check the session (fire-and-forget) and
    // sign out if so. A legitimate permission error leaves the session
    // alone (checkSessionValid re-reads the users doc first).
    checkSessionValid();
    return 'رفضت قواعد Firestore الوصول. إن كان حسابك قد أُوقف أو حُذف فستُسجَّل خروجك الآن — راجع المالك. وإلا فحسابك يحتاج تصاريح (orgId / role / branchIds) يضبطها المالك بسكربت set-custom-claims.js ثم تسجّل خروج ودخول من جديد.';
  }
  return (err && err.message) || 'خطأ غير متوقع أثناء قراءة البيانات.';
}

// revision 11, Issue 1: فشل حتمي — المعاملة لم تلتزم إطلاقاً، فالعملية
// المعلقة قديمة ويجب مسحها حتى لا تحظر العملية التالية بتحذير مضلل.
// (بعد رفض "رصيد غير كافٍ" بقيت العملية المعلقة وحظرت الدفعة التالية.)
// الفشل الغامض (شبكة/مهلة/تعارض) لا يمسح — قد تكون المعاملة التزمت
// وفقد التأكيد، فتبقى العملية المعلقة للتسوية عبر العلامة.
function isDefinitiveSaveFailure(err) {
  if (!err) return false;
  const m = err.message || '';
  if (m === 'INSUFFICIENT_FUNDS' || m === 'INSUFFICIENT_STOCK' || m === 'NO_STOCK_BALANCE' || m === 'NO_CASHBOX' || m === 'NO_BANK_ACCOUNT') return true;
  if (err.code === 'permission-denied' || /permission-denied/i.test(m)) return true;
  return false;
}

// revision 11, Issue 2: رسالة صلاحية واضحة حسب الدور. إن كان الدور نفسه
// لا يسمح بهذا الإجراء أصلاً (مثلاً مبيعات يدفع لمورد)، فالمشكلة ليست في
// الاتصال ولا في التصاريح — بل في الدور. تعيد null إن كان الدور مسموحاً
// (حينها الرفض مشكلة تصاريح فعلية ويُستخدم firestoreErrorMessage).
function roleDeniedMessage(allowedRoles, actionLabel) {
  if (!me || !allowedRoles || allowedRoles.includes(me.role)) return null;
  return `دورك (${roleLabel(me.role)}) لا يسمح بـ${actionLabel}. هذه العملية مسموحة لـ: ${allowedRoles.map((r) => roleLabel(r)).join('، ')}. اطلب من المالك أو من لديه الصلاحية.`;
}

// ============================================================================
// 1) تسجيل الدخول — Firebase Auth فقط
// ============================================================================
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError($('login-error'));
  $('login-btn').disabled = true;
  $('login-btn').textContent = 'جارٍ تسجيل الدخول...';
  try {
    // نفس تطبيع شاشة الفتح: تجاهل المسافات الطرفية وتحويل الأرقام العربية للاتينية
    const normPass = $('login-password').value.trim().replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    await signInWithEmailAndPassword(auth, $('login-email').value.trim(), normPass);
    // onAuthStateChanged يتولى الباقي
  } catch (err) {
    showError($('login-error'), authErrorMessage(err.code));
  } finally {
    $('login-btn').disabled = false;
    $('login-btn').textContent = 'تسجيل الدخول';
  }
});

$('logout-btn').addEventListener('click', async () => { await signOut(auth); location.reload(); });

onAuthStateChanged(auth, async (user) => {
  if (!user) { $('login-screen').classList.remove('hidden'); $('app').classList.add('hidden'); return; }
  try {
    // التصاريح المخصصة من الـ token (orgId / role / branchIds)
    const token = await user.getIdTokenResult(true);
    const claims = token.claims || {};
    // ملف المستخدم في Firestore (فيه interfaces و permissions للموظفين)
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    // revision 11f: حساب بلا مستند مستخدم (حُذف من صفحة الموظفين) لا
    // يدخل التطبيق أبداً — إلا المالك (دخوله من تصاريح الـ token وحدها،
    // وقد لا يكون له مستند مستخدم). بلا هذا الفحص كان المحذوف يدخل
    // بواجهات أكثر من قبل (interfaces = null تعني كل الواجهات) وتصاريح
    // الـ token نفسها ما زالت تمرر القواعد.
    if (!userSnap.exists() && claims.role !== 'owner') {
      await signOut(auth);
      showError($('login-error'), 'هذا الحساب محذوف — راجع المالك.');
      return;
    }
    const profile = userSnap.exists() ? userSnap.data() : {};
    if (profile.isActive === false) {
      await signOut(auth);
      showError($('login-error'), 'هذا الحساب موقوف — راجع المالك.');
      return;
    }
    me = {
      uid: user.uid,
      email: user.email,
      displayName: profile.displayName_ar || profile.displayName_en || user.email,
      // revision 11f (rules-level): the owner is the token claim. For a
      // non-owner, the role comes from the users doc — NOT the token
      // claim — so an owner demotion/promotion takes effect at once
      // (mirrors the rules' effectiveRole()). The login gate above
      // already ensured a non-owner HAS a users doc.
      role: claims.role === 'owner' ? 'owner' : (profile.role || 'sales'),
      orgId: claims.orgId || profile.orgId || ORG_ID,
      branchIds: claims.branchIds || profile.branchIds || ['*'],
      interfaces: profile.interfaces || null,   // null = كل الواجهات حسب الدور
      permissions: profile.permissions || {}
    };
    orgId = me.orgId;
    $('login-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('user-name').textContent = me.displayName;
    $('user-role').textContent = roleLabel(me.role);
    $('user-avatar').textContent = (me.displayName || '?').trim().charAt(0);
    startLiveClock();
    // revision 11f: re-check the session every 60s, so an already-open
    // session dies even without navigation after a delete/deactivation.
    setInterval(() => { checkSessionValid(); }, 60000);
    await loadLookups();
    // تسوية أي عمليات معلقة من تبويب سابق أُغلق أثناء الحفظ (localStorage).
    // العمليات الملتزمة تُمسح وتُعرض قيمها؛ غير الملتزمة والمجهولة تُترك
    // ليسوّيها الحفظ التالي قبل أي استبدال.
    reconcilePendingOpsOnLoad();
    buildNav();
    await go('dashboard');
  } catch (err) {
    showError($('login-error'), firestoreErrorMessage(err));
    $('login-screen').classList.remove('hidden');
  }
});

// --- revision 11f (rules-level): re-check that this session is still valid ---
// A deleted/deactivated non-owner is denied EVERY read and write by the
// rules, so an already-open session must die on its next operation.
// Called on navigation, on a timer, and whenever a Firestore operation
// fails with permission-denied. A legitimate permission error leaves the
// session alone (the users doc is re-read first).
async function checkSessionValid() {
  if (!me || me.role === 'owner') return true;
  try {
    const snap = await getDoc(doc(db, 'users', me.uid));
    if (!snap.exists() || snap.data().isActive === false) {
      await signOut(auth);
      showError($('login-error'), 'تم إيقاف حسابك أو حذفه — راجع المالك.');
      return false;
    }
    return true;
  } catch (e) {
    // Reading your own users doc is allowed by the rules; a
    // permission-denied here also means the account is blocked.
    if (e && e.code === 'permission-denied') {
      await signOut(auth);
      showError($('login-error'), 'تم إيقاف حسابك أو حذفه — راجع المالك.');
      return false;
    }
    return true; // network error — do not sign out on a transient failure
  }
}

function roleLabel(role) {
  return { owner: 'المالك', manager: 'مدير عام', accountant: 'محاسب', sales: 'موظف مبيعات',
    inventory: 'أمين مخزن', storekeeper: 'أمين مستودع' }[role] || role;
}
function isOwner() { return me && me.role === 'owner'; }

// ============================================================================
// 2) التنقل — المالك يرى كل شيء، والموظف يرى فقط واجهاته
// ============================================================================
const NAV = [
  { id: 'dashboard',  label: 'الرئيسية',        ico: '🏠', ownerOnly: false },
  { id: 'sales',      label: 'المبيعات',        ico: '🛒', ownerOnly: false },
  { id: 'purchases',  label: 'المشتريات',      ico: '🛍️', ownerOnly: false },
  { id: 'products',   label: 'المنتجات',        ico: '📦', ownerOnly: false },
  { id: 'inventory',  label: 'المخزون',        ico: '🗃️', ownerOnly: false },
  { id: 'accounts',   label: 'الحسابات',       ico: '💰', ownerOnly: true  },
  { id: 'settlement', label: 'تسوية الصندوق',   ico: '⚖️', ownerOnly: false },
  { id: 'reports',    label: 'التقارير والتحليلات', ico: '📊', ownerOnly: true },
  { id: 'customers',  label: 'إدارة العملاء',   ico: '👥', ownerOnly: false },
  { id: 'suppliers',  label: 'إدارة الموردين',  ico: '🤝', ownerOnly: false },
  { id: 'debts-customers', label: 'مديونيات العملاء', ico: '💳', ownerOnly: false },
  { id: 'debts-suppliers', label: 'مديونيات الموردين', ico: '🧾', ownerOnly: false },
  { id: 'branches',   label: 'إدارة الفروع',    ico: '📍', ownerOnly: true  },
  { id: 'catalogue',  label: 'إدارة الكتالوج',  ico: '🏷️', ownerOnly: true  },
  { id: 'employees',  label: 'إدارة الموظفين',  ico: '👤', ownerOnly: true  },
  { id: 'settings',   label: 'الإعدادات',      ico: '⚙️', ownerOnly: true  },
  { id: 'help',       label: 'المساعدة والدعم', ico: '❓', ownerOnly: false }
];
const NAV_EN = {
  dashboard: 'Dashboard', sales: 'Sales', purchases: 'Purchases', products: 'Products',
  inventory: 'Inventory', accounts: 'Accounts', settlement: 'Cashbox Settlement', reports: 'Reports & Analytics',
  customers: 'Customers', suppliers: 'Suppliers', branches: 'Branches',
  catalogue: 'Catalogue',
  'debts-customers': 'Customer Debts', 'debts-suppliers': 'Supplier Debts',
  employees: 'Employees', settings: 'Settings', help: 'Help & Support'
};
const ALL_INTERFACES = ['dashboard', 'sales', 'purchases', 'products', 'inventory', 'customers', 'suppliers', 'debts-customers', 'debts-suppliers'];

function visibleNav() {
  if (isOwner()) return NAV;
  // الموظف: فقط الواجهات المكتوبة في مستند users الخاص به
  const allowed = new Set(me.interfaces || ALL_INTERFACES);
  // 'settlement' is role-gated, not interface-gated: it is shown only to a
  // role that can write cashboxes/bankAccounts (owner/manager/accountant),
  // because only they can apply a pending item. Sales/inventory never see it.
  return NAV.filter((n) => n.id === 'dashboard' || n.id === 'help' || allowed.has(n.id)
    || (n.id === 'settlement' && canWriteMoneyBox()));
}
function canSee(page) {
  if (isOwner()) return true;
  if (page === 'dashboard' || page === 'help' || page === 'ai') return true;
  // 'settlement' is role-gated: only owner/manager/accountant may open it.
  if (page === 'settlement') return canWriteMoneyBox();
  return (me.interfaces || ALL_INTERFACES).includes(page);
}
function buildNav() {
  $('main-nav').innerHTML = visibleNav().map((n) =>
    `<button class="nav-item" data-page="${n.id}"><span class="ico">${n.ico}</span> ${uiLang === 'en' ? (NAV_EN[n.id] || n.label) : n.label}</button>`).join('');
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      go(b.dataset.page);
      // في وضع الموبايل يُغلق الدرج بعد الانتقال للصفحة
      if (document.body.classList.contains('mobile-view') || window.innerWidth <= 768) document.body.classList.add('sidebar-hidden');
    }));
}

// --- الساعة الحية في الفوتر + الجرس + اللغة + القائمة ---
function startLiveClock() {
  const tick = () => {
    const el = $('live-clock'); if (!el) return;
    el.textContent = new Date().toLocaleDateString('ar-EG') + ' ' + new Date().toLocaleTimeString('ar-EG');
  };
  tick(); setInterval(tick, 1000);
}
function updateBell() {
  const badge = $('bell-badge');
  if (!badge) return;
  const n = latestAlerts.length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.classList.toggle('hidden', n === 0);
}
function renderNotifDropdown() {
  const dd = $('notif-dropdown'); if (!dd) return;
  dd.innerHTML = '<h4>🔔 التنبيهات</h4>' + (latestAlerts.length
    ? latestAlerts.map((a) => `<div class="notif-item" data-notif-go="${a.page || 'dashboard'}"><span>${a.ico}</span><span>${esc(a.text)}<br><small style="color:var(--muted)">${a.time}</small></span></div>`).join('')
    : '<div class="empty">لا توجد تنبيهات حالياً.</div>');
  dd.querySelectorAll('[data-notif-go]').forEach((el) => el.addEventListener('click', () => { dd.classList.add('hidden'); go(el.dataset.notifGo); }));
}
function toggleLang() {
  uiLang = uiLang === 'ar' ? 'en' : 'ar';
  document.documentElement.lang = uiLang;
  $('lang-btn').textContent = uiLang === 'ar' ? 'English 🌐' : 'عربي 🌐';
  $('global-search').placeholder = uiLang === 'en' ? 'Search product, part number or car...' : 'ابحث عن منتج، رقم قطعة أو سيارة...';
  buildNav();
  if (currentPage) go(currentPage);
}
$('menu-btn').addEventListener('click', () => document.body.classList.toggle('sidebar-hidden'));
$('settings-btn').addEventListener('click', () => go('settings'));
$('lang-btn').addEventListener('click', toggleLang);

// --- تبديل عرض الموبايل / الكمبيوتر — يُحفظ اختيار المستخدم ويُستعاد عند التحميل ---
const VIEW_MODE_KEY = 'alfalaky-view-mode';
function applyViewMode(mode) {
  const mobile = mode === 'mobile';
  document.body.classList.toggle('mobile-view', mobile);
  if (mobile) document.body.classList.add('sidebar-hidden'); // الدرج مغلق افتراضياً في وضع الموبايل
  else document.body.classList.remove('sidebar-hidden'); // الرجوع للكمبيوتر يُظهر القائمة من جديد
  const btn = $('view-toggle-btn');
  if (btn) btn.textContent = mobile ? '🖥️ عرض الكمبيوتر' : '📱 عرض الموبايل';
  try { localStorage.setItem(VIEW_MODE_KEY, mobile ? 'mobile' : 'desktop'); } catch (e) { /* تجاهل */ }
}
let savedViewMode = 'desktop';
try { savedViewMode = localStorage.getItem(VIEW_MODE_KEY) || 'desktop'; } catch (e) { /* تجاهل */ }
if (savedViewMode === 'mobile') applyViewMode('mobile');
// على الشاشات الصغيرة الحقيقية تبدأ القائمة الجانبية مغلقة (درج يُفتح من ☰)
if (window.innerWidth <= 768) document.body.classList.add('sidebar-hidden');
window.addEventListener('resize', () => { if (window.innerWidth <= 768) document.body.classList.add('sidebar-hidden'); });
$('view-toggle-btn').addEventListener('click', () => {
  applyViewMode(document.body.classList.contains('mobile-view') ? 'desktop' : 'mobile');
});
$('ai-start-btn').addEventListener('click', () => go('ai'));
$('bell-btn').addEventListener('click', () => { renderNotifDropdown(); $('notif-dropdown').classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  const dd = $('notif-dropdown');
  if (dd && !dd.classList.contains('hidden') && !e.target.closest('.bell-wrap')) dd.classList.add('hidden');
});

async function go(page) {
  if (!canSee(page)) { $('page').innerHTML = emptyState('ليس لديك صلاحية لعرض هذه الصفحة.'); return; }
  // revision 11f: an already-open session must die when the owner
  // deletes/deactivates the user — re-check before rendering the page.
  if (!(await checkSessionValid())) return;
  currentPage = page;
  window.scrollTo(0, 0); // العنوان يظهر من فوق دائماً ولا يختفي تحت الهيدر الثابت
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === page));
  const renderers = { dashboard: renderDashboard, sales: renderPOS, purchases: renderPurchases,
    products: renderProducts, inventory: renderInventory, accounts: renderAccounts, settlement: renderSettlement, reports: renderReports,
    customers: () => renderContacts('customers'), suppliers: () => renderContacts('suppliers'),
    'debts-customers': () => renderDebts('customers'), 'debts-suppliers': () => renderDebts('suppliers'),
    branches: renderBranches, catalogue: renderCatalogue, employees: renderEmployees, settings: renderSettings,
    ai: renderAI, help: renderHelp };
  if (!renderers[page]) { await go('dashboard'); return; }
  $('page').innerHTML = '<div class="empty">جارٍ تحميل البيانات من Firestore...</div>';
  invoiceItemsCache = {}; // بنود جديدة بعد أي عملية بيع/شراء تُحمّل من جديد
  let loadTimer = null;
  try {
    const timeout = new Promise((_, rej) => { loadTimer = setTimeout(() => rej(new Error('load-timeout')), 30000); });
    await Promise.race([renderers[page](), timeout]);
    clearTimeout(loadTimer);
  }
  catch (err) {
    clearTimeout(loadTimer);
    if (err && err.message === 'load-timeout') {
      $('page').innerHTML = `<div class="error show">التحميل أخذ وقتاً طويلاً — تحقق من الإنترنت ثم اضغط إعادة المحاولة.</div><button class="btn" onclick="location.reload()">↻ إعادة المحاولة</button>`;
    } else {
      $('page').innerHTML = `<div class="error show">${esc(firestoreErrorMessage(err))}</div>`;
    }
  }
}

// بيانات مرجعية: فروع/مخازن/تصنيفات/علامات/مركبات (للقوائم المنسدلة)
async function loadLookups() {
  const [b, w, c, br, v, s] = await Promise.all([
    getDocs(query(collection(db, 'branches'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'warehouses'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'categories'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'brands'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'vehicles'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'suppliers'), where('orgId', '==', orgId), limit(200)))
  ]);
  branches = b.docs.map((d) => ({ id: d.id, ...d.data() }));
  warehouses = w.docs.map((d) => ({ id: d.id, ...d.data() }));
  categories = c.docs.map((d) => ({ id: d.id, ...d.data() }));
  brands = br.docs.map((d) => ({ id: d.id, ...d.data() }));
  vehicles = v.docs.map((d) => ({ id: d.id, ...d.data() }));
  suppliersCache = s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
function branchName(id) { return (branches.find((b) => b.id === id) || {}).name_ar || id || '—'; }
function categoryName(id) { return (categories.find((c) => c.id === id) || {}).name_ar || '—'; }
function brandName(id) { return (brands.find((b) => b.id === id) || {}).name_ar || '—'; }
function supplierName(id) { return (suppliersCache.find((s) => s.id === id) || {}).name_ar || '—'; }
function canSeePrices() { return isOwner() || me.role === 'manager' || me.role === 'accountant'; }

// ============================================================================
// 3) تحميل البيانات من Firestore (كلها مقيدة بـ orgId)
// ملاحظة: الاستعلامات بدون orderBy على الخادم لتجنب الحاجة لفهارس مركبة
// إضافية؛ الترتيب يتم في العميل.
// ============================================================================
async function loadCollection(name, extraWhere = []) {
  let q = query(collection(db, name), where('orgId', '==', orgId), limit(500));
  for (const [field, op, value] of extraWhere) q = query(q, where(field, op, value));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function loadProducts() {
  productsCache = await loadCollection('products');
  const bals = await loadCollection('stockBalances');
  balancesCache = {};
  bals.forEach((b) => { balancesCache[b.productId] = (balancesCache[b.productId] || 0) + Number(b.quantity || 0); });
  return productsCache;
}
function productStock(p) { return balancesCache[p.id] ?? null; } // null = لا يوجد رصيد مسجل بعد

// ============================================================================
// 4) لوحة التحكم — كل المؤشرات من Firestore، وبدون بيانات تظهر حالات فارغة
// ============================================================================
// بنود الفواتير — تُحمّل مرة واحدة بالتوازي وتُحفظ في الذاكرة طوال الجلسة
// (بدل قراءة متسلسلة لبنود كل فاتورة على حدة، اللي كانت تعلّق لوحة التحكم)
let invoiceItemsCache = {}; // invoiceId -> [items]
async function loadInvoiceItems(invoices, coll = 'salesInvoices') {
  if (coll === 'purchaseInvoices') {
    // أصناف فواتير الشراء مضمّنة في مستند الفاتورة نفسه (inv.items) — لا توجد
    // مجموعة فرعية items تحت purchaseInvoices، وقواعد Firestore ترفض قراءتها
    // (هذا الرفض كان يعطّل فتح تفاصيل مديونيات الموردين بالكامل)
    // revision 11d: معرّف اصطناعي لكل بند (كما في loadInvoiceDetail) حتى
    // تكون البنود متسقة الشكل مع بنود المبيعات.
    invoices.forEach((inv) => { invoiceItemsCache[inv.id] = Array.isArray(inv.items) ? inv.items.map((it, i) => ({ id: 'it_' + i, ...it })) : []; });
    return invoiceItemsCache;
  }
  const missing = invoices.filter((inv) => !(inv.id in invoiceItemsCache));
  if (missing.length) {
    const snaps = await Promise.all(missing.map((inv) => getDocs(collection(db, coll, inv.id, 'items'))));
    // revision 11d: كان يُخزَّن d.data() فقط بلا معرّف المستند، فكان
    // it.id غير معرّف في الحذف المتتابع، وdoc(..., 'items', undefined)
    // يرمي "Cannot read properties of undefined (reading 'indexOf')" من
    // داخل Firestore ويفشل الحذف كله. الآن يُخزَّن المعرف مع البيانات.
    snaps.forEach((snap, i) => { invoiceItemsCache[missing[i].id] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  }
  return invoiceItemsCache;
}
// نص التفاصيل لمديونية: للمديونية اليدوية النص المحفوظ وقت التسجيل،
// ولفاتورة عادية ملخص أصنافها (أسماء المنتجات والكميات) — يتعبى تلقائياً
function debtDetailsText(inv, items) {
  if (inv.isManualDebt) return (inv.manualDetails || inv.manualReason || '').trim();
  const list = (items || []).filter((i) => i && (i.productName_ar || i.productName));
  return list.map((i) => `${i.productName_ar || i.productName} × ${fmtNum(i.quantity || 1)}`).join('، ');
}

async function renderDashboard() {
  const [sales, purchases, customers, suppliers, bals, salesPays, purchPays] = await Promise.all([
    loadCollection('salesInvoices'),
    loadCollection('purchaseInvoices'),
    loadCollection('customers'),
    loadCollection('suppliers'),
    loadCollection('stockBalances'),
    loadCollection('salesPayments'),
    loadCollection('purchasePayments')
  ]);
  await loadProducts();
  const posted = sales.filter((s) => s.status === 'posted');
  const postedPurchases = purchases.filter((p) => p.status === 'posted');
  // المديونيات اليدوية ديون وليست مبيعات/مشتريات: تُستبعد من أرقام المبيعات
  // والمشتريات والربح والرسم البياني، وتبقى في بطاقات المديونية فقط
  const tradeSales = posted.filter((s) => !s.isManualDebt);
  const tradePurchases = postedPurchases.filter((p) => !p.isManualDebt);
  const totalSales = tradeSales.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const totalPurchases = tradePurchases.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const monthSum = (list, y, m) => list.filter((s) => { const t = tsToDate(s.date || s.createdAt); return t.getFullYear() === y && t.getMonth() === m; })
    .reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const salesCur = monthSum(tradeSales, now.getFullYear(), now.getMonth());
  const salesPrev = monthSum(tradeSales, prevMonth.getFullYear(), prevMonth.getMonth());
  const purchCur = monthSum(tradePurchases, now.getFullYear(), now.getMonth());
  const purchPrev = monthSum(tradePurchases, prevMonth.getFullYear(), prevMonth.getMonth());
  // الربح = الإيراد − تكلفة البضاعة المباعة (من بنود آخر 60 فاتورة)، وحساب التكلفة حسب الشهر
  const cogsByMonth = {};
  await loadInvoiceItems(tradeSales.slice(0, 60));
  for (const inv of tradeSales.slice(0, 60)) {
    const k = monthKey(tsToDate(inv.date || inv.createdAt));
    (invoiceItemsCache[inv.id] || []).forEach((d) => { cogsByMonth[k] = (cogsByMonth[k] || 0) + Number(d.costPricePiasters || 0) * Number(d.quantity || 0); });
  }
  const cogs = Object.values(cogsByMonth).reduce((a, v) => a + v, 0);
  const profit = totalSales - cogs;
  const profitCur = salesCur - (cogsByMonth[monthKey(now)] || 0);
  const profitPrev = salesPrev - (cogsByMonth[monthKey(prevMonth)] || 0);
  // قيمة المخزون = مجموع (الرصيد × سعر الشراء) للمنتجات النشطة فقط —
  // بعد تنظيف البيانات التجريبية (إيقاف منتجاتها) تختفي قيمتها من هنا،
  // لأن أرصدة stockBalances نفسها لا تُكتب من العميل أبداً.
  const prodById = Object.fromEntries(productsCache.map((p) => [p.id, p]));
  const inventoryValue = bals.reduce((a, b) => {
    const pr = prodById[b.productId] || {};
    if (pr.isActive === false) return a;
    return a + Number(b.quantity || 0) * Number(pr.purchasePricePiasters || 0);
  }, 0);
  const activeCustomers = customers.filter((c) => c.isActive !== false).length;

  // مديونيات العملاء والموردين (مشتقة: المتبقي = الإجمالي − المدفوع أولاً − مجموع الدفعات)
  const salesPayByInv = {};
  salesPays.forEach((p) => { if (p.salesInvoiceId) salesPayByInv[p.salesInvoiceId] = (salesPayByInv[p.salesInvoiceId] || 0) + Number(p.amountPiasters || 0); });
  const purchPayByInv = {};
  purchPays.forEach((p) => { if (p.purchaseInvoiceId) purchPayByInv[p.purchaseInvoiceId] = (purchPayByInv[p.purchaseInvoiceId] || 0) + Number(p.amountPiasters || 0); });
  const openingSum = (list) => list.reduce((a, c) => a + Math.max(0, Number(c.openingBalancePiasters || 0)), 0);
  const custDebtTotal = posted.reduce((a, s) => a + remainingOf(s, salesPayByInv), 0) + openingSum(customers);
  const custDebtCount = posted.filter((s) => remainingOf(s, salesPayByInv) > 0).length;
  const supDebtTotal = postedPurchases.reduce((a, p) => a + remainingOf(p, purchPayByInv), 0) + openingSum(suppliers);
  const supDebtCount = postedPurchases.filter((p) => remainingOf(p, purchPayByInv) > 0).length;
  const debtCardsHTML = `
    <div class="debt-cards">
      <div class="card debt-card" data-go-debts="debts-customers"><div class="kpi-text"><div class="value">${fmtEGPNum(custDebtTotal)}<span class="unit">ج.م</span></div><div class="label">💳 مديونيات العملاء</div><div class="delta flat">${custDebtCount} فاتورة مفتوحة — اضغط للتفاصيل</div></div><div class="ico">💳</div></div>
      <div class="card debt-card" data-go-debts="debts-suppliers"><div class="kpi-text"><div class="value">${fmtEGPNum(supDebtTotal)}<span class="unit">ج.م</span></div><div class="label">🧾 مديونيات الموردين</div><div class="delta flat">${supDebtCount} فاتورة مفتوحة — اضغط للتفاصيل</div></div><div class="ico">🧾</div></div>
    </div>`;

  // أكثر المنتجات مبيعاً (من بنود آخر 60 فاتورة)
  const soldQty = {};
  for (const inv of tradeSales.slice(0, 60)) {
    (invoiceItemsCache[inv.id] || []).forEach((d) => { soldQty[d.productId] = (soldQty[d.productId] || 0) + Number(d.quantity || 0); });
  }
  const best = Object.entries(soldQty).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([pid, qty], i) => ({ rank: i + 1, name: (prodById[pid] || {}).name_ar || pid,
      categoryId: (prodById[pid] || {}).categoryId, partNumber: (prodById[pid] || {}).partNumber || '', qty }));

  // تنبيهات المخزون المنخفض — المنتجات النشطة فقط (الموقوفة لا تُنبَّه عنها)
  const lowStock = productsCache.filter((p) => {
    if (p.isActive === false) return false;
    const q = productStock(p); return q !== null && q > 0 && Number(p.minStock || 0) > 0 && q < Number(p.minStock);
  });
  const outStock = productsCache.filter((p) => p.isActive !== false && productStock(p) === 0);
  const activeProducts = productsCache.filter((p) => p.isActive !== false);
  const inStockPct = activeProducts.length ? Math.round(100 * activeProducts.filter((p) => (productStock(p) ?? 0) > 0).length / activeProducts.length) : 0;

  // التنبيهات — من بيانات Firestore الحقيقية فقط
  const alerts = [];
  lowStock.slice(0, 3).forEach((p) => alerts.push({ ico: '⚠️', text: `انخفاض في مخزون ${p.name_ar} — متبقي ${fmtNum(productStock(p))} قطعة`, time: relTime(p.updatedAt || p.createdAt), page: 'inventory' }));
  [...customers].sort((a, b) => tsToDate(b.createdAt) - tsToDate(a.createdAt)).slice(0, 2)
    .forEach((c) => alerts.push({ ico: '👤', text: `عميل جديد سجل في النظام: ${c.name_ar}`, time: relTime(c.createdAt), page: 'customers' }));
  [...postedPurchases].sort((a, b) => tsToDate(b.createdAt) - tsToDate(a.createdAt)).slice(0, 1)
    .forEach((p) => alerts.push({ ico: '📦', text: `دفعة جديدة من المورد ${supplierName(p.supplierId)}`, time: relTime(p.createdAt), page: 'purchases' }));
  postedPurchases.filter((p) => Number(p.remainingPiasters || 0) > 0).slice(0, 2)
    .forEach((p) => alerts.push({ ico: '💳', text: `موعد دفع مستحقات المورد ${supplierName(p.supplierId)} — متبقي ${fmtEGP(p.remainingPiasters)}`, time: relTime(p.date || p.createdAt), page: 'purchases' }));
  if (!alerts.length && productsCache.length) alerts.push({ ico: '✅', text: 'لا توجد تنبيهات حرجة — المخزون والفواتير في وضع جيد.', time: 'الآن', page: 'dashboard' });
  latestAlerts = alerts; updateBell();

  // مبيعات ومشتريات آخر N أشهر (حسب الفلتر)
  const months = [], salesByMonth = [], purchByMonth = [];
  for (let i = dashRange - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toLocaleDateString('ar-EG', { month: 'long' }));
    salesByMonth.push(monthSum(tradeSales, d.getFullYear(), d.getMonth()) / 100);
    purchByMonth.push(monthSum(tradePurchases, d.getFullYear(), d.getMonth()) / 100);
  }
  // مبيعات حسب الفئة (من بنود الفواتير)
  const catTotals = {};
  for (const inv of tradeSales.slice(0, 60)) {
    (invoiceItemsCache[inv.id] || []).forEach((d) => { const cat = categoryName((prodById[d.productId] || {}).categoryId);
      catTotals[cat] = (catTotals[cat] || 0) + Number(d.lineTotalPiasters || 0); });
  }
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const catShares = shares100(catEntries.map(([, v]) => v)); // نسب صحيحة مجموعها 100
  const catColors = ['#2f81f7', '#f0883e', '#3fb950', '#a371f7', '#8b98a9', '#39c5cf'];
  // أداء الفروع (حسب فلتر المدة)
  const branchTotals = {};
  tradeSales.forEach((s) => {
    const t = tsToDate(s.date || s.createdAt);
    if (branchRange === 'month' && (t.getFullYear() !== now.getFullYear() || t.getMonth() !== now.getMonth())) return;
    if (branchRange === 'quarter' && t < new Date(now.getFullYear(), now.getMonth() - 2, 1)) return;
    branchTotals[s.branchId] = (branchTotals[s.branchId] || 0) + Number(s.totalPiasters || 0);
  });
  const branchLabels = Object.keys(branchTotals).map(branchName);
  const branchValues = Object.values(branchTotals).map((v) => v / 100);

  const hasAny = posted.length || postedPurchases.length || productsCache.some((p) => p.isActive !== false);
  const dSales = pctDelta(salesCur, salesPrev);
  const dPurch = pctDelta(purchCur, purchPrev);
  const dProfit = pctDelta(profitCur, profitPrev);
  const hasProducts = activeProducts.length > 0;
  const ringC = 2 * Math.PI * 52;
  const ringColor = !hasProducts ? '#8b98a9' : inStockPct >= 80 ? '#3fb950' : inStockPct >= 50 ? '#f0883e' : '#f85149';
  const stockStatus = !hasProducts ? { text: 'لا توجد منتجات بعد', cls: 'flat' } : inStockPct >= 80 ? { text: 'مخزون آمن ✓', cls: 'ok' } : inStockPct >= 50 ? { text: 'مخزون يحتاج متابعة', cls: 'warn' } : { text: 'مخزون حرج — راجع المشتريات', cls: 'bad' };
  const medalCls = (r) => r === 1 ? 'gold' : r === 2 ? 'silver' : r === 3 ? 'bronze' : 'plain';

  const heroArt = `<div class="hero-art"><svg viewBox="0 0 640 190" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    <defs>
      <linearGradient id="carBody" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#123a7a"/><stop offset=".5" stop-color="#1d4ed8"/><stop offset="1" stop-color="#0a1628"/></linearGradient>
      <linearGradient id="beam" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#58a6ff" stop-opacity=".8"/><stop offset="1" stop-color="#58a6ff" stop-opacity="0"/></linearGradient>
    </defs>
    <polygon points="60,0 110,0 40,190 0,190" fill="url(#beam)" opacity=".35"/>
    <polygon points="180,0 200,0 120,190 90,190" fill="url(#beam)" opacity=".2"/>
    <g transform="translate(520,95)"><circle r="42" fill="#1c2b45" stroke="#58a6ff" stroke-width="2" opacity=".9"/><circle r="30" fill="none" stroke="#8b98a9" stroke-width="1.5" stroke-dasharray="4 5"/><circle r="12" fill="#0a1628" stroke="#58a6ff" stroke-width="2"/></g>
    <g transform="translate(448,128)"><rect x="-16" y="-34" width="32" height="56" rx="8" fill="#f0883e" opacity=".9"/><rect x="-16" y="-34" width="32" height="10" rx="5" fill="#c25e1e"/><line x1="-16" y1="-14" x2="16" y2="-14" stroke="#c25e1e" stroke-width="2"/><line x1="-16" y1="-2" x2="16" y2="-2" stroke="#c25e1e" stroke-width="2"/></g>
    <g>
      <path d="M40 150 L52 128 Q58 118 74 116 L108 112 Q130 92 168 88 L250 86 Q292 86 322 96 L360 104 Q410 110 440 122 L470 128 Q492 132 494 142 L492 152 Q490 158 480 158 L452 158 A26 26 0 0 0 400 158 L210 158 A26 26 0 0 0 158 158 L70 158 Q44 158 40 150 Z" fill="url(#carBody)" stroke="#58a6ff" stroke-width="1.5"/>
      <path d="M118 110 L140 94 L196 92 L232 90 L262 96 L276 104 L250 110 Z" fill="#bcd6ff" opacity=".85"/>
      <path d="M284 98 L318 100 L344 106 L300 110 Z" fill="#bcd6ff" opacity=".7"/>
      <circle cx="184" cy="158" r="24" fill="#050d1d" stroke="#58a6ff" stroke-width="3"/><circle cx="184" cy="158" r="10" fill="none" stroke="#8b98a9" stroke-width="2"/>
      <circle cx="426" cy="158" r="24" fill="#050d1d" stroke="#58a6ff" stroke-width="3"/><circle cx="426" cy="158" r="10" fill="none" stroke="#8b98a9" stroke-width="2"/>
      <ellipse cx="60" cy="140" rx="14" ry="5" fill="#e6edf3" opacity=".9"/>
    </g>
  </svg></div>`;

  $('page').innerHTML = `
    <div class="hero">${heroArt}<div class="hero-text"><h2>إدارة أذكى .. لعمل أكثر نجاحاً</h2><p>مع نظام الفلكي المتكامل لقطع غيار السيارات — كل الأرقام أدناه من قاعدة بيانات Firestore مباشرة.</p></div></div>
    <div class="kpi-grid">
      <div class="card kpi"><div class="kpi-text"><div class="value" data-countup="${inventoryValue}" data-countup-fmt="egp">${fmtEGPNum(inventoryValue)}<span class="unit">ج.م</span></div><div class="label">قيمة المخزون الإجمالية</div><div class="delta flat">—</div></div><div class="ico">📦</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value" data-countup="${totalPurchases}" data-countup-fmt="egp">${fmtEGPNum(totalPurchases)}<span class="unit">ج.م</span></div><div class="label">إجمالي المشتريات</div><div class="delta ${dPurch.cls}">${dPurch.text}</div></div><div class="ico">🤝</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value" data-countup="${totalSales}" data-countup-fmt="egp">${fmtEGPNum(totalSales)}<span class="unit">ج.م</span></div><div class="label">إجمالي المبيعات</div><div class="delta ${dSales.cls}">${dSales.text}</div></div><div class="ico">🛒</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value" data-countup="${profit}" data-countup-fmt="egp">${fmtEGPNum(profit)}<span class="unit">ج.م</span></div><div class="label">صافي الربح</div><div class="delta ${dProfit.cls}">${dProfit.text}</div></div><div class="ico">📈</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value" data-countup="${activeCustomers}" data-countup-fmt="int-en">${Number(activeCustomers).toLocaleString('en-US')}</div><div class="label">عملاء نشطين</div><div class="delta flat">—</div></div><div class="ico">👥</div></div>
    </div>
    ${debtCardsHTML}
    ${hasAny ? '' : `<div class="card">${emptyState('لا توجد بيانات بعد في Firestore — أنشئ منتجات وفواتير من صفحتي المنتجات والمبيعات، وستظهر المؤشرات هنا تلقائياً.')}</div>`}
    <div class="dash-row2">
      <div class="card"><h3>🏆 أكثر المنتجات مبيعاً</h3>
        ${best.length ? best.map((b) => `<div class="best-row"><span class="medal ${medalCls(b.rank)}">${b.rank}</span><span class="best-thumb">${categoryIcon(b.categoryId)}</span><span class="best-info"><b>${esc(b.name)}</b><small dir="ltr">${esc(b.partNumber)}</small></span><span class="best-qty">${fmtNum(b.qty)} قطعة</span></div>`).join('') : emptyState('لا توجد مبيعات مسجلة بعد.')}</div>
      <div class="card">
        <div class="card-head"><h3>📊 المبيعات والمشتريات خلال ${dashRange} أشهر</h3>
          <select id="dash-range"><option value="3" ${dashRange === 3 ? 'selected' : ''}>3 أشهر</option><option value="6" ${dashRange === 6 ? 'selected' : ''}>6 أشهر</option><option value="12" ${dashRange === 12 ? 'selected' : ''}>12 شهر</option></select></div>
        <div class="chart-wrap"><canvas id="chart-sales"></canvas></div>
      </div>
      <div class="card"><h3>🍩 توزيع المبيعات حسب الفئة</h3>
        <div class="donut-wrap"><div class="chart-wrap"><canvas id="chart-cat"></canvas></div>
        ${catEntries.length ? `<div class="donut-legend">${catEntries.map(([cat, v], i) => `<div class="leg-row"><span class="dot" style="background:${catColors[i % catColors.length]}"></span><span>${esc(cat)}</span><span class="pct">${catShares[i]}%</span></div>`).join('')}</div>`
        : `<div class="donut-legend"><div class="leg-row"><span class="dot" style="background:#8b98a9"></span><span>لا توجد مبيعات حسب الفئة بعد</span></div></div>`}</div></div>
    </div>
    <div class="dash-row3">
      <div class="card">
        <div class="card-head"><h3>🔔 التنبيهات</h3><button class="link-btn" id="alerts-all-btn">عرض الكل</button></div>
        ${alerts.length ? alerts.slice(0, 4).map((a) => `<div class="alert-row"><span class="a-ico">${a.ico}</span><span>${esc(a.text)}</span><span class="a-time">${a.time}</span></div>`).join('') + (alerts.length > 4 ? `<div class="alerts-more hidden">${alerts.slice(4).map((a) => `<div class="alert-row"><span class="a-ico">${a.ico}</span><span>${esc(a.text)}</span><span class="a-time">${a.time}</span></div>`).join('')}</div>` : '') : emptyState('لا توجد تنبيهات حالياً.')}
      </div>
      <div class="card"><h3>📦 حالة المخزون</h3>
        <div class="stock-ring-wrap">
          <div class="stock-ring">
            <svg width="120" height="120" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(139,152,169,.2)" stroke-width="10"/>
              <circle cx="60" cy="60" r="52" fill="none" stroke="${ringColor}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${ringC.toFixed(1)}" stroke-dashoffset="${(ringC * (1 - inStockPct / 100)).toFixed(1)}"/>
            </svg>
            <div class="ring-center"><b>${inStockPct}%</b><small>متوفر</small></div>
          </div>
          <div class="stock-stats">
            <div class="stock-stat"><span>⚠️ منتج منخفض المخزون</span><b>${fmtNum(lowStock.length)}</b></div>
            <div class="stock-stat"><span>❌ منتج نفد من المخزون</span><b>${fmtNum(outStock.length)}</b></div>
            <div class="stock-status ${stockStatus.cls}">${stockStatus.text}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>🏢 أداء الفروع</h3>
          <select id="branch-range"><option value="month" ${branchRange === 'month' ? 'selected' : ''}>هذا الشهر</option><option value="quarter" ${branchRange === 'quarter' ? 'selected' : ''}>آخر 3 أشهر</option><option value="all" ${branchRange === 'all' ? 'selected' : ''}>كل الفترات</option></select></div>
        ${branchLabels.length ? `<div class="chart-wrap small"><canvas id="chart-branches"></canvas></div>` : emptyState('لا توجد مبيعات حسب الفرع بعد.')}
      </div>
    </div>`;

  $('dash-range').addEventListener('change', (e) => { dashRange = Number(e.target.value); renderDashboard(); });
  $('branch-range').addEventListener('change', (e) => { branchRange = e.target.value; renderDashboard(); });
  document.querySelectorAll('[data-go-debts]').forEach((el) => el.addEventListener('click', () => go(el.dataset.goDebts)));
  $('alerts-all-btn').addEventListener('click', (e) => {
    const more = document.querySelector('.alerts-more');
    if (more) { more.classList.toggle('hidden'); e.target.textContent = more.classList.contains('hidden') ? 'عرض الكل' : 'عرض أقل'; }
  });

  animateKpiCountUps(); // عدّ تصاعدي لقيم KPI عند أول عرض للوحة
  destroyChart('sales'); destroyChart('cat'); destroyChart('branches');
  const kTick = (v) => v >= 1000 ? (v / 1000) + 'K' : v;
  charts.sales = new Chart($('chart-sales'), { type: 'line',
    data: { labels: months, datasets: [
      { label: 'المبيعات', data: salesByMonth, borderColor: '#2f81f7', backgroundColor: 'rgba(47,129,247,.2)', fill: true, tension: 0.4, pointBackgroundColor: '#2f81f7' },
      { label: 'المشتريات', data: purchByMonth, borderColor: '#f0883e', backgroundColor: 'rgba(240,136,62,.15)', fill: true, tension: 0.4, pointBackgroundColor: '#f0883e' } ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6edf3', usePointStyle: true } } },
      scales: { x: { ticks: { color: '#8b98a9' }, grid: { color: 'rgba(139,152,169,.08)' } },
        y: { min: 0, ticks: { color: '#8b98a9', callback: kTick }, grid: { color: 'rgba(139,152,169,.08)' } } } } });
  if (catEntries.length) {
    const donutTotal = fmtEGPNum(totalSales);
    const centerText = { id: 'centerText', afterDraw(chart) {
      const meta = chart.getDatasetMeta(0); if (!meta.data[0]) return;
      const { x, y } = meta.data[0]; const ctx = chart.ctx;
      ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = '#e6edf3';
      let fs = 19; ctx.font = `800 ${fs}px Cairo, sans-serif`;
      const maxW = (meta.data[0].innerRadius || 50) * 1.7;
      while (fs > 11 && ctx.measureText(donutTotal).width > maxW) { fs -= 1; ctx.font = `800 ${fs}px Cairo, sans-serif`; }
      ctx.fillText(donutTotal, x, y - 2);
      ctx.font = '600 12px Cairo, sans-serif'; ctx.fillStyle = '#8b98a9'; ctx.fillText('ج.م', x, y + 16); ctx.restore();
    } };
    charts.cat = new Chart($('chart-cat'), { type: 'doughnut',
      data: { labels: catEntries.map(([c]) => c), datasets: [{ data: catEntries.map(([, v]) => v / 100),
        backgroundColor: catColors, borderColor: '#0d1f3c', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { display: false } } }, plugins: [centerText] });
  } else {
    // دونات محايدة حتى مع غياب البيانات — الحلقة الرمادية تترسم دائماً
    const centerText = { id: 'centerText', afterDraw(chart) {
      const meta = chart.getDatasetMeta(0); if (!meta.data[0]) return;
      const { x, y } = meta.data[0]; const ctx = chart.ctx;
      ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = '#8b98a9';
      ctx.font = '700 15px Cairo, sans-serif'; ctx.fillText('لا توجد مبيعات', x, y); ctx.restore();
    } };
    charts.cat = new Chart($('chart-cat'), { type: 'doughnut',
      data: { labels: ['لا توجد بيانات'], datasets: [{ data: [1],
        backgroundColor: ['rgba(139,152,169,.25)'], borderColor: '#0d1f3c', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { display: false }, tooltip: { enabled: false } } }, plugins: [centerText] });
  }
  if (branchLabels.length) {
    charts.branches = new Chart($('chart-branches'), { type: 'bar',
      data: { labels: branchLabels, datasets: [{ label: 'المبيعات (ج.م)', data: branchValues,
        backgroundColor: '#2f81f7', borderRadius: 6, maxBarThickness: 60 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#8b98a9' }, grid: { display: false } },
          y: { min: 0, ticks: { color: '#8b98a9', callback: kTick }, grid: { color: 'rgba(139,152,169,.08)' } } } } });
  }
}

// ============================================================================
// 5) المنتجات والبحث الذكي والمسح
// ============================================================================
async function searchProducts(q) {
  q = (q || '').trim();
  if (!q) return productsCache;
  // 1) رقم القطعة المطابق تماماً أولاً (يستخدم فهرس orgId+partNumber)
  try {
    const exact = await getDocs(query(collection(db, 'products'), where('orgId', '==', orgId), where('partNumber', '==', q), limit(20)));
    if (!exact.empty) return exact.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { /* يقع على البحث في العميل إن لم يوجد الفهرس */ }
  // 2) باركود / QR مطابق
  try {
    const byCode = await getDocs(query(collection(db, 'products'), where('orgId', '==', orgId), where('barcode', '==', q), limit(20)));
    if (!byCode.empty) return byCode.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { /* تجاهل */ }
  // 3) بحث نصي في العميل: الاسم، رقم بديل، باركود، QR
  const needle = q.toLowerCase();
  return productsCache.filter((p) =>
    (p.name_ar || '').toLowerCase().includes(needle) ||
    (p.name_en || '').toLowerCase().includes(needle) ||
    (p.partNumber || '').toLowerCase().includes(needle) ||
    (p.alternativeNumbers || []).some((a) => String(a).toLowerCase().includes(needle)) ||
    String(p.barcode || '').includes(q) || String(p.qrCode || '').includes(q));
}

function productCardHTML(p) {
  const stock = productStock(p);
  const inactive = p.isActive === false;
  const vehicles = (p.vehicleCompatibility || []).slice(0, 2);
  return `<div class="card" ${inactive ? 'style="opacity:.6"' : ''}>
    <h3>${esc(p.name_ar)} ${p.name_en ? `<small style="color:var(--muted)">(${esc(p.name_en)})</small>` : ''} ${inactive ? '<span class="badge bad">موقوف</span>' : ''}${demoBadge(p)}</h3>
    <div class="list-row"><span>رقم القطعة</span><b dir="ltr">${esc(p.partNumber || '—')}</b></div>
    <div class="list-row"><span>الباركود / QR</span><b dir="ltr">${esc(p.barcode || p.qrCode || '—')}</b></div>
    <div class="list-row"><span>سعر البيع</span><b>${fmtEGP(p.sellingPricePiasters)}</b></div>
    ${canSeePrices() ? `<div class="list-row"><span>سعر الشراء</span><b>${fmtEGP(p.purchasePricePiasters)}</b></div>
    <div class="list-row"><span>سعر الجملة</span><b>${fmtEGP(p.wholesalePricePiasters)}</b></div>` : ''}
    <div class="list-row"><span>المخزون المتاح</span><b>${stock === null ? 'غير مسجل' : fmtNum(stock) + ' قطعة'}</b></div>
    <div class="list-row"><span>الوحدة</span><b>${esc(p.unit || 'قطعة')}</b></div>
    <div class="list-row"><span>المورد</span><b>${esc(p.supplierId ? supplierName(p.supplierId) : '—')}</b></div>
    <div class="list-row"><span>المخزن / الرف</span><b>${esc(p.warehouseLocation || '—')} / ${esc(p.shelfNumber || '—')}</b></div>
    <div class="list-row"><span>التصنيف / العلامة</span><b>${esc(categoryName(p.categoryId))} / ${esc(brandName(p.brandId))}</b></div>
    ${vehicles.length ? `<div class="list-row"><span>توافق السيارات</span><b>${esc(vehicles.join('، '))}${(p.vehicleCompatibility || []).length > 2 ? '…' : ''}</b></div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn small" data-add-sale="${p.id}">➕ إضافة للبيع</button>
      <button class="btn small secondary" data-edit-product="${p.id}">✏️ تعديل</button>
      ${(isOwner() || me.role === 'manager') ? `<button class="btn small ${inactive ? '' : 'danger'}" data-toggle-product="${p.id}" data-active="${!inactive}">${inactive ? '✅ تفعيل' : '⛔ إيقاف'}</button>` : ''}
      ${isOwner() ? `<button class="btn small danger" data-delete-product="${p.id}">🗑️ حذف</button>` : ''}
    </div></div>`;
}

async function renderProducts() {
  await loadProducts();
  $('page').innerHTML = `
    <h2 class="page-title">📦 المنتجات</h2>
    <p class="page-sub">كتالوج المنتجات من Firestore — البحث الذكي: رقم القطعة المطابق يظهر أولاً، ثم الباركود وQR والاسم.</p>
    <div class="toolbar">
      <input id="inv-search" type="search" placeholder="ابحث بالاسم، رقم القطعة، الباركود، أو QR...">
      <button class="btn scan small" id="scan-btn-inv">📷 بحث بالكاميرا</button>
      <button class="btn small" id="add-product-btn">➕ منتج جديد</button>
    </div>
    ${isOwner() ? `<div class="card" id="demo-cleanup-box" style="margin-bottom:14px;border-color:rgba(240,176,0,.45)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h3 style="margin-bottom:4px">🧹 البيانات التجريبية</h3>
        <p class="note" style="text-align:right;margin:0">إخفاء كل البيانات المعلَّمة «تجريبي» دفعة واحدة: إيقاف المنتجات التجريبية وإلغاء فواتيرها وإيقاف عملائها ومورديها.</p></div>
        <button class="btn danger" id="demo-cleanup-btn" style="width:auto">🗑️ حذف البيانات التجريبية</button>
      </div>
      <p class="note" style="text-align:right">الحذف النهائي من قاعدة البيانات يتم من لوحة المالك (Admin) عند الطلب — هذا الزر يخفي البيانات التجريبية ويلغي فواتيرها.</p>
      <div id="demo-cleanup-result"></div>
    </div>` : ''}
    <div class="grid-3" id="products-grid"></div>`;
  const draw = async (q) => {
    const list = await searchProducts(q);
    $('products-grid').innerHTML = list.length ? list.map(productCardHTML).join('') : emptyState('لا توجد منتجات مطابقة — جرّب كوداً آخر أو أضف المنتج جديداً.');
    bindProductButtons();
  };
  $('inv-search').addEventListener('input', (e) => draw(e.target.value));
  $('scan-btn-inv').addEventListener('click', openScanner);
  $('add-product-btn').addEventListener('click', () => openProductForm());
  const cleanupBtn = $('demo-cleanup-btn');
  if (cleanupBtn) cleanupBtn.addEventListener('click', cleanupDemoData);
  await draw('');
}

// --- المخزون: أرصدة المنتجات وحالتها (صفحة مستقلة عن كتالوج المنتجات) ---
async function renderInventory() {
  await loadProducts();
  const rows = productsCache.map((p) => ({ p, stock: productStock(p) }));
  const totalQty = rows.reduce((a, r) => a + (r.stock ?? 0), 0);
  const prodById = Object.fromEntries(productsCache.map((p) => [p.id, p]));
  const bals = await loadCollection('stockBalances');
  const inventoryValue = bals.reduce((a, b) =>
    a + Number(b.quantity || 0) * Number((prodById[b.productId] || {}).purchasePricePiasters || 0), 0);
  const low = rows.filter((r) => r.stock !== null && r.stock > 0 && Number(r.p.minStock || 0) > 0 && r.stock < Number(r.p.minStock)).length;
  const out = rows.filter((r) => r.stock === 0).length;
  $('page').innerHTML = `
    <h2 class="page-title">🗃️ المخزون</h2>
    <p class="page-sub">أرصدة المنتجات من stockBalances في Firestore — الرصيد يُحدَّث في نفس معاملة البيع/الشراء (ذرياً مع الفاتورة وحركة المخزون).</p>
    <div class="kpi-grid">
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(productsCache.length)}</div><div class="label">عدد المنتجات</div></div><div class="ico">📦</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(totalQty)}</div><div class="label">إجمالي الكمية بالمخزون</div></div><div class="ico">🔢</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(inventoryValue)}<span class="unit">ج.م</span></div><div class="label">قيمة المخزون الإجمالية</div></div><div class="ico">💰</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(low)}</div><div class="label">منتج منخفض المخزون</div></div><div class="ico">⚠️</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(out)}</div><div class="label">منتج نافد</div></div><div class="ico">❌</div></div>
    </div>
    <div class="card"><h3>أرصدة المنتجات</h3>
      ${rows.length ? `<table><tr><th>المنتج</th><th>رقم القطعة</th><th>المخزن / الرف</th><th>الكمية المتاحة</th><th>الحد الأدنى</th><th>الحالة</th></tr>
      ${rows.sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0)).map(({ p, stock }) => {
        const status = stock === 0 ? '<span class="badge bad">نافد</span>'
          : (Number(p.minStock || 0) > 0 && stock < Number(p.minStock)) ? '<span class="badge warn">منخفض</span>'
          : '<span class="badge ok">متوفر</span>';
        return `<tr><td>${esc(p.name_ar)}${demoBadge(p)}</td><td dir="ltr">${esc(p.partNumber || '—')}</td>
        <td>${esc(p.warehouseLocation || '—')} / ${esc(p.shelfNumber || '—')}</td>
        <td class="num">${stock === null ? 'غير مسجل' : fmtNum(stock)}</td>
        <td class="num">${fmtNum(p.minStock || 0)}</td><td>${status}</td></tr>`;
      }).join('')}</table>` : emptyState('لا توجد منتجات بعد — أضف منتجات من صفحة المنتجات.')}
    </div>`;
}
function bindProductButtons() {
  document.querySelectorAll('[data-add-sale]').forEach((b) => b.addEventListener('click', () => {
    const p = productsCache.find((x) => x.id === b.dataset.addSale);
    if (p) { addToCart(p); go('sales'); }
  }));
  document.querySelectorAll('[data-edit-product]').forEach((b) => b.addEventListener('click', () => {
    const p = productsCache.find((x) => x.id === b.dataset.editProduct);
    if (p) openProductForm(p);
  }));
  document.querySelectorAll('[data-toggle-product]').forEach((b) => b.addEventListener('click', async () => {
    // إيقاف/تفعيل فقط (إيقاف ناعم) — يبقي سجلات المبيعات سليمة؛ والحذف
    // النهائي للمالك فقط من زر "حذف" (revision 11).
    const active = b.dataset.active === 'true';
    if (!active && !confirm('سيتم إيقاف هذا المنتج — لن يظهر في البحث ونقطة البيع، لكن سجلاته ومبيعاته السابقة تبقى محفوظة. متابعة؟')) return;
    await updateDoc(doc(db, 'products', b.dataset.toggleProduct), { isActive: !active, updatedAt: serverTimestamp() });
    await loadProducts();
    if (currentPage === 'products') await renderProducts();
  }));
  document.querySelectorAll('[data-delete-product]').forEach((b) => b.addEventListener('click', () => {
    const p = productsCache.find((x) => x.id === b.dataset.deleteProduct);
    if (p) deleteMasterRecord('products', p.id, p.name_ar || p.id);
  }));
}

// --- حذف البيانات التجريبية (تنظيف ناعم — قواعد Firestore تمنع الحذف من العميل) ---
// ما يفعله: إيقاف المنتجات التجريبية (isActive=false) + إلغاء فواتير المبيعات
// والمشتريات التجريبية المنشورة (status='cancelled' عبر isReversalOnly في القواعد)
// + إيقاف العملاء والموردين التجريبيين. ما لا يفعله: لا يحذف أي مستند نهائياً،
// ولا يمس stockBalances (لا تُكتب من العميل أبداً) — قيمتها تختفي من لوحة التحكم
// لأن منتجاتها أصبحت موقوفة (انظر فلتر isActive في renderDashboard).
async function cleanupDemoData() {
  if (!isOwner()) { alert('هذه العملية للمالك فقط.'); return; }
  if (!confirm('سيتم إخفاء كل البيانات التجريبية:\n• إيقاف المنتجات المعلَّمة «تجريبي»\n• إلغاء فواتير المبيعات والمشتريات التجريبية المنشورة\n• إيقاف العملاء والموردين التجريبيين\n\nلن تُحذف أي بيانات نهائياً من قاعدة البيانات (القواعد تمنع الحذف من العميل) — وستعود لوحة التحكم لحالاتها الفارغة. متابعة؟')) return;
  const btn = $('demo-cleanup-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جارٍ التنظيف...'; }
  const res = { products: 0, sales: 0, purchases: 0, contacts: 0, failed: [] };
  const fail = (label, err) => res.failed.push(`${label}: ${err && err.code ? err.code : (err && err.message) || err}`);
  try {
    const demoProducts = (await loadCollection('products', [['isDemo', '==', true]])).filter((p) => p.isActive !== false);
    for (const p of demoProducts) {
      try { await updateDoc(doc(db, 'products', p.id), { isActive: false, updatedAt: serverTimestamp() }); res.products++; }
      catch (e) { fail(`منتج ${p.name_ar || p.id}`, e); }
    }
    const demoSales = (await loadCollection('salesInvoices', [['isDemo', '==', true]])).filter((s) => s.status === 'posted');
    for (const s of demoSales) {
      try { await updateDoc(doc(db, 'salesInvoices', s.id), { status: 'cancelled', updatedAt: serverTimestamp() }); res.sales++; }
      catch (e) { fail(`فاتورة مبيعات ${s.invoiceNumber || s.id}`, e); }
    }
    const demoPurch = (await loadCollection('purchaseInvoices', [['isDemo', '==', true]])).filter((s) => s.status === 'posted');
    for (const s of demoPurch) {
      try { await updateDoc(doc(db, 'purchaseInvoices', s.id), { status: 'cancelled', updatedAt: serverTimestamp() }); res.purchases++; }
      catch (e) { fail(`فاتورة مشتريات ${s.invoiceNumber || s.id}`, e); }
    }
    for (const coll of ['customers', 'suppliers']) {
      const demoContacts = (await loadCollection(coll, [['isDemo', '==', true]])).filter((c) => c.isActive !== false);
      for (const c of demoContacts) {
        try { await updateDoc(doc(db, coll, c.id), { isActive: false, updatedAt: serverTimestamp() }); res.contacts++; }
        catch (e) { fail(`${coll === 'customers' ? 'عميل' : 'مورد'} ${c.name_ar || c.id}`, e); }
      }
    }
  } catch (e) { fail('قراءة البيانات التجريبية', e); }
  const lines = [`تم التنظيف: إيقاف ${res.products} منتج، إلغاء ${res.sales} فاتورة مبيعات، إلغاء ${res.purchases} فاتورة مشتريات، إيقاف ${res.contacts} عميل/مورد.`];
  if (res.failed.length) lines.push(`تعذّر تنفيذ ${res.failed.length} عنصر (القواعد منعته): ` + res.failed.slice(0, 5).join('؛ ') + (res.failed.length > 5 ? '…' : ''));
  lines.push('ملاحظة: أرصدة stockBalances لا تُكتب من العميل، فقيمتها تختفي من لوحة التحكم لأن منتجاتها أصبحت موقوفة. الحذف النهائي من قاعدة البيانات يتم من لوحة المالك (Admin) عند الطلب.');
  const box = $('demo-cleanup-result');
  if (box) box.innerHTML = `<div class="note" style="text-align:right;color:var(--text)">${lines.map((l) => esc(l)).join('<br>')}</div>`;
  else alert(lines.join('\n'));
  await loadProducts();
  if (currentPage === 'products') await renderProducts();
  else if (currentPage === 'sales') await renderPOS();
  else await go(currentPage);
}

// --- المسح بالكاميرا: BarcodeDetector + fallback يدوي ---
let scanStream = null, scanRaf = null;
let invoiceScanTarget = null; // عند المسح من نموذج فاتورة: يُستدعى بالمنتج بدلاً من الانتقال لصفحة المنتجات
async function openScanner() {
  $('scan-modal').classList.remove('hidden');
  $('scan-result').innerHTML = '';
  hideError($('scan-error'));
  if (!('BarcodeDetector' in window)) {
    showError($('scan-error'), 'متصفحك لا يدعم كشف الباركود بالكاميرا — استخدم الإدخال اليدوي بالأسفل.');
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scan-video');
    video.srcObject = scanStream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e'] });
    const tick = async () => {
      if ($('scan-modal').classList.contains('hidden')) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) { await handleScannedCode(codes[0].rawValue); return; }
      } catch (e) { /* تجاهل وأعد المحاولة */ }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    showError($('scan-error'), 'تعذّر فتح الكاميرا — تأكد من منح الإذن، أو استخدم الإدخال اليدوي.');
  }
}
function closeScanner() {
  $('scan-modal').classList.add('hidden');
  if (scanRaf) cancelAnimationFrame(scanRaf);
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}
$('scan-close-btn').addEventListener('click', closeScanner);
$('scan-btn-top').addEventListener('click', openScanner);
$('manual-search-btn').addEventListener('click', () => handleScannedCode($('manual-code').value.trim()));
$('manual-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleScannedCode(e.target.value.trim()); });
$('global-search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  await loadProducts();
  const list = await searchProducts(e.target.value);
  if (list.length) { await go('products'); $('inv-search').value = e.target.value; $('inv-search').dispatchEvent(new Event('input')); }
  else alert('لا توجد نتائج مطابقة في Firestore.');
});

async function handleScannedCode(code) {
  if (!code) return;
  closeScanner();
  if (!productsCache.length) await loadProducts();
  let found = productsCache.find((p) => p.barcode === code || p.qrCode === code || p.partNumber === code);
  if (!found) {
    // جرّب استعلاماً مباشراً بالباركود قبل اعتبار الكود غير مسجل
    const list = await searchProducts(code);
    found = list[0];
  }
  if (found) {
    $('scan-result').innerHTML = '';
    if (invoiceScanTarget) { const cb = invoiceScanTarget; invoiceScanTarget = null; cb(found); return; }
    if (currentPage !== 'products') await go('products');
    $('products-grid').innerHTML = productCardHTML(found);
    bindProductButtons();
  } else {
    // كود غير مسجل: اعرض إضافة منتج جديد مملوءاً بالكود
    if (confirm(`الكود ${code} غير مسجّل في قاعدة البيانات. هل تريد إضافة منتج جديد بهذا الكود؟`)) {
      openProductForm(null, code);
    }
  }
}

// ============================================================================
// 6) نموذج المنتج (إضافة / تعديل)
// ============================================================================
let editingProduct = null;
// revision 11: إنشاء تصنيف جديد من داخل نموذج المنتج. إن كُتب اسم في
// حقل "تصنيف جديد" فإما يُعاد استخدام تصنيف موجود بنفس الاسم (بلا
// تكرار)، أو يُنشأ تصنيف جديد ويُضاف للقائمة ويُختار. تعيد معرّف
// التصنيف الذي سيُحفظ مع المنتج.
async function ensureNewCategory() {
  const name = $('pf-newcat').value.trim();
  if (!name) return $('pf-category').value;
  const existing = categories.find((c) => (c.name_ar || '').trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    $('pf-category').value = existing.id;
    $('pf-newcat').value = '';
    return existing.id;
  }
  const ref = await addDoc(collection(db, 'categories'), {
    orgId, name_ar: name, name_en: '', isActive: true,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  categories.push({ id: ref.id, orgId, name_ar: name, name_en: '', isActive: true });
  $('pf-category').innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.name_ar)}</option>`).join('');
  $('pf-category').value = ref.id;
  $('pf-newcat').value = '';
  return ref.id;
}

function openProductForm(p = null, scannedCode = '') {
  editingProduct = p;
  $('product-modal-title').textContent = p ? 'تعديل منتج' : 'منتج جديد';
  $('pf-category').innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.name_ar)}</option>`).join('') || '<option value="">— لا توجد تصنيفات —</option>';
  $('pf-brand').innerHTML = brands.map((b) => `<option value="${b.id}">${esc(b.name_ar)}</option>`).join('') || '<option value="">—</option>';
  $('pf-supplier').innerHTML = '<option value="">— بدون مورد —</option>' + suppliersCache.map((s) => `<option value="${s.id}">${esc(s.name_ar)}</option>`).join('');
  $('pf-name-ar').value = p?.name_ar || '';
  $('pf-name-en').value = p?.name_en || '';
  $('pf-part').value = p?.partNumber || scannedCode || '';
  $('pf-alt').value = (p?.alternativeNumbers || []).join(', ');
  $('pf-barcode').value = p?.barcode || (/^\d+$/.test(scannedCode) ? scannedCode : '');
  $('pf-qr').value = p?.qrCode || (!/^\d+$/.test(scannedCode) ? scannedCode : '');
  $('pf-category').value = p?.categoryId || '';
  $('pf-brand').value = p?.brandId || '';
  $('pf-supplier').value = p?.supplierId || '';
  // revision 11: المالك (ومن يسمح له بإنشاء تصنيف) يكتب تصنيفاً جديداً
  // أثناء إضافة المنتج بدل قائمة ثابتة. يُنشأ التصنيف عند الضغط على
  // "إضافة التصنيف" أو تلقائياً عند حفظ المنتج إن كُتب اسم ولم يُضف بعد.
  const canNewCat = ['owner', 'manager', 'inventory'].includes(me.role);
  $('pf-newcat-wrap').style.display = canNewCat ? '' : 'none';
  $('pf-newcat').value = '';
  $('pf-unit').value = p?.unit || 'قطعة';
  $('pf-vehicles').value = (p?.vehicleCompatibility || []).join('\n');
  // سعر الشراء يظهر فقط لمن لديه صلاحية رؤيته
  const showBuy = canSeePrices();
  $('pf-buy-label').style.display = showBuy ? '' : 'none';
  $('pf-buy').style.display = showBuy ? '' : 'none';
  $('pf-buy').value = p ? (p.purchasePricePiasters || 0) / 100 : 0;
  $('pf-sell').value = p ? (p.sellingPricePiasters || 0) / 100 : 0;
  $('pf-wholesale').value = p ? (p.wholesalePricePiasters || 0) / 100 : 0;
  $('pf-min').value = p?.minStock ?? 0;
  $('pf-loc').value = p?.warehouseLocation || '';
  $('pf-shelf').value = p?.shelfNumber || '';
  $('pf-notes').value = p?.description_ar || '';
  hideError($('product-error'));
  $('product-modal').classList.remove('hidden');
}
$('product-cancel-btn').addEventListener('click', () => $('product-modal').classList.add('hidden'));
// revision 11: زر "إضافة التصنيف" داخل نموذج المنتج — ينشئ التصنيف
// فوراً ويختاره في القائمة (بلا انتظار حفظ المنتج).
$('pf-newcat-add').addEventListener('click', async () => {
  const btn = $('pf-newcat-add');
  if (!$('pf-newcat').value.trim()) { showError($('product-error'), 'اكتب اسم التصنيف الجديد أولاً.'); return; }
  btn.disabled = true;
  try {
    hideError($('product-error'));
    await ensureNewCategory();
    showToast('✅ أُضيف التصنيف الجديد واختير للمنتج.');
  } catch (err) { showError($('product-error'), firestoreErrorMessage(err)); }
  btn.disabled = false;
});
$('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.querySelector('#product-form button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'جارٍ الحفظ...'; }
  const done = () => { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'حفظ المنتج'; } };
  // revision 11: إن كُتب تصنيف جديد ولم يُضف بالزر، يُنشأ الآن قبل حفظ
  // المنتج حتى يُحفظ المنتج بمعرّف التصنيف الجديد.
  let newCatId = null;
  try { newCatId = await ensureNewCategory(); }
  catch (err) { showError($('product-error'), firestoreErrorMessage(err)); done(); return; }
  // سعر الشراء لا يُكتب إلا ممن لديه صلاحية رؤيته — وإلا يبقى كما هو عند التعديل
  const buyPrice = canSeePrices() ? toPiasters($('pf-buy').value)
    : (editingProduct ? Number(editingProduct.purchasePricePiasters || 0) : 0);
  const data = {
    orgId, name_ar: $('pf-name-ar').value.trim(), name_en: $('pf-name-en').value.trim(),
    partNumber: $('pf-part').value.trim(),
    alternativeNumbers: $('pf-alt').value.split(',').map((s) => s.trim()).filter(Boolean),
    barcode: $('pf-barcode').value.trim(), qrCode: $('pf-qr').value.trim(),
    categoryId: newCatId || $('pf-category').value, brandId: $('pf-brand').value,
    supplierId: $('pf-supplier').value || null,
    unit: $('pf-unit').value || 'قطعة',
    vehicleCompatibility: $('pf-vehicles').value.split('\n').map((s) => s.trim()).filter(Boolean),
    purchasePricePiasters: buyPrice,
    sellingPricePiasters: toPiasters($('pf-sell').value),
    wholesalePricePiasters: toPiasters($('pf-wholesale').value),
    minStock: Number($('pf-min').value || 0),
    warehouseLocation: $('pf-loc').value.trim(), shelfNumber: $('pf-shelf').value.trim(),
    description_ar: $('pf-notes').value.trim(), isActive: editingProduct ? (editingProduct.isActive !== false) : true, updatedAt: serverTimestamp()
  };
  // رقم القطعة unique: مرفوض لو موجود لمنتج آخر (يسمح برقم المنتج نفسه عند التعديل)
  if (data.partNumber) {
    await loadProducts();
    const clash = productsCache.find((p) => (p.partNumber || '') === data.partNumber && p.id !== (editingProduct ? editingProduct.id : null));
    if (clash) { showError($('product-error'), 'رقم القطعة ده موجود بالفعل لمنتج آخر.'); done(); return; }
  }
  try {
    if (editingProduct) await updateDoc(doc(db, 'products', editingProduct.id), data);
    else {
      // المنتج الجديد يُنشأ مع سجل رصيده (quantity 0) في نفس الدفعة،
      // حتى تتمكن معاملة البيع/الشراء من قراءة الرصيد دائماً (revision 9).
      // معرّف سجل الرصيد حتمي: 'bal_'+productId.
      const prodRef = doc(collection(db, 'products'));
      const batch = writeBatch(db);
      batch.set(prodRef, { ...data, createdAt: serverTimestamp() });
      batch.set(doc(db, 'stockBalances', 'bal_' + prodRef.id), {
        orgId, productId: prodRef.id, warehouseId: (warehouses[0] || {}).id || '',
        branchId: DEFAULT_BRANCH, quantity: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      await batch.commit();
    }
    $('product-modal').classList.add('hidden');
    await loadProducts();
    if (currentPage === 'products') await renderProducts();
    else if (currentPage === 'inventory') await renderInventory();
  } catch (err) { showError($('product-error'), firestoreErrorMessage(err)); }
  done();
});

// ============================================================================
// 7) نقطة البيع POS — فاتورة + بنود + حركات مخزون في دفعة واحدة
// ============================================================================
function addToCart(p, qty = 1) {
  const line = posCart.find((l) => l.product.id === p.id);
  const stock = productStock(p);
  const wanted = (line ? line.qty : 0) + qty;
  if (stock !== null && wanted > stock) { alert(`المخزون المتاح ${stock} قطعة فقط من ${p.name_ar}.`); return; }
  if (line) line.qty = wanted; else posCart.push({ product: p, qty });
}
async function renderPOS() {
  await loadProducts();
  const customers = await loadCollection('customers');
  $('page').innerHTML = `
    <h2 class="page-title">🛒 نقطة البيع (POS)</h2>
    <p class="page-sub">أضف المنتجات بالبحث أو بالمسح — الفاتورة تُحفظ في Firestore مع حركات مخزون موثقة.</p>
    ${isOwner() ? `<div class="card" id="demo-cleanup-box" style="margin-bottom:14px;border-color:rgba(240,176,0,.45)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h3 style="margin-bottom:4px">🧹 البيانات التجريبية</h3>
        <p class="note" style="text-align:right;margin:0">إخفاء كل البيانات المعلَّمة «تجريبي» دفعة واحدة: إيقاف المنتجات التجريبية وإلغاء فواتيرها وإيقاف عملائها ومورديها.</p></div>
        <button class="btn danger" id="demo-cleanup-btn" style="width:auto">🗑️ حذف البيانات التجريبية</button>
      </div>
      <p class="note" style="text-align:right">الحذف النهائي من قاعدة البيانات يتم من لوحة المالك (Admin) عند الطلب — هذا الزر يخفي البيانات التجريبية ويلغي فواتيرها.</p>
      <div id="demo-cleanup-result"></div>
    </div>` : ''}
    <div class="pos-layout">
      <div class="card">
        <div class="toolbar">
          <input id="pos-search" type="search" placeholder="ابحث برقم القطعة أو الاسم...">
          <button class="btn scan small" id="scan-btn-pos">📷 مسح</button>
          ${canCreateInvoice('sales') ? '<button class="btn small" id="new-invoice-btn" type="button">🧾 إنشاء فاتورة</button>' : ''}
        </div>
        <div id="pos-results" class="grid-3"></div>
      </div>
      <div class="card">
        <h3>🧾 الفاتورة الحالية</h3>
        <label>العميل</label>
        <select id="pos-customer"><option value="">عميل نقدي (بدون حساب)</option>
          ${customers.map((c) => `<option value="${c.id}">${esc(c.name_ar)} — ${esc(c.phone || '')}</option>`).join('')}</select>
        <div id="pos-cart"></div>
        <div class="cart-total"><span>الإجمالي</span><span id="pos-total">0.00 ج.م</span></div>
        <label>طريقة الدفع</label>
        <select id="pos-pay"><option value="cash">نقدي</option><option value="visa">فيزا</option>
          <option value="instapay">إنستاباي</option><option value="bank_transfer">تحويل بنكي</option><option value="credit">آجل (دين على العميل)</option></select>
        <label>المبلغ المدفوع (جنيه)</label><input id="pos-paid" type="number" step="0.01" min="0">
        <button class="btn" id="pos-checkout">✅ تأكيد البيع وحفظ الفاتورة</button>
        <button class="btn secondary" id="pos-clear">مسح السلة</button>
        <div class="error" id="pos-error"></div>
        <p class="note">رقم الفاتورة يُولَّد تلقائياً. لا يمكن حذف فاتورة منشورة — الإلغاء يكون بعكسها فقط.</p>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h3>🧾 آخر فواتير المبيعات</h3><div id="recent-sales-invoices">${emptyState('جارٍ التحميل...')}</div></div>`;
  const drawCart = () => {
    const total = posCart.reduce((a, l) => a + l.qty * Number(l.product.sellingPricePiasters || 0), 0);
    $('pos-cart').innerHTML = posCart.length ? posCart.map((l, i) => `
      <div class="cart-line"><span>${esc(l.product.name_ar)} × ${l.qty}</span>
      <span>${fmtEGP(l.qty * Number(l.product.sellingPricePiasters || 0))}
      <button class="btn small secondary" data-cart-del="${i}">✕</button></span></div>`).join('')
      : emptyState('السلة فارغة — أضف منتجات من البحث أو المسح.');
    $('pos-total').textContent = fmtEGP(total);
    $('pos-paid').value = (total / 100).toFixed(2);
    document.querySelectorAll('[data-cart-del]').forEach((b) => b.addEventListener('click', () => { posCart.splice(Number(b.dataset.cartDel), 1); drawCart(); }));
  };
  const drawResults = async (q) => {
    const list = (await searchProducts(q)).filter((p) => p.isActive !== false).slice(0, 12);
    $('pos-results').innerHTML = list.length ? list.map((p) => `
      <div class="card"><b>${esc(p.name_ar)}</b>${demoBadge(p)}<br><small dir="ltr">${esc(p.partNumber || '')}</small>
      <div class="list-row"><span>${fmtEGP(p.sellingPricePiasters)}</span><span>متاح: ${productStock(p) ?? '—'}</span></div>
      <button class="btn small" data-pos-add="${p.id}">➕ إضافة</button></div>`).join('')
      : emptyState('لا نتائج — جرّب كوداً آخر أو امسح الباركود.');
    document.querySelectorAll('[data-pos-add]').forEach((b) => b.addEventListener('click', () => {
      addToCart(productsCache.find((p) => p.id === b.dataset.posAdd)); drawCart();
    }));
  };
  $('pos-search').addEventListener('input', (e) => drawResults(e.target.value));
  $('scan-btn-pos').addEventListener('click', openScanner);
  const newInvBtn = $('new-invoice-btn');
  if (newInvBtn) newInvBtn.addEventListener('click', () => renderInvoiceForm('sales'));
  $('pos-clear').addEventListener('click', () => { posCart = []; drawCart(); });
  const posCleanupBtn = $('demo-cleanup-btn');
  if (posCleanupBtn) posCleanupBtn.addEventListener('click', cleanupDemoData);
  $('pos-checkout').addEventListener('click', async () => {
    hideError($('pos-error'));
    if (!posCart.length) { showError($('pos-error'), 'السلة فارغة.'); return; }
    const subtotal = posCart.reduce((a, l) => a + l.qty * Number(l.product.sellingPricePiasters || 0), 0);
    const paid = Math.min(subtotal, Math.max(0, toPiasters($('pos-paid').value)));
    const customerId = $('pos-customer').value || null;
    // البيع الآجل يحتاج عميلاً بحساب — العميل النقدي (بدون حساب) لا تجوز عليه مديونية
    if (!customerId && subtotal - paid > 0) { showError($('pos-error'), 'البيع الآجل يحتاج عميلاً مسجلاً — اختر عميلاً أو ادفع كامل المبلغ.'); return; }
    // الحمولة الكاملة للفاتورة — كل حقل يؤثر على المال أو السجل. رقم الفاتورة
    // يُعاد استخدامه من العملية المعلقة إن وُجدت (حتى لا يتغير رقم الفاتورة
    // عند إعادة المحاولة فيتسبب في حظر خاطئ). معرّف الفاتورة هو opId نفسه.
    const posInvKey = pendingOpKey(['inv', 'pos']);
    const posPayMethod = $('pos-pay').value;
    const posStored = readPendingOp(posInvKey);
    const posInvoiceNumber = posStored
      ? posStored.payload.invoiceNumber
      : 'SI-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now()).slice(-6);
    const posPayload = {
      kind: 'pos', branchId: DEFAULT_BRANCH, customerId: customerId || null,
      lines: posCart.map((l) => ({ productId: l.product.id, qty: l.qty, unitPrice: Number(l.product.sellingPricePiasters || 0) })).sort((a, b) => String(a.productId).localeCompare(String(b.productId))),
      subtotal, paid, payMethod: posPayMethod, invoiceNumber: posInvoiceNumber
    };
    let posOpId;
    for (;;) {
      const begin = await beginPendingOp(posInvKey, posPayload, async (storedOpId) => {
        const s = await getDoc(markerRefFor(storedOpId));
        return s.exists();
      }, async (storedOpId) => {
        const d = await getDoc(doc(db, 'salesInvoices', storedOpId));
        return d.exists() ? { invoiceNumber: d.data().invoiceNumber, totalPiasters: d.data().totalPiasters, paidPiasters: d.data().paidPiasters } : null;
      });
      if (begin.action === 'proceed') { posOpId = begin.opId; break; }
      if (begin.action === 'unknown') { showError($('pos-error'), unknownBlockMessage('فاتورة بيع (POS)')); return; }
      if (begin.committed) { alert(committedBlockMessage(begin.stored, begin.saved, 'فاتورة بيع (POS)')); return; }
      const ok = confirmDiscardPendingOp(begin.stored, posPayload, false, 'فاتورة بيع (POS)');
      if (!ok) { showError($('pos-error'), 'تم إلغاء الحفظ — توجد فاتورة معلقة بقيم مختلفة. راجع القيم الأصلية أو تجاهل العملية المعلقة أولاً.'); return; }
      clearPendingOp(posInvKey);
    }
    const invRef = doc(db, 'salesInvoices', posOpId);
    const invoiceNumber = posInvoiceNumber;
    const payMethod = posPayMethod;
    const payRef = paid > 0 ? doc(db, 'salesPayments', 'pay-' + posOpId) : null; // حتمي من معرّف العملية
    const posMarkerRef = markerRefFor(posOpId);
    // الصندوق يُضمَّن فقط إذا كان الدور يسمح (owner/manager/accountant).
    // دور sales: الفاتورة تُسجَّل ذرياً وأثر الصندوق معلّق (cashEffect:'pending').
    const posCashPending = paid > 0 && movesMoney(payMethod) && !canWriteMoneyBox();
    const box = (paid > 0 && movesMoney(payMethod) && canWriteMoneyBox()) ? await resolveMoneyBoxRef(payMethod) : null;
    // المخزون: نحلّ مراجع الأرصدة قبل المعاملة (قراءة فقط). إن لم يوجد
    // رصيد مسجل لمنتج ما، نرمي خطأً واضحاً ولا نبدأ المعاملة أصلاً.
    let stockRefs = null;
    try {
      stockRefs = await resolveStockBalanceRefs(posCart.map((l) => l.product.id));
    } catch (err) {
      if (err && err.message && err.message.startsWith('NO_STOCK_BALANCE:')) {
        showError($('pos-error'), `لا يوجد رصيد مخزون مسجل لـ ${err.message.slice('NO_STOCK_BALANCE:'.length)} — اطلب من المالك تشغيل التهيئة (زر التهيئة في الإعدادات) لإنشاء سجل الرصيد أولاً. لم تُسجَّل الفاتورة.`);
      } else {
        showError($('pos-error'), firestoreErrorMessage(err) + ' — لم يُسجَّل أي شيء.');
      }
      return;
    }
    try {
      const result = await runTransaction(db, async (tx) => {
        // فحص عدم التكرار عبر العلامة (لا نقرأ الفاتورة الغائبة مباشرة).
        // نرجع القيم المحفوظة حتى يعرضها المتصل (لا قيم قديمة بصمت).
        const posMarkerSnap = await tx.get(posMarkerRef);
        if (posMarkerSnap.exists()) {
          const existingInv = await tx.get(invRef);
          const d = existingInv.exists() ? existingInv.data() : {};
          return { alreadyApplied: true, saved: { invoiceNumber: d.invoiceNumber, totalPiasters: d.totalPiasters, paidPiasters: d.paidPiasters, cashEffect: d.cashEffect || null } };
        }
        const contactSnap = (customerId) ? await tx.get(doc(db, 'customers', customerId)) : null;
        const curOwed = (contactSnap && contactSnap.exists()) ? Number(contactSnap.data().currentBalancePiasters || 0) : 0;
        let boxSnap = null;
        if (box) boxSnap = await tx.get(box.ref);
        // المخزون: نقرأ كل الأرصدة هنا — قبل أي كتابة. Firestore يشترط أن
        // تكون كل القراءات قبل كل الكتابات داخل المعاملة، وإلا رفضها
        // برسالة "transactions require all reads to be executed before
        // all writes". (revision 10: كانت القراءة بعد أول tx.set ففشل
        // الـ POS كل مرة.)
        const balSnaps = {};
        for (const l of posCart) {
          if (!balSnaps[l.product.id]) balSnaps[l.product.id] = await tx.get(stockRefs[l.product.id]);
        }
        if (box) applyMoneyMovementTx(tx, box.ref, box.isBank, boxSnap, 1, paid);
        tx.set(posMarkerRef, { orgId, opId: posOpId, kind: 'pos', createdAt: serverTimestamp() });
        tx.set(invRef, {
          orgId, branchId: DEFAULT_BRANCH, invoiceNumber,
          idempotencyKey: invRef.id, customerId, createdBy: me.uid, status: 'posted',
          date: serverTimestamp(), subtotalPiasters: subtotal, discountPiasters: 0, taxPiasters: 0,
          totalPiasters: subtotal, paidPiasters: 0, remainingPiasters: Math.max(0, subtotal - paid),
          paymentMethod: payMethod, ...(posCashPending ? { cashEffect: 'pending' } : {}),
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        // المدفوع الآن مستند دفعة حقيقي (لا paidPiasters) حتى يظهر في سجل الدفعات
        if (paid > 0) {
          tx.set(payRef, {
            orgId, branchId: DEFAULT_BRANCH, customerId, salesInvoiceId: invRef.id,
            receivedBy: me.uid, amountPiasters: paid, paymentMethod: payMethod,
            date: Timestamp.fromDate(new Date()), notes: 'دفعة عند إنشاء الفاتورة',
            ...(posCashPending ? { cashEffect: 'pending' } : {}),
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
        }
        // رصيد العميل يزيد بالمتبقي فقط (مديونية جديدة)
        if (customerId && subtotal - paid > 0 && contactSnap && contactSnap.exists()) {
          tx.update(doc(db, 'customers', customerId), { currentBalancePiasters: curOwed + (subtotal - paid), updatedAt: serverTimestamp() });
        }
        // (الأرصدة قُرئت أعلاه قبل أي كتابة — انظر balSnaps.)
        posCart.forEach((l) => {
          const itemRef = doc(collection(db, 'salesInvoices', invRef.id, 'items'));
          tx.set(itemRef, {
            orgId, productId: l.product.id, productName_ar: l.product.name_ar,
            partNumber: l.product.partNumber || '', quantity: l.qty,
            unitPricePiasters: Number(l.product.sellingPricePiasters || 0), discountPiasters: 0,
            lineTotalPiasters: l.qty * Number(l.product.sellingPricePiasters || 0),
            costPricePiasters: Number(l.product.purchasePricePiasters || 0)
          });
          const movRef = doc(collection(db, 'stockMovements'));
          tx.set(movRef, {
            orgId, branchId: DEFAULT_BRANCH, warehouseId: (warehouses[0] || {}).id || '',
            productId: l.product.id, type: 'sale_out', quantity: l.qty,
            referenceType: 'salesInvoice', referenceId: invRef.id, createdBy: me.uid,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
        });
        // المخزون: خصم الكميات من الأرصدة في نفس المعاملة (ذري مع الفاتورة
        // والحركة). نجمع الكمية لكل منتج أولاً حتى لو تكرر في سطرين، لأن
        // كل تحديث يُحسب من نفس القراءة الأصلية. إن أصبح أي رصيد سالباً
        // تُلغى المعاملة كلها.
        {
          const delta = {};
          for (const l of posCart) delta[l.product.id] = (delta[l.product.id] || 0) - l.qty;
          for (const [pid, d] of Object.entries(delta)) applyStockMovementTx(tx, stockRefs[pid], balSnaps[pid], d);
        }
        return { alreadyApplied: false };
      });
      clearPendingOp(posInvKey); // نجاح مؤكد — امسح العملية المعلقة
      // المخزون يُحدَّث في نفس المعاملة مع الفاتورة (revision 9) — لا
      // خادم موثوق ولا Cloud Function؛ الرصيد يتحرك ذرياً مع البيع.
      alert(result.alreadyApplied
        ? `الفاتورة ${result.saved.invoiceNumber} محفوظة بالفعل — لم يُضف أي أثر مكرر. القيم المحفوظة: الإجمالي ${fmtEGP(result.saved.totalPiasters)}، المدفوع ${fmtEGP(result.saved.paidPiasters)}.${result.saved.cashEffect === 'pending' ? ' أثر الصندوق معلّق بانتظار محاسب.' : ''}`
        : posCashPending
          ? `تم حفظ الفاتورة ${invoiceNumber} في Firestore. ملاحظة: أثر الصندوق معلّق (cashEffect: pending) — يعتمد محاسب حركة الصندوق لاحقاً (دورك لا يسمح بالكتابة في الصندوق).`
          : `تم حفظ الفاتورة ${invoiceNumber} في Firestore.`);
      posCart = []; await loadProducts(); await renderPOS();
    } catch (err) {
      // revision 11, Issue 1: فشل حتمي — امسح العملية المعلقة حتى لا تحظر
      // الفاتورة التالية بتحذير مضلل.
      if (isDefinitiveSaveFailure(err)) clearPendingOp(posInvKey);
      if (err && err.message === 'INSUFFICIENT_FUNDS') showError($('pos-error'), 'رصيد الصندوق/البنك لا يكفي لخصم هذا المبلغ — لم تُسجَّل الفاتورة. اختر طريقة دفع أخرى أو قلّل المبلغ.');
      else if (err && err.message === 'INSUFFICIENT_STOCK') showError($('pos-error'), 'المخزون لا يكفي — الكمية المطلوبة أكبر من الرصيد المتاح لأحد الأصناف. لم تُسجَّل الفاتورة.');
      else if (err && err.code === 'permission-denied') showError($('pos-error'), (roleDeniedMessage(['owner', 'manager', 'sales'], 'البيع من نقطة البيع') || firestoreErrorMessage(err)) + ' — لم يُسجَّل أي شيء.');
      else showError($('pos-error'), firestoreErrorMessage(err) + ' — لم يُسجَّل أي شيء، ويمكن إعادة المحاولة بأمان.');
    }
  });
  drawCart(); await drawResults('');
  // آخر فواتير المبيعات مع المتبقي المشتق وحالة السداد
  const [recentSales, recentPays] = await Promise.all([loadCollection('salesInvoices'), loadCollection('salesPayments')]);
  const recentEl = $('recent-sales-invoices');
  if (recentEl) {
    const payMap = {};
    recentPays.forEach((p) => { if (p.salesInvoiceId) payMap[p.salesInvoiceId] = (payMap[p.salesInvoiceId] || 0) + Number(p.amountPiasters || 0); });
    const rows = recentSales.filter((s) => s.status === 'posted' && !s.isManualDebt).sort((a, b) => tsToDate(b.createdAt) - tsToDate(a.createdAt)).slice(0, 10);
    recentEl.innerHTML = rows.length ? `<table><tr><th>رقم الفاتورة</th><th>العميل</th><th>الإجمالي</th><th>المتبقي</th><th>الحالة</th><th></th></tr>
      ${rows.map((s) => {
        const rem = remainingOf(s, payMap);
        const st = payStatusOf(Number(s.totalPiasters || 0), Number(s.totalPiasters || 0) - rem);
        const cust = customers.find((c) => c.id === s.customerId);
        return `<tr><td dir="ltr">${esc(s.invoiceNumber || s.id)}${demoBadge(s)}</td><td>${esc(cust ? cust.name_ar : 'عميل نقدي')}</td>
        <td class="num">${fmtEGP(s.totalPiasters)}</td><td class="num">${fmtEGP(rem)}</td>
        <td><span class="badge ${payStatusBadgeCls(st)}">${payStatusLabel(st)}</span></td>
        <td><button class="btn small secondary" data-view-sinv="${s.id}">عرض / طباعة</button></td></tr>`;
      }).join('')}</table>` : emptyState('لا توجد فواتير مبيعات بعد.');
    recentEl.querySelectorAll('[data-view-sinv]').forEach((b) => b.addEventListener('click', () => renderInvoiceDetail('sales', b.dataset.viewSinv)));
  }
}

// ============================================================================
// 8) المشتريات — قائمة فواتير الشراء من Firestore
// ============================================================================
async function renderPurchases() {
  const list = (await loadCollection('purchaseInvoices')).filter((p) => !p.isManualDebt);
  const suppliers = await loadCollection('suppliers');
  const supName = (id) => (suppliers.find((s) => s.id === id) || {}).name_ar || '—';
  $('page').innerHTML = `
    <h2 class="page-title">📦 المشتريات</h2>
    <p class="page-sub">فواتير الشراء المنشورة في Firestore — أنشئ فاتورة شراء جديدة مباشرة باختيار المنتجات دون سلة، ثم اطبعها.</p>
    <div class="toolbar">${canCreateInvoice('purchase') ? '<button class="btn small" id="new-purchase-invoice-btn">➕ إنشاء فاتورة شراء</button>' : ''}</div>
    ${list.length ? `<div class="card"><table><tr><th>رقم الفاتورة</th><th>المورد</th><th>الحالة</th><th>الإجمالي</th><th>المتبقي</th><th>التاريخ</th><th></th></tr>
      ${list.sort((a, b) => tsToDate(b.createdAt) - tsToDate(a.createdAt)).map((p) => `
      <tr><td dir="ltr">${esc(p.invoiceNumber || p.id)}${demoBadge(p)}</td><td>${esc(supName(p.supplierId))}</td>
      <td><span class="badge ${p.status === 'posted' ? 'ok' : 'warn'}">${esc(p.status || '')}</span></td>
      <td class="num">${fmtEGP(p.totalPiasters)}</td><td class="num">${fmtEGP(p.remainingPiasters)}</td>
      <td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td>
      <td><button class="btn small secondary" data-view-pinv="${p.id}">عرض / طباعة</button></td></tr>`).join('')}</table></div>`
    : `<div class="card">${emptyState('لا توجد فواتير شراء بعد في Firestore.')}</div>`}`;
  const npb = $('new-purchase-invoice-btn');
  if (npb) npb.addEventListener('click', () => renderInvoiceForm('purchase'));
  document.querySelectorAll('[data-view-pinv]').forEach((b) => b.addEventListener('click', () => renderInvoiceDetail('purchase', b.dataset.viewPinv)));
}

// ============================================================================
// 9) الحسابات والتقارير (مالك فقط) — من القيود والفواتير الحقيقية
// ============================================================================
async function renderAccounts() {
  const [entries, expenses, cashboxes, salesInvs, purchInvs, salesPays, purchPays, customers, suppliers] = await Promise.all([
    loadCollection('journalEntries'), loadCollection('expenses'), loadCollection('cashboxes'),
    loadCollection('salesInvoices'), loadCollection('purchaseInvoices'),
    loadCollection('salesPayments'), loadCollection('purchasePayments'),
    loadCollection('customers'), loadCollection('suppliers')
  ]);
  const debit = entries.filter((e) => e.status !== 'reversed').reduce((a, e) => a + Number(e.totalDebitPiasters || 0), 0);
  const credit = entries.filter((e) => e.status !== 'reversed').reduce((a, e) => a + Number(e.totalCreditPiasters || 0), 0);
  const expTotal = expenses.filter((e) => e.status !== 'cancelled').reduce((a, e) => a + Number(e.amountPiasters || 0), 0);
  const spByInv = {}; salesPays.forEach((p) => { if (p.salesInvoiceId) spByInv[p.salesInvoiceId] = (spByInv[p.salesInvoiceId] || 0) + Number(p.amountPiasters || 0); });
  const ppByInv = {}; purchPays.forEach((p) => { if (p.purchaseInvoiceId) ppByInv[p.purchaseInvoiceId] = (ppByInv[p.purchaseInvoiceId] || 0) + Number(p.amountPiasters || 0); });
  const openingSum = (list) => list.reduce((a, c) => a + Math.max(0, Number(c.openingBalancePiasters || 0)), 0);
  const custDebtTotal = salesInvs.filter((s) => s.status === 'posted').reduce((a, s) => a + remainingOf(s, spByInv), 0) + openingSum(customers);
  const supDebtTotal = purchInvs.filter((s) => s.status === 'posted').reduce((a, s) => a + remainingOf(s, ppByInv), 0) + openingSum(suppliers);
  $('page').innerHTML = `
    <h2 class="page-title">💰 الحسابات</h2>
    <div class="kpi-grid">
      <div class="card kpi"><div class="value">${fmtEGP(debit)}</div><div class="label">إجمالي المدين (قيود)</div></div>
      <div class="card kpi"><div class="value">${fmtEGP(credit)}</div><div class="label">إجمالي الدائن (قيود)</div></div>
      <div class="card kpi"><div class="value">${debit === credit ? '✅ متوازن' : '⚠️ غير متوازن'}</div><div class="label">حالة ميزان المراجعة</div></div>
      <div class="card kpi"><div class="value">${fmtEGP(expTotal)}</div><div class="label">إجمالي المصروفات</div></div>
    </div>
    <div class="card"><h3>الخزن</h3>
      ${cashboxes.length ? cashboxes.map((c) => `<div class="list-row"><span>${esc(c.name_ar)}</span><b>${fmtEGP(c.balancePiasters)}</b></div>`).join('') : emptyState('لا توجد خزن مسجلة بعد.')}
    </div>
    <div class="card" style="margin-top:14px"><h3>💳 المديونيات</h3>
      <div class="list-row"><span>مديونيات العملاء (فواتير مفتوحة)</span><b>${fmtEGP(custDebtTotal)}</b></div>
      <div class="list-row"><span>مديونيات الموردين (فواتير مفتوحة)</span><b>${fmtEGP(supDebtTotal)}</b></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn small" id="acc-debts-cust">مديونيات العملاء</button>
        <button class="btn small" id="acc-debts-sup">مديونيات الموردين</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h3>أحدث القيود المحاسبية</h3>
      ${entries.length ? `<table><tr><th>رقم القيد</th><th>الوصف</th><th>مدين</th><th>دائن</th><th>الحالة</th></tr>
      ${entries.slice(0, 20).map((e) => `<tr><td dir="ltr">${esc(e.entryNumber || e.id)}</td><td>${esc(e.description_ar || '')}</td>
      <td class="num">${fmtEGP(e.totalDebitPiasters)}</td><td class="num">${fmtEGP(e.totalCreditPiasters)}</td>
      <td>${esc(e.status || '')}</td></tr>`).join('')}</table>` : emptyState('لا توجد قيود محاسبية بعد.')}</div>`;
  $('acc-debts-cust').addEventListener('click', () => go('debts-customers'));
  $('acc-debts-sup').addEventListener('click', () => go('debts-suppliers'));
}
async function renderReports() {
  const sales = (await loadCollection('salesInvoices')).filter((s) => s.status === 'posted' && !s.isManualDebt);
  const byMonth = {};
  sales.forEach((s) => { const t = tsToDate(s.date || s.createdAt); const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
    byMonth[k] = (byMonth[k] || 0) + Number(s.totalPiasters || 0); });
  const rows = Object.entries(byMonth).sort();
  $('page').innerHTML = `
    <h2 class="page-title">📊 التقارير والتحليلات</h2>
    <p class="page-sub">تقارير محسوبة من فواتير المبيعات المنشورة فقط — الفواتير الملغاة والمديونيات اليدوية مستبعدة.</p>
    <div class="card"><h3>المبيعات الشهرية</h3>
    ${rows.length ? `<table><tr><th>الشهر</th><th>إجمالي المبيعات</th></tr>
      ${rows.map(([m, v]) => `<tr><td>${m}</td><td class="num">${fmtEGP(v)}</td></tr>`).join('')}</table>`
    : emptyState('لا توجد مبيعات لعرض تقارير عنها بعد.')}
    <button class="btn secondary" id="export-csv">⬇️ تصدير CSV</button></div>`;
  $('export-csv').addEventListener('click', () => {
    const csv = 'month,total_egp\n' + rows.map(([m, v]) => `${m},${(v / 100).toFixed(2)}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'alfalaky-monthly-sales.csv'; a.click();
  });
}

// ============================================================================
// 10) العملاء والموردون
// ============================================================================
let contactKind = 'customers';
async function renderContacts(kind) {
  contactKind = kind;
  const [list, debts] = await Promise.all([loadCollection(kind), loadDebtsData(kind)]);
  const isCust = kind === 'customers';
  $('page').innerHTML = `
    <h2 class="page-title">${isCust ? '👥 إدارة العملاء' : '🤝 إدارة الموردين'}</h2>
    <div class="toolbar"><button class="btn small" id="add-contact-btn">➕ ${isCust ? 'عميل جديد' : 'مورد جديد'}</button></div>
    <div class="card">
    ${list.length ? `<table><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد الحالي</th><th>الحالة</th>${isOwner() ? '<th></th>' : ''}</tr>
      ${list.map((c) => `<tr><td>${esc(c.name_ar)}${demoBadge(c)}</td><td dir="ltr">${esc(c.phone || '')}</td>
      <td class="num">${fmtEGP(contactOwed(c, debts.byContact[c.id] || []))}</td>
      <td><span class="badge ${c.isActive === false ? 'bad' : 'ok'}">${c.isActive === false ? 'موقوف' : 'نشط'}</span></td>
      ${isOwner() ? `<td style="white-space:nowrap"><button class="btn small danger" data-delete-contact="${c.id}" data-contact-name="${esc(c.name_ar)}">🗑️ حذف</button></td>` : ''}</tr>`).join('')}</table>`
    : emptyState(isCust ? 'لا يوجد عملاء مسجلون بعد.' : 'لا يوجد موردون مسجلون بعد.')}</div>`;
  $('add-contact-btn').addEventListener('click', () => openContactForm());
  // revision 11: حذف جهة (المالك فقط) — بلا حظر، مع حوار أثر وتأكيد وتدقيق.
  document.querySelectorAll('[data-delete-contact]').forEach((b) => b.addEventListener('click', () => {
    deleteMasterRecord(kind, b.dataset.deleteContact, b.dataset.contactName || b.dataset.deleteContact);
  }));
}
let contactMode = null;
function openContactForm() {
  contactMode = contactKind;
  $('contact-modal-title').textContent = contactKind === 'customers' ? 'عميل جديد' : 'مورد جديد';
  ['cf-name', 'cf-phone', 'cf-email', 'cf-address'].forEach((id) => { $(id).value = ''; });
  $('cf-balance').value = 0;
  hideError($('contact-error'));
  $('contact-modal').classList.remove('hidden');
}
$('contact-cancel-btn').addEventListener('click', () => $('contact-modal').classList.add('hidden'));
$('contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.querySelector('#contact-form button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'جارٍ الحفظ...'; }
  try {
    await addDoc(collection(db, contactMode), {
      orgId, branchId: DEFAULT_BRANCH,
      name_ar: $('cf-name').value.trim(), name_en: '', phone: $('cf-phone').value.trim(),
      email: $('cf-email').value.trim(), address_ar: $('cf-address').value.trim(),
      openingBalancePiasters: toPiasters($('cf-balance').value),
      currentBalancePiasters: toPiasters($('cf-balance').value),
      creditLimitPiasters: 0, isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    $('contact-modal').classList.add('hidden');
    await renderContacts(contactMode);
  } catch (err) { showError($('contact-error'), firestoreErrorMessage(err)); }
  finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'حفظ'; } }
});

// ============================================================================
// 11) الفروع والمخازن (مالك فقط) + الإعدادات
// ============================================================================
// --- revision 11e: إدارة الكتالوج (المالك فقط) ---
// التصنيفات: إعادة تسمية + حذف (حوار أثر يعرض المنتجات المرتبطة، تأكيد
// بكتابة الاسم، سجل تدقيق). العلامات والمركبات: حذف بنفس الحوار.
// المنتجات المرتبطة لا تُحذف أبداً — تظهر بلا تصنيف/علامة/مركبة.
async function renderCatalogue() {
  await loadLookups();
  const catCount = (cid) => productsCache.filter((p) => p.categoryId === cid).length;
  const brandCount = (bid) => productsCache.filter((p) => p.brandId === bid).length;
  const vehCount = (vid) => productsCache.filter((p) => (p.vehicleCompatibility || []).includes(vid)).length;
  $('page').innerHTML = `
    <h2 class="page-title">🏷️ إدارة الكتالوج</h2>
    <p class="page-sub">إعادة تسمية تصنيف أو حذف تصنيف/علامة/مركبة — المنتجات المرتبطة لا تُحذف، بل تظهر بلا تصنيف.</p>
    <div class="grid-2">
      <div class="card"><h3>التصنيفات</h3>
        ${categories.length ? categories.map((c) => `<div class="list-row" data-cat-row="${c.id}">
          <span class="cat-name">${esc(c.name_ar)}</span>
          <span class="badge">${fmtNum(catCount(c.id))} منتج</span>
          <span style="display:flex;gap:6px">
            <button class="btn small secondary" data-rename-cat="${c.id}">✏️ إعادة تسمية</button>
            <button class="btn small danger" data-delete-cat="${c.id}" data-cat-name="${esc(c.name_ar)}">🗑️ حذف</button>
          </span></div>`).join('') : emptyState('لا توجد تصنيفات بعد — أنشئ واحداً من نموذج المنتج.')}
      </div>
      <div class="card"><h3>العلامات التجارية</h3>
        ${brands.length ? brands.map((b) => `<div class="list-row"><span>${esc(b.name_ar)}</span>
          <span class="badge">${fmtNum(brandCount(b.id))} منتج</span>
          <button class="btn small danger" data-delete-brand="${b.id}" data-brand-name="${esc(b.name_ar)}">🗑️ حذف</button></div>`).join('') : emptyState('لا توجد علامات بعد.')}
      </div>
      <div class="card"><h3>المركبات</h3>
        ${vehicles.length ? vehicles.map((v) => `<div class="list-row"><span>${esc(v.name_ar)}</span>
          <span class="badge">${fmtNum(vehCount(v.id))} منتج</span>
          <button class="btn small danger" data-delete-vehicle="${v.id}" data-vehicle-name="${esc(v.name_ar)}">🗑️ حذف</button></div>`).join('') : emptyState('لا توجد مركبات بعد.')}
      </div>
    </div>`;
  // إعادة تسمية تصنيف: إدخال مضمّن + حفظ/إلغاء.
  document.querySelectorAll('[data-rename-cat]').forEach((btn) => btn.addEventListener('click', () => {
    const row = document.querySelector(`[data-cat-row="${btn.dataset.renameCat}"]`);
    const nameEl = row.querySelector('.cat-name');
    const current = nameEl.textContent;
    nameEl.innerHTML = `<input type="text" value="${esc(current)}" style="width:180px" data-cat-input> <button class="btn small" data-cat-save>💾 حفظ</button> <button class="btn small secondary" data-cat-cancel>إلغاء</button>`;
    row.querySelector('[data-cat-cancel]').addEventListener('click', () => renderCatalogue());
    row.querySelector('[data-cat-save]').addEventListener('click', async () => {
      const next = row.querySelector('[data-cat-input]').value.trim();
      if (!next) { alert('اكتب اسم التصنيف أولاً.'); return; }
      await updateDoc(doc(db, 'categories', btn.dataset.renameCat), { name_ar: next, updatedAt: serverTimestamp() });
      showToast(`✅ أُعيدت تسمية التصنيف إلى «${next}».`);
      await renderCatalogue();
    });
  }));
  document.querySelectorAll('[data-delete-cat]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('categories', b.dataset.deleteCat, b.dataset.catName)));
  document.querySelectorAll('[data-delete-brand]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('brands', b.dataset.deleteBrand, b.dataset.brandName)));
  document.querySelectorAll('[data-delete-vehicle]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('vehicles', b.dataset.deleteVehicle, b.dataset.vehicleName)));
}

async function renderBranches() {
  $('page').innerHTML = `
    <h2 class="page-title">📍 إدارة الفروع</h2>
    <p class="page-sub">حذف فرع أو مخزن للمالك فقط — بحوار أثر وتأكيد بكتابة الاسم وسجل تدقيق. حذف فرع لا يحذف فواتيره.</p>
    <div class="grid-2">
      <div class="card"><h3>الفروع</h3>
        ${branches.length ? branches.map((b) => `<div class="list-row"><span>${esc(b.name_ar)}</span><span class="badge ${b.isActive === false ? 'bad' : 'ok'}">${b.isActive === false ? 'موقوف' : 'نشط'}</span>
          <button class="btn small danger" data-delete-branch="${b.id}" data-branch-name="${esc(b.name_ar)}">🗑️ حذف</button></div>`).join('') : emptyState('لا توجد فروع مسجلة بعد — استخدم التهيئة في الإعدادات.')}
      </div>
      <div class="card"><h3>المخازن</h3>
        ${warehouses.length ? warehouses.map((w) => `<div class="list-row"><span>${esc(w.name_ar)}</span><span>${esc(branchName(w.branchId))}</span>
          <button class="btn small danger" data-delete-warehouse="${w.id}" data-warehouse-name="${esc(w.name_ar)}">🗑️ حذف</button></div>`).join('') : emptyState('لا توجد مخازن مسجلة بعد.')}
      </div>
    </div>`;
  document.querySelectorAll('[data-delete-branch]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('branches', b.dataset.deleteBranch, b.dataset.branchName)));
  document.querySelectorAll('[data-delete-warehouse]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('warehouses', b.dataset.deleteWarehouse, b.dataset.warehouseName)));
}
async function renderSettings() {
  const orgSnap = await getDoc(doc(db, 'organizations', orgId));
  const org = orgSnap.exists() ? orgSnap.data() : null;
  $('page').innerHTML = `
    <h2 class="page-title">⚙️ الإعدادات و Firebase</h2>
    <div class="grid-2">
      <div class="card"><h3>المؤسسة</h3>
        ${org ? `<div class="list-row"><span>الاسم</span><b>${esc(org.name_ar || '')}</b></div>
        <div class="list-row"><span>العملة</span><b>${esc(org.currency || 'EGP')}</b></div>
        <div class="list-row"><span>اللغة الافتراضية</span><b>${esc(org.defaultLanguage || 'ar')}</b></div>`
        : emptyState('لم يتم إنشاء مستند المؤسسة بعد — اكتب اسمها بالأسفل لحفظه.')}
        ${isOwner() ? `<div style="margin-top:10px">
          <label>اسم المؤسسة *</label>
          <input id="org-name-input" type="text" value="${esc(org ? org.name_ar || '' : '')}" placeholder="اسم الشركة — يظهر في الفواتير والكشوفات">
          <button class="btn" id="org-name-save" style="margin-top:8px">💾 حفظ اسم المؤسسة</button>
          <div class="error hidden" id="org-name-error"></div>
          <p class="note">إن لم يكن مستند المؤسسة موجوداً بعد، يُنشأ الآن باسمك (المالك فقط).</p>
        </div>` : ''}
      </div>
      <div class="card"><h3>🔥 اتصال Firebase</h3>
        <div class="list-row"><span>المشروع</span><b dir="ltr">${firebaseConfig.projectId}</b></div>
        <div class="list-row"><span>المستخدم</span><b dir="ltr">${esc(me.email)}</b></div>
        <div class="list-row"><span>الدور</span><b>${roleLabel(me.role)}</b></div>
        <div class="list-row"><span>orgId</span><b dir="ltr">${esc(me.orgId)}</b></div>
        <div class="list-row"><span>الفروع المسموحة</span><b dir="ltr">${esc((me.branchIds || []).join(', '))}</b></div>
        <button class="btn" id="setup-btn">🚀 تهيئة النظام (مؤسسة + فرع + مخزن + خزينة + حسابات)</button>
        <p class="note">التهيئة تنشئ البيانات الأساسية فقط إن لم تكن موجودة، ولا تمس أي بيانات قائمة.</p>
      </div>
    </div>`;
  // --- revision 11: تعديل اسم المؤسسة من الإعدادات (المالك فقط) ---
  // إن وُجد مستند المنظمة فهو تحديث (مسموح أصلاً في القواعد)؛ وإن لم
  // يوجد فهو إنشاء بمخطط ثابت (مسموح في قواعد revision 11 للمالك فقط،
  // ومعرّف المستند = orgId في توكن المالك فلا ينشئ منظمة غير منظمته).
  const orgSaveBtn = $('org-name-save');
  if (orgSaveBtn) orgSaveBtn.addEventListener('click', async () => {
    if (!isOwner()) { alert('تعديل اسم المؤسسة للمالك فقط.'); return; }
    const name = $('org-name-input').value.trim();
    if (!name) { showError($('org-name-error'), 'اكتب اسم المؤسسة أولاً.'); return; }
    hideError($('org-name-error'));
    orgSaveBtn.disabled = true; orgSaveBtn.textContent = '⏳ جارٍ الحفظ...';
    try {
      const orgRef = doc(db, 'organizations', orgId);
      if (org) {
        await updateDoc(orgRef, { name_ar: name, updatedAt: serverTimestamp() });
      } else {
        await setDoc(orgRef, {
          orgId, name_ar: name, name_en: name, currency: 'EGP',
          defaultLanguage: 'ar', isActive: true,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      }
      showToast(`✅ تم حفظ اسم المؤسسة: ${name}`);
      await renderSettings();
    } catch (err) {
      showError($('org-name-error'), firestoreErrorMessage(err));
      orgSaveBtn.disabled = false; orgSaveBtn.textContent = '💾 حفظ اسم المؤسسة';
    }
  });
  // --- التهيئة الآمنة: إنشاء فقط — لا كتابة فوق بيانات موجودة أبداً ----
  // (المراجعة 6) المشكلة التي كشفها اختبار المحاكي: التهيئة تحدد المستندات
  // الغائبة باستعلام قبل المعاملة، والمعاملة تكتبها بـ tx.set. فإن ظهر
  // صندوق (برصيد) بين الاستعلام والالتزام، فإن tx.set يكتب فوقه (لأن set
  // على مستند موجود هو تحديث، والقواعد كانت تسمح به) فيعيد الرصيد إلى 0.
  // الإصلاح على مستويين:
  //  * قاعدة createdAtUnchanged() في القواعد: التحديث لا يجوز أن يغيّر
  //    createdAt أبداً. فكتابة set الكاملة للتهيئة (التي تعيد ختم createdAt
  //    بـ "الآن") تُرفض على مستند موجود — لأنها تحديث يغيّر createdAt —
  //    بينما تنجح كإنشاء على مستند غائب. فالمعاملة تفشل بدل الكتابة فوق
  //    مستند موجود. والتحديثات المشروعة (رصيد، اسم، حالة…) لا تمس
  //    createdAt أبداً فلا تتأثر.
  //  * حلقة إعادة محاولة (3 محاولات): إن فشلت المعاملة (لأن مستنداً ظهر
  //    بعد الاستعلام)، تعيد التهيئة الاستعلام من جديد فيجد المستند الجديد
  //    فيتخطاه، فتنجح المحاولة التالية. فلا يرى المستخدم خطأً في حالة
  //    السباق، ولا يُكتب فوق أي رصيد.
  //  * مستند المنظمة: التهيئة لا تكتبه أصلاً (إنشاؤه من تدفق التسجيل،
  //    وقاعدة الإنشاء فيه false). التهيئة تقرأه فقط للتأكد من وجوده.
  //  * معرّف الصندوق/البنك منظم النطاق: cash_<orgId>_<branchId> و
  //    bank_<orgId>_<branchId> — فلا يتصادم منظمتان على cash_main العام.
  //    والصندوق العام cash_main الموجود أصلاً يُحترم: إن وُجد صندوق نشط
  //    للفرع فلا يُنشأ صندوق جديد، فيبقى الرصيد كما هو (لا ترحيل هنا).
  //    وإن وُجد صندوقان نشطان (قديم عام + جديد منظم النطاق)، فإن
  //    resolveMoneyBoxRef يفضّل المنظم النطاق (حتمي) فلا غموض في الدفعات.
  $('setup-btn').addEventListener('click', async () => {
    if (!isOwner()) { alert('التهيئة للمالك فقط.'); return; }
    // المحاولة الواحدة: استعلام ثم معاملة محروسة بالعلامة.
    const attemptSetup = async () => {
      // مستند المنظمة لا يُقرأ ولا يُكتب هنا (إنشاؤه من تدفق التسجيل) —
      // التهيئة تخص المستندات المبدئية للفرع فقط.
      const [branches, warehouses, boxes, banks, accounts, categories, prods, bals] = await Promise.all([
        loadCollection('branches'),
        loadCollection('warehouses'),
        loadCollection('cashboxes'),
        loadCollection('bankAccounts'),
        loadCollection('accounts'),
        loadCollection('categories'),
        loadCollection('products'),
        loadCollection('stockBalances'),
      ]);
      const branchIds = new Set(branches.map((b) => b.id));
      const whIds = new Set(warehouses.map((w) => w.id));
      const accIds = new Set(accounts.map((a) => a.id));
      const catIds = new Set(categories.map((c) => c.id));
      const hasActiveBox = boxes.some((c) => c.isActive !== false && c.branchId === DEFAULT_BRANCH)
        || boxes.some((c) => c.isActive !== false);
      const hasActiveBank = banks.some((b) => b.isActive !== false);
      const missing = [];
      // مستند المنظمة لا يُكتب هنا (إنشاؤه من تدفق التسجيل) — يُقرأ فقط.
      if (!branchIds.has(DEFAULT_BRANCH)) missing.push({ ref: doc(db, 'branches', DEFAULT_BRANCH), data: {
        orgId, name_ar: 'الفرع الرئيسي', name_en: 'Main Branch',
        isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      if (!whIds.has('wh_main')) missing.push({ ref: doc(db, 'warehouses', 'wh_main'), data: {
        orgId, branchId: DEFAULT_BRANCH, name_ar: 'المخزن الرئيسي',
        name_en: 'Main Warehouse', isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      if (!hasActiveBox) missing.push({ ref: doc(db, 'cashboxes', orgScopedCashboxId(orgId, DEFAULT_BRANCH)), data: {
        orgId, branchId: DEFAULT_BRANCH, name_ar: 'صندوق الفرع الرئيسي',
        balancePiasters: 0, isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      if (!hasActiveBank) missing.push({ ref: doc(db, 'bankAccounts', orgScopedBankId(orgId, DEFAULT_BRANCH)), data: {
        orgId, branchId: DEFAULT_BRANCH, bankName_ar: 'الحساب البنكي الرئيسي', bankName_en: 'Main Bank Account',
        balancePiasters: 0, isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      const seedAccounts = [
        ['1010', 'الصندوق', 'asset'], ['1200', 'العملاء', 'asset'], ['1300', 'المخزون', 'asset'],
        ['2100', 'الموردون', 'liability'], ['4000', 'المبيعات', 'income'], ['5000', 'تكلفة البضاعة المباعة', 'expense'],
        ['6000', 'المصروفات العمومية', 'expense']
      ];
      for (const [code, name, type] of seedAccounts) {
        if (!accIds.has('acc_' + code)) missing.push({ ref: doc(db, 'accounts', 'acc_' + code), data: {
          orgId, code, name_ar: name, name_en: '', type,
          isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      }
      for (const [id, name] of [['cat_filters', 'فلاتر'], ['cat_brakes', 'فرامل'], ['cat_engine', 'مكونات محرك'], ['cat_electrical', 'كهرباء']]) {
        if (!catIds.has(id)) missing.push({ ref: doc(db, 'categories', id), data: {
          orgId, name_ar: name, name_en: '', isActive: true,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      }
      // المخزون (revision 9): كل منتج بلا سجل رصيد يُنشأ له سجل بكمية 0،
      // حتى تتمكن معاملة البيع/الشراء من قراءة الرصيد دائماً. هذا ترحيل
      // لمرة واحدة للمنتجات القديمة؛ المنتجات الجديدة يُنشأ رصيدها معها.
      const balIds = new Set(bals.map((b) => b.id));
      for (const p of prods) {
        if (!balIds.has('bal_' + p.id)) missing.push({ ref: doc(db, 'stockBalances', 'bal_' + p.id), data: {
          orgId, productId: p.id, warehouseId: 'wh_main', branchId: DEFAULT_BRANCH,
          quantity: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
      }
      return runTransaction(db, async (tx) => {
        const markerRef = setupMarkerRefFor(orgId, DEFAULT_BRANCH);
        const markerSnap = await tx.get(markerRef);
        if (markerSnap.exists()) return { alreadyDone: true, created: 0 };
        for (const m of missing) tx.set(m.ref, m.data);
        tx.set(markerRef, { orgId, opId: 'setup-' + orgId + '-' + DEFAULT_BRANCH, kind: 'setup', createdAt: serverTimestamp() });
        return { alreadyDone: false, created: missing.length };
      });
    };
    try {
      // حلقة إعادة المحاولة: إن ظهر مستند بين الاستعلام والالتزام، ترفض
      // القواعد الكتابة فوقه (createdAtUnchanged) فتفشل المعاملة؛ نعيد
      // الاستعلام فيجد المستند الجديد فيتخطاه فتنجح المحاولة التالية.
      let result = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await attemptSetup(); lastErr = null; break; }
        catch (err) { lastErr = err; result = null; }
      }
      if (lastErr) throw lastErr;
      alert(result.alreadyDone
        ? 'التهيئة تمت من قبل — لم يُغيَّر أي شيء.'
        : (result.created === 0 ? 'لا شيء جديد — كل المستندات المبدئية موجودة أصلاً.' : `تمت التهيئة بنجاح — أُنشئ ${result.created} مستنداً جديداً، ولم يُمس أي مستند موجود.`));
      await loadLookups(); await renderSettings();
    } catch (err) { alert(firestoreErrorMessage(err)); }
  });
}

// ============================================================================
// 12) إدارة الموظفين (مالك فقط)
// ============================================================================
// --- revision 11e: تعديل موظف وحذفه (المالك فقط) ---
// التعديل: الاسم والدور والواجهات والصلاحيات والحالة. المالك لا يستطيع
// تغيير دوره هو ولا إيقاف نفسه (الحقول تُعطَّل عند تعديل النفس).
// الحذف: يُحذف مستند المستخدم فقط (حوار أثر + تأكيد بكتابة الاسم +
// سجل تدقيق)؛ مبيعاته وسجلاته السابقة لا تُحذف، وحساب الدخول (Auth) لا
// يُحذف تلقائياً. المالك لا يستطيع حذف نفسه (زر الحذف مخفي لنفسه،
 // والقواعد تمنعه أيضاً).
let editingUserId = null; // null = إنشاء موظف جديد؛ وإلا تعديل هذا المستخدم
function openEmployeeForm(user) {
  editingUserId = user ? user.id : null;
  const isSelf = user && user.id === me.uid;
  $('employee-modal-title').textContent = user ? `تعديل موظف — ${user.displayName_ar || user.email}` : 'موظف جديد';
  $('employee-submit-btn').textContent = user ? '💾 حفظ التعديلات' : 'إنشاء الموظف';
  $('ef-email-row').style.display = user ? 'none' : '';
  $('ef-pass-row').style.display = user ? 'none' : '';
  $('ef-email').required = !user;
  $('ef-pass').required = !user;
  $('ef-name').value = user ? (user.displayName_ar || '') : '';
  $('ef-email').value = user ? (user.email || '') : '';
  $('ef-pass').value = '';
  $('ef-role').value = user ? (user.role || 'sales') : 'sales';
  $('ef-role').disabled = !!isSelf; // المالك لا يغيّر دوره هو
  // revision 11f (rules-level): عند التعديل، وضّح أن تغيير الدور هنا
  // يغيّر ما يستطيع فعله فوراً — الدور الفعلي يأتي من مستند المستخدم
  // (وليس من تصريح الـ token)، والقواعد تطبّقه مباشرة.
  $('ef-role-note').classList.toggle('hidden', !user);
  $('ef-perms').value = user ? (user.permissions || []).join(', ') : '';
  $('ef-interfaces').innerHTML = ALL_INTERFACES.map((id) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="checkbox" value="${id}" style="width:auto" ${user && (user.interfaces || []).includes(id) ? 'checked' : ''}> ${NAV.find((n) => n.id === id).label}</label>`).join('');
  hideError($('employee-error'));
  $('employee-modal').classList.remove('hidden');
}
async function renderEmployees() {
  const users = await loadCollection('users');
  $('page').innerHTML = `
    <h2 class="page-title">👤 إدارة الموظفين</h2>
    <p class="page-sub">إيقاف موظف يمنعه من الدخول فوراً. حذف موظف يحذف سجله فقط — مبيعاته وسجلاته السابقة لا تُحذف أبداً، وحساب الدخول (Firebase Auth) لا يُحذف تلقائياً. المالك لا يستطيع حذف نفسه أو تغيير دوره.</p>
    <div class="toolbar"><button class="btn small" id="add-emp-btn">➕ موظف جديد</button></div>
    <div class="card">
    ${users.length ? `<table><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>الواجهات</th><th>الحالة</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.displayName_ar || u.email)}</td><td dir="ltr">${esc(u.email)}</td>
      <td>${roleLabel(u.role)}</td><td>${esc((u.interfaces || []).join('، ') || 'كل الواجهات حسب الدور')}</td>
      <td><span class="badge ${u.isActive === false ? 'bad' : 'ok'}">${u.isActive === false ? 'موقوف' : 'نشط'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn small secondary" data-edit-user="${u.id}">✏️ تعديل</button>
        ${u.uid !== me.uid ? `<button class="btn small secondary" data-toggle-user="${u.id}" data-active="${u.isActive !== false}">
        ${u.isActive === false ? 'تفعيل' : 'إيقاف'}</button>
        <button class="btn small danger" data-delete-user="${u.id}" data-user-name="${esc(u.displayName_ar || u.email)}">🗑️ حذف</button>` : ''}</td></tr>`).join('')}</table>`
    : emptyState('لا يوجد موظفون مسجلون بعد.')}</div>`;
  $('add-emp-btn').addEventListener('click', () => openEmployeeForm(null));
  document.querySelectorAll('[data-edit-user]').forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === b.dataset.editUser);
    if (u) openEmployeeForm(u);
  }));
  document.querySelectorAll('[data-toggle-user]').forEach((b) => b.addEventListener('click', async () => {
    const active = b.dataset.active === 'true';
    await updateDoc(doc(db, 'users', b.dataset.toggleUser), { isActive: !active, updatedAt: serverTimestamp() });
    await renderEmployees();
  }));
  document.querySelectorAll('[data-delete-user]').forEach((b) => b.addEventListener('click', () => deleteMasterRecord('users', b.dataset.deleteUser, b.dataset.userName)));
}
$('employee-cancel-btn').addEventListener('click', () => $('employee-modal').classList.add('hidden'));
$('employee-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError($('employee-error'));
  const submitBtn = document.querySelector('#employee-form button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'جارٍ الحفظ...'; }
  const interfaces = [...document.querySelectorAll('#ef-interfaces input:checked')].map((c) => c.value);
  const permissions = $('ef-perms').value.split(',').map((s) => s.trim()).filter(Boolean);
  let secondary = null;
  try {
    // revision 11e: وضع التعديل — يُحدَّث مستند المستخدم فقط، بلا حساب
    // Auth جديد. المالك لا يغيّر دوره هو (القائمة معطّلة لنفسه، وهنا
    // يُفرض ذلك أيضاً حتى لو أُرسل النموذج بأي طريق).
    if (editingUserId) {
      const isSelf = editingUserId === me.uid;
      const patch = {
        displayName_ar: $('ef-name').value.trim(),
        interfaces, permissions, updatedAt: serverTimestamp()
      };
      if (!isSelf) patch.role = $('ef-role').value;
      await updateDoc(doc(db, 'users', editingUserId), patch);
      $('employee-modal').classList.add('hidden');
      showToast('✅ حُفظت تعديلات الموظف.');
      editingUserId = null;
      await renderEmployees();
      return;
    }
    // تطبيق Firebase ثانوي حتى لا يخرج المالك من جلسته أثناء إنشاء حساب الموظف
    secondary = initializeApp(firebaseConfig, 'secondary-' + Date.now());
    const secAuth = getAuth(secondary);
    const cred = await createUserWithEmailAndPassword(secAuth, $('ef-email').value.trim(), $('ef-pass').value);
    const uid = cred.user.uid;
    await setDoc(doc(db, 'users', uid), {
      orgId, branchIds: ['*'], role: $('ef-role').value,
      displayName_ar: $('ef-name').value.trim(), displayName_en: '',
      email: $('ef-email').value.trim(), interfaces, permissions,
      isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await signOut(secAuth);
    $('employee-modal').classList.add('hidden');
    alert('تم إنشاء الموظف. ملاحظة: لكي تعمل قواعد Firestore مع حسابه، يجب أن يضبط المالك تصاريحه المخصصة (orgId/role/branchIds) بسكربت set-custom-claims.js — الواجهة والصلاحيات هنا تتحكم في ما يظهر له، وقواعد Firestore هي التي تفرض الوصول للبيانات.');
    await renderEmployees();
  } catch (err) {
    showError($('employee-error'), err.code === 'auth/email-already-in-use'
      ? 'هذا البريد مسجّل بالفعل في Firebase Auth.'
      : firestoreErrorMessage(err));
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = editingUserId ? '💾 حفظ التعديلات' : 'إنشاء الموظف'; }
    if (secondary) await deleteApp(secondary).catch(() => {});
  }
});

// ============================================================================
// 13) المساعد الذكي — إجابات من بيانات Firestore الحقيقية (بدون خادم خارجي)
// ============================================================================
async function renderAI() {
  $('page').innerHTML = `
    <h2 class="page-title">🤖 المساعد الذكي</h2>
    <p class="page-sub">اسأل عن مبيعاتك ومخزونك وعملائك — الإجابات محسوبة من Firestore مباشرة.</p>
    <div class="card"><div class="ai-chat" id="ai-log">
      <div class="ai-msg bot">أهلاً بك في مساعد الفلكي الذكي 👋 اسألني مثلاً: «ما إجمالي مبيعات اليوم؟» أو «ما المنتجات منخفضة المخزون؟» أو «ما أكثر المنتجات مبيعاً؟»</div>
    </div>
    <div class="ai-suggest" style="margin-top:14px">
      <button class="btn small secondary" data-ai-q="ما إجمالي مبيعات اليوم؟">مبيعات اليوم</button>
      <button class="btn small secondary" data-ai-q="ما المنتجات منخفضة المخزون؟">المخزون المنخفض</button>
      <button class="btn small secondary" data-ai-q="ما أكثر المنتجات مبيعاً؟">الأكثر مبيعاً</button>
      <button class="btn small secondary" data-ai-q="ما صافي الربح؟">صافي الربح</button>
      <button class="btn small secondary" data-ai-q="كم عدد العملاء النشطين؟">العملاء</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <input id="ai-input" placeholder="اكتب سؤالك هنا...">
      <button class="btn small" id="ai-send" style="margin-top:0">إرسال</button>
    </div></div>`;
  const ask = async (q) => {
    const log = $('ai-log');
    log.innerHTML += `<div class="ai-msg user">${esc(q)}</div>`;
    log.innerHTML += `<div class="ai-msg bot">جارٍ الحساب من Firestore...</div>`;
    const answer = await answerAI(q);
    log.querySelectorAll('.ai-msg.bot').item(log.querySelectorAll('.ai-msg.bot').length - 1).textContent = answer;
    log.scrollTop = log.scrollHeight;
  };
  document.querySelectorAll('[data-ai-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.aiQ)));
  $('ai-send').addEventListener('click', () => { const v = $('ai-input').value.trim(); if (v) { $('ai-input').value = ''; ask(v); } });
  $('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ai-send').click(); });
}
async function answerAI(q) {
  const [sales, customers] = await Promise.all([loadCollection('salesInvoices'), loadCollection('customers')]);
  await loadProducts();
  const posted = sales.filter((s) => s.status === 'posted' && !s.isManualDebt);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todaySales = posted.filter((s) => tsToDate(s.date || s.createdAt) >= today)
    .reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const totalSales = posted.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const low = productsCache.filter((p) => { const st = productStock(p); return st !== null && st > 0 && Number(p.minStock || 0) > 0 && st < Number(p.minStock); });
  const active = customers.filter((c) => c.isActive !== false).length;
  if (/مبيعات اليوم|مبيعات النهاردة|بيع.*اليوم/.test(q)) return `مبيعات اليوم: ${fmtEGP(todaySales)} (${posted.filter((s) => tsToDate(s.date || s.createdAt) >= today).length} فاتورة منشورة).`;
  if (/ربح/.test(q)) {
    let cogs = 0;
    await loadInvoiceItems(posted.slice(0, 60));
    for (const inv of posted.slice(0, 60)) {
      (invoiceItemsCache[inv.id] || []).forEach((d) => { cogs += Number(d.costPricePiasters || 0) * Number(d.quantity || 0); });
    }
    return `صافي الربح الإجمالي (من آخر 60 فاتورة): ${fmtEGP(totalSales - cogs)} — الإيراد ${fmtEGP(totalSales)} ناقص تكلفة البضاعة ${fmtEGP(cogs)}.`;
  }
  if (/منخفض|ناقص|مخزون/.test(q)) {
    if (!low.length) return 'لا توجد منتجات منخفضة المخزون حالياً — كل المنتجات فوق حد إعادة الطلب.';
    return `يوجد ${low.length} منتج منخفض المخزون:\n` + low.slice(0, 8).map((p) => `• ${p.name_ar} — متبقي ${fmtNum(productStock(p))} / حد ${fmtNum(p.minStock)}`).join('\n');
  }
  if (/الأكثر مبيعاً|أكثر.*مبيع|أفضل/.test(q)) {
    const sold = {};
    await loadInvoiceItems(posted.slice(0, 60));
    for (const inv of posted.slice(0, 60)) {
      (invoiceItemsCache[inv.id] || []).forEach((d) => { sold[d.productId] = (sold[d.productId] || 0) + Number(d.quantity || 0); });
    }
    const top = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!top.length) return 'لا توجد مبيعات مسجلة بعد لأحدد الأكثر مبيعاً.';
    const byId = Object.fromEntries(productsCache.map((p) => [p.id, p]));
    return 'أكثر المنتجات مبيعاً:\n' + top.map(([pid, qty], i) => `${i + 1}. ${(byId[pid] || {}).name_ar || pid} — ${fmtNum(qty)} قطعة`).join('\n');
  }
  if (/عملاء|عميل/.test(q)) return `عدد العملاء النشطين: ${active} من أصل ${customers.length} عميل مسجل.`;
  if (/مبيعات/.test(q)) return `إجمالي المبيعات المنشورة: ${fmtEGP(totalSales)} (${posted.length} فاتورة)، منها مبيعات اليوم ${fmtEGP(todaySales)}.`;
  return 'أستطيع الإجابة عن: مبيعات اليوم والإجمالي، صافي الربح، المنتجات منخفضة المخزون، أكثر المنتجات مبيعاً، وعدد العملاء النشطين — جرّب أحد هذه الأسئلة.';
}

// ============================================================================
// 14) المساعدة والدعم
// ============================================================================
async function renderHelp() {
  $('page').innerHTML = `
    <h2 class="page-title">❓ المساعدة والدعم</h2>
    <p class="page-sub">دليل سريع لاستخدام نظام الفلكي.</p>
    <div class="grid-2">
      <div class="card"><h3>🔐 الدخول</h3><p style="line-height:1.9">الدخول بإيميل وكلمة مرور حسابك في Firebase Auth. التسجيل العام مغلق — الحسابات ينشئها المالك فقط من إدارة الموظفين. كلمة مرور فتح الواجهة موجودة في نسخة التطبيق الكاملة فقط.</p></div>
      <div class="card"><h3>📷 البحث بالكاميرا</h3><p style="line-height:1.9">من أي صفحة: اضغط «📷 مسح» ووجّه الكاميرا لباركود أو QR القطعة، وستظهر بطاقتها كاملة (الاسم، رقم القطعة، السعر، المخزون، المخزن، المورد) مع «إضافة للبيع» و«تعديل». وإن لم تعمل الكاميرا أدخل الكود يدوياً.</p></div>
      <div class="card"><h3>🛒 نقطة البيع</h3><p style="line-height:1.9">أضف المنتجات بالبحث أو المسح، اختر العميل وطريقة الدفع، ثم «تأكيد البيع». تُحفظ الفاتورة مع بنودها وحركات المخزون في Firestore. الفاتورة المنشورة لا تُحذف — الإلغاء يكون بعكسها من التطبيق الكامل.</p></div>
      <div class="card"><h3>📦 المنتجات والمخزون</h3><p style="line-height:1.9">صفحة «المنتجات» هي الكتالوج الكامل: إضافة وتعديل وإيقاف/تفعيل حسب صلاحيتك. وصفحة «المخزون» تعرض الأرصدة وحالتها (متوفر/منخفض/نافد) وقيمة المخزون.</p></div>
      <div class="card"><h3>👤 الموظفون</h3><p style="line-height:1.9">المالك فقط ينشئ حسابات الموظفين ويحدد واجهاتهم وصلاحياتهم من صفحة إدارة الموظفين، ويفعّل أو يوقف أي حساب في أي وقت — وسجلات الموظف السابقة تبقى محفوظة دائماً.</p></div>
      <div class="card"><h3>🔥 البيانات</h3><p style="line-height:1.9">كل البيانات في مشروع Firebase «al-falaky-erp» (Firestore في eur3) وتظهر الأرقام من استعلامات حية. عند ظهور خطأ صلاحيات، فحسابك يحتاج تصاريح (orgId / role / branchIds) يضبطها المالك.</p></div>
      <div class="card"><h3>💳 المديونيات والفواتير</h3><p style="line-height:1.9">من «مديونيات العملاء/الموردين» ترى كل جهة ورصيدها والفواتير المفتوحة وتواريخ استحقاقها، وتسجّل تسديد جزء بأي مبلغ وطريقة دفع (نقدي/تحويل/فودافون كاش/شيك)، ويظهر المتبقي فوراً. ومن زر «إنشاء فاتورة» في المبيعات أو المشتريات تنشئ فاتورة مباشرة باختيار المنتج بالبحث أو الكاميرا دون سلة، ثم تطبعها A4 باسم الفلكي من زر «طباعة».</p></div>
    </div>`;
}

// ============================================================================
// 15) المديونيات والدفعات وإنشاء الفواتير والطباعة
// ملاحظات قواعد Firestore (منشورة — لا تُفترض قابليتها للتغيير):
// • الفاتورة المنشورة لا يُحدَّث فيها paid/remaining أبداً — المتبقي وحالة
//   السداد مشتقّان في العميل: المتبقي = الإجمالي − المدفوع عند الإنشاء −
//   مجموع الدفعات اللاحقة من salesPayments / purchasePayments.
// • الدفعات append-only: إنشاء فقط، بلا تعديل أو حذف.
// • رصيد العميل/المورد المخزّن هو currentBalancePiasters ويُحدَّث مع كل دفعة
//   ومع كل فاتورة آجلة جديدة.
// • الصندوق/البنك يُحدَّثان بأفضل جهد منفصل (غير ذري مع الدفعة) حتى لا يفشل
//   تسجيل دفعة صحيحة بسبب رفض قاعدة على الصندوق (مثلاً دور sales لا يحدّث
//   الخزائن، أو رصيد لا يكفي) — ويُعرض سبب عدم التنفيذ للمستخدم.
// • كل الاستعلامات بدون orderBy على الخادم (تجنباً للفهارس المركبة) —
//   الترتيب والتصفية في العميل.
// ============================================================================
const PAY_METHODS = [
  ['cash', '💵 نقدي'], ['bank_transfer', '🏦 تحويل بنكي'], ['vodafone_cash', '📱 فودافون كاش'],
  ['cheque', '🧾 شيك'], ['visa', '💳 فيزا'], ['instapay', '⚡ إنستاباي'], ['adjustment', '⚖️ تسوية/تعديل']
];
const payMethodLabel = (m) => (PAY_METHODS.find(([v]) => v === m) || [null, m || '—'])[1];
const payStatusOf = (total, paid) => paid >= total ? 'paid' : paid > 0 ? 'partial' : 'credit';
const payStatusLabel = (s) => ({ paid: 'مدفوع', partial: 'جزئي', credit: 'آجل' }[s] || s);
const payStatusBadgeCls = (s) => s === 'paid' ? 'ok' : s === 'partial' ? 'warn' : '';
function remainingOf(inv, payByInv) {
  return Math.max(0, Number(inv.totalPiasters || 0) - Number(inv.paidPiasters || 0) - (payByInv[inv.id] || 0));
}
// revision 11c: المتبقي المشتق من قائمة دفعات (مصفوفة)، لا من خريطة.
// remainingOf يتوقع خريطة مفتاحها رقم الفاتورة (payByInv[inv.id])؛ تمرير
// مصفوفة إليه كان يتجاهل الدفعات كلها (invPayments[inv.id] غير معرّف)
// فيحسب المتبقي = الإجمالي، ثم يضيف مبلغ الدفعة المحذوفة فيتجاوز
// الإجمالي (200 + 50 = 250). هذه الدالة تأخذ المصفوفة مباشرة وتقيّد
// الناتج بين 0 والإجمالي — وتُستخدم في حوار الحذف وفي المعاملة معاً.
function remainingFromPayments(inv, payments) {
  const total = Number(inv.totalPiasters || 0);
  const paid = payments.reduce((a, p) => a + Number(p.amountPiasters || 0), 0);
  return Math.min(total, Math.max(0, total - Number(inv.paidPiasters || 0) - paid));
}
function paidOf(inv, payByInv) { return Number(inv.totalPiasters || 0) - remainingOf(inv, payByInv); }
// مديونية جهة واحدة = المتبقي المشتق من فواتيرها المفتوحة + رصيدها الافتتاحي.
// الرصيد المخزّن currentBalancePiasters يساوي هذا المجموع عندما يكون محدَّثاً،
// لكن بيانات العينة وبعض المسارات القديمة تركته قديماً (مثلاً مورد NGK كان صفراً
// رغم مديونية 16,694) — فالمشتق + الافتتاحي هو المرجع الوحيد لكل العروض.
function contactOwed(c, openList) {
  const derived = (openList || []).reduce((a, x) => a + x.remaining, 0);
  return derived + Math.max(0, Number((c || {}).openingBalancePiasters || 0));
}
function dueDateOf(inv) {
  if (inv.dueDate) return tsToDate(inv.dueDate);
  return new Date(tsToDate(inv.date || inv.createdAt).getTime() + 30 * 24 * 3600 * 1000);
}
function dateInputVal(d) {
  const x = d instanceof Date ? d : tsToDate(d);
  if (!x || isNaN(x)) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function parseDateInput(v) {
  if (!v) return null;
  const [y, m, d] = v.split('-').map(Number);
  return Timestamp.fromDate(new Date(y, m - 1, d, 12, 0, 0));
}
function canRecordPayment(kind) {
  return kind === 'customers'
    ? ['owner', 'manager', 'sales', 'accountant'].includes(me.role)
    : ['owner', 'manager', 'accountant'].includes(me.role);
}
function canCreateInvoice(kind) {
  return kind === 'sales'
    ? ['owner', 'manager', 'sales'].includes(me.role)
    : ['owner', 'manager', 'inventory', 'accountant'].includes(me.role);
}

// --- أثر الدفعة على الصندوق/البنك (أفضل جهد — لا يفشل تسجيل الدفعة) ---
// --- معاملة ذرية واحدة لكل حفظ مالي ---------------------------------------
// مستند الدفعة/الفاتورة + رصيد الجهة + الصندوق/البنك في runTransaction واحدة:
// إما أن تُحفظ كلها معاً، أو لا يُحفظ شيء.
// * معرّف العملية حتمي ومستقر عبر إعادة المحاولة (opId)، وداخل المعاملة نتحقق
//   أولاً مما إذا كانت العلامة موجودة — فوجودها يثبت أن المعاملة
//   كلها التزمت من قبل، فتعود المحاولة مبكراً دون إعادة تطبيق أي أثر.
// * رصيد الصندوق/البنك يُقرأ داخل المعاملة، فأي تعارض يعيد المحاولة بقيم جديدة.
// * العملية المعلقة محفوظة في localStorage (تنجو من إغلاق التبويب) بالحمولة
//   الكاملة (كل الحقول التي تؤثر على المال أو السجل) مع معرّفها — لا معرّفاً
//   وحده. إعادة المحاولة بنفس الحمولة تعيد استخدام نفس المعرف. إعادة المحاولة
//   بحمولة مختلفة تُحظَر: نتحقق أولاً مما إذا كانت العملية الأصلية قد التزمت
//   (تسوية)، ثم على المستخدم إما العودة للقيم الأصلية أو تجاهل العملية
//   المعلقة صراحةً. لا نعيد قيماً قديمة بصمت أبداً، ولا ننشئ عملية ثانية
//   لنفس الحفظ.
// * النطاق: المفتاح يتضمن uid المستخدم و orgId — فلا تتسرب عملية معلقة من
//   مستخدم إلى آخر على نفس الجهاز، ولا من منظمة إلى أخرى.
// ⚠️ "تجاهل المعلقة" ليس مخرجاً آمناً من عملية مجهولة الحالة:
//   - إذا كانت العلامة موجودة (العملية التزمت) → نعرض القيم المحفوظة ونمنع
//     أي عملية ثانية. لا تجاهل هنا.
//   - إذا كانت الحالة مجهولة (تعذّرت قراءة العلامة — انقطاع/خطأ) → نمنع
//     أي استبدال حتى تُسوَّى الحالة (إعادة قراءة العلامة ثم الدفعة/الفاتورة).
//     لا تجاهل، لا عملية جديدة، حتى تُعرف الحالة.
//   - فقط إذا تأكدنا أن العلامة غائبة (العملية لم تلتزم) يُسمح للمستخدم
//     بتجاهل المعلقة صراحةً والمتابعة بالقيم الجديدة.
// ⚠️ تغييرات سلوك (قرارات منفصلة — انظر proposal §6):
//   (1) رصيد غير كافٍ: الدفعة تفشل ولا تُسجَّل إطلاقاً (قبل: تُسجَّل وتُتخطى الصندوق).
//   (2) دفع زائد: النموذج يمنع تجاوز المتبقي؛ المعاملة لا تعيد الفحص.
//   (3) تثبيت الرصيد: رصيد الجهة لا ينزل تحت الصفر (Math.max(0, ...)).

const PENDING_OP_PREFIX = 'alfalaky.pendingOp.';
// نطاق العملية المعلقة: uid المستخدم + orgId — يمنع التسرب عبر المستخدمين/المنظمات.
function pendingOpScope() {
  const uid = (me && me.uid) ? String(me.uid) : 'anon';
  const orgId = (me && me.orgId) ? String(me.orgId) : 'noorg';
  return { uid, orgId };
}
function pendingOpKey(parts) {
  const s = pendingOpScope();
  return PENDING_OP_PREFIX + s.uid + '.' + s.orgId + '.' + parts.map((p) => String(p ?? 'none')).join(':');
}
// كل مفاتيح العمليات المعلقة الخاصة بالمستخدم+المنظمة الحاليين (للتسوية عند التحميل).
function listPendingOpKeys() {
  const s = pendingOpScope();
  const prefix = PENDING_OP_PREFIX + s.uid + '.' + s.orgId + '.';
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch (e) { /* التخزين غير متاح */ }
  return out;
}
function newOpId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
// مقارنة قانونية للحمولات (مفاتيح مرتبة) حتى لا يؤثر ترتيب الحقول.
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function payloadsEqual(a, b) { return canon(a) === canon(b); }
// العملية المعلقة: { opId, payload, uid, orgId, createdAt } — الحمولة الكاملة، لا المعرف وحده.
function readPendingOp(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return (v && v.opId && v.payload) ? v : null;
  } catch (e) { return null; }
}
function writePendingOp(key, opId, payload) {
  try {
    const s = pendingOpScope();
    localStorage.setItem(key, JSON.stringify({ opId, payload, uid: s.uid, orgId: s.orgId, createdAt: Date.now() }));
  } catch (e) { /* التخزين غير متاح */ }
}
function clearPendingOp(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
// يصف الفروق بين حمولتين (لرسالة الحظر) — سطر لكل حقل مختلف.
function payloadDiffLines(stored, current) {
  const lines = [];
  const keys = [...new Set([...Object.keys(stored || {}), ...Object.keys(current || {})])].sort();
  for (const k of keys) {
    const a = canon(stored ? stored[k] : undefined);
    const b = canon(current ? current[k] : undefined);
    if (a !== b) lines.push(`${k}: ${a} ← ${b}`);
  }
  return lines;
}
// تسوية عملية معلقة: نقرأ العلامة أولاً، ثم مستند الدفعة/الفاتورة إن وُجدت.
// يعيد { status: 'committed'|'not-committed'|'unknown', saved }.
//   committed: العلامة موجودة → العملية التزمت؛ saved = القيم المحفوظة.
//   not-committed: العلامة غائبة قطعاً → العملية لم تلتزم.
//   unknown: تعذّرت قراءة العلامة (شبكة/صلاحية) → الحالة مجهولة، لا قرار.
// readSaved: دالة async اختيارية تستلم opId وتعيد القيم المحفوظة من مستند
// الدفعة/الفاتورة (تُستدعى فقط إذا كانت العلامة موجودة).
async function reconcilePendingOp(stored, readSaved) {
  try {
    const s = await getDoc(markerRefFor(stored.opId));
    if (s.exists()) {
      let saved = null;
      if (readSaved) { try { saved = await readSaved(stored.opId); } catch (e) { saved = null; } }
      return { status: 'committed', saved };
    }
    return { status: 'not-committed', saved: null };
  } catch (e) {
    return { status: 'unknown', saved: null };
  }
}
// بداية عملية محفوظة. يعيد:
//   { action:'proceed', opId } — لا عملية معلقة، أو الحمولة مطابقة (إعادة محاولة).
//   { action:'blocked', stored, committed:true, saved } — الحمولة مختلفة
//     والعملية الأصلية التزمت → لا عملية ثانية؛ اعرض القيم المحفوظة.
//   { action:'blocked', stored, committed:false } — الحمولة مختلفة والعملية
//     الأصلية لم تلتزم قطعاً → يجوز للمستخدم تجاهلها صراحةً والمتابعة.
//   { action:'unknown', stored } — تعذّرت معرفة حالة العملية الأصلية →
//     ممنوع أي استبدال حتى تُسوَّى الحالة (أعد المحاولة لاحقاً).
// checkCommitted: دالة async تستلم opId المخزن وتعيد { committed, saved }
// أو true/false (للتوافق). readSaved: دالة async اختيارية لجلب القيم المحفوظة.
async function beginPendingOp(key, payload, checkCommitted, readSaved) {
  const stored = readPendingOp(key);
  if (!stored) {
    const opId = newOpId();
    writePendingOp(key, opId, payload);
    return { action: 'proceed', opId };
  }
  if (payloadsEqual(stored.payload, payload)) {
    return { action: 'proceed', opId: stored.opId };
  }
  // الحمولة مختلفة — يجب تسوية العملية الأصلية أولاً قبل أي استبدال.
  let rec;
  try {
    if (checkCommitted) {
      const r = await checkCommitted(stored.opId);
      if (r && typeof r === 'object') rec = { status: r.committed ? 'committed' : 'not-committed', saved: r.saved || null };
      else rec = { status: r ? 'committed' : 'not-committed', saved: null };
      if (rec.status === 'committed' && !rec.saved && readSaved) {
        try { rec.saved = await readSaved(stored.opId); } catch (e) { rec.saved = null; }
      }
    } else {
      rec = await reconcilePendingOp(stored, readSaved);
    }
  } catch (e) {
    return { action: 'unknown', stored };
  }
  if (rec.status === 'unknown') return { action: 'unknown', stored };
  if (rec.status === 'committed') return { action: 'blocked', stored, committed: true, saved: rec.saved };
  return { action: 'blocked', stored, committed: false, saved: null };
}
// يبني رسالة حظر بشرية من عملية معلقة مختلفة: يعرض القيم الأصلية والمختلفة
// وحالة الالتزام، ويسأل المستخدم إن كان يريد تجاهل العملية المعلقة والمتابعة
// بالقيم الجديدة. يُستدعى فقط عندما تأكدنا أن العملية الأصلية لم تلتزم
// (committed === false). يعيد true إذا وافق المستخدم على التجاهل، false إذا ألغى.
function confirmDiscardPendingOp(stored, current, committed, what) {
  const diffs = payloadDiffLines(stored.payload, current);
  const status = 'العملية الأصلية غير محفوظة (لم يصل تأكيدها) — لكن لا يمكن استبدالها بعملية جديدة دون تجاهلها صراحةً.';
  const msg = `⚠️ توجد عملية ${what} معلقة بقيم مختلفة عن القيم الحالية.
${status}

القيم الأصلية (المعلقة):
${diffs.map((d) => '• ' + d).join('\n')}

اضغط "موافق" لتجاهل العملية المعلقة والمتابعة بالقيم الجديدة، أو "إلغاء" للعودة ومراجعة القيم الأصلية أولاً.`;
  return confirm(msg);
}
// رسالة الحظر عندما تكون العملية الأصلية محفوظة بالفعل (لا تجاهل، لا عملية ثانية).
function committedBlockMessage(stored, saved, what) {
  const savedLine = saved
    ? `\nالقيم المحفوظة: ${Object.entries(saved).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('، ')}.`
    : '';
  return `العملية ${what} الأصلية محفوظة بالفعل — لا يمكن إنشاء عملية ثانية بنفس الهوية.${savedLine}\nراجع القيم المحفوظة أعلاه؛ لا حاجة لإعادة الحفظ.`;
}
// رسالة الحظر عندما تكون حالة العملية الأصلية مجهولة (لا تجاهل، لا استبدال).
function unknownBlockMessage(what) {
  return `تعذّر التحقق من حالة العملية ${what} المعلقة — تحقق من الاتصال وحاول مرة أخرى. لم يُنشأ أي شيء، ولم تُتجاهل العملية المعلقة. لا يمكن استبدالها حتى تُعرف حالتها.`;
}
// تسوية كل العمليات المعلقة للمستخدم+المنظمة الحاليين عند تحميل التطبيق
// (بعد تسجيل الدخول). العمليات الملتزمة تُمسح (وتُعرض قيمها)؛ غير الملتزمة
// تُترك ليعرضها الحفظ التالي؛ المجهولة تُترك مع تحذير.
async function reconcilePendingOpsOnLoad() {
  const keys = listPendingOpKeys();
  if (!keys.length) return;
  for (const key of keys) {
    const stored = readPendingOp(key);
    if (!stored) continue;
    try {
      const rec = await reconcilePendingOp(stored, null);
      if (rec.status === 'committed') {
        clearPendingOp(key);
        showToast(`عملية معلقة سابقة تم حفظها بالفعل (opId: ${stored.opId.slice(0, 8)}…) — لم يُضف أي أثر مكرر.`);
      }
      // not-committed و unknown: تُترك كما هي؛ الحفظ التالي يسوّيها.
    } catch (e) { /* تُترك كما هي */ }
  }
}

function isBankMethod(method) { return method === 'bank_transfer' || method === 'visa' || method === 'instapay'; }
function movesMoney(method) { return method !== 'adjustment' && method !== 'vodafone_cash' && method !== 'cheque'; }

// --- حارس العملية: علامة (marker) في مجموعة opMarkers --------------------
// مشكلة قواعد القراءة: فحص الوجود داخل المعاملة يقرأ مستند الدفعة/الفاتورة
// قبل وجوده، وقواعد القراءة الحالية تصل إلى resource.data.orgId فينكر
// القراءة لأن resource يكون null للمستند الغائب. الحل: نقرأ علامة في مجموعة
// opMarkers بدلاً من مستند الدفعة/الفاتورة نفسه. قواعد opMarkers لا تصل إلى
// resource.data إلا بعد التأكد من وجود المستند (resource == null أولاً)،
// فقراءة علامة غائبة مسموحة وتعيد "غير موجود" دون خطأ. العلامة تُكتب في نفس
// المعاملة مع الدفعة/الفاتورة، فوجودها يثبت أن المعاملة كلها التزمت.
// العلامة لا تحمل بيانات حساسة (opId + orgId + kind + وقت فقط)، وopId عشوائي
// لا يمكن تخمينه، فلا تسريب عبرها. انظر proposal §5.
function markerRefFor(opId) { return doc(db, 'opMarkers', opId); }
// معرّفا الصندوق/البنك منظما النطاق — فلا يتصادم منظمتان على cash_main العام.
// (انظر proposal §5e: تصميم الصناديق منظمة النطاق.)
function orgScopedCashboxId(org, branch) { return 'cash_' + String(org) + '_' + String(branch); }
function orgScopedBankId(org, branch) { return 'bank_' + String(org) + '_' + String(branch); }
// علامة التهيئة: مستند واحد في opMarkers يثبت أن التهيئة تمت للمنظمة+الفرع.
function setupMarkerRefFor(org, branch) { return doc(db, 'opMarkers', 'setup-' + String(org) + '-' + String(branch)); }

// هل يستطيع المستخدم الحالي الكتابة في الصندوق/البنك؟
// القواعد: isAccountantOrAbove = owner | manager | accountant فقط.
// دور sales (و inventory) لا يستطيع — فمعاملة البيع النقدي له لا تشمل
// الصندوق، بل تُسجَّل الدفعة/الفاتورة ذرياً وتُعلَّم cashEffect:'pending'
// ليعتمدها محاسب لاحقاً. البيع نفسه لا ينكسر، والدور لا يكسب أي وصول للصندوق.
function canWriteMoneyBox() { return !!me && ['owner', 'manager', 'accountant'].includes(me.role); }

// يحدد مستند الصندوق/البنك المستهدف بالاستعلام (orgId + الفرع) — قراءة فقط،
// قبل المعاملة. داخل المعاملة يُعاد قراءة المستند نفسه عبر tx.get.
// ⚠️ لا رجوع إلى معرّف عام (cash_main / bank_main): إن لم يوجد صندوق أو
// حساب بنكي نشط للمنظمة+الفرع، نرمي خطأً واضحاً ولا نبدأ المعاملة أصلاً —
// فلا tx.get على مستند غائب (مرفوض في القواعد)، ولا إنشاء صندوق داخل
// معاملة دفع. الصندوق يُنشأ مرة واحدة في التهيئة (انظر زر التهيئة).
// انظر proposal §5e.
async function resolveMoneyBoxRef(method) {
  if (isBankMethod(method)) {
    const banks = await loadCollection('bankAccounts');
    // نفضّل الحساب المنظم النطاق (حتمي) إن وُجد — فإن وُجد حسابان نشطان
    // (قديم عام + جديد منظم النطاق) فالدفعات تذهب دائماً إلى المنظم النطاق.
    const bank = banks.find((b) => b.isActive !== false && b.id === orgScopedBankId(orgId, DEFAULT_BRANCH))
      || banks.find((b) => b.isActive !== false);
    if (!bank) throw new Error('NO_BANK_ACCOUNT');
    return { ref: doc(db, 'bankAccounts', bank.id), isBank: true, label: 'الحساب البنكي الرئيسي' };
  }
  const boxes = await loadCollection('cashboxes');
  const box = boxes.find((c) => c.isActive !== false && c.id === orgScopedCashboxId(orgId, DEFAULT_BRANCH))
    || boxes.find((c) => c.isActive !== false && c.branchId === DEFAULT_BRANCH)
    || boxes.find((c) => c.isActive !== false);
  if (!box) throw new Error('NO_CASHBOX');
  return { ref: doc(db, 'cashboxes', box.id), isBank: false, label: 'الصندوق الرئيسي' };
}

// يطبق أثر الصندوق/البنك داخل معاملة. يُستدعى من داخل runTransaction فقط.
// boxSnap هو نتيجة tx.get(boxRef) داخل المعاملة نفسها (مقروءة بإصدار).
// يرمي INSUFFICIENT_FUNDS إذا كان الرصيد الجديد سيصبح سالباً — فيُلغى كل شيء.
function applyMoneyMovementTx(tx, boxRef, isBank, boxSnap, direction, amountPiasters) {
  // الصندوق موجود قطعاً هنا: resolveMoneyBoxRef تحققت منه بالاستعلام قبل
  // المعاملة، ورمت خطأً واضحاً إن لم يوجد. فإن غاب المستند فجأة (لا يحدث
  // عملياً — الحذف ممنوع في القواعد)، نرمي ولا ننشئ صندوقاً داخل المعاملة.
  if (!boxSnap.exists()) throw new Error(isBank ? 'NO_BANK_ACCOUNT' : 'NO_CASHBOX');
  const cur = Number(boxSnap.data().balancePiasters || 0);
  const next = cur + direction * amountPiasters;
  if (next < 0) throw new Error('INSUFFICIENT_FUNDS');
  tx.update(boxRef, { balancePiasters: next, updatedAt: serverTimestamp() });
  return next;
}

// --- تسوية الصندوق (settlement design, implemented) -----------------------
// A sales user records a cash payment/sale atomically but cannot write the
// cashbox/bank, so the payment/invoice is flagged cashEffect:'pending'.
// An owner/manager/accountant applies each pending item exactly once via a
// runTransaction that follows the SAME marker pattern as the payment fix:
// the settlement marker (opMarkers/'settle-'+opId, kind 'settlement') + a
// cashSettlements audit doc + the cashbox update, ALL in one transaction.
// A retry/double-click finds the marker and returns alreadyApplied with the
// saved values — the cashbox moves at most once per pending item.
// See cash-settlement-design.md and proposal §7.

function settleMarkerRefFor(opId) { return doc(db, 'opMarkers', 'settle-' + opId); }

// Derives the operation id from a payment doc id ('pay-'+opId -> opId).
function opIdFromPayDocId(id) { return (id || '').startsWith('pay-') ? id.slice(4) : id; }

// Loads the pending settlement items for this org, deduplicated by opId.
// A POS/invoice-form cash sale flags BOTH the invoice (doc id = opId) and
// its payment doc ('pay-'+opId) with cashEffect:'pending' — they are ONE
// operation and one cash effect, so the list is keyed by opId and the
// amount always comes from the payment doc (the invoice's paidPiasters is
// 0 by the v_k fix; the payment doc carries the paid amount). A
// recordPayment flags only its payment doc. Items that already have a
// cashSettlements record are excluded (the payment doc itself is never
// updated — its update rule is false — so the flag stays 'pending' and the
// settlement record is what marks it settled).
async function loadPendingSettlements() {
  const [salesPay, purchPay, salesInv, purchInv, settled] = await Promise.all([
    loadCollection('salesPayments'), loadCollection('purchasePayments'),
    loadCollection('salesInvoices'), loadCollection('purchaseInvoices'),
    loadCollection('cashSettlements')
  ]);
  const settledOpIds = new Set(settled.map((s) => s.opId));
  const byOpId = {};
  const addPay = (p, coll, direction) => {
    if (p.cashEffect !== 'pending') return;
    const opId = opIdFromPayDocId(p.id);
    if (settledOpIds.has(opId)) return;
    byOpId[opId] = {
      opId, kind: 'payment', coll, docId: p.id, paymentId: p.id,
      invoiceId: p.salesInvoiceId || p.purchaseInvoiceId || null,
      amountPiasters: Number(p.amountPiasters || 0), paymentMethod: p.paymentMethod || 'cash',
      direction, contactId: p.customerId || p.supplierId || null,
      invoiceNumber: null, createdBy: p.receivedBy || p.createdBy || null,
      dateMs: p.date ? tsToDate(p.date).getTime() : (p.createdAt ? tsToDate(p.createdAt).getTime() : 0)
    };
  };
  salesPay.forEach((p) => addPay(p, 'salesPayments', 1));
  purchPay.forEach((p) => addPay(p, 'purchasePayments', -1));
  // Invoices: only add if no payment doc already claimed this opId (the
  // payment carries the amount); otherwise the invoice is the fallback
  // source for the paid amount (total - remaining).
  const addInv = (inv, coll, direction) => {
    if (inv.cashEffect !== 'pending') return;
    const opId = inv.id;
    if (settledOpIds.has(opId)) return;
    if (byOpId[opId]) { byOpId[opId].invoiceNumber = inv.invoiceNumber || byOpId[opId].invoiceNumber; return; }
    const paid = Math.max(0, Number(inv.totalPiasters || 0) - Number(inv.remainingPiasters || 0));
    byOpId[opId] = {
      opId, kind: 'invoice', coll, docId: inv.id, paymentId: null, invoiceId: inv.id,
      amountPiasters: paid, paymentMethod: inv.paymentMethod || 'cash',
      direction, contactId: inv.customerId || inv.supplierId || null,
      invoiceNumber: inv.invoiceNumber || null, createdBy: inv.createdBy || null,
      dateMs: inv.date ? tsToDate(inv.date).getTime() : (inv.createdAt ? tsToDate(inv.createdAt).getTime() : 0)
    };
  };
  salesInv.forEach((i) => addInv(i, 'salesInvoices', 1));
  purchInv.forEach((i) => addInv(i, 'purchaseInvoices', -1));
  const items = Object.values(byOpId).sort((a, b) => a.dateMs - b.dateMs);
  const receipts = items.filter((i) => i.direction > 0).reduce((a, i) => a + i.amountPiasters, 0);
  const payouts = items.filter((i) => i.direction < 0).reduce((a, i) => a + i.amountPiasters, 0);
  return { items, receipts, payouts, settledCount: settled.length };
}

// Applies ONE pending item exactly once. Follows the marker pattern: the
// settlement marker + the cashSettlements audit doc + the cashbox update,
// ALL in one runTransaction. A retry/double-click finds the marker and
// returns alreadyApplied with the saved values (no second cashbox move).
// Insufficient funds aborts everything — the item stays pending.
async function settlePendingItem(item) {
  if (!canWriteMoneyBox()) { showToast('ليس لديك صلاحية لتسوية أثر الصندوق.'); return; }
  const org = me.orgId;
  const markerRef = settleMarkerRefFor(item.opId);
  const settleRef = doc(db, 'cashSettlements', 'settle-' + item.opId);
  let box;
  try {
    box = await resolveMoneyBoxRef(item.paymentMethod);
  } catch (err) {
    showToast(firestoreErrorMessage(err));
    return;
  }
  const btn = document.querySelector(`[data-settle="${item.opId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جارٍ التسوية...'; }
  try {
    const result = await runTransaction(db, async (tx) => {
      // (1) Existence check via the MARKER (allowed even when missing).
      const markerSnap = await tx.get(markerRef);
      if (markerSnap.exists()) {
        const ex = await tx.get(settleRef);
        const d = ex.exists() ? ex.data() : {};
        return { alreadyApplied: true, saved: { amountPiasters: d.amountPiasters, boxId: d.boxId, settledBy: d.settledBy } };
      }
      // (2) Re-read the source doc inside the transaction for the amount
      // and method (it exists — the pending list only shows existing docs).
      const srcRef = doc(db, item.coll, item.docId);
      const srcSnap = await tx.get(srcRef);
      if (!srcSnap.exists()) throw new Error('المستند الأصلي غير موجود — لا يمكن تسويته.');
      const src = srcSnap.data();
      const isPay = item.coll.endsWith('Payments');
      const amount = isPay
        ? Number(src.amountPiasters || 0)
        : Math.max(0, Number(src.totalPiasters || 0) - Number(src.remainingPiasters || 0));
      const method = src.paymentMethod || item.paymentMethod || 'cash';
      // (3) Read the cashbox/bank inside the transaction; check sufficient
      // funds for a payout; update it (INSUFFICIENT_FUNDS aborts all).
      const boxSnap = await tx.get(box.ref);
      const nextBox = applyMoneyMovementTx(tx, box.ref, box.isBank, boxSnap, item.direction, amount);
      const curBox = nextBox - item.direction * amount;
      // (4) Write the marker AND the settlement record in the same transaction.
      tx.set(markerRef, { orgId: org, opId: 'settle-' + item.opId, kind: 'settlement', createdAt: serverTimestamp() });
      tx.set(settleRef, {
        orgId: org, opId: item.opId, paymentId: item.paymentId || null, invoiceId: item.invoiceId || null,
        amountPiasters: amount, paymentMethod: method, direction: item.direction,
        boxId: box.ref.id, boxKind: box.isBank ? 'bank' : 'cashbox',
        boxBalanceBeforePiasters: curBox, boxBalanceAfterPiasters: nextBox,
        settledBy: me.uid, settledAt: serverTimestamp(), createdAt: serverTimestamp()
      });
      return { alreadyApplied: false, amountPiasters: amount, boxId: box.ref.id, boxBalanceAfterPiasters: nextBox };
    });
    if (result.alreadyApplied) {
      showToast(`هذه التسوية مطبَّقة بالفعل — لم يُضف أي أثر مكرر. المبلغ المحفوظ: ${fmtEGP(result.saved.amountPiasters)}.`);
    } else {
      showToast(`تمت التسوية: ${fmtEGP(result.amountPiasters)} ${item.direction > 0 ? 'إلى' : 'من'} ${box.label}. الرصيد الآن ${fmtEGP(result.boxBalanceAfterPiasters)}.`);
    }
    await go('settlement');
  } catch (err) {
    if (err && err.message === 'INSUFFICIENT_FUNDS') {
      showToast('رصيد الصندوق/البنك لا يكفي لخصم هذا المبلغ — لم تُسجَّل التسوية. البند يبقى معلّقاً.');
    } else {
      showToast(firestoreErrorMessage(err));
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✅ تسوية'; }
  }
}

// Renders the settlement page (owner/manager/accountant only — see canSee).
// Shows the pending totals, the projected balance after settling everything,
// and one row per pending operation with an Apply button.
async function renderSettlement() {
  const { items, receipts, payouts, settledCount } = await loadPendingSettlements();
  // Current balances, per box kind, for the projected balance.
  let cashBal = null, bankBal = null;
  try { const b = await resolveMoneyBoxRef('cash'); const s = await getDoc(b.ref); cashBal = s.exists() ? Number(s.data().balancePiasters || 0) : 0; } catch (e) { /* no cashbox yet */ }
  try { const b = await resolveMoneyBoxRef('bank_transfer'); const s = await getDoc(b.ref); bankBal = s.exists() ? Number(s.data().balancePiasters || 0) : 0; } catch (e) { /* no bank account yet */ }
  const cashReceipts = items.filter((i) => i.direction > 0 && !isBankMethod(i.paymentMethod)).reduce((a, i) => a + i.amountPiasters, 0);
  const cashPayouts = items.filter((i) => i.direction < 0 && !isBankMethod(i.paymentMethod)).reduce((a, i) => a + i.amountPiasters, 0);
  const bankReceipts = items.filter((i) => i.direction > 0 && isBankMethod(i.paymentMethod)).reduce((a, i) => a + i.amountPiasters, 0);
  const bankPayouts = items.filter((i) => i.direction < 0 && isBankMethod(i.paymentMethod)).reduce((a, i) => a + i.amountPiasters, 0);
  const projCash = cashBal !== null ? cashBal + cashReceipts - cashPayouts : null;
  const projBank = bankBal !== null ? bankBal + bankReceipts - bankPayouts : null;
  const rows = items.map((it) => {
    const d = it.dateMs ? new Date(it.dateMs).toLocaleDateString('ar-EG') : '—';
    const kind = it.kind === 'payment' ? 'دفعة' : 'فاتورة';
    const dir = it.direction > 0 ? '⬆️ تحصيل' : '⬇️ صرف';
    const method = (PAY_METHODS[it.paymentMethod] || it.paymentMethod);
    return `<tr>
      <td>${d}</td><td>${kind}</td><td>${esc(it.invoiceNumber || '—')}</td>
      <td>${dir}</td><td>${fmtEGP(it.amountPiasters)}</td><td>${esc(method)}</td>
      <td><button class="btn" data-settle="${it.opId}">✅ تسوية</button></td>
    </tr>`;
  }).join('');
  $('page').innerHTML = `
    <h2>⚖️ تسوية الصندوق</h2>
    <p style="color:var(--muted)">دفعات ومبيعات سجّلها موظفون لا يملكون صلاحية الكتابة في الصندوق/البنك، فبقي أثرها معلّقاً. طبّق كل بند مرة واحدة — إعادة التطبيق مستحيلة (العلامة تمنع التكرار).</p>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">تحصيلات معلّقة</div><div class="kpi-value">${fmtEGP(receipts)}</div></div>
      <div class="kpi"><div class="kpi-label">مصروفات معلّقة</div><div class="kpi-value">${fmtEGP(payouts)}</div></div>
      <div class="kpi"><div class="kpi-label">رصيد الصندوق الحالي</div><div class="kpi-value">${cashBal !== null ? fmtEGP(cashBal) : 'لا يوجد صندوق'}</div></div>
      <div class="kpi"><div class="kpi-label">الصندوق بعد التسوية</div><div class="kpi-value">${projCash !== null ? fmtEGP(projCash) : '—'}</div></div>
      <div class="kpi"><div class="kpi-label">رصيد البنك الحالي</div><div class="kpi-value">${bankBal !== null ? fmtEGP(bankBal) : 'لا يوجد حساب'}</div></div>
      <div class="kpi"><div class="kpi-label">البنك بعد التسوية</div><div class="kpi-value">${projBank !== null ? fmtEGP(projBank) : '—'}</div></div>
    </div>
    <p style="color:var(--muted)">تسويات مطبَّقة من قبل: ${settledCount}</p>
    ${items.length ? `<table class="tbl"><thead><tr><th>التاريخ</th><th>النوع</th><th>رقم الفاتورة</th><th>الاتجاه</th><th>المبلغ</th><th>طريقة الدفع</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">لا توجد بنود معلّقة — كل الأثار مطبَّقة.</div>'}`;
  document.querySelectorAll('[data-settle]').forEach((b) =>
    b.addEventListener('click', () => {
      const it = items.find((x) => x.opId === b.dataset.settle);
      if (it) settlePendingItem(it);
    }));
}

// --- تحديث المخزون محلياً (revision 9) ------------------------------------
// The stock balance for a product lives in stockBalances/bal_<productId>.
// It is updated in the SAME transaction as the sale/purchase (and the
// stockMovements doc), so a sale can never record without its stock effect.
// The balance doc is created with quantity 0 when the product is created
// (product form, batch) and for existing products by the owner setup, so
// the transaction can always read it. A missing balance doc is a pre-check
// error (NO_STOCK_BALANCE), not a transaction failure — the transaction
// never tx.get's a doc that may not exist (that read is denied).
function stockBalanceRefFor(productId) { return doc(db, 'stockBalances', 'bal_' + productId); }

// Resolves the balance doc refs for the given product ids (read-only,
// before the transaction). Throws NO_STOCK_BALANCE naming the first
// product with no balance record, so the caller can show a clear error
// instead of starting a transaction that would fail on a missing read.
async function resolveStockBalanceRefs(productIds) {
  const bals = await loadCollection('stockBalances');
  const byProduct = {};
  bals.forEach((b) => { byProduct[b.productId] = b; });
  const refs = {};
  for (const pid of [...new Set(productIds)]) {
    if (!byProduct[pid]) {
      const p = (productsCache || []).find((x) => x.id === pid);
      throw new Error('NO_STOCK_BALANCE:' + (p ? p.name_ar : pid));
    }
    refs[pid] = stockBalanceRefFor(pid);
  }
  return refs;
}

// Applies one stock delta inside a transaction. balanceSnap is the result
// of tx.get(balanceRef) inside the same transaction (versioned read).
// Throws INSUFFICIENT_STOCK if the new quantity would go negative — the
// whole transaction aborts (reject-the-save, like insufficient funds).
// Returns the new quantity.
function applyStockMovementTx(tx, balanceRef, balanceSnap, delta) {
  if (!balanceSnap.exists()) throw new Error('NO_STOCK_BALANCE');
  const cur = Number(balanceSnap.data().quantity || 0);
  const next = cur + delta;
  if (next < 0) throw new Error('INSUFFICIENT_STOCK');
  tx.update(balanceRef, { quantity: next, updatedAt: serverTimestamp() });
  return next;
}

// --- تحميل بيانات المديونيات: جهات + فواتير منشورة + دفعات ---
async function loadDebtsData(kind) {
  const isCust = kind === 'customers';
  const [contacts, invoices, payments] = await Promise.all([
    loadCollection(kind),
    loadCollection(isCust ? 'salesInvoices' : 'purchaseInvoices'),
    loadCollection(isCust ? 'salesPayments' : 'purchasePayments')
  ]);
  const payByInv = {};
  payments.forEach((p) => {
    const k = isCust ? p.salesInvoiceId : p.purchaseInvoiceId;
    if (k) payByInv[k] = (payByInv[k] || 0) + Number(p.amountPiasters || 0);
  });
  const posted = invoices.filter((i) => i.status === 'posted');
  const open = posted
    .map((inv) => ({ inv, remaining: remainingOf(inv, payByInv), paid: paidOf(inv, payByInv) }))
    .filter((x) => x.remaining > 0);
  const byContact = {};
  open.forEach((x) => {
    const cid = isCust ? x.inv.customerId : x.inv.supplierId;
    if (!cid) return;
    (byContact[cid] = byContact[cid] || []).push(x);
  });
  return { isCust, contacts, posted, payments, payByInv, open, byContact };
}

// --- قائمة المديونيات ---
async function renderDebts(kind, selectedId = null) {
  if (selectedId) return renderDebtDetail(kind, selectedId);
  const { isCust, contacts, open, byContact } = await loadDebtsData(kind);
  const title = isCust ? '💳 مديونيات العملاء' : '🧾 مديونيات الموردين';
  const who = isCust ? 'عميل' : 'مورد';
  const rows = contacts
    .map((c) => {
      const list = byContact[c.id] || [];
      const debt = contactOwed(c, list);
      return { c, list, debt, openingOnly: !list.length && debt > 0 };
    })
    .filter((r) => r.debt > 0);
  // فواتير بلا جهة (حُذفت الجهة وبقيت فواتيرها): تظهر صفاً مستقلاً حتى لا يختفي
  // مبلغها من الجدول بينما يبقى محسوباً في الإجمالي
  for (const id of Object.keys(byContact)) {
    if (contacts.some((c) => c.id === id)) continue;
    const list = byContact[id];
    const debt = list.reduce((a, x) => a + x.remaining, 0);
    if (debt > 0) rows.push({ c: { id, name_ar: 'جهة محذوفة', phone: '—' }, list, debt, openingOnly: false, orphan: true });
  }
  rows.sort((a, b) => b.debt - a.debt);
  // الإجمالي = مجموع الصفوف الظاهرة تماماً (مشتق + افتتاحي + بلا جهة) — بلا أي فرق
  const totalDebt = rows.reduce((a, r) => a + r.debt, 0);
  $('page').innerHTML = `
    <h2 class="page-title">${title}</h2>
    <p class="page-sub">كل ${who} ورصيده المدين من الفواتير المفتوحة — المتبقي = الإجمالي − المدفوع عند الإنشاء − مجموع الدفعات المسجلة. اضغط على أي ${who} لعرض فواتيره ودفعاته وتسديد جزء.</p>
    <div class="toolbar"><button class="btn small" id="debts-add-btn">➕ تسجيل مديونية</button></div>
    <div class="kpi-grid">
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(totalDebt)}<span class="unit">ج.م</span></div><div class="label">إجمالي المديونيات المفتوحة</div></div><div class="ico">💳</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(open.length)}</div><div class="label">فاتورة مفتوحة</div></div><div class="ico">🧾</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(rows.length)}</div><div class="label">${who} عليه مديونية</div></div><div class="ico">👥</div></div>
    </div>
    <div class="card"><h3>${title}</h3>
    ${rows.length ? `<table><tr><th>${who}</th><th>الهاتف</th><th>فواتير مفتوحة</th><th>أقرب استحقاق</th><th>المديونية</th><th></th></tr>
      ${rows.map(({ c, list, debt, openingOnly, orphan }) => {
        const nearest = list.length ? new Date(Math.min(...list.map((x) => dueDateOf(x.inv).getTime()))) : null;
        return `<tr><td>${esc(c.name_ar)}${demoBadge(c)}${openingOnly ? ' <span class="badge">رصيد افتتاحي</span>' : ''}${orphan ? ' <span class="badge warn">جهة محذوفة</span>' : ''}</td>
        <td dir="ltr">${esc(c.phone || '')}</td><td class="num">${list.length || '—'}</td>
        <td>${nearest ? nearest.toLocaleDateString('ar-EG') : '—'}</td>
        <td class="num">${fmtEGP(debt)}</td>
        <td><button class="btn small" data-debt-open="${c.id}">التفاصيل والدفعات</button></td></tr>`;
      }).join('')}</table>`
    : emptyState('لا توجد مديونيات مفتوحة حالياً — كل الفواتير مسددة بالكامل.')}</div>`;
  document.querySelectorAll('[data-debt-open]').forEach((b) =>
    b.addEventListener('click', () => renderDebts(kind, b.dataset.debtOpen)));
  $('debts-add-btn').addEventListener('click', () => openManualDebtForm(kind, null, () => renderDebts(kind)));
}

// --- تفاصيل مديونية جهة: فواتير مفتوحة + سجل دفعات + تسديد جزء ---
async function renderDebtDetail(kind, contactId) {
  const { isCust, contacts, payments, payByInv, byContact, posted } = await loadDebtsData(kind);
  const found = contacts.find((x) => x.id === contactId);
  // الجهة محذوفة وبقيت فواتيرها: نعرض فواتيرها ودفعاتها بلا تسجيل مديونية جديدة عليها
  const c = found || { id: contactId, name_ar: 'جهة محذوفة', phone: '', openingBalancePiasters: 0 };
  const list = byContact[contactId] || [];
  const debt = contactOwed(c, list);
  const opening = Math.max(0, Number(c.openingBalancePiasters || 0));
  // التفاصيل لكل فاتورة مفتوحة: نص محفوظ لليدوية، وملخص أصناف تلقائي للفواتير العادية
  await loadInvoiceItems(list.map((x) => x.inv), isCust ? 'salesInvoices' : 'purchaseInvoices');
  list.forEach((x) => { x.details = debtDetailsText(x.inv, invoiceItemsCache[x.inv.id] || []); });
  const myPayments = payments
    .filter((p) => (isCust ? p.customerId : p.supplierId) === contactId)
    .sort((a, b) => tsToDate(b.date || b.createdAt) - tsToDate(a.date || a.createdAt));
  const invById = {};
  posted.forEach((inv) => { invById[inv.id] = inv; });
  const title = isCust ? '💳 مديونية عميل' : '🧾 مديونية مورد';
  $('page').innerHTML = `
    <h2 class="page-title">${title}: ${esc(c.name_ar)}</h2>
    <p class="page-sub"><button class="btn small secondary" id="back-debts">← عودة للمديونيات</button></p>
    <div class="kpi-grid">
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(debt)}<span class="unit">ج.م</span></div><div class="label">المديونية المفتوحة</div></div><div class="ico">💳</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtNum(list.length)}</div><div class="label">فاتورة مفتوحة</div></div><div class="ico">🧾</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(myPayments.reduce((a, p) => a + Number(p.amountPiasters || 0), 0))}<span class="unit">ج.م</span></div><div class="label">إجمالي الدفعات المسجلة</div></div><div class="ico">💰</div></div>
    </div>
    <div class="toolbar"><button class="btn small" id="print-statement-btn">🖨️ طباعة كشف الحساب</button>
    <button class="btn small" id="pdf-statement-btn">⬇️ تحميل PDF</button>
    ${found ? '<button class="btn small" id="debt-add-btn">➕ تسجيل مديونية</button>' : ''}</div>
    ${opening > 0 ? `<p class="note">من المديونية أعلاه رصيد افتتاحي: ${fmtEGP(opening)} — والباقي من الفواتير المفتوحة أدناه.</p>` : ''}
    <div class="card"><h3>الفواتير المفتوحة</h3>
    ${list.length ? `<table><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>الاستحقاق</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th></th></tr>
      ${list.sort((a, b) => dueDateOf(a.inv) - dueDateOf(b.inv)).map((x) => {
        const { inv, remaining, paid } = x;
        const st = payStatusOf(Number(inv.totalPiasters || 0), paid);
        return `<tr><td dir="ltr">${esc(inv.invoiceNumber || inv.id)}${demoBadge(inv)}${inv.isManualDebt ? ' <span class="badge">مديونية يدوية</span>' : ''}${x.details ? `<div class="inv-details" dir="rtl">📦 ${esc(x.details)}</div>` : ''}</td>
        <td>${tsToDate(inv.date || inv.createdAt).toLocaleDateString('ar-EG')}</td>
        <td>${dueDateOf(inv).toLocaleDateString('ar-EG')}</td>
        <td class="num">${fmtEGP(inv.totalPiasters)}</td><td class="num">${fmtEGP(paid)}</td>
        <td class="num">${fmtEGP(remaining)}</td>
        <td><span class="badge ${payStatusBadgeCls(st)}">${payStatusLabel(st)}</span></td>
        <td style="white-space:nowrap">
          ${(isCust ? ['owner', 'manager', 'sales', 'accountant'] : ['owner', 'manager', 'accountant']).includes(me.role) ? `<button class="btn small" data-pay-inv="${inv.id}" data-pay-max="${remaining}">💰 تسديد جزء</button>` : ''}
          <button class="btn small secondary" data-adj-inv="${inv.id}" data-adj-old="${remaining}">✏️ تعديل المبلغ</button>
          <button class="btn small secondary" data-view-inv="${inv.id}">عرض / طباعة</button>
        </td></tr>`;
      }).join('')}</table>`
    : emptyState('لا توجد فواتير مفتوحة لهذه الجهة — المديونية مسددة بالكامل.')}
    <div id="pay-form-area"></div></div>
    <div class="card" style="margin-top:14px"><h3>سجل الدفعات</h3>
    ${myPayments.length ? `<table><tr><th>التاريخ</th><th>الفاتورة</th><th>طريقة الدفع</th><th>المبلغ</th><th>ملاحظات</th>${isOwner() ? '<th></th>' : ''}</tr>
      ${myPayments.map((p) => {
        const invId = isCust ? p.salesInvoiceId : p.purchaseInvoiceId;
        const inv = invId ? invById[invId] : null;
        return `<tr><td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td>
        <td dir="ltr">${inv ? esc(inv.invoiceNumber || inv.id) : 'على الحساب'}</td>
        <td>${payMethodLabel(p.paymentMethod)}</td><td class="num">${fmtEGP(p.amountPiasters)}</td>
        <td>${esc(p.notes || '')}</td>
        ${isOwner() ? `<td style="white-space:nowrap"><button class="btn small danger" data-delete-payment="${p.id}">🗑️ حذف</button></td>` : ''}</tr>`;
      }).join('')}</table>`
    : emptyState('لا توجد دفعات مسجلة بعد لهذه الجهة.')}</div>`;
  $('back-debts').addEventListener('click', () => renderDebts(kind));
  // revision 11: حذف دفعة (المالك فقط) — عكس ثم حذف في معاملة واحدة.
  document.querySelectorAll('[data-delete-payment]').forEach((b) => b.addEventListener('click', () => {
    const p = myPayments.find((x) => x.id === b.dataset.deletePayment);
    if (p) deletePayment(kind, p);
  }));
  const dab = $('debt-add-btn');
  if (dab) dab.addEventListener('click', () => openManualDebtForm(kind, c, () => renderDebtDetail(kind, contactId)));
  $('print-statement-btn').addEventListener('click', () => printStatement(kind, c, list, myPayments, invById));
  $('pdf-statement-btn').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true; b.textContent = '⏳ جارٍ إنشاء PDF...';
    downloadStatementPDF(kind, c, list, myPayments, invById).finally(() => { b.disabled = false; b.textContent = '⬇️ تحميل PDF'; });
  });
  document.querySelectorAll('[data-pay-inv]').forEach((b) => b.addEventListener('click', () => {
    const inv = list.find((x) => x.inv.id === b.dataset.payInv);
    if (inv) openPayForm(kind, c, inv.inv, Number(b.dataset.payMax), () => renderDebtDetail(kind, contactId));
  }));
  document.querySelectorAll('[data-adj-inv]').forEach((b) => b.addEventListener('click', () => {
    const inv = list.find((x) => x.inv.id === b.dataset.adjInv);
    if (inv) openAdjustForm(kind, c, inv.inv, Number(b.dataset.adjOld), () => renderDebtDetail(kind, contactId));
  }));
  document.querySelectorAll('[data-view-inv]').forEach((b) => b.addEventListener('click', () =>
    renderInvoiceDetail(isCust ? 'sales' : 'purchase', b.dataset.viewInv)));
}

// --- نموذج تسديد جزء (داخلي — يظهر داخل صفحة التفاصيل) ---
function openPayForm(kind, contact, inv, maxRemaining, onDone) {
  const area = $('pay-form-area');
  if (!area) return;
  const isCust = kind === 'customers';
  const today = dateInputVal(new Date());
  area.innerHTML = `
    <div class="pay-form card" style="margin-top:14px;border-color:rgba(240,180,41,.5)">
      <h3>💰 تسديد جزء — فاتورة ${esc(inv.invoiceNumber || inv.id)}</h3>
      <p class="note" style="text-align:right">المتبقي على هذه الفاتورة: <b>${fmtEGP(maxRemaining)}</b> — المبلغ يجب أن يكون أكبر من صفر ولا يتجاوز المتبقي.</p>
      <div class="form-grid">
        <div><label>المبلغ (جنيه) *</label><input id="pay-amount" type="number" step="0.01" min="0.01" max="${(maxRemaining / 100).toFixed(2)}" placeholder="مثال: 500"></div>
        <div><label>تاريخ الدفعة *</label><input id="pay-date" type="date" value="${today}"></div>
        <div><label>طريقة التسديد *</label><select id="pay-method">${PAY_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div><label>ملاحظات</label><input id="pay-notes" placeholder="اختياري"></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" id="pay-submit" style="width:auto">✅ تسجيل الدفعة</button>
        <button class="btn secondary" id="pay-cancel" style="width:auto" type="button">إلغاء</button>
      </div>
      <div class="error" id="pay-error"></div>
      <p class="note">الدفعة تُسجَّل فوراً وتخصم من رصيد المديونية. الدفع النقدي يضاف للصندوق (تحصيل) أو يُخصم منه (دفع لمورد)، والتحويل البنكي/الفيزا/إنستاباي يؤثر على الحساب البنكي، وفودافون كاش والشيك لا يؤثران على الصندوق.</p>
    </div>`;
  $('pay-cancel').addEventListener('click', () => { area.innerHTML = ''; });
  $('pay-submit').addEventListener('click', async () => {
    hideError($('pay-error'));
    const amount = toPiasters($('pay-amount').value);
    const dateTs = parseDateInput($('pay-date').value) || Timestamp.fromDate(new Date());
    const method = $('pay-method').value;
    const notes = $('pay-notes').value.trim();
    if (!amount || amount <= 0) { showError($('pay-error'), 'أدخل مبلغاً أكبر من صفر.'); return; }
    if (amount > maxRemaining) { showError($('pay-error'), `المبلغ يتجاوز المتبقي على الفاتورة (${fmtEGP(maxRemaining)}).`); return; }
    $('pay-submit').disabled = true; $('pay-submit').textContent = 'جارٍ الحفظ...';
    try {
      const cashMsg = await recordPayment(kind, contact.id, inv, amount, dateTs, method, notes);
      area.innerHTML = '';
      showToast(`✅ تم تسجيل دفعة ${fmtEGP(amount)} (${payMethodLabel(method)}) — المتبقي الآن ${fmtEGP(maxRemaining - amount)}.${cashMsg ? ' ' + cashMsg : ''}`);
      await onDone();
    } catch (err) {
      showError($('pay-error'), firestoreErrorMessage(err));
      $('pay-submit').disabled = false; $('pay-submit').textContent = '✅ تسجيل الدفعة';
    }
  });
}

// --- تعديل المبلغ المستحق على فاتورة مفتوحة (قيد تسوية — بلا تعديل لأي فاتورة مرحّلة) ---
// نقصان: دفعة تسوية بقيمة الفرق (لا تحرّك الصندوق/البنك). زيادة: فاتورة مديونية يدوية
// جديدة بقيمة الفرق (DEBT-ADJ) مربوطة بالفاتورة الأصلية. في الحالتين يُحفظ
// المبلغ القديم والجديد والسبب والتاريخ في المستند نفسه.
function openAdjustForm(kind, contact, inv, oldRemaining, onDone) {
  const area = $('pay-form-area');
  if (!area) return;
  const today = dateInputVal(new Date());
  area.innerHTML = `
    <div class="pay-form card" style="margin-top:14px;border-color:rgba(240,180,41,.5)">
      <h3>✏️ تعديل المبلغ المستحق — فاتورة ${esc(inv.invoiceNumber || inv.id)}</h3>
      <p class="note" style="text-align:right">المتبقي الحالي على هذه الفاتورة: <b>${fmtEGP(oldRemaining)}</b> — أدخل المبلغ الجديد المتفق عليه. النقصان يُسجَّل كدفعة تسوية، والزيادة كمديونية إضافية مربوطة بنفس الفاتورة. لا تُعدَّل الفاتورة الأصلية أبداً.</p>
      <div class="form-grid">
        <div><label>المبلغ الجديد المستحق (جنيه) *</label><input id="adj-amount" type="number" step="0.01" min="0" value="${(oldRemaining / 100).toFixed(2)}"></div>
        <div><label>تاريخ التسوية *</label><input id="adj-date" type="date" value="${today}"></div>
        <div><label>سبب التعديل *</label><input id="adj-reason" placeholder="مثال: اتفاق جديد مع العميل / تصحيح مبلغ"></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" id="adj-submit" style="width:auto">✅ حفظ التعديل</button>
        <button class="btn secondary" id="adj-cancel" style="width:auto" type="button">إلغاء</button>
      </div>
      <div class="error" id="adj-error"></div>
    </div>`;
  $('adj-cancel').addEventListener('click', () => { area.innerHTML = ''; });
  $('adj-submit').addEventListener('click', async () => {
    hideError($('adj-error'));
    const newAmount = toPiasters($('adj-amount').value);
    const reason = $('adj-reason').value.trim();
    const dateTs = parseDateInput($('adj-date').value) || Timestamp.fromDate(new Date());
    if (isNaN(newAmount) || newAmount < 0) { showError($('adj-error'), 'أدخل مبلغاً صحيحاً (صفر أو أكثر).'); return; }
    if (newAmount === oldRemaining) { showError($('adj-error'), 'المبلغ الجديد يساوي المتبقي الحالي — لا يوجد تعديل.'); return; }
    if (!reason) { showError($('adj-error'), 'اكتب سبب التعديل.'); return; }
    $('adj-submit').disabled = true; $('adj-submit').textContent = 'جارٍ الحفظ...';
    try {
      const isCust = kind === 'customers';
      if (newAmount < oldRemaining) {
        const diff = oldRemaining - newAmount;
        await recordPayment(kind, contact.id, inv, diff, dateTs, 'adjustment', reason,
          { isAdjustment: true, oldRemainingPiasters: oldRemaining, newRemainingPiasters: newAmount, reason });
        showToast(`✅ تم تعديل المبلغ: من ${fmtEGP(oldRemaining)} إلى ${fmtEGP(newAmount)} (نقصان ${fmtEGP(diff)} كدفعة تسوية).`);
      } else {
        const diff = newAmount - oldRemaining;
        // قيد التسوية (زيادة) في معاملة ذرية واحدة: الفاتورة + رصيد الجهة،
        // مع معرّف عملية محفوظ بالحمولة الكاملة وفحص عدم التكرار.
        // لا يحرّك الصندوق/البنك (تسوية محاسبية فقط).
        const adjKey = pendingOpKey(['adj', kind, contact.id, inv.id]);
        const adjStored = readPendingOp(adjKey);
        const adjNum = adjStored
          ? adjStored.payload.invoiceNumber
          : 'DEBT-ADJ-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now()).slice(-6);
        const adjPayload = {
          kind, contactId: contact.id, adjustedInvoiceId: inv.id,
          oldRemaining, newAmount, diff, reason,
          dateMs: dateTs ? dateTs.toMillis() : null, invoiceNumber: adjNum
        };
        let adjOpId;
        for (;;) {
          const begin = await beginPendingOp(adjKey, adjPayload, async (storedOpId) => {
            const s = await getDoc(markerRefFor(storedOpId));
            return s.exists();
          }, async (storedOpId) => {
            const d = await getDoc(doc(db, isCust ? 'salesInvoices' : 'purchaseInvoices', storedOpId));
            return d.exists() ? { invoiceNumber: d.data().invoiceNumber, totalPiasters: d.data().totalPiasters } : null;
          });
          if (begin.action === 'proceed') { adjOpId = begin.opId; break; }
          if (begin.action === 'unknown') {
            showError($('adj-error'), unknownBlockMessage('قيد تسوية'));
            $('adj-submit').disabled = false; $('adj-submit').textContent = '✅ حفظ التعديل';
            return;
          }
          if (begin.committed) {
            alert(committedBlockMessage(begin.stored, begin.saved, 'قيد تسوية'));
            $('adj-submit').disabled = false; $('adj-submit').textContent = '✅ حفظ التعديل';
            return;
          }
          const ok = confirmDiscardPendingOp(begin.stored, adjPayload, false, 'قيد تسوية');
          if (!ok) {
            showError($('adj-error'), 'تم إلغاء التعديل — يوجد قيد تسوية معلق بقيم مختلفة. راجع القيم الأصلية أو تجاهل العملية المعلقة أولاً.');
            $('adj-submit').disabled = false; $('adj-submit').textContent = '✅ حفظ التعديل';
            return;
          }
          clearPendingOp(adjKey);
        }
        const due = new Date(dateTs.toDate().getTime() + 30 * 86400000);
        const adjInvRef = doc(db, isCust ? 'salesInvoices' : 'purchaseInvoices', adjOpId);
        const adjMarkerRef = markerRefFor(adjOpId);
        const adjResult = await runTransaction(db, async (tx) => {
          const adjMarkerSnap = await tx.get(adjMarkerRef);
          if (adjMarkerSnap.exists()) {
            const existingAdj = await tx.get(adjInvRef);
            const d = existingAdj.exists() ? existingAdj.data() : {};
            return { alreadyApplied: true, saved: { invoiceNumber: d.invoiceNumber, totalPiasters: d.totalPiasters } };
          }
          const contactSnap = await tx.get(doc(db, kind, contact.id));
          const cur = contactSnap.exists() ? Number(contactSnap.data().currentBalancePiasters || 0) : 0;
          tx.set(adjMarkerRef, { orgId, opId: adjOpId, kind: 'adj', createdAt: serverTimestamp() });
          tx.set(adjInvRef, {
            orgId, branchId: (inv && inv.branchId) || DEFAULT_BRANCH,
            ...(isCust ? { customerId: contact.id } : { supplierId: contact.id }),
            invoiceNumber: adjNum, date: dateTs, dueDate: Timestamp.fromDate(due),
            status: 'posted', totalPiasters: diff, paidPiasters: 0, remainingPiasters: diff,
            subtotalPiasters: diff, discountPiasters: 0, taxPiasters: 0,
            isManualDebt: true, isAdjustment: true, adjustedInvoiceId: inv.id,
            oldRemainingPiasters: oldRemaining, newRemainingPiasters: newAmount,
            manualReason: reason, manualDetails: 'قيد تسوية — ' + reason, paymentMethod: 'credit',
            opId: adjOpId, createdBy: me.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
          if (contactSnap.exists()) {
            tx.update(doc(db, kind, contact.id), { currentBalancePiasters: cur + diff, updatedAt: serverTimestamp() });
          }
          return { alreadyApplied: false };
        });
        clearPendingOp(adjKey);
        showToast(adjResult.alreadyApplied
          ? `قيد التسوية ${adjResult.saved.invoiceNumber} محفوظ بالفعل — لم يُضف أي أثر مكرر. القيمة المحفوظة: ${fmtEGP(adjResult.saved.totalPiasters)}.`
          : `✅ تم تعديل المبلغ: من ${fmtEGP(oldRemaining)} إلى ${fmtEGP(newAmount)} (زيادة ${fmtEGP(diff)} كقيد تسوية رقم ${adjNum}).`);
      }
      area.innerHTML = '';
      await onDone();
    } catch (err) {
      // revision 11, Issue 1: فشل حتمي — امسح العملية المعلقة حتى لا تحظر
      // التعديل التالي بتحذير مضلل.
      if (isDefinitiveSaveFailure(err)) clearPendingOp(adjKey);
      showError($('adj-error'), firestoreErrorMessage(err));
      $('adj-submit').disabled = false; $('adj-submit').textContent = '✅ حفظ التعديل';
    }
  });
}

// --- تسجيل دفعة: مستند دفعة + تحديث رصيد الجهة (ذرياً) + أثر الصندوق/البنك ---
async function recordPayment(kind, contactId, inv, amountPiasters, dateTs, method, notes, extra = {}) {
  const isCust = kind === 'customers';
  const coll = isCust ? 'salesPayments' : 'purchasePayments';
  const contactRef = doc(db, kind, contactId);
  // الحمولة الكاملة للدفعة — كل حقل يؤثر على المال أو السجل. تُحفظ مع معرّف
  // العملية في localStorage (تنجو من إغلاق التبويب)؛ إعادة المحاولة بنفس الحمولة تعيد استخدام نفس
  // المعرف، وإعادة المحاولة بحمولة مختلفة تُحظَر حتى تتم التسوية أولاً.
  const payload = {
    kind, contactId, invoiceId: inv ? inv.id : null,
    amountPiasters, method, dateMs: dateTs ? dateTs.toMillis() : null, notes: notes || '',
    extra: extra ? { isAdjustment: !!extra.isAdjustment, oldRemainingPiasters: extra.oldRemainingPiasters ?? null, newRemainingPiasters: extra.newRemainingPiasters ?? null, reason: extra.reason || '' } : null
  };
  const payKey = pendingOpKey(['pay', kind, contactId, inv ? inv.id : 'none']);
  const direction = isCust ? 1 : -1;
  // الصندوق يُضمَّن في المعاملة فقط إذا كان دور المستخدم يسمح بالكتابة فيه
  // (owner/manager/accountant). دور sales لا يستطيع — فتُسجَّل الدفعة ذرياً
  // وتُعلَّم cashEffect:'pending' ليعتمدها محاسب لاحقاً (البيع لا ينكسر).
  const cashPending = movesMoney(method) && !canWriteMoneyBox();
  const box = (movesMoney(method) && canWriteMoneyBox()) ? await resolveMoneyBoxRef(method) : null;
  // بداية العملية مع التسوية: إذا اختلفت الحمولة عن المعلقة، نتحقق أولاً مما
  // إذا كانت العملية الأصلية قد التزمت، ثم نعرض على المستخدم القيم الأصلية
  // مقابل الجديدة — ولا ننشئ عملية ثانية أبداً قبل قراره.
  let opId;
  for (;;) {
    const begin = await beginPendingOp(payKey, payload, async (storedOpId) => {
      // التسوية تقرأ العلامة (مسموحة حتى لو غائبة)، لا مستند الدفعة نفسه.
      const s = await getDoc(markerRefFor(storedOpId));
      return s.exists();
    }, async (storedOpId) => {
      const d = await getDoc(doc(db, coll, 'pay-' + storedOpId));
      return d.exists() ? { amountPiasters: d.data().amountPiasters, paymentMethod: d.data().paymentMethod } : null;
    });
    if (begin.action === 'proceed') { opId = begin.opId; break; }
    if (begin.action === 'unknown') throw new Error('PENDING_STATUS_UNKNOWN');
    if (begin.committed) throw new Error('PENDING_ALREADY_COMMITTED:' + JSON.stringify(begin.saved || {}));
    const ok = confirmDiscardPendingOp(begin.stored, payload, false, 'دفعة');
    if (!ok) throw new Error('PAYLOAD_CHANGED_PENDING');
    clearPendingOp(payKey); // المستخدم قرر صراحةً تجاهل العملية المعلقة والمتابعة بالقيم الجديدة
  }
  const payRef = doc(db, coll, 'pay-' + opId); // حتمي — مستقر عبر إعادة المحاولة
  const payMarkerRef = markerRefFor(opId);
  let result;
  try {
    result = await runTransaction(db, async (tx) => {
      // (1) فحص عدم التكرار عبر العلامة: إذا كانت موجودة، فالمعاملة كلها
      // التزمت من قبل (الدفعة + رصيد الجهة + الصندوق ذرية) — عودة مبكرة
      // مع إرجاع القيم المحفوظة حتى يعرضها المتصل (لا قيم قديمة بصمت).
      // نقرأ مستند الدفعة نفسه هنا فقط لأنه موجود حتماً في هذه الحالة.
      const markerSnap = await tx.get(payMarkerRef);
      if (markerSnap.exists()) {
        const existingPay = await tx.get(payRef);
        const d = existingPay.exists() ? existingPay.data() : {};
        return { payRef, alreadyApplied: true, saved: { amountPiasters: d.amountPiasters, paymentMethod: d.paymentMethod, cashEffect: d.cashEffect || null } };
      }
      const contactSnap = await tx.get(contactRef);
      const curOwed = contactSnap.exists() ? Number(contactSnap.data().currentBalancePiasters || 0) : 0;
      let boxSnap = null;
      if (box) boxSnap = await tx.get(box.ref);
      if (box) applyMoneyMovementTx(tx, box.ref, box.isBank, boxSnap, direction, amountPiasters);
      const payData = {
        orgId, branchId: (inv && inv.branchId) || DEFAULT_BRANCH,
        amountPiasters, paymentMethod: method, date: dateTs, notes: notes || '',
        opId, ...(cashPending ? { cashEffect: 'pending' } : {}),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...extra
      };
      if (isCust) { payData.customerId = contactId; payData.salesInvoiceId = inv ? inv.id : null; payData.receivedBy = me.uid; }
      else { payData.supplierId = contactId; payData.purchaseInvoiceId = inv ? inv.id : null; payData.paidBy = me.uid; }
      tx.set(payMarkerRef, { orgId, opId, kind: 'payment', createdAt: serverTimestamp() });
      tx.set(payRef, payData);
      if (contactSnap.exists()) {
        tx.update(contactRef, { currentBalancePiasters: Math.max(0, curOwed - amountPiasters), updatedAt: serverTimestamp() });
      }
      return { payRef, alreadyApplied: false };
    });
  } catch (err) {
    // لم يُسجَّل شيء — أظهر خطأ واضحاً وأعد تفعيل زر الحفظ لإعادة المحاولة.
    // ⚠️ تغيير سلوك: رصيد غير كافٍ يعني أن الدفعة لم تُسجَّل إطلاقاً (قبل:
    // كانت تُسجَّل الدفعة ويُتخطى الصندوق). انظر proposal §6.
    // revision 11, Issue 1: فشل حتمي (رصيد غير كافٍ / صلاحية / ...) يعني
    // أن المعاملة لم تلتزم إطلاقاً — امسح العملية المعلقة حتى لا تحظر
    // الدفعة التالية بتحذير مضلل.
    if (isDefinitiveSaveFailure(err)) clearPendingOp(payKey);
    if (err && err.message === 'INSUFFICIENT_FUNDS') {
      alert('رصيد الصندوق/البنك لا يكفي لخصم هذا المبلغ — لم تُسجَّل الدفعة. اختر طريقة دفع أخرى أو قلّل المبلغ.');
    } else if (err && err.message === 'PAYLOAD_CHANGED_PENDING') {
      // سبق عرضه للمستخدم في نافذة التأكيد — لا حاجة لتنبيه آخر.
    } else if (err && err.message === 'PENDING_STATUS_UNKNOWN') {
      alert(unknownBlockMessage('دفعة'));
    } else if (err && err.message && err.message.startsWith('PENDING_ALREADY_COMMITTED:')) {
      let saved = null;
      try { saved = JSON.parse(err.message.slice('PENDING_ALREADY_COMMITTED:'.length)); } catch (e) { saved = null; }
      alert(committedBlockMessage(null, saved, 'دفعة'));
    } else if (err && err.code === 'permission-denied') {
      // revision 11, Issue 2: دفعة مورد بدور مبيعات كانت تُظهر "تحقق من
      // الاتصال" — وهي ليست مشكلة اتصال ولا تصاريح، بل الدور نفسه لا
      // يسمح بهذا الإجراء. ميّز بين الحالتين.
      const allowed = isCust ? ['owner', 'manager', 'sales', 'accountant'] : ['owner', 'manager', 'accountant'];
      const roleMsg = roleDeniedMessage(allowed, isCust ? 'تسجيل دفعة عميل' : 'دفع الموردين');
      alert(roleMsg || firestoreErrorMessage(err));
    } else {
      alert('تعذّر حفظ الدفعة — تحقق من الاتصال وحاول مرة أخرى. لم يُسجَّل أي شيء.');
    }
    throw err;
  }
  clearPendingOp(payKey); // نجاح مؤكد — امسح معرّف العملية حتى تحصل الدفعة التالية على معرّف جديد
  if (result.alreadyApplied) {
    const s = result.saved || {};
    const pend = s.cashEffect === 'pending' ? ' — أثر الصندوق معلّق بانتظار محاسب.' : '';
    return `هذه الدفعة مسجَّلة بالفعل — لم يُضف أي أثر مكرر. القيم المحفوظة: ${fmtEGP(s.amountPiasters || amountPiasters)} (${payMethodLabel(s.paymentMethod || method)}).${pend}`;
  }
  if (method === 'adjustment') return '';
  if (!movesMoney(method)) return 'ملاحظة: طريقة الدفع (فودافون كاش / شيك) لا تؤثر على رصيد الصندوق — سُجّلت الدفعة وخصمت من المديونية فقط.';
  if (cashPending) return 'ملاحظة: أثر الصندوق معلّق (cashEffect: pending) — سُجّلت الدفعة وخصمت من المديونية، ويعتمد محاسب حركة الصندوق لاحقاً (دورك لا يسمح بالكتابة في الصندوق).';
  return isCust ? `أُضيف ${fmtEGP(amountPiasters)} إلى «${box.label}».` : `خُصم ${fmtEGP(amountPiasters)} من «${box.label}».`;
}

// ===========================================================================
// revision 11: حذف المالك (Owner delete) — لا حظر على الحذف بسبب وجود
// فواتير أو أرصدة أو مخزون. المالك يحذف أي شيء، بعد حوار أثر يعرض
// الفواتير والدفعات والنقد والمخزون والأرصدة المتأثرة، وتأكيد بكتابة
// الاسم، وسجل تدقيق في نفس المعاملة. حذف الفاتورة/الدفعة يعكس النقد
// ورصيد الجهة والمخزون وحقلي المدفوع/المتبقي في معاملة واحدة.
// إن كان العكس مستحيلاً محاسبياً (رصيد صندوق/مخزون سالب) فالحوار يشرح
// العاقبة الملموسة والعلاج بدل الرفض الصامت.
// ===========================================================================

// --- سجل التدقيق: يُكتب في نفس معاملة الحذف (بلا سجل تدقيق لا يلتزم الحذف) ---
// revision 11b: المعامل كان اسمه collection فحجب دالة collection() المستوردة،
// فكان أول سطر (collection(db, 'deletions')) يرمي "collection is not a
// function" ويفشل كل حذف. أُعيدت تسميته إلى collName.
function writeDeletionAudit(tx, collName, docId, label, reason, impact) {
  tx.set(doc(collection(db, 'deletions')), {
    orgId, collection: collName, docId, label, reason, impact,
    deletedBy: me.uid, deletedByEmail: me.email || '',
    createdAt: serverTimestamp()
  });
}

// --- نافذة تأكيد الحذف: أثر + سبب + كتابة الاسم للتأكيد ---
let deleteModalExpected = '';
let deleteModalOnConfirm = null;
// revision 11b: تحذير لا حظر. إن كان العكس سيجعل صندوقاً أو مخزوناً
// سالباً، يُعرض التحذير بالعاقبة الملموسة والعلاج، ويبقى زر التأكيد
// مفعّلاً — المالك يقرر بعد التحذير (كما في النسخة دون اتصال). كتابة
// الاسم + السبب ما زالت مطلوبة.
function openDeleteModal({ title, impactHTML, warning, confirmName, onConfirm }) {
  if (!isOwner()) { alert('الحذف للمالك فقط.'); return; }
  $('delete-modal-title').textContent = title;
  $('delete-impact').innerHTML = impactHTML;
  const warnEl = $('delete-blocker');
  if (warning) { warnEl.textContent = '⚠️ تحذير: ' + warning; warnEl.classList.remove('hidden'); }
  else warnEl.classList.add('hidden');
  $('delete-question').textContent = `هل تريد حذف «${confirmName}»؟`;
  hideError($('delete-error'));
  deleteModalExpected = confirmName;
  deleteModalOnConfirm = onConfirm;
  $('delete-confirm-btn').disabled = false;
  $('delete-modal').classList.remove('hidden');
}
$('delete-cancel-btn').addEventListener('click', () => {
  $('delete-modal').classList.add('hidden');
  deleteModalOnConfirm = null;
  deleteModalExpected = '';
});
$('delete-confirm-btn').addEventListener('click', async () => {
  const reason = 'حذف بتأكيد المالك (نعم/لا)'; // revision 11g: لا سبب ولا كتابة اسم
  const btn = $('delete-confirm-btn');
  btn.disabled = true; btn.textContent = '⏳ جارٍ الحذف...';
  try {
    await deleteModalOnConfirm(reason);
    $('delete-modal').classList.add('hidden');
    deleteModalOnConfirm = null;
    deleteModalExpected = '';
  } catch (err) {
    showError($('delete-error'), firestoreErrorMessage(err));
  }
  btn.disabled = false; btn.textContent = 'نعم، احذف';
});

// --- حذف سجل رئيسي (منتج/عميل/مورد/تصنيف/مخزن/فرع/حساب/علامة/سيارة) ---
// لا حظر: يعرض الأثر كاملاً ثم يحذف. المنتج يحذف معه سجل رصيده وأرقامه
// البديلة؛ والفواتير والدفعات المرتبطة تبقى وتظهر كـ "جهة محذوفة" (كما
// تفعل SI-20261125-823957 اليوم)، وتُذكر في الأثر.

// --- حذف جهة (عميل/مورد) مع كل فواتيرها ودفعاتها (cascade) ---
// revision 11b: مثل النسخة دون اتصال — لا أيتام «جهة محذوفة». تُحذف
// الجهة مع كل فواتيرها (وموادها) ودفعاتها، ويُعكس النقد والمخزون في
// نفس المعاملة (أو دفعات آمنة إن كثرت الفواتير)، ويُكتب سجل تدقيق.
// تحذير (لا حظر) إن كان العكس سيجعل صندوقاً أو مخزوناً سالباً.
const CASCADE_BATCH = 40; // فواتير لكل معاملة (أمان تحت حد 500 كتابة)
async function deleteContactCascade(collName, docId, label) {
  if (!isOwner()) { alert('الحذف للمالك فقط.'); return; }
  const isCust = collName === 'customers';
  const invColl = isCust ? 'salesInvoices' : 'purchaseInvoices';
  const payColl = isCust ? 'salesPayments' : 'purchasePayments';
  const contactField = isCust ? 'customerId' : 'supplierId';
  const payInvField = isCust ? 'salesInvoiceId' : 'purchaseInvoiceId';
  const cashDir = isCust ? -1 : 1;   // عكس دفعة: بيع يخصم من الصندوق، شراء يضيف
  const stockDir = isCust ? 1 : -1;  // عكس فاتورة: بيع يعيد المخزون، شراء يخصم
  // (1) تحميل كل شيء قبل الحوار.
  const [invoices, payments] = await Promise.all([loadCollection(invColl), loadCollection(payColl)]);
  const contactSnap = await getDoc(doc(db, collName, docId));
  if (!contactSnap.exists()) { alert('الجهة غير موجودة — ربما حُذفت بالفعل.'); return; }
  const myInvoices = invoices.filter((inv) => inv[contactField] === docId);
  const myInvIds = new Set(myInvoices.map((i) => i.id));
  const myPayments = payments.filter((p) => p[contactField] === docId || myInvIds.has(p[payInvField]));
  await loadInvoiceItems(myInvoices, invColl);
  const posted = myInvoices.filter((i) => i.status === 'posted');
  const drafts = myInvoices.filter((i) => i.status !== 'posted');
  // (2) حساب الأثر: النقد (لكل طريقة دفع) والمخزون.
  const impact = [];
  const contact = contactSnap.data();
  impact.push(`الرصيد الحالي: ${fmtEGP(Number(contact.currentBalancePiasters || 0))} — سيُحذف مع الجهة.`);
  impact.push(`فواتير: ${fmtNum(myInvoices.length)} (${fmtNum(posted.length)} مرحّلة، ${fmtNum(drafts.length)} مسودة) — ستُحذف كلها مع موادها.`);
  impact.push(`دفعات: ${fmtNum(myPayments.length)} — ستُحذف كلها.`);
  const cashByMethod = {}; // طريقة الدفع -> مجموع العكس (بياستر)
  for (const pay of myPayments) {
    if (movesMoney(pay.paymentMethod) && pay.cashEffect !== 'pending') {
      cashByMethod[pay.paymentMethod] = (cashByMethod[pay.paymentMethod] || 0) + Number(pay.amountPiasters || 0);
    }
  }
  const boxesByMethod = {}; // طريقة الدفع -> { ref, label } (يُحل قبل الحوار)
  let cashWarn = null;
  for (const [method, total] of Object.entries(cashByMethod)) {
    try {
      const box = await resolveMoneyBoxRef(method);
      boxesByMethod[method] = box;
      const boxSnap = await getDoc(box.ref);
      const boxCur = boxSnap.exists() ? Number(boxSnap.data().balancePiasters || 0) : 0;
      const boxNew = boxCur + cashDir * total;
      impact.push(`النقد (${method}): عكس الدفعات ${cashDir < 0 ? 'يخصم' : 'يضيف'} ${fmtEGP(total)} ${cashDir < 0 ? 'من' : 'إلى'} «${box.label}» (الحالي ${fmtEGP(boxCur)} → بعد الحذف ${fmtEGP(boxNew)}).`);
      if (boxNew < 0 && !cashWarn) cashWarn = `عكس دفعات هذه الجهة يخصم ${fmtEGP(total)} من «${box.label}» لكن رصيده الحالي ${fmtEGP(boxCur)} فقط — فسيصبح ${fmtEGP(boxNew)} (سالب). هذا يعني أن ${fmtEGP(-boxNew)} من نقد هذه الجهة قد صُرف أو نُقل بالفعل. إن أكّدت الحذف فسيُسجَّل الرصيد سالباً (ويُوثَّق في سجل التدقيق)؛ والأفضل أن تضيف ${fmtEGP(-boxNew)} إلى الصندوق أولاً.`;
    } catch (e) {
      impact.push(`النقد (${method}): تعذّر تحديد الصندوق — ستُحذف الفواتير والدفعات دون عكس نقدي لهذه الطريقة، ويُوثَّق ذلك في سجل التدقيق.`);
    }
  }
  const stockByProduct = {};
  for (const inv of posted) {
    for (const it of (invoiceItemsCache[inv.id] || [])) {
      if (!it.productId) continue;
      stockByProduct[it.productId] = (stockByProduct[it.productId] || 0) + Number(it.quantity || 0);
    }
  }
  let stockWarn = null;
  const stockLines = [];
  for (const [pid, qty] of Object.entries(stockByProduct)) {
    const cur = productStock({ id: pid });
    const next = (cur === null ? 0 : cur) + stockDir * qty;
    const pname = (productsCache.find((x) => x.id === pid) || {}).name_ar || pid;
    stockLines.push(`«${pname}»: ${cur === null ? 'غير مسجل' : fmtNum(cur)} → ${fmtNum(next)}`);
    if (next < 0 && !stockWarn) stockWarn = `عكس فواتير هذه الجهة يخصم ${fmtNum(qty)} قطعة من «${pname}» لكن المتاح ${cur === null ? 0 : fmtNum(cur)} فقط — فسيصبح ${fmtNum(next)} (سالب). هذا يعني أن ${fmtNum(-next)} قطعة من هذا الصنف قد بيعت بالفعل. إن أكّدت الحذف فسيُسجَّل المخزون سالباً (ويُوثَّق في سجل التدقيق)؛ والأفضل أن تستلم ${fmtNum(-next)} قطعة أولاً.`;
  }
  if (stockLines.length) impact.push('المخزون: ' + stockLines.join('؛ '));
  if (Object.keys(stockByProduct).length) impact.push('ستُكتب حركة مخزون عكسية (adjustment) لكل صنف — الحركة الأصلية تبقى في السجل ولا تُحذف.');
  const batches = Math.max(1, Math.ceil(myInvoices.length / CASCADE_BATCH));
  if (batches > 1) impact.push(`كثرة الفواتير: سيُنفَّذ الحذف في ${fmtNum(batches)} دفعة آمنة (كل دفعة معاملة مستقلة)؛ إن توقفت دفعة في المنتصف تبقى الفواتير المتبقية ويمكن إعادة المحاولة.`);
  const warning = cashWarn || stockWarn;
  const impactHTML = `<p><b>سيُحذف نهائياً (مع كل ما يخصه):</b> ${esc(label)}</p><ul>${impact.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="note">الحذف نهائي ولا يمكن التراجع عنه. يُحفظ سجل تدقيق بالأثر. لن تبقى أي فاتورة أو دفعة «جهة محذوفة».</p>`;
  openDeleteModal({
    title: `🗑️ حذف ${esc(label)} مع كل فواتيره`,
    impactHTML,
    warning,
    confirmName: label,
    onConfirm: async (reason) => {
      const groups = [];
      for (let i = 0; i < myInvoices.length; i += CASCADE_BATCH) groups.push(myInvoices.slice(i, i + CASCADE_BATCH));
      if (groups.length === 0) groups.push([]);
      const orphanPayments = myPayments.filter((p) => !p[payInvField]);
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const groupIds = new Set(group.map((i) => i.id));
        const gPayments = myPayments.filter((p) => groupIds.has(p[payInvField]));
        if (gi === 0) gPayments.push(...orphanPayments);
        const gPosted = group.filter((i) => i.status === 'posted');
        const gCash = {}; // طريقة -> مجموع هذه الدفعة
        for (const pay of gPayments) {
          if (movesMoney(pay.paymentMethod) && pay.cashEffect !== 'pending' && boxesByMethod[pay.paymentMethod]) {
            gCash[pay.paymentMethod] = (gCash[pay.paymentMethod] || 0) + Number(pay.amountPiasters || 0);
          }
        }
        const gStock = {};
        for (const inv of gPosted) {
          for (const it of (invoiceItemsCache[inv.id] || [])) {
            if (!it.productId) continue;
            gStock[it.productId] = (gStock[it.productId] || 0) + Number(it.quantity || 0);
          }
        }
        await runTransaction(db, async (tx) => {
          // (1) كل القراءات أولاً.
          const invSnaps = [];
          for (const inv of group) invSnaps.push(await tx.get(doc(db, invColl, inv.id)));
          const itemSnaps = [];
          if (invColl === 'salesInvoices') {
            for (const inv of group) {
              for (const it of (invoiceItemsCache[inv.id] || [])) {
                itemSnaps.push(await tx.get(doc(db, invColl, inv.id, 'items', it.id)));
              }
            }
          }
          const paySnaps = [];
          for (const pay of gPayments) paySnaps.push(await tx.get(doc(db, payColl, pay.id)));
          const boxSnaps = {};
          for (const method of Object.keys(gCash)) boxSnaps[method] = await tx.get(boxesByMethod[method].ref);
          const balSnaps = {};
          for (const pid of Object.keys(gStock)) balSnaps[pid] = await tx.get(stockBalanceRefFor(pid));
          // (2) الكتابات: العكس ثم الحذف ثم التدقيق.
          for (const [method, total] of Object.entries(gCash)) {
            const bs = boxSnaps[method];
            if (bs && bs.exists()) {
              const cur = Number(bs.data().balancePiasters || 0);
              tx.update(boxesByMethod[method].ref, { balancePiasters: cur + cashDir * total, updatedAt: serverTimestamp() });
            }
          }
          for (const [pid, qty] of Object.entries(gStock)) {
            const bs = balSnaps[pid];
            if (bs.exists()) {
              const cur = Number(bs.data().quantity || 0);
              tx.update(stockBalanceRefFor(pid), { quantity: cur + stockDir * qty, updatedAt: serverTimestamp() });
            }
            // revision 11d: حركة عكسية (adjustment) — مرجعها الجهة المحذوفة
            // (الدفعة تجمع عدة فواتير)، والحركة الأصلية تبقى.
            writeReversingMovement(tx, pid, qty, docId, group[0] ? group[0].branchId : undefined, 'contactDelete');
          }
          itemSnaps.forEach((s) => { if (s.exists()) tx.delete(s.ref); });
          paySnaps.forEach((s) => { if (s.exists()) tx.delete(s.ref); });
          invSnaps.forEach((s) => { if (s.exists()) tx.delete(s.ref); });
          writeDeletionAudit(tx, collName, docId, `${label} — دفعة ${gi + 1}/${groups.length}`, reason, `حذف ${group.length} فاتورة و${gPayments.length} دفعة (عكس نقد ${Object.values(gCash).reduce((a, b) => a + b, 0)} بياستر، مخزون ${Object.keys(gStock).length} صنف)`);
        });
      }
      // المعاملة الأخيرة: حذف الجهة نفسها + سجل التدقيق الرئيسي.
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(doc(db, collName, docId));
        if (!snap.exists()) throw new Error('الجهة غير موجودة — ربما حُذفت بالفعل.');
        tx.delete(doc(db, collName, docId));
        writeDeletionAudit(tx, collName, docId, label, reason, impact.join(' | '));
      });
      showToast(`✅ حُذف «${label}» مع ${fmtNum(myInvoices.length)} فاتورة و${fmtNum(myPayments.length)} دفعة.`);
      await loadLookups();
      await renderContacts(collName);
    }
  });
}

async function deleteMasterRecord(collName, docId, label) {
  // revision 11b: المعامل كان اسمه collection فحجب دالة collection()
  // المستوردة (نفس خطأ writeDeletionAudit) — أُعيدت تسميته.
  if (!isOwner()) { alert('الحذف للمالك فقط.'); return; }
  const impact = [];
  let extraDeletes = []; // مراجع مستندات إضافية تُحذف مع السجل (رصيد، أرقام بديلة)
  if (collName === 'products') {
    const stock = productStock({ id: docId });
    impact.push(`المخزون المتاح: ${stock === null ? 'غير مسجل' : fmtNum(stock) + ' قطعة'} — ستُحذف كل سجلات الرصيد مع المنتج.`);
    const [sales, purchases] = await Promise.all([loadCollection('salesInvoices'), loadCollection('purchaseInvoices')]);
    await loadInvoiceItems(sales, 'salesInvoices');
    await loadInvoiceItems(purchases, 'purchaseInvoices');
    let linked = 0, linkedTotal = 0;
    for (const inv of [...sales, ...purchases]) {
      const items = invoiceItemsCache[inv.id] || [];
      if (items.some((it) => it.productId === docId)) {
        linked++;
        linkedTotal += Number(inv.totalPiasters || 0);
      }
    }
    impact.push(linked
      ? `فواتير مرتبطة: ${fmtNum(linked)} فاتورة بإجمالي ${fmtEGP(linkedTotal)} — ستبقى الفواتير وتظهر كمنتج محذوف، ولن تُحذف.`
      : 'لا توجد فواتير مرتبطة بهذا المنتج.');
    // revision 11e: سجلات الرصيد القديمة قد تحمل معرّفات أخرى غير
    // bal_<productId> (مثل <productId>_wh_main). يُحذف كل سجل رصيد
    // يحمل productId == المنتج (استعلام productId + orgId عبر
    // loadCollection)، ويُعرض في الحوار — حتى لا يبقى أي رصيد يُحسب
    // في إجمالي المخزون أو التقارير بعد الحذف.
    const allBals = await loadCollection('stockBalances');
    const prodBals = allBals.filter((b) => b.productId === docId);
    for (const b of prodBals) extraDeletes.push(doc(db, 'stockBalances', b.id));
    impact.push(prodBals.length
      ? `سجلات المخزون: ${fmtNum(prodBals.length)} سجل — ${prodBals.map((b) => `${b.id} (${fmtNum(b.quantity || 0)} قطعة)`).join('، ')} — ستُحذف كلها.`
      : 'لا توجد سجلات مخزون لهذا المنتج.');
    // الأرقام البديلة: مجموعة فرعية تحت المنتج
    const alts = await getDocs(collection(db, 'products', docId, 'alternativeNumbers'));
    alts.docs.forEach((d) => extraDeletes.push(d.ref));
  } else if (collName === 'categories') {
    // revision 11e: حذف تصنيف — تُعرض المنتجات المرتبطة؛ المنتجات نفسها
    // لا تُحذف، بل تظهر بلا تصنيف.
    const linkedProducts = (productsCache || []).filter((p) => p.categoryId === docId);
    impact.push(linkedProducts.length
      ? `منتجات مرتبطة: ${fmtNum(linkedProducts.length)} منتج — ${linkedProducts.slice(0, 5).map((p) => p.name_ar).join('، ')}${linkedProducts.length > 5 ? '…' : ''} — ستبقى المنتجات وتظهر بلا تصنيف (لن تُحذف).`
      : 'لا توجد منتجات مرتبطة بهذا التصنيف.');
  } else if (collName === 'brands') {
    // revision 11e: حذف علامة — تُعرض المنتجات المرتبطة؛ لا تُحذف.
    const linkedProducts = (productsCache || []).filter((p) => p.brandId === docId);
    impact.push(linkedProducts.length
      ? `منتجات مرتبطة: ${fmtNum(linkedProducts.length)} منتج — ستبقى المنتجات وتظهر بلا علامة (لن تُحذف).`
      : 'لا توجد منتجات مرتبطة بهذه العلامة.');
  } else if (collName === 'vehicles') {
    // revision 11e: حذف مركبة — تُعرض المنتجات المتوافقة معها؛ لا تُحذف.
    const linkedProducts = (productsCache || []).filter((p) => (p.vehicleCompatibility || []).includes(docId));
    impact.push(linkedProducts.length
      ? `منتجات مرتبطة: ${fmtNum(linkedProducts.length)} منتج متوافق مع هذه المركبة — ستبقى المنتجات (لن تُحذف).`
      : 'لا توجد منتجات مرتبطة بهذه المركبة.');
  } else if (collName === 'users') {
    // revision 11e: حذف موظف — يُحذف مستند المستخدم فقط. مبيعاته
    // وسجلاته السابقة لا تُحذف أبداً. المالك لا يستطيع حذف نفسه
    // (القواعد تمنعه أيضاً).
    // revision 11f: حساب الدخول (Firebase Auth) ما زال موجوداً بعد
    // الحذف — لن يستطيع فتح التطبيق (سيُسجَّل خروجه فوراً برسالة «هذا
    // الحساب محذوف»)، لكن حساب الدخول نفسه لم يُحذف؛ إن أردت منعه
    // تماماً (حتى من الوصول المباشر للبيانات بتصاريح الـ token) فعطّل
    // الحساب أو احذفه من Firebase Auth.
    if (docId === me.uid) { alert('لا يمكنك حذف حسابك أنت (المالك).'); return; }
    impact.push('سجل الموظف فقط — مبيعاته وسجلاته السابقة ستبقى. حساب الدخول (Firebase Auth) ما زال موجوداً، لكنه لن يصل لأي بيانات بعد الحذف (القواعد ترفض كل قراءة وكتابة لمن لا مستند مستخدم له) ولن يستطيع فتح التطبيق. إن أردت إغلاق حساب الدخول نفسه فعطّله أو احذفه من Firebase Auth.');
  } else if (collName === 'customers' || collName === 'suppliers') {
    // revision 11b: الحذف متتابع (cascade) مثل النسخة دون اتصال — لا
    // أيتام «جهة محذوفة». يُحذف العميل/المورد مع كل فواتيره ودفعاته.
    await deleteContactCascade(collName, docId, label);
    return;
  } else {
    impact.push('سجل رئيسي — لا توجد فواتير أو أرصدة مرتبطة به مباشرةً.');
  }
  const impactHTML = `<p><b>سيُحذف نهائياً:</b> ${esc(label)}</p><ul>${impact.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="note">الحذف نهائي ولا يمكن التراجع عنه. يُحفظ سجل تدقيق بالأثر.</p>`;
  openDeleteModal({
    title: `🗑️ حذف ${esc(label)}`,
    impactHTML,
    warning: null,
    confirmName: label,
    onConfirm: async (reason) => {
      await runTransaction(db, async (tx) => {
        // كل القراءات أولاً (قاعدة reads-before-writes).
        const snap = await tx.get(doc(db, collName, docId));
        if (!snap.exists()) throw new Error('السجل غير موجود — ربما حُذف بالفعل.');
        const extraSnaps = [];
        for (const ref of extraDeletes) extraSnaps.push(await tx.get(ref));
        // ثم الكتابات: الحذف + سجل التدقيق في نفس المعاملة.
        tx.delete(doc(db, collName, docId));
        extraSnaps.forEach((s, i) => { if (s.exists()) tx.delete(extraDeletes[i]); });
        writeDeletionAudit(tx, collName, docId, label, reason, impact.join(' | '));
      });
      showToast(`✅ حُذف «${label}» نهائياً.`);
      await loadLookups();
      if (currentPage === 'products') await renderProducts();
      else if (currentPage === 'customers' || currentPage === 'suppliers') await renderContacts(currentPage);
      else if (currentPage === 'inventory') await renderInventory();
    }
  });
}

// --- حذف فاتورة: عكس ثم حذف في معاملة واحدة ---
// يعكس النقد (دفعات الفاتورة)، ورصيد الجهة (المتبقي)، والمخزون (الأصناف)،
// ثم يحذف الفاتورة وبنودها ودفعاتها، ويسجّل التدقيق — كل ذلك ذرياً.
// إن كان العكس مستحيلاً (صندوق أو مخزون سالب) فالحوار يشرح العاقبة
// الملموسة والعلاج، ولا يمضي الحذف.
// --- حركة مخزون عكسية عند حذف فاتورة (أو جهة) ---
// revision 11d: الحركة الأصلية (sale_out / purchase_in) لا تُحذف أبداً
// (القواعد تمنع حذف stockMovements، وهي سجل التدقيق) — بل تُكتب حركة
// عكسية في نفس المعاملة تعيد أثرها. نوعها 'adjustment' (تصحيح) بكمية
// موجبة (القواعد ترفض الكمية السالبة)، ومرجعها الفاتورة المحذوفة،
// فيبقى تاريخ الحركات متسقاً: الأصل + العكس = صفر، والرصيد يطابق
// مجموع الحركات. direction: +1 يعيد للمخزون (عكس بيع)، -1 يخصم منه
// (عكس شراء) — تُذكر في سجل التدقيق بالكلمات.
function writeReversingMovement(tx, productId, qty, referenceId, branchId, referenceType = 'invoiceDelete') {
  const movRef = doc(collection(db, 'stockMovements'));
  tx.set(movRef, {
    orgId, branchId: branchId || DEFAULT_BRANCH,
    warehouseId: (warehouses[0] || {}).id || '',
    productId, type: 'adjustment', quantity: qty,
    referenceType, referenceId,
    createdBy: me.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
}

async function deleteInvoice(kind, inv) {
  if (!isOwner()) { alert('الحذف للمالك فقط.'); return; }
  const isSales = kind === 'sales';
  const coll = isSales ? 'salesInvoices' : 'purchaseInvoices';
  const payColl = isSales ? 'salesPayments' : 'purchasePayments';
  const data = await loadInvoiceDetail(kind, inv.id);
  if (!data) { alert('تعذّر العثور على هذه الفاتورة.'); return; }
  const { items, contact, payments, remaining, paid } = data;
  const contactId = isSales ? inv.customerId : inv.supplierId;
  const contactName = contact ? contact.name_ar : 'جهة محذوفة';
  // --- حساب الأثر قبل فتح الحوار ---
  const impact = [];
  impact.push(`الإجمالي ${fmtEGP(inv.totalPiasters)} — المدفوع ${fmtEGP(paid)} — المتبقي ${fmtEGP(remaining)}.`);
  impact.push(`الدفعات: ${fmtNum(payments.length)} دفعة بإجمالي ${fmtEGP(paid)} — ستُحذف مع الفاتورة.`);
  // النقد: دفعات البيع أضافت نقداً (عكسها يخصم)، ودفعات الشراء خصمت نقداً (عكسها يضيف).
  const cashPayments = payments.filter((p) => movesMoney(p.paymentMethod) && p.cashEffect !== 'pending');
  const cashDelta = cashPayments.reduce((a, p) => a + Number(p.amountPiasters || 0), 0);
  const cashDir = isSales ? -1 : 1; // عكس أثر الدفعة على الصندوق
  let box = null, boxCur = 0, boxNew = 0, cashBlocker = null;
  if (cashDelta > 0) {
    try {
      box = await resolveMoneyBoxRef(cashPayments[0].paymentMethod);
      const boxSnap = await getDoc(box.ref);
      boxCur = boxSnap.exists() ? Number(boxSnap.data().balancePiasters || 0) : 0;
      boxNew = boxCur + cashDir * cashDelta;
      impact.push(isSales
        ? `الصندوق «${box.label}»: سيُخصم منه ${fmtEGP(cashDelta)} (عكس دفعات البيع) — من ${fmtEGP(boxCur)} إلى ${fmtEGP(boxNew)}.`
        : `الصندوق «${box.label}»: سيُضاف إليه ${fmtEGP(cashDelta)} (عكس دفعات الشراء) — من ${fmtEGP(boxCur)} إلى ${fmtEGP(boxNew)}.`);
      if (boxNew < 0) {
        cashBlocker = `عكس دفعات هذه الفاتورة يخصم ${fmtEGP(cashDelta)} من «${box.label}» لكن رصيده الحالي ${fmtEGP(boxCur)} فقط — فسيصبح ${fmtEGP(boxNew)} (سالب). هذا يعني أن ${fmtEGP(-boxNew)} من نقد هذه الفاتورة قد صُرف أو نُقل بالفعل. إن أكّدت الحذف فسيُسجَّل الرصيد سالباً (ويُوثَّق في سجل التدقيق)؛ والأفضل أن تضيف ${fmtEGP(-boxNew)} إلى الصندوق أولاً.`;
      }
    } catch (e) { box = null; }
  }
  // المخزون: البيع أخذ من المخزون (عكسه يضيف)، والشراء أضاف للمخزون (عكسه يخصم).
  const stockDir = isSales ? 1 : -1;
  const stockByProduct = {};
  for (const it of items) {
    // revision 11d: بنود الفاتورة المخزّنة تستخدم الحقل 'quantity'
    // (POS ونموذج الفاتورة يكتبان quantity: l.qty). قراءة it.qty كانت
    // تُرجع 0 دائماً فلا يُستعاد المخزون عند حذف فاتورة بيع.
    stockByProduct[it.productId] = (stockByProduct[it.productId] || 0) + Number(it.quantity || 0);
  }
  let stockBlocker = null;
  const stockLines = [];
  for (const [pid, qty] of Object.entries(stockByProduct)) {
    const cur = productStock({ id: pid });
    const next = (cur === null ? 0 : cur) + stockDir * qty;
    const pname = (productsCache.find((p) => p.id === pid) || {}).name_ar || pid;
    stockLines.push(isSales
      ? `المخزون «${pname}»: سيُضاف ${fmtNum(qty)} قطعة (عكس البيع) — من ${cur === null ? 'غير مسجل' : fmtNum(cur)} إلى ${fmtNum(next)}.`
      : `المخزون «${pname}»: سيُخصم ${fmtNum(qty)} قطعة (عكس الشراء) — من ${cur === null ? 'غير مسجل' : fmtNum(cur)} إلى ${fmtNum(next)}.`);
    if (next < 0) {
      stockBlocker = `عكس شراء هذه الفاتورة يخصم ${fmtNum(qty)} قطعة من «${pname}» لكن المتاح ${cur === null ? 0 : fmtNum(cur)} فقط — فسيصبح ${fmtNum(next)} (سالب). هذا يعني أن ${fmtNum(-next)} قطعة من هذا الصنف قد بيعت بالفعل. إن أكّدت الحذف فسيُسجَّل المخزون سالباً (ويُوثَّق في سجل التدقيق)؛ والأفضل أن تستلم ${fmtNum(-next)} قطعة أولاً (فاتورة شراء أو تسوية مخزون).`;
    }
  }
  impact.push(...stockLines);
  if (Object.keys(stockByProduct).length) impact.push('ستُكتب حركة مخزون عكسية (adjustment) لكل صنف — الحركة الأصلية تبقى في السجل ولا تُحذف.');
  impact.push(`رصيد «${contactName}»: سيقل بمقدار المتبقي ${fmtEGP(remaining)} (تُلغى المديونية المفتوحة من هذه الفاتورة).`);
  const warning = cashBlocker || stockBlocker;
  const impactHTML = `<p><b>ستُحذف نهائياً:</b> فاتورة ${esc(inv.invoiceNumber || inv.id)} (${isSales ? 'مبيعات' : 'مشتريات'})</p><ul>${impact.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="note">الحذف نهائي ولا يمكن التراجع عنه. يُحفظ سجل تدقيق بالأثر.</p>`;
  openDeleteModal({
    title: `🗑️ حذف فاتورة ${esc(inv.invoiceNumber || inv.id)}`,
    impactHTML,
    warning,
    confirmName: inv.invoiceNumber || inv.id,
    onConfirm: async (reason) => {
      await runTransaction(db, async (tx) => {
        // (1) كل القراءات أولاً.
        const invSnap = await tx.get(doc(db, coll, inv.id));
        if (!invSnap.exists()) throw new Error('الفاتورة غير موجودة — ربما حُذفت بالفعل.');
        const paySnaps = [];
        for (const p of payments) paySnaps.push(await tx.get(doc(db, payColl, p.id)));
        const itemSnaps = [];
        if (isSales) {
          // بنود فاتورة المبيعات مجموعة فرعية؛ معرّفاتها معروفة من
          // loadInvoiceDetail (قبل المعاملة)، فنقرأها هنا عبر tx.get فقط
          // (لا getDocs داخل دالة المعاملة).
          for (const it of items) itemSnaps.push(await tx.get(doc(db, coll, inv.id, 'items', it.id)));
        }
        const contactSnap = contactId ? await tx.get(doc(db, isSales ? 'customers' : 'suppliers', contactId)) : null;
        let boxSnap = null;
        if (box) boxSnap = await tx.get(box.ref);
        const balSnaps = {};
        for (const pid of Object.keys(stockByProduct)) balSnaps[pid] = await tx.get(stockBalanceRefFor(pid));
        // (2) الكتابات: العكس ثم الحذف ثم التدقيق.
        if (box && boxSnap && boxSnap.exists() && cashDelta > 0) {
          const cur = Number(boxSnap.data().balancePiasters || 0);
          const next = cur + cashDir * cashDelta;
          // revision 11b: لا رفض هنا — إن كان next سالباً فقد حذّره الحوار
          // وأكّد المالك؛ يُسجَّل سالباً ويُوثَّق في سجل التدقيق (القواعد
          // تسمح للمالك بذلك في سياق الحذف فقط، انظر firestore.rules).
          tx.update(box.ref, { balancePiasters: next, updatedAt: serverTimestamp() });
        }
        for (const [pid, qty] of Object.entries(stockByProduct)) {
          const bs = balSnaps[pid];
          if (bs.exists()) {
            const cur = Number(bs.data().quantity || 0);
            const next = cur + stockDir * qty;
            // revision 11b: لا رفض هنا — سالب بعد تحذير وتأكيد المالك.
            tx.update(stockBalanceRefFor(pid), { quantity: next, updatedAt: serverTimestamp() });
          }
          // revision 11d: حركة عكسية (adjustment) في نفس المعاملة — الحركة
          // الأصلية تبقى (لا تُحذف)، والعكس يوثّق الاستعادة.
          writeReversingMovement(tx, pid, qty, inv.id, inv.branchId);
        }
        if (contactSnap && contactSnap.exists() && remaining > 0) {
          const cur = Number(contactSnap.data().currentBalancePiasters || 0);
          tx.update(contactSnap.ref, { currentBalancePiasters: Math.max(0, cur - remaining), updatedAt: serverTimestamp() });
        }
        itemSnaps.forEach((s) => { if (s.exists()) tx.delete(s.ref); });
        paySnaps.forEach((s) => { if (s.exists()) tx.delete(s.ref); });
        tx.delete(doc(db, coll, inv.id));
        writeDeletionAudit(tx, coll, inv.id, inv.invoiceNumber || inv.id, reason, impact.join(' | '));
      });
      showToast(`✅ حُذفت فاتورة ${inv.invoiceNumber || inv.id} وعُكست آثارها.`);
      if (currentPage === 'invoice-detail') go(isSales ? 'sales' : 'purchases');
      else if (currentPage === 'debts' || currentPage === 'debt-detail') await renderDebts(isSales ? 'customers' : 'suppliers');
    }
  });
}

// --- حذف دفعة: عكس ثم حذف في معاملة واحدة ---
// يعكس النقد (إن حرّكت الدفعة نقداً)، ورصيد الجهة (يعود الدين بمقدار
// الدفعة)، وحقلي المدفوع/المتبقي في الفاتورة (المتبقي يزيد بمقدار الدفعة،
// والمدفوع المشتق ينقص تلقائياً بحذف مستند الدفعة)، ثم يحذف الدفعة.
async function deletePayment(kind, payment) {
  if (!isOwner()) { alert('الحذف للمالك فقط.'); return; }
  const isCust = kind === 'customers';
  const payColl = isCust ? 'salesPayments' : 'purchasePayments';
  const invColl = isCust ? 'salesInvoices' : 'purchaseInvoices';
  const invId = isCust ? payment.salesInvoiceId : payment.purchaseInvoiceId;
  const contactId = isCust ? payment.customerId : payment.supplierId;
  const amount = Number(payment.amountPiasters || 0);
  const impact = [];
  impact.push(`الدفعة: ${fmtEGP(amount)} — ${payMethodLabel(payment.paymentMethod)} — بتاريخ ${tsToDate(payment.date || payment.createdAt).toLocaleDateString('ar-EG')}.`);
  let inv = null, invRemaining = 0, invTotal = 0, invNewRemaining = 0;
  if (invId) {
    const invSnap = await getDoc(doc(db, invColl, invId));
    if (invSnap.exists()) {
      inv = { id: invSnap.id, ...invSnap.data() };
      const invPayments = (await loadCollection(payColl)).filter((p) => (isCust ? p.salesInvoiceId : p.purchaseInvoiceId) === invId);
      // revision 11c: المتبقي الحالي من كل الدفعات، والمتبقي الجديد بعد
      // استبعاد هذه الدفعة — بنفس الدالة التي تستخدمها المعاملة أدناه.
      invRemaining = remainingFromPayments(inv, invPayments);
      invTotal = Number(inv.totalPiasters || 0);
      invNewRemaining = remainingFromPayments(inv, invPayments.filter((p) => p.id !== payment.id));
      impact.push(`الفاتورة ${esc(inv.invoiceNumber || inv.id)}: المتبقي سيزيد من ${fmtEGP(invRemaining)} إلى ${fmtEGP(invNewRemaining)} (المدفوع المشتق ينقص ${fmtEGP(amount)}).`);
    }
  }
  let box = null, boxCur = 0, boxNew = 0, cashBlocker = null;
  if (movesMoney(payment.paymentMethod) && payment.cashEffect !== 'pending') {
    try {
      box = await resolveMoneyBoxRef(payment.paymentMethod);
      const boxSnap = await getDoc(box.ref);
      boxCur = boxSnap.exists() ? Number(boxSnap.data().balancePiasters || 0) : 0;
      // دفعة البيع أضافت نقداً (عكسها يخصم)، ودفعة الشراء خصمت نقداً (عكسها يضيف).
      boxNew = isCust ? boxCur - amount : boxCur + amount;
      impact.push(isCust
        ? `الصندوق «${box.label}»: سيُخصم منه ${fmtEGP(amount)} (عكس دفعة البيع) — من ${fmtEGP(boxCur)} إلى ${fmtEGP(boxNew)}.`
        : `الصندوق «${box.label}»: سيُضاف إليه ${fmtEGP(amount)} (عكس دفعة الشراء) — من ${fmtEGP(boxCur)} إلى ${fmtEGP(boxNew)}.`);
      if (boxNew < 0) {
        cashBlocker = `عكس هذه الدفعة يخصم ${fmtEGP(amount)} من «${box.label}» لكن رصيده الحالي ${fmtEGP(boxCur)} فقط — فسيصبح ${fmtEGP(boxNew)} (سالب). هذا يعني أن ${fmtEGP(-boxNew)} من نقد هذه الدفعة قد صُرف أو نُقل بالفعل. إن أكّدت الحذف فسيُسجَّل الرصيد سالباً (ويُوثَّق في سجل التدقيق)؛ والأفضل أن تضيف ${fmtEGP(-boxNew)} إلى الصندوق أولاً.`;
      }
    } catch (e) { box = null; }
  } else if (payment.cashEffect === 'pending') {
    impact.push('أثر الصندوق لهذه الدفعة معلّق (لم يُطبَّق بعد) — لا عكس نقدي.');
  } else {
    impact.push('طريقة الدفع لا تحرّك الصندوق — لا عكس نقدي.');
  }
  let contactName = 'جهة محذوفة';
  if (contactId) {
    const contactSnap = await getDoc(doc(db, isCust ? 'customers' : 'suppliers', contactId));
    if (contactSnap.exists()) contactName = contactSnap.data().name_ar || contactName;
  }
  impact.push(`رصيد «${contactName}»: سيزيد ${fmtEGP(amount)} (يعود الدين بمقدار الدفعة).`);
  const impactHTML = `<p><b>ستُحذف نهائياً:</b> دفعة ${fmtEGP(amount)} (${payMethodLabel(payment.paymentMethod)})</p><ul>${impact.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="note">الحذف نهائي ولا يمكن التراجع عنه. يُحفظ سجل تدقيق بالأثر.</p>`;
  openDeleteModal({
    title: '🗑️ حذف دفعة',
    impactHTML,
    warning: cashBlocker,
    confirmName: String(amount / 100),
    onConfirm: async (reason) => {
      await runTransaction(db, async (tx) => {
        // (1) كل القراءات أولاً.
        const paySnap = await tx.get(doc(db, payColl, payment.id));
        if (!paySnap.exists()) throw new Error('الدفعة غير موجودة — ربما حُذفت بالفعل.');
        const invSnap = invId ? await tx.get(doc(db, invColl, invId)) : null;
        const contactSnap = contactId ? await tx.get(doc(db, isCust ? 'customers' : 'suppliers', contactId)) : null;
        let boxSnap = null;
        if (box) boxSnap = await tx.get(box.ref);
        // (2) الكتابات: العكس ثم الحذف ثم التدقيق.
        if (box && boxSnap && boxSnap.exists() && movesMoney(payment.paymentMethod) && payment.cashEffect !== 'pending') {
          const cur = Number(boxSnap.data().balancePiasters || 0);
          const next = isCust ? cur - amount : cur + amount;
          // revision 11b: لا رفض هنا — سالب بعد تحذير وتأكيد المالك.
          tx.update(box.ref, { balancePiasters: next, updatedAt: serverTimestamp() });
        }
        if (contactSnap && contactSnap.exists()) {
          const cur = Number(contactSnap.data().currentBalancePiasters || 0);
          tx.update(contactSnap.ref, { currentBalancePiasters: cur + amount, updatedAt: serverTimestamp() });
        }
        if (invSnap && invSnap.exists()) {
          // revision 11c: المتبقي المخزّن = المشتق بعد استبعاد هذه الدفعة
          // (الإجمالي - المدفوع عند الإنشاء - مجموع الدفعات الأخرى)،
          // مقيّد بين 0 والإجمالي. نفس القيمة التي عرضها الحوار
          // (invNewRemaining) — لا invRemaining + amount، لأن invRemaining
          // كان يُحسب خطأً من مصفوفة فتجاوز الإجمالي (250 > 200).
          tx.update(invSnap.ref, { remainingPiasters: invNewRemaining, updatedAt: serverTimestamp() });
        }
        tx.delete(doc(db, payColl, payment.id));
        writeDeletionAudit(tx, payColl, payment.id, `دفعة ${fmtEGP(amount)}`, reason, impact.join(' | '));
      });
      showToast(`✅ حُذفت الدفعة ${fmtEGP(amount)} وعُكست آثارها.`);
      if (currentPage === 'debt-detail') await renderDebtDetail(kind, contactId);
      else if (currentPage === 'invoice-detail') await renderInvoiceDetail(isCust ? 'sales' : 'purchase', invId);
      else await renderDebts(kind);
    }
  });
}

// --- تسجيل مديونية يدوية (من غير فاتورة منتجات) ---
// تُسجَّل كفاتورة مفتوحة isManualDebt (بلا بنود وبلا حركة مخزون) فيرجع رصيدها
// في المديونيات والدفعات والطباعة تلقائياً، مع زيادة رصيد الجهة فوراً.
let mdKind = 'customers', mdContact = null, mdContacts = [], mdOnDone = null;
function contactSummaryHTML(c, owed) {
  return `<div class="list-row"><span>الاسم</span><b>${esc(c.name_ar)}</b></div>
  <div class="list-row"><span>الهاتف</span><b dir="ltr">${esc(c.phone || '—')}</b></div>
  <div class="list-row"><span>العنوان</span><b>${esc(c.address_ar || '—')}</b></div>
  <div class="list-row"><span>الرصيد الحالي</span><b>${fmtEGP(owed)}</b></div>`;
}
async function openManualDebtForm(kind, contact, onDone) {
  mdKind = kind; mdContact = contact || null; mdOnDone = onDone || null;
  const isCust = kind === 'customers';
  $('manual-debt-title').textContent = `➕ تسجيل مديونية — ${isCust ? 'عميل' : 'مورد'}`;
  $('md-date').value = dateInputVal(new Date());
  $('md-amount').value = ''; $('md-reason').value = ''; $('md-details').value = '';
  hideError($('md-error'));
  const picker = $('md-contact-picker'), summary = $('md-contact-summary');
  // الرصيد المعروض في الملخص مشتق من الفواتير المفتوحة + الافتتاحي (وليس المخزّن)
  const { byContact: mdByContact } = await loadDebtsData(kind);
  const mdOwed = (c) => contactOwed(c, mdByContact[c.id] || []);
  if (mdContact) {
    picker.style.display = 'none';
    summary.innerHTML = contactSummaryHTML(mdContact, mdOwed(mdContact));
  } else {
    picker.style.display = '';
    mdContacts = await loadCollection(kind);
    $('md-contact-select').innerHTML = mdContacts.map((c) => `<option value="${c.id}">${esc(c.name_ar)} — ${esc(c.phone || '')}</option>`).join('');
    const first = mdContacts[0] || null;
    mdContact = first;
    summary.innerHTML = first ? contactSummaryHTML(first, mdOwed(first)) : emptyState('لا يوجد عملاء/موردون بعد — أضف جهة أولاً.');
    $('md-contact-select').onchange = (e) => {
      mdContact = mdContacts.find((c) => c.id === e.target.value) || null;
      if (mdContact) summary.innerHTML = contactSummaryHTML(mdContact, mdOwed(mdContact));
    };
  }
  $('manual-debt-modal').classList.remove('hidden');
}
$('manual-debt-cancel-btn').addEventListener('click', () => $('manual-debt-modal').classList.add('hidden'));
$('manual-debt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!mdContact) { showError($('md-error'), 'اختر العميل / المورد أولاً.'); return; }
  const amount = toPiasters($('md-amount').value);
  const reason = $('md-reason').value.trim();
  const details = $('md-details').value.trim();
  const dateTs = parseDateInput($('md-date').value) || Timestamp.fromDate(new Date());
  if (!amount || amount <= 0) { showError($('md-error'), 'أدخل مبلغاً أكبر من صفر.'); return; }
  if (!reason) { showError($('md-error'), 'اكتب البيان / سبب المديونية.'); return; }
  if (!details) { showError($('md-error'), 'اكتب التفاصيل — هو خد إيه؟ (البضاعة/المنتجات).'); return; }
  const isCust = mdKind === 'customers';
  $('md-save').disabled = true; $('md-save').textContent = 'جارٍ الحفظ...';
  try {
    // مديونية يدوية في معاملة ذرية واحدة: الفاتورة + رصيد الجهة، مع معرّف
    // عملية محفوظ بالحمولة الكاملة وفحص عدم التكرار. لا تحرّك الصندوق/البنك
    // (مديونية آجلة فقط — الدفع يتم لاحقاً عبر recordPayment).
    const mdKey = pendingOpKey(['debt', mdKind, mdContact.id]);
    const mdStored = readPendingOp(mdKey);
    const mdNum = mdStored
      ? mdStored.payload.invoiceNumber
      : 'DEBT-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now()).slice(-6);
    const mdPayload = {
      kind: mdKind, contactId: mdContact.id, amount, reason, details,
      dateMs: dateTs ? dateTs.toMillis() : null, invoiceNumber: mdNum
    };
    let mdOpId;
    for (;;) {
      const begin = await beginPendingOp(mdKey, mdPayload, async (storedOpId) => {
        const s = await getDoc(markerRefFor(storedOpId));
        return s.exists();
      }, async (storedOpId) => {
        const d = await getDoc(doc(db, isCust ? 'salesInvoices' : 'purchaseInvoices', storedOpId));
        return d.exists() ? { invoiceNumber: d.data().invoiceNumber, totalPiasters: d.data().totalPiasters } : null;
      });
      if (begin.action === 'proceed') { mdOpId = begin.opId; break; }
      if (begin.action === 'unknown') {
        showError($('md-error'), unknownBlockMessage('مديونية يدوية'));
        $('md-save').disabled = false; $('md-save').textContent = '✅ تسجيل المديونية';
        return;
      }
      if (begin.committed) {
        alert(committedBlockMessage(begin.stored, begin.saved, 'مديونية يدوية'));
        $('md-save').disabled = false; $('md-save').textContent = '✅ تسجيل المديونية';
        return;
      }
      const ok = confirmDiscardPendingOp(begin.stored, mdPayload, false, 'مديونية يدوية');
      if (!ok) {
        showError($('md-error'), 'تم إلغاء التسجيل — توجد مديونية معلقة بقيم مختلفة. راجع القيم الأصلية أو تجاهل العملية المعلقة أولاً.');
        $('md-save').disabled = false; $('md-save').textContent = '✅ تسجيل المديونية';
        return;
      }
      clearPendingOp(mdKey);
    }
    const due = new Date(dateTs.toDate().getTime() + 30 * 86400000);
    const mdInvRef = doc(db, isCust ? 'salesInvoices' : 'purchaseInvoices', mdOpId);
    const mdMarkerRef = markerRefFor(mdOpId);
    const mdResult = await runTransaction(db, async (tx) => {
      const mdMarkerSnap = await tx.get(mdMarkerRef);
      if (mdMarkerSnap.exists()) {
        const existingDebt = await tx.get(mdInvRef);
        const d = existingDebt.exists() ? existingDebt.data() : {};
        return { alreadyApplied: true, saved: { invoiceNumber: d.invoiceNumber, totalPiasters: d.totalPiasters } };
      }
      const contactSnap = await tx.get(doc(db, mdKind, mdContact.id));
      const cur = contactSnap.exists() ? Number(contactSnap.data().currentBalancePiasters || 0) : 0;
      tx.set(mdMarkerRef, { orgId, opId: mdOpId, kind: 'debt', createdAt: serverTimestamp() });
      tx.set(mdInvRef, {
        orgId, branchId: DEFAULT_BRANCH,
        ...(isCust ? { customerId: mdContact.id } : { supplierId: mdContact.id }),
        invoiceNumber: mdNum, date: dateTs, dueDate: Timestamp.fromDate(due),
        status: 'posted', totalPiasters: amount, paidPiasters: 0, remainingPiasters: amount,
        subtotalPiasters: amount, discountPiasters: 0, taxPiasters: 0,
        isManualDebt: true, manualReason: reason, manualDetails: details, paymentMethod: 'credit',
        opId: mdOpId, createdBy: me.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      if (contactSnap.exists()) {
        tx.update(doc(db, mdKind, mdContact.id), { currentBalancePiasters: cur + amount, updatedAt: serverTimestamp() });
      }
      return { alreadyApplied: false };
    });
    clearPendingOp(mdKey);
    $('manual-debt-modal').classList.add('hidden');
    showToast(mdResult.alreadyApplied
      ? `المديونية ${mdResult.saved.invoiceNumber} مسجَّلة بالفعل — لم يُضف أي أثر مكرر. القيمة المحفوظة: ${fmtEGP(mdResult.saved.totalPiasters)}.`
      : `✅ تم تسجيل مديونية ${fmtEGP(amount)} على ${mdContact.name_ar} — رقمها ${mdNum}.`);
    const done = mdOnDone; mdOnDone = null; if (done) await done();
  } catch (err) {
    // revision 11, Issue 1: فشل حتمي — امسح العملية المعلقة حتى لا تحظر
    // المديونية التالية بتحذير مضلل.
    if (isDefinitiveSaveFailure(err)) clearPendingOp(mdKey);
    showError($('md-error'), firestoreErrorMessage(err));
  } finally {
    $('md-save').disabled = false; $('md-save').textContent = '✅ تسجيل المديونية';
  }
});

// إنشاء فاتورة مباشرة (بدون سلة) — اختيار المنتج يضيفه للفاتورة فوراً
// ============================================================================
let invForm = null;       // { kind, lines: [{product, qty, unitPrice}], contactId }
// invoiceScanTarget معلنة أعلى الملف بجانب متغيرات المسح

function invFormTotals() {
  if (!invForm) return { subtotal: 0, total: 0, paid: 0, remaining: 0 };
  const subtotal = invForm.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
  const discount = toPiasters($('inv-discount') ? $('inv-discount').value : 0);
  const tax = toPiasters($('inv-tax') ? $('inv-tax').value : 0);
  const total = Math.max(0, subtotal - discount + tax);
  let paid = 0;
  const status = document.querySelector('input[name="inv-pay-status"]:checked');
  if (status && status.value === 'paid') paid = total;
  else if (status && status.value === 'partial') paid = Math.min(total, toPiasters($('inv-paid-amount') ? $('inv-paid-amount').value : 0));
  return { subtotal, discount, tax, total, paid, remaining: total - paid };
}
function updateInvTotals() {
  const t = invFormTotals();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('inv-subtotal', fmtEGP(t.subtotal));
  set('inv-total', fmtEGP(t.total));
  set('inv-paid-show', fmtEGP(t.paid));
  set('inv-remaining', fmtEGP(t.remaining));
}
function drawInvLines() {
  const wrap = $('inv-lines');
  if (!wrap || !invForm) return;
  wrap.innerHTML = invForm.lines.length ? `<table><tr><th>المنتج</th><th>رقم القطعة</th><th>الكمية</th><th>سعر الوحدة (جنيه)</th><th>الإجمالي</th><th></th></tr>
    ${invForm.lines.map((l, i) => `<tr>
      <td>${esc(l.product.name_ar)}${demoBadge(l.product)}</td><td dir="ltr">${esc(l.product.partNumber || '—')}</td>
      <td><input type="number" min="1" step="1" value="${l.qty}" data-line-qty="${i}" style="width:80px"></td>
      <td><input type="number" min="0" step="0.01" value="${(l.unitPrice / 100).toFixed(2)}" data-line-price="${i}" style="width:100px"></td>
      <td class="num" data-line-total="${i}">${fmtEGP(l.qty * l.unitPrice)}</td>
      <td><button class="btn small secondary" data-line-del="${i}">✕</button></td></tr>`).join('')}</table>`
    : emptyState('لم تضف أي منتج بعد — ابحث بالاسم أو رقم القطعة أو الباركود، أو امسح بالكاميرا، وسيُضاف المنتج للفاتورة مباشرة.');
  wrap.querySelectorAll('[data-line-qty]').forEach((inp) => inp.addEventListener('input', () => {
    const l = invForm.lines[Number(inp.dataset.lineQty)];
    l.qty = Math.max(1, Math.floor(Number(inp.value) || 1));
    const stock = productStock(l.product);
    if (invForm.kind === 'sales' && stock !== null && l.qty > stock) {
      alert(`المخزون المتاح ${stock} قطعة فقط من ${l.product.name_ar}.`);
      l.qty = stock; inp.value = stock;
    }
    const totalEl = wrap.querySelector(`[data-line-total="${inp.dataset.lineQty}"]`);
    if (totalEl) totalEl.textContent = fmtEGP(l.qty * l.unitPrice);
    updateInvTotals();
  }));
  wrap.querySelectorAll('[data-line-price]').forEach((inp) => inp.addEventListener('input', () => {
    const l = invForm.lines[Number(inp.dataset.linePrice)];
    l.unitPrice = Math.max(0, toPiasters(inp.value));
    const totalEl = wrap.querySelector(`[data-line-total="${inp.dataset.linePrice}"]`);
    if (totalEl) totalEl.textContent = fmtEGP(l.qty * l.unitPrice);
    updateInvTotals();
  }));
  wrap.querySelectorAll('[data-line-del]').forEach((b) => b.addEventListener('click', () => {
    invForm.lines.splice(Number(b.dataset.lineDel), 1); drawInvLines(); updateInvTotals();
  }));
}
function addInvLine(product) {
  if (!invForm) return;
  const stock = productStock(product);
  if (invForm.kind === 'sales' && stock !== null && stock <= 0) { alert(`المنتج ${product.name_ar} نافد من المخزون.`); return; }
  const existing = invForm.lines.find((l) => l.product.id === product.id);
  if (existing) {
    if (invForm.kind === 'sales' && stock !== null && existing.qty + 1 > stock) { alert(`المخزون المتاح ${stock} قطعة فقط من ${product.name_ar}.`); return; }
    existing.qty += 1;
  } else {
    invForm.lines.push({
      product,
      qty: 1,
      unitPrice: Number(invForm.kind === 'purchase' ? (product.purchasePricePiasters || 0) : (product.sellingPricePiasters || 0))
    });
  }
  drawInvLines(); updateInvTotals();
}

async function renderInvoiceForm(kind) {
  const isSales = kind === 'sales';
  if (!canCreateInvoice(kind)) {
    $('page').innerHTML = emptyState('دورك الحالي لا يسمح بإنشاء فواتير ' + (isSales ? 'مبيعات' : 'شراء') + '.');
    return;
  }
  await loadProducts();
  const contacts = await loadCollection(isSales ? 'customers' : 'suppliers');
  const activeContacts = contacts.filter((c) => c.isActive !== false);
  invForm = { kind, lines: [], contactId: '' };
  const today = dateInputVal(new Date());
  const due = dateInputVal(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  $('page').innerHTML = `
    <h2 class="page-title">🧾 ${isSales ? 'إنشاء فاتورة مبيعات' : 'إنشاء فاتورة شراء'}</h2>
    <p class="page-sub">اختر المنتج بالبحث أو المسح فيُضاف للفاتورة مباشرة — لا توجد سلة في هذا المسار. الكمية والسعر يتعدلان في نفس السطر. نقطة البيع (POS) تبقى كما هي لمن يفضّل السلة.</p>
    <p><button class="btn small secondary" id="inv-back">← عودة إلى ${isSales ? 'نقطة البيع' : 'المشتريات'}</button></p>
    <div class="card"><h3>بيانات الفاتورة</h3>
      <div class="form-grid">
        <div><label>${isSales ? 'العميل' : 'المورد'} ${isSales ? '' : '*'}</label>
          <select id="inv-contact"><option value="">${isSales ? 'عميل نقدي (بدون حساب)' : '— اختر المورد —'}</option>
          ${activeContacts.map((c) => `<option value="${c.id}">${esc(c.name_ar)} — ${esc(c.phone || '')}</option>`).join('')}</select></div>
        <div><label>الفرع</label><select id="inv-branch">
          ${branches.map((b) => `<option value="${b.id}" ${b.id === DEFAULT_BRANCH ? 'selected' : ''}>${esc(b.name_ar)}</option>`).join('') || `<option value="${DEFAULT_BRANCH}">الفرع الرئيسي</option>`}</select></div>
        <div><label>تاريخ الفاتورة *</label><input id="inv-date" type="date" value="${today}"></div>
        <div><label>تاريخ الاستحقاق</label><input id="inv-due" type="date" value="${due}"></div>
      </div>
      <div class="form-grid" style="margin-top:10px">
        <div><label>اسم جديد (سريع)</label><input id="inv-new-name" placeholder="اسم ${isSales ? 'عميل' : 'مورد'} جديد"></div>
        <div><label>هاتف الجديد</label><input id="inv-new-phone" dir="ltr" placeholder="01xxxxxxxxx"></div>
        <div style="align-self:end"><button class="btn small" id="inv-new-contact" type="button">➕ إضافة واختياره</button></div>
      </div>
      <div class="form-grid" style="margin-top:10px">
        <div><label>الخصم (جنيه)</label><input id="inv-discount" type="number" step="0.01" min="0" value="0"></div>
        <div><label>الضريبة (جنيه)</label><input id="inv-tax" type="number" step="0.01" min="0" value="0"></div>
        <div><label>ملاحظات</label><input id="inv-notes" placeholder="اختياري"></div>
      </div>
      <div style="margin-top:12px"><label>حالة السداد عند الإنشاء</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">
          <label style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="inv-pay-status" value="paid" style="width:auto"> مدفوع بالكامل</label>
          <label style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="inv-pay-status" value="partial" style="width:auto"> جزئي (دفعة أولى)</label>
          <label style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="inv-pay-status" value="credit" checked style="width:auto"> آجل (دين كامل)</label>
        </div></div>
      <div class="form-grid" style="margin-top:10px">
        <div><label>المبلغ المدفوع الآن (جنيه)</label><input id="inv-paid-amount" type="number" step="0.01" min="0" value="0"></div>
        <div><label>طريقة الدفع الآن</label><select id="inv-pay-method">${PAY_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="card"><h3>🔍 إضافة منتج للفاتورة</h3>
      <div class="toolbar">
        <input id="inv-search" type="search" placeholder="ابحث بالاسم، رقم القطعة، الباركود، أو QR...">
        <button class="btn scan small" id="inv-scan-btn" type="button">📷 مسح بالكاميرا</button>
      </div>
      <div id="inv-search-results"></div>
      <div id="inv-lines" style="margin-top:12px"></div>
      <div class="cart-total"><span>الإجمالي الفرعي</span><span id="inv-subtotal">0.00 ج.م</span></div>
      <div class="list-row"><span>الإجمالي بعد الخصم والضريبة</span><b id="inv-total">0.00 ج.م</b></div>
      <div class="list-row"><span>المدفوع الآن</span><b id="inv-paid-show">0.00 ج.م</b></div>
      <div class="list-row"><span>المتبقي (مديونية)</span><b id="inv-remaining">0.00 ج.م</b></div>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="btn" id="inv-save" style="width:auto">✅ حفظ الفاتورة</button>
        <button class="btn secondary" id="inv-cancel" style="width:auto" type="button">إلغاء</button>
      </div>
      <div class="error" id="inv-error"></div>
      <p class="note">رقم الفاتورة يُولَّد تلقائياً. الفاتورة المنشورة لا تُحذف ولا تُعدَّل — الإلغاء يكون بعكسها فقط. المخزون يتحرك مع حفظ الفاتورة (خروج للبيع / دخول للشراء).</p>
    </div>`;
  const refreshPayInputs = () => {
    const st = document.querySelector('input[name="inv-pay-status"]:checked');
    const paidInput = $('inv-paid-amount');
    if (st && st.value === 'paid') {
      // مدفوع بالكامل: المبلغ هو الإجمالي نفسه — يُعرض في الحقل (معطّل) ولا يُكتب يدوياً
      paidInput.disabled = true;
      paidInput.value = (invFormTotals().total / 100).toFixed(2);
    } else if (st && st.value === 'partial') {
      paidInput.disabled = false; // جزئي: المبلغ قابل للكتابة
    } else {
      paidInput.disabled = true;
      paidInput.value = 0;
    }
    updateInvTotals();
  };
  document.querySelectorAll('input[name="inv-pay-status"]').forEach((r) => r.addEventListener('change', refreshPayInputs));
  ['inv-discount', 'inv-tax', 'inv-paid-amount'].forEach((id) => $(id).addEventListener('input', updateInvTotals));
  $('inv-back').addEventListener('click', () => go(isSales ? 'sales' : 'purchases'));
  $('inv-cancel').addEventListener('click', () => go(isSales ? 'sales' : 'purchases'));
  $('inv-new-contact').addEventListener('click', async () => {
    const name = $('inv-new-name').value.trim();
    const phone = $('inv-new-phone').value.trim();
    if (!name || !phone) { alert('أدخل اسم وهاتف الجهة الجديدة.'); return; }
    // منع النقر المزدوج أثناء الإنشاء (كان ينشئ جهتين بنفس الاسم والهاتف).
    const btn = $('inv-new-contact');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      // لا مكرر: إن وُجدت جهة بنفس الهاتف في المنظمة، نختارها بدل إنشاء جديدة.
      // الجهة تُنشأ فوراً هنا (قبل حفظ الفاتورة) وتبقى حتى لو أُلغيت الفاتورة —
      // هذا مقصود وموثّق: إنشاء الجهة مستقل عن حفظ الفاتورة.
      // (بديل كان مطروحاً: معرّف حتمي من الهاتف — رُفض لأنه يمنع جهتين
      // شرعيتين تشتركان في هاتف واحد، ولأن الهاتف قد يتغير.)
      const collName = isSales ? 'customers' : 'suppliers';
      const existing = (await loadCollection(collName)).find((c) => String(c.phone || '').trim() === phone);
      let refId;
      if (existing) {
        refId = existing.id;
      } else {
        const ref = await addDoc(collection(db, collName), {
          orgId, branchId: DEFAULT_BRANCH, name_ar: name, name_en: '', phone, email: '', address_ar: '',
          openingBalancePiasters: 0, currentBalancePiasters: 0, creditLimitPiasters: 0,
          isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        refId = ref.id;
      }
      const sel = $('inv-contact');
      if (![...sel.options].some((o) => o.value === refId)) {
        sel.innerHTML += `<option value="${refId}" selected>${esc(name)} — ${esc(phone)}</option>`;
      }
      sel.value = refId;
      $('inv-new-name').value = ''; $('inv-new-phone').value = '';
    } catch (err) { alert(firestoreErrorMessage(err)); }
    finally { btn.disabled = false; }
  });
  $('inv-search').addEventListener('input', async (e) => {
    const q = e.target.value;
    const box = $('inv-search-results');
    if (!q.trim()) { box.innerHTML = ''; return; }
    const list = (await searchProducts(q)).filter((p) => p.isActive !== false).slice(0, 8);
    box.innerHTML = list.length ? list.map((p) => `
      <div class="list-row" style="cursor:pointer" data-inv-pick="${p.id}">
        <span>${esc(p.name_ar)} <small dir="ltr" style="color:var(--muted)">${esc(p.partNumber || '')}</small></span>
        <b>${fmtEGP(isSales ? p.sellingPricePiasters : p.purchasePricePiasters)} — متاح: ${productStock(p) ?? '—'}</b>
      </div>`).join('') : emptyState('لا توجد نتائج مطابقة.');
    box.querySelectorAll('[data-inv-pick]').forEach((el) => el.addEventListener('click', () => {
      addInvLine(productsCache.find((p) => p.id === el.dataset.invPick));
      $('inv-search').value = ''; box.innerHTML = '';
    }));
  });
  $('inv-scan-btn').addEventListener('click', () => {
    invoiceScanTarget = (p) => { if (p.isActive === false) { alert('هذا المنتج موقوف.'); return; } addInvLine(p); };
    openScanner();
  });
  $('inv-save').addEventListener('click', saveInvoiceForm);
  drawInvLines(); refreshPayInputs();
}

async function saveInvoiceForm() {
  if (!invForm) return;
  hideError($('inv-error'));
  const isSales = invForm.kind === 'sales';
  const contactId = $('inv-contact').value || null;
  const branchId = $('inv-branch').value || DEFAULT_BRANCH;
  const dateTs = parseDateInput($('inv-date').value) || Timestamp.fromDate(new Date());
  const dueTs = parseDateInput($('inv-due').value) || Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  const notes = $('inv-notes').value.trim();
  const t = invFormTotals();
  const payStatus = document.querySelector('input[name="inv-pay-status"]:checked');
  const payMethod = $('inv-pay-method').value;
  if (!invForm.lines.length) { showError($('inv-error'), 'أضف منتجاً واحداً على الأقل للفاتورة.'); return; }
  if (!isSales && !contactId) { showError($('inv-error'), 'اختر المورد أولاً.'); return; }
  if (isSales && payStatus.value !== 'paid' && !contactId) { showError($('inv-error'), 'الفاتورة الآجلة أو الجزئية تحتاج عميلاً مسجلاً — اختر عميلاً أو أضف عميلاً جديداً.'); return; }
  if (t.total <= 0) { showError($('inv-error'), 'إجمالي الفاتورة يجب أن يكون أكبر من صفر.'); return; }
  for (const l of invForm.lines) {
    if (!l.qty || l.qty <= 0) { showError($('inv-error'), 'كمية كل صنف يجب أن تكون أكبر من صفر.'); return; }
    if (isSales) {
      const stock = productStock(l.product);
      if (stock !== null && l.qty > stock) { showError($('inv-error'), `المخزون المتاح ${stock} قطعة فقط من ${l.product.name_ar}.`); return; }
    }
  }
  const prefix = isSales ? 'SI' : 'PI';
  const btn = $('inv-save');
  btn.disabled = true; btn.textContent = 'جارٍ الحفظ...';
  // الحمولة الكاملة للفاتورة — كل حقل يؤثر على المال أو السجل. رقم الفاتورة
  // يُعاد استخدامه من العملية المعلقة إن وُجدت (حتى لا يتغير عند إعادة المحاولة).
  const invFormKey = pendingOpKey(['inv', 'form', isSales ? 'sales' : 'purchase']);
  const invFormStored = readPendingOp(invFormKey);
  const formInvoiceNumber = invFormStored
    ? invFormStored.payload.invoiceNumber
    : `${prefix}-` + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now()).slice(-6);
  const formPayload = {
    kind: isSales ? 'sales' : 'purchase', branchId, contactId: contactId || null,
    lines: invForm.lines.map((l) => ({ productId: l.product.id, qty: l.qty, unitPrice: l.unitPrice })).sort((a, b) => String(a.productId).localeCompare(String(b.productId))),
    subtotal: t.subtotal, discount: t.discount, tax: t.tax, total: t.total, paid: t.paid, remaining: t.remaining,
    payMethod, dateMs: dateTs ? dateTs.toMillis() : null, dueMs: dueTs ? dueTs.toMillis() : null,
    notes: notes || '', invoiceNumber: formInvoiceNumber
  };
  let formOpId;
  for (;;) {
    const begin = await beginPendingOp(invFormKey, formPayload, async (storedOpId) => {
      const s = await getDoc(markerRefFor(storedOpId));
      return s.exists();
    }, async (storedOpId) => {
      const d = await getDoc(doc(db, isSales ? 'salesInvoices' : 'purchaseInvoices', storedOpId));
      return d.exists() ? { invoiceNumber: d.data().invoiceNumber, totalPiasters: d.data().totalPiasters, paidPiasters: d.data().paidPiasters } : null;
    });
    if (begin.action === 'proceed') { formOpId = begin.opId; break; }
    if (begin.action === 'unknown') {
      showError($('inv-error'), unknownBlockMessage('فاتورة مباشرة'));
      btn.disabled = false; btn.textContent = '✅ حفظ الفاتورة';
      return;
    }
    if (begin.committed) {
      alert(committedBlockMessage(begin.stored, begin.saved, 'فاتورة مباشرة'));
      btn.disabled = false; btn.textContent = '✅ حفظ الفاتورة';
      return;
    }
    const ok = confirmDiscardPendingOp(begin.stored, formPayload, false, 'فاتورة مباشرة');
    if (!ok) {
      showError($('inv-error'), 'تم إلغاء الحفظ — توجد فاتورة معلقة بقيم مختلفة. راجع القيم الأصلية أو تجاهل العملية المعلقة أولاً.');
      btn.disabled = false; btn.textContent = '✅ حفظ الفاتورة';
      return;
    }
    clearPendingOp(invFormKey);
  }
  const invRef = doc(db, isSales ? 'salesInvoices' : 'purchaseInvoices', formOpId);
  const invoiceNumber = formInvoiceNumber; // رقم الفاتورة الأصلي (من العملية المعلقة إن وُجدت)
  const payRef = t.paid > 0 ? doc(db, isSales ? 'salesPayments' : 'purchasePayments', 'pay-' + formOpId) : null;
  const formMarkerRef = markerRefFor(formOpId);
  // الصندوق يُضمَّن فقط إذا كان الدور يسمح (owner/manager/accountant).
  const formCashPending = t.paid > 0 && movesMoney(payMethod) && !canWriteMoneyBox();
  const box = (t.paid > 0 && movesMoney(payMethod) && canWriteMoneyBox()) ? await resolveMoneyBoxRef(payMethod) : null;
  // المخزون: نحلّ مراجع الأرصدة قبل المعاملة (قراءة فقط). إن لم يوجد
  // رصيد مسجل لمنتج ما، نرمي خطأً واضحاً ولا نبدأ المعاملة أصلاً.
  let formStockRefs = null;
  try {
    formStockRefs = await resolveStockBalanceRefs(invForm.lines.map((l) => l.product.id));
  } catch (err) {
    if (err && err.message && err.message.startsWith('NO_STOCK_BALANCE:')) {
      showError($('inv-error'), `لا يوجد رصيد مخزون مسجل لـ ${err.message.slice('NO_STOCK_BALANCE:'.length)} — اطلب من المالك تشغيل التهيئة (زر التهيئة في الإعدادات) لإنشاء سجل الرصيد أولاً. لم تُسجَّل الفاتورة.`);
    } else {
      showError($('inv-error'), firestoreErrorMessage(err) + ' — لم يُسجَّل أي شيء.');
    }
    btn.disabled = false; btn.textContent = '✅ حفظ الفاتورة';
    return;
  }
  try {
    const result = await runTransaction(db, async (tx) => {
      // فحص عدم التكرار عبر العلامة (لا نقرأ الفاتورة الغائبة مباشرة).
      // نرجع القيم المحفوظة حتى يعرضها المتصل (لا قيم قديمة بصمت).
      const formMarkerSnap = await tx.get(formMarkerRef);
      if (formMarkerSnap.exists()) {
        const existingInv = await tx.get(invRef);
        const d = existingInv.exists() ? existingInv.data() : {};
        return { alreadyApplied: true, saved: { invoiceNumber: d.invoiceNumber, totalPiasters: d.totalPiasters, paidPiasters: d.paidPiasters, cashEffect: d.cashEffect || null } };
      }
      const contactSnap = (contactId && t.remaining > 0) ? await tx.get(doc(db, isSales ? 'customers' : 'suppliers', contactId)) : null;
      const curBal = (contactSnap && contactSnap.exists()) ? Number(contactSnap.data().currentBalancePiasters || 0) : 0;
      let boxSnap = null;
      if (box) boxSnap = await tx.get(box.ref);
      // المخزون: نقرأ كل الأرصدة هنا — قبل أي كتابة. Firestore يشترط أن
      // تكون كل القراءات قبل كل الكتابات داخل المعاملة، وإلا رفضها
      // برسالة "transactions require all reads to be executed before
      // all writes". (revision 10: كانت القراءة بعد applyMoneyMovementTx
      // فرفضت المعاملة.)
      const formBalSnaps = {};
      for (const l of invForm.lines) {
        if (!formBalSnaps[l.product.id]) formBalSnaps[l.product.id] = await tx.get(formStockRefs[l.product.id]);
      }
      if (box) applyMoneyMovementTx(tx, box.ref, box.isBank, boxSnap, isSales ? 1 : -1, t.paid);
      tx.set(formMarkerRef, { orgId, opId: formOpId, kind: 'invoice', createdAt: serverTimestamp() });
      const base = {
        orgId, branchId, invoiceNumber, idempotencyKey: invRef.id,
        createdBy: me.uid, status: 'posted', date: dateTs, dueDate: dueTs,
        subtotalPiasters: t.subtotal, discountPiasters: t.discount, taxPiasters: t.tax,
        totalPiasters: t.total, paidPiasters: 0, remainingPiasters: t.remaining,
        paymentMethod: t.paid >= t.total ? payMethod : t.paid > 0 ? 'mixed' : 'credit',
        ...(formCashPending ? { cashEffect: 'pending' } : {}),
        notes, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      };
      if (isSales) {
        tx.set(invRef, { ...base, customerId: contactId });
        invForm.lines.forEach((l) => {
          const itemRef = doc(collection(db, 'salesInvoices', invRef.id, 'items'));
          tx.set(itemRef, {
            orgId, productId: l.product.id, productName_ar: l.product.name_ar,
            partNumber: l.product.partNumber || '', quantity: l.qty,
            unitPricePiasters: l.unitPrice, discountPiasters: 0,
            lineTotalPiasters: l.qty * l.unitPrice,
            costPricePiasters: Number(l.product.purchasePricePiasters || 0)
          });
          const movRef = doc(collection(db, 'stockMovements'));
          tx.set(movRef, {
            orgId, branchId, warehouseId: (warehouses[0] || {}).id || '',
            productId: l.product.id, type: 'sale_out', quantity: l.qty,
            referenceType: 'salesInvoice', referenceId: invRef.id, createdBy: me.uid,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
        });
      } else {
        tx.set(invRef, {
          ...base, supplierId: contactId, supplierInvoiceNumber: '',
          shippingPiasters: 0, extraExpensesPiasters: 0,
          items: invForm.lines.map((l) => ({
            productId: l.product.id, productName_ar: l.product.name_ar, partNumber: l.product.partNumber || '',
            quantity: l.qty, unitPricePiasters: l.unitPrice, lineTotalPiasters: l.qty * l.unitPrice,
            costPricePiasters: Number(l.product.purchasePricePiasters || 0)
          }))
        });
        invForm.lines.forEach((l) => {
          const movRef = doc(collection(db, 'stockMovements'));
          tx.set(movRef, {
            orgId, branchId, warehouseId: (warehouses[0] || {}).id || '',
            productId: l.product.id, type: 'purchase_in', quantity: l.qty,
            referenceType: 'purchaseInvoice', referenceId: invRef.id, createdBy: me.uid,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
          });
        });
      }
      // المخزون: تطبيق دلتا كل منتج في نفس المعاملة (ذري مع الفاتورة
      // والحركة). نجمع الكمية لكل منتج أولاً حتى لو تكرر في سطرين.
      // بيع: خصم (-qty)؛ شراء: إضافة (+qty). إن أصبح أي رصيد سالباً
      // تُلغى المعاملة كلها (INSUFFICIENT_STOCK).
      {
        const delta = {};
        for (const l of invForm.lines) delta[l.product.id] = (delta[l.product.id] || 0) + (isSales ? -l.qty : +l.qty);
        for (const [pid, d] of Object.entries(delta)) applyStockMovementTx(tx, formStockRefs[pid], formBalSnaps[pid], d);
      }
      // المدفوع الآن يُسجَّل كمستند دفعة حقيقي (في نفس المعاملة) لا كـ paidPiasters،
      // حتى يظهر في سجل الدفعات ويُشتق المتبقي منه بشكل صحيح. paidPiasters يبقى صفراً.
      // الفواتير القديمة ذات paidPiasters فقط (SI-20261125-739953 و SI-20261125-053797)
      // لا تُمسّ — المتبقي المشتق يحسبها أصلاً، وإنشاء دفعة لها سيضاعف الحساب.
      if (t.paid > 0) {
        tx.set(payRef, {
          orgId, branchId,
          ...(isSales
            ? { customerId: contactId, salesInvoiceId: invRef.id, receivedBy: me.uid }
            : { supplierId: contactId, purchaseInvoiceId: invRef.id, paidBy: me.uid }),
          amountPiasters: t.paid, paymentMethod: payMethod, date: dateTs,
          notes: 'دفعة عند إنشاء الفاتورة',
          ...(formCashPending ? { cashEffect: 'pending' } : {}),
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      }
      // رصيد الجهة يزيد بالمتبقي (مديونية جديدة) — ذرياً مع الفاتورة
      if (contactId && t.remaining > 0 && contactSnap && contactSnap.exists()) {
        tx.update(doc(db, isSales ? 'customers' : 'suppliers', contactId), { currentBalancePiasters: curBal + t.remaining, updatedAt: serverTimestamp() });
      }
      return { alreadyApplied: false };
    });
    clearPendingOp(invFormKey); // نجاح مؤكد — امسح العملية المعلقة
    let cashMsg = '';
    if (t.paid > 0 && box) {
      const dest = box.label;
      cashMsg = isSales ? `أُضيف ${fmtEGP(t.paid)} إلى «${dest}».` : `خُصم ${fmtEGP(t.paid)} من «${dest}».`;
    } else if (formCashPending) {
      cashMsg = 'ملاحظة: أثر الصندوق معلّق (cashEffect: pending) — يعتمد محاسب حركة الصندوق لاحقاً (دورك لا يسمح بالكتابة في الصندوق).';
    }
    await loadProducts();
    showToast(result.alreadyApplied
      ? `الفاتورة ${result.saved.invoiceNumber} محفوظة بالفعل — لم يُضف أي أثر مكرر. القيم المحفوظة: الإجمالي ${fmtEGP(result.saved.totalPiasters)}، المدفوع ${fmtEGP(result.saved.paidPiasters)}.${result.saved.cashEffect === 'pending' ? ' أثر الصندوق معلّق بانتظار محاسب.' : ''}`
      : `✅ تم حفظ الفاتورة ${invoiceNumber}.${cashMsg ? ' ' + cashMsg : ''}`);
    invForm = null;
    await renderInvoiceDetail(isSales ? 'sales' : 'purchase', invRef.id);
  } catch (err) {
    // revision 11, Issue 1: فشل حتمي — امسح العملية المعلقة حتى لا تحظر
    // الفاتورة التالية بتحذير مضلل.
    if (isDefinitiveSaveFailure(err)) clearPendingOp(invFormKey);
    if (err && err.message === 'INSUFFICIENT_FUNDS') showError($('inv-error'), 'رصيد الصندوق/البنك لا يكفي لخصم هذا المبلغ — لم تُسجَّل الفاتورة. اختر طريقة دفع أخرى أو قلّل المبلغ.');
    else if (err && err.message === 'INSUFFICIENT_STOCK') showError($('inv-error'), 'المخزون لا يكفي — الكمية المطلوبة أكبر من الرصيد المتاح لأحد الأصناف. لم تُسجَّل الفاتورة.');
    else if (err && err.code === 'permission-denied') showError($('inv-error'), ((roleDeniedMessage(isSales ? ['owner', 'manager', 'sales'] : ['owner', 'manager', 'inventory', 'accountant'], isSales ? 'إنشاء فاتورة مبيعات' : 'إنشاء فاتورة مشتريات') || firestoreErrorMessage(err)) + ' — لم يُسجَّل أي شيء.'));
    else showError($('inv-error'), firestoreErrorMessage(err) + ' — لم يُسجَّل أي شيء، ويمكن إعادة المحاولة بأمان.');
    btn.disabled = false; btn.textContent = '✅ حفظ الفاتورة';
  }
}

// ============================================================================
// عرض فاتورة + طباعتها (A4)
// ============================================================================
async function loadInvoiceDetail(kind, invoiceId) {
  const isSales = kind === 'sales';
  const invSnap = await getDoc(doc(db, isSales ? 'salesInvoices' : 'purchaseInvoices', invoiceId));
  if (!invSnap.exists()) return null;
  const inv = { id: invSnap.id, ...invSnap.data() };
  let items = [];
  if (isSales) {
    const snap = await getDocs(collection(db, 'salesInvoices', invoiceId, 'items'));
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    items = (inv.items || []).map((it, i) => ({ id: 'it_' + i, ...it }));
  }
  const contactId = isSales ? inv.customerId : inv.supplierId;
  let contact = null;
  if (contactId) {
    const cs = await getDoc(doc(db, isSales ? 'customers' : 'suppliers', contactId));
    if (cs.exists()) contact = { id: cs.id, ...cs.data() };
  }
  const payments = (await loadCollection(isSales ? 'salesPayments' : 'purchasePayments'))
    .filter((p) => (isSales ? p.salesInvoiceId : p.purchaseInvoiceId) === invoiceId)
    .sort((a, b) => tsToDate(a.date || a.createdAt) - tsToDate(b.date || b.createdAt));
  const payByInv = { [invoiceId]: payments.reduce((a, p) => a + Number(p.amountPiasters || 0), 0) };
  return { inv, items, contact, payments, remaining: remainingOf(inv, payByInv), paid: paidOf(inv, payByInv) };
}

function invoiceSheetHTML(kind, inv, items, contact, paid, remaining) {
  const isSales = kind === 'sales';
  const st = payStatusOf(Number(inv.totalPiasters || 0), paid);
  const whoLabel = isSales ? 'العميل' : 'المورد';
  return `
  <div class="inv-sheet" dir="rtl">
    <div class="inv-head">
      <div class="inv-brand">
        <div class="inv-logo">الفلكي <span>لقطع غيار السيارات</span></div>
        <div class="inv-brand-en" dir="ltr">Al-Falaky Auto Spare Parts</div>
      </div>
      <div class="inv-title">${inv.isAdjustment ? 'قيد تسوية' : inv.isManualDebt ? 'مديونية يدوية' : (isSales ? 'فاتورة مبيعات' : 'فاتورة مشتريات')}</div>
    </div>
    <div class="inv-meta">
      <div><span>رقم الفاتورة:</span> <b dir="ltr">${esc(inv.invoiceNumber || inv.id)}</b></div>
      <div><span>التاريخ:</span> <b>${tsToDate(inv.date || inv.createdAt).toLocaleDateString('ar-EG')}</b></div>
      <div><span>الاستحقاق:</span> <b>${dueDateOf(inv).toLocaleDateString('ar-EG')}</b></div>
      <div><span>الفرع:</span> <b>${esc(branchName(inv.branchId))}</b></div>
      <div><span>حالة السداد:</span> <b><span class="badge ${payStatusBadgeCls(st)}">${payStatusLabel(st)}</span></b></div>
    </div>
    <div class="inv-contact">
      <div><span>${whoLabel}:</span> <b>${esc(contact ? contact.name_ar : (isSales ? 'عميل نقدي' : '—'))}</b></div>
      <div><span>الهاتف:</span> <b dir="ltr">${esc(contact ? (contact.phone || '—') : '—')}</b></div>
      <div><span>العنوان:</span> <b>${esc(contact ? (contact.address_ar || '—') : '—')}</b></div>
    </div>
    ${inv.isManualDebt ? `<div class="inv-notes">مديونية مسجلة يدوياً (بدون بنود منتجات) — البيان: <b>${esc(inv.manualReason || '—')}</b>${inv.manualDetails ? ` — التفاصيل: <b>${esc(inv.manualDetails)}</b>` : ''}${inv.isAdjustment ? ` — تعديل للمبلغ من <b>${fmtEGP(inv.oldRemainingPiasters)}</b> إلى <b>${fmtEGP(inv.newRemainingPiasters)}</b>` : ''}</div>` : `
    <table class="inv-table items-table">
      <tr><th>#</th><th>الصنف</th><th>رقم القطعة</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr>
      ${items.map((it, i) => `<tr>
        <td>${i + 1}</td><td>${esc(it.productName_ar || it.productName || '—').replace(/ /g, ' ')}</td>
        <td dir="ltr">${esc(it.partNumber || '—')}</td>
        <td class="num">${fmtNum(it.quantity)}</td>
        <td class="num">${fmtEGP(it.unitPricePiasters)}</td>
        <td class="num">${fmtEGP(it.lineTotalPiasters)}</td></tr>`).join('')}
    </table>`}
    <div class="inv-totals">
      <div><span>الإجمالي الفرعي:</span> <b>${fmtEGP(inv.subtotalPiasters)}</b></div>
      ${Number(inv.discountPiasters || 0) ? `<div><span>الخصم:</span> <b>− ${fmtEGP(inv.discountPiasters)}</b></div>` : ''}
      ${Number(inv.taxPiasters || 0) ? `<div><span>الضريبة:</span> <b>+ ${fmtEGP(inv.taxPiasters)}</b></div>` : ''}
      <div class="grand"><span>الإجمالي العام:</span> <b>${fmtEGP(inv.totalPiasters)}</b></div>
      <div><span>المدفوع:</span> <b>${fmtEGP(paid)}</b></div>
      <div class="remain"><span>المتبقي:</span> <b>${fmtEGP(remaining)}</b></div>
    </div>
    ${inv.notes ? `<div class="inv-notes">ملاحظات: ${esc(inv.notes)}</div>` : ''}
    <div class="inv-foot">
      <div>شكراً لتعاملكم مع الفلكي لقطع غيار السيارات</div>
      <div class="inv-sign"><span>توقيع المستلم: ....................</span><span>توقيع البائع: ....................</span></div>
    </div>
  </div>`;
}

async function renderInvoiceDetail(kind, invoiceId) {
  const isSales = kind === 'sales';
  const data = await loadInvoiceDetail(kind, invoiceId);
  if (!data) { $('page').innerHTML = emptyState('تعذّر العثور على هذه الفاتورة.'); return; }
  const { inv, items, contact, payments, remaining, paid } = data;
  const st = payStatusOf(Number(inv.totalPiasters || 0), paid);
  const contactId = isSales ? inv.customerId : inv.supplierId;
  currentPage = 'invoice-detail';
  document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.classList.remove('active'));
  $('page').innerHTML = `
    <h2 class="page-title">🧾 ${isSales ? 'فاتورة مبيعات' : 'فاتورة مشتريات'} ${esc(inv.invoiceNumber || '')}</h2>
    <p><button class="btn small secondary" id="inv-detail-back">← عودة</button></p>
    <div class="toolbar">
      <button class="btn" id="inv-print-btn" style="width:auto">🖨️ طباعة الفاتورة (A4)</button>
      <button class="btn" id="inv-pdf-btn" style="width:auto">⬇️ تحميل PDF</button>
      ${remaining > 0 && contactId && (isSales ? ['owner', 'manager', 'sales', 'accountant'] : ['owner', 'manager', 'accountant']).includes(me.role) ? `<button class="btn" id="inv-pay-btn" style="width:auto">💰 تسديد جزء (المتبقي ${fmtEGP(remaining)})</button>` : ''}
      ${isOwner() ? `<button class="btn danger" id="inv-delete-btn" style="width:auto">🗑️ حذف الفاتورة</button>` : ''}
    </div>
    ${invoiceSheetHTML(kind, inv, items, contact, paid, remaining)}
    <div id="pay-form-area"></div>
    <div class="card" style="margin-top:14px"><h3>سجل الدفعات على هذه الفاتورة</h3>
    ${payments.length ? `<table><tr><th>التاريخ</th><th>طريقة الدفع</th><th>المبلغ</th><th>ملاحظات</th></tr>
      ${payments.map((p) => `<tr><td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td>
      <td>${payMethodLabel(p.paymentMethod)}</td><td class="num">${fmtEGP(p.amountPiasters)}</td><td>${esc(p.notes || '')}</td></tr>`).join('')}</table>`
    : emptyState('لا توجد دفعات لاحقة مسجلة على هذه الفاتورة.')}
    <p class="note">حالة السداد: <span class="badge ${payStatusBadgeCls(st)}">${payStatusLabel(st)}</span> — المدفوع ${fmtEGP(paid)} من إجمالي ${fmtEGP(inv.totalPiasters)}، والمتبقي ${fmtEGP(remaining)}.</p></div>`;
  $('inv-detail-back').addEventListener('click', () => go(isSales ? 'sales' : 'purchases'));
  $('inv-print-btn').addEventListener('click', () => printInvoice(kind, invoiceId));
  $('inv-pdf-btn').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true; b.textContent = '⏳ جارٍ إنشاء PDF...';
    downloadInvoicePDF(kind, invoiceId).finally(() => { b.disabled = false; b.textContent = '⬇️ تحميل PDF'; });
  });
  const payBtn = $('inv-pay-btn');
  if (payBtn) payBtn.addEventListener('click', () => {
    if (!canRecordPayment(isSales ? 'customers' : 'suppliers')) {
      alert('دورك الحالي لا يسمح بتسجيل دفعات ' + (isSales ? 'العملاء' : 'الموردين') + '.');
      return;
    }
    openPayForm(isSales ? 'customers' : 'suppliers', contact, inv, remaining, () => renderInvoiceDetail(kind, invoiceId));
  });
  // revision 11: حذف الفاتورة (المالك فقط) — عكس ثم حذف في معاملة واحدة.
  const delBtn = $('inv-delete-btn');
  if (delBtn) delBtn.addEventListener('click', () => deleteInvoice(kind, inv));
}

function printArea() {
  if (typeof window.print === 'function') window.print();
  else alert('الطباعة غير متاحة في هذا المتصفح — افتح الرابط في Chrome ثم اطبع.');
}
function printInvoice(kind, invoiceId) {
  // ورقة الفاتورة معروضة أصلاً على الصفحة — نطبعها مباشرة من غير إعادة تحميل
  // (التحميل غير المتزامن بلا catch كان يفشل بصمت، فلا نافذة ولا رسالة)
  const sheet = document.querySelector('#page .inv-sheet');
  const area = $('print-area');
  if (sheet) {
    area.innerHTML = sheet.outerHTML;
    printArea();
    return;
  }
  loadInvoiceDetail(kind, invoiceId).then((data) => {
    if (!data) { alert('تعذّر العثور على هذه الفاتورة.'); return; }
    const { inv, items, contact, paid, remaining } = data;
    area.innerHTML = invoiceSheetHTML(kind, inv, items, contact, paid, remaining);
    printArea();
  }).catch((err) => { alert('تعذّرت الطباعة: ' + firestoreErrorMessage(err)); });
}

function statementHTML(kind, contact, openList, myPayments, invById) {
  const isCust = kind === 'customers';
  const totalDebt = openList.reduce((a, x) => a + x.remaining, 0);
  const totalPaid = myPayments.reduce((a, p) => a + Number(p.amountPiasters || 0), 0);
  return `
  <div class="inv-sheet" dir="rtl">
    <div class="inv-head">
      <div class="inv-brand">
        <div class="inv-logo">الفلكي <span>لقطع غيار السيارات</span></div>
        <div class="inv-brand-en" dir="ltr">Al-Falaky Auto Spare Parts</div>
      </div>
      <div class="inv-title">كشف حساب ${isCust ? 'عميل' : 'مورد'}</div>
    </div>
    <div class="inv-meta">
      <div><span>${isCust ? 'العميل' : 'المورد'}:</span> <b>${esc(contact.name_ar)}</b></div>
      <div><span>الهاتف:</span> <b dir="ltr">${esc(contact.phone || '—')}</b></div>
      <div><span>التاريخ:</span> <b>${new Date().toLocaleDateString('ar-EG')}</b></div>
      <div><span>المديونية المفتوحة:</span> <b>${fmtEGP(totalDebt)}</b></div>
    </div>
    <h3 style="color:#111;margin:14px 0 8px">الفواتير المفتوحة</h3>
    ${openList.length ? `<table class="inv-table stmt-table"><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>الاستحقاق</th><th>التفاصيل</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th></tr>
      ${openList.map(({ inv, remaining, paid, details }) => `<tr>
        <td dir="ltr">${wbrHyphens(esc(inv.invoiceNumber || inv.id))}</td>
        <td>${tsToDate(inv.date || inv.createdAt).toLocaleDateString('ar-EG')}</td>
        <td>${dueDateOf(inv).toLocaleDateString('ar-EG')}</td>
        <td style="text-align:right">${esc(details || (inv.isManualDebt ? (inv.manualDetails || inv.manualReason || '') : ''))}</td>
        <td class="num">${fmtEGP(inv.totalPiasters)}</td><td class="num">${fmtEGP(paid)}</td><td class="num">${fmtEGP(remaining)}</td></tr>`).join('')}</table>`
    : '<p>لا توجد فواتير مفتوحة.</p>'}
    <h3 style="color:#111;margin:14px 0 8px">سجل الدفعات</h3>
    ${myPayments.length ? `<table class="inv-table"><tr><th>التاريخ</th><th>الفاتورة</th><th>طريقة الدفع</th><th>المبلغ</th><th>ملاحظات</th></tr>
      ${myPayments.map((p) => {
        const invId = isCust ? p.salesInvoiceId : p.purchaseInvoiceId;
        const inv = invId ? invById[invId] : null;
        return `<tr><td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td>
        <td dir="ltr">${inv ? wbrHyphens(esc(inv.invoiceNumber || inv.id)) : 'على الحساب'}</td>
        <td>${payMethodLabel(p.paymentMethod)}</td><td class="num">${fmtEGP(p.amountPiasters)}</td><td>${esc(p.notes || '')}</td></tr>`;
      }).join('')}</table>
      <div class="inv-totals"><div><span>إجمالي الدفعات:</span> <b>${fmtEGP(totalPaid)}</b></div></div>`
    : '<p>لا توجد دفعات مسجلة.</p>'}
    <div class="inv-foot"><div>كشف حساب صادر من نظام الفلكي لإدارة قطع غيار السيارات</div></div>
  </div>`;
}
function printStatement(kind, contact, openList, myPayments, invById) {
  const area = $('print-area');
  area.innerHTML = statementHTML(kind, contact, openList, myPayments, invById);
  printArea();
}

// ===========================================================================
// تنزيل PDF حقيقي (html2pdf.js من CDN — لا مفاتيح ولا بيانات خاصة)
// الفكرة: تصوير ورقة الفاتورة/كشف الحساب كما تظهر على الشاشة (html2canvas)،
// فيحافظ على تشكيل العربية واتجاه RTL من غير خطوط PDF عربية. قراءة فقط —
// لا يغيّر أي بيانات أو أرصدة. الملف يتنزل باسم رقم الفاتورة.
// ===========================================================================
// حدود الحبر في اللوحة: أين يبدأ وينتهي المحتوى غير الأبيض (لكشف القصّ قبل الحفظ)
function canvasInkBox(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (count === 0) return { count: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  return { count, x0, y0, x1, y1 };
}
function canvasHasContent(canvas) {
  const box = canvasInkBox(canvas);
  return !!box && box.count >= 500;
}
// html2canvas يسقط المسافات بين الكلمات العربية عند إعادة ترتيب الكلمات RTL —
// نستبدل المسافة العادية بمسافة غير فاصلة (\u00A0) في نصوص ورقة الـ PDF
// (الحل المتعارف عليه لهذه المشكلة)، فتُرسَم الكلمات متصلة بمسافة ظاهرة.
// مهم: لا نمسّ نصوص الجداول — المسافة غير الفاصلة تجعل النص كلمة واحدة
// لا تنكسر، فينهار تخطيط الأعمدة الثابتة (تصبح متساوية ويُقصّ رقم الفاتورة).
// عناوين الجداول وأسماء المنتجات تُكتب بمسافة غير فاصلة أصلاً عند بناء الـ HTML.
function fixArabicSpaces(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (n.nodeValue.includes(' ') && !(n.parentElement && n.parentElement.closest('table'))) n.nodeValue = n.nodeValue.replace(/ /g, '\u00A0');
  }
}
// فرصة كسر بعد كل شرطة في رقم فاتورة طويل، حتى يلتف داخل عمود ضيق في الـ PDF
// (html2canvas لا يكسر الرقم الطويل بنفسه) — بلا أثر على الشاشة إن لم يحتج الكسر.
function wbrHyphens(s) { return String(s == null ? '' : s).replace(/-/g, '-<wbr>'); }
// ===== ترقيم PDF يدوي (jsPDF): مستند يقارب صفحة واحدة يُضغَط لصفحة واحدة؛
// وإلا تُوضع الكتل كاملة (.inv-sheet) على الصفحات، ولا تُقسَّم كتلة إلا إذا
// كانت هي نفسها أطول من الصفحة. لا يترك صفحة أخيرة شبه فارغة أبداً.
// blocks: [{top, h}] بالبكسل داخل اللوحة (top بالنسبة لأعلى اللوحة).
// breaks: إحداثيات y بالبكسل (مرتبة) يجوز القطع عندها — أسفل كل صف جدول
// وأعلى كل كتلة — فيلتصق القطع بأقرب حد صف، فلا يُقطَع صف جدول أبداً
// ولا يبقى سطر وحيد وحده على صفحة. =====
function pdfLayout(canvas, blocks, breaks) {
  const PAGE_W = 210, PAGE_H = 297;
  const totalHmm = (canvas.height / canvas.width) * PAGE_W;
  let scale = 1;
  if (totalHmm <= PAGE_H) scale = 1;
  else if (totalHmm <= PAGE_H * 1.18) scale = PAGE_H / totalHmm;
  else {
    let p = Math.ceil(totalHmm / PAGE_H);
    const lastH = totalHmm - (p - 1) * PAGE_H;
    if (lastH < 30) { p -= 1; scale = (p * PAGE_H) / totalHmm; }
  }
  const imgW = PAGE_W * scale, imgH = totalHmm * scale;
  const k = imgW / canvas.width; // مم لكل بكسل في اللوحة
  const x0 = (PAGE_W - imgW) / 2;
  // أقرب حد قطع آمن عند y أو تحته (بالبكسل)؛ null إن لم يوجد حد صالح
  // (يجب أن يترك 20مم على الأقل من المحتوى في الصفحة الحالية).
  function snapBreak(y) {
    if (!breaks || !breaks.length) return y;
    const minY = 20 / k;
    let best = null;
    for (const b of breaks) { if (b <= y && b >= minY) best = b; else if (b > y) break; }
    return best === null ? y : best;
  }
  const pages = [[]];
  if (imgH <= PAGE_H) {
    pages[0].push({ sx: 0, sy: 0, sw: canvas.width, sh: canvas.height, dx: x0, dy: 0, dw: imgW, dh: imgH });
  } else {
    let page = 0, yCur = 0;
    for (const b of blocks) {
      let remPx = b.h, srcY = b.top;
      while (remPx > 0) {
        const spaceMm = PAGE_H - yCur;
        const spacePx = spaceMm / k;
        if (remPx <= spacePx) {
          pages[page].push({ sx: 0, sy: Math.round(srcY), sw: canvas.width, sh: Math.round(remPx), dx: x0, dy: yCur, dw: imgW, dh: remPx * k });
          yCur += remPx * k; remPx = 0;
        } else if (spaceMm >= 20) {
          // قسّم الكتلة: ألصق القطع بحد صف جدول حتى لا يُقطَع صف
          const cutY = snapBreak(srcY + spacePx);
          const takePx = Math.max(1, Math.round(cutY - srcY));
          pages[page].push({ sx: 0, sy: Math.round(srcY), sw: canvas.width, sh: takePx, dx: x0, dy: yCur, dw: imgW, dh: takePx * k });
          srcY += takePx; remPx -= takePx;
          pages.push([]); page++; yCur = 0;
        } else {
          pages.push([]); page++; yCur = 0;
        }
      }
    }
  }
  return { pages, imgW, imgH, scale };
}
async function downloadElementAsPDF(html, filename) {
  if (typeof html2pdf === 'undefined') {
    alert('تعذّر تحميل مكتبة PDF — تأكّد من الاتصال بالإنترنت ثم أعد المحاولة.');
    return;
  }
  // الغلاف LTR صريح يحمل ورقة RTL بعرض ثابت 794px — لا نعتمد على تخطيط
  // تدفق RTL داخل استنساخ html2canvas (عرض التخطيط فيه لم يكن 794px،
  // فكان الحبر يظهر في مكان غريب والمحتوى يُقصّ من اليسار)
  const wrap = document.createElement('div');
  wrap.setAttribute('dir', 'ltr');
  wrap.style.cssText = 'position:absolute;left:0;top:0;width:794px;z-index:-1;';
  const host = document.createElement('div');
  host.className = 'pdf-doc';
  host.setAttribute('dir', 'rtl');
  host.style.cssText = 'width:794px;max-width:794px;background:#fff;';
  host.innerHTML = html;
  fixArabicSpaces(host);
  wrap.appendChild(host);
  document.body.appendChild(wrap);
  // انتظر frame بعد الإضافة حتى يستقر التخطيط والخطوط قبل التصوير
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const opt = {
    margin: 0,
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0, windowWidth: 794, x: 0, y: 0, width: 794 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    // لا تقطع صف جدول أو مجموع أو تذييل بين صفحتين
    pagebreak: { mode: ['css', 'legacy'], avoid: ['.inv-table tr', '.inv-totals', '.inv-foot', '.pdf-doc h3'] }
  };
  try {
    // تحقق قبل الحفظ: صوّر أولاً بنفس عامل html2pdf وتأكد أن اللوحة فيها محتوى
    // وأن الحبر يمتد عبر عرض الصفحة (وإلا فالمحتوى مقصوص)
    const worker = html2pdf().set(opt).from(host).toCanvas();
    const canvas = await worker.get('canvas');
    const box = canvasInkBox(canvas);
    const w = canvas ? canvas.width : 0;
    const contentOk = box && box.count >= 500;
    const fitsWidth = box && box.x0 >= 4 && box.x1 <= w - 5 && box.x1 >= w * 0.8;
    if (!contentOk || !fitsWidth) {
      alert('تعذّر تصوير ورقة الفاتورة بشكل كامل — المحتوى خارج حدود الصفحة. حاول مرة أخرى، ولو استمرت المشكلة أعد تحميل الصفحة.');
      return;
    }
    // ترقيم يدوي بـ jsPDF (يضغط المستند القريب من صفحة واحدة في صفحة واحدة
    // فلا تبقى صفحة ثانية فارغة، ويبقي التذييل مع المحتوى قدر الإمكان).
    // مهم: قِس حدود الكتل (.inv-sheet) هنا قبل إزالة الغلاف — فبعد فصله يصبح
    // host.offsetHeight صفراً فينفجر معامل التحويل وتدور الحلقة للأبد.
    if (window.jspdf && window.jspdf.jsPDF) {
      const hostRect = host.getBoundingClientRect();
      const fy = canvas.height / host.offsetHeight;
      let blocks = [...host.querySelectorAll(':scope > .inv-sheet')].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round((r.top - hostRect.top) * fy), h: Math.round(r.height * fy) };
      });
      if (!blocks.length) blocks = [{ top: 0, h: canvas.height }];
      // حدود قطع آمنة: أسفل كل صف جدول وأعلى كل كتلة — حتى لا يُقطَع صف
      const breaks = [];
      host.querySelectorAll('.inv-table tr').forEach((tr) => {
        const r = tr.getBoundingClientRect();
        breaks.push(Math.round((r.bottom - hostRect.top) * fy));
      });
      blocks.forEach((b) => breaks.push(b.top));
      breaks.sort((a, b) => a - b);
      const layout = pdfLayout(canvas, blocks, breaks);
      const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      layout.pages.forEach((ops, pi) => {
        if (pi > 0) pdf.addPage();
        for (const op of ops) {
          const tmp = document.createElement('canvas');
          tmp.width = op.sw; tmp.height = op.sh;
          tmp.getContext('2d').drawImage(canvas, op.sx, op.sy, op.sw, op.sh, 0, 0, op.sw, op.sh);
          pdf.addImage(tmp.toDataURL('image/jpeg', 0.98), 'JPEG', op.dx, op.dy, op.dw, op.dh);
        }
      });
      pdf.save(filename);
    } else {
      await worker.toPdf().save();
    }
  } catch (err) {
    alert('تعذّر إنشاء ملف PDF: ' + (err && err.message ? err.message : 'خطأ غير معروف'));
  } finally {
    wrap.remove();
  }
}
async function downloadInvoicePDF(kind, invoiceId) {
  let data;
  try { data = await loadInvoiceDetail(kind, invoiceId); }
  catch (err) { alert('تعذّر تحميل الفاتورة: ' + firestoreErrorMessage(err)); return; }
  if (!data) { alert('تعذّر العثور على هذه الفاتورة.'); return; }
  const { inv, items, contact, payments, remaining, paid } = data;
  const st = payStatusOf(Number(inv.totalPiasters || 0), paid);
  // نفس ورقة الفاتورة المعروضة + سجل الدفعات وحالة السداد (كما على الشاشة)
  const html = `${invoiceSheetHTML(kind, inv, items, contact, paid, remaining)}
  <div class="inv-sheet" dir="rtl" style="margin-top:14px">
    <h3 style="color:#111;margin:0 0 8px">سجل الدفعات على هذه الفاتورة</h3>
    ${payments.length ? `<table class="inv-table"><tr><th>التاريخ</th><th>طريقة الدفع</th><th>المبلغ</th><th>ملاحظات</th></tr>
      ${payments.map((p) => `<tr><td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td>
      <td>${payMethodLabel(p.paymentMethod)}</td><td class="num">${fmtEGP(p.amountPiasters)}</td><td>${esc(p.notes || '')}</td></tr>`).join('')}</table>`
    : '<p>لا توجد دفعات لاحقة مسجلة على هذه الفاتورة.</p>'}
    <p style="color:#111;margin:12px 0 0">حالة السداد: <b>${payStatusLabel(st)}</b>، المدفوع ${fmtEGP(paid)} من إجمالي ${fmtEGP(inv.totalPiasters)}، والمتبقي ${fmtEGP(remaining)}.</p>
  </div>`;
  return downloadElementAsPDF(html, `${inv.invoiceNumber || inv.id}.pdf`);
}
async function downloadStatementPDF(kind, contact, openList, myPayments, invById) {
  const name = String(contact.name_ar || 'كشف-حساب').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return downloadElementAsPDF(statementHTML(kind, contact, openList, myPayments, invById), `كشف-حساب-${name}-${date}.pdf`);
}
