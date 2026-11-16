/**
 * 2026 CBB イベント物販・POSレジシステム 共通設定・通信・ユーティリティ (js/config.js)
 */

const APP_CONFIG = {
  // ★現在設定済みのGASウェブアプリURLに書き換えてください
  GAS_API_URL: "https://script.google.com/macros/s/AKfycbyWmha9IM3Io0qWl1nNI4-W1yts4I4gFm92eymr411bttK7mYovucOTn3_tsqlG9oFk-A/exec",
  STAFF_POLL_INTERVAL: 30000
};

/**
 * 注文ステータス定数（マジックナンバー解消）
 */
const ORDER_STATUS = Object.freeze({
  UNPAID: 0,     // 未決済
  PAID: 1,       // 決済済み（ピッキング待ち）
  PICKING: 2,    // ピッキング中
  COMPLETED: 3,  // 引き渡し完了
  CANCELED: 4    // キャンセル済み
});

// ==========================================
// 共通UI・データ整形ユーティリティ
// ==========================================

/**
 * HTMLエスケープ（innerHTML埋め込み時の表示崩れ・XSS防止）
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 入力欄へのEnterキー送信バインド（IME変換確定時は除外）
 */
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

/**
 * 複数注文の明細（items）を商品単位で合算して配列で返す共通関数
 * @param {Array} targetOrders - 合算対象の注文オブジェクト配列
 * @returns {Array<{id: string, name: string, price: number, qty: number, subtotal: number}>}
 */
function aggregateOrderItems(targetOrders) {
  const aggregatedMap = new Map();

  (targetOrders || []).forEach(order => {
    (order.items || []).forEach(item => {
      const key = String(item.id || item.name);
      const price = Number(item.price || 0);
      const qty = Number(item.qty || 0);

      if (!aggregatedMap.has(key)) {
        aggregatedMap.set(key, {
          id: String(item.id || ""),
          name: String(item.name || ""),
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

  return Array.from(aggregatedMap.values());
}

// ==========================================
// 全画面ローディングスピナー＆GAS API通信ラッパー
// ==========================================
let activeLoadingCount = 0;

function ensureSpinnerElement() {
  let overlay = document.getElementById("global-loading-overlay");
  if (overlay) return overlay;

  const style = document.createElement("style");
  style.textContent = `
    #global-loading-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      backdrop-filter: blur(2px);
      z-index: 9999;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #global-loading-overlay.active {
      display: flex;
    }
    .global-spinner-ring {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(255, 255, 255, 0.25);
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: globalSpin 0.8s linear infinite;
      margin-bottom: 14px;
    }
    .global-spinner-text {
      font-size: 0.95rem;
      font-weight: bold;
      letter-spacing: 0.03em;
      text-align: center;
      padding: 0 20px;
    }
    @keyframes globalSpin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);

  overlay = document.createElement("div");
  overlay.id = "global-loading-overlay";
  overlay.innerHTML = `
    <div class="global-spinner-ring"></div>
    <div id="global-spinner-label" class="global-spinner-text">通信中...</div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showLoading(text = "通信中...") {
  activeLoadingCount++;
  const overlay = ensureSpinnerElement();
  const label = document.getElementById("global-spinner-label");
  if (label) label.textContent = text;
  overlay.classList.add("active");
}

function hideLoading() {
  activeLoadingCount = Math.max(0, activeLoadingCount - 1);
  if (activeLoadingCount === 0) {
    const overlay = document.getElementById("global-loading-overlay");
    if (overlay) overlay.classList.remove("active");
  }
}

async function apiGet(action, params = {}, options = {}) {
  const { silent = false, loadingText = "データを読み込み中..." } = options;
  if (!silent) showLoading(loadingText);

  try {
    const url = new URL(APP_CONFIG.GAS_API_URL);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });

    const res = await fetch(url.toString(), { method: "GET" });
    const json = await res.json();
    if (!json.success) {
      const err = new Error(json.message || "データ取得エラー");
      if (json.authError) err.authError = true;
      throw err;
    }
    return json;
  } finally {
    if (!silent) hideLoading();
  }
}

async function apiPost(payload, options = {}) {
  const { silent = false, loadingText = "処理を実行中..." } = options;
  if (!silent) showLoading(loadingText);

  try {
    const res = await fetch(APP_CONFIG.GAS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.success) {
      const err = new Error(json.message || "更新処理エラー");
      if (json.authError) err.authError = true;
      throw err;
    }
    return json;
  } finally {
    if (!silent) hideLoading();
  }
}
