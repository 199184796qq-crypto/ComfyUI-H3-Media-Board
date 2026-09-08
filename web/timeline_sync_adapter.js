// Compatibility boundary for Timeline Director's v4 editor and HTTP API.
export const targetTypes = new Set(["MiniMaxH3TimelinePlanner", "MiniMaxH3TimelineDirector"]);

export function checkTarget(node) {
  if (node?.inputs?.some(input => input.name === "timeline_data" && input.link != null)) {
    throw new Error("请断开目标 timeline_data 的输入连线；同步桥通过下拉选择目标，不需要输出连线");
  }
  const ui = node?.__m3td;
  if (!targetTypes.has(node?.comfyClass || node?.type) || !ui ||
      typeof ui.sync !== "function" || typeof ui.render !== "function" ||
      ui.state?.version !== 4 || !ui.widget ||
      !["images", "audios", "videoClips"].every(key => Array.isArray(ui.state[key]))) {
    throw new Error("目标时间线接口不兼容或尚未就绪，请更新素材板插件后重试");
  }
  if (ui.uploading || ui.drag) throw new Error("目标正在上传或编辑，请稍后同步");
  return ui;
}

export function mergeMedia(state, items, sourceId) {
  const next = structuredClone(state);
  let added = 0, updated = 0;
  for (const item of items) {
    const info = item.info;
    const key = {image:"images", audio:"audios", video:"videoClips"}[item.kind];
    const id = `h3board:${sourceId}:${item.kind}:${item.slot}`;
    const existing = next[key].find(asset => asset.id === id);
    if (!existing && next[key].some(asset => asset.file === info.filename)) continue;
    if (existing?.file === info.filename && existing.name === item.name) continue;
    const asset = {id, file:info.filename, name:item.name};
    if (item.kind === "image") Object.assign(asset, {width:info.width, height:info.height});
    else if (item.kind === "audio") {
      if (!info.hasAudio || !(info.duration > 0)) throw new Error(`音频不可用：${item.name}`);
      if (existing && (existing.trimStart || 0) >= info.duration) throw new Error(`新音频短于已有裁剪位置：${item.name}`);
      Object.assign(asset, {duration:info.duration, trimStart:existing?.trimStart || 0});
    } else {
      if (!info.hasVideo || !(info.duration > 0)) throw new Error(`视频不可用：${item.name}`);
      if (existing && existing.trimStart + existing.duration > info.duration + 0.001) {
        throw new Error(`新视频短于已有剪辑范围：${item.name}，请先调整目标剪辑`);
      }
      const start = next.videoClips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
      Object.assign(asset, {start, duration:info.duration, trimStart:0, sourceDuration:info.duration,
        hasAudio:!!info.hasAudio, referenceMode:"guide", peaks:info.peaks || [], proxy:""});
      if (existing) Object.assign(asset, {start:existing.start, duration:existing.duration,
        trimStart:existing.trimStart, referenceMode:existing.referenceMode});
    }
    if (existing) { Object.assign(existing, asset); updated++; }
    else { next[key].push(asset); added++; }
  }
  if (next.images.length > 9 || next.audios.length > 3) {
    throw new Error("同步后超过目标容量（9 张图片 / 3 段音频），请先整理目标素材；本次未写入");
  }
  return {state:next, added, updated};
}

export async function inspectMedia(api, item) {
  const response = await api.fetchApi("/minimax_h3_timeline/media_info", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({filename:item.filename, kind:item.kind}),
  });
  if (!response.ok) throw new Error(`目标素材检查失败（${response.status}），请检查目标插件版本或素材格式`);
  const info = await response.json();
  if (info.error || info.filename !== item.filename ||
      (item.kind === "image" && !(info.width > 0 && info.height > 0))) {
    throw new Error(info.error || "目标素材接口返回格式不兼容，请更新适配器");
  }
  return {...item, info};
}
