/**
 * V17 — приём заявок квалификационной формы.
 *
 * Что делает:
 *  1. Принимает POST от формы (index.html) → пишет строку в Google Таблицу (журнал/резерв)
 *     и создаёт страницу в базе Notion (заказчик работает в Notion).
 *  2. Шлёт уведомление в Telegram-чат с кнопками «Отказать (шаблон 1/2/3)».
 *  3. По нажатию кнопки отправляет письмо-отказ заявителю с выбранным шаблоном
 *     и помечает сообщение в чате.
 *
 * Установка — см. README-НАСТРОЙКА.md. Кратко:
 *  - создать Google Таблицу → Расширения → Apps Script → вставить этот код
 *  - заполнить CONFIG ниже
 *  - Развернуть → Веб-приложение (Выполнять как: я; Доступ: все) → URL в SUBMIT_URL формы
 *  - зарегистрировать этот же URL как webhook Telegram-бота (см. README)
 */

var CONFIG = {
  // Notion: токен интеграции и data source базы «V17 dealflow».
  // Оставить пустым — писать только в таблицу.
  NOTION_TOKEN: '',           // ntn_... (выдал заказчик)
  NOTION_DATA_SOURCE_ID: '',  // id источника данных базы (не самой базы!)

  // Telegram
  TELEGRAM_TOKEN: '',      // токен бота от @BotFather
  TELEGRAM_CHAT_ID: '',    // id чата заявок (см. README, шаг 3)

  // Почта для отказов. Пусто = ящик владельца скрипта.
  // Чтобы слать с deals@v17.vc — либо скрипт разворачивается из-под этого ящика,
  // либо ящик добавлен алиасом в Gmail владельца скрипта.
  MAIL_FROM_ALIAS: '',
  MAIL_FROM_NAME: 'V17 Team',
  // Куда уходят ответы кандидатов на письма-отказы. Работает даже если письмо
  // отправлено с личного ящика: кандидат жмёт Reply — и ответ идёт команде.
  MAIL_REPLY_TO: 'deals@v17.vc',

  SHEET_NAME: 'Applications',
  SETTINGS_SHEET: 'Settings',
  TEMPLATES_SHEET: 'Decline templates'
};

/* ==========================================================================
   НАСТРОЙКИ БЕЗ ПРОГРАММИСТА.
   При первом запуске скрипт сам создаёт листы «Settings» (ключ / значение)
   и «Decline templates» (Label / Subject / Body) с значениями по умолчанию.
   Дальше пороги MRR, список вертикалей и тексты отказов правятся прямо
   в таблице — форма подтягивает их при каждой загрузке страницы,
   письма-отказы читают тексты в момент отправки. Ничего передеплоивать не надо.
   ========================================================================== */
var DEFAULT_SETTINGS = [
  ['MRR_THRESHOLD_B2C', 10000, 'Порог MRR, если выбран ТОЛЬКО B2C'],
  ['MRR_THRESHOLD_OTHER', 30000, 'Порог MRR для остальных/смешанных сегментов (B2B, B2B2C)'],
  ['VERTICALS', 'HealthTech, Wellbeing, Productivity Tools, Future of Work, FinTech, EdTech, Entertainment, Lifestyle, MarTech, DIY-Marketing Tools, AI Operators, AI Assistants for Business, Gaming, Gambling / Betting, Other', 'Список вертикалей через запятую — порядок сохраняется на форме']
];

/* Стартовые шаблоны отказов — копируются в лист «Decline templates» при первом
   запуске, дальше источник истины — таблица. {{name}} и {{company}} подставляются. */
var DECLINE_TEMPLATES = [
  {
    label: 'Not a fit now',
    subject: 'V17 — your application',
    body: 'Hi {{name}},\n\n' +
      'Thank you for applying to V17 and for the time you put into the application for {{company}}.\n\n' +
      'We have reviewed it carefully, and at this point it does not match our current investment focus, so we will pass for now. This is a reflection of our thesis and portfolio construction today — not a judgment on your product or team.\n\n' +
      'Things change quickly at our end as well: feel free to reapply once your metrics or stage move forward.\n\n' +
      'Wishing you a great run,\nV17 Team'
  },
  {
    label: 'Below thresholds',
    subject: 'V17 — your application',
    body: 'Hi {{name}},\n\n' +
      'Thanks for your application to V17 with {{company}}.\n\n' +
      'Right now the company is earlier than the profile we invest in (we focus on Seed to Series A+ teams with MRR from $10k for B2C and from $30k for B2B). We will keep your application in our pipeline, and we would genuinely love to hear from you again once you cross those marks.\n\n' +
      'Best of luck — keep building,\nV17 Team'
  },
  {
    label: 'Outside thesis',
    subject: 'V17 — your application',
    body: 'Hi {{name}},\n\n' +
      'Thank you for telling us about {{company}}.\n\n' +
      'We invest in a fairly narrow set of verticals (B2C consumer products and B2B marketing/AI tools), and your product falls outside that focus, so we will step aside here. It is purely a matter of thesis fit.\n\n' +
      'We appreciate your interest in V17 and wish you every success with the raise.\n\n' +
      'V17 Team'
  }
];

/* ============================ приём запросов ============================ */

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // Апдейты Telegram сюда больше не приходят (webhook не используем —
    // GAS отвечает на POST редиректом 302, Telegram считает это ошибкой
    // и зацикливает повторы). Кнопки обрабатывает pollTelegram по таймеру.
    if (body.update_id !== undefined) {
      return jsonResponse({ ok: true, ignored: 'telegram update' });
    }
    // Заявка обязана содержать хотя бы название компании или email.
    if (!body.company_name && !body.contact_email) {
      return jsonResponse({ ok: false, error: 'empty submission ignored' });
    }
    return handleFormSubmission(body);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'config') {
    var s = getSettings();
    return jsonResponse({
      ok: true,
      thresholds: {
        b2c: Number(s.MRR_THRESHOLD_B2C) || 10000,
        other: Number(s.MRR_THRESHOLD_OTHER) || 30000
      },
      verticals: String(s.VERTICALS || '').split(',').map(function (v) { return v.trim(); }).filter(Boolean)
    });
  }
  return jsonResponse({ ok: true, service: 'v17-apply', time: new Date().toISOString() });
}

/* ==================== настройки и шаблоны из таблицы ==================== */

function getSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SETTINGS_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Ключ (не менять)', 'Значение (можно менять)', 'Что это']]);
    sheet.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 3);
  }
  var rows = sheet.getDataRange().getValues();
  var out = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0]) out[String(rows[i][0]).trim()] = rows[i][1];
  }
  return out;
}

function getDeclineTemplates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.TEMPLATES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TEMPLATES_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Label (кнопка в TG)', 'Subject', 'Body ({{name}}, {{company}})']]);
    var seed = DECLINE_TEMPLATES.map(function (t) { return [t.label, t.subject, t.body]; });
    sheet.getRange(2, 1, seed.length, 3).setValues(seed);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(3, 600);
  }
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][2]) {
      out.push({ label: String(rows[i][0]), subject: String(rows[i][1] || 'V17 — your application'), body: String(rows[i][2]) });
    }
  }
  return out.length ? out : DECLINE_TEMPLATES;
}

/* ============================ заявка с формы ============================ */

var SHEET_HEADERS = [
  'Submitted at', 'Hard filter failed', 'Company', 'Website', 'Segment', 'Stage',
  'Top user markets', 'MRR $', 'Interested in', 'Amount raising $', 'Post-money $',
  'Verticals', 'Problem', 'Pitch deck', 'ICP', 'Team',
  'Ret D30 %', 'Ret D60 %', 'Ret D90 %', 'CAC $', 'LTV $', 'Avg session min',
  'Payback', 'Monetization', 'Organic %', 'MRR growth', 'Marketing spend $/mo',
  'Contact name', 'Contact email', 'Notes', 'Status', 'Notion URL'
];

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleFormSubmission(d) {
  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); };
  /* Строки, начинающиеся с = + -, Sheets парсит как формулы (например
     «+18%/mo» превращается в #NAME?) — экранируем апострофом. */
  var safe = function (v) {
    return (typeof v === 'string' && /^[=+\-]/.test(v)) ? "'" + v : v;
  };

  /* Pitch deck по ТЗ — ссылка ИЛИ файл. Файл приходит base64 → кладём
     на Google Drive и дальше везде используем ссылку. */
  var deck = d.pitch_deck || '';
  if (d.pitch_deck_file && d.pitch_deck_file.data) {
    try {
      var fileUrl = saveDeckFile(d);
      deck = deck ? deck + ' · ' + fileUrl : fileUrl;
    } catch (err) {
      deck = deck || ('file upload failed: ' + err);
    }
  }
  d.pitch_deck = deck;

  var sheet = getSheet();
  var row = [
    d.submitted_at || new Date().toISOString(),
    d.hard_filter_failed ? 'YES' : '',
    d.company_name || '', d.website || '',
    joined(d.segment).toUpperCase(), d.stage || '', joined(d.market),
    d.mrr || '', joined(d.interested_in), d.amount_raising || '', d.post_money || '',
    joined(d.verticals), safe(d.problem || ''), d.pitch_deck || '', safe(d.icp || ''), safe(d.team || ''),
    d.ret30 || '', d.ret60 || '', d.ret90 || '', d.cac || '', d.ltv || '', d.session || '',
    safe(d.payback || ''), safe(d.sub_model || ''), d.organic_pct || '', safe(d.mrr_growth || ''), d.marketing_spend || '',
    safe(d.contact_name || ''), d.contact_email || '', safe(d.notes || ''),
    'new', ''
  ];
  sheet.appendRow(row);
  var rowNum = sheet.getLastRow();

  var notionUrl = '';
  try {
    notionUrl = createNotionPage(d);
    if (notionUrl) {
      sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).setValue(notionUrl);
    }
  } catch (err) {
    sheet.getRange(rowNum, SHEET_HEADERS.indexOf('Notion URL') + 1).setValue('ERROR: ' + err);
  }

  try {
    notifyTelegram(d, rowNum, notionUrl);
  } catch (err) {
    // Телеграм упал — заявка всё равно сохранена в таблице и Notion.
  }

  return jsonResponse({ ok: true });
}

/* Приложенный pitch deck → папка «V17 pitch decks» на Drive владельца скрипта.
   Доступ «всем по ссылке (просмотр)», чтобы ссылка работала из Notion/таблицы. */
function saveDeckFile(d) {
  var f = d.pitch_deck_file;
  var blob = Utilities.newBlob(
    Utilities.base64Decode(f.data),
    f.mime || 'application/octet-stream',
    (d.company_name ? d.company_name + ' — ' : '') + (f.name || 'pitch-deck')
  );
  var it = DriveApp.getFoldersByName('V17 pitch decks');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('V17 pitch decks');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/* ============================ Notion ============================
   Заявка становится карточкой в CRM заказчика «V17 dealflow».
   Маппинг на их реальные колонки (у 'Industry ' и 'Revenue ' в названии
   хвостовой пробел — так в их базе, не «чинить»!):
     Name ← компания · Email ← email · Type ← сегмент · Industry ← вертикали
     Revenue ← MRR · Estimated Value ← сумма раунда · Financing ← инструмент
     Lead Source ← 'Website form'. Остальные детали — в тело карточки. */

function createNotionPage(d) {
  if (!CONFIG.NOTION_TOKEN || !CONFIG.NOTION_DATA_SOURCE_ID) return '';

  var rt = function (s) { return [{ text: { content: String(s || '').slice(0, 1900) } }]; };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };

  // Сегменты формы → варианты их селекта Type.
  var seg = (d.segment || []).map(function (s) { return String(s).toLowerCase(); });
  var type = null;
  if (seg.indexOf('b2b2c') !== -1) type = 'B2B2C';
  else if (seg.indexOf('b2b') !== -1 && seg.indexOf('b2c') !== -1) type = 'B2B & B2C';
  else if (seg.indexOf('b2c') !== -1) type = 'B2C';
  else if (seg.indexOf('b2b') !== -1) type = 'B2B';
  else if (seg.length) type = seg[0].toUpperCase();

  // Наши вертикали → их опции Industry (несовпадающие Notion создаст сам).
  var industryRename = { 'Productivity Tools': 'Productivity tools' };
  var industries = (d.verticals || []).map(function (v) {
    return { name: industryRename[v] || v };
  });

  var finMap = { investment: 'Equity', cohort: 'Cohort financing', media: 'Marketing for equity' };
  var financing = (d.interested_in || []).map(function (v) { return { name: finMap[v] || v }; });

  var properties = {
    'Name':            { title: rt((d.hard_filter_failed ? '⚠️ ' : '') + (d.company_name || '(no name)')) },
    'Email':           { email: d.contact_email || null },
    'Revenue ':        { number: num(d.mrr) },
    'Estimated Value': { number: num(d.amount_raising) },
    'Lead Source':     { select: { name: 'Website form' } }
  };
  if (type) properties['Type'] = { select: { name: type } };
  if (industries.length) properties['Industry '] = { multi_select: industries };
  if (financing.length) properties['Financing'] = { multi_select: financing };

  var children = [];
  if (d.hard_filter_failed) {
    children.push({ callout: {
      icon: { emoji: '⚠️' },
      rich_text: rt('Did NOT pass the quick filter (MRR/stage below thresholds). Separate pool / cohort financing.')
    }});
  }
  var line = function (label, value) {
    if (value === undefined || value === null || value === '') return;
    children.push({ bulleted_list_item: { rich_text: [
      { text: { content: label + ': ' }, annotations: { bold: true } },
      { text: { content: String(value).slice(0, 1800) } }
    ]}});
  };
  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); };
  line('Website', d.website);
  line('Stage', d.stage);
  line('Top user markets', joined(d.market));
  line('Post-money, $', d.post_money);
  line('Pitch deck', d.pitch_deck);
  line('Contact', (d.contact_name || '') + ' · ' + (d.contact_email || ''));
  children.push({ heading_3: { rich_text: rt('Metrics') } });
  line('Retention D30/D60/D90, %', (d.ret30 || '—') + ' / ' + (d.ret60 || '—') + ' / ' + (d.ret90 || '—'));
  line('CAC / LTV, $', (d.cac || '—') + ' / ' + (d.ltv || '—'));
  line('Avg session, min', d.session);
  line('Payback', d.payback);
  line('Monetization', d.sub_model);
  line('Organic traffic, %', d.organic_pct);
  line('MRR & MoM growth', d.mrr_growth);
  line('Marketing spend, $/mo', d.marketing_spend);
  var block = function (title, text) {
    if (!text) return;
    children.push({ heading_3: { rich_text: rt(title) } });
    children.push({ paragraph: { rich_text: rt(text) } });
  };
  block('What & problem', d.problem);
  block('ICP', d.icp);
  block('Team', d.team);
  block('Notes', d.notes);

  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.NOTION_TOKEN,
      'Notion-Version': '2025-09-03'
    },
    payload: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: CONFIG.NOTION_DATA_SOURCE_ID },
      properties: properties,
      children: children
    }),
    muteHttpExceptions: true
  });
  var out = JSON.parse(resp.getContentText());
  if (out.object === 'error') throw new Error(out.message);
  return out.url || '';
}

/* ============================ Telegram ============================ */

/* Актуальный id чата. Telegram меняет id группы при апгрейде до супергруппы
   (например, после изменения настроек чата) — тогда старый id перестаёт
   работать. Новый id запоминаем в Script Properties (см. tg ниже). */
function tgChatId() {
  return PropertiesService.getScriptProperties().getProperty('tg_chat_id') || CONFIG.TELEGRAM_CHAT_ID;
}

function tg(method, payload) {
  var call = function () {
    return UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  };
  var resp = call();
  /* Группу апгрейдили до супергруппы → Telegram вернул новый chat_id.
     Запоминаем его и повторяем запрос, чтобы уведомление не потерялось. */
  try {
    var out = JSON.parse(resp.getContentText());
    var newId = out && !out.ok && out.parameters && out.parameters.migrate_to_chat_id;
    if (newId && payload && payload.chat_id) {
      PropertiesService.getScriptProperties().setProperty('tg_chat_id', String(newId));
      payload.chat_id = String(newId);
      resp = call();
    }
  } catch (e) { /* не-JSON ответ — отдаём как есть */ }
  return resp;
}

function notifyTelegram(d, rowNum, notionUrl) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || '—'); };
  var money = function (v) { return v ? '$' + Number(v).toLocaleString('en-US') : '—'; };

  var lines = [
    (d.hard_filter_failed ? '⚠️ <b>Новая заявка (НЕ прошла фильтр)</b>' : '✅ <b>Новая заявка</b>'),
    '',
    '<b>' + esc(d.company_name || '(без названия)') + '</b> — ' + esc(d.website || ''),
    esc(joined(d.segment).toUpperCase()) + ' · ' + esc(d.stage || '—') + ' · рынки: ' + esc(joined(d.market) || '—'),
    'MRR: ' + money(d.mrr) + ' · Raising: ' + money(d.amount_raising) + ' · Post-money: ' + money(d.post_money),
    'Интерес: ' + esc(joined(d.interested_in)),
    'Вертикали: ' + esc(joined(d.verticals)),
    'Retention 30/60/90: ' + esc((d.ret30 || '—') + '/' + (d.ret60 || '—') + '/' + (d.ret90 || '—') + '%') +
      ' · CAC ' + money(d.cac) + ' · LTV ' + money(d.ltv),
    'Organic: ' + esc(d.organic_pct || '—') + '% · Spend: ' + money(d.marketing_spend) + '/мес',
    (d.pitch_deck ? 'Deck: ' + esc(d.pitch_deck) : ''),
    '',
    '👤 ' + esc(d.contact_name || '—') + ' · ' + esc(d.contact_email || '—'),
    (notionUrl ? '📄 <a href="' + notionUrl + '">Открыть в Notion</a>' : '')
  ];

  /* В callback_data кладём номер строки + отпечаток email. Если строки
     в таблице удалят/отсортируют и номер «съедет», строка будет найдена
     заново по отпечатку — письмо не уйдёт не тому человеку. */
  var key = rowKey(d.contact_email, d.company_name);
  var keyboard = { inline_keyboard: [
    getDeclineTemplates().map(function (t, i) {
      return { text: '✉️ Отказ: ' + t.label, callback_data: 'd:' + rowNum + ':' + i + ':' + key };
    }),
    [{ text: '✔️ Взяли в работу', callback_data: 'p:' + rowNum + ':' + key }]
  ]};

  tg('sendMessage', {
    chat_id: tgChatId(),
    text: lines.filter(Boolean).join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

/* Опрос Telegram по таймеру (каждую минуту). Забирает нажатия кнопок
   через getUpdates и обрабатывает их. Оффсет хранится в Script Properties,
   поэтому каждое нажатие обрабатывается ровно один раз. */
function pollTelegram() {
  if (!CONFIG.TELEGRAM_TOKEN) return;
  var props = PropertiesService.getScriptProperties();
  var offset = Number(props.getProperty('tg_offset') || 0);
  var resp = tg('getUpdates', { offset: offset + 1, allowed_updates: ['callback_query'] });
  var out = JSON.parse(resp.getContentText());
  if (!out.ok) return;
  out.result.forEach(function (u) {
    if (u.update_id > offset) offset = u.update_id;
    if (u.callback_query) {
      try { handleCallback(u.callback_query); } catch (e) { /* не роняем остальные */ }
    }
  });
  props.setProperty('tg_offset', String(offset));
}

/* Короткий отпечаток заявки (email+компания) для проверки, что номер строки
   всё ещё указывает на ту же заявку. */
function rowKey(email, company) {
  var raw = String(email || '') + '|' + String(company || '');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < 4; i++) {
    hex += ((digest[i] + 256) % 256).toString(16).padStart(2, '0');
  }
  return hex;
}

/* Находит строку заявки: сначала проверяет сохранённый номер, при несовпадении
   отпечатка ищет по всей таблице. Возвращает номер строки или 0. */
function findRow(sheet, rowNum, key) {
  var emailCol = SHEET_HEADERS.indexOf('Contact email');
  var companyCol = SHEET_HEADERS.indexOf('Company');
  var last = sheet.getLastRow();
  if (rowNum >= 2 && rowNum <= last) {
    var row = sheet.getRange(rowNum, 1, 1, SHEET_HEADERS.length).getValues()[0];
    if (rowKey(row[emailCol], row[companyCol]) === key) return rowNum;
  }
  if (last < 2) return 0;
  var all = sheet.getRange(2, 1, last - 1, SHEET_HEADERS.length).getValues();
  for (var i = 0; i < all.length; i++) {
    if (rowKey(all[i][emailCol], all[i][companyCol]) === key) return i + 2;
  }
  return 0;
}

function handleCallback(cb) {
  var parts = (cb.data || '').split(':');
  var kind = parts[0];
  var sheet = getSheet();
  var statusCol = SHEET_HEADERS.indexOf('Status') + 1;
  var rowNum, key;

  if (kind === 'p') {
    rowNum = parseInt(parts[1], 10);
    key = parts[2];
    if (key) rowNum = findRow(sheet, rowNum, key);
    if (!rowNum) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Строка заявки не найдена (удалена?)', show_alert: true });
      return;
    }
    sheet.getRange(rowNum, statusCol).setValue('in progress');
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Помечено: в работе' });
    appendToMessage(cb, '\n\n✔️ <b>Взято в работу</b> (' + esc(cb.from.first_name || '') + ')');
    return;
  }

  if (kind === 'd') {
    rowNum = parseInt(parts[1], 10);
    var tplIdx = parseInt(parts[2], 10);
    key = parts[3];
    var tpl = getDeclineTemplates()[tplIdx];
    if (key) rowNum = findRow(sheet, rowNum, key);
    if (!rowNum) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Строка заявки не найдена (удалена?)', show_alert: true });
      return;
    }
    var row = sheet.getRange(rowNum, 1, 1, SHEET_HEADERS.length).getValues()[0];
    var email = row[SHEET_HEADERS.indexOf('Contact email')];
    var name = row[SHEET_HEADERS.indexOf('Contact name')] || 'there';
    var company = row[SHEET_HEADERS.indexOf('Company')] || 'your company';

    if (!email || !tpl) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет email или шаблона', show_alert: true });
      return;
    }

    var fill = function (s) {
      return s.replace(/{{name}}/g, name).replace(/{{company}}/g, company);
    };
    var mailOpts = { name: CONFIG.MAIL_FROM_NAME };
    if (CONFIG.MAIL_FROM_ALIAS) mailOpts.from = CONFIG.MAIL_FROM_ALIAS;
    if (CONFIG.MAIL_REPLY_TO) mailOpts.replyTo = CONFIG.MAIL_REPLY_TO;
    GmailApp.sendEmail(email, fill(tpl.subject), fill(tpl.body), mailOpts);

    sheet.getRange(rowNum, statusCol).setValue('declined (' + tpl.label + ')');
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отказ отправлен на ' + email });
    appendToMessage(cb, '\n\n❌ <b>Отказ отправлен</b> («' + esc(tpl.label) + '», ' + esc(cb.from.first_name || '') + ')');
  }
}

function appendToMessage(cb, suffix) {
  try {
    tg('editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: cb.message.text + suffix,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (e) { /* не критично */ }
}

/* ============================ утилиты ============================ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Одноразовый запуск: включает обработку кнопок Telegram.
   Удаляет webhook (несовместим с GAS — тот отвечает 302, Telegram зацикливает
   повторы) и ставит таймер, который раз в минуту опрашивает getUpdates. */
function setupTelegramPolling() {
  if (!CONFIG.TELEGRAM_TOKEN) throw new Error('Сначала впиши TELEGRAM_TOKEN в CONFIG');
  tg('deleteWebhook', { drop_pending_updates: true });

  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'pollTelegram';
  });
  if (!exists) {
    ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  }
  Logger.log('Polling включён: триггер pollTelegram раз в минуту.');
}
