/**
 * 2026 CBB イベント物販・POSレジシステム バックエンドAPI (gas/Code.gs - Refactored)
 */

// ==========================================
// 定数・シート定義・列インデックス
// ==========================================
const SHEET_NAMES = Object.freeze({
  PRODUCTS: 'products',
  ORDERS: 'orders',
  USERS: 'users',
  STAFFS: 'staffs'
});

const ORDER_STATUS = Object.freeze({
  UNPAID: 0,     // 未決済
  PAID: 1,       // 決済済み（ピッキング待ち）
  PICKING: 2,    // ピッキング中
  COMPLETED: 3,  // 引き渡し完了
  CANCELED: 4    // キャンセル済み
});

const ACTIVE_STOCK_STATUSES = [
  ORDER_STATUS.UNPAID,
  ORDER_STATUS.PAID,
  ORDER_STATUS.PICKING,
  ORDER_STATUS.COMPLETED
];

const COL = Object.freeze({
  PRODUCTS: { ID: 0, NAME: 1, PRICE: 2, STOCK: 3, LIMIT: 4, IMAGE_URL: 5, STATUS: 6 },
  ORDERS: { ID: 0, CREATED_AT: 1, TOTAL_PRICE: 2, STATUS: 3, UPDATED_AT: 4, ITEMS: 5, RECEIVED_AMOUNT: 6 },
  USERS: { USER_ID: 0, ACCOUNT: 1, CREATED_AT: 2 },
  STAFFS: { NAME: 0, ACCOUNT: 1, PIN: 2 }
});

const CACHE_KEY_PRODUCTS = 'public_products';
const CACHE_TTL_SECONDS = 21600; // 6時間
const ORDER_EXPIRE_MS = 60 * 60 * 1000; // 1時間（60分）

// ==========================================
// 1. HTTP エンドポイント (doGet / doPost)
// ==========================================
function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || '').trim();

    if (action === 'public') {
      return createJsonResponse_(handlePublic_(params));
    }
    if (action === 'staff') {
      return createJsonResponse_(handleStaff_(params));
    }
    return createJsonResponse_({ success: false, message: '不明なGETアクションです。' });
  } catch (err) {
    return createJsonResponse_({ success: false, message: err.message || String(err) });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse_({ success: false, message: 'リクエストボディが空です。' });
    }
    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '').trim();

    if (action === 'createOrder') {
      return createJsonResponse_(handleCreateOrder_(payload));
    }
    if (action === 'payAllByUser') {
      return createJsonResponse_(handlePayAllByUser_(payload));
    }
    if (action === 'updateStatusByUser') {
      return createJsonResponse_(handleUpdateStatusByUser_(payload));
    }
    if (action === 'updateStatus') {
      return createJsonResponse_(handleUpdateStatus_(payload));
    }

    return createJsonResponse_({ success: false, message: '不明なPOSTアクションです。' });
  } catch (err) {
    return createJsonResponse_({ success: false, message: err.message || String(err) });
  }
}

// ==========================================
// 2. GET アクションハンドラ
// ==========================================
function handlePublic_(params) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const account = normalizeEmail_(params.account);
  const forceRefresh = String(params.force || '') === '1';

  const products = getProductsWithRealtimeStock_(ss, forceRefresh);

  let userObj = null;
  let myOrders = [];
  let isStaff = false;

  if (account) {
    isStaff = Boolean(findStaffByAccount_(ss, account));
    userObj = getOrCreateUser_(ss, account);
    const allOrders = getAllOrders_(ss);
    myOrders = allOrders.filter(o =>
      o.account === account || (userObj && o.user_id === userObj.user_id)
    );
  }

  return {
    success: true,
    products: products,
    user: userObj,
    myOrders: myOrders,
    isStaff: isStaff
  };
}

function handleStaff_(params) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const staff = verifyStaffCredentials_(ss, params.account, params.pin);
  if (!staff) {
    return {
      success: false,
      authError: true,
      message: 'スタッフ認証に失敗しました。GmailアドレスとPINを確認してください。'
    };
  }

  const forceRefresh = String(params.force || '') === '1';
  const products = getProductsWithRealtimeStock_(ss, forceRefresh);
  const orders = getAllOrders_(ss);
  const users = getAllUsers_(ss);

  return {
    success: true,
    staffName: staff.name,
    products: products,
    orders: orders,
    users: users
  };
}

// ==========================================
// 3. POST アクションハンドラ（すべて排他制御付き）
// ==========================================
function handleCreateOrder_(payload) {
  const account = normalizeEmail_(payload.account);
  const reqItems = Array.isArray(payload.items) ? payload.items : [];

  if (!account || !account.includes('@')) {
    return { success: false, message: '有効なGmailアドレスが必要です。' };
  }
  if (reqItems.length === 0) {
    return { success: false, message: '注文商品が選択されていません。' };
  }

  return withScriptLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const userObj = getOrCreateUser_(ss, account);
    const latestProducts = getProductsWithRealtimeStock_(ss, true);
    const productMap = new Map(latestProducts.map(p => [p.id, p]));

    let totalPrice = 0;
    const verifiedItems = [];

    for (const item of reqItems) {
      const pid = String(item.id || '').trim();
      const qty = Math.floor(Number(item.qty) || 0);
      const prod = productMap.get(pid);

      if (!prod || !prod.status) {
        return { success: false, message: `商品（ID: ${pid}）は現在販売されていません。` };
      }
      if (qty <= 0) {
        return { success: false, message: `「${prod.name}」の数量が不正です。` };
      }
      if (qty > prod.limit) {
        return { success: false, message: `「${prod.name}」の購入上限（${prod.limit}点）を超えています。` };
      }
      if (qty > prod.stock) {
        return { success: false, message: `申し訳ありません。「${prod.name}」の在庫が不足しています（残り${prod.stock}点）。` };
      }

      totalPrice += prod.price * qty;
      verifiedItems.push({
        id: prod.id,
        name: prod.name,
        price: prod.price,
        qty: qty
      });
    }

    const nowStr = formatDateTime_(new Date());
    const orderId = generateOrderId_();
    const storedPayload = JSON.stringify({
      user_id: userObj.user_id,
      account: account,
      items: verifiedItems
    });

    const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    orderSheet.appendRow([
      orderId,
      nowStr,
      totalPrice,
      ORDER_STATUS.UNPAID,
      nowStr,
      storedPayload,
      0
    ]);

    invalidateProductsCache_();
    SpreadsheetApp.flush();

    return {
      success: true,
      orderId: orderId,
      userId: userObj.user_id,
      totalPrice: totalPrice,
      message: '注文を確定しました。'
    };
  });
}

function handlePayAllByUser_(payload) {
  return withScriptLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const staff = verifyStaffCredentials_(ss, payload.account, payload.pin);
    if (!staff) {
      return { success: false, authError: true, message: 'スタッフ認証エラーです。' };
    }

    const targetUid = String(payload.userId || '').trim().toUpperCase();
    if (!targetUid) {
      return { success: false, message: 'ユーザーIDが指定されていません。' };
    }

    if (payload.receivedAmount === undefined || payload.receivedAmount === null || payload.receivedAmount === '') {
      return { success: false, message: 'エラー: お預かり金額（receivedAmount）が送信されていません。' };
    }
    const receivedAmount = Number(payload.receivedAmount);
    if (isNaN(receivedAmount) || receivedAmount < 0) {
      return { success: false, message: 'お預かり金額の数値が不正です。' };
    }

    const users = getAllUsers_(ss);
    const userObj = users.find(u => u.user_id.toUpperCase() === targetUid);
    const targetAccount = userObj ? userObj.account : '';

    const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const rows = orderSheet.getDataRange().getValues();
    const nowStr = formatDateTime_(new Date());

    let updatedCount = 0;
    let sumTotalPrice = 0;

    for (let i = 1; i < rows.length; i++) {
      const parsed = parseOrderRow_(rows[i]);
      if (!parsed.id || parsed.status !== ORDER_STATUS.UNPAID) continue;

      const isTarget = (parsed.user_id.toUpperCase() === targetUid) ||
        (targetAccount && parsed.account === targetAccount);

      if (isTarget) {
        const rowNum = i + 1;
        const recordReceived = updatedCount === 0 ? receivedAmount : 0;

        orderSheet.getRange(rowNum, COL.ORDERS.STATUS + 1).setValue(ORDER_STATUS.PAID);
        orderSheet.getRange(rowNum, COL.ORDERS.UPDATED_AT + 1).setValue(nowStr);
        orderSheet.getRange(rowNum, COL.ORDERS.RECEIVED_AMOUNT + 1).setValue(recordReceived);

        updatedCount++;
        sumTotalPrice += parsed.total_price;
      }
    }

    if (updatedCount === 0) {
      return { success: false, message: '対象の未決済注文が見つかりませんでした（すでに決済済みか期限切れの可能性があります）。' };
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      updatedCount: updatedCount,
      totalPrice: sumTotalPrice,
      receivedAmount: receivedAmount,
      message: `${targetUid} の未決済注文 ${updatedCount}件（合計 ¥${sumTotalPrice.toLocaleString()}）の決済を完了しました。`
    };
  });
}

function handleUpdateStatusByUser_(payload) {
  return withScriptLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const staff = verifyStaffCredentials_(ss, payload.account, payload.pin);
    if (!staff) {
      return { success: false, authError: true, message: 'スタッフ認証エラーです。' };
    }

    const targetUid = String(payload.userId || '').trim().toUpperCase();
    const nextStatus = Number(payload.nextStatus);
    if (!targetUid || ![ORDER_STATUS.PICKING, ORDER_STATUS.COMPLETED].includes(nextStatus)) {
      return { success: false, message: 'パラメータが不正です。' };
    }

    const users = getAllUsers_(ss);
    const userObj = users.find(u => u.user_id.toUpperCase() === targetUid);
    const targetAccount = userObj ? userObj.account : '';

    const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const rows = orderSheet.getDataRange().getValues();
    const nowStr = formatDateTime_(new Date());

    let updatedCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const parsed = parseOrderRow_(rows[i]);
      const isWaiting = parsed.status === ORDER_STATUS.PAID || parsed.status === ORDER_STATUS.PICKING;
      if (!parsed.id || !isWaiting) continue;

      const isTarget = (parsed.user_id.toUpperCase() === targetUid) ||
        (targetAccount && parsed.account === targetAccount);

      if (isTarget) {
        const rowNum = i + 1;
        orderSheet.getRange(rowNum, COL.ORDERS.STATUS + 1).setValue(nextStatus);
        orderSheet.getRange(rowNum, COL.ORDERS.UPDATED_AT + 1).setValue(nowStr);
        updatedCount++;
      }
    }

    if (updatedCount === 0) {
      return { success: false, message: '対象の引き渡し待ち注文が見つかりませんでした。' };
    }

    SpreadsheetApp.flush();

    return {
      success: true,
      updatedCount: updatedCount,
      message: `${targetUid} の注文（${updatedCount}件）を更新しました。`
    };
  });
}

function handleUpdateStatus_(payload) {
  return withScriptLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const staff = verifyStaffCredentials_(ss, payload.account, payload.pin);
    if (!staff) {
      return { success: false, authError: true, message: 'スタッフ認証エラーです。' };
    }

    const targetOrderId = String(payload.orderId || '').trim().toUpperCase();
    const nextStatus = Number(payload.status);
    if (!targetOrderId || isNaN(nextStatus)) {
      return { success: false, message: '注文IDまたはステータスが不正です。' };
    }

    const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    const rows = orderSheet.getDataRange().getValues();
    const nowStr = formatDateTime_(new Date());

    for (let i = 1; i < rows.length; i++) {
      const rowOrderId = String(rows[i][COL.ORDERS.ID] || '').trim().toUpperCase();
      if (rowOrderId === targetOrderId) {
        const rowNum = i + 1;
        orderSheet.getRange(rowNum, COL.ORDERS.STATUS + 1).setValue(nextStatus);
        orderSheet.getRange(rowNum, COL.ORDERS.UPDATED_AT + 1).setValue(nowStr);

        if (nextStatus === ORDER_STATUS.CANCELED) {
          invalidateProductsCache_();
        }
        SpreadsheetApp.flush();

        return {
          success: true,
          message: `注文 ${targetOrderId} のステータスを更新しました。`
        };
      }
    }

    return { success: false, message: `注文ID「${targetOrderId}」が見つかりません。` };
  });
}

// ==========================================
// 4. 時間主導・編集トリガー処理
// ==========================================
function autoCancelExpiredOrders() {
  withScriptLock_(() => {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
    if (!orderSheet) return;

    const rows = orderSheet.getDataRange().getValues();
    const now = new Date();
    const nowStr = formatDateTime_(now);
    let canceledCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const status = Number(rows[i][COL.ORDERS.STATUS]);
      if (status !== ORDER_STATUS.UNPAID) continue;

      const createdRaw = rows[i][COL.ORDERS.CREATED_AT];
      const createdDate = createdRaw instanceof Date ? createdRaw : new Date(String(createdRaw));
      if (isNaN(createdDate.getTime())) continue;

      if (now.getTime() - createdDate.getTime() >= ORDER_EXPIRE_MS) {
        const rowNum = i + 1;
        orderSheet.getRange(rowNum, COL.ORDERS.STATUS + 1).setValue(ORDER_STATUS.CANCELED);
        orderSheet.getRange(rowNum, COL.ORDERS.UPDATED_AT + 1).setValue(nowStr);
        canceledCount++;
      }
    }

    if (canceledCount > 0) {
      invalidateProductsCache_();
      SpreadsheetApp.flush();
    }
  });
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheetName = e.range.getSheet().getName();
  if (sheetName === SHEET_NAMES.PRODUCTS || sheetName === SHEET_NAMES.ORDERS) {
    invalidateProductsCache_();
  }
}

// ==========================================
// 5. データアクセス・行データ変換（マッピング層）
// ==========================================
function getProductsWithRealtimeStock_(ss, forceRefresh = false) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get(CACHE_KEY_PRODUCTS);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // キャッシュ破損時は再計算へフォールバック
      }
    }
  }

  const productSheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  if (!productSheet) return [];

  const allOrders = getAllOrders_(ss);
  const reservedQtyMap = {};

  allOrders.forEach(order => {
    if (!ACTIVE_STOCK_STATUSES.includes(order.status)) return;
    order.items.forEach(item => {
      reservedQtyMap[item.id] = (reservedQtyMap[item.id] || 0) + item.qty;
    });
  });

  const pRows = productSheet.getDataRange().getValues();
  const result = [];

  for (let i = 1; i < pRows.length; i++) {
    const prod = parseProductRow_(pRows[i]);
    if (!prod.id && !prod.name) continue;

    const reserved = reservedQtyMap[prod.id] || 0;
    prod.stock = Math.max(0, prod.initial_stock - reserved);
    result.push(prod);
  }

  try {
    cache.put(CACHE_KEY_PRODUCTS, JSON.stringify(result), CACHE_TTL_SECONDS);
  } catch (e) {
    // キャッシュ上限超過時は無視
  }

  return result;
}

function parseProductRow_(row) {
  const rawStatus = row[COL.PRODUCTS.STATUS];
  const isActive = (rawStatus === true || String(rawStatus).toUpperCase() === 'TRUE' || Number(rawStatus) === 1);

  return {
    id: String(row[COL.PRODUCTS.ID] || '').trim(),
    name: String(row[COL.PRODUCTS.NAME] || '').trim(),
    price: Number(row[COL.PRODUCTS.PRICE]) || 0,
    initial_stock: Number(row[COL.PRODUCTS.STOCK]) || 0,
    stock: 0,
    limit: Math.max(1, Number(row[COL.PRODUCTS.LIMIT]) || 1),
    image_url: String(row[COL.PRODUCTS.IMAGE_URL] || '').trim(),
    status: isActive
  };
}

function getAllOrders_(ss) {
  const orderSheet = ss.getSheetByName(SHEET_NAMES.ORDERS);
  if (!orderSheet) return [];

  const rows = orderSheet.getDataRange().getValues();
  const orders = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseOrderRow_(rows[i]);
    if (parsed.id) orders.push(parsed);
  }
  return orders;
}

function parseOrderRow_(row) {
  const rawItems = String(row[COL.ORDERS.ITEMS] || '').trim();
  let account = '';
  let userId = '';
  let items = [];

  if (rawItems) {
    try {
      const parsedJson = JSON.parse(rawItems);
      if (Array.isArray(parsedJson)) {
        items = parsedJson;
      } else if (parsedJson && typeof parsedJson === 'object') {
        account = normalizeEmail_(parsedJson.account);
        userId = String(parsedJson.user_id || '').trim();
        items = Array.isArray(parsedJson.items) ? parsedJson.items : [];
      }
    } catch (e) {
      items = [];
    }
  }

  return {
    id: String(row[COL.ORDERS.ID] || '').trim(),
    created_at: formatCellDate_(row[COL.ORDERS.CREATED_AT]),
    total_price: Number(row[COL.ORDERS.TOTAL_PRICE]) || 0,
    status: Number(row[COL.ORDERS.STATUS]),
    updated_at: formatCellDate_(row[COL.ORDERS.UPDATED_AT]),
    account: account,
    user_id: userId,
    items: items.map(it => ({
      id: String(it.id || '').trim(),
      name: String(it.name || '').trim(),
      price: Number(it.price) || 0,
      qty: Number(it.qty) || 0
    })),
    received_amount: Number(row[COL.ORDERS.RECEIVED_AMOUNT]) || 0
  };
}

function getAllUsers_(ss) {
  const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
  if (!userSheet) return [];

  const rows = userSheet.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseUserRow_(rows[i]);
    if (parsed.user_id && parsed.account) users.push(parsed);
  }
  return users;
}

function parseUserRow_(row) {
  return {
    user_id: String(row[COL.USERS.USER_ID] || '').trim(),
    account: normalizeEmail_(row[COL.USERS.ACCOUNT]),
    created_at: formatCellDate_(row[COL.USERS.CREATED_AT])
  };
}

function getOrCreateUser_(ss, account) {
  const normalized = normalizeEmail_(account);
  const existingUsers = getAllUsers_(ss);
  const found = existingUsers.find(u => u.account === normalized);
  if (found) return found;

  return withScriptLock_(() => {
    const refreshedUsers = getAllUsers_(ss);
    const rechecked = refreshedUsers.find(u => u.account === normalized);
    if (rechecked) return rechecked;

    let maxNum = 1000;
    refreshedUsers.forEach(u => {
      const m = u.user_id.match(/^USR-(\d+)$/i);
      if (m) {
        const num = Number(m[1]);
        if (num > maxNum) maxNum = num;
      }
    });

    const newUserId = `USR-${maxNum + 1}`;
    const nowStr = formatDateTime_(new Date());
    const userSheet = ss.getSheetByName(SHEET_NAMES.USERS);
    userSheet.appendRow([newUserId, normalized, nowStr]);
    SpreadsheetApp.flush();

    return {
      user_id: newUserId,
      account: normalized,
      created_at: nowStr
    };
  });
}

// ==========================================
// 6. スタッフ認証・共通ヘルパー
// ==========================================
function findStaffByAccount_(ss, account) {
  const normalized = normalizeEmail_(account);
  if (!normalized) return null;

  const staffSheet = ss.getSheetByName(SHEET_NAMES.STAFFS);
  if (!staffSheet) return null;

  const rows = staffSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const rowAcc = normalizeEmail_(rows[i][COL.STAFFS.ACCOUNT]);
    if (rowAcc === normalized) {
      return {
        name: String(rows[i][COL.STAFFS.NAME] || 'スタッフ').trim(),
        account: rowAcc,
        pin: String(rows[i][COL.STAFFS.PIN] || '').trim()
      };
    }
  }
  return null;
}

function verifyStaffCredentials_(ss, account, pin) {
  const staff = findStaffByAccount_(ss, account);
  if (!staff) return null;
  const inputPin = String(pin || '').trim();
  if (!inputPin || staff.pin !== inputPin) return null;
  return staff;
}

function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('現在アクセスが集中しています。数秒おいてから再度お試しください。');
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function invalidateProductsCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY_PRODUCTS);
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function generateOrderId_() {
  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HHmmss');
  const rand = Math.floor(100 + Math.random() * 900);
  return `ORD-${ts}${rand}`;
}

function formatDateTime_(dateObj) {
  return Utilities.formatDate(dateObj, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}

function formatCellDate_(val) {
  if (!val) return '';
  if (val instanceof Date) return formatDateTime_(val);
  return String(val).trim();
}

function createJsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
