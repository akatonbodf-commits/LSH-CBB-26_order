/**
 * 2026 CBB イベント物販事前注文画面スクリプト (js/app.js)
 * - Enterキーによるアカウント認証実行対応
 * - 会員QRコードモーダル内の未決済注文 商品別個数・小計合算表示
 */

let currentAccount = localStorage.getItem("cbb_user_account") || "";
let currentUserId = localStorage.getItem("cbb_user_id") || "";
let products = [];
let myOrders = [];
let cart = {};

window.addEventListener("DOMContentLoaded", async () => {
  // Gmail入力欄でのEnterキー送信バインド
  const gmailInput = document.getElementById("input-gmail");
  if (gmailInput) {
    gmailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        saveAccount();
      }
    });
  }

  if (!currentAccount) {
    openAccountModal();
  } else {
    updateAccountUI();
  }
  await loadPublicData(false, true, "商品一覧を読み込み中...");
});

function openAccountModal() {
  const input = document.getElementById("input-gmail");
  input.value = currentAccount;
  document.getElementById("account-modal").classList.add("active");
  setTimeout(() => input.focus(), 50);
}

async function saveAccount() {
  const val = document.getElementById("input-gmail").value.trim().toLowerCase();
  if (!val || !val.includes("@")) {
    alert("有効なメールアドレスを入力してください。");
    return;
  }
  currentAccount = val;
  currentUserId = "";
  cart = {};
  localStorage.setItem("cbb_user_account", currentAccount);
  localStorage.removeItem("cbb_user_id");
  document.getElementById("account-modal").classList.remove("active");
  document.getElementById("staff-quick-cue").style.display = "none";
  updateAccountUI();
  await loadPublicData(false, false, "アカウントを認証中...");
}

function updateAccountUI() {
  const uidLabel = currentUserId ? ` (${currentUserId})` : "";
  document.getElementById("display-account").textContent = `ログイン: ${currentAccount}${uidLabel}`;
}

async function loadPublicData(isManual = false, forceRefresh = false, loadingText = "在庫情報を更新中...") {
  const statusEl = document.getElementById("sync-status");
  try {
    statusEl.textContent = "同期中...";
    const params = { account: currentAccount };
    if (isManual || forceRefresh) {
      params.force = "1";
    }

    const data = await apiGet("public", params, { loadingText });
    products = (data.products || []).map(p => ({
      ...p,
      id: String(p.id),
      price: Number(p.price) || 0,
      stock: Math.max(0, Number(p.stock) || 0),
      limit: Math.max(1, Number(p.limit) || 1)
    }));
    myOrders = data.myOrders || [];

    const quickCueEl = document.getElementById("staff-quick-cue");
    quickCueEl.style.display = data.isStaff ? "block" : "none";

    if (data.user && data.user.user_id) {
      currentUserId = data.user.user_id;
      localStorage.setItem("cbb_user_id", currentUserId);
      updateAccountUI();
    }

    Object.keys(cart).forEach(pid => {
      const prod = products.find(p => String(p.id) === String(pid));
      if (!prod || !prod.status || prod.stock <= 0) {
        delete cart[pid];
      } else {
        const maxAllowed = Math.min(prod.stock, prod.limit);
        if (cart[pid] > maxAllowed) {
          cart[pid] = maxAllowed;
        }
      }
    });

    renderProducts();
    updateCartFooter();
    updateHeaderQrButton();

    const now = new Date();
    statusEl.textContent = `更新 ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  } catch (err) {
    statusEl.textContent = "通信混雑中";
    if (isManual) {
      alert("データの更新に失敗しました。数秒おいてから再度お試しください。\n(" + err.message + ")");
    }
  }
}

function updateHeaderQrButton() {
  const qrBtn = document.getElementById("btn-header-qr");
  qrBtn.style.display = currentUserId ? "inline-block" : "none";
}

function renderProducts() {
  const grid = document.getElementById("product-grid");
  grid.innerHTML = "";

  products.filter(p => p.status).forEach(prod => {
    const pid = String(prod.id);
    const inCartQty = Number(cart[pid] || 0);
    const stockNum = Number(prod.stock);
    const limitNum = Number(prod.limit);
    const isSoldOut = stockNum <= 0;
    const maxSelectable = Math.min(stockNum, limitNum);

    let badgeClass = "badge-ok";
    let badgeText = "在庫あり";
    if (isSoldOut) {
      badgeClass = "badge-out";
      badgeText = "売り切れ";
    } else if (stockNum <= 5) {
      badgeClass = "badge-low";
      badgeText = `残りわずか (${stockNum})`;
    }

    const card = document.createElement("div");
    card.className = `product-card ${isSoldOut ? "sold-out" : ""}`;
    card.innerHTML = `
      <div class="product-img-wrap">
        <span class="stock-badge ${badgeClass}">${badgeText}</span>
        <img src="${prod.image_url || 'https://placehold.co/300?text=No+Image'}" alt="${prod.name}" loading="lazy">
      </div>
      <div class="product-info">
        <div class="product-name">${prod.name}</div>
        <div class="product-price">¥${prod.price.toLocaleString()}</div>
        <div class="product-limit">お一人様 ${limitNum}点まで</div>
        <div class="qty-controls">
          ${inCartQty === 0
            ? `<button type="button" class="btn-select-qty" ${isSoldOut ? "disabled" : ""} data-pid="${pid}" onclick="changeQty(this.dataset.pid, 1)">
                 ${isSoldOut ? "売り切れ" : "数量選択"}
               </button>`
            : `<div class="stepper">
                 <button type="button" data-pid="${pid}" onclick="changeQty(this.dataset.pid, -1)">−</button>
                 <span>${inCartQty}</span>
                 <button type="button" data-pid="${pid}" onclick="changeQty(this.dataset.pid, 1)" ${inCartQty >= maxSelectable ? "disabled" : ""}>＋</button>
               </div>`
          }
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function changeQty(productId, delta) {
  const pid = String(productId);
  const prod = products.find(p => String(p.id) === pid);
  if (!prod) return;

  const maxSelectable = Math.min(Number(prod.stock), Number(prod.limit));
  const current = Number(cart[pid] || 0);
  const next = current + Number(delta);

  if (next <= 0) {
    delete cart[pid];
  } else if (next <= maxSelectable) {
    cart[pid] = next;
  }

  renderProducts();
  updateCartFooter();
}

function updateCartFooter() {
  let totalCount = 0;
  let totalPrice = 0;
  Object.entries(cart).forEach(([id, qty]) => {
    const prod = products.find(p => String(p.id) === String(id));
    if (prod) {
      totalCount += Number(qty);
      totalPrice += Number(prod.price) * Number(qty);
    }
  });

  document.getElementById("footer-count").textContent = totalCount;
  document.getElementById("footer-total").textContent = totalPrice.toLocaleString();
  document.getElementById("btn-open-cart").disabled = totalCount === 0;
}

function openCartModal() {
  const container = document.getElementById("cart-items-container");
  container.innerHTML = "";
  let totalPrice = 0;

  Object.entries(cart).forEach(([id, qty]) => {
    const prod = products.find(p => String(p.id) === String(id));
    if (!prod) return;
    const sub = prod.price * qty;
    totalPrice += sub;
    const row = document.createElement("div");
    row.className = "cart-item-row";
    row.innerHTML = `
      <div>
        <div style="font-weight:bold;">${prod.name}</div>
        <div style="font-size:0.82rem; color:#718096;">¥${prod.price.toLocaleString()} × ${qty}</div>
      </div>
      <div style="font-weight:bold;">¥${sub.toLocaleString()}</div>
    `;
    container.appendChild(row);
  });

  document.getElementById("modal-total").textContent = totalPrice.toLocaleString();
  document.getElementById("cart-modal").classList.add("active");
}

function closeCartModal(e) {
  if (!e || e.target.id === "cart-modal") {
    document.getElementById("cart-modal").classList.remove("active");
  }
}

async function submitOrder() {
  if (!currentAccount) {
    openAccountModal();
    return;
  }
  const btn = document.getElementById("btn-submit-order");
  btn.disabled = true;
  btn.textContent = "注文処理中...";

  try {
    const items = Object.entries(cart).map(([id, qty]) => {
      const prod = products.find(p => String(p.id) === String(id));
      return { id: String(id), name: prod.name, qty: Number(qty), price: Number(prod.price) };
    });

    await apiPost(
      { action: "createOrder", account: currentAccount, items: items },
      { loadingText: "注文を確定しています..." }
    );

    cart = {};
    closeCartModal();
    await loadPublicData(false, false, "注文情報を反映中...");
    openQrModal();

  } catch (err) {
    alert("注文を確定できませんでした:\n" + err.message);
    await loadPublicData(false, true, "最新在庫を確認中...");
  } finally {
    btn.disabled = false;
    btn.textContent = "注文を確定・送信";
  }
}

function openQrModal() {
  if (!currentUserId) {
    alert("ユーザーIDがまだ発行されていません。アカウント認証を行ってください。");
    return;
  }

  const qrBox = document.getElementById("qrcode-box");
  qrBox.innerHTML = "";
  new QRCode(qrBox, {
    text: currentUserId,
    width: 190,
    height: 190
  });

  document.getElementById("qr-user-id").textContent = `ユーザーID: ${currentUserId}`;
  document.getElementById("qr-user-account").textContent = currentAccount;

  const unpaidOrders = myOrders.filter(o => o.status === 0);
  const paidOrders = myOrders.filter(o => o.status === 1 || o.status === 2);

  let html = "";

  if (unpaidOrders.length > 0) {
    const unpaidTotal = unpaidOrders.reduce((sum, o) => sum + Number(o.total_price || 0), 0);

    const aggregatedMap = new Map();
    unpaidOrders.forEach(o => {
      (o.items || []).forEach(i => {
        const key = String(i.id || i.name);
        const qty = Number(i.qty || 0);
        const price = Number(i.price || 0);
        if (!aggregatedMap.has(key)) {
          aggregatedMap.set(key, {
            name: i.name,
            qty: 0,
            subtotal: 0
          });
        }
        const entry = aggregatedMap.get(key);
        entry.qty += qty;
        entry.subtotal += price * qty;
      });
    });

    const aggregatedRows = Array.from(aggregatedMap.values()).map(item => `
      <li>
        <span><strong>${item.name}</strong> × ${item.qty}点</span>
        <span>¥${item.subtotal.toLocaleString()}</span>
      </li>
    `).join("");

    html += `
      <div class="summary-section" style="border-color:#fbd38d; background:#fffaf0;">
        <span class="section-badge" style="background:var(--warning);">未決済のご注文（${unpaidOrders.length}件合算）</span>
        <div style="font-size:1.05rem; font-weight:bold; margin-bottom:6px;">
          レジお支払い合計: ¥${unpaidTotal.toLocaleString()}
        </div>
        <ul class="aggregated-list">
          ${aggregatedRows}
        </ul>
      </div>
    `;
  } else {
    html += `
      <div class="summary-section">
        <span class="section-badge" style="background:var(--muted);">未決済のご注文なし</span>
        <div>現在お支払い待ちの注文はありません。</div>
      </div>
    `;
  }

  if (paidOrders.length > 0) {
    html += `
      <div class="summary-section" style="border-color:#9ae6b4; background:#f0fff4;">
        <span class="section-badge" style="background:var(--success);">お支払い済み・引き渡し待ち（${paidOrders.length}件）</span>
        <ul style="padding-left:18px; line-height:1.5;">
          ${paidOrders.map(o => `<li><strong>${o.id}</strong>（¥${Number(o.total_price).toLocaleString()}）</li>`).join("")}
        </ul>
      </div>
    `;
  }

  document.getElementById("qr-orders-summary").innerHTML = html;
  document.getElementById("qr-modal").classList.add("active");
}

function closeQrModal(e) {
  if (!e || e.target.id === "qr-modal") {
    document.getElementById("qr-modal").classList.remove("active");
  }
}
