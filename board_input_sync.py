"""Wireless image/audio input for the media board; queue links are supplied by JS."""
import hashlib
import io
import json
from pathlib import Path
import wave

import numpy as np
from PIL import Image
import folder_paths


def save_media(data, suffix):
    name = "bridge_" + hashlib.sha256(data).hexdigest() + suffix
    root = Path(folder_paths.get_input_directory()) / "h3_media_board"
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    if not path.exists():
        path.write_bytes(data)
    return {"path": f"h3_media_board/{name}", "name": name}


class H3BoardInputSync:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target_board": ("STRING", {"default": ""}),
                "image_slot": ("INT", {"default": 1, "min": 1, "max": 9}),
                "audio_slot": ("INT", {"default": 1, "min": 1, "max": 3}),
                "image_batch_index": ("INT", {"default": 0, "min": 0}),
                "audio_batch_index": ("INT", {"default": 0, "min": 0}),
            },
            "optional": {"image": ("IMAGE",), "audio": ("AUDIO",),
                         "base_manifest": ("STRING", {"forceInput": True})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("同步清单（无需连线）",)
    FUNCTION = "sync"
    CATEGORY = "H3-Media-Board"
    OUTPUT_NODE = True
    DESCRIPTION = "接入 IMAGE/AUDIO，选择目标素材板和序号，运行后无线同步。批次索引从 0 开始。"

    def sync(self, target_board, image_slot, audio_slot, image_batch_index=0,
             audio_batch_index=0, image=None, audio=None, base_manifest="{}"):
        if not target_board:
            raise ValueError("请选择目标 H3 Media Board")
        if image is None and audio is None:
            raise ValueError("请至少接入一张图片或一段 AUDIO")
        if not 1 <= image_slot <= 9 or not 1 <= audio_slot <= 3:
            raise ValueError("图片序号为 1–9，音频序号为 1–3")
        manifest = json.loads(base_manifest)
        if not isinstance(manifest, dict):
            raise ValueError("素材清单必须是对象")
        updates = []
        if image is not None:
            if not 0 <= image_batch_index < image.shape[0]:
                raise ValueError("图片批次索引超出范围")
            pixels = image[image_batch_index].detach().cpu().float().numpy()
            pixels = np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)
            if pixels.shape[-1] == 1:
                pixels = pixels[..., 0]
            buffer = io.BytesIO()
            Image.fromarray(pixels).save(buffer, format="PNG")
            updates.append(("image", image_slot, save_media(buffer.getvalue(), ".png")))
        if audio is not None:
            waveform = audio["waveform"]
            if waveform.ndim != 3 or not 0 <= audio_batch_index < waveform.shape[0]:
                raise ValueError("AUDIO 应为 [批次, 声道, 采样]，请检查音频批次索引")
            sample_rate = int(audio["sample_rate"])
            if sample_rate <= 0 or waveform.shape[1] < 1 or waveform.shape[2] < 1:
                raise ValueError("音频采样率、声道和长度必须大于零")
            samples = waveform[audio_batch_index].detach().cpu().float().numpy().T
            pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype("<i2")
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as output:
                output.setnchannels(pcm.shape[1])
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(pcm.tobytes())
            updates.append(("audio", audio_slot, save_media(buffer.getvalue(), ".wav")))
        for kind, slot, item in updates:
            entries = manifest.setdefault(kind, [])
            while len(entries) < slot:
                entries.append(None)
            entries[slot - 1] = item
        return {"ui": {"h3_input_sync": [{"target": str(target_board), "updates": updates}]},
                "result": (json.dumps(manifest, ensure_ascii=False),)}
