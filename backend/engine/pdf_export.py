"""PDF export engine for meeting protocols and template test runs."""

import io
import json
import logging
import os
import re
import sys
from typing import Any, Optional

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
    HRFlowable,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

logger = logging.getLogger("steppe.pdf")

_FONTS_INITIALIZED = False


def ensure_pdf_fonts():
    """Register TrueType fonts with full Cyrillic and Kazakh unicode glyph support."""
    global _FONTS_INITIALIZED
    if _FONTS_INITIALIZED:
        return

    regular_candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    bold_candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    italic_candidates = [
        "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
        "/Library/Fonts/Arial Italic.ttf",
        "C:\\Windows\\Fonts\\ariali.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
    ]

    reg_path = next((p for p in regular_candidates if os.path.exists(p)), None)
    bold_path = next((p for p in bold_candidates if os.path.exists(p)), None)
    italic_path = next((p for p in italic_candidates if os.path.exists(p)), None)

    if reg_path:
        try:
            pdfmetrics.registerFont(TTFont("CustomArial", reg_path))
            pdfmetrics.registerFont(TTFont("CustomArial-Bold", bold_path or reg_path))
            pdfmetrics.registerFont(TTFont("CustomArial-Italic", italic_path or reg_path))
            pdfmetrics.registerFontFamily(
                "CustomArial",
                normal="CustomArial",
                bold="CustomArial-Bold",
                italic="CustomArial-Italic",
            )
            _FONTS_INITIALIZED = True
            logger.info("PDF fonts registered from %s", reg_path)
            return
        except Exception as e:
            logger.warning("Failed to register TrueType font %s: %s", reg_path, e)

    _FONTS_INITIALIZED = True


class NumberedCanvas(canvas.Canvas):
    """Two-pass canvas that renders 'Стр. X из Y' footer on every page."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)

    def draw_page_decorations(self, page_count):
        self.saveState()
        font_name = "CustomArial" if _FONTS_INITIALIZED else "Helvetica"
        self.setFont(font_name, 8.5)
        self.setFillColor(colors.HexColor("#64748b"))

        # Footer divider line
        self.setStrokeColor(colors.HexColor("#e2e8f0"))
        self.setLineWidth(0.75)
        self.line(40, 36, A4[0] - 40, 36)

        # Footer labels
        left_text = "Steppe Meeting — Протокол"
        page_text = f"Стр. {self._pageNumber} из {page_count}"
        self.drawString(40, 24, left_text)
        self.drawRightString(A4[0] - 40, 24, page_text)
        self.restoreState()


def _get_styles():
    ensure_pdf_fonts()
    font_main = "CustomArial"
    font_bold = "CustomArial-Bold"

    styles = getSampleStyleSheet()

    doc_type_style = ParagraphStyle(
        "DocType",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=13,
        leading=16,
        alignment=1,  # Center
        textColor=colors.HexColor("#1e3a8a"),  # Deep Navy
        spaceAfter=4,
    )

    title_style = ParagraphStyle(
        "ProtocolTitle",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=15,
        leading=19,
        alignment=1,  # Center
        textColor=colors.HexColor("#0f172a"),  # Slate 900
        spaceAfter=12,
    )

    section_heading = ParagraphStyle(
        "SectionHeading",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=11.5,
        leading=15,
        textColor=colors.HexColor("#1e293b"),  # Slate 800
        spaceBefore=10,
        spaceAfter=6,
    )

    topic_title = ParagraphStyle(
        "TopicTitle",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=10.5,
        leading=14,
        textColor=colors.HexColor("#1e40af"),  # Blue 800
        spaceBefore=6,
        spaceAfter=4,
    )

    body = ParagraphStyle(
        "ProtocolBody",
        parent=styles["Normal"],
        fontName=font_main,
        fontSize=9.5,
        leading=13.5,
        textColor=colors.HexColor("#334155"),  # Slate 700
    )

    body_bold = ParagraphStyle(
        "ProtocolBodyBold",
        parent=body,
        fontName=font_bold,
        textColor=colors.HexColor("#1e293b"),
    )

    body_dim = ParagraphStyle(
        "ProtocolBodyDim",
        parent=body,
        fontSize=8.5,
        leading=12,
        textColor=colors.HexColor("#64748b"),
    )

    th_style = ParagraphStyle(
        "TableHeader",
        parent=styles["Normal"],
        fontName=font_bold,
        fontSize=9,
        leading=12,
        alignment=1,  # Center
        textColor=colors.HexColor("#1e293b"),
    )

    td_style = ParagraphStyle(
        "TableCell",
        parent=styles["Normal"],
        fontName=font_main,
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor("#1e293b"),
    )

    td_bold_style = ParagraphStyle(
        "TableCellBold",
        parent=td_style,
        fontName=font_bold,
    )

    td_center = ParagraphStyle(
        "TableCellCenter",
        parent=td_style,
        alignment=1,
    )

    return {
        "doc_type": doc_type_style,
        "title": title_style,
        "section": section_heading,
        "topic": topic_title,
        "body": body,
        "body_bold": body_bold,
        "body_dim": body_dim,
        "th": th_style,
        "td": td_style,
        "td_bold": td_bold_style,
        "td_center": td_center,
    }


def _safe_escape(text: Any) -> str:
    if text is None:
        return ""
    s = str(text)
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_meeting_protocol_pdf(meeting_row: dict, lang: str = "ru") -> tuple[bytes, str]:
    """Generate a clean, official A4 protocol document in PDF format."""
    styles = _get_styles()

    title = meeting_row.get("title") or "Совещание"
    clean_title = re.sub(r'[/\\?%*:|"<>]+', "-", title).strip() or f"meeting_{str(meeting_row.get('id', ''))[:8]}"

    raw_protocol = (
        meeting_row.get("protocol_kz") if lang == "kz" else meeting_row.get("protocol_ru")
    ) or "{}"
    try:
        protocol_data = json.loads(raw_protocol) if isinstance(raw_protocol, str) else raw_protocol
    except Exception:
        protocol_data = {}

    meta = protocol_data.get("metadata") or {}

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=40,
        rightMargin=40,
        topMargin=36,
        bottomMargin=46,
    )
    story = []

    # 1. Document Header
    is_kz = lang == "kz"
    header_text = "ХАТТАМА" if is_kz else "ПРОТОКОЛ ЗАСЕДАНИЯ"
    story.append(Paragraph(header_text, styles["doc_type"]))
    story.append(Paragraph(_safe_escape(title), styles["title"]))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#1e3a8a"), spaceAfter=10))

    # 2. Meta Info Card Table
    created_date = (meeting_row.get("created_at") or "")[:10]
    doc_date = meta.get("date") or created_date or "—"
    location = meta.get("location") or "Астана"
    chairperson = meta.get("chairperson") or "—"
    secretary = meta.get("secretary") or "—"

    meta_rows = [
        [
            Paragraph(f"<b>{'Күні / Дата:' if is_kz else 'Дата проведения:'}</b> {doc_date}", styles["body"]),
            Paragraph(f"<b>{'Өткізілген орны:' if is_kz else 'Место проведения:'}</b> {location}", styles["body"]),
        ],
        [
            Paragraph(f"<b>{'Төраға:' if is_kz else 'Председатель:'}</b> {chairperson}", styles["body"]),
            Paragraph(f"<b>{'Хатшы:' if is_kz else 'Секретарь:'}</b> {secretary}", styles["body"]),
        ],
    ]
    meta_table = Table(meta_rows, colWidths=[255, 260])
    meta_table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
            ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ])
    )
    story.append(meta_table)
    story.append(Spacer(1, 10))

    # 3. Participants
    story.append(Paragraph("Қатысқандар / Присутствовали" if is_kz else "Присутствовали", styles["section"]))
    protocol_participants = protocol_data.get("participants")
    if protocol_participants and isinstance(protocol_participants, list):
        participants = protocol_participants
    else:
        try:
            participants = json.loads(meeting_row.get("participants") or "[]")
        except Exception:
            participants = []

    if participants:
        part_bullets = []
        for p in participants:
            if isinstance(p, dict):
                p_name = p.get("name", "Участник")
                p_pos = f" — {p.get('position')}" if p.get("position") else ""
                part_bullets.append(f"• <b>{_safe_escape(p_name)}</b>{_safe_escape(p_pos)}")
            else:
                part_bullets.append(f"• {_safe_escape(p)}")

        # Split participants into two columns for compact, clean look
        mid = (len(part_bullets) + 1) // 2
        col1 = "<br/>".join(part_bullets[:mid])
        col2 = "<br/>".join(part_bullets[mid:]) if mid < len(part_bullets) else ""
        part_table = Table(
            [[Paragraph(col1, styles["body"]), Paragraph(col2, styles["body"])]],
            colWidths=[255, 260],
        )
        part_table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        story.append(part_table)
    else:
        story.append(Paragraph("Согласно списку участников", styles["body"]))
    story.append(Spacer(1, 10))

    # 4. Agenda
    story.append(Paragraph("Күн тәртібі / Повестка дня" if is_kz else "Повестка дня", styles["section"]))
    agenda_text = meeting_row.get("agenda") or meta.get("agenda", "")
    raw_topics = protocol_data.get("agenda_items") or protocol_data.get("topics") or []

    if raw_topics:
        agenda_lines = []
        for idx, t in enumerate(raw_topics, 1):
            t_title = t.get("topic") or t.get("topic_name") or f"Вопрос {idx}"
            agenda_lines.append(f"<b>{idx}.</b> {_safe_escape(t_title)}")
        story.append(Paragraph("<br/>".join(agenda_lines), styles["body"]))
    elif agenda_text:
        story.append(Paragraph(_safe_escape(agenda_text), styles["body"]))
    else:
        story.append(Paragraph("Вопросы рабочего совещания", styles["body"]))
    story.append(Spacer(1, 12))

    # 5. Topics and Decisions
    story.append(Paragraph("Шешімдер мен тапсырмалар / Решения и поручения" if is_kz else "Решения и поручения", styles["section"]))

    if raw_topics:
        for idx, t in enumerate(raw_topics, 1):
            t_title = t.get("topic") or t.get("topic_name") or f"Вопрос {idx}"
            topic_flowables = [
                Paragraph(f"{idx}. {_safe_escape(t_title)}", styles["topic"])
            ]

            speaker = t.get("speaker") or t.get("discussion")
            if speaker:
                topic_flowables.append(
                    Paragraph(f"<b>{'Баяндамашы' if is_kz else 'Докладчик'}:</b> {_safe_escape(speaker)}", styles["body_dim"])
                )
                topic_flowables.append(Spacer(1, 3))

            decisions = t.get("decisions", [])
            if decisions:
                # Decision Table: №, Решение, Ответственный, Срок
                col_widths = [24, 305, 105, 81]  # total = 515 pt
                headers = [
                    Paragraph("№", styles["th"]),
                    Paragraph("Решение / Поручение" if not is_kz else "Шешім / Тапсырма", styles["th"]),
                    Paragraph("Ответственный" if not is_kz else "Жауапты", styles["th"]),
                    Paragraph("Срок" if not is_kz else "Мерзімі", styles["th"]),
                ]
                d_rows = [headers]
                for d_idx, d in enumerate(decisions, 1):
                    if isinstance(d, dict):
                        d_text = d.get("decision") or d.get("text") or ""
                        d_resp = d.get("responsible") or d.get("assignee") or "—"
                        d_dead = d.get("deadline") or "—"
                    else:
                        d_text = str(d)
                        d_resp = "—"
                        d_dead = "—"

                    d_rows.append([
                        Paragraph(f"{idx}.{d_idx}", styles["td_center"]),
                        Paragraph(_safe_escape(d_text), styles["td"]),
                        Paragraph(_safe_escape(d_resp), styles["td"]),
                        Paragraph(_safe_escape(d_dead), styles["td_center"]),
                    ])

                t_table = Table(d_rows, colWidths=col_widths, repeatRows=1)
                t_table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                    ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#94a3b8")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ]))
                topic_flowables.append(t_table)
            else:
                topic_flowables.append(Paragraph("Решения не зафиксированы.", styles["body_dim"]))

            topic_flowables.append(Spacer(1, 10))
            story.append(KeepTogether(topic_flowables))
    else:
        # Fallback to executive summary if no topics
        raw_summary = (
            meeting_row.get("summary_kz") if lang == "kz" else meeting_row.get("summary_ru")
        ) or "{}"
        try:
            sum_data = json.loads(raw_summary) if isinstance(raw_summary, str) else raw_summary
        except Exception:
            sum_data = {}
        if sum_data.get("executive_summary"):
            story.append(Paragraph(_safe_escape(sum_data["executive_summary"]), styles["body"]))
        else:
            story.append(Paragraph("Протокол сформирован по материалам совещания.", styles["body"]))

    story.append(Spacer(1, 16))

    # 6. Signatures Block
    sig_chair = chairperson if chairperson != "—" else "___________________"
    sig_sec = secretary if secretary != "—" else "___________________"
    sig_data = [
        [
            Paragraph(f"<b>{'Төраға' if is_kz else 'Председатель'}:</b>", styles["body_bold"]),
            Paragraph(f"________________ / {_safe_escape(sig_chair)}", styles["body"]),
            Paragraph(f"<b>{'Хатшы' if is_kz else 'Секретарь'}:</b>", styles["body_bold"]),
            Paragraph(f"________________ / {_safe_escape(sig_sec)}", styles["body"]),
        ]
    ]
    sig_table = Table(sig_data, colWidths=[90, 165, 80, 180])
    sig_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(KeepTogether([
        HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#94a3b8"), spaceBefore=10, spaceAfter=10),
        sig_table,
    ]))

    doc.build(story, canvasmaker=NumberedCanvas)
    return buf.getvalue(), title


def build_template_test_pdf(template_name: str, values: dict, slots: list[dict]) -> bytes:
    """Generate a clean PDF report displaying the results of a template test run."""
    styles = _get_styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=40,
        rightMargin=40,
        topMargin=36,
        bottomMargin=46,
    )
    story = []

    story.append(Paragraph("ТЕСТОВЫЙ ПРОТОКОЛ", styles["doc_type"]))
    story.append(Paragraph(f"Шаблон: {_safe_escape(template_name)}", styles["title"]))
    story.append(HRFlowable(width="100%", thickness=1.5, color=colors.HexColor("#1e3a8a"), spaceAfter=12))

    slots_map = {s.get("key"): s for s in slots}

    # Group into scalar fields and repeated tables / outlines
    scalar_items = []
    repeated_items = []

    for key, val in values.items():
        slot_info = slots_map.get(key, {})
        label = slot_info.get("label") or key
        if isinstance(val, list):
            repeated_items.append((label, key, val, slot_info))
        elif isinstance(val, dict):
            repeated_items.append((label, key, [val], slot_info))
        else:
            scalar_items.append((label, key, str(val)))

    if scalar_items:
        story.append(Paragraph("Основные реквизиты документа", styles["section"]))
        rows = [[Paragraph("Поле / Реквизит", styles["th"]), Paragraph("Значение", styles["th"])]]
        for label, key, val_str in scalar_items:
            rows.append([
                Paragraph(f"<b>{_safe_escape(label)}</b><br/><font color='#64748b' size='7.5'>{_safe_escape(key)}</font>", styles["td"]),
                Paragraph(_safe_escape(val_str) or "<font color='#94a3b8'>—</font>", styles["td"]),
            ])
        t_scalar = Table(rows, colWidths=[185, 330])
        t_scalar.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#cbd5e1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(t_scalar)
        story.append(Spacer(1, 12))

    if repeated_items:
        story.append(Paragraph("Динамические разделы и списки", styles["section"]))
        for label, key, items, slot_info in repeated_items:
            story.append(Paragraph(f"• {_safe_escape(label)}", styles["topic"]))
            if not items:
                story.append(Paragraph("Нет записей", styles["body_dim"]))
                story.append(Spacer(1, 6))
                continue

            first = items[0]
            if isinstance(first, dict):
                cols = list(first.keys())
                header_row = [Paragraph(_safe_escape(c), styles["th"]) for c in cols]
                data_rows = [header_row]
                for item in items:
                    data_rows.append([
                        Paragraph(_safe_escape(str(item.get(c, ""))), styles["td"])
                        for c in cols
                    ])
                col_w = 515 / max(1, len(cols))
                t_rep = Table(data_rows, colWidths=[col_w] * len(cols))
                t_rep.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),
                    ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#cbd5e1")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                story.append(t_rep)
            else:
                item_lines = [f"{i}. {_safe_escape(str(item))}" for i, item in enumerate(items, 1)]
                story.append(Paragraph("<br/>".join(item_lines), styles["body"]))

            story.append(Spacer(1, 10))

    doc.build(story, canvasmaker=NumberedCanvas)
    return buf.getvalue()
