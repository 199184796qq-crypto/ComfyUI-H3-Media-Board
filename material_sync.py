import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from aiohttp import web
import folder_paths
from server import PromptServer
from .nodes import _h3_settings


def import_media(manifest):
    root = Path(folder_paths.get_input_directory()).resolve()
    source_root = (root / "h3_media_board").resolve()
    destination = (root / "minimax_h3_timeline_director").resolve()
    if not destination.is_relative_to(root):
        raise ValueError("目标素材目录必须位于 ComfyUI input 中")
    destination.mkdir(exist_ok=True)
    result = []
    for kind in ("image", "audio", "video"):
        entries = manifest.get(kind, [])
        if not isinstance(entries, list):
            raise ValueError("素材列表格式错误")
        for index, item in enumerate(entries):
            if not item:
                continue
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise ValueError("素材路径格式错误")
            source = (root / item["path"]).resolve()
            if not source.is_relative_to(source_root):
                raise ValueError("素材必须位于 input/h3_media_board 中")
            stat = source.stat()
            identity = f"{source}:{stat.st_size}:{stat.st_mtime_ns}"
            name = "board_" + hashlib.sha256(identity.encode()).hexdigest()[:24] + source.suffix.lower()
            target = destination / name
            if not target.exists():
                fd, temporary = tempfile.mkstemp(dir=destination, suffix=".tmp")
                os.close(fd)
                try:
                    shutil.copyfile(source, temporary)
                    os.replace(temporary, target)
                finally:
                    Path(temporary).unlink(missing_ok=True)
            result.append({"kind": kind, "slot": index, "filename": f"{destination.name}/{name}", "name": item.get("name") or source.name})
    return result


@PromptServer.instance.routes.post("/h3_material_sync/import")
async def import_route(request):
    try:
        payload = await request.json()
        manifest = payload.get("manifest")
        if not isinstance(manifest, dict):
            raise ValueError("素材清单格式错误")
        result = await asyncio.to_thread(import_media, manifest)
        raw = payload["settings"]
        settings = _h3_settings(raw["duration"], raw["aspect_ratio"], raw["megapixels"], raw["multiple"])
        return web.json_response({"items": result, "settings": {
            key: settings[key] for key in ("width", "height", "duration")
        }})
    except (ValueError, KeyError, TypeError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


class H3MaterialSync:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media_board": ("H3_MEDIA_BOARD",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("导入素材清单",)
    FUNCTION = "collect"
    CATEGORY = "H3-Media-Board"
    DESCRIPTION = "连接素材板，在目标时间线下拉框选择节点，再点击同步。同步完成后再运行工作流。"

    def collect(self, media_board):
        return (json.dumps(import_media(media_board), ensure_ascii=False),)
