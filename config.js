// config.js
const APP_CONFIG = {
  // デプロイしたGASのウェブアプリURLに書き換えてください
  GAS_API_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",

  // スタッフ画面の自動更新間隔（ミリ秒）
  STAFF_POLL_INTERVAL: 30000 // 30秒
};

let activeRequestCount = 0;

/**
 * 全画面共通ローディングスピナーのDOM生成・表示
 */
function showGlobalSpinner(message = "通信中...") {
  let overlay = document.getElementById("global-loading-overlay");
  if (!overlay) {
    const style = document.createElement("style");
    style.textContent = `
      #global-loading-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(2px);
        z-index: 9999;
        align-items: center;
        justify-content: center;
      }
      #global-loading-overlay.active {
        display: flex;
      }
      .global-spinner-box {
        background: #ffffff;
        padding: 20px 28px;
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        min-width: 160px;
      }
      .global-spinner-ring {
        width: 38px;
        height: 38px;
        border: 4px solid #e2e8f0;
        border-top-color: #3182ce;
        border-radius: 50%;
        animation: globalSpin 0.8s linear infinite;
      }
      .global-spinner-text {
        font-size: 0.9rem;
        font-weight: bold;
        color: #1a365d;
      }
      @keyframes globalSpin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);

    overlay = document.createElement("div");
    overlay.id = "global-loading-overlay";
    overlay.innerHTML = `
      <div class="global-spinner-box">
        <div class="global-spinner-ring"></div>
        <div id="global-spinner-text" class="global-spinner-text">通信中...</div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  const textEl = document.getElementById("global-spinner-text");
  if (textEl) textEl.textContent = message;
  overlay.classList.add("active");
}

function hideGlobalSpinner() {
  const overlay = document.getElementById("global-loading-overlay");
  if (overlay) {
    overlay.classList.remove("active");
  }
}

/**
 * GASとのGET通信ヘルパー
 * @param {string} action
 * @param {object} params
 * @param {object} options { silent?: boolean, loadingText?: string }
 */
async function apiGet(action = "public", params = {}, options = {}) {
  const silent = Boolean(options.silent);
  if (!silent) {
    activeRequestCount++;
    showGlobalSpinner(options.loadingText || "データを読み込み中...");
  }

  try {
    const url = new URL(APP_CONFIG.GAS_API_URL);
    url.searchParams.set("action", action);
    url.searchParams.set("_t", Date.now());

    Object.entries(params).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== "") {
        url.searchParams.set(key, String(val));
      }
    });

    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error(`通信エラーが発生しました (HTTP ${res.status})`);
    }

    const data = await res.json();
    if (!data.success) {
      const err = new Error(data.message || "データの取得に失敗しました");
      err.authError = Boolean(data.authError);
      throw err;
    }
    return data;
  } finally {
    if (!silent) {
      activeRequestCount = Math.max(0, activeRequestCount - 1);
      if (activeRequestCount === 0) hideGlobalSpinner();
    }
  }
}

/**
 * GASとのPOST通信ヘルパー
 * @param {object} payload
 * @param {object} options { silent?: boolean, loadingText?: string }
 */
async function apiPost(payload, options = {}) {
  const silent = Boolean(options.silent);
  if (!silent) {
    activeRequestCount++;
    showGlobalSpinner(options.loadingText || "処理を送信中...");
  }

  try {
    const res = await fetch(APP_CONFIG.GAS_API_URL, {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`通信エラーが発生しました (HTTP ${res.status})`);
    }

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.message || "リクエストの処理に失敗しました");
    }
    return data;
  } finally {
    if (!silent) {
      activeRequestCount = Math.max(0, activeRequestCount - 1);
      if (activeRequestCount === 0) hideGlobalSpinner();
    }
  }
}