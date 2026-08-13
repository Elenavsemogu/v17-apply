# Форма заявок V17 — что это и как запустить

**Состав:**
- `index.html` — форма (EN): двухшаговый фильтр Quick Fit Check → полная анкета.
  Поля — строго по ТЗ «Заявка для заполнения командами»: сегменты B2C/B2B/B2B2C,
  стадии Seed…Series A+ (без Pre-Seed), рынки Top user markets (мультивыбор,
  с Global), pitch deck — ссылка или файл (до 10 МБ, уходит на Google Drive).
  Порог MRR: от $10k для чистого B2C, от $30k для остальных сегментов.
  Отказ мягкий: показывается вежливый отказ, но кнопкой «Submit anyway»
  заявку всё равно можно отправить — она помечается `hard_filter_failed`.
- `google-apps-script.js` — бэкенд на Google Apps Script: пишет заявку в Google
  Таблицу (журнал) и в Notion, шлёт уведомление в Telegram с кнопками
  «Отказ (шаблон)» / «Взяли в работу», по кнопке отправляет письмо-отказ заявителю.

Сервер не нужен. Всё живёт на GitHub Pages (форма) + Google (бэкенд).

**Правки без программиста:** при первом обращении скрипт сам создаёт в таблице
листы «Settings» и «Decline templates». В «Settings» правятся пороги MRR
(отдельно для чистого B2C и для остальных сегментов) и список вертикалей;
в «Decline templates» — кнопки и тексты
писем-отказов. Форма подтягивает настройки при каждой загрузке страницы,
письма читают шаблоны в момент отправки — передеплой не нужен.

---

## Чек-лист запуска

### 1. Google Таблица + скрипт (10 мин)
1. Создать таблицу «V17 Applications» ([sheets.new](https://sheets.new))
2. Расширения → Apps Script → вставить `google-apps-script.js`
3. Заполнить `CONFIG` (Notion и Telegram можно добавить позже — форма уже будет
   складывать заявки в таблицу)
4. Развернуть → Новое развертывание → **Веб-приложение**,
   «Выполнять как: Я», «Доступ: Все» → скопировать URL (`…/exec`)

### 2. Notion ✅ (подключено 13.08)
1. ✅ Токен интеграции выдал заказчик (в `ACCESS-HOSTING.md`, секция V17;
   в этот публичный репозиторий не класть!) → `CONFIG.NOTION_TOKEN`
2. ✅ Заявки пишутся прямо в CRM заказчика — база **«V17 dealflow»**
   (создавать отдельную базу не нужно). Скрипт мапит поля формы на их колонки:
   `Name` ← компания, `Email`, `Type` ← сегмент, `Industry` ← вертикали,
   `Revenue` ← MRR, `Estimated Value` ← сумма раунда, `Financing` ← инструмент,
   `Lead Source` = «Website form»; остальное (метрики, ICP, команда, питчдек) —
   в тело карточки. Не прошедшие фильтр помечаются ⚠️ в названии.
3. `CONFIG.NOTION_DATA_SOURCE_ID` — id источника данных базы (не самой базы;
   у «V17 dealflow» их два, нужен основной — значение в `ACCESS-HOSTING.md`).
4. Пере-развернуть скрипт (Управление развёртываниями → ✏️ → Новая версия)

### 3. Telegram (5 мин)
1. ✅ Бот создан: `@V17_Applications_Bot`, токен — в `ACCESS-HOSTING.md`
   (секция V17; в этот публичный репозиторий токен не класть!) →
   вписать в `CONFIG.TELEGRAM_TOKEN` прямо в Apps Script
2. Создать новый чат/группу, добавить туда бота
3. Узнать chat_id: написать что-нибудь в чат, открыть
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` → взять `chat.id`
   (у группы отрицательный, вида `-100…`) → `CONFIG.TELEGRAM_CHAT_ID`
4. В Apps Script: выбрать функцию `setupTelegramPolling` → Выполнить (одноразово;
   ставит таймер, который раз в минуту забирает нажатия кнопок из Telegram).
   Webhook НЕ использовать: Apps Script отвечает на POST редиректом 302,
   Telegram считает это ошибкой и зацикливает повторные доставки.

### 4. Почта отказов
- По умолчанию письма уходят с Google-ящика владельца скрипта.
- Чтобы слать с `deals@v17.vc`: либо делать шаги 1–4 из-под этого ящика,
  либо добавить его алиасом в Gmail владельца → вписать в `CONFIG.MAIL_FROM_ALIAS`.
- Лимит Gmail: ~100 писем/день на обычном аккаунте — для отказов достаточно.

### 5. Форма → хостинг → Тильда
1. В `index.html` вписать URL веб-приложения в `SUBMIT_URL`
2. Залить на GitHub Pages (отдельный репозиторий, Settings → Pages)
3. В Тильде на нужной странице: блок **T123 «HTML-код»** →
   `<iframe src="https://<адрес формы>" style="width:100%;height:1400px;border:0" loading="lazy"></iframe>`
   (высоту подогнать по месту; на мобиле форма сама адаптируется)

### 6. Проверка
- Отправить тестовую заявку с сайта → строка в таблице + карточка в Notion +
  сообщение в TG → нажать «Отказ» → письмо пришло на тестовую почту.

---

## Шаблоны отказов (на согласование Валерии/заказчику)

Все три с подстановкой имени и компании. Тон — вежливый, «дверь открыта».

**1. Not a fit now** — универсальный отказ:
> Hi {{name}}, — Thank you for applying to V17 and for the time you put into the
> application for {{company}}. We have reviewed it carefully, and at this point it
> does not match our current investment focus, so we will pass for now. This is a
> reflection of our thesis and portfolio construction today — not a judgment on
> your product or team. Things change quickly at our end as well: feel free to
> reapply once your metrics or stage move forward. — Wishing you a great run, V17 Team

**2. Below thresholds** — не дотягивает по метрикам/стадии:
> Hi {{name}}, — Thanks for your application to V17 with {{company}}. Right now the
> company is earlier than the profile we invest in (we focus on Seed to Series A+
> teams with MRR from $10k for B2C and from $30k for B2B). We will keep your
> application in our pipeline, and we would genuinely love to hear from you again
> once you cross those marks. — Best of luck — keep building, V17 Team

**3. Outside thesis** — не наша вертикаль:
> Hi {{name}}, — Thank you for telling us about {{company}}. We invest in a fairly
> narrow set of verticals (B2C consumer products and B2B marketing/AI tools), and
> your product falls outside that focus, so we will step aside here. It is purely
> a matter of thesis fit. — We appreciate your interest in V17 and wish you every
> success with the raise. V17 Team

---

## Принятые решения

Подтверждено Лерой 13.08 — **источник истины по полям: ТЗ «Заявка для
заполнения командами.docx», а не Notion-форма**:
- Segment: только B2C / B2B / B2B2C (B2G и Other убраны).
- Stage: Seed / Pre-Series A / Series A / Series A+ (Pre-Seed убран, автоотказ по стадии не нужен).
- Top user markets: мультивыбор Global / USA / Europe / LatAm / SEA / Other (на отказ не влияет).
- Pitch deck: ссылка ИЛИ файл (файл до 10 МБ, складывается на Google Drive владельца скрипта).
- Порог MRR: только-B2C = $10k; остальные/смешанные сегменты = $30k (строже).

Подтверждено Лерой 11.08:
- Поле Name добавлено; шкала fit оставлена.
- Пороги/вертикали/шаблоны отказов правятся из таблицы («однозначно да»).

Прочее:
- Метрики: короткий набор из ТЗ (Retention D30/60/90, session, CAC, LTV, payback,
  монетизация, % organic, MoM-рост, marketing spend); Avg session необязателен.
- Кастомный текст отказа из Telegram в MVP не делаем (3 шаблона + «Взяли в работу»);
  нестандартный ответ проще написать с почты напрямую.

## Ограничения MVP
- Кнопки в TG обрабатываются опросом раз в минуту: после нажатия реакция
  (пометка сообщения, письмо-отказ) приходит с задержкой до ~60 секунд.
- После нажатия кнопки в TG сообщение перерисовывается без HTML-жирности — косметика.
- WhatsApp-бот отложен (решение Леры), логика фильтра переносится на него без изменений.
