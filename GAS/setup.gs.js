/**
 * 2026 CBB イベント物販・POSレジシステム 初期セットアップスクリプト (Setup.gs v3.4)
 * - products / orders / users / staffs の4シート構成と最新ヘッダ（received_amount含む）を構築
 * - 1時間経過した未決済注文の自動キャンセルトリガーを設定
 *
 * 【使い方】
 * 1. GASエディタで「Setup.gs」を作成してこのコードを貼り付けて保存
 * 2. エディタ上部の関数選択プルダウンから「setupAllSheets」を選んで「実行」
 * 3. 初回のみ権限承認ダイアログが出るので許可する
 */

function setupAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. products シート（商品マスタ）
  const productHeaders = ['id', 'name', 'price', 'stock', 'limit', 'image_url', 'status'];
  const productSheet = initSheetWithHeaders_(ss, 'products', productHeaders, [100, 220, 90, 90, 90, 260, 90]);
  if (productSheet.getLastRow() <= 1) {
    const sampleProducts = [
      ['ITEM-001', '2026 CBB 記念Tシャツ (M)', 2500, 30, 2, 'https://placehold.co/400x400/1a365d/ffffff?text=T-Shirt+M', true],
      ['ITEM-002', '2026 CBB 記念Tシャツ (L)', 2500, 30, 2, 'https://placehold.co/400x400/1a365d/ffffff?text=T-Shirt+L', true],
      ['ITEM-003', 'アクリルキーホルダー', 800, 50, 5, 'https://placehold.co/400x400/3182ce/ffffff?text=Keyholder', true],
      ['ITEM-004', '缶バッジ 2個セット', 500, 60, 5, 'https://placehold.co/400x400/38a169/ffffff?text=Badge', true],
      ['ITEM-005', '特製パンフレット', 1000, 40, 3, 'https://placehold.co/400x400/dd6b20/ffffff?text=Pamphlet', true]
    ];
    productSheet.getRange(2, 1, sampleProducts.length, productHeaders.length).setValues(sampleProducts);
    productSheet.getRange(2, 3, sampleProducts.length, 1).setNumberFormat('#,##0');
  }

  // 2. orders シート（注文トランザクション：G列に received_amount を含む）
  const orderHeaders = ['id', 'created_at', 'total_price', 'status', 'updated_at', 'items', 'received_amount'];
  const orderSheet = initSheetWithHeaders_(ss, 'orders', orderHeaders, [170, 160, 110, 80, 160, 340, 130]);
  // 既存データがある場合は金額列の書式を整える
  if (orderSheet.getLastRow() > 1) {
    const dataRows = orderSheet.getLastRow() - 1;
    orderSheet.getRange(2, 3, dataRows, 1).setNumberFormat('#,##0');
    orderSheet.getRange(2, 7, dataRows, 1).setNumberFormat('#,##0');
  }

  // 3. users シート（アカウントとユーザーIDの1対1対応表）
  const userHeaders = ['user_id', 'account', 'created_at'];
  initSheetWithHeaders_(ss, 'users', userHeaders, [120, 240, 160]);

  // 4. staffs シート（スタッフ認証マスタ）
  const staffHeaders = ['name', 'account', 'pin'];
  const staffSheet = initSheetWithHeaders_(ss, 'staffs', staffHeaders, [150, 240, 120]);
  if (staffSheet.getLastRow() <= 1) {
    const nowStaffAccount = Session.getActiveUser().getEmail() || 'staff@example.com';
    const sampleStaffs = [
      ['管理者スタッフ', nowStaffAccount.toLowerCase(), '1234']
    ];
    staffSheet.getRange(2, 1, sampleStaffs.length, staffHeaders.length).setValues(sampleStaffs);
    // PINの先頭0消え防止のため文字列書式を設定
    staffSheet.getRange(2, 3, sampleStaffs.length, 1).setNumberFormat('@');
  }

  // 5. 自動キャンセルトリガー設定 & キャッシュクリア
  setupAutoCancelTrigger();
  CacheService.getScriptCache().remove('public_products');

  SpreadsheetApp.flush();
  Logger.log('全シート（products, orders, users, staffs）と自動キャンセルトリガーのセットアップが完了しました。');
}

/**
 * シート作成または既存シートのヘッダ・列幅・フリーズ行整備（既存データ行は保持）
 */
function initSheetWithHeaders_(ss, sheetName, headers, colWidths) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  // 1行目ヘッダを設定・更新
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#1a365d')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(1);

  if (colWidths && colWidths.length === headers.length) {
    colWidths.forEach((w, idx) => {
      sheet.setColumnWidth(idx + 1, w);
    });
  }

  return sheet;
}

/**
 * 1時間経過した未決済注文（status = 0）を自動キャンセル（status = 4）にする時間主導トリガー設定
 * - すでに登録済みの場合は重複作成しない
 */
function setupAutoCancelTrigger() {
  const handlerName = 'autoCancelExpiredOrders';
  const triggers = ScriptApp.getProjectTriggers();
  const alreadyExists = triggers.some(t => t.getHandlerFunction() === handlerName);

  if (!alreadyExists) {
    ScriptApp.newTrigger(handlerName)
      .timeBased()
      .everyMinutes(10)
      .create();
  }
}