"""Media board and media-board unpacker for ComfyUI.

The package intentionally stores uploaded media inside ComfyUI/input/h3_media_board.
That keeps workflow JSON portable: the saved manifest holds paths relative to input.
"""

from __future__ import annotations

import json
import math
import re
import secrets
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer


MAX_COUNTS = {"image": 9, "audio": 3, "video": 3}
DYNAMIC_MEDIA_LIMIT = 64
SAFE_KIND = set(MAX_COUNTS)
UPLOAD_DIRNAME = "h3_media_board"
ASPECT_RATIOS = {
    "1:1": (1, 1), "2:3": (2, 3), "3:2": (3, 2), "3:4": (3, 4),
    "4:3": (4, 3), "9:16": (9, 16), "16:9": (16, 9), "21:9": (21, 9),
}
MAX_SEED = 0x1FFFFFFFFFFFFF  # Exact integer range supported by browser number inputs.
_LAST_QUEUED_SEEDS: dict[str, int] = {}


def _prompt_h3_overrides(prompt: str | None) -> dict[str, float | str]:
    """Extract an H3 duration and aspect ratio explicitly stated in a prompt.

    This runs at execution time as well as in the browser UI, so a prompt
    supplied through the forced ``external_prompt`` input cannot leave the
    board's runtime settings out of sync with the written prompt.
    """
    text = str(prompt or "").replace("：", ":")
    result: dict[str, float | str] = {}

    # Check explicit numeric ratios before descriptive words. Boundaries avoid
    # mistaking timestamps such as 00:03 for a requested output ratio.
    for ratio in sorted(ASPECT_RATIOS, key=len, reverse=True):
        pattern = ratio.replace(":", r"\s*:\s*")
        if re.search(rf"(?<!\d){pattern}(?!\d)", text):
            result["aspect_ratio"] = ratio
            break
    else:
        lowered = text.lower()
        if re.search(r"(?:\bportrait\b|\bvertical\b|竖屏|竖版)", lowered):
            result["aspect_ratio"] = "9:16"
        elif re.search(r"(?:\bultra[ -]?wide\b|\bwidescreen\b|超宽屏)", lowered):
            result["aspect_ratio"] = "21:9"
        elif re.search(r"(?:\blandscape\b|\bhorizontal\b|横屏|横版)", lowered):
            result["aspect_ratio"] = "16:9"
        elif re.search(r"(?:\bsquare\b|方形|正方形)", lowered):
            result["aspect_ratio"] = "1:1"

    duration_patterns = (
        r"(?:\bduration\b|\b(?:target\s+)?video(?:\s+(?:duration|length))?\b|\blength\b|时长|视频长度)\s*(?:is|为|:)?\s*(\d+(?:\.\d+)?)",
        r"(?:^|[^\d:])(\d+(?:\.\d+)?)\s*(?:-|–|—)?\s*(?:seconds?|secs?|秒)\b",
    )
    for pattern in duration_patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        seconds = float(match.group(1))
        # Reference prompts often contain alignment timestamps such as
        # "0.00 seconds". They are not a requested video duration.
        if seconds < 4.0:
            continue
        # H3 accepts 4–15 seconds in 0.5-second increments.
        result["duration"] = min(15.0, max(4.0, round(seconds * 2) / 2))
        break
    return result


def _input_root() -> Path:
    root = Path(folder_paths.get_input_directory()) / UPLOAD_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_relative_path(value: str) -> Path:
    """Resolve a manifest entry, rejecting paths outside the upload directory."""
    root = _input_root().resolve()
    candidate = (Path(folder_paths.get_input_directory()) / value).resolve()
    if root not in candidate.parents and candidate != root:
        raise ValueError("Media path is outside input/h3_media_board")
    return candidate


def _clean_manifest(raw: str | dict[str, Any] | list[dict[str, Any]] | None) -> dict[str, list[dict[str, str] | None]]:
    result: dict[str, list[dict[str, str] | None]] = {kind: [] for kind in MAX_COUNTS}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        return result
    if not isinstance(parsed, dict):
        return result

    for kind, limit in MAX_COUNTS.items():
        items = parsed.get(kind, [])
        if not isinstance(items, list):
            continue
        for item in items[:limit]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                if kind == "image":
                    result[kind].append(None)
                continue
            try:
                path = _safe_relative_path(item["path"])
            except ValueError:
                if kind == "image":
                    result[kind].append(None)
                continue
            if not path.is_file():
                if kind == "image":
                    result[kind].append(None)
                continue
            result[kind].append(
                {
                    "path": item["path"].replace("\\", "/"),
                    "name": str(item.get("name") or path.name),
                }
            )
    return result


def _clean_dynamic_media_manifest(raw: str | dict[str, Any] | None) -> dict[str, list[dict[str, str]]]:
    """Validate the dynamic board manifest without H3 first/last-frame gaps."""
    result: dict[str, list[dict[str, str]]] = {"image": [], "audio": []}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        return result
    if not isinstance(parsed, dict):
        return result
    for kind in result:
        items = parsed.get(kind, [])
        if not isinstance(items, list):
            continue
        for item in items[:DYNAMIC_MEDIA_LIMIT]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                continue
            try:
                path = _safe_relative_path(item["path"])
            except ValueError:
                continue
            if path.is_file():
                result[kind].append({
                    "path": item["path"].replace("\\", "/"),
                    "name": str(item.get("name") or path.name),
                })
    return result


def _resize_dynamic_image(
    image: torch.Tensor,
    mode: str,
    target_width: int,
    target_height: int,
    method: str,
) -> torch.Tensor:
    """Resize a Comfy IMAGE batch for DynamicMediaBoard outputs.

    The board owns the final pixels passed downstream, so every dynamic image
    output shares one predictable geometry before it reaches an H3 guide.
    """
    if mode == "不缩放" or image.ndim != 4:
        return image
    target_width = max(16, min(16384, int(target_width)))
    target_height = max(16, min(16384, int(target_height)))
    source_height, source_width = int(image.shape[1]), int(image.shape[2])
    if source_width < 1 or source_height < 1:
        return image
    interpolation = {
        "最近邻": "nearest-exact",
        "双线性": "bilinear",
        "双三次": "bicubic",
        "区域": "area",
    }.get(method, "bicubic")
    pixels = image.movedim(-1, 1)

    def scale(height: int, width: int) -> torch.Tensor:
        kwargs: dict[str, Any] = {"size": (max(1, height), max(1, width)), "mode": interpolation}
        if interpolation in {"bilinear", "bicubic"}:
            kwargs["align_corners"] = False
        return torch.nn.functional.interpolate(pixels, **kwargs)

    if mode == "按宽度等比":
        result = scale(round(source_height * target_width / source_width), target_width)
    elif mode == "按高度等比":
        result = scale(target_height, round(source_width * target_height / source_height))
    elif mode == "指定尺寸（居中裁切）":
        factor = max(target_width / source_width, target_height / source_height)
        result = scale(round(source_height * factor), round(source_width * factor))
        top = max(0, (result.shape[2] - target_height) // 2)
        left = max(0, (result.shape[3] - target_width) // 2)
        result = result[:, :, top:top + target_height, left:left + target_width]
    elif mode == "指定尺寸（留边）":
        factor = min(target_width / source_width, target_height / source_height)
        result = scale(round(source_height * factor), round(source_width * factor))
        pad_width = target_width - result.shape[3]
        pad_height = target_height - result.shape[2]
        result = torch.nn.functional.pad(
            result,
            (max(0, pad_width // 2), max(0, pad_width - pad_width // 2), max(0, pad_height // 2), max(0, pad_height - pad_height // 2)),
            value=0.0,
        )
    else:  # 指定尺寸（拉伸）
        result = scale(target_height, target_width)
    return result.movedim(1, -1).contiguous()


PANORAMA_ASPECT_RATIOS = {
    "1:1": (1, 1), "2:3": (2, 3), "3:2": (3, 2), "3:4": (3, 4),
    "4:3": (4, 3), "9:16": (9, 16), "16:9": (16, 9), "21:9": (21, 9),
}


def _equirectangular_to_perspective(
    image: torch.Tensor,
    yaw: float,
    pitch: float,
    horizontal_fov: float,
    width: int,
    height: int,
) -> torch.Tensor:
    """Render a rectilinear camera view from an equirectangular IMAGE batch."""
    if image.ndim != 4 or image.shape[-1] not in {1, 3, 4}:
        raise ValueError("全景图必须是 ComfyUI IMAGE 格式 [批次, 高, 宽, 通道]。")
    source_height, source_width = int(image.shape[1]), int(image.shape[2])
    if source_width < 2 or source_height < 2:
        raise ValueError("全景图尺寸无效。")

    width = max(16, min(8192, int(width)))
    height = max(16, min(8192, int(height)))
    yaw = math.radians((float(yaw) + 180.0) % 360.0 - 180.0)
    pitch = math.radians(max(-89.0, min(89.0, float(pitch))))
    horizontal_fov = math.radians(max(30.0, min(120.0, float(horizontal_fov))))
    dtype, device = image.dtype, image.device
    horizontal_scale = math.tan(horizontal_fov * 0.5)
    vertical_scale = horizontal_scale / (width / height)

    output_x = (torch.arange(width, device=device, dtype=dtype) + 0.5) / width * 2.0 - 1.0
    output_y = 1.0 - (torch.arange(height, device=device, dtype=dtype) + 0.5) / height * 2.0
    plane_y, plane_x = torch.meshgrid(output_y * vertical_scale, output_x * horizontal_scale, indexing="ij")
    sin_yaw, cos_yaw = math.sin(yaw), math.cos(yaw)
    sin_pitch, cos_pitch = math.sin(pitch), math.cos(pitch)
    forward = torch.tensor([cos_pitch * cos_yaw, sin_pitch, cos_pitch * sin_yaw], device=device, dtype=dtype)
    right = torch.tensor([-sin_yaw, 0.0, cos_yaw], device=device, dtype=dtype)
    up = torch.tensor([-sin_pitch * cos_yaw, cos_pitch, -sin_pitch * sin_yaw], device=device, dtype=dtype)
    rays = torch.nn.functional.normalize(
        forward.view(1, 1, 3) + plane_x.unsqueeze(-1) * right.view(1, 1, 3) + plane_y.unsqueeze(-1) * up.view(1, 1, 3),
        dim=-1,
    )
    longitude = torch.atan2(rays[..., 2], rays[..., 0])
    latitude = torch.asin(rays[..., 1].clamp(-1.0, 1.0))
    source_u = torch.remainder(longitude / (2.0 * math.pi) + 0.5, 1.0)
    source_v = (0.5 - latitude / math.pi).clamp(0.5 / source_height, 1.0 - 0.5 / source_height)
    source = torch.cat((image.movedim(-1, 1), image.movedim(-1, 1)[..., :1]), dim=-1)
    grid_x = source_u * (2.0 * source_width / (source_width + 1.0)) - 1.0
    grid_y = source_v * 2.0 - 1.0
    grid = torch.stack((grid_x, grid_y), dim=-1).unsqueeze(0).expand(image.shape[0], -1, -1, -1)
    return torch.nn.functional.grid_sample(
        source, grid, mode="bilinear", padding_mode="border", align_corners=False,
    ).movedim(1, -1).contiguous()


def _paint_panorama_rectangles(image: torch.Tensor, raw_annotations: str) -> torch.Tensor:
    """Apply browser-drawn, normalized filled rectangles to the snapshot output."""
    try:
        annotations = json.loads(raw_annotations or "[]")
    except json.JSONDecodeError:
        return image
    if not isinstance(annotations, list):
        return image
    result = image.clone()
    height, width, channels = int(result.shape[1]), int(result.shape[2]), int(result.shape[3])
    for annotation in annotations[:100]:
        if not isinstance(annotation, dict):
            continue
        try:
            x = float(annotation.get("x", 0.0)); y = float(annotation.get("y", 0.0))
            end_x = x + float(annotation.get("w", 0.0)); end_y = y + float(annotation.get("h", 0.0))
        except (TypeError, ValueError):
            continue
        color = str(annotation.get("color", "#ff3b30"))
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            continue
        left = max(0, min(width, round(min(x, end_x) * width)))
        right = max(0, min(width, round(max(x, end_x) * width)))
        top = max(0, min(height, round(min(y, end_y) * height)))
        bottom = max(0, min(height, round(max(y, end_y) * height)))
        if left >= right or top >= bottom:
            continue
        rgb = [int(color[index:index + 2], 16) / 255.0 for index in (1, 3, 5)]
        fill = torch.tensor(rgb[:min(3, channels)], device=result.device, dtype=result.dtype)
        result[:, top:bottom, left:right, :fill.numel()] = fill
    return result


async def _upload_media(request: web.Request) -> web.Response:
    """Small, node-scoped uploader used by the browser-side media cards."""
    body = await request.post()
    kind = str(body.get("kind", ""))
    upload = body.get("file")
    if kind not in SAFE_KIND or upload is None or not getattr(upload, "filename", None):
        return web.json_response({"error": "A media kind and file are required."}, status=400)

    original_name = Path(upload.filename).name
    stem = re.sub(r"[^\w.-]+", "_", Path(original_name).stem, flags=re.UNICODE).strip("._") or kind
    suffix = re.sub(r"[^A-Za-z0-9.]", "", Path(original_name).suffix.lower())[:12]
    # A unique prefix avoids overwriting an earlier workflow asset with the same name.
    import uuid

    filename = f"{uuid.uuid4().hex[:10]}_{stem}{suffix}"
    destination = _input_root() / filename
    with destination.open("wb") as target:
        shutil.copyfileobj(upload.file, target)

    return web.json_response(
        {
            "path": f"{UPLOAD_DIRNAME}/{filename}",
            "name": original_name,
        }
    )


# This is intentionally a dedicated endpoint rather than ComfyUI's image-only uploader:
# audio and video need the exact same upload flow as images.
PromptServer.instance.routes.post("/h3_media_board/upload")(_upload_media)


def _load_image(item: dict[str, str]) -> torch.Tensor:
    path = _safe_relative_path(item["path"])
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        pixels = np.asarray(image).astype(np.float32) / 255.0
    return torch.from_numpy(pixels)[None,]


def _media_descriptor(item: dict[str, str] | None) -> dict[str, str] | None:
    if item is None:
        return None
    # This descriptor is deliberately simple and can be consumed by media loader nodes.
    # It follows ComfyUI's conventional input-file shape.
    return {"filename": item["path"], "subfolder": "", "type": "input", "name": item["name"]}


def _load_audio(item: dict[str, str] | None) -> dict[str, Any] | None:
    """Decode an audio file or a video's embedded audio into ComfyUI AUDIO."""
    if item is None:
        return None
    try:
        # ComfyUI's own decoder handles MP3/AAC/WAV as well as audio streams
        # inside MP4/MOV/WebM. It returns [channels, samples].
        from comfy_extras.nodes_audio import load as decode_audio

        waveform, sample_rate = decode_audio(str(_safe_relative_path(item["path"])))
        return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
    except Exception as error:  # No stream is a valid state for a silent video.
        print(f"[H3 Media Board] Unable to decode audio from {item['name']}: {error}")
        return None


def _load_video_frames(item: dict[str, str] | None) -> torch.Tensor | None:
    """Decode a video to ComfyUI's IMAGE frame-batch format [F,H,W,C]."""
    if item is None:
        return None
    try:
        import av

        frames: list[np.ndarray] = []
        with av.open(str(_safe_relative_path(item["path"]))) as container:
            if not container.streams.video:
                return None
            stream = container.streams.video[0]
            for frame in container.decode(stream):
                frames.append(frame.to_ndarray(format="rgb24"))
        if not frames:
            return None
        return torch.from_numpy(np.stack(frames)).float().div_(255.0)
    except Exception as error:
        print(f"[H3 Media Board] Unable to decode video from {item['name']}: {error}")
        return None


def _h3_settings(duration: float, aspect_ratio: str, megapixels: float, multiple: int,
                 second_pass_scale: float = 1.0, auto_calculate: bool = True,
                 manual_frames: int = 362) -> dict[str, int | float | str | bool]:
    """Match H3 Resolution Selector: MP × 1024² → ratio → nearest multiple."""
    duration = min(15.0, max(4.0, float(duration)))
    megapixels = round(min(16.0, max(0.1, float(megapixels))), 1)
    multiple = min(128, max(8, int(multiple)))
    second_pass_scale = round(min(4.0, max(1.0, float(second_pass_scale))), 1)
    width_ratio, height_ratio = ASPECT_RATIOS.get(aspect_ratio, ASPECT_RATIOS["9:16"])
    scale = math.sqrt(megapixels * 1024 * 1024 / (width_ratio * height_ratio))
    width = round(width_ratio * scale / multiple) * multiple
    height = round(height_ratio * scale / multiple) * multiple
    base_frames = max(5, round(duration * 24))
    calculated_frames = base_frames + (5 - base_frames % 17) % 17
    frames = calculated_frames if auto_calculate else max(1, int(manual_frames))
    return {
        "duration": duration, "aspect_ratio": aspect_ratio, "megapixels": megapixels,
        "multiple": multiple, "auto_calculate": bool(auto_calculate), "manual_frames": max(1, int(manual_frames)),
        "second_pass_scale": second_pass_scale,
        "width": width, "height": height, "frames": frames,
    }


class _H3SeedNoise:
    """ComfyUI-compatible NOISE provider for SamplerCustomAdvanced."""

    def __init__(self, seed: int):
        self.seed = int(seed)

    def generate_noise(self, input_latent: dict[str, Any]):
        import comfy.sample

        return comfy.sample.prepare_noise(input_latent["samples"], self.seed, input_latent.get("batch_index"))


def _effective_noise_seed(seed: int, mode: str, unique_id: str | None) -> int:
    key = str(unique_id or "default")
    seed = max(0, min(MAX_SEED, int(seed)))
    if mode == "random_each_queue":
        effective = secrets.randbelow(MAX_SEED + 1)
    elif mode == "reuse_last_queue":
        effective = _LAST_QUEUED_SEEDS.get(key, seed)
    else:
        effective = seed
    _LAST_QUEUED_SEEDS[key] = effective
    return effective


class H3MediaBoard:
    """One-output visual media collector.

    The browser extension owns the card UI and persists it into ``media_manifest``.
    ``prompt`` remains a normal Comfy STRING input, so an upstream text node can be
    connected without sacrificing the editable textarea in this node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "media_manifest": ("STRING", {"default": "{}", "multiline": False}),
                "duration": ("FLOAT", {"default": 15.0, "min": 4.0, "max": 15.0, "step": 0.5}),
                "aspect_ratio": (list(ASPECT_RATIOS.keys()), {"default": "9:16"}),
                "megapixels": ("FLOAT", {"default": 0.4, "min": 0.1, "max": 16.0, "step": 0.1}),
                "multiple": ("INT", {"default": 32, "min": 8, "max": 128, "step": 4}),
                "auto_calculate": ("BOOLEAN", {"default": True, "label_on": "自动计算帧数", "label_off": "手动帧数"}),
                "manual_frames": ("INT", {"default": 362, "min": 1, "max": 10000, "step": 1}),
                "noise_seed": ("INT", {"default": 0, "min": 0, "max": MAX_SEED}),
                "noise_mode": (["fixed", "random_each_queue", "reuse_last_queue"], {"default": "fixed"}),
                "noise_after_generate": (["fixed", "randomize", "increment", "decrement"], {"default": "randomize"}),
                # Keep additions at the end: ComfyUI serializes existing
                # workflow widget values by position, so inserting here would
                # shift old seed and mode values into incompatible inputs.
                "second_pass_scale": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 4.0, "step": 0.1}),
            },
            # A separate forced input guarantees a visible socket in both the
            # legacy canvas and Nodes 2.0.  The local textarea remains usable
            # whenever this optional input is not connected.
            "optional": {"external_prompt": ("STRING", {"forceInput": True})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("H3_MEDIA_BOARD", "NOISE", "FLOAT")
    RETURN_NAMES = ("media_board", "noise", "2采放大倍数")
    FUNCTION = "collect"
    CATEGORY = "H3 / Media"

    @classmethod
    def IS_CHANGED(cls, noise_mode: str = "fixed", **_kwargs):
        # A random-each-queue noise source must not be served from execution cache.
        return float("nan") if noise_mode == "random_each_queue" else noise_mode

    def collect(self, prompt: str, media_manifest: str, duration: float, aspect_ratio: str,
                megapixels: float, multiple: int, auto_calculate: bool, manual_frames: int,
                noise_seed: int, noise_mode: str, external_prompt: str | None = None,
                unique_id: str | None = None, noise_after_generate: str = "randomize",
                second_pass_scale: float = 1.0):
        manifest = _clean_manifest(media_manifest)
        effective_prompt = external_prompt if external_prompt is not None else prompt
        manifest["prompt"] = effective_prompt
        overrides = _prompt_h3_overrides(effective_prompt)
        effective_duration = float(overrides.get("duration", duration))
        effective_aspect_ratio = str(overrides.get("aspect_ratio", aspect_ratio))
        settings = _h3_settings(
            effective_duration, effective_aspect_ratio, megapixels, multiple,
            second_pass_scale, auto_calculate, manual_frames,
        )
        effective_seed = _effective_noise_seed(noise_seed, noise_mode, unique_id)
        settings["noise"] = {
            "seed": int(noise_seed), "mode": noise_mode, "after_generate": noise_after_generate,
            "effective_seed": effective_seed,
        }
        manifest["settings"] = settings
        # UI payload must remain JSON serializable; the executable noise object
        # travels only through the in-memory board output to the unpack node.
        runtime_manifest = dict(manifest)
        noise = _H3SeedNoise(effective_seed)
        runtime_manifest["_noise_object"] = noise
        # Keep the existing outputs at indexes 0 and 1 so saved workflows stay
        # connected; append the second-pass scale as a direct FLOAT output.
        return {
            "ui": {"h3_media_board": [manifest]},
            "result": (runtime_manifest, noise, float(settings["second_pass_scale"])),
        }


class H3MediaBoardUnpack:
    """Expose media plus H3 duration, resolution and aligned-frame parameters.

    Empty positions return None.  The frontend marks these outputs inactive according
    to the linked board manifest, while output indexes stay stable for saved graphs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media_board": ("H3_MEDIA_BOARD",)}}

    # Order mirrors H3's reference inputs: images → videos → video audio → audio.
    # H3's ref_videos ports take IMAGE frame batches, not ComfyUI VIDEO objects.
    RETURN_TYPES = tuple(
        ["IMAGE"] * 9 + ["IMAGE"] * 3 + ["AUDIO"] * 3 + ["AUDIO"] * 3
        + ["STRING", "FLOAT", "INT", "INT", "INT", "NOISE", "FLOAT"]
    )
    RETURN_NAMES = tuple(
        [f"image_{index}" for index in range(1, 10)]
        + [f"video_{index}" for index in range(1, 4)]
        + [f"video_audio_{index}" for index in range(1, 4)]
        + [f"audio_{index}" for index in range(1, 4)]
        + ["prompt", "duration", "width", "height", "frames", "noise", "2采放大倍数"]
    )
    FUNCTION = "unpack"
    CATEGORY = "H3 / Media"

    def unpack(self, media_board: dict[str, Any]):
        manifest = _clean_manifest(media_board)
        # image[0] and image[1] are H3's first/last frame positions.  A None
        # at image[0] must remain a real empty first-frame socket instead of
        # shifting the tail frame into it.
        images = [_load_image(item) if item is not None else None for item in manifest["image"]]
        images += [None] * (MAX_COUNTS["image"] - len(images))
        audios = [_load_audio(item) for item in manifest["audio"]]
        audios += [None] * (MAX_COUNTS["audio"] - len(audios))
        videos = [_load_video_frames(item) for item in manifest["video"]]
        videos += [None] * (MAX_COUNTS["video"] - len(videos))
        video_audios = [_load_audio(item) for item in manifest["video"]]
        video_audios += [None] * (MAX_COUNTS["video"] - len(video_audios))
        settings = media_board.get("settings", {}) if isinstance(media_board, dict) else {}
        params = _h3_settings(
            settings.get("duration", 15.0), settings.get("aspect_ratio", "9:16"),
            settings.get("megapixels", 0.4), settings.get("multiple", 32),
            settings.get("second_pass_scale", 1.0), settings.get("auto_calculate", True),
            settings.get("manual_frames", 362),
        )
        noise_settings = settings.get("noise", {}) if isinstance(settings, dict) else {}
        noise = media_board.get("_noise_object") if isinstance(media_board, dict) else None
        if noise is None:
            noise = _H3SeedNoise(int(noise_settings.get("effective_seed", noise_settings.get("seed", 0))))
        return tuple(images + videos + video_audios + audios + [
            str(media_board.get("prompt", "")), params["duration"], params["width"], params["height"], params["frames"], noise,
            float(params["second_pass_scale"]),
        ])


class H3ConditionLatentSwitch:
    """Route either H3 image/text or multi-reference condition and latent together.

    Both values are selected as one pair, preventing the common mistake of
    pairing the conditioning from one H3 preparation node with the latent from
    the other.  ``external_switch`` overrides the local toggle when connected.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "use_image_text": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "图文输入（开）",
                        "label_off": "多参输入（关）",
                        "tooltip": "开：输出图文/图生分支；关：输出多参参考分支。",
                    },
                ),
            },
            "optional": {
                # Lazy ports mean ComfyUI asks only the selected H3 branch for
                # its values.  The other H3 condition/latent preparation node
                # and its upstream media unpacker are skipped completely.
                "image_text_conditioning": ("CONDITIONING", {"lazy": True, "tooltip": "接 H3 图文/图生节点的正向条件。"}),
                "image_text_latent": ("LATENT", {"lazy": True, "tooltip": "接 H3 图文/图生节点的 Latent。"}),
                "multi_reference_conditioning": ("CONDITIONING", {"lazy": True, "tooltip": "接 H3 多参参考节点的正向条件。"}),
                "multi_reference_latent": ("LATENT", {"lazy": True, "tooltip": "接 H3 多参参考节点的 Latent。"}),
                # A separate socket keeps the local toggle available while
                # permitting workflow logic (Boolean/Compare nodes) to drive it.
                "external_switch": ("BOOLEAN", {"forceInput": True, "tooltip": "外部开关；接入后优先于本节点开关。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("正向条件", "latent")
    FUNCTION = "route"
    CATEGORY = "H3 / Media"

    def check_lazy_status(
        self,
        use_image_text: bool,
        external_switch: bool | None = None,
        **_kwargs,
    ) -> list[str]:
        """Request only one complete condition/latent pair from upstream."""
        use_image_text = bool(external_switch) if external_switch is not None else bool(use_image_text)
        if use_image_text:
            return ["image_text_conditioning", "image_text_latent"]
        return ["multi_reference_conditioning", "multi_reference_latent"]

    def route(
        self,
        use_image_text: bool,
        image_text_conditioning: Any = None,
        image_text_latent: Any = None,
        multi_reference_conditioning: Any = None,
        multi_reference_latent: Any = None,
        external_switch: bool | None = None,
    ):
        use_image_text = bool(external_switch) if external_switch is not None else bool(use_image_text)
        if use_image_text:
            if image_text_conditioning is None or image_text_latent is None:
                raise ValueError("请连接图文/图生分支的正向条件和 Latent。")
            return (image_text_conditioning, image_text_latent)
        if multi_reference_conditioning is None or multi_reference_latent is None:
            raise ValueError("请连接多参参考分支的正向条件和 Latent。")
        return (multi_reference_conditioning, multi_reference_latent)


class H3VideoModeControl:
    """A small, explicit control node for :class:`H3ConditionLatentSwitch`."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media_board": ("H3_MEDIA_BOARD", {"tooltip": "接 H3 Media Board 的 media_board 输出，并原样转发。"}),
                "use_image_text": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "图文 / 图生",
                        "label_off": "多参参考",
                        "tooltip": "开：图文/图生模式；关：多参参考生视频模式。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("BOOLEAN", "H3_MEDIA_BOARD")
    RETURN_NAMES = ("模式开关", "media_board")
    FUNCTION = "control"
    CATEGORY = "H3 / Media"

    def control(self, media_board: dict[str, Any], use_image_text: bool):
        # Passing the board through keeps one clean wire path: Media Board →
        # Mode Control → Media Board Outputs, alongside the Boolean control.
        # The frontend supplies a media-based recommendation by default, but
        # users can always override it with either visible mode button.
        return (bool(use_image_text), media_board)


class H3SecondPassPreparation:
    """Rebuild H3 conditioning at the final latent size and optionally inject a guide.

    The first sampler works at the Media Board's base resolution.  After the
    video latent is upscaled, its old conditioning cannot safely be reused:
    image keyframes embedded in it still have the base resolution.  This node
    receives the *already upscaled and re-combined* AV latent, rebuilds the
    selected H3 conditioning at exactly that size, and can add up to twelve
    independent image/audio guide groups in one compact step for the second
    sampler.
    """

    # The canvas reveals groups only as they are used, while this fixed backend
    # schema keeps saved workflows and ComfyUI validation reliable.
    MAX_GUIDE_GROUPS = 12

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "media_board": ("H3_MEDIA_BOARD", {"tooltip": "接 H3 Media Board 或模式控制节点的 media_board 输出。"}),
            "clip": ("CLIP",),
            "upscaled_latent": ("LATENT", {"tooltip": "接 LTXVConcatAVLatent 的 latent 输出。"}),
            "use_image_text": (
                "BOOLEAN",
                {"default": True, "label_on": "图文 / 图生", "label_off": "多参参考"},
            ),
            "frame_idx": (
                "INT",
                {"default": 168, "min": -9999, "max": 9999, "step": 1, "label": "第 1 组注入起始帧"},
            ),
        }
        optional = {
            # Keep the original local ports for existing workflows.  When the
            # guide sync wire is connected below, its VAE pair takes priority.
            "vae": ("VAE", {"tooltip": "H3 视频 VAE；接入一采引导同步后由同步线自动提供。"}),
            "audio_vae": ("VAE", {"tooltip": "H3 音频 VAE；接入一采引导同步后由同步线自动提供。"}),
            "guide_sync": ("H3_GUIDE_SYNC", {"label": "一采引导同步", "tooltip": "接 H3 多时间点引导帧的二采同步输出；同步 VAE、音频 VAE、全部引导图片/音频和时间点。"}),
            "external_switch": ("BOOLEAN", {"forceInput": True, "label": "自动模式开关", "tooltip": "接 H3 生视频模式控制的模式开关；接入后自动跟随素材类型。"}),
            "injection_image": ("IMAGE", {"label": "第 1 组图片 / 帧串", "tooltip": "第 1 组：可接单张图片、视频帧批次或多帧图片序列。"}),
            "injection_audio": ("AUDIO", {"label": "第 1 组音频", "tooltip": "第 1 组：可选，从该组起始帧开始注入音频。"}),
        }
        for group_index in range(2, cls.MAX_GUIDE_GROUPS + 1):
            required[f"frame_idx_{group_index}"] = (
                "INT",
                {
                    "default": 0, "min": -9999, "max": 9999, "step": 1,
                    "label": f"第 {group_index} 组注入起始帧",
                },
            )
            optional[f"injection_image_{group_index}"] = (
                "IMAGE",
                {"label": f"第 {group_index} 组图片 / 帧串", "tooltip": f"第 {group_index} 组：可接单张图片、视频帧批次或多帧图片序列。"},
            )
            optional[f"injection_audio_{group_index}"] = (
                "AUDIO",
                {"label": f"第 {group_index} 组音频", "tooltip": f"第 {group_index} 组：可选，从该组起始帧开始注入音频。"},
            )
        return {
            "required": required,
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("二采正向条件", "二采 latent")
    FUNCTION = "prepare"
    CATEGORY = "H3 / Media"

    @staticmethod
    def _target_shape(latent: dict[str, Any]) -> tuple[int, int, int]:
        """Read pixel width, height and resolved frame count from an H3 AV latent."""
        try:
            from comfy.ldm.minimax.model import FRAME_PER_TOKEN

            samples = latent["samples"]
            video = samples.tensors[0]
            if not samples.is_nested or video.ndim != 5 or video.shape[1] != 24:
                raise ValueError
            width = int(video.shape[4] * 16)
            height = int(video.shape[3] * 16)
            frames = int(sum(FRAME_PER_TOKEN[index % 5] for index in range(video.shape[2])))
            return width, height, frames
        except Exception as error:
            raise ValueError("H3 二采准备需要 LTXVConcatAVLatent 输出的 MiniMax H3 AV latent。") from error

    @staticmethod
    def _choose_image_text(_manifest: dict[str, Any], local_value: bool, external_value: bool | None) -> bool:
        if external_value is not None:
            return bool(external_value)
        return bool(local_value)

    def prepare(
        self,
        media_board: dict[str, Any],
        clip: Any,
        upscaled_latent: dict[str, Any],
        use_image_text: bool,
        frame_idx: int,
        vae: Any = None,
        audio_vae: Any = None,
        guide_sync: dict[str, Any] | None = None,
        external_switch: bool | None = None,
        injection_image: torch.Tensor | None = None,
        injection_audio: dict[str, Any] | None = None,
        **additional_guides: Any,
    ):
        try:
            from comfy_extras.nodes_minimax_h3 import (
                MiniMaxH3AddGuide,
                MiniMaxH3ImageToVideo,
                MiniMaxH3ReferenceToVideo,
            )
        except ImportError as error:
            raise RuntimeError("未找到 ComfyUI 原生 MiniMax H3 节点；请更新 ComfyUI 后再使用 H3 二采准备。") from error

        manifest = _clean_manifest(media_board)
        if isinstance(guide_sync, dict):
            vae = guide_sync.get("vae") or vae
            audio_vae = guide_sync.get("audio_vae") or audio_vae
        if vae is None:
            raise ValueError("H3 二采准备需要视频 VAE；请连接视频 VAE，或接入 H3 多时间点引导帧的二采同步输出。")
        width, height, frames = self._target_shape(upscaled_latent)
        prompt = str(media_board.get("prompt", "")) if isinstance(media_board, dict) else ""
        image_text_mode = self._choose_image_text(manifest, bool(use_image_text), external_switch)

        if image_text_mode:
            first_frame = _load_image(manifest["image"][0]) if manifest["image"] and manifest["image"][0] else None
            last_frame = _load_image(manifest["image"][1]) if len(manifest["image"]) > 1 and manifest["image"][1] else None
            positive = MiniMaxH3ImageToVideo.execute(
                clip, vae, prompt, width, height, frames, first_frame, last_frame
            )[0]
        else:
            ref_images = {
                f"ref_image_{index}": _load_image(item)
                for index, item in enumerate(manifest["image"])
                if item is not None
            }
            ref_videos = {
                f"ref_video_{index}": _load_video_frames(item)
                for index, item in enumerate(manifest["video"])
                if item is not None
            }
            ref_videos = {name: frames_tensor for name, frames_tensor in ref_videos.items() if frames_tensor is not None}
            ref_video_audios = {
                f"ref_video_audio_{index}": _load_audio(item)
                for index, item in enumerate(manifest["video"])
                if item is not None
            }
            ref_video_audios = {name: audio for name, audio in ref_video_audios.items() if audio is not None}
            ref_audios = {
                f"ref_audio_{index}": _load_audio(item)
                for index, item in enumerate(manifest["audio"])
                if item is not None
            }
            ref_audios = {name: audio for name, audio in ref_audios.items() if audio is not None}
            positive = MiniMaxH3ReferenceToVideo.execute(
                clip, vae, audio_vae, prompt, width, height, frames, "match",
                ref_images, ref_videos, ref_video_audios, ref_audios,
            )[0]

        synced_groups = guide_sync.get("groups") if isinstance(guide_sync, dict) else None
        if isinstance(synced_groups, list):
            guide_groups = [
                (group.get("frame_idx", 0), group.get("image"), group.get("audio"))
                for group in synced_groups if isinstance(group, dict)
            ]
        else:
            guide_groups = [(frame_idx, injection_image, injection_audio)]
            for group_index in range(2, self.MAX_GUIDE_GROUPS + 1):
                guide_groups.append((
                    additional_guides.get(f"frame_idx_{group_index}", 0),
                    additional_guides.get(f"injection_image_{group_index}"),
                    additional_guides.get(f"injection_audio_{group_index}"),
                ))
        # AddGuide appends a keyframe to the conditioning. Repeating it here
        # lets one compact node place several stills, clips or audio cues at
        # independent timeline positions for the second sampling pass.
        for guide_frame_idx, guide_image, guide_audio in guide_groups:
            if guide_image is None and guide_audio is None:
                continue
            positive = MiniMaxH3AddGuide.execute(
                positive, upscaled_latent, int(guide_frame_idx),
                vae=vae, audio_vae=audio_vae,
                image=guide_image, audio=guide_audio,
            )[0]
        return (positive, upscaled_latent)


class H3MultiTimeGuide:
    """Place several native H3 image/audio guides on one conditioning stream."""

    # ComfyUI validates a stable backend schema; the accompanying frontend
    # exposes only used groups plus one empty next group.
    MAX_GUIDE_GROUPS = 12

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "positive": ("CONDITIONING", {"tooltip": "接 H3 图文或多参节点的正向条件，也可接上一个引导节点的 positive。"}),
            "latent": ("LATENT", {"tooltip": "接与该正向条件配套的 MiniMax H3 AV latent。"}),
            "frame_idx": (
                "INT",
                {"default": 0, "min": -9999, "max": 9999, "step": 1, "label": "第 1 组注入起始帧"},
            ),
        }
        optional = {
            "vae": ("VAE", {"label": "视频 VAE", "tooltip": "注入图片/帧串时需要 H3 视频 VAE。"}),
            "audio_vae": ("VAE", {"label": "音频 VAE", "tooltip": "注入音频时需要 H3 音频 VAE。"}),
            "guide_image": ("IMAGE", {"label": "第 1 组图片 / 帧串", "tooltip": "第 1 组：可接单张图片、视频帧批次或多帧图片序列。"}),
            "guide_audio": ("AUDIO", {"label": "第 1 组音频", "tooltip": "第 1 组：可选，从该组起始帧开始注入音频。"}),
        }
        for group_index in range(2, cls.MAX_GUIDE_GROUPS + 1):
            required[f"frame_idx_{group_index}"] = (
                "INT",
                {
                    "default": 0, "min": -9999, "max": 9999, "step": 1,
                    "label": f"第 {group_index} 组注入起始帧",
                },
            )
            optional[f"guide_image_{group_index}"] = (
                "IMAGE",
                {"label": f"第 {group_index} 组图片 / 帧串", "tooltip": f"第 {group_index} 组：可接单张图片、视频帧批次或多帧图片序列。"},
            )
            optional[f"guide_audio_{group_index}"] = (
                "AUDIO",
                {"label": f"第 {group_index} 组音频", "tooltip": f"第 {group_index} 组：可选，从该组起始帧开始注入音频。"},
            )
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("CONDITIONING", "H3_GUIDE_SYNC")
    RETURN_NAMES = ("positive", "二采同步")
    FUNCTION = "guide"
    CATEGORY = "H3 / Media"

    def guide(
        self,
        positive: Any,
        latent: dict[str, Any],
        frame_idx: int,
        vae: Any = None,
        audio_vae: Any = None,
        guide_image: torch.Tensor | None = None,
        guide_audio: dict[str, Any] | None = None,
        **additional_guides: Any,
    ):
        try:
            from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide
        except ImportError as error:
            raise RuntimeError("未找到 ComfyUI 原生 MiniMax H3 节点；请更新 ComfyUI 后再使用 H3 多时间点引导帧。") from error

        guide_groups = [(frame_idx, guide_image, guide_audio)]
        for group_index in range(2, self.MAX_GUIDE_GROUPS + 1):
            guide_groups.append((
                additional_guides.get(f"frame_idx_{group_index}", 0),
                additional_guides.get(f"guide_image_{group_index}"),
                additional_guides.get(f"guide_audio_{group_index}"),
            ))
        for guide_frame_idx, image, audio in guide_groups:
            if image is None and audio is None:
                continue
            positive = MiniMaxH3AddGuide.execute(
                positive, latent, int(guide_frame_idx),
                vae=vae, audio_vae=audio_vae, image=image, audio=audio,
            )[0]
        # The bundle makes the second pass reuse exactly the same guide
        # assets, VAE pair and timeline positions without duplicating wires.
        # It remains a separate output so existing workflows using `positive`
        # continue to work unchanged.
        guide_sync = {
            "vae": vae,
            "audio_vae": audio_vae,
            "groups": [
                {"frame_idx": int(guide_frame_idx), "image": image, "audio": audio}
                for guide_frame_idx, image, audio in guide_groups
                if image is not None or audio is not None
            ],
        }
        return (positive, guide_sync)


class DynamicMediaBoard:
    """A growing image/audio upload board with one output per populated asset.

    ComfyUI needs output types to be declared ahead of time, so the node owns
    a generous fixed backend capacity.  The frontend hides all unused ports
    and reveals each port exactly when its matching card receives an upload.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "media_manifest": ("STRING", {"default": "{}", "multiline": False}),
                "resize_mode": ([
                    "不缩放", "指定尺寸（拉伸）", "指定尺寸（居中裁切）", "指定尺寸（留边）", "按宽度等比", "按高度等比",
                ], {"default": "不缩放", "label": "统一图像缩放模式"}),
                "resize_width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8, "label": "统一缩放宽度"}),
                "resize_height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8, "label": "统一缩放高度"}),
                "resize_method": (["双三次", "双线性", "最近邻", "区域"], {"default": "双三次", "label": "缩放算法"}),
            },
        }

    # The canvas creates only populated outputs at runtime.  A wildcard schema
    # lets those dynamic slots be IMAGE or AUDIO in their visible order.
    RETURN_TYPES = tuple("*" for _ in range(DYNAMIC_MEDIA_LIMIT * 2))
    RETURN_NAMES = tuple(
        [f"图片_{index}" for index in range(1, DYNAMIC_MEDIA_LIMIT + 1)]
        + [f"音频_{index}" for index in range(1, DYNAMIC_MEDIA_LIMIT + 1)]
    )
    FUNCTION = "collect"
    CATEGORY = "H3 / Media"

    def collect(
        self,
        media_manifest: str,
        resize_mode: str = "不缩放",
        resize_width: int = 1024,
        resize_height: int = 1024,
        resize_method: str = "双三次",
    ):
        manifest = _clean_dynamic_media_manifest(media_manifest)
        images = [
            _resize_dynamic_image(_load_image(item), resize_mode, resize_width, resize_height, resize_method)
            for item in manifest["image"]
        ]
        audios = [_load_audio(item) for item in manifest["audio"]]
        values = images + audios
        values += [None] * (DYNAMIC_MEDIA_LIMIT * 2 - len(values))
        return tuple(values)


class PanoramaViewerSnapshot:
    """Interactive equirectangular panorama viewer with a perspective IMAGE output."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panorama_path": ("STRING", {"default": "", "multiline": False}),
                "yaw": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.1}),
                "pitch": ("FLOAT", {"default": 0.0, "min": -89.0, "max": 89.0, "step": 0.1}),
                "horizontal_fov": ("FLOAT", {"default": 90.0, "min": 30.0, "max": 120.0, "step": 1.0}),
                "aspect_ratio": (list(PANORAMA_ASPECT_RATIOS), {"default": "16:9"}),
                "output_width": ("INT", {"default": 1024, "min": 256, "max": 8192, "step": 8}),
                "lock_x": ("BOOLEAN", {"default": False, "label_on": "锁定 X", "label_off": "解锁 X"}),
                "lock_y": ("BOOLEAN", {"default": False, "label_on": "锁定 Y", "label_off": "解锁 Y"}),
                "lock_z": ("BOOLEAN", {"default": False, "label_on": "锁定 Z", "label_off": "解锁 Z"}),
                "annotations": ("STRING", {"default": "[]", "multiline": False}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "可选：从其他节点输入全景图；拖入节点的图片优先由全景图路径使用。"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("截图",)
    FUNCTION = "snapshot"
    CATEGORY = "H3 / Media"

    def snapshot(
        self,
        panorama_path: str,
        yaw: float,
        pitch: float,
        horizontal_fov: float,
        aspect_ratio: str,
        output_width: int,
        lock_x: bool = False,
        lock_y: bool = False,
        lock_z: bool = False,
        annotations: str = "[]",
        image: torch.Tensor | None = None,
    ):
        if image is None:
            if not panorama_path:
                raise ValueError("请拖入一张 2:1 等距柱状全景图，或连接 image 输入。")
            image = _load_image({"path": panorama_path, "name": Path(panorama_path).name})
        ratio_width, ratio_height = PANORAMA_ASPECT_RATIOS.get(aspect_ratio, PANORAMA_ASPECT_RATIOS["16:9"])
        max_width = min(8192, math.floor(8192 * ratio_width / ratio_height))
        width = max(256, min(max_width, int(output_width)))
        height = max(16, round(width * ratio_height / ratio_width))
        snapshot = _equirectangular_to_perspective(image, yaw, pitch, horizontal_fov, width, height)
        return (_paint_panorama_rectangles(snapshot, annotations),)


NODE_CLASS_MAPPINGS = {
    "H3MediaBoard": H3MediaBoard,
    "H3MediaBoardUnpack": H3MediaBoardUnpack,
    "H3ConditionLatentSwitch": H3ConditionLatentSwitch,
    "H3VideoModeControl": H3VideoModeControl,
    "H3SecondPassPreparation": H3SecondPassPreparation,
    "H3MultiTimeGuide": H3MultiTimeGuide,
    "DynamicMediaBoard": DynamicMediaBoard,
    "PanoramaViewerSnapshot": PanoramaViewerSnapshot,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3MediaBoard": "H3 Media Board (9 Image / 3 Audio / 3 Video)",
    "H3MediaBoardUnpack": "H3 Media Board Outputs",
    "H3ConditionLatentSwitch": "H3 条件与 Latent 切换",
    "H3VideoModeControl": "H3 生视频模式控制",
    "H3SecondPassPreparation": "H3 二采准备（高分条件 / 注入帧）",
    "H3MultiTimeGuide": "H3 多时间点引导帧",
    "DynamicMediaBoard": "动态素材板（图片 / 音频）",
    "PanoramaViewerSnapshot": "360° 全景查看与截图",
}
