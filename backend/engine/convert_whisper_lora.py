"""Merge the published Kazakh/Russian Whisper LoRA and export a portable INT8 model.

Run in a separate process: conversion uses substantial RAM, which must be released
before normal transcription. Only inference artifacts are downloaded, not optimizer
checkpoints. Source weights live in a temporary directory and are removed afterward.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path


def convert(model_id: str, output: Path):
    from ctranslate2.converters import TransformersConverter
    from huggingface_hub import snapshot_download
    from peft import PeftModel
    from transformers import WhisperTokenizerFast

    from stt_catalog import get_model_info

    info = get_model_info(model_id)
    with tempfile.TemporaryDirectory(prefix="whisper-source-", dir=output.parent) as temporary:
        root = Path(temporary)
        print("Скачивание базовых весов Whisper (~3.2 ГБ) и LoRA...", flush=True)
        base = snapshot_download(
            info["base_repo_id"], revision=info["base_revision"], local_dir=root / "base",
            allow_patterns=["*.json", "model.safetensors", "merges.txt", "vocab.json"],
        )
        adapter = snapshot_download(
            info["repo_id"], revision=info["revision"], local_dir=root / "adapter",
            allow_patterns=["adapter_config.json", "adapter_model.safetensors"],
        )

        class MergedWhisperConverter(TransformersConverter):
            def load_model(self, model_class, model_name_or_path, **kwargs):
                base_model = model_class.from_pretrained(model_name_or_path, local_files_only=True, **kwargs)
                return PeftModel.from_pretrained(base_model, adapter, local_files_only=True).merge_and_unload()

        print("Объединение LoRA и конвертация в CTranslate2 INT8...", flush=True)
        # Base repository has a slow tokenizer; create tokenizer.json for offline
        # faster-whisper so inference never downloads an OpenAI tokenizer.
        WhisperTokenizerFast.from_pretrained(base, local_files_only=True).save_pretrained(base)
        converter = MergedWhisperConverter(
            base, load_as_float16=True, low_cpu_mem_usage=True,
            copy_files=["tokenizer.json", "preprocessor_config.json"],
        )
        converter.convert(str(output), quantization="int8", force=True)
        print("Конвертация Whisper завершена", flush=True)


if __name__ == "__main__":
    convert(sys.argv[1], Path(sys.argv[2]))
