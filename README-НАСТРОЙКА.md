# Форма заявок V17 — что это и как запустить

**Состав:**
- `index.html` — форма (EN): двухшаговый фильтр Quick Fit Check → полная анкета.
  Пороги: MRR от $10k для чистого B2C, от $30k для остальных сегментов;
  Pre-Seed — мягкий автоотказ. Отказ мягкий: заявку всё равно можно отправить,
  она помечается `hard_filter_failed`.
- `google-apps-script.js` — бэкенд на Google Apps Script: пишет заявку в Google
  Таблицу (журнал) и в Notion, шлёт уведомление в Telegram с кнопками
  «Отказ (шаблон)» / «Взяли в работу», по кнопке отправляет письмо-отказ заявителю.

Сервер не нужен. Всё живёт на GitHub Pages (форма) + Google (бэкенд).

---

## Чек-лист запуска

### 1. Google Таблица + скрипт (10 мин)
1. Создать таблицу «V17 Applications» ([sheets.new](https://sheets.new))
2. Расширения → Apps Script → вставить `google-apps-script.js`
3. Заполнить `CONFIG` (Notion и Telegram можно добавить позже — форма уже будет
   складывать заявки в таблицу)
4. Развернуть → Новое развертывание → **Веб-приложение**,
   «Выполнять как: Я», «Доступ: Все» → скопировать URL (`…/exec`)

### 2. Notion (когда дадут доступ)
1. [notion.so/my-integrations](https://notion.so/my-integrations) → New integration
   (workspace заказчика) → скопировать токен в `CONFIG.NOTION_TOKEN`
2. Создать в Notion базу-таблицу со свойствами (имена должны совпадать!):
   `Company` (Title), `Website` (URL), `Segment` (Multi-select), `Stage` (Select),
   `Primary Market` (Select), `MRR (USD)` (Number), `Interested In` (Multi-select),
   `Amount Raising (USD)` (Number), `Post-Money (USD)` (Number), `Verticals` (Multi-select),
   `Pitch Deck` (URL), `Retention D30 (%)`/`D60`/`D90` (Number), `CAC (USD)` (Number),
   `LTV (USD)` (Number), `Payback` (Text), `Monetization` (Text), `Organic Traffic (%)` (Number),
   `MRR Growth` (Text), `Marketing Spend (USD/mo)` (Number), `Contact Name` (Text),
   `Contact Email` (Email), `Hard Filter Failed` (Checkbox), `Status` (Select)
3. На странице базы: ⋯ → Connections → добавить созданную интеграцию
4. ID базы (32 символа из URL) → `CONFIG.NOTION_DATABASE_ID`
5. Пере-развернуть скрипт (Управление развёртываниями → ✏️ → Новая версия)

### 3. Telegram (5 мин)
1. У @BotFather: `/newbot` → имя вроде `V17 Applications Bot` → скопировать токен
   в `CONFIG.TELEGRAM_TOKEN`
2. Создать новый чат/группу, добавить туда бота
3. Узнать chat_id: написать что-нибудь в чат, открыть
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` → взять `chat.id`
   (у группы отрицательный, вида `-100…`) → `CONFIG.TELEGRAM_CHAT_ID`
4. В Apps Script: функция `setupTelegramWebhook` → вписать URL веб-приложения →
   Выполнить (регистрирует webhook, чтобы работали кнопки)

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

## Принятые решения (Лера делегировала)

- Поля и варианты — из Notion-формы заказчика; двухшаговый фильтр — из заявки.
- Pre-Seed → мягкий автоотказ (фокус «Seed - Series A+»).
- Порог MRR: только-B2C = $10k, любые другие/смешанные сегменты = $30k.
- Primary Market — одиночный выбор (как в Notion), на отказ не влияет.
- Метрики: набор Notion + Retention D30/60/90 и монетизация из заявки; Avg session необязателен.
- Pitch deck — только ссылкой (без загрузки файлов).
- Боковая шкала fit оставлена («в идеале оставить»).
- Кастомный текст отказа из Telegram в MVP не делаем (3 шаблона + «Взяли в работу»);
  нестандартный ответ проще написать с почты напрямую.

## Ограничения MVP
- После нажатия кнопки в TG сообщение перерисовывается без HTML-жирности — косметика.
- WhatsApp-бот отложен (решение Леры), логика фильтра переносится на него без изменений.
