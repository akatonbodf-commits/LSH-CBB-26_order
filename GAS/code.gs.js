/**
 * 2026 CBB イベント物販・POSレジシステム バックエンド (GAS v3.4)
 * - ordersシートに received_amount（お預かり金額）列を追加し、一括決済時に記録
 */

const CACHE_TTL = 21600; // 6時間 (秒)
const ORDER_TIMEOUT_MS = 60 * 60 * 1000; // 1時間自動キャンセル閾値
const ORDER_HEADERS = ['id', 'created_at', 'total_price', 'status', 'updated_at', 'items', 'received_amount'];

function onEdit(e) {
  clearProductCache_();
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#edf2f7');
      sheet.setFrozenRows(1);
    }
  } else if (headers && headers.length > 0) {
    // 既存シートに不足している末尾ヘッダ列があれば自動補完
    const lastCol = sheet.getLastColumn();
    if (lastCol < headers.length) {
      const missingHeaders = headers.slice(lastCol);
      sheet.getRange(1, lastCol + 1, 1, missingHeaders.length)
        .setValues([missingHeaders])
        .setFontWeight('bold')
        .setBackground('#edf2f7');
    }
  }
  return sheet;
}

/**
 * GET API: ユーザー用公開データ取得 / スタッフ用管理データ取得
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action || 'public';

  try {
    if (params.force === '1') {
      clearProductCache_();
    }

    // ① ユーザー用注文画面向け
    if (action === 'public') {
      const account = (params.account || '').trim().toLowerCase();
      const products = getCachedProducts_();
      let userInfo = null;
      let myOrders = [];
      let isStaff = false;

      if (account) {
        userInfo = getOrCreateUser_(account);
        myOrders = getUserOrders_(account);
        isStaff = isStaffAccount_(account);
      }

      return createJsonResponse_({
        success: true,
        message: 'データを取得しました',
        user: userInfo,
        isStaff: isStaff,
        products: products,
        myOrders: myOrders,
        timestamp: new Date().toISOString()
      });
    }

    // ② スタッフ用管理画面向け（Gmail + PIN認証必須）
    if (action === 'staff') {
      const account = (params.account || '').trim().toLowerCase();
      const pin = String(params.pin || '').trim();
      const staff = verifyStaffCredentials_(account, pin);

      if (!staff) {
        return createJsonResponse_({
          success: false,
          authError: true,
          message: 'スタッフ認証に失敗しました。staffsシートの登録内容・パスコードを確認してください。'
        });
      }

      const fullData = getFullAdminData_();
      return createJsonResponse_({
        success: true,
        message: '管理データを取得しました',
        staffName: staff.name,
        products: fullData.products,
        orders: fullData.orders,
        users: fullData.users,
        timestamp: new Date().toISOString()
      });
    }

    return createJsonResponse_({ success: false, message: '不正なアクションです' });
  } catch (err) {
    return createJsonResponse_({ success: false, message: 'サーバーエラー: ' + err.message });
  }
}

/**
 * POST API: 注文確定・ユーザー単位一括決済・ユーザー単位引き渡し更新・個別ステータス更新
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (!lock.tryLock(10000)) {
      return createJsonResponse_({ success: false, message: 'アクセスが集中しています。数秒後に再度お試しください。' });
    }

    if (action === 'createOrder') {
      return handleCreateOrder_(payload);
    } else if (action === 'payAllByUser') {
      return handlePayAllByUser_(payload);
    } else if (action === 'updateStatusByUser') {
      return handleUpdateStatusByUser_(payload);
    } else if (action === 'updateStatus') {
      return handleUpdateStatus_(payload);
    } else if (action === 'cancelExpired') {
      const count = cancelExpiredOrdersCore_();
      return createJsonResponse_({ success: true, message: `${count}件の期限切れ注文をキャンセルしました` });
    }

    return createJsonResponse_({ success: false, message: '不明なリクエストです' });

  } catch (err) {
    return createJsonResponse_({ success: false, message: '処理中にエラーが発生しました: ' + err.message });
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function getOrCreateUser_(account) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ensureSheet_(ss, 'users', ['user_id', 'account', 'created_at']);

  const rows = userSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim().toLowerCase() === account) {
      return {
        user_id: String(rows[i][0]).trim(),
        account: account
      };
    }
  }

  const nextNum = 1000 + rows.length;
  const newUserId = 'USR-' + nextNum;
  const nowIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  userSheet.appendRow([newUserId, account, nowIso]);
  SpreadsheetApp.flush();

  return {
    user_id: newUserId,
    account: account
  };
}

function handleCreateOrder_(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);

  const account = (payload.account || '').trim().toLowerCase();
  const cartItems = payload.items || [];

  if (!account || cartItems.length === 0) {
    return createJsonResponse_({ success: false, message: 'アカウントまたはカートが空です' });
  }

  const userInfo = getOrCreateUser_(account);
  const latestProducts = computeProductsWithLiveStock_(ss);
  const productMap = {};
  latestProducts.forEach(p => { productMap[p.id] = p; });

  const now = new Date();
  const nowIso = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const orderId = 'ORD-' + Utilities.formatDate(now, 'Asia/Tokyo', 'HHmmss') + '-' + Math.floor(100 + Math.random() * 900);

  let totalPrice = 0;
  let isOutOfStock = false;
  let errorReason = '';

  for (const item of cartItems) {
    const prod = productMap[String(item.id)];
    const qty = Number(item.qty);
    if (!prod || !prod.status) {
      isOutOfStock = true;
      errorReason = `商品「${item.name}」は現在販売停止中です`;
      break;
    }
    if (qty <= 0 || qty > prod.limit) {
      isOutOfStock = true;
      errorReason = `商品「${prod.name}」の購入上限（${prod.limit}点）を超えています`;
      break;
    }
    if (prod.stock < qty) {
      isOutOfStock = true;
      errorReason = `商品「${prod.name}」の在庫が不足しています（残り${prod.stock}点）`;
      break;
    }
    totalPrice += prod.price * qty;
  }

  const itemsWithMeta = cartItems.map(item => ({
    id: String(item.id),
    name: String(item.name),
    qty: Number(item.qty),
    price: Number(item.price),
    account: account,
    user_id: userInfo.user_id
  }));

  if (isOutOfStock) {
    orderSheet.appendRow([orderId, nowIso, totalPrice, 4, nowIso, JSON.stringify(itemsWithMeta), 0]);
    clearProductCache_();
    return createJsonResponse_({ success: false, message: errorReason, orderId: orderId });
  }

  // 新規注文時は未決済のため received_amount は 0 で初期化
  orderSheet.appendRow([orderId, nowIso, totalPrice, 0, nowIso, JSON.stringify(itemsWithMeta), 0]);
  SpreadsheetApp.flush();
  clearProductCache_();

  return createJsonResponse_({
    success: true,
    message: '注文が確定しました',
    user: userInfo,
    order: {
      id: orderId,
      created_at: nowIso,
      total_price: totalPrice,
      status: 0,
      items: itemsWithMeta,
      account: account,
      user_id: userInfo.user_id,
      received_amount: 0
    }
  });
}

/**
 * ユーザーの未決済注文を一括決済し、受け取った金額（received_amount）を記録する
 */
function handlePayAllByUser_(payload) {
  const staffAcc = (payload.account || '').trim().toLowerCase();
  const pin = String(payload.pin || '').trim();
  if (!verifyStaffCredentials_(staffAcc, pin)) {
    return createJsonResponse_({ success: false, message: 'スタッフ権限がありません' });
  }

  const targetUserId = String(payload.userId || '').trim().toUpperCase();
  if (!targetUserId) {
    return createJsonResponse_({ success: false, message: 'ユーザーIDが指定されていません' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ensureSheet_(ss, 'users', ['user_id', 'account', 'created_at']);
  const userRows = userSheet.getDataRange().getValues();
  let targetAccount = '';

  for (let i = 1; i < userRows.length; i++) {
    if (String(userRows[i][0] || '').trim().toUpperCase() === targetUserId) {
      targetAccount = String(userRows[i][1] || '').trim().toLowerCase();
      break;
    }
  }

  if (!targetAccount) {
    return createJsonResponse_({ success: false, message: `ユーザーID「${targetUserId}」が見つかりません` });
  }

  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const data = orderSheet.getDataRange().getValues();
  const nowIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  const targetRowIndices = [];
  let sumTotalPrice = 0;

  for (let i = 1; i < data.length; i++) {
    const status = Number(data[i][3]);
    if (status === 0) {
      try {
        const items = JSON.parse(data[i][5]);
        const orderAcc = (items.length > 0 && items[0].account) ? items[0].account.toLowerCase() : '';
        const orderUid = (items.length > 0 && items[0].user_id) ? items[0].user_id.toUpperCase() : '';
        if (orderUid === targetUserId || orderAcc === targetAccount) {
          targetRowIndices.push(i);
          sumTotalPrice += Number(data[i][2] || 0);
        }
      } catch (e) {}
    }
  }

  if (targetRowIndices.length === 0) {
    return createJsonResponse_({ success: false, message: 'このユーザーの未決済注文は0件です' });
  }

  // 受け取った金額の確定（未指定または不正な場合は合計金額と同額とする）
  const rawReceived = Number(payload.receivedAmount);
  const receivedAmount = (!isNaN(rawReceived) && rawReceived >= sumTotalPrice) ? rawReceived : sumTotalPrice;

  targetRowIndices.forEach((rowIdx, idx) => {
    orderSheet.getRange(rowIdx + 1, 4).setValue(1); // status -> 1 (決済済み)
    orderSheet.getRange(rowIdx + 1, 5).setValue(nowIso); // updated_at
    // 複数注文一括決済時は先頭行にお預かり金額を記録し、2件目以降は0を記録して重複集計を防止
    orderSheet.getRange(rowIdx + 1, 7).setValue(idx === 0 ? receivedAmount : 0);
  });

  SpreadsheetApp.flush();
  clearProductCache_();

  return createJsonResponse_({
    success: true,
    message: `${targetRowIndices.length}件の注文を一括決済完了にしました`,
    updatedCount: targetRowIndices.length,
    receivedAmount: receivedAmount
  });
}

function handleUpdateStatusByUser_(payload) {
  const staffAcc = (payload.account || '').trim().toLowerCase();
  const pin = String(payload.pin || '').trim();
  if (!verifyStaffCredentials_(staffAcc, pin)) {
    return createJsonResponse_({ success: false, message: 'スタッフ権限がありません' });
  }

  const targetUserId = String(payload.userId || '').trim().toUpperCase();
  const nextStatus = Number(payload.nextStatus);

  if (!targetUserId || (nextStatus !== 2 && nextStatus !== 3)) {
    return createJsonResponse_({ success: false, message: 'パラメータが不正です' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userSheet = ensureSheet_(ss, 'users', ['user_id', 'account', 'created_at']);
  const userRows = userSheet.getDataRange().getValues();
  let targetAccount = '';

  for (let i = 1; i < userRows.length; i++) {
    if (String(userRows[i][0] || '').trim().toUpperCase() === targetUserId) {
      targetAccount = String(userRows[i][1] || '').trim().toLowerCase();
      break;
    }
  }

  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const data = orderSheet.getDataRange().getValues();
  const nowIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  let updatedCount = 0;

  for (let i = 1; i < data.length; i++) {
    const status = Number(data[i][3]);
    const isTargetStatus = (nextStatus === 2) ? (status === 1) : (status === 1 || status === 2);
    if (isTargetStatus) {
      try {
        const items = JSON.parse(data[i][5]);
        const orderAcc = (items.length > 0 && items[0].account) ? items[0].account.toLowerCase() : '';
        const orderUid = (items.length > 0 && items[0].user_id) ? items[0].user_id.toUpperCase() : '';
        if (orderUid === targetUserId || (targetAccount && orderAcc === targetAccount)) {
          orderSheet.getRange(i + 1, 4).setValue(nextStatus);
          orderSheet.getRange(i + 1, 5).setValue(nowIso);
          updatedCount++;
        }
      } catch (e) {}
    }
  }

  if (updatedCount === 0) {
    return createJsonResponse_({ success: false, message: '対象の注文が見つかりませんでした（すでに更新済みの可能性があります）' });
  }

  SpreadsheetApp.flush();
  clearProductCache_();

  return createJsonResponse_({
    success: true,
    message: `${updatedCount}件の注文を更新しました`,
    updatedCount: updatedCount
  });
}

function handleUpdateStatus_(payload) {
  const account = (payload.account || '').trim().toLowerCase();
  const pin = String(payload.pin || '').trim();
  if (!verifyStaffCredentials_(account, pin)) {
    return createJsonResponse_({ success: false, message: 'スタッフ権限がありません' });
  }

  const orderId = String(payload.orderId || '').trim();
  const nextStatus = Number(payload.status);

  if (!orderId || isNaN(nextStatus) || nextStatus < 0 || nextStatus > 4) {
    return createJsonResponse_({ success: false, message: 'パラメータが不正です' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const data = orderSheet.getDataRange().getValues();
  const nowIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === orderId) {
      const currentStatus = Number(data[i][3]);
      if (currentStatus === 4 && nextStatus !== 4) {
        return createJsonResponse_({ success: false, message: 'すでにキャンセル済みの注文です' });
      }
      orderSheet.getRange(i + 1, 4).setValue(nextStatus);
      orderSheet.getRange(i + 1, 5).setValue(nowIso);

      SpreadsheetApp.flush();
      clearProductCache_();

      return createJsonResponse_({
        success: true,
        message: 'ステータスを更新しました',
        orderId: orderId,
        status: nextStatus
      });
    }
  }

  return createJsonResponse_({ success: false, message: '該当する注文IDが見つかりません' });
}

function autoCancelExpiredOrders() {
  const lock = LockService.getScriptLock();
  try {
    if (lock.tryLock(10000)) {
      cancelExpiredOrdersCore_();
    }
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function cancelExpiredOrdersCore_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const data = orderSheet.getDataRange().getValues();
  const now = new Date();
  const nowIso = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  let canceledCount = 0;

  for (let i = 1; i < data.length; i++) {
    const status = Number(data[i][3]);
    if (status === 0) {
      const createdAt = new Date(data[i][1]);
      if (!isNaN(createdAt.getTime()) && (now.getTime() - createdAt.getTime() >= ORDER_TIMEOUT_MS)) {
        orderSheet.getRange(i + 1, 4).setValue(4);
        orderSheet.getRange(i + 1, 5).setValue(nowIso);
        canceledCount++;
      }
    }
  }

  if (canceledCount > 0) {
    SpreadsheetApp.flush();
    clearProductCache_();
  }
  return canceledCount;
}

function getCachedProducts_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('public_products');
  if (cached) {
    return JSON.parse(cached);
  }

  const lock = LockService.getScriptLock();
  try {
    if (lock.tryLock(10000)) {
      const recheck = cache.get('public_products');
      if (recheck) {
        return JSON.parse(recheck);
      }
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const products = computeProductsWithLiveStock_(ss);
      cache.put('public_products', JSON.stringify(products), CACHE_TTL);
      return products;
    } else {
      return computeProductsWithLiveStock_(SpreadsheetApp.getActiveSpreadsheet());
    }
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function computeProductsWithLiveStock_(ss) {
  const productSheet = ensureSheet_(ss, 'products', ['id', 'name', 'price', 'stock', 'limit', 'image_url', 'status']);
  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);

  const productRows = productSheet.getDataRange().getValues();
  const orderRows = orderSheet.getDataRange().getValues();

  const reservedMap = {};
  for (let i = 1; i < orderRows.length; i++) {
    const r = orderRows[i];
    if (!r[0]) continue;
    const status = Number(r[3]);
    if (status >= 0 && status <= 3) {
      try {
        const items = JSON.parse(r[5]);
        items.forEach(item => {
          const pid = String(item.id).trim();
          reservedMap[pid] = (reservedMap[pid] || 0) + Number(item.qty || 0);
        });
      } catch (e) {}
    }
  }

  const products = [];
  const seenIds = new Set();

  for (let i = 1; i < productRows.length; i++) {
    const r = productRows[i];
    if (!r[0] && !r[1]) continue;

    let id = String(r[0] || '').trim();
    if (!id || seenIds.has(id)) {
      id = (id || 'ITEM') + '_ROW' + (i + 1);
    }
    seenIds.add(id);

    const initialStock = Math.max(0, Number(r[3]) || 0);
    const reserved = reservedMap[id] || 0;
    const remainingStock = Math.max(0, initialStock - reserved);
    const limitNum = Math.max(1, Number(r[4]) || 1);

    const rawStatus = r[6];
    const isActive = (rawStatus === true || String(rawStatus).toUpperCase() === 'TRUE' || Number(rawStatus) === 1);

    products.push({
      id: id,
      name: String(r[1] || '名称未設定'),
      price: Math.max(0, Number(r[2]) || 0),
      stock: remainingStock,
      limit: limitNum,
      image_url: convertDriveUrl_(String(r[5] || '')),
      status: isActive
    });
  }
  return products;
}

function getUserOrders_(account) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const orderRows = orderSheet.getDataRange().getValues();
  const result = [];

  for (let i = 1; i < orderRows.length; i++) {
    const r = orderRows[i];
    if (!r[0]) continue;
    const status = Number(r[3]);
    if (status === 4) continue;

    try {
      const items = JSON.parse(r[5]);
      const orderAccount = (items.length > 0 && items[0].account) ? items[0].account.toLowerCase() : '';
      const userId = (items.length > 0 && items[0].user_id) ? items[0].user_id : '';
      if (orderAccount === account) {
        result.push({
          id: String(r[0]),
          created_at: r[1] instanceof Date ? Utilities.formatDate(r[1], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : String(r[1]),
          total_price: Number(r[2]),
          status: status,
          items: items,
          account: orderAccount,
          user_id: userId,
          received_amount: Number(r[6] || 0)
        });
      }
    } catch (e) {}
  }
  return result;
}

function getFullAdminData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const products = computeProductsWithLiveStock_(ss);

  const userSheet = ensureSheet_(ss, 'users', ['user_id', 'account', 'created_at']);
  const userRows = userSheet.getDataRange().getValues();
  const users = [];
  const accToUid = {};
  for (let i = 1; i < userRows.length; i++) {
    if (!userRows[i][0]) continue;
    const uid = String(userRows[i][0]).trim();
    const acc = String(userRows[i][1] || '').trim().toLowerCase();
    users.push({ user_id: uid, account: acc });
    accToUid[acc] = uid;
  }

  const orderSheet = ensureSheet_(ss, 'orders', ORDER_HEADERS);
  const orderRows = orderSheet.getDataRange().getValues();
  const orders = [];

  for (let i = 1; i < orderRows.length; i++) {
    const r = orderRows[i];
    if (!r[0]) continue;
    let parsedItems = [];
    try {
      parsedItems = JSON.parse(r[5]);
    } catch (e) {}
    const account = (parsedItems.length > 0 && parsedItems[0].account) ? parsedItems[0].account.toLowerCase() : '';
    const userId = (parsedItems.length > 0 && parsedItems[0].user_id) ? parsedItems[0].user_id : (accToUid[account] || '');

    orders.push({
      id: String(r[0]),
      created_at: r[1] instanceof Date ? Utilities.formatDate(r[1], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : String(r[1]),
      total_price: Number(r[2]),
      status: Number(r[3]),
      updated_at: r[4] instanceof Date ? Utilities.formatDate(r[4], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss') : String(r[4]),
      items: parsedItems,
      account: account,
      user_id: userId,
      received_amount: Number(r[6] || 0)
    });
  }
  return { products, orders, users };
}

function isStaffAccount_(account) {
  if (!account) return false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const staffSheet = ensureSheet_(ss, 'staffs', ['name', 'account', 'pin']);
  const rows = staffSheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const rowAccount = String(rows[i][1] || '').trim().toLowerCase();
    if (rowAccount === account) {
      return true;
    }
  }
  return false;
}

function verifyStaffCredentials_(account, pin) {
  if (!account || !pin) return null;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const staffSheet = ensureSheet_(ss, 'staffs', ['name', 'account', 'pin']);
  const rows = staffSheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[1]) continue;
    const rowAccount = String(r[1]).trim().toLowerCase();
    const rowPin = String(r[2] || '').trim();
    if (rowAccount === account && rowPin === pin) {
      return { name: String(r[0] || 'スタッフ'), account: rowAccount };
    }
  }
  return null;
}

function clearProductCache_() {
  CacheService.getScriptCache().remove('public_products');
}

function convertDriveUrl_(url) {
  if (!url) return '';
  const match = url.match(/(?:\/d\/|id=)([a-zA-Z0-9_-]{25,})/);
  if (match && match[1]) {
    return 'https://lh3.googleusercontent.com/d/' + match[1];
  }
  return url;
}

function createJsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}