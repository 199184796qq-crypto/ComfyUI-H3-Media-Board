"""Source-audio control for an already selected H3 AV latent."""

import torch
import torchaudio
from comfy.nested_tensor import NestedTensor


def control_audio(av_latent, audio_mode="native", audio_denoise_strength=0.35,
                  drive_audio=None, audio_vae=None):
    if audio_mode == "native":
        return av_latent
    if audio_mode not in {"lock_source", "remix_source"}:
        raise ValueError(f"未知音频模式：{audio_mode}")
    if drive_audio is None or audio_vae is None:
        raise ValueError("锁定或重混源音频需要连接 drive_audio 和 audio_vae。")
    if not 0 <= audio_denoise_strength <= 1:
        raise ValueError("音频去噪强度必须在 0 到 1 之间。")
    samples = av_latent["samples"]
    if not isinstance(samples, NestedTensor) or len(samples.unbind()) != 2:
        raise ValueError("音频控制需要 H3 音视频联合 Latent。")
    video, audio = samples.unbind()
    if video.ndim != 5 or audio.ndim != 4:
        raise ValueError("H3 Latent 的视频或音频维度不正确。")

    waveform = drive_audio["waveform"]
    sample_rate = drive_audio["sample_rate"]
    vae_rate = audio_vae.audio_sample_rate
    if sample_rate != vae_rate:
        waveform = torchaudio.functional.resample(waveform, sample_rate, vae_rate)
    encoded = audio_vae.encode(waveform.movedim(1, -1))
    if encoded.ndim != 4 or encoded.shape[1:-1] != audio.shape[1:-1]:
        raise ValueError("请连接 MiniMax H3 音频 VAE，编码结果与目标音频 Latent 不匹配。")
    if encoded.shape[0] == 1 and audio.shape[0] > 1:
        encoded = encoded.expand(audio.shape[0], -1, -1, -1)
    if encoded.shape[0] != audio.shape[0]:
        raise ValueError("源音频与目标 Latent 的批次数不匹配。")
    encoded = encoded[..., :audio.shape[-1]]
    encoded = torch.nn.functional.pad(encoded, (0, audio.shape[-1] - encoded.shape[-1]))
    encoded = encoded.to(device=audio.device, dtype=audio.dtype)

    mask = av_latent.get("noise_mask")
    if isinstance(mask, NestedTensor):
        video_mask, _ = mask.unbind()
    elif mask is None:
        video_mask = torch.ones_like(video)
    elif isinstance(mask, torch.Tensor):
        video_mask = mask
    else:
        raise ValueError("无法识别 H3 Latent 的噪声遮罩。")
    strength = 0.0 if audio_mode == "lock_source" else audio_denoise_strength
    result = av_latent.copy()
    result["samples"] = NestedTensor((video, encoded))
    result["noise_mask"] = NestedTensor((video_mask, torch.full_like(encoded, strength)))
    return result
