"""
RAG Retriever for Steppe Meeting Desktop.
Two-stage hybrid retrieval with HyDE query expansion, vector search in SQLite,
and citation synthesis.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

from . import embeddings, vector_store

logger = logging.getLogger("steppe.retriever")


def _format_source_label(source_type: str, language: str) -> str:
    labels = {
        "protocol_ru": "Официальный протокол (RU)",
        "protocol_kz": "Ресми хаттама (KZ)",
        "summary_ru": "Краткое резюме (RU)",
        "summary_kz": "Қысқаша мазмұны (KZ)",
        "transcript": "Стенограмма аудио",
    }
    key = f"{source_type}_{language}" if source_type in ("protocol", "summary") else source_type
    return labels.get(key, labels.get(source_type, source_type))


async def retrieve(
    conn,
    query: str,
    top_k: int = 8,
    filter_meeting_id: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Performs semantic retrieval across indexed meeting chunks.
    Returns (chunks, citations).
    """
    if not query or not query.strip():
        return [], []

    # 1. Embed user query and generate HyDE vector in parallel
    embed_task = embeddings.embed_texts([query])
    hyde_task = embeddings.generate_hyde_vector(query)

    query_vectors, hyde_vector = await asyncio.gather(embed_task, hyde_task)
    if not query_vectors:
        return [], []

    query_vec = query_vectors[0]

    # 2. Vector search candidate pools
    pool_k = min(30, top_k * 3)
    results_direct = vector_store.search(
        conn=conn,
        query_vector=query_vec,
        top_k=pool_k,
        filter_meeting_id=filter_meeting_id,
    )

    results_hyde = []
    if hyde_vector is not None:
        results_hyde = vector_store.search(
            conn=conn,
            query_vector=hyde_vector,
            top_k=pool_k,
            filter_meeting_id=filter_meeting_id,
        )

    # 3. Deduplicate and merge candidates by (meeting_id, source_type, chunk_index)
    seen = set()
    merged_candidates: List[Dict[str, Any]] = []

    for r in results_direct:
        key = (r["meeting_id"], r["source_type"], r["chunk_index"])
        if key not in seen:
            seen.add(key)
            # direct query score weight 1.0
            r["combined_score"] = r["score"]
            merged_candidates.append(r)

    for r in results_hyde:
        key = (r["meeting_id"], r["source_type"], r["chunk_index"])
        if key not in seen:
            seen.add(key)
            # hyde score weight 0.85
            r["combined_score"] = r["score"] * 0.85
            merged_candidates.append(r)
        else:
            # Boost candidate found in both
            for c in merged_candidates:
                if (c["meeting_id"], c["source_type"], c["chunk_index"]) == key:
                    c["combined_score"] = max(c["combined_score"], r["score"] * 1.1)

    # 4. Sort and take top_k
    merged_candidates.sort(key=lambda x: x["combined_score"], reverse=True)
    top_chunks = merged_candidates[:top_k]

    # 5. Build clean citations for UI
    citations: List[Dict[str, Any]] = []
    for c in top_chunks:
        # Create a clean snippet (up to 200 chars)
        raw_text = c["text"].strip().replace("\n", " ")
        snippet = raw_text[:220] + "..." if len(raw_text) > 220 else raw_text

        citations.append({
            "meeting_id": c["meeting_id"],
            "meeting_title": c["meeting_title"],
            "source_type": c["source_type"],
            "source_label": _format_source_label(c["source_type"], c.get("language", "ru")),
            "language": c.get("language", "ru"),
            "chunk_index": c["chunk_index"],
            "snippet": snippet,
            "score": round(float(c.get("combined_score", c.get("score", 0.0))), 3),
            "timestamp_start": c.get("timestamp_start"),
            "timestamp_end": c.get("timestamp_end"),
        })

    return top_chunks, citations


def build_rag_prompt(
    history: List[Dict[str, str]],
    chunks: List[Dict[str, Any]],
    user_message: str,
) -> str:
    """
    Constructs the prompt for the local LLM incorporating retrieved meeting chunks.
    """
    context_blocks = []
    for i, c in enumerate(chunks, 1):
        source_label = _format_source_label(c["source_type"], c.get("language", "ru"))
        title = c["meeting_title"]
        context_blocks.append(
            f"[Документ {i}] Совещание: «{title}» | Источник: {source_label}\n{c['text']}"
        )

    context_str = "\n\n".join(context_blocks) if context_blocks else "Релевантных материалов совещаний в базе не найдено."

    prompt = f"""Ты — интеллектуальный ассистент по совещаниям Steppe Meeting.
Твоя задача — точно, структурированно и вежливо отвечать на вопросы пользователя, опираясь на предоставленный контекст протоколов, резюме и стенограмм совещаний.

ИНСТРУКЦИИ:
1. Отвечай на том языке, на котором задан вопрос (русский или казахский).
2. Обязательно указывай, из какого именно совещания взята информация (например: "Согласно совещанию «...»...").
3. Если в контексте есть конкретные поручения, ответственные лица или сроки — перечисли их чётким списком.
4. Если в контексте нет ответа на вопрос, честно напиши, что в материалах сохранённых совещаний данной информации не найдено, но не придумывай факты.
5. Оформляй ответ красиво в Markdown (используй заголовки, списки, выделения).

МАТЕРИАЛЫ ИЗ БАЗЫ ЗНАНИЙ СОВЕЩАНИЙ:
{context_str}

ИСТОРИЯ ДИАЛОГА:
"""
    for msg in history[-6:]:
        role = "Пользователь" if msg.get("role") == "user" else "Ассистент"
        content = msg.get("content", "").strip()
        prompt += f"{role}: {content}\n"

    prompt += f"\nПользователь: {user_message.strip()}\nАссистент: "
    return prompt
