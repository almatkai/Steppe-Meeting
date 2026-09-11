"""Create a browser-preview DOCX without changing the stored original template."""

import io
import pathlib
import zipfile

from PIL import Image
from PIL import UnidentifiedImageError

PREVIEW_OPTIMIZE_THRESHOLD_BYTES = 20 * 1024 * 1024
PREVIEW_MAX_IMAGE_EDGE = 2000
PREVIEW_JPEG_QUALITY = 85
_RASTER_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def _optimize_image(content: bytes, extension: str) -> bytes:
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            image.thumbnail((PREVIEW_MAX_IMAGE_EDGE, PREVIEW_MAX_IMAGE_EDGE))
            output = io.BytesIO()
            if extension in {'.jpg', '.jpeg'}:
                if image.mode not in {'RGB', 'L'}:
                    image = image.convert('RGB')
                image.save(
                    output,
                    format='JPEG',
                    quality=PREVIEW_JPEG_QUALITY,
                    optimize=True,
                    progressive=True,
                )
            elif extension == '.png':
                image.save(output, format='PNG', optimize=True)
            else:
                image.save(output, format='WEBP', quality=PREVIEW_JPEG_QUALITY, method=4)
            optimized = output.getvalue()
            return optimized if len(optimized) < len(content) else content
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return content


def optimize_docx_preview(
    docx_bytes: bytes,
    threshold_bytes: int = PREVIEW_OPTIMIZE_THRESHOLD_BYTES,
) -> bytes:
    """Optimize raster images only when a generated preview is unusually large.

    The caller stores this result under ``test.docx``. The original
    ``template.docx`` remains byte-for-byte unchanged and is used for real
    exports, so preview optimization cannot degrade signed documents.
    """
    if len(docx_bytes) <= threshold_bytes:
        return docx_bytes

    source = io.BytesIO(docx_bytes)
    output = io.BytesIO()
    with zipfile.ZipFile(source) as input_archive:
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as output_archive:
            for member in input_archive.infolist():
                content = input_archive.read(member.filename)
                extension = pathlib.PurePosixPath(member.filename).suffix.lower()
                if member.filename.startswith('word/media/') and extension in _RASTER_EXTENSIONS:
                    content = _optimize_image(content, extension)
                output_archive.writestr(member, content)
    optimized_docx = output.getvalue()
    return optimized_docx if len(optimized_docx) < len(docx_bytes) else docx_bytes
