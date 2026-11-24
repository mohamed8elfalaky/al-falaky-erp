// ============================================================================
// Al-Falaky Smart ERP — GitHub Pages snapshot (static, no build step)
// الفلكي لقطع غيار السيارات
// ----------------------------------------------------------------------------
// • القفل الوحيد هو Firebase Auth — لا يوجد أي باسورد مشترك في هذا الكود.
// • كل الأرقام تأتي من استعلامات Firestore الحية — لا أرقام مثال مُضمّنة.
// • الفلوس بالقرش (integer piasters) في Firestore، وتُعرض بالجنيه (÷100).
// • المخزون لا يُكتب مباشرة: البيع يكتب فاتورة + بنود + حركات مخزون،
//   ورصيد stockBalances يُحدَّث من الخادم الموثوق / Cloud Function.
// ============================================================================
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, limit,
  addDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp
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
  if (err && err.code === 'permission-denied') {
    return 'رفضت قواعد Firestore الوصول — حسابك يحتاج تصاريح (orgId / role / branchIds). '
      + 'يضبطها المالك بسكربت set-custom-claims.js ثم تسجّل خروج ودخول من جديد.';
  }
  return (err && err.message) || 'خطأ غير متوقع أثناء قراءة البيانات.';
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
      role: claims.role || profile.role || 'sales',
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
    await loadLookups();
    buildNav();
    await go('dashboard');
  } catch (err) {
    showError($('login-error'), firestoreErrorMessage(err));
    $('login-screen').classList.remove('hidden');
  }
});

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
  { id: 'reports',    label: 'التقارير والتحليلات', ico: '📊', ownerOnly: true },
  { id: 'customers',  label: 'إدارة العملاء',   ico: '👥', ownerOnly: false },
  { id: 'suppliers',  label: 'إدارة الموردين',  ico: '🤝', ownerOnly: false },
  { id: 'branches',   label: 'إدارة الفروع',    ico: '📍', ownerOnly: true  },
  { id: 'employees',  label: 'إدارة الموظفين',  ico: '👤', ownerOnly: true  },
  { id: 'settings',   label: 'الإعدادات',      ico: '⚙️', ownerOnly: true  },
  { id: 'help',       label: 'المساعدة والدعم', ico: '❓', ownerOnly: false }
];
const NAV_EN = {
  dashboard: 'Dashboard', sales: 'Sales', purchases: 'Purchases', products: 'Products',
  inventory: 'Inventory', accounts: 'Accounts', reports: 'Reports & Analytics',
  customers: 'Customers', suppliers: 'Suppliers', branches: 'Branches',
  employees: 'Employees', settings: 'Settings', help: 'Help & Support'
};
const ALL_INTERFACES = ['dashboard', 'sales', 'purchases', 'products', 'inventory', 'customers', 'suppliers'];

function visibleNav() {
  if (isOwner()) return NAV;
  // الموظف: فقط الواجهات المكتوبة في مستند users الخاص به
  const allowed = new Set(me.interfaces || ALL_INTERFACES);
  return NAV.filter((n) => n.id === 'dashboard' || n.id === 'help' || allowed.has(n.id));
}
function canSee(page) {
  if (isOwner()) return true;
  if (page === 'dashboard' || page === 'help' || page === 'ai') return true;
  return (me.interfaces || ALL_INTERFACES).includes(page);
}
function buildNav() {
  $('main-nav').innerHTML = visibleNav().map((n) =>
    `<button class="nav-item" data-page="${n.id}"><span class="ico">${n.ico}</span> ${uiLang === 'en' ? (NAV_EN[n.id] || n.label) : n.label}</button>`).join('');
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.page)));
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
$('ai-start-btn').addEventListener('click', () => go('ai'));
$('bell-btn').addEventListener('click', () => { renderNotifDropdown(); $('notif-dropdown').classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  const dd = $('notif-dropdown');
  if (dd && !dd.classList.contains('hidden') && !e.target.closest('.bell-wrap')) dd.classList.add('hidden');
});

async function go(page) {
  if (!canSee(page)) { $('page').innerHTML = emptyState('ليس لديك صلاحية لعرض هذه الصفحة.'); return; }
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === page));
  const renderers = { dashboard: renderDashboard, sales: renderPOS, purchases: renderPurchases,
    products: renderProducts, inventory: renderInventory, accounts: renderAccounts, reports: renderReports,
    customers: () => renderContacts('customers'), suppliers: () => renderContacts('suppliers'),
    branches: renderBranches, employees: renderEmployees, settings: renderSettings,
    ai: renderAI, help: renderHelp };
  $('page').innerHTML = '<div class="empty">جارٍ تحميل البيانات من Firestore...</div>';
  try { await renderers[page](); }
  catch (err) { $('page').innerHTML = `<div class="error show">${esc(firestoreErrorMessage(err))}</div>`; }
}

// بيانات مرجعية: فروع/مخازن/تصنيفات/علامات (للقوائم المنسدلة)
async function loadLookups() {
  const [b, w, c, br, s] = await Promise.all([
    getDocs(query(collection(db, 'branches'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'warehouses'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'categories'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'brands'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'suppliers'), where('orgId', '==', orgId), limit(200)))
  ]);
  branches = b.docs.map((d) => ({ id: d.id, ...d.data() }));
  warehouses = w.docs.map((d) => ({ id: d.id, ...d.data() }));
  categories = c.docs.map((d) => ({ id: d.id, ...d.data() }));
  brands = br.docs.map((d) => ({ id: d.id, ...d.data() }));
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
async function renderDashboard() {
  const [sales, purchases, customers, bals] = await Promise.all([
    loadCollection('salesInvoices'),
    loadCollection('purchaseInvoices'),
    loadCollection('customers'),
    loadCollection('stockBalances')
  ]);
  await loadProducts();
  const posted = sales.filter((s) => s.status === 'posted');
  const postedPurchases = purchases.filter((p) => p.status === 'posted');
  const totalSales = posted.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const totalPurchases = postedPurchases.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const monthSum = (list, y, m) => list.filter((s) => { const t = tsToDate(s.date || s.createdAt); return t.getFullYear() === y && t.getMonth() === m; })
    .reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const salesCur = monthSum(posted, now.getFullYear(), now.getMonth());
  const salesPrev = monthSum(posted, prevMonth.getFullYear(), prevMonth.getMonth());
  const purchCur = monthSum(postedPurchases, now.getFullYear(), now.getMonth());
  const purchPrev = monthSum(postedPurchases, prevMonth.getFullYear(), prevMonth.getMonth());
  // الربح = الإيراد − تكلفة البضاعة المباعة (من بنود آخر 60 فاتورة)، وحساب التكلفة حسب الشهر
  const cogsByMonth = {};
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    const k = monthKey(tsToDate(inv.date || inv.createdAt));
    items.forEach((it) => { const d = it.data(); cogsByMonth[k] = (cogsByMonth[k] || 0) + Number(d.costPricePiasters || 0) * Number(d.quantity || 0); });
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

  // أكثر المنتجات مبيعاً (من بنود آخر 60 فاتورة)
  const soldQty = {};
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    items.forEach((it) => { const d = it.data(); soldQty[d.productId] = (soldQty[d.productId] || 0) + Number(d.quantity || 0); });
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
    salesByMonth.push(monthSum(posted, d.getFullYear(), d.getMonth()) / 100);
    purchByMonth.push(monthSum(postedPurchases, d.getFullYear(), d.getMonth()) / 100);
  }
  // مبيعات حسب الفئة (من بنود الفواتير)
  const catTotals = {};
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    items.forEach((it) => { const d = it.data(); const cat = categoryName((prodById[d.productId] || {}).categoryId);
      catTotals[cat] = (catTotals[cat] || 0) + Number(d.lineTotalPiasters || 0); });
  }
  const catEntries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const catShares = shares100(catEntries.map(([, v]) => v)); // نسب صحيحة مجموعها 100
  const catColors = ['#2f81f7', '#f0883e', '#3fb950', '#a371f7', '#8b98a9', '#39c5cf'];
  // أداء الفروع (حسب فلتر المدة)
  const branchTotals = {};
  posted.forEach((s) => {
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
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(inventoryValue)}<span class="unit">ج.م</span></div><div class="label">قيمة المخزون الإجمالية</div><div class="delta flat">—</div></div><div class="ico">📦</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(totalPurchases)}<span class="unit">ج.م</span></div><div class="label">إجمالي المشتريات</div><div class="delta ${dPurch.cls}">${dPurch.text}</div></div><div class="ico">🤝</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(totalSales)}<span class="unit">ج.م</span></div><div class="label">إجمالي المبيعات</div><div class="delta ${dSales.cls}">${dSales.text}</div></div><div class="ico">🛒</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${fmtEGPNum(profit)}<span class="unit">ج.م</span></div><div class="label">صافي الربح</div><div class="delta ${dProfit.cls}">${dProfit.text}</div></div><div class="ico">📈</div></div>
      <div class="card kpi"><div class="kpi-text"><div class="value">${Number(activeCustomers).toLocaleString('en-US')}</div><div class="label">عملاء نشطين</div><div class="delta flat">—</div></div><div class="ico">👥</div></div>
    </div>
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
  $('alerts-all-btn').addEventListener('click', (e) => {
    const more = document.querySelector('.alerts-more');
    if (more) { more.classList.toggle('hidden'); e.target.textContent = more.classList.contains('hidden') ? 'عرض الكل' : 'عرض أقل'; }
  });

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
      ctx.font = '800 19px Cairo, sans-serif'; ctx.fillText(donutTotal, x, y - 2);
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
    <p class="page-sub">أرصدة المنتجات من stockBalances في Firestore — الرصيد نفسه لا يُكتب من العميل، بل يُحدَّث من الخادم الموثوق بناءً على حركات المخزون.</p>
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
    // إيقاف/تفعيل فقط (إيقاف ناعم) — المنتج لا يُحذف أبداً حتى تبقى سجلات مبيعاته سليمة
    const active = b.dataset.active === 'true';
    if (!active && !confirm('سيتم إيقاف هذا المنتج — لن يظهر في البحث ونقطة البيع، لكن سجلاته ومبيعاته السابقة تبقى محفوظة. متابعة؟')) return;
    await updateDoc(doc(db, 'products', b.dataset.toggleProduct), { isActive: !active, updatedAt: serverTimestamp() });
    await loadProducts();
    if (currentPage === 'products') await renderProducts();
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
$('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // سعر الشراء لا يُكتب إلا ممن لديه صلاحية رؤيته — وإلا يبقى كما هو عند التعديل
  const buyPrice = canSeePrices() ? toPiasters($('pf-buy').value)
    : (editingProduct ? Number(editingProduct.purchasePricePiasters || 0) : 0);
  const data = {
    orgId, name_ar: $('pf-name-ar').value.trim(), name_en: $('pf-name-en').value.trim(),
    partNumber: $('pf-part').value.trim(),
    alternativeNumbers: $('pf-alt').value.split(',').map((s) => s.trim()).filter(Boolean),
    barcode: $('pf-barcode').value.trim(), qrCode: $('pf-qr').value.trim(),
    categoryId: $('pf-category').value, brandId: $('pf-brand').value,
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
  try {
    if (editingProduct) await updateDoc(doc(db, 'products', editingProduct.id), data);
    else await addDoc(collection(db, 'products'), { ...data, createdAt: serverTimestamp() });
    $('product-modal').classList.add('hidden');
    await loadProducts();
    if (currentPage === 'products') await renderProducts();
    else if (currentPage === 'inventory') await renderInventory();
  } catch (err) { showError($('product-error'), firestoreErrorMessage(err)); }
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
    </div>`;
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
  $('pos-clear').addEventListener('click', () => { posCart = []; drawCart(); });
  const posCleanupBtn = $('demo-cleanup-btn');
  if (posCleanupBtn) posCleanupBtn.addEventListener('click', cleanupDemoData);
  $('pos-checkout').addEventListener('click', async () => {
    hideError($('pos-error'));
    if (!posCart.length) { showError($('pos-error'), 'السلة فارغة.'); return; }
    const subtotal = posCart.reduce((a, l) => a + l.qty * Number(l.product.sellingPricePiasters || 0), 0);
    const paid = toPiasters($('pos-paid').value);
    const customerId = $('pos-customer').value || null;
    const invoiceNumber = 'SI-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(Date.now()).slice(-6);
    try {
      const batch = writeBatch(db);
      const invRef = doc(collection(db, 'salesInvoices'));
      batch.set(invRef, {
        orgId, branchId: DEFAULT_BRANCH, invoiceNumber,
        idempotencyKey: invRef.id, customerId, createdBy: me.uid, status: 'posted',
        date: serverTimestamp(), subtotalPiasters: subtotal, discountPiasters: 0, taxPiasters: 0,
        totalPiasters: subtotal, paidPiasters: paid, remainingPiasters: Math.max(0, subtotal - paid),
        paymentMethod: $('pos-pay').value, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      posCart.forEach((l) => {
        const itemRef = doc(collection(db, 'salesInvoices', invRef.id, 'items'));
        batch.set(itemRef, {
          orgId, productId: l.product.id, productName_ar: l.product.name_ar,
          partNumber: l.product.partNumber || '', quantity: l.qty,
          unitPricePiasters: Number(l.product.sellingPricePiasters || 0), discountPiasters: 0,
          lineTotalPiasters: l.qty * Number(l.product.sellingPricePiasters || 0),
          costPricePiasters: Number(l.product.purchasePricePiasters || 0)
        });
        const movRef = doc(collection(db, 'stockMovements'));
        batch.set(movRef, {
          orgId, branchId: DEFAULT_BRANCH, warehouseId: (warehouses[0] || {}).id || '',
          productId: l.product.id, type: 'sale_out', quantity: l.qty,
          referenceType: 'salesInvoice', referenceId: invRef.id, createdBy: me.uid,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
      // ملاحظة: رصيد stockBalances يُحدَّث من الخادم الموثوق بناءً على حركة المخزون — قواعد Firestore تمنع الكتابة المباشرة من العميل.
      alert(`تم حفظ الفاتورة ${invoiceNumber} في Firestore.`);
      posCart = []; await loadProducts(); await renderPOS();
    } catch (err) { showError($('pos-error'), firestoreErrorMessage(err)); }
  });
  drawCart(); await drawResults('');
}

// ============================================================================
// 8) المشتريات — قائمة فواتير الشراء من Firestore
// ============================================================================
async function renderPurchases() {
  const list = await loadCollection('purchaseInvoices');
  const suppliers = await loadCollection('suppliers');
  const supName = (id) => (suppliers.find((s) => s.id === id) || {}).name_ar || '—';
  $('page').innerHTML = `
    <h2 class="page-title">📦 المشتريات</h2>
    <p class="page-sub">فواتير الشراء المنشورة في Firestore. إضافة فاتورة شراء جديدة تتم من التطبيق الكامل؛ هنا تُعرض الفواتير وأرصدة الموردين.</p>
    ${list.length ? `<div class="card"><table><tr><th>رقم الفاتورة</th><th>المورد</th><th>الحالة</th><th>الإجمالي</th><th>المتبقي</th><th>التاريخ</th></tr>
      ${list.sort((a, b) => tsToDate(b.createdAt) - tsToDate(a.createdAt)).map((p) => `
      <tr><td dir="ltr">${esc(p.invoiceNumber || p.id)}${demoBadge(p)}</td><td>${esc(supName(p.supplierId))}</td>
      <td><span class="badge ${p.status === 'posted' ? 'ok' : 'warn'}">${esc(p.status || '')}</span></td>
      <td class="num">${fmtEGP(p.totalPiasters)}</td><td class="num">${fmtEGP(p.remainingPiasters)}</td>
      <td>${tsToDate(p.date || p.createdAt).toLocaleDateString('ar-EG')}</td></tr>`).join('')}</table></div>`
    : `<div class="card">${emptyState('لا توجد فواتير شراء بعد في Firestore.')}</div>`}`;
}

// ============================================================================
// 9) الحسابات والتقارير (مالك فقط) — من القيود والفواتير الحقيقية
// ============================================================================
async function renderAccounts() {
  const [entries, expenses, cashboxes] = await Promise.all([
    loadCollection('journalEntries'), loadCollection('expenses'), loadCollection('cashboxes')
  ]);
  const debit = entries.filter((e) => e.status !== 'reversed').reduce((a, e) => a + Number(e.totalDebitPiasters || 0), 0);
  const credit = entries.filter((e) => e.status !== 'reversed').reduce((a, e) => a + Number(e.totalCreditPiasters || 0), 0);
  const expTotal = expenses.filter((e) => e.status !== 'cancelled').reduce((a, e) => a + Number(e.amountPiasters || 0), 0);
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
    <div class="card" style="margin-top:14px"><h3>أحدث القيود المحاسبية</h3>
      ${entries.length ? `<table><tr><th>رقم القيد</th><th>الوصف</th><th>مدين</th><th>دائن</th><th>الحالة</th></tr>
      ${entries.slice(0, 20).map((e) => `<tr><td dir="ltr">${esc(e.entryNumber || e.id)}</td><td>${esc(e.description_ar || '')}</td>
      <td class="num">${fmtEGP(e.totalDebitPiasters)}</td><td class="num">${fmtEGP(e.totalCreditPiasters)}</td>
      <td>${esc(e.status || '')}</td></tr>`).join('')}</table>` : emptyState('لا توجد قيود محاسبية بعد.')}</div>`;
}
async function renderReports() {
  const sales = (await loadCollection('salesInvoices')).filter((s) => s.status === 'posted');
  const byMonth = {};
  sales.forEach((s) => { const t = tsToDate(s.date || s.createdAt); const k = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
    byMonth[k] = (byMonth[k] || 0) + Number(s.totalPiasters || 0); });
  const rows = Object.entries(byMonth).sort();
  $('page').innerHTML = `
    <h2 class="page-title">📊 التقارير والتحليلات</h2>
    <p class="page-sub">تقارير محسوبة من فواتير المبيعات المنشورة فقط — الفواتير الملغاة مستبعدة.</p>
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
  const list = await loadCollection(kind);
  const isCust = kind === 'customers';
  $('page').innerHTML = `
    <h2 class="page-title">${isCust ? '👥 إدارة العملاء' : '🤝 إدارة الموردين'}</h2>
    <div class="toolbar"><button class="btn small" id="add-contact-btn">➕ ${isCust ? 'عميل جديد' : 'مورد جديد'}</button></div>
    <div class="card">
    ${list.length ? `<table><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد الحالي</th><th>الحالة</th></tr>
      ${list.map((c) => `<tr><td>${esc(c.name_ar)}${demoBadge(c)}</td><td dir="ltr">${esc(c.phone || '')}</td>
      <td class="num">${fmtEGP(c.currentBalancePiasters)}</td>
      <td><span class="badge ${c.isActive === false ? 'bad' : 'ok'}">${c.isActive === false ? 'موقوف' : 'نشط'}</span></td></tr>`).join('')}</table>`
    : emptyState(isCust ? 'لا يوجد عملاء مسجلون بعد.' : 'لا يوجد موردون مسجلون بعد.')}</div>`;
  $('add-contact-btn').addEventListener('click', () => openContactForm());
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
});

// ============================================================================
// 11) الفروع والمخازن (مالك فقط) + الإعدادات
// ============================================================================
async function renderBranches() {
  $('page').innerHTML = `
    <h2 class="page-title">📍 إدارة الفروع</h2>
    <div class="grid-2">
      <div class="card"><h3>الفروع</h3>
        ${branches.length ? branches.map((b) => `<div class="list-row"><span>${esc(b.name_ar)}</span><span class="badge ${b.isActive === false ? 'bad' : 'ok'}">${b.isActive === false ? 'موقوف' : 'نشط'}</span></div>`).join('') : emptyState('لا توجد فروع مسجلة بعد — استخدم التهيئة في الإعدادات.')}
      </div>
      <div class="card"><h3>المخازن</h3>
        ${warehouses.length ? warehouses.map((w) => `<div class="list-row"><span>${esc(w.name_ar)}</span><span>${esc(branchName(w.branchId))}</span></div>`).join('') : emptyState('لا توجد مخازن مسجلة بعد.')}
      </div>
    </div>`;
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
        : emptyState('لم يتم إنشاء مستند المؤسسة بعد — اضغط "تهيئة النظام" بالأسفل.')}
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
  $('setup-btn').addEventListener('click', async () => {
    try {
      await setDoc(doc(db, 'organizations', orgId), {
        name_ar: 'الفلكي لقطع غيار السيارات', name_en: 'Al-Falaky Auto Spare Parts',
        currency: 'EGP', defaultLanguage: 'ar', isActive: true,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'branches', DEFAULT_BRANCH), { orgId, name_ar: 'الفرع الرئيسي', name_en: 'Main Branch',
        isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'warehouses', 'wh_main'), { orgId, branchId: DEFAULT_BRANCH, name_ar: 'المخزن الرئيسي',
        name_en: 'Main Warehouse', isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, 'cashboxes', 'cash_main'), { orgId, branchId: DEFAULT_BRANCH, name_ar: 'صندوق الفرع الرئيسي',
        balancePiasters: 0, isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      const seedAccounts = [
        ['1010', 'الصندوق', 'asset'], ['1200', 'العملاء', 'asset'], ['1300', 'المخزون', 'asset'],
        ['2100', 'الموردون', 'liability'], ['4000', 'المبيعات', 'income'], ['5000', 'تكلفة البضاعة المباعة', 'expense'],
        ['6000', 'المصروفات العمومية', 'expense']
      ];
      for (const [code, name, type] of seedAccounts) {
        await setDoc(doc(db, 'accounts', 'acc_' + code), { orgId, code, name_ar: name, name_en: '', type,
          isActive: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      }
      // تصنيفات وعلامات أساسية إن لم توجد
      for (const [id, name] of [['cat_filters', 'فلاتر'], ['cat_brakes', 'فرامل'], ['cat_engine', 'مكونات محرك'], ['cat_electrical', 'كهرباء']]) {
        await setDoc(doc(db, 'categories', id), { orgId, name_ar: name, name_en: '', isActive: true,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      }
      alert('تمت التهيئة بنجاح.');
      await loadLookups(); await renderSettings();
    } catch (err) { alert(firestoreErrorMessage(err)); }
  });
}

// ============================================================================
// 12) إدارة الموظفين (مالك فقط)
// ============================================================================
async function renderEmployees() {
  const users = await loadCollection('users');
  $('page').innerHTML = `
    <h2 class="page-title">👤 إدارة الموظفين</h2>
    <p class="page-sub">إيقاف موظف يمنعه من الدخول فوراً. الحذف هنا يعني إيقاف الحساب فقط — مبيعاته وسجلاته السابقة لا تُحذف أبداً.</p>
    <div class="toolbar"><button class="btn small" id="add-emp-btn">➕ موظف جديد</button></div>
    <div class="card">
    ${users.length ? `<table><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>الواجهات</th><th>الحالة</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.displayName_ar || u.email)}</td><td dir="ltr">${esc(u.email)}</td>
      <td>${roleLabel(u.role)}</td><td>${esc((u.interfaces || []).join('، ') || 'كل الواجهات حسب الدور')}</td>
      <td><span class="badge ${u.isActive === false ? 'bad' : 'ok'}">${u.isActive === false ? 'موقوف' : 'نشط'}</span></td>
      <td>${u.uid !== me.uid ? `<button class="btn small secondary" data-toggle-user="${u.id}" data-active="${u.isActive !== false}">
        ${u.isActive === false ? 'تفعيل' : 'إيقاف'}</button>` : ''}</td></tr>`).join('')}</table>`
    : emptyState('لا يوجد موظفون مسجلون بعد.')}</div>`;
  $('add-emp-btn').addEventListener('click', () => {
    $('ef-interfaces').innerHTML = ALL_INTERFACES.map((id) =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin:0"><input type="checkbox" value="${id}" style="width:auto"> ${NAV.find((n) => n.id === id).label}</label>`).join('');
    hideError($('employee-error'));
    $('employee-modal').classList.remove('hidden');
  });
  document.querySelectorAll('[data-toggle-user]').forEach((b) => b.addEventListener('click', async () => {
    const active = b.dataset.active === 'true';
    await updateDoc(doc(db, 'users', b.dataset.toggleUser), { isActive: !active, updatedAt: serverTimestamp() });
    await renderEmployees();
  }));
}
$('employee-cancel-btn').addEventListener('click', () => $('employee-modal').classList.add('hidden'));
$('employee-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError($('employee-error'));
  const interfaces = [...document.querySelectorAll('#ef-interfaces input:checked')].map((c) => c.value);
  const permissions = $('ef-perms').value.split(',').map((s) => s.trim()).filter(Boolean);
  let secondary = null;
  try {
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
  const posted = sales.filter((s) => s.status === 'posted');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todaySales = posted.filter((s) => tsToDate(s.date || s.createdAt) >= today)
    .reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const totalSales = posted.reduce((a, s) => a + Number(s.totalPiasters || 0), 0);
  const low = productsCache.filter((p) => { const st = productStock(p); return st !== null && st > 0 && Number(p.minStock || 0) > 0 && st < Number(p.minStock); });
  const active = customers.filter((c) => c.isActive !== false).length;
  if (/مبيعات اليوم|مبيعات النهاردة|بيع.*اليوم/.test(q)) return `مبيعات اليوم: ${fmtEGP(todaySales)} (${posted.filter((s) => tsToDate(s.date || s.createdAt) >= today).length} فاتورة منشورة).`;
  if (/ربح/.test(q)) {
    let cogs = 0;
    for (const inv of posted.slice(0, 60)) {
      const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
      items.forEach((it) => { const d = it.data(); cogs += Number(d.costPricePiasters || 0) * Number(d.quantity || 0); });
    }
    return `صافي الربح الإجمالي (من آخر 60 فاتورة): ${fmtEGP(totalSales - cogs)} — الإيراد ${fmtEGP(totalSales)} ناقص تكلفة البضاعة ${fmtEGP(cogs)}.`;
  }
  if (/منخفض|ناقص|مخزون/.test(q)) {
    if (!low.length) return 'لا توجد منتجات منخفضة المخزون حالياً — كل المنتجات فوق حد إعادة الطلب.';
    return `يوجد ${low.length} منتج منخفض المخزون:\n` + low.slice(0, 8).map((p) => `• ${p.name_ar} — متبقي ${fmtNum(productStock(p))} / حد ${fmtNum(p.minStock)}`).join('\n');
  }
  if (/الأكثر مبيعاً|أكثر.*مبيع|أفضل/.test(q)) {
    const sold = {};
    for (const inv of posted.slice(0, 60)) {
      const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
      items.forEach((it) => { const d = it.data(); sold[d.productId] = (sold[d.productId] || 0) + Number(d.quantity || 0); });
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
    </div>`;
}
