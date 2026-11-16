/**
 * 2026 CBB イベント物販・POSレジシステム スタッフ管理画面スクリプト (js/staff.js v3.6)
 * - レジ金種クイックボタン（ちょうど / +1,000 / +5,000 / +10,000 / クリア）
 * - 完了済み履歴の簡易確認（最新10件）＆誤完了時の差し戻し
 * - ダッシュボードへのレジ締め集計（総売上・お預かり総額・お釣り総額）
 */

// ==========================================
// グローバル状態管理
// ==========================================
let staffAccount = "";
let staffPin = "";
let staffName = "";

let products = [];
let orders = [];
let users = [];

let selectedPosUserId = "";
let currentPosUnpaidTotal = 0;
let selectedHandoverUserId = "";

// カメラ・軽量スキャン制御用
let videoStream = null;
let scanning = false;
let scanCanvas = null;
let scanCtx = null;
let scanTimerId = null;
let lastScannedCode = "";
let lastScannedTime = 0;

// 自動同期タイマーID
let pollTimerId = null;

// ==========================================
// 1. 初期化・認証・同期管理
// ==========================================
window.addEventListener("DOMContentLoaded", initStaffPage);
window.addEventListener("beforeunload", stopCamera);

function bindEnterKey(elementId, callback) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      callback();
    }
  });
}

async function initStaffPage() {
  bindEnterKey("auth-gmail", submitStaffAuth);
  bindEnterKey("auth-pin", submitStaffAuth);
  bindEnterKey("manual-user-id", searchUserManual);
  bindEnterKey("pos-deposit", () => {
    const payBtn = document.getElementById("btn-complete-pay");
    if (payBtn && !payBtn.disabled) {
      completeBatchPayment();
    }
  });

  const savedAccount = (localStorage.getItem("cbb_user_account") || "").trim().toLowerCase();
  const sessionAccount = (sessionStorage.getItem("cbb_staff_account") || "").trim().toLowerCase();
  const sessionPin = (sessionStorage.getItem("cbb_staff_pin") || "").trim();

  const gmailInput = document.getElementById("auth-gmail");
  if (sessionAccount) {
    gmailInput.value = sessionAccount;
  } else if (savedAccount) {
    gmailInput.value = savedAccount;
  }

  if (sessionAccount && sessionPin) {
    document.getElementById("auth-pin").value = sessionPin;
    await submitStaffAuth();
  } else {
    setTimeout(() => gmailInput.focus(), 50);
  }
}

async function submitStaffAuth() {
  const gmailInput = document.getElementById("auth-gmail");
  const pinInput = document.getElementById("auth-pin");
  const errorEl = document.getElementById("auth-error-msg");
  const loginBtn = document.getElementById("btn-staff-login");

  if (loginBtn.disabled) return;

  const account = gmailInput.value.trim().toLowerCase();
  const pin = pinInput.value.trim();

  if (!account || !account.includes("@")) {
    errorEl.textContent = "有効なGmailアドレスを入力してください。";
    gmailInput.focus();
    return;
  }
  if (!pin) {
    errorEl.textContent = "スタッフパスコード（PIN）を入力してください。";
    pinInput.focus();
    return;
  }

  errorEl.textContent = "";
  loginBtn.disabled = true;
  loginBtn.textContent = "認証中...";

  try {
    const data = await apiGet(
      "staff",
      { account, pin, force: "1" },
      { loadingText: "スタッフ認証・管理データを取得中..." }
    );

    staffAccount = account;
    staffPin = pin;
    staffName = data.staffName || "スタッフ";

    sessionStorage.setItem("cbb_staff_account", staffAccount);
    sessionStorage.setItem("cbb_staff_pin", staffPin);
    localStorage.setItem("cbb_user_account", staffAccount);

    products = data.products || [];
    orders = data.orders || [];
    users = data.users || [];

    document.getElementById("staff-auth-modal").classList.remove("active");
    document.getElementById("staff-app").style.display = "block";
    document.getElementById("staff-name-badge").textContent = `担当: ${staffName}`;

    updateLastSyncLabel();
    renderAllStaffViews();

    if (pollTimerId) clearInterval(pollTimerId);
    pollTimerId = setInterval(
      () => refreshAll({ isManual: false, silent: true }),
      APP_CONFIG.STAFF_POLL_INTERVAL
    );

  } catch (err) {
    sessionStorage.removeItem("cbb_staff_account");
    sessionStorage.removeItem("cbb_staff_pin");
    errorEl.textContent = err.message || "認証に失敗しました。";
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "認証する";
  }
}

function cancelStaffAuth() {
  window.location.replace("index.html");
}

async function refreshAll(arg = false) {
  if (!staffAccount || !staffPin) return;

  const isManual = typeof arg === "boolean" ? arg : Boolean(arg.isManual);
  const silent = typeof arg === "boolean" ? !arg : Boolean(arg.silent);
  const loadingText = (typeof arg === "object" && arg.loadingText)
    ? arg.loadingText
    : "最新データを同期中...";

  const syncEl = document.getElementById("last-sync-text");

  try {
    if (isManual) syncEl.textContent = "同期中...";
    const params = { account: staffAccount, pin: staffPin };
    if (isManual) params.force = "1";

    const data = await apiGet("staff", params, { silent, loadingText });

    products = data.products || [];
    orders = data.orders || [];
    users = data.users || [];

    updateLastSyncLabel();
    renderAllStaffViews();
  } catch (err) {
    if (err.authError) {
      sessionStorage.removeItem("cbb_staff_account");
      sessionStorage.removeItem("cbb_staff_pin");
      alert("スタッフ認証が無効になりました。注文画面へ移動します。");
      window.location.replace("index.html");
      return;
    }
    syncEl.textContent = "同期エラー";
    if (isManual) {
      alert("データの更新に失敗しました:\n" + err.message);
    }
  }
}

function updateLastSyncLabel() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("last-sync-text").textContent = `最終同期 ${hh}:${mm}:${ss}`;
}

function renderAllStaffViews() {
  renderHandoverList();
  renderCompletedHistory();
  renderDashboard();

  if (selectedPosUserId) {
    loadUserOrdersIntoPos(selectedPosUserId, false);
  }

  if (selectedHandoverUserId) {
    const groups = buildHandoverUserGroups();
    if (groups.some(g => g.userId === selectedHandoverUserId)) {
      selectHandoverUser(selectedHandoverUserId);
    } else {
      selectedHandoverUserId = "";
    }
  }
}

function switchTab(tabName, btn) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`panel-${tabName}`).classList.add("active");
}

// ==========================================
// 2. レジ決済（POS）・軽量ライブカメラQRスキャン＆金種ボタン機能
// ==========================================
async function toggleCamera() {
  if (scanning) {
    stopCamera();
    return;
  }

  const btn = document.getElementById("btn-toggle-cam");
  const video = document.getElementById("qr-video");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("このブラウザはカメラのライブ起動に対応していません。ユーザーIDを手入力してください。");
    return;
  }

  btn.disabled = true;
  btn.textContent = "カメラ起動中...";

  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    });

    video.srcObject = videoStream;
    await video.play();

    if (!scanCanvas) {
      scanCanvas = document.createElement("canvas");
      scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
    }

    scanning = true;
    btn.disabled = false;
    btn.textContent = "カメラ停止";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-secondary");

    scheduleNextScan();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "カメラ起動";
    alert("カメラを起動できませんでした。ブラウザのカメラ権限を許可するか、ユーザーIDを手入力してください。");
  }
}

function stopCamera() {
  scanning = false;
  if (scanTimerId) {
    clearTimeout(scanTimerId);
    scanTimerId = null;
  }
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
  const video = document.getElementById("qr-video");
  if (video) {
    video.srcObject = null;
  }
  const btn = document.getElementById("btn-toggle-cam");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "カメラ起動";
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-primary");
  }
}

function scheduleNextScan() {
  if (!scanning) return;
  scanTimerId = setTimeout(processVideoFrame, 250);
}

function processVideoFrame() {
  if (!scanning) return;

  const video = document.getElementById("qr-video");
  const posPanel = document.getElementById("panel-pos");

  if (document.hidden || !posPanel.classList.contains("active")) {
    scheduleNextScan();
    return;
  }

  if (video && video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
    const targetMax = 360;
    const scale = Math.min(1, targetMax / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.floor(video.videoWidth * scale);
    const h = Math.floor(video.videoHeight * scale);

    if (scanCanvas.width !== w || scanCanvas.height !== h) {
      scanCanvas.width = w;
      scanCanvas.height = h;
    }

    scanCtx.drawImage(video, 0, 0, w, h);
    const imageData = scanCtx.getImageData(0, 0, w, h);

    const code = jsQR(imageData.data, w, h, {
      inversionAttempts: "dontInvert"
    });

    if (code && code.data) {
      const scannedCode = code.data.trim().toUpperCase();
      const now = Date.now();

      if (scannedCode !== lastScannedCode || now - lastScannedTime > 3000) {
        lastScannedCode = scannedCode;
        lastScannedTime = now;

        document.getElementById("manual-user-id").value = scannedCode;
        searchUserManual();
      }
    }
  }

  scheduleNextScan();
}

async function searchUserManual() {
  const inputEl = document.getElementById("manual-user-id");
  let query = inputEl.value.trim().toUpperCase();
  if (!query) {
    alert("ユーザーIDを入力してください。");
    inputEl.focus();
    return;
  }

  await refreshAll({
    isManual: false,
    silent: false,
    loadingText: "顧客の未決済注文を検索中..."
  });

  if (query.startsWith("ORD-")) {
    const matchedOrder = orders.find(o => o.id.toUpperCase() === query);
    if (matchedOrder && matchedOrder.user_id) {
      query = matchedOrder.user_id.toUpperCase();
      inputEl.value = query;
    }
  }

  const userObj = users.find(u => u.user_id.toUpperCase() === query);
  if (!userObj) {
    alert(`ユーザーID「${query}」が見つかりません。番号をお確かめください。`);
    return;
  }

  loadUserOrdersIntoPos(userObj.user_id, true);
}

function loadUserOrdersIntoPos(userId, resetDeposit = true) {
  const targetUid = userId.toUpperCase();
  const userObj = users.find(u => u.user_id.toUpperCase() === targetUid);
  if (!userObj) return;

  selectedPosUserId = userObj.user_id;
  const card = document.getElementById("pos-checkout-card");
  card.style.display = "block";

  const unpaidOrders = orders.filter(
    o => o.status === 0 && (o.user_id.toUpperCase() === targetUid || o.account === userObj.account)
  );

  document.getElementById("pos-user-id").textContent = `ユーザーID: ${userObj.user_id}`;
  document.getElementById("pos-user-account").textContent = `顧客アカウント: ${userObj.account}`;

  const pill = document.getElementById("pos-unpaid-badge");
  const targetBox = document.getElementById("pos-target-orders");
  const tbody = document.getElementById("pos-items-tbody");
  const payBtn = document.getElementById("btn-complete-pay");

  if (unpaidOrders.length === 0) {
    pill.textContent = "未決済なし";
    pill.style.background = "#718096";
    targetBox.innerHTML = `<div>現在、未決済の注文はありません（すべて決済済みまたはキャンセル済みです）。</div>`;
    tbody.innerHTML = "";
    currentPosUnpaidTotal = 0;
    document.getElementById("pos-total-price").textContent = "0";
    document.getElementById("pos-deposit").value = "";
    document.getElementById("pos-change").textContent = "0";
    payBtn.disabled = true;
    payBtn.textContent = "未決済の注文がありません";
    return;
  }

  pill.textContent = `未決済 ${unpaidOrders.length}件`;
  pill.style.background = "#dd6b20";

  targetBox.innerHTML = `
    <div style="font-weight:bold; margin-bottom:4px;">一括精算対象の注文（${unpaidOrders.length}件）:</div>
    ${unpaidOrders.map(o => `
      <div class="target-order-row">
        <span><strong>${o.id}</strong>（¥${Number(o.total_price).toLocaleString()} / ${o.created_at}）</span>
        <button type="button" class="btn btn-danger-outline" onclick="cancelSingleOrderFromPos('${o.id}')">この注文のみ取消</button>
      </div>
    `).join("")}
  `;

  let totalPrice = 0;
  const aggregatedMap = new Map();

  unpaidOrders.forEach(o => {
    totalPrice += Number(o.total_price || 0);
    (o.items || []).forEach(i => {
      const key = String(i.id || i.name);
      const price = Number(i.price || 0);
      const qty = Number(i.qty || 0);
      if (!aggregatedMap.has(key)) {
        aggregatedMap.set(key, {
          name: i.name,
          price: price,
          qty: 0,
          subtotal: 0
        });
      }
      const entry = aggregatedMap.get(key);
      entry.qty += qty;
      entry.subtotal += price * qty;
    });
  });

  const allRowsHtml = Array.from(aggregatedMap.values()).map(item => `
    <tr>
      <td><strong>${item.name}</strong></td>
      <td>¥${item.price.toLocaleString()}</td>
      <td><strong>${item.qty}点</strong></td>
      <td>¥${item.subtotal.toLocaleString()}</td>
    </tr>
  `);

  currentPosUnpaidTotal = totalPrice;
  tbody.innerHTML = allRowsHtml.join("");
  document.getElementById("pos-total-price").textContent = totalPrice.toLocaleString();

  if (resetDeposit) {
    const depositInput = document.getElementById("pos-deposit");
    depositInput.value = "";
    document.getElementById("pos-change").textContent = "0";
    setTimeout(() => depositInput.focus(), 50);
  } else {
    calcChange();
  }

  payBtn.disabled = false;
  payBtn.textContent = `現金で一括会計（${unpaidOrders.length}件・決済完了）`;
}

// 金種クイックボタン制御
function setExactDeposit() {
  if (currentPosUnpaidTotal <= 0) return;
  document.getElementById("pos-deposit").value = currentPosUnpaidTotal;
  calcChange();
}

function addDepositAmount(amount) {
  const input = document.getElementById("pos-deposit");
  const current = Number(input.value) || 0;
  input.value = current + amount;
  calcChange();
}

function clearDepositAmount() {
  const input = document.getElementById("pos-deposit");
  input.value = "";
  calcChange();
  input.focus();
}

function calcChange() {
  const depositVal = document.getElementById("pos-deposit").value;
  if (depositVal === "") {
    document.getElementById("pos-change").textContent = "0";
    return;
  }

  const deposit = Number(depositVal);
  const change = deposit - currentPosUnpaidTotal;
  document.getElementById("pos-change").textContent = change >= 0 ? change.toLocaleString() : "金額不足";
}

async function completeBatchPayment() {
  if (!selectedPosUserId || currentPosUnpaidTotal <= 0) return;

  const depositVal = document.getElementById("pos-deposit").value;
  const deposit = depositVal === "" ? currentPosUnpaidTotal : Number(depositVal);

  if (deposit < currentPosUnpaidTotal) {
    alert("お預かり金額が合計金額に足りていません。");
    document.getElementById("pos-deposit").focus();
    return;
  }

  const payBtn = document.getElementById("btn-complete-pay");
  if (payBtn.disabled) return;
  payBtn.disabled = true;
  payBtn.textContent = "一括決済処理中...";

  try {
    const res = await apiPost(
      {
        action: "payAllByUser",
        account: staffAccount,
        pin: staffPin,
        userId: selectedPosUserId,
        receivedAmount: deposit
      },
      { loadingText: "一括決済とお預かり金額を記録しています..." }
    );

    const change = deposit - currentPosUnpaidTotal;
    alert(`${res.message}\nお預かり: ¥${deposit.toLocaleString()} / お釣り: ¥${change.toLocaleString()}`);
    await refreshAll({ isManual: false, silent: false, loadingText: "最新状態を反映中..." });
  } catch (err) {
    alert("決済処理に失敗しました:\n" + err.message);
    payBtn.disabled = false;
    payBtn.textContent = "現金で一括会計（決済完了）";
  }
}

async function cancelSingleOrderFromPos(orderId) {
  if (!confirm(`注文ID「${orderId}」をキャンセルしますか？\n（在庫は自動的に戻ります）`)) {
    return;
  }

  try {
    await apiPost(
      {
        action: "updateStatus",
        account: staffAccount,
        pin: staffPin,
        orderId: orderId,
        status: 4
      },
      { loadingText: "注文をキャンセルしています..." }
    );

    alert(`注文ID「${orderId}」をキャンセルしました。`);
    await refreshAll({ isManual: false, silent: false, loadingText: "最新状態を反映中..." });
  } catch (err) {
    alert("キャンセル処理に失敗しました:\n" + err.message);
  }
}

// ==========================================
// 3. 商品引き渡し（ピッキング）＆完了済み履歴確認機能
// ==========================================
function buildHandoverUserGroups() {
  const waitingOrders = orders.filter(o => o.status === 1 || o.status === 2);
  const groupMap = new Map();

  waitingOrders.forEach(o => {
    const uid = (o.user_id || o.account || o.id).toUpperCase();
    if (!groupMap.has(uid)) {
      groupMap.set(uid, {
        userId: uid,
        account: o.account || "",
        orders: [],
        hasUnstarted: false,
        aggregatedItems: new Map()
      });
    }

    const group = groupMap.get(uid);
    group.orders.push(o);
    if (o.status === 1) {
      group.hasUnstarted = true;
    }

    (o.items || []).forEach(i => {
      const itemKey = String(i.id || i.name);
      const qty = Number(i.qty || 0);
      if (!group.aggregatedItems.has(itemKey)) {
        group.aggregatedItems.set(itemKey, {
          name: i.name,
          qty: 0
        });
      }
      group.aggregatedItems.get(itemKey).qty += qty;
    });
  });

  return Array.from(groupMap.values());
}

function renderHandoverList() {
  const groups = buildHandoverUserGroups();
  document.getElementById("badge-wait-count").textContent = groups.length;

  const listEl = document.getElementById("paid-orders-list");
  if (groups.length === 0) {
    listEl.innerHTML = `<p class="empty-placeholder">現在引き渡し待ちのお客様はいません。</p>`;
    return;
  }

  listEl.innerHTML = groups.map(g => {
    const isSelected = selectedHandoverUserId === g.userId;
    const badgeColor = g.hasUnstarted ? "#38a169" : "#3182ce";
    const badgeLabel = g.hasUnstarted ? "決済済み" : "ピッキング中";
    const orderCountNote = g.orders.length > 1 ? `（注文${g.orders.length}件合算）` : "";

    return `
      <div class="order-list-item ${isSelected ? "selected" : ""}" onclick="selectHandoverUser('${g.userId}')">
        <div>
          <strong>${g.userId}</strong> <span style="font-size:0.78rem; color:#2b6cb0; font-weight:bold;">${orderCountNote}</span>
          <div style="font-size:0.78rem; color:#718096;">${g.account}</div>
        </div>
        <span class="status-pill" style="background:${badgeColor};">${badgeLabel}</span>
      </div>
    `;
  }).join("");
}

function selectHandoverUser(userId) {
  const targetUid = userId.toUpperCase();
  const groups = buildHandoverUserGroups();
  const group = groups.find(g => g.userId === targetUid);
  if (!group) return;

  selectedHandoverUserId = targetUid;
  renderHandoverList();

  const area = document.getElementById("picking-detail-area");
  const itemsHtml = Array.from(group.aggregatedItems.values()).map(i => `
    <tr>
      <td><strong>${i.name}</strong></td>
      <td><strong>${i.qty}点</strong></td>
    </tr>
  `).join("");

  const targetOrderIds = group.orders.map(o => o.id).join(", ");

  const actionButtonHtml = group.hasUnstarted
    ? `<button type="button" class="btn btn-warning" onclick="updateHandoverUserStatus('${group.userId}', 2)">
         ピッキング開始（引き渡し中へ）
       </button>`
    : `<button type="button" class="btn btn-success" style="padding:12px 16px; font-size:1rem;" onclick="updateHandoverUserStatus('${group.userId}', 3)">
         引き渡し完了
       </button>`;

  area.innerHTML = `
    <div style="margin-bottom:12px;">
      <div style="font-size:1.3rem; font-weight:bold; color:var(--primary);">
        呼び出し番号: ${group.userId}
      </div>
      <div style="font-size:0.85rem; color:#4a5568; margin-top:2px;">顧客: ${group.account}</div>
      <div style="font-size:0.78rem; color:#718096; margin-top:2px;">対象注文（${group.orders.length}件合算）: ${targetOrderIds}</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>商品名（全注文合算）</th>
          <th>合計数量</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    <div class="picking-actions">
      ${actionButtonHtml}
    </div>
  `;
}

async function updateHandoverUserStatus(userId, nextStatus) {
  const loadingMsg = nextStatus === 2
    ? "ピッキング開始を記録しています..."
    : "引き渡し完了を記録しています...";

  try {
    await apiPost(
      {
        action: "updateStatusByUser",
        account: staffAccount,
        pin: staffPin,
        userId: userId,
        nextStatus: nextStatus
      },
      { loadingText: loadingMsg }
    );

    if (nextStatus === 3) {
      selectedHandoverUserId = "";
      document.getElementById("picking-detail-area").innerHTML =
        `<p class="empty-placeholder" style="color:var(--success); font-weight:bold;">${userId} 様への引き渡しが完了しました！</p>`;
    }

    await refreshAll({ isManual: false, silent: false, loadingText: "一覧を更新中..." });

    if (nextStatus === 2) {
      selectHandoverUser(userId);
    }
  } catch (err) {
    alert("ステータス更新エラー:\n" + err.message);
  }
}

/**
 * 直近の引き渡し完了履歴（status === 3 の最新10件）を表示
 */
function renderCompletedHistory() {
  const container = document.getElementById("completed-history-list");
  if (!container) return;

  const completedOrders = orders
    .filter(o => o.status === 3)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))
    .slice(0, 10);

  if (completedOrders.length === 0) {
    container.innerHTML = `<p class="empty-placeholder" style="padding:16px 0;">まだ引き渡し完了済みの注文はありません。</p>`;
    return;
  }

  container.innerHTML = completedOrders.map(o => {
    const uidLabel = o.user_id ? `${o.user_id} / ` : "";
    const itemsSummary = (o.items || [])
      .map(i => `${i.name} × ${i.qty}点`)
      .join("、");
    const completedTime = o.updated_at || o.created_at;

    return `
      <div class="history-item">
        <div>
          <div><strong>${uidLabel}${o.id}</strong> <span style="font-size:0.8rem; color:#4a5568;">（${o.account}）</span></div>
          <div class="history-items-summary">${itemsSummary}</div>
          <div class="history-meta">完了時刻: ${completedTime} ／ 金額: ¥${Number(o.total_price || 0).toLocaleString()}</div>
        </div>
        <button type="button" class="btn-revert-outline" onclick="revertCompletedOrder('${o.id}')">
          引き渡し前に戻す
        </button>
      </div>
    `;
  }).join("");
}

/**
 * 誤って引き渡し完了にした注文を「決済済み（status: 1）」へ差し戻す
 */
async function revertCompletedOrder(orderId) {
  if (!confirm(`注文ID「${orderId}」を引き渡し待ち（決済済み）に戻しますか？`)) {
    return;
  }

  try {
    await apiPost(
      {
        action: "updateStatus",
        account: staffAccount,
        pin: staffPin,
        orderId: orderId,
        status: 1
      },
      { loadingText: "引き渡し待ちへ戻しています..." }
    );

    await refreshAll({ isManual: false, silent: false, loadingText: "一覧を更新中..." });
  } catch (err) {
    alert("差し戻しエラー:\n" + err.message);
  }
}

// ==========================================
// 4. ダッシュボード（売上・レジ締め集計）機能
// ==========================================
function renderDashboard() {
  const validPaidOrders = orders.filter(o => [1, 2, 3].includes(o.status));
  const totalSales = validPaidOrders.reduce((sum, o) => sum + Number(o.total_price || 0), 0);

  // お預かり総額（received_amountが未記録の過去データがある場合はtotal_priceを補完）
  const totalReceived = validPaidOrders.reduce((sum, o) => {
    const rec = Number(o.received_amount);
    if (!isNaN(rec) && rec > 0) {
      return sum + rec;
    }
    return sum;
  }, 0);

  // レジ締め用: お釣り払い出し総額（お預かり総額 - 総売上、0未満にはしない）
  const effectiveReceived = totalReceived > 0 ? totalReceived : totalSales;
  const totalChange = Math.max(0, effectiveReceived - totalSales);

  document.getElementById("kpi-total-sales").textContent = `¥${totalSales.toLocaleString()}`;
  document.getElementById("kpi-total-received").textContent = `¥${effectiveReceived.toLocaleString()}`;
  document.getElementById("kpi-total-change").textContent = `¥${totalChange.toLocaleString()}`;
  document.getElementById("kpi-order-count").textContent = `${validPaidOrders.length}件`;

  const soldCountMap = {};
  validPaidOrders.forEach(o => {
    (o.items || []).forEach(i => {
      soldCountMap[i.id] = (soldCountMap[i.id] || 0) + Number(i.qty || 0);
    });
  });

  const tbody = document.getElementById("dashboard-tbody");
  tbody.innerHTML = products.map(p => {
    const soldQty = soldCountMap[p.id] || 0;
    const stockClass = p.stock <= 5 ? "stock-low" : "stock-ok";
    return `
      <tr>
        <td>${p.id}</td>
        <td>${p.name}</td>
        <td>¥${Number(p.price).toLocaleString()}</td>
        <td>${soldQty}点</td>
        <td class="${stockClass}">${p.stock}点</td>
      </tr>
    `;
  }).join("");
}
