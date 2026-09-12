import os
import tempfile
from pathlib import Path

import folder_paths
import torch
from safetensors.torch import load_file, save_file
from comfy.nested_tensor import NestedTensor
from .t8_loader import load_t8_sampling
from .drift_control_av import install_drift_control_av_model

def _h3_streams(latent, label):
    samples = latent.get("samples") if isinstance(latent, dict) else None
    tensors = list(samples.unbind()) if hasattr(samples, "unbind") else list(samples.tensors) if hasattr(samples, "tensors") else list(samples) if isinstance(samples, (list, tuple)) else []
    if len(tensors) != 2 or tensors[0].ndim != 5 or tensors[1].ndim != 4:
        raise ValueError(f"{label} 必须是 H3 音视频 latent。")
    return tensors


def _valid_guide_frames(value):
    value = int(value)
    if value < 5:
        return 1
    while value % 17 != 5:
        value -= 1
    return max(1, value)


def _apply_linear_temporal_noise_mask(target_latent, source_latent, guide_frames, include_audio=True, gradient=False, audio_soft_release=True):
    target_video, target_audio = _h3_streams(target_latent, "latent")
    source_video, source_audio = _h3_streams(source_latent, "previous_latent")
    frames = _valid_guide_frames(guide_frames)
    tokens = 2 if frames <= 5 else ((frames - 5) // 17) * 5 + 2
    if tokens >= target_video.shape[2] or tokens > source_video.shape[2]:
        raise ValueError("重叠长度超过 latent 可用范围。")
    video = target_video.clone(); video[:, :, :tokens] = source_video[:, :, -tokens:].to(video)
    vm = torch.ones((1, 1, target_video.shape[2], 1, 1), device=target_video.device)
    vm[:, :, :tokens] = 0
    audio = target_audio.clone(); am = torch.ones((1, 1, 1, target_audio.shape[-1]), device=target_audio.device)
    at = 0
    if include_audio:
        at = min(round(frames * 40 / 24), source_audio.shape[-1], target_audio.shape[-1])
        audio[..., :at] = source_audio[..., -at:].to(audio); am[..., :at] = 0
    out = dict(target_latent); out["samples"] = NestedTensor((video, audio)); out["noise_mask"] = NestedTensor((vm, am))
    return out, {"frames": frames, "video_tokens": tokens}


def _path(value):
    path = Path(value.strip()).expanduser()
    if not value.strip():
        raise ValueError("请填写 latent 文件路径。")
    if not path.is_absolute():
        root = Path(folder_paths.get_output_directory()).resolve()
        path = (root / path).resolve()
        if not path.is_relative_to(root):
            raise ValueError("相对路径必须位于 ComfyUI output 内；其他目录请填写绝对路径。")
    if path.suffix.lower() != ".safetensors":
        raise ValueError("latent 文件必须使用 .safetensors 扩展名。")
    return path


class MotionCon:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT", {"tooltip": "本节尚未采样的 H3 音视频 latent。"}),
            "context_length": (["22", "5", "39", "56"], {"default": "22",
                "tooltip": "接 H3 Media Board 的 H3mb_重叠帧数；内部会按 H3 时间网格对齐。"}),
            "continue_audio": ("BOOLEAN", {"default": True}),
        }, "optional": {
            "previous_latent": ("LATENT", {"tooltip": "接 motion_con 读取，或上一节采样器输出；不接则生成第一节。"}),
        }}

    RETURN_TYPES = ("LATENT", "INT")
    RETURN_NAMES = ("latent", "trim_frames")
    FUNCTION = "apply"
    CATEGORY = "motion_con"
    DESCRIPTION = "H3 直接 latent 续接准备。模型、引导和 Sigmas 保持原采样链，本节点只把上一节尾部写入本节 latent。"

    def apply(self, latent, context_length="22", continue_audio=True, previous_latent=None):
        if previous_latent is None:
            return latent, 0
        source_video, _ = _h3_streams(previous_latent, "previous_latent")
        target_video, _ = _h3_streams(latent, "latent")
        if source_video.shape[0] != 1 or target_video.shape[0] != 1:
            raise ValueError("motion_con 续接目前要求 batch_size=1，避免误用其他样本的尾部。")
        if "noise_mask" in latent:
            raise ValueError("本节 latent 已有 noise_mask；请连接未添加遮罩的 H3 目标 latent。")
        masked, details = _apply_linear_temporal_noise_mask(
            latent, previous_latent, _valid_guide_frames(int(context_length)),
            include_audio=continue_audio, gradient=False, audio_soft_release=continue_audio,
        )
        return masked, details["frames"]


class MotionConSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT", {"tooltip": "连接采样完成后的完整 H3 音视频 latent。"}),
            "filename_prefix": ("STRING", {"default": "motion_con/clip",
                "tooltip": "文件前缀；相对路径保存到 ComfyUI output 文件夹。"}),
            "clip_index": ("INT", {"default": 1, "min": 1, "max": 9999,
                "tooltip": "本节编号。接入 H3 Media Board 的绿色存储Clip变量。"}),
        }, "optional": {"noise": ("NOISE",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("saved_path",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "motion_con"
    DESCRIPTION = "完整保存音视频 samples，保留 dtype 和数值；不保存上一节的采样遮罩。相对路径位于 output。"

    def save(self, latent, filename_prefix, clip_index, noise=None):
        video, audio = _h3_streams(latent, "latent")
        prefix = filename_prefix.strip()
        if not prefix:
            raise ValueError("请填写 filename_prefix。")
        path = _path(f"{prefix}_{int(clip_index):05d}.safetensors")
        path.parent.mkdir(parents=True, exist_ok=True)
        # 同一节重跑时覆盖自己的固定槽位，避免读取到旧的随机编号。
        handle, temporary = tempfile.mkstemp(prefix=".motion_con_", suffix=".tmp", dir=path.parent)
        os.close(handle)
        try:
            save_file({"video": video.detach().cpu().contiguous().clone(),
                       "audio": audio.detach().cpu().contiguous().clone()}, temporary,
                      metadata={"format": "motion_con_h3_av", "version": "1", "fps": "24"})
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return (str(path),)


class MotionConLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "filename_prefix": ("STRING", {"default": "motion_con/clip",
                "tooltip": "与保存节点相同的文件前缀。"}),
            "clip_index": ("INT", {"default": 0, "min": 0, "max": 9999,
                "tooltip": "要读取的上段编号；接 H3 Media Board 的绿色加载Clip_上段变量。0 表示首段，不读取。"}),
        }}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("previous_latent",)
    FUNCTION = "load"
    CATEGORY = "motion_con"

    @classmethod
    def IS_CHANGED(cls, filename_prefix, clip_index=0):
        if int(clip_index) <= 0:
            return "disabled"
        path = _path(f"{filename_prefix.strip()}_{int(clip_index):05d}.safetensors")
        if not path.is_file():
            return float("nan")
        stat = path.stat()
        return str(path), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size

    def load(self, filename_prefix, clip_index):
        if int(clip_index) <= 0:
            return (None,)
        path = _path(f"{filename_prefix.strip()}_{int(clip_index):05d}.safetensors")
        data = load_file(str(path), device="cpu")
        if "video" not in data or "audio" not in data:
            raise ValueError("需要包含 video 和 audio 的 H3 latent 文件。")
        latent = {"samples": NestedTensor([data["video"].clone(), data["audio"].clone()])}
        _h3_streams(latent, "saved latent")
        return (latent,)


class MotionConTrim:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
        }, "optional": {
            "audio": ("AUDIO",),
            "trim_frames": ("INT", {"default": 0, "min": 0, "forceInput": True}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "trim"
    CATEGORY = "motion_con"
    DESCRIPTION = "H3 按 24 fps 裁掉本节开头重复的画面和音频；保存 latent 时仍保存完整采样结果。"

    def trim(self, images, trim_frames=None, audio=None):
        if trim_frames is None:
            raise ValueError("请连接 trim_frames，指定需要裁掉的重叠帧数。")
        count = int(trim_frames)
        if count < 0 or count >= images.shape[0]:
            raise ValueError("裁切帧数必须小于本节总帧数。")
        result_audio = audio
        if audio is not None and count:
            samples = round(count * int(audio["sample_rate"]) / 24)
            if samples >= audio["waveform"].shape[-1]:
                raise ValueError("音频长度不足以裁掉重叠部分。")
            result_audio = dict(audio, waveform=audio["waveform"][..., samples:].clone())
        return images[count:].clone() if count else images, result_audio


class MotionConDynamic:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "latent": ("LATENT",), "sigmas": ("SIGMAS",),
            "previous_latent": ("LATENT",),
            "context_length": (["22", "5", "39", "56"], {"default": "22"}),
        }}
    RETURN_TYPES = ("MODEL", "LATENT")
    RETURN_NAMES = ("model", "latent")
    FUNCTION = "apply"
    CATEGORY = "motion_con"
    DESCRIPTION = "独立动态遮罩包装；不修改 T8 原节点。"

    def apply(self, model, latent, sigmas, previous_latent, context_length):
        masked, details = _apply_linear_temporal_noise_mask(
            latent, previous_latent, _valid_guide_frames(int(context_length)),
            include_audio=True, gradient=False, audio_soft_release=True)
        wrapped = install_drift_control_av_model(model, masked, sigmas, details["video_tokens"])
        return wrapped, masked


class MotionConT8Wrapper:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "av_latent": ("LATENT",),
            "steps": ("INT", {"default": 4, "min": 1, "max": 1000}),
            "shift_video": ("FLOAT", {"default": 12.0}), "shift_audio": ("FLOAT", {"default": 3.0}),
            "sampler_name": (["dual_clock_euler", "euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp", "heun", "heunpp2", "exp_heun_2_x0", "exp_heun_2_x0_sde", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_cfg_pp", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_2m_sde_heun", "dpmpp_2m_sde_heun_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ipndm", "ipndm_v", "deis", "cfgpp_ud10_ab", "res_multistep", "res_multistep_cfg_pp", "res_multistep_ancestral", "res_multistep_ancestral_cfg_pp", "gradient_estimation", "gradient_estimation_cfg_pp", "er_sde", "seeds_2", "seeds_3", "sa_solver", "sa_solver_pece"], {"default": "dual_clock_euler"}),
            "scheduler": (["native_flow", "normal", "karras", "exponential", "sgm_uniform"], {"default": "native_flow"}),
            "context_length": (["22", "5", "39", "56"], {"default": "22"})},
            "optional": {"previous_latent": ("LATENT",)}}
            
    RETURN_TYPES = ("MODEL", "SAMPLER", "SIGMAS", "LATENT")
    RETURN_NAMES = ("model", "sampler", "sigmas", "av_latent")
    FUNCTION = "apply"
    CATEGORY = "H3-Media-Board"
    DESCRIPTION = "T8 独立包装版：复制 T8 采样设置并加入动态遮罩，不修改 T8 原节点。"

    def apply(self, model, av_latent, steps, shift_video, shift_audio, sampler_name, scheduler, context_length, previous_latent=None):
        module = load_t8_sampling()
        base_model, sampler, sigmas = module.setup_dual_clock_sampling(
            model, av_latent, steps, shift_video, shift_audio, sampler_name, scheduler)
        if previous_latent is None:
            return base_model, sampler, sigmas, av_latent
        masked, details = _apply_linear_temporal_noise_mask(
            av_latent, previous_latent, _valid_guide_frames(int(context_length)),
            include_audio=True, gradient=False, audio_soft_release=True)
        return install_drift_control_av_model(base_model, masked, sigmas, details["video_tokens"]), sampler, sigmas, masked


NODE_CLASS_MAPPINGS = {
    "motion_con": MotionCon,
    "motion_con_save": MotionConSave,
    "motion_con_load": MotionConLoad,
    "motion_con_trim": MotionConTrim,
    "motion_con_dynamic": MotionConDynamic,
    "motion_con_t8_wrapper": MotionConT8Wrapper,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "motion_con": "motion_con",
    "motion_con_save": "motion_con 保存",
    "motion_con_load": "motion_con 读取",
    "motion_con_trim": "motion_con 裁掉重叠",
    "motion_con_dynamic": "motion_con 动态包装",
    "motion_con_t8_wrapper": "motion_con T8 动态包装",
}
