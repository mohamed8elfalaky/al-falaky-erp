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
let productsCache = []; // منتجات محملة للبحث السريع
let balancesCache = {}; // productId -> quantity
let currentPage = 'dashboard';
let posCart = [];       // [{product, qty}]
let charts = {};        // Chart.js instances (لتدميرها قبل إعادة الرسم)

// --- أدوات مساعدة ---
const $ = (id) => document.getElementById(id);
const fmtEGP = (piasters) => (Number(piasters || 0) / 100)
  .toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
const fmtNum = (n) => Number(n || 0).toLocaleString('ar-EG');
const toPiasters = (egp) => Math.round(Number(egp || 0) * 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tsToDate = (t) => (t && t.toDate) ? t.toDate() : (t instanceof Date ? t : new Date(t));
function showError(el, msg) { el.textContent = msg; el.classList.add('show'); }
function hideError(el) { el.textContent = ''; el.classList.remove('show'); }
function emptyState(text) { return `<div class="empty">${text}</div>`; }
function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

// ترجمة أخطاء Firebase إلى عربي واضح
function authErrorMessage(code) {
  return {
    'auth/invalid-credential': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    'auth/user-not-found': 'لا يوجد حساب بهذا البريد الإلكتروني.',
    'auth/wrong-password': 'كلمة المرور غير صحيحة.',
    'auth/user-disabled': 'هذا الحساب موقوف — راجع المالك.',
    'auth/too-many-requests': 'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً.',
    'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت.',
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
    await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-password').value);
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
    $('user-name').textContent = me.displayName + ' — ' + roleLabel(me.role);
    $('user-avatar').textContent = (me.displayName || '?').trim().charAt(0);
    $('conn-badge').textContent = '● متصل بـ Firestore';
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
  { id: 'purchases',  label: 'المشتريات',      ico: '📦', ownerOnly: false },
  { id: 'inventory',  label: 'المخزون',        ico: '📦', ownerOnly: false },
  { id: 'accounts',   label: 'الحسابات',       ico: '💰', ownerOnly: true  },
  { id: 'reports',    label: 'التقارير والتحليلات', ico: '📊', ownerOnly: true },
  { id: 'customers',  label: 'إدارة العملاء',   ico: '👥', ownerOnly: false },
  { id: 'suppliers',  label: 'إدارة الموردين',  ico: '🤝', ownerOnly: false },
  { id: 'branches',   label: 'إدارة الفروع',    ico: '📍', ownerOnly: true  },
  { id: 'employees',  label: 'إدارة الموظفين',  ico: '👤', ownerOnly: true  },
  { id: 'settings',   label: 'الإعدادات',      ico: '⚙️', ownerOnly: true  }
];
const ALL_INTERFACES = ['dashboard', 'sales', 'purchases', 'inventory', 'customers', 'suppliers'];

function visibleNav() {
  if (isOwner()) return NAV;
  // الموظف: فقط الواجهات المكتوبة في مستند users الخاص به
  const allowed = new Set(me.interfaces || ALL_INTERFACES);
  return NAV.filter((n) => n.id === 'dashboard' || allowed.has(n.id));
}
function canSee(page) {
  if (isOwner()) return true;
  if (page === 'dashboard') return true;
  return (me.interfaces || ALL_INTERFACES).includes(page);
}
function buildNav() {
  $('main-nav').innerHTML = visibleNav().map((n) =>
    `<button class="nav-item" data-page="${n.id}"><span class="ico">${n.ico}</span> ${n.label}</button>`).join('');
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.page)));
}

async function go(page) {
  if (!canSee(page)) { $('page').innerHTML = emptyState('ليس لديك صلاحية لعرض هذه الصفحة.'); return; }
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === page));
  const renderers = { dashboard: renderDashboard, sales: renderPOS, purchases: renderPurchases,
    inventory: renderInventory, accounts: renderAccounts, reports: renderReports,
    customers: () => renderContacts('customers'), suppliers: () => renderContacts('suppliers'),
    branches: renderBranches, employees: renderEmployees, settings: renderSettings };
  $('page').innerHTML = '<div class="empty">جارٍ تحميل البيانات من Firestore...</div>';
  try { await renderers[page](); }
  catch (err) { $('page').innerHTML = `<div class="error show">${esc(firestoreErrorMessage(err))}</div>`; }
}

// بيانات مرجعية: فروع/مخازن/تصنيفات/علامات (للقوائم المنسدلة)
async function loadLookups() {
  const [b, w, c, br] = await Promise.all([
    getDocs(query(collection(db, 'branches'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'warehouses'), where('orgId', '==', orgId), limit(100))),
    getDocs(query(collection(db, 'categories'), where('orgId', '==', orgId), limit(200))),
    getDocs(query(collection(db, 'brands'), where('orgId', '==', orgId), limit(200)))
  ]);
  branches = b.docs.map((d) => ({ id: d.id, ...d.data() }));
  warehouses = w.docs.map((d) => ({ id: d.id, ...d.data() }));
  categories = c.docs.map((d) => ({ id: d.id, ...d.data() }));
  brands = br.docs.map((d) => ({ id: d.id, ...d.data() }));
}
function branchName(id) { return (branches.find((b) => b.id === id) || {}).name_ar || id || '—'; }
function categoryName(id) { return (categories.find((c) => c.id === id) || {}).name_ar || '—'; }
function brandName(id) { return (brands.find((b) => b.id === id) || {}).name_ar || '—'; }

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
  // الربح = الإيراد − تكلفة البضاعة المباعة (من بنود الفواتير إن وُجدت)
  let cogs = 0;
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    items.forEach((it) => { const d = it.data(); cogs += Number(d.costPricePiasters || 0) * Number(d.quantity || 0); });
  }
  const profit = totalSales - cogs;
  // قيمة المخزون = مجموع (الرصيد × سعر الشراء)
  const prodById = Object.fromEntries(productsCache.map((p) => [p.id, p]));
  const inventoryValue = bals.reduce((a, b) =>
    a + Number(b.quantity || 0) * Number((prodById[b.productId] || {}).purchasePricePiasters || 0), 0);
  const activeCustomers = customers.filter((c) => c.isActive !== false).length;

  // أكثر المنتجات مبيعاً (من بنود آخر 60 فاتورة)
  const soldQty = {};
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    items.forEach((it) => { const d = it.data(); soldQty[d.productId] = (soldQty[d.productId] || 0) + Number(d.quantity || 0); });
  }
  const best = Object.entries(soldQty).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([pid, qty], i) => ({ rank: i + 1, name: (prodById[pid] || {}).name_ar || pid, qty }));

  // تنبيهات المخزون المنخفض
  const lowStock = productsCache.filter((p) => {
    const q = productStock(p); return q !== null && Number(p.minStock || 0) > 0 && q < Number(p.minStock);
  });
  const outStock = productsCache.filter((p) => productStock(p) === 0);
  const inStockCount = productsCache.length ? Math.round(100 * productsCache.filter((p) => (productStock(p) ?? 0) > 0).length / productsCache.length) : 0;

  // مبيعات ومشتريات آخر 6 أشهر
  const months = [], salesByMonth = [], purchByMonth = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toLocaleDateString('ar-EG', { month: 'long' }));
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    salesByMonth.push(posted.filter((s) => { const t = tsToDate(s.date || s.createdAt); return `${t.getFullYear()}-${t.getMonth()}` === key; })
      .reduce((a, s) => a + Number(s.totalPiasters || 0), 0) / 100);
    purchByMonth.push(postedPurchases.filter((s) => { const t = tsToDate(s.date || s.createdAt); return `${t.getFullYear()}-${t.getMonth()}` === key; })
      .reduce((a, s) => a + Number(s.totalPiasters || 0), 0) / 100);
  }
  // مبيعات حسب الفئة (من بنود الفواتير)
  const catTotals = {};
  for (const inv of posted.slice(0, 60)) {
    const items = await getDocs(collection(db, 'salesInvoices', inv.id, 'items'));
    items.forEach((it) => { const d = it.data(); const cat = categoryName((prodById[d.productId] || {}).categoryId);
      catTotals[cat] = (catTotals[cat] || 0) + Number(d.lineTotalPiasters || 0); });
  }
  // أداء الفروع
  const branchTotals = {};
  posted.forEach((s) => { branchTotals[s.branchId] = (branchTotals[s.branchId] || 0) + Number(s.totalPiasters || 0); });

  const hasAny = posted.length || postedPurchases.length || productsCache.length;
  $('page').innerHTML = `
    <div class="hero"><h2>إدارة أذكى .. لعمل أكثر نجاحاً</h2><p>مع نظام الفلكي المتكامل لقطع غيار السيارات — كل الأرقام أدناه من قاعدة بيانات Firestore مباشرة.</p></div>
    <div class="kpi-grid">
      <div class="card kpi"><div class="ico">🛒</div><div class="value">${fmtEGP(totalSales)}</div><div class="label">إجمالي المبيعات</div></div>
      <div class="card kpi"><div class="ico">📈</div><div class="value">${fmtEGP(profit)}</div><div class="label">صافي الربح (إيراد − تكلفة)</div></div>
      <div class="card kpi"><div class="ico">📦</div><div class="value">${fmtEGP(totalPurchases)}</div><div class="label">إجمالي المشتريات</div></div>
      <div class="card kpi"><div class="ico">🏷️</div><div class="value">${fmtEGP(inventoryValue)}</div><div class="label">قيمة المخزون الإجمالية</div></div>
      <div class="card kpi"><div class="ico">👥</div><div class="value">${fmtNum(activeCustomers)}</div><div class="label">عملاء نشطين</div></div>
    </div>
    ${hasAny ? '' : `<div class="card">${emptyState('لا توجد بيانات بعد في Firestore — أنشئ منتجات وفواتير من صفحتي المخزون والمبيعات، وستظهر المؤشرات هنا تلقائياً.')}</div>`}
    <div class="grid-2">
      <div class="card"><h3>🏆 أكثر المنتجات مبيعاً</h3>
        ${best.length ? best.map((b) => `<div class="list-row"><span>${b.rank}️⃣ ${esc(b.name)}</span><b>${fmtNum(b.qty)} قطعة</b></div>`).join('') : emptyState('لا توجد مبيعات مسجلة بعد.')}</div>
      <div class="card"><h3>📊 المبيعات والمشتريات خلال 6 أشهر</h3><div class="chart-wrap"><canvas id="chart-sales"></canvas></div></div>
    </div>
    <div class="grid-3">
      <div class="card"><h3>🍩 توزيع المبيعات حسب الفئة</h3><div class="chart-wrap small"><canvas id="chart-cat"></canvas></div>
        ${Object.keys(catTotals).length ? '' : emptyState('لا توجد مبيعات حسب الفئة بعد.')}</div>
      <div class="card"><h3>⚠️ التنبيهات والمخزون</h3>
        <div class="list-row"><span>🔴 منتجات ناقصة (أقل من الحد)</span><b>${fmtNum(lowStock.length)}</b></div>
        <div class="list-row"><span>❌ منتجات نافدة</span><b>${fmtNum(outStock.length)}</b></div>
        <div class="list-row"><span>✅ نسبة المنتجات المتوفرة</span><b>${inStockCount}%</b></div>
        <div class="progress"><div style="width:${inStockCount}%"></div></div>
        ${lowStock.slice(0, 5).map((p) => `<div class="list-row"><span>${esc(p.name_ar)}</span><span class="badge warn">متبقي ${fmtNum(productStock(p))} / حد ${fmtNum(p.minStock)}</span></div>`).join('')}
      </div>
      <div class="card"><h3>🏢 أداء الفروع</h3>
        ${Object.keys(branchTotals).length ? Object.entries(branchTotals).map(([bid, v]) =>
          `<div class="list-row"><span>${esc(branchName(bid))}</span><b class="num">${fmtEGP(v)}</b></div>`).join('') : emptyState('لا توجد مبيعات حسب الفرع بعد.')}
      </div>
    </div>`;

  destroyChart('sales'); destroyChart('cat');
  charts.sales = new Chart($('chart-sales'), { type: 'line',
    data: { labels: months, datasets: [
      { label: 'المبيعات', data: salesByMonth, borderColor: '#2f81f7', backgroundColor: 'rgba(47,129,247,.2)', fill: true, tension: 0.4 },
      { label: 'المشتريات', data: purchByMonth, borderColor: '#f0883e', backgroundColor: 'rgba(240,136,62,.15)', fill: true, tension: 0.4 } ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6edf3' } } },
      scales: { x: { ticks: { color: '#8b98a9' } }, y: { ticks: { color: '#8b98a9' } } } } });
  if (Object.keys(catTotals).length) {
    charts.cat = new Chart($('chart-cat'), { type: 'doughnut',
      data: { labels: Object.keys(catTotals), datasets: [{ data: Object.values(catTotals).map((v) => v / 100),
        backgroundColor: ['#2f81f7', '#f0883e', '#3fb950', '#a371f7', '#39c5cf', '#8b98a9'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6edf3' } } } } });
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
  return `<div class="card">
    <h3>${esc(p.name_ar)} ${p.name_en ? `<small style="color:var(--muted)">(${esc(p.name_en)})</small>` : ''}</h3>
    <div class="list-row"><span>رقم القطعة</span><b dir="ltr">${esc(p.partNumber || '—')}</b></div>
    <div class="list-row"><span>الباركود / QR</span><b dir="ltr">${esc(p.barcode || p.qrCode || '—')}</b></div>
    <div class="list-row"><span>سعر البيع</span><b>${fmtEGP(p.sellingPricePiasters)}</b></div>
    ${isOwner() || me.role === 'manager' || me.role === 'accountant' ? `<div class="list-row"><span>سعر الشراء</span><b>${fmtEGP(p.purchasePricePiasters)}</b></div>` : ''}
    <div class="list-row"><span>المخزون المتاح</span><b>${stock === null ? 'غير مسجل' : fmtNum(stock) + ' قطعة'}</b></div>
    <div class="list-row"><span>المخزن / الرف</span><b>${esc(p.warehouseLocation || '—')} / ${esc(p.shelfNumber || '—')}</b></div>
    <div class="list-row"><span>التصنيف / العلامة</span><b>${esc(categoryName(p.categoryId))} / ${esc(brandName(p.brandId))}</b></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn small" data-add-sale="${p.id}">➕ إضافة للبيع</button>
      <button class="btn small secondary" data-edit-product="${p.id}">✏️ تعديل</button>
    </div></div>`;
}

async function renderInventory() {
  await loadProducts();
  $('page').innerHTML = `
    <h2 class="page-title">📦 المخزون والمنتجات</h2>
    <p class="page-sub">البحث الذكي: رقم القطعة المطابق يظهر أولاً، ثم الباركود وQR والاسم.</p>
    <div class="toolbar">
      <input id="inv-search" type="search" placeholder="ابحث برقم القطعة، الباركود، أو الاسم...">
      <button class="btn scan small" id="scan-btn-inv">📷 مسح باركود / QR</button>
      <button class="btn small" id="add-product-btn">➕ منتج جديد</button>
    </div>
    <div class="grid-3" id="products-grid"></div>`;
  const draw = async (q) => {
    const list = await searchProducts(q);
    $('products-grid').innerHTML = list.length ? list.map(productCardHTML).join('') : emptyState('لا توجد منتجات مطابقة — جرّب كوداً آخر أو أضف المنتج جديداً.');
    bindProductButtons();
  };
  $('inv-search').addEventListener('input', (e) => draw(e.target.value));
  $('scan-btn-inv').addEventListener('click', openScanner);
  $('add-product-btn').addEventListener('click', () => openProductForm());
  await draw('');
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
  if (list.length) { await go('inventory'); $('inv-search').value = e.target.value; $('inv-search').dispatchEvent(new Event('input')); }
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
    if (currentPage !== 'inventory') await go('inventory');
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
  $('pf-name-ar').value = p?.name_ar || '';
  $('pf-name-en').value = p?.name_en || '';
  $('pf-part').value = p?.partNumber || scannedCode || '';
  $('pf-alt').value = (p?.alternativeNumbers || []).join(', ');
  $('pf-barcode').value = p?.barcode || (/^\d+$/.test(scannedCode) ? scannedCode : '');
  $('pf-qr').value = p?.qrCode || (!/^\d+$/.test(scannedCode) ? scannedCode : '');
  $('pf-category').value = p?.categoryId || '';
  $('pf-brand').value = p?.brandId || '';
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
  const data = {
    orgId, name_ar: $('pf-name-ar').value.trim(), name_en: $('pf-name-en').value.trim(),
    partNumber: $('pf-part').value.trim(),
    alternativeNumbers: $('pf-alt').value.split(',').map((s) => s.trim()).filter(Boolean),
    barcode: $('pf-barcode').value.trim(), qrCode: $('pf-qr').value.trim(),
    categoryId: $('pf-category').value, brandId: $('pf-brand').value,
    purchasePricePiasters: toPiasters($('pf-buy').value),
    sellingPricePiasters: toPiasters($('pf-sell').value),
    wholesalePricePiasters: toPiasters($('pf-wholesale').value),
    minStock: Number($('pf-min').value || 0), unit: 'piece',
    warehouseLocation: $('pf-loc').value.trim(), shelfNumber: $('pf-shelf').value.trim(),
    description_ar: $('pf-notes').value.trim(), isActive: true, updatedAt: serverTimestamp()
  };
  try {
    if (editingProduct) await updateDoc(doc(db, 'products', editingProduct.id), data);
    else await addDoc(collection(db, 'products'), { ...data, createdAt: serverTimestamp() });
    $('product-modal').classList.add('hidden');
    await loadProducts();
    if (currentPage === 'inventory') await renderInventory();
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
    const list = (await searchProducts(q)).slice(0, 12);
    $('pos-results').innerHTML = list.length ? list.map((p) => `
      <div class="card"><b>${esc(p.name_ar)}</b><br><small dir="ltr">${esc(p.partNumber || '')}</small>
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
      <tr><td dir="ltr">${esc(p.invoiceNumber || p.id)}</td><td>${esc(supName(p.supplierId))}</td>
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
      ${list.map((c) => `<tr><td>${esc(c.name_ar)}</td><td dir="ltr">${esc(c.phone || '')}</td>
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
