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
  // Notion: интеграция и база. Оставить пустым — писать только в таблицу.
  NOTION_TOKEN: '',        // secret_... (из notion.so/my-integrations)
  NOTION_DATABASE_ID: '',  // 32 символа из URL базы

  // Telegram
  TELEGRAM_TOKEN: '',      // токен бота от @BotFather
  TELEGRAM_CHAT_ID: '',    // id чата заявок (см. README, шаг 3)

  // Почта для отказов. Пусто = ящик владельца скрипта.
  // Чтобы слать с deals@v17.vc — либо скрипт разворачивается из-под этого ящика,
  // либо ящик добавлен алиасом в Gmail владельца скрипта.
  MAIL_FROM_ALIAS: '',
  MAIL_FROM_NAME: 'V17 Team',

  SHEET_NAME: 'Applications'
};

/* Шаблоны отказов. {{name}} и {{company}} подставляются автоматически. */
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
    if (body.callback_query || body.message) {
      return handleTelegramUpdate(body);
    }
    return handleFormSubmission(body);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet() {
  return jsonResponse({ ok: true, service: 'v17-apply', time: new Date().toISOString() });
}

/* ============================ заявка с формы ============================ */

var SHEET_HEADERS = [
  'Submitted at', 'Hard filter failed', 'Company', 'Website', 'Segment', 'Stage',
  'Primary market', 'MRR $', 'Interested in', 'Amount raising $', 'Post-money $',
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

  var sheet = getSheet();
  var row = [
    d.submitted_at || new Date().toISOString(),
    d.hard_filter_failed ? 'YES' : '',
    d.company_name || '', d.website || '',
    joined(d.segment).toUpperCase(), d.stage || '', d.market || '',
    d.mrr || '', joined(d.interested_in), d.amount_raising || '', d.post_money || '',
    joined(d.verticals), d.problem || '', d.pitch_deck || '', d.icp || '', d.team || '',
    d.ret30 || '', d.ret60 || '', d.ret90 || '', d.cac || '', d.ltv || '', d.session || '',
    d.payback || '', d.sub_model || '', d.organic_pct || '', d.mrr_growth || '', d.marketing_spend || '',
    d.contact_name || '', d.contact_email || '', d.notes || '',
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

/* ============================ Notion ============================ */

function createNotionPage(d) {
  if (!CONFIG.NOTION_TOKEN || !CONFIG.NOTION_DATABASE_ID) return '';

  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); };
  var rt = function (s) { return [{ text: { content: String(s || '').slice(0, 1900) } }]; };
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };
  var multi = function (v) {
    return (Array.isArray(v) ? v : (v ? [v] : [])).map(function (x) { return { name: String(x) }; });
  };

  // Названия свойств должны совпадать с колонками базы в Notion (см. README, шаг 2).
  var properties = {
    'Company':               { title: rt(d.company_name || '(no name)') },
    'Website':               { url: d.website || null },
    'Segment':               { multi_select: multi((d.segment || []).map(function (s) { return String(s).toUpperCase(); })) },
    'Stage':                 { select: d.stage ? { name: d.stage } : null },
    'Primary Market':        { select: d.market ? { name: d.market } : null },
    'MRR (USD)':             { number: num(d.mrr) },
    'Interested In':         { multi_select: multi(d.interested_in) },
    'Amount Raising (USD)':  { number: num(d.amount_raising) },
    'Post-Money (USD)':      { number: num(d.post_money) },
    'Verticals':             { multi_select: multi(d.verticals) },
    'Pitch Deck':            { url: d.pitch_deck || null },
    'Retention D30 (%)':     { number: num(d.ret30) },
    'Retention D60 (%)':     { number: num(d.ret60) },
    'Retention D90 (%)':     { number: num(d.ret90) },
    'CAC (USD)':             { number: num(d.cac) },
    'LTV (USD)':             { number: num(d.ltv) },
    'Payback':               { rich_text: rt(d.payback) },
    'Monetization':          { rich_text: rt(d.sub_model) },
    'Organic Traffic (%)':   { number: num(d.organic_pct) },
    'MRR Growth':            { rich_text: rt(d.mrr_growth) },
    'Marketing Spend (USD/mo)': { number: num(d.marketing_spend) },
    'Contact Name':          { rich_text: rt(d.contact_name) },
    'Contact Email':         { email: d.contact_email || null },
    'Hard Filter Failed':    { checkbox: !!d.hard_filter_failed },
    'Status':                { select: { name: 'New' } }
  };

  var children = [];
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
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      parent: { database_id: CONFIG.NOTION_DATABASE_ID },
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

function tg(method, payload) {
  return UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function notifyTelegram(d, rowNum, notionUrl) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  var joined = function (v) { return Array.isArray(v) ? v.join(', ') : (v || '—'); };
  var money = function (v) { return v ? '$' + Number(v).toLocaleString('en-US') : '—'; };

  var lines = [
    (d.hard_filter_failed ? '⚠️ <b>Новая заявка (НЕ прошла фильтр)</b>' : '✅ <b>Новая заявка</b>'),
    '',
    '<b>' + esc(d.company_name || '(без названия)') + '</b> — ' + esc(d.website || ''),
    esc(joined(d.segment).toUpperCase()) + ' · ' + esc(d.stage || '—') + ' · рынок: ' + esc(d.market || '—'),
    'MRR: ' + money(d.mrr) + ' · Raising: ' + money(d.amount_raising) + ' · Post-money: ' + money(d.post_money),
    'Интерес: ' + esc(joined(d.interested_in)),
    'Вертикали: ' + esc(joined(d.verticals)),
    'Retention 30/60/90: ' + esc((d.ret30 || '—') + '/' + (d.ret60 || '—') + '/' + (d.ret90 || '—') + '%') +
      ' · CAC ' + money(d.cac) + ' · LTV ' + money(d.ltv),
    'Organic: ' + esc(d.organic_pct || '—') + '% · Spend: ' + money(d.marketing_spend) + '/мес',
    '',
    '👤 ' + esc(d.contact_name || '—') + ' · ' + esc(d.contact_email || '—'),
    (notionUrl ? '📄 <a href="' + notionUrl + '">Открыть в Notion</a>' : '')
  ];

  var keyboard = { inline_keyboard: [
    DECLINE_TEMPLATES.map(function (t, i) {
      return { text: '✉️ Отказ: ' + t.label, callback_data: 'd:' + rowNum + ':' + i };
    }),
    [{ text: '✔️ Взяли в работу', callback_data: 'p:' + rowNum }]
  ]};

  tg('sendMessage', {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: lines.filter(Boolean).join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard
  });
}

function handleTelegramUpdate(update) {
  var cb = update.callback_query;
  if (!cb) return jsonResponse({ ok: true }); // обычные сообщения игнорируем

  var parts = (cb.data || '').split(':');
  var kind = parts[0];
  var rowNum = parseInt(parts[1], 10);
  var sheet = getSheet();
  var statusCol = SHEET_HEADERS.indexOf('Status') + 1;

  if (kind === 'p') {
    sheet.getRange(rowNum, statusCol).setValue('in progress');
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Помечено: в работе' });
    appendToMessage(cb, '\n\n✔️ <b>Взято в работу</b> (' + esc(cb.from.first_name || '') + ')');
    return jsonResponse({ ok: true });
  }

  if (kind === 'd') {
    var tplIdx = parseInt(parts[2], 10);
    var tpl = DECLINE_TEMPLATES[tplIdx];
    var row = sheet.getRange(rowNum, 1, 1, SHEET_HEADERS.length).getValues()[0];
    var email = row[SHEET_HEADERS.indexOf('Contact email')];
    var name = row[SHEET_HEADERS.indexOf('Contact name')] || 'there';
    var company = row[SHEET_HEADERS.indexOf('Company')] || 'your company';

    if (!email || !tpl) {
      tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет email или шаблона', show_alert: true });
      return jsonResponse({ ok: true });
    }

    var fill = function (s) {
      return s.replace(/{{name}}/g, name).replace(/{{company}}/g, company);
    };
    var mailOpts = { name: CONFIG.MAIL_FROM_NAME };
    if (CONFIG.MAIL_FROM_ALIAS) mailOpts.from = CONFIG.MAIL_FROM_ALIAS;
    GmailApp.sendEmail(email, fill(tpl.subject), fill(tpl.body), mailOpts);

    sheet.getRange(rowNum, statusCol).setValue('declined (' + tpl.label + ')');
    tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отказ отправлен на ' + email });
    appendToMessage(cb, '\n\n❌ <b>Отказ отправлен</b> («' + esc(tpl.label) + '», ' + esc(cb.from.first_name || '') + ')');
  }

  return jsonResponse({ ok: true });
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

/* Одноразовый запуск после деплоя: регистрирует webhook Telegram на URL веб-приложения.
   Перед запуском вписать URL деплоя (заканчивается на /exec). */
function setupTelegramWebhook() {
  var WEB_APP_URL = ''; // ← вставить URL веб-приложения
  if (!WEB_APP_URL) throw new Error('Впиши WEB_APP_URL');
  var resp = tg('setWebhook', { url: WEB_APP_URL, allowed_updates: ['callback_query'] });
  Logger.log(resp.getContentText());
}
