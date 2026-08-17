# @V17_apply_bot

Тот же фильтр и анкета, что на [v17.vc/apply](https://v17.vc/apply). Заявки уходят в тот же Google Apps Script — таблица, Notion, внутренний чат.

Живёт на Amvera (Варшава), проект `v17-apply-bot`. Токен — только в переменных окружения, не в git.

## Локально

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export TELEGRAM_TOKEN=...
python bot.py
```

## Amvera

1. Проект Python + pip, точка входа `bot.py`, диск `/data`.
2. Переменные: `TELEGRAM_TOKEN`, `SUBMIT_URL`, `PROXY_URL`, `PYTHONUNBUFFERED=1`.
3. `git push amvera master` из этой папки.
