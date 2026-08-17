"""
V17 application bot — same filter and questionnaire as v17.vc/apply.

Applicants talk to @V17_apply_bot. Completed applications go to the same
Google Apps Script endpoint as the website form (Sheets + Notion + internal
Telegram chat). Hard-fail MRR is not saved. Soft-fail is marked and submitted.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from pathlib import Path

import httpx
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    PersistenceInput,
    PicklePersistence,
    filters,
)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("v17-apply-bot")

TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
SUBMIT_URL = os.environ.get(
    "SUBMIT_URL",
    "https://script.google.com/macros/s/AKfycbxnTuK2UxFXKCc2lswSbVNU2bzEbS-eJMHl_4DPBw7yb0AX3d7nbMLAK9u4R6mOvlGV/exec",
).strip()
PROXY_URL = os.environ.get(
    "PROXY_URL",
    "https://lightgray-oryx-237895.hostingersite.com/wp-json/srm/v1/v17",
).strip()
CONTACT_FALLBACK = "deals@v17.vc"

MRR_SOFT_B2C = 10000
MRR_HARD_B2C = 5000
MRR_SOFT_OTHER = 30000
MRR_HARD_OTHER = 15000

SEGMENTS = [("b2c", "B2C"), ("b2b", "B2B"), ("b2b2c", "B2B2C")]
STAGES = [
    ("seed", "Seed"),
    ("preseriesa", "Pre-Series A"),
    ("seriesa", "Series A"),
    ("seriesaplus", "Series A+"),
]
MARKETS = [
    ("global", "Global"),
    ("usa", "USA"),
    ("europe", "Europe"),
    ("latam", "LatAm"),
    ("sea", "SEA"),
    ("other", "Other"),
]
INSTRUMENTS = [
    ("investment", "Equity investment"),
    ("cohort", "Cohort financing"),
    ("media", "Marketing for equity"),
]
VERTICALS = [
    "HealthTech",
    "Wellbeing",
    "Productivity Tools",
    "Future of Work",
    "FinTech",
    "EdTech",
    "Entertainment",
    "Lifestyle",
    "MarTech",
    "DIY-Marketing Tools",
    "AI Operators",
    "AI Assistants for Business",
    "Gaming",
    "Gambling / Betting",
    "Other",
]
FREE_EMAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "aol.com", "mail.ru", "yandex.ru", "yandex.com", "protonmail.com", "pm.me",
    "gmx.com", "live.com", "msn.com", "inbox.ru", "bk.ru", "list.ru",
    "yahoo.co.uk", "googlemail.com",
}
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
DECK_MAX = 10 * 1024 * 1024

# After the gate. Conditional steps are skipped in next_step/prev_step.
APP_STEPS = [
    "company_name",
    "website",
    "interested_in",
    "amount_raising",
    "post_money",
    "verticals",
    "verticals_other",
    "problem",
    "pitch_deck",
    "icp",
    "team",
    "retention",
    "cac_ltv",
    "session",
    "payback",
    "sub_model",
    "organic_pct",
    "mrr_growth",
    "marketing_spend",
    "contact_name",
    "contact_email",
    "notes",
    "review",
]


def persist_path() -> str:
    if Path("/data").is_dir():
        return "/data/bot_data.pickle"
    return str(Path(__file__).resolve().parent / "bot_data.pickle")


def data(context: ContextTypes.DEFAULT_TYPE) -> dict:
    store = context.user_data.setdefault("app", {})
    store.setdefault("answers", {})
    store.setdefault("tmp", {})
    store.setdefault("step", "welcome")
    return store


def answers(context: ContextTypes.DEFAULT_TYPE) -> dict:
    return data(context)["answers"]


def is_b2c_only(ans: dict) -> bool:
    seg = ans.get("segment") or []
    return bool(seg) and all(s == "b2c" for s in seg)


def mrr_soft(ans: dict) -> int:
    return MRR_SOFT_B2C if is_b2c_only(ans) else MRR_SOFT_OTHER


def mrr_hard(ans: dict) -> int:
    return MRR_HARD_B2C if is_b2c_only(ans) else MRR_HARD_OTHER


def parse_money(text: str) -> float | None:
    raw = (text or "").strip().lower().replace("$", "").replace("\u00a0", " ")
    raw = raw.replace(",", "").replace(" ", "")
    if not raw:
        return None
    mult = 1
    if raw.endswith("k"):
        mult = 1000
        raw = raw[:-1]
    elif raw.endswith("m"):
        mult = 1_000_000
        raw = raw[:-1]
    try:
        return float(raw) * mult
    except ValueError:
        return None


def needs_raise(ans: dict) -> bool:
    sel = ans.get("interested_in") or []
    return "investment" in sel or "media" in sel


def skip_step(step: str, ans: dict) -> bool:
    if step == "market_other":
        return "other" not in (ans.get("market") or [])
    if step in ("amount_raising", "post_money"):
        return not needs_raise(ans)
    if step == "verticals_other":
        return "Other" not in (ans.get("verticals") or [])
    return False


def next_app_step(current: str, ans: dict) -> str:
    if current not in APP_STEPS:
        current = APP_STEPS[0]
        if not skip_step(current, ans):
            return current
    i = APP_STEPS.index(current)
    for step in APP_STEPS[i + 1:]:
        if not skip_step(step, ans):
            return step
    return "review"


def prev_app_step(current: str, ans: dict) -> str:
    if current not in APP_STEPS:
        return "market"
    i = APP_STEPS.index(current)
    for step in reversed(APP_STEPS[:i]):
        if not skip_step(step, ans):
            return step
    return "market"


def progress_label(step: str, ans: dict) -> str:
    visible = [s for s in APP_STEPS if s != "review" and not skip_step(s, ans)]
    if step not in visible:
        return ""
    return f"Question {visible.index(step) + 1} of {len(visible)}"


def label_of(options: list[tuple[str, str]], value: str) -> str:
    for key, label in options:
        if key == value:
            return label
    return value


def join_labels(options: list[tuple[str, str]], values: list[str]) -> str:
    return ", ".join(label_of(options, v) for v in values) or "—"


def nav_row(include_back: bool = True) -> list[InlineKeyboardButton]:
    row = []
    if include_back:
        row.append(InlineKeyboardButton("← Back", callback_data="nav:back"))
    row.append(InlineKeyboardButton("Start over", callback_data="nav:restart"))
    return row


def multi_keyboard(prefix: str, options: list[tuple[str, str]], selected: list[str], with_back: bool = True) -> InlineKeyboardMarkup:
    rows = []
    row: list[InlineKeyboardButton] = []
    for key, label in options:
        mark = "✓ " if key in selected else ""
        row.append(InlineKeyboardButton(f"{mark}{label}", callback_data=f"t:{prefix}:{key}"))
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append([InlineKeyboardButton("Next →", callback_data=f"n:{prefix}")])
    rows.append(nav_row(with_back))
    return InlineKeyboardMarkup(rows)


def single_keyboard(prefix: str, options: list[tuple[str, str]], with_back: bool = True) -> InlineKeyboardMarkup:
    rows = []
    row: list[InlineKeyboardButton] = []
    for key, label in options:
        row.append(InlineKeyboardButton(label, callback_data=f"s:{prefix}:{key}"))
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append(nav_row(with_back))
    return InlineKeyboardMarkup(rows)


def text_nav(with_back: bool = True, skip: bool = False) -> InlineKeyboardMarkup:
    extra = []
    if skip:
        extra.append([InlineKeyboardButton("Skip", callback_data="nav:skip")])
    extra.append(nav_row(with_back))
    return InlineKeyboardMarkup(extra)


WELCOME = (
    "V17 — capital and marketing for a product that can outpace its own growth\n\n"
    "4 quick questions first — if we're a clear mismatch, we'll say so right away. "
    "Then a short application. 5-7 minutes in total"
)

THESIS = (
    "<b>What we invest in</b>\n\n"
    "<b>Segments</b>\n"
    "· <b>B2C</b> Consumer, HealthTech, FinTech, EdTech, Wellbeing &amp; Lifestyle\n"
    "· <b>B2B</b> MarTech, AI assistants and Productivity Tools, Future of Work\n\n"
    "<b>Stage</b> Seed – Series A+\n\n"
    "<b>MRR</b>\n"
    "· from <b>$10k</b> (B2C)\n"
    "· from <b>$30k</b> (B2B)\n\n"
    "<b>Markets</b> Global, US, Europe"
)

HARD_DECLINE = (
    "<b>Thank you for your interest in V17.</b> This is below our current "
    "investment stage. Please reach out again once you've grown further — "
    "we'd be glad to take another look"
)

SOFT_DECLINE = (
    "This may not match our current focus — MRR below threshold "
    "(${soft} for {label}). You can still submit it — it will go into a "
    "separate pool for cohort financing and reconsideration, though we cannot "
    "guarantee a response"
)


async def send(update: Update, text: str, markup=None, html: bool = False) -> None:
    kwargs = {
        "text": text,
        "reply_markup": markup,
        "disable_web_page_preview": True,
    }
    if html:
        kwargs["parse_mode"] = ParseMode.HTML
    if update.callback_query:
        try:
            await update.callback_query.edit_message_text(**kwargs)
            return
        except Exception:
            pass
        await update.callback_query.message.reply_text(**kwargs)
        return
    await update.effective_message.reply_text(**kwargs)


async def ask(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    step = store["step"]
    ans = store["answers"]
    tmp = store["tmp"]
    handler = ASK.get(step)
    if not handler:
        store["step"] = "welcome"
        handler = ASK["welcome"]
    await handler(update, context, ans, tmp)


async def ask_welcome(update, context, ans, tmp):
    markup = InlineKeyboardMarkup([
        [InlineKeyboardButton("Start application", callback_data="nav:start")],
        [InlineKeyboardButton("What we invest in", callback_data="nav:thesis")],
    ])
    await send(update, WELCOME, markup)


async def ask_thesis(update, context, ans, tmp):
    markup = InlineKeyboardMarkup([
        [InlineKeyboardButton("Start application", callback_data="nav:start")],
        [InlineKeyboardButton("← Back", callback_data="nav:home")],
    ])
    await send(update, THESIS, markup, html=True)


async def ask_segment(update, context, ans, tmp):
    selected = tmp.setdefault("segment", list(ans.get("segment") or []))
    await send(
        update,
        "Quick fit check\n\n1/4  Segment — tap all that apply, then Next",
        multi_keyboard("segment", SEGMENTS, selected, with_back=False),
    )


async def ask_stage(update, context, ans, tmp):
    await send(
        update,
        "2/4  Stage — pick one",
        single_keyboard("stage", STAGES),
    )


async def ask_mrr(update, context, ans, tmp):
    floor = mrr_hard(ans)
    await send(
        update,
        f"3/4  Current MRR, $\n\nA number is enough — 35k, 35 000 or $35,000 all work. "
        f"Minimum we look at from {floor:,}".replace(",", " "),
        text_nav(),
    )


async def ask_market(update, context, ans, tmp):
    selected = tmp.setdefault("market", list(ans.get("market") or []))
    await send(
        update,
        "4/4  Top user markets — tap all that apply, then Next",
        multi_keyboard("market", MARKETS, selected),
    )


async def ask_market_other(update, context, ans, tmp):
    await send(update, "Which other markets? A few words is enough", text_nav())


async def ask_gate(update, context, ans, tmp):
    mrr = float(ans.get("mrr") or 0)
    hard = mrr_hard(ans)
    soft = mrr_soft(ans)
    if mrr < hard:
        ans["below_soft_threshold"] = False
        data(context)["step"] = "hard_fail"
        await send(
            update,
            HARD_DECLINE,
            InlineKeyboardMarkup([[InlineKeyboardButton("Start over", callback_data="nav:restart")]]),
            html=True,
        )
        return
    if mrr < soft:
        ans["below_soft_threshold"] = True
        label = "B2C" if is_b2c_only(ans) else "B2B"
        text = SOFT_DECLINE.format(soft=f"{soft:,}", label=label)
        await send(
            update,
            text,
            InlineKeyboardMarkup([
                [InlineKeyboardButton("Continue anyway", callback_data="nav:continue")],
                [InlineKeyboardButton("Stop here", callback_data="nav:stop")],
            ]),
        )
        return
    ans["below_soft_threshold"] = False
    data(context)["step"] = "company_name"
    await send(update, "Thanks — we're a fit on the basics. Let's get to the application")
    await ask(update, context)


async def ask_hard_fail(update, context, ans, tmp):
    await send(
        update,
        HARD_DECLINE,
        InlineKeyboardMarkup([[InlineKeyboardButton("Start over", callback_data="nav:restart")]]),
        html=True,
    )


async def q(step: str, ans: dict, body: str) -> str:
    label = progress_label(step, ans)
    return f"{label}\n\n{body}" if label else body


async def ask_company_name(update, context, ans, tmp):
    await send(update, await q("company_name", ans, "Company name"), text_nav())


async def ask_website(update, context, ans, tmp):
    await send(update, await q("website", ans, "Website — with https:// if you have it"), text_nav())


async def ask_interested_in(update, context, ans, tmp):
    selected = tmp.setdefault("interested_in", list(ans.get("interested_in") or []))
    await send(
        update,
        await q(
            "interested_in",
            ans,
            "Which instrument interests you — tap all that apply, then Next\n\n"
            "Cohort financing is for teams already spending $200k+/month on marketing",
        ),
        multi_keyboard("interested_in", INSTRUMENTS, selected),
    )


async def ask_amount_raising(update, context, ans, tmp):
    await send(update, await q("amount_raising", ans, "Amount raising, $"), text_nav())


async def ask_post_money(update, context, ans, tmp):
    await send(update, await q("post_money", ans, "Post-money valuation, $"), text_nav())


async def ask_verticals(update, context, ans, tmp):
    selected = tmp.setdefault("verticals", list(ans.get("verticals") or []))
    options = [(v, v) for v in VERTICALS]
    await send(
        update,
        await q("verticals", ans, "Verticals — tap all that apply, then Next"),
        multi_keyboard("verticals", options, selected),
    )


async def ask_verticals_other(update, context, ans, tmp):
    await send(update, await q("verticals_other", ans, "List relevant vertical(s) — describe briefly"), text_nav())


async def ask_problem(update, context, ans, tmp):
    await send(
        update,
        await q("problem", ans, "What you do and what problem you solve — 2-3 sentences"),
        text_nav(),
    )


async def ask_pitch_deck(update, context, ans, tmp):
    await send(
        update,
        await q(
            "pitch_deck",
            ans,
            "Pitch deck — send a link or attach a file (PDF/PPT, up to 10 MB)",
        ),
        text_nav(),
    )


async def ask_icp(update, context, ans, tmp):
    await send(update, await q("icp", ans, "ICP — who pays, why, how often"), text_nav())


async def ask_team(update, context, ans, tmp):
    await send(
        update,
        await q("team", ans, "Team — founders, background and links to profiles"),
        text_nav(),
    )


async def ask_retention(update, context, ans, tmp):
    await send(
        update,
        await q(
            "retention",
            ans,
            "Retention D30 / D60 / D90, %\n\nThree numbers, in that order — e.g. 40 25 18",
        ),
        text_nav(),
    )


async def ask_cac_ltv(update, context, ans, tmp):
    await send(
        update,
        await q("cac_ltv", ans, "CAC and LTV, $\n\nTwo numbers — e.g. 40 180"),
        text_nav(),
    )


async def ask_session(update, context, ans, tmp):
    await send(
        update,
        await q("session", ans, "Avg session, min — if relevant"),
        text_nav(skip=True),
    )


async def ask_payback(update, context, ans, tmp):
    await send(
        update,
        await q(
            "payback",
            ans,
            "Payback: overall period and month-by-month dynamics",
        ),
        text_nav(),
    )


async def ask_sub_model(update, context, ans, tmp):
    await send(
        update,
        await q("sub_model", ans, "Subscription model / monetization"),
        text_nav(),
    )


async def ask_organic(update, context, ans, tmp):
    await send(
        update,
        await q("organic_pct", ans, "% of organic traffic — a number"),
        text_nav(),
    )


async def ask_mrr_growth(update, context, ans, tmp):
    await send(
        update,
        await q("mrr_growth", ans, "MRR and avg MoM growth, % — e.g. $45k, +18%/mo"),
        text_nav(),
    )


async def ask_spend(update, context, ans, tmp):
    await send(
        update,
        await q("marketing_spend", ans, "Marketing spend, $/month"),
        text_nav(),
    )


async def ask_contact_name(update, context, ans, tmp):
    await send(update, await q("contact_name", ans, "Your name"), text_nav())


async def ask_contact_email(update, context, ans, tmp):
    await send(
        update,
        await q(
            "contact_email",
            ans,
            "Email — corporate only, no gmail, yahoo, hotmail and similar",
        ),
        text_nav(),
    )


async def ask_notes(update, context, ans, tmp):
    await send(
        update,
        await q("notes", ans, "Anything else we should know"),
        text_nav(skip=True),
    )


def review_text(ans: dict) -> str:
    lines = [
        "<b>Check before sending</b>",
        "",
        f"Segment: {join_labels(SEGMENTS, ans.get('segment') or [])}",
        f"Stage: {label_of(STAGES, ans.get('stage') or '')}",
        f"MRR: ${int(ans.get('mrr') or 0):,}",
        f"Markets: {join_labels(MARKETS, ans.get('market') or [])}",
    ]
    if ans.get("market_other"):
        lines.append(f"Other markets: {ans['market_other']}")
    lines += [
        f"Company: {ans.get('company_name') or '—'}",
        f"Website: {ans.get('website') or '—'}",
        f"Instrument: {join_labels(INSTRUMENTS, ans.get('interested_in') or [])}",
    ]
    if ans.get("amount_raising"):
        lines.append(f"Raising: ${int(ans['amount_raising']):,}")
    if ans.get("post_money"):
        lines.append(f"Post-money: ${int(ans['post_money']):,}")
    lines.append(f"Verticals: {', '.join(ans.get('verticals') or []) or '—'}")
    if ans.get("verticals_other"):
        lines.append(f"Other vertical: {ans['verticals_other']}")
    deck = ans.get("pitch_deck") or ("file attached" if ans.get("pitch_deck_file") else "—")
    lines += [
        f"Pitch deck: {deck}",
        f"Name: {ans.get('contact_name') or '—'}",
        f"Email: {ans.get('contact_email') or '—'}",
    ]
    if ans.get("below_soft_threshold"):
        lines += ["", "This application will go into the separate (below-threshold) pool"]
    return "\n".join(lines)


async def ask_review(update, context, ans, tmp):
    await send(
        update,
        review_text(ans),
        InlineKeyboardMarkup([
            [InlineKeyboardButton("Submit application", callback_data="nav:submit")],
            [InlineKeyboardButton("← Edit last answer", callback_data="nav:back")],
            [InlineKeyboardButton("Start over", callback_data="nav:restart")],
        ]),
        html=True,
    )


ASK = {
    "welcome": ask_welcome,
    "thesis": ask_thesis,
    "segment": ask_segment,
    "stage": ask_stage,
    "mrr": ask_mrr,
    "market": ask_market,
    "market_other": ask_market_other,
    "gate": ask_gate,
    "hard_fail": ask_hard_fail,
    "company_name": ask_company_name,
    "website": ask_website,
    "interested_in": ask_interested_in,
    "amount_raising": ask_amount_raising,
    "post_money": ask_post_money,
    "verticals": ask_verticals,
    "verticals_other": ask_verticals_other,
    "problem": ask_problem,
    "pitch_deck": ask_pitch_deck,
    "icp": ask_icp,
    "team": ask_team,
    "retention": ask_retention,
    "cac_ltv": ask_cac_ltv,
    "session": ask_session,
    "payback": ask_payback,
    "sub_model": ask_sub_model,
    "organic_pct": ask_organic,
    "mrr_growth": ask_mrr_growth,
    "marketing_spend": ask_spend,
    "contact_name": ask_contact_name,
    "contact_email": ask_contact_email,
    "notes": ask_notes,
    "review": ask_review,
}


def reset_app(context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data["app"] = {"answers": {}, "tmp": {}, "step": "welcome"}


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    ans = store["answers"]
    if ans.get("company_name") or ans.get("segment"):
        store["step"] = "welcome"
        await send(
            update,
            "You already have an application in progress. Continue or start over?",
            InlineKeyboardMarkup([
                [InlineKeyboardButton("Continue", callback_data="nav:continue_saved")],
                [InlineKeyboardButton("Start over", callback_data="nav:restart")],
            ]),
        )
        return
    reset_app(context)
    data(context)["step"] = "welcome"
    await ask(update, context)


async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    reset_app(context)
    await send(update, "Cleared. Send /start when you want to apply again")


def after_gate_or(step: str, ans: dict) -> str:
    if skip_step(step, ans):
        return next_app_step(step, ans)
    return step


async def go_next(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    step = store["step"]
    ans = store["answers"]
    order = ["segment", "stage", "mrr", "market", "market_other", "gate"]
    if step in order:
        i = order.index(step)
        nxt = order[i + 1] if i + 1 < len(order) else "company_name"
        while nxt not in ("gate", "company_name") and skip_step(nxt, ans):
            i = order.index(nxt)
            nxt = order[i + 1] if i + 1 < len(order) else "company_name"
        store["step"] = nxt
    elif step in APP_STEPS:
        store["step"] = next_app_step(step, ans)
    else:
        store["step"] = "welcome"
    await ask(update, context)


async def go_back(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    step = store["step"]
    ans = store["answers"]
    back_map = {
        "welcome": "welcome",
        "thesis": "welcome",
        "segment": "welcome",
        "stage": "segment",
        "mrr": "stage",
        "market": "mrr",
        "market_other": "market",
        "gate": "market_other" if not skip_step("market_other", ans) else "market",
        "hard_fail": "mrr",
    }
    if step in back_map:
        store["step"] = back_map[step]
    elif step in APP_STEPS:
        store["step"] = prev_app_step(step, ans)
    else:
        store["step"] = "welcome"
    await ask(update, context)


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    raw = query.data or ""
    store = data(context)
    ans = store["answers"]
    tmp = store["tmp"]

    if raw == "nav:home":
        store["step"] = "welcome"
        await ask(update, context)
        return
    if raw == "nav:thesis":
        store["step"] = "thesis"
        await ask(update, context)
        return
    if raw == "nav:start":
        store["step"] = "segment"
        await ask(update, context)
        return
    if raw == "nav:restart":
        reset_app(context)
        data(context)["step"] = "segment"
        await ask(update, context)
        return
    if raw == "nav:back":
        await go_back(update, context)
        return
    if raw == "nav:skip":
        step = store["step"]
        if step == "session":
            ans["session"] = ""
        if step == "notes":
            ans["notes"] = ""
        await go_next(update, context)
        return
    if raw == "nav:continue":
        store["step"] = "company_name"
        await send(update, "Thanks — we'll take the application into the separate pool")
        await ask(update, context)
        return
    if raw == "nav:stop":
        reset_app(context)
        await send(update, "Understood. Send /start if you want to try again later")
        return
    if raw == "nav:continue_saved":
        step = store.get("step") or "segment"
        if step in ("welcome", "thesis"):
            store["step"] = "segment" if not ans.get("segment") else step
        await ask(update, context)
        return
    if raw == "nav:submit":
        await submit_application(update, context)
        return

    if raw.startswith("t:"):
        _, prefix, key = raw.split(":", 2)
        selected = tmp.setdefault(prefix, list(ans.get(prefix) or []))
        if key in selected:
            selected.remove(key)
        else:
            selected.append(key)
        ans[prefix] = list(selected)
        await ask(update, context)
        return

    if raw.startswith("n:"):
        prefix = raw.split(":", 1)[1]
        selected = tmp.get(prefix) or ans.get(prefix) or []
        if not selected:
            await query.answer("Pick at least one", show_alert=True)
            return
        ans[prefix] = list(selected)
        await go_next(update, context)
        return

    if raw.startswith("s:"):
        _, prefix, key = raw.split(":", 2)
        ans[prefix] = key
        await go_next(update, context)
        return


def normalize_website(text: str) -> str | None:
    url = (text or "").strip()
    if not url:
        return None
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    if "." not in url:
        return None
    return url


def parse_three_numbers(text: str) -> list[float] | None:
    parts = re.split(r"[\s,/|;]+", (text or "").strip())
    parts = [p for p in parts if p]
    if len(parts) != 3:
        return None
    out = []
    for p in parts:
        try:
            out.append(float(p.replace("%", "").replace(",", ".")))
        except ValueError:
            return None
    return out


def parse_two_numbers(text: str) -> list[float] | None:
    parts = re.split(r"[\s,/|;]+", (text or "").strip())
    parts = [p for p in parts if p]
    if len(parts) != 2:
        return None
    out = []
    for p in parts:
        val = parse_money(p)
        if val is None:
            return None
        out.append(val)
    return out


def validate_email(text: str) -> str | None:
    val = (text or "").strip().lower()
    if not EMAIL_RE.match(val):
        return "Please enter a valid email address"
    domain = val.split("@", 1)[1]
    if domain in FREE_EMAIL_DOMAINS:
        return "This looks like a personal inbox — please use your company email"
    return None


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    step = store["step"]
    ans = store["answers"]
    text = (update.message.text or "").strip()

    if text in {"/start", "/cancel"}:
        return

    if step == "mrr":
        val = parse_money(text)
        if val is None or val < 0:
            await send(update, "Please send a number — 35k, 35000 or $35,000", text_nav())
            return
        ans["mrr"] = val
        await go_next(update, context)
        return

    if step == "market_other":
        if len(text) < 2:
            await send(update, "Please tell us which markets", text_nav())
            return
        ans["market_other"] = text
        await go_next(update, context)
        return

    if step == "company_name":
        ans["company_name"] = text
        await go_next(update, context)
        return

    if step == "website":
        url = normalize_website(text)
        if not url:
            await send(update, "That doesn't look like a website — try again", text_nav())
            return
        ans["website"] = url
        await go_next(update, context)
        return

    if step == "amount_raising":
        val = parse_money(text)
        if val is None:
            await send(update, "Please send a number", text_nav())
            return
        ans["amount_raising"] = val
        await go_next(update, context)
        return

    if step == "post_money":
        val = parse_money(text)
        if val is None:
            await send(update, "Please send a number", text_nav())
            return
        ans["post_money"] = val
        await go_next(update, context)
        return

    if step == "verticals_other":
        ans["verticals_other"] = text
        await go_next(update, context)
        return

    if step == "problem":
        ans["problem"] = text
        await go_next(update, context)
        return

    if step == "pitch_deck":
        url = normalize_website(text)
        if not url:
            await send(update, "Send a link or attach a PDF/PPT file", text_nav())
            return
        ans["pitch_deck"] = url
        ans.pop("pitch_deck_file", None)
        await go_next(update, context)
        return

    if step == "icp":
        ans["icp"] = text
        await go_next(update, context)
        return

    if step == "team":
        ans["team"] = text
        await go_next(update, context)
        return

    if step == "retention":
        nums = parse_three_numbers(text)
        if not nums:
            await send(update, "Please send three numbers — e.g. 40 25 18", text_nav())
            return
        ans["ret30"], ans["ret60"], ans["ret90"] = nums
        await go_next(update, context)
        return

    if step == "cac_ltv":
        nums = parse_two_numbers(text)
        if not nums:
            await send(update, "Please send two numbers — CAC then LTV, e.g. 40 180", text_nav())
            return
        ans["cac"], ans["ltv"] = nums
        await go_next(update, context)
        return

    if step == "session":
        val = parse_money(text)
        if val is None:
            await send(update, "A number, or tap Skip", text_nav(skip=True))
            return
        ans["session"] = val
        await go_next(update, context)
        return

    if step == "payback":
        ans["payback"] = text
        await go_next(update, context)
        return

    if step == "sub_model":
        ans["sub_model"] = text
        await go_next(update, context)
        return

    if step == "organic_pct":
        val = parse_money(text)
        if val is None or val < 0 or val > 100:
            await send(update, "A number from 0 to 100", text_nav())
            return
        ans["organic_pct"] = val
        await go_next(update, context)
        return

    if step == "mrr_growth":
        ans["mrr_growth"] = text
        await go_next(update, context)
        return

    if step == "marketing_spend":
        val = parse_money(text)
        if val is None:
            await send(update, "Please send a number", text_nav())
            return
        ans["marketing_spend"] = val
        await go_next(update, context)
        return

    if step == "contact_name":
        ans["contact_name"] = text
        await go_next(update, context)
        return

    if step == "contact_email":
        err = validate_email(text)
        if err:
            await send(update, err, text_nav())
            return
        ans["contact_email"] = text.strip().lower()
        await go_next(update, context)
        return

    if step == "notes":
        ans["notes"] = text
        await go_next(update, context)
        return

    if step in ("welcome", "thesis"):
        await ask(update, context)
        return

    await send(update, "Please use the buttons above, or send /start")


async def on_document(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    store = data(context)
    if store["step"] != "pitch_deck":
        await send(update, "A file is only needed for the pitch deck step")
        return
    doc = update.message.document
    if not doc:
        return
    if doc.file_size and doc.file_size > DECK_MAX:
        await send(update, "File is over 10 MB — send a smaller file or a link", text_nav())
        return
    try:
        tg_file = await context.bot.get_file(doc.file_id)
        raw = await tg_file.download_as_bytearray()
    except Exception as exc:
        log.exception("deck download failed: %s", exc)
        await send(update, "Could not download the file — try a link instead", text_nav())
        return
    store["answers"]["pitch_deck_file"] = {
        "name": doc.file_name or "pitch-deck",
        "mime": doc.mime_type or "application/octet-stream",
        "data": base64.b64encode(bytes(raw)).decode("ascii"),
    }
    store["answers"]["pitch_deck"] = store["answers"].get("pitch_deck") or ""
    await go_next(update, context)


async def post_payload(payload: dict) -> None:
    body = json.dumps(payload)
    headers = {"Content-Type": "text/plain;charset=utf-8"}
    timeout = httpx.Timeout(60.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            resp = await client.post(SUBMIT_URL, content=body, headers=headers)
            resp.raise_for_status()
            return
        except Exception as exc:
            log.warning("primary submit failed: %s", exc)
        resp = await client.post(PROXY_URL, content=body, headers=headers)
        resp.raise_for_status()


async def submit_application(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    ans = answers(context)
    user = update.effective_user
    if not ans.get("company_name") or not ans.get("contact_email"):
        await send(update, "Something is missing — please go back and finish the form")
        return
    payload = {
        "segment": ans.get("segment") or [],
        "stage": label_of(STAGES, ans.get("stage") or ""),
        "mrr": ans.get("mrr"),
        "market": [label_of(MARKETS, v) for v in (ans.get("market") or [])],
        "market_other": ans.get("market_other") or "",
        "company_name": ans.get("company_name"),
        "website": ans.get("website"),
        "interested_in": ans.get("interested_in") or [],
        "amount_raising": ans.get("amount_raising") or "",
        "post_money": ans.get("post_money") or "",
        "verticals": ans.get("verticals") or [],
        "verticals_other": ans.get("verticals_other") or "",
        "problem": ans.get("problem") or "",
        "pitch_deck": ans.get("pitch_deck") or "",
        "pitch_deck_file": ans.get("pitch_deck_file"),
        "icp": ans.get("icp") or "",
        "team": ans.get("team") or "",
        "ret30": ans.get("ret30"),
        "ret60": ans.get("ret60"),
        "ret90": ans.get("ret90"),
        "cac": ans.get("cac"),
        "ltv": ans.get("ltv"),
        "session": ans.get("session") or "",
        "payback": ans.get("payback") or "",
        "sub_model": ans.get("sub_model") or "",
        "organic_pct": ans.get("organic_pct"),
        "mrr_growth": ans.get("mrr_growth") or "",
        "marketing_spend": ans.get("marketing_spend") or "",
        "contact_name": ans.get("contact_name"),
        "contact_email": ans.get("contact_email"),
        "notes": ans.get("notes") or "",
        "below_soft_threshold": bool(ans.get("below_soft_threshold")),
        "source": "telegram_bot",
        "telegram": f"@{user.username}" if user and user.username else (str(user.id) if user else ""),
        "submitted_at": None,
    }
    if payload["pitch_deck_file"] is None:
        payload.pop("pitch_deck_file")
    await send(update, "Submitting…")
    try:
        await post_payload(payload)
    except Exception as exc:
        log.exception("submit failed: %s", exc)
        await send(
            update,
            f"Something went wrong — please try again or email {CONTACT_FALLBACK}",
            InlineKeyboardMarkup([
                [InlineKeyboardButton("Try again", callback_data="nav:submit")],
                [InlineKeyboardButton("← Back", callback_data="nav:back")],
            ]),
        )
        return
    reset_app(context)
    await send(
        update,
        "Application submitted\n\n"
        "We will look at the numbers and get back to you. If your application "
        "fits our criteria, we will reach out within a few weeks. Please do not "
        "be discouraged if you do not hear back from us — those are just our "
        "current focus areas, not a judgment on your company",
    )


async def load_remote_config() -> None:
    global MRR_SOFT_B2C, MRR_SOFT_OTHER, MRR_HARD_B2C, MRR_HARD_OTHER, VERTICALS
    url = SUBMIT_URL + "?action=config"
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            cfg = resp.json()
        th = cfg.get("thresholds") or {}
        MRR_SOFT_B2C = int(th.get("b2c") or MRR_SOFT_B2C)
        MRR_SOFT_OTHER = int(th.get("other") or MRR_SOFT_OTHER)
        MRR_HARD_B2C = int(th.get("hard_b2c") or MRR_HARD_B2C)
        MRR_HARD_OTHER = int(th.get("hard_other") or MRR_HARD_OTHER)
        verts = [v for v in (cfg.get("verticals") or []) if v]
        if verts:
            VERTICALS = verts
        log.info("config loaded: soft %s/%s hard %s/%s", MRR_SOFT_B2C, MRR_SOFT_OTHER, MRR_HARD_B2C, MRR_HARD_OTHER)
    except Exception as exc:
        log.warning("config fallback to defaults: %s", exc)


def main() -> None:
    if not TOKEN:
        raise SystemExit("TELEGRAM_TOKEN is not set")

    persistence = PicklePersistence(
        filepath=persist_path(),
        store_data=PersistenceInput(bot_data=False, chat_data=False, user_data=True, callback_data=False),
    )
    app = (
        Application.builder()
        .token(TOKEN)
        .persistence(persistence)
        .concurrent_updates(True)
        .build()
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.Document.ALL, on_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))

    async def on_boot(application: Application) -> None:
        await load_remote_config()
        log.info("V17 apply bot started, persistence=%s", persist_path())

    app.post_init = on_boot
    log.info("polling")
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)


if __name__ == "__main__":
    main()
