import { app } from "../../scripts/app.js";

const LIMITS = { image: 9, audio: 3, video: 3 };
const LABELS = { image: "参考图片", audio: "参考音频", video: "参考视频" };
const ACCEPTS = { image: "image/*", audio: "audio/*", video: "video/*" };
const H3_RATIOS = {
  "1:1": [1, 1], "2:3": [2, 3], "3:2": [3, 2], "3:4": [3, 4],
  "4:3": [4, 3], "9:16": [9, 16], "16:9": [16, 9], "21:9": [21, 9],
};

function h3Settings(duration, aspectRatio, megapixels, multiple, autoCalculate = true, manualFrames = 362) {
  const seconds = Math.min(15, Math.max(4, Number(duration) || 15));
  const mp = Math.min(16, Math.max(0.1, Number(megapixels) || 0.4));
  const align = Math.min(128, Math.max(8, Math.round(Number(multiple) || 32)));
  const [ratioWidth, ratioHeight] = H3_RATIOS[aspectRatio] || H3_RATIOS["9:16"];
  const scale = Math.sqrt(mp * 1024 * 1024 / (ratioWidth * ratioHeight));
  const width = Math.round(ratioWidth * scale / align) * align;
  const height = Math.round(ratioHeight * scale / align) * align;
  const baseFrames = Math.max(5, Math.round(seconds * 24));
  const calculatedFrames = baseFrames + (5 - baseFrames % 17) % 17;
  const automatic = Boolean(autoCalculate);
  return { duration: seconds, aspectRatio, megapixels: mp, multiple: align, autoCalculate: automatic, manualFrames: Math.max(1, Math.round(Number(manualFrames) || 1)), width, height, frames: automatic ? calculatedFrames : Math.max(1, Math.round(Number(manualFrames) || 1)) };
}

function viewUrl(path) {
  // ComfyUI deliberately strips folders from `filename` for security.  A board
  // asset is stored below input/h3_media_board, therefore its folder must be
  // sent separately as `subfolder` or the server looks in input/ and returns 404.
  const normalized = String(path || "").replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const subfolder = slash >= 0 ? normalized.slice(0, slash) : "";
  const suffix = subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : "";
  return `/view?filename=${encodeURIComponent(filename)}${suffix}&type=input`;
}

function readManifest(widget) {
  try {
    const parsed = JSON.parse(widget.value || "{}");
    return Object.fromEntries(Object.keys(LIMITS).map((kind) => [kind, Array.isArray(parsed[kind]) ? parsed[kind].filter(Boolean).slice(0, LIMITS[kind]) : []]));
  } catch (_) {
    return { image: [], audio: [], video: [] };
  }
}

function compactMedia(state, kind) {
  state[kind] = Array.isArray(state[kind]) ? state[kind].filter(Boolean).slice(0, LIMITS[kind]) : [];
}

function injectStyle() {
  if (document.getElementById("h3-media-board-style")) return;
  const style = document.createElement("style");
  style.id = "h3-media-board-style";
  style.textContent = `
    .h3-media-board { display:flex; flex-direction:column; box-sizing:border-box; width:100%; height:100%; min-width:900px; max-width:900px; min-height:1010px; color:#ddd; font:12px system-ui, sans-serif; user-select:none; }
    .h3-media-board .mb-title { margin: 8px 0 5px; color:#c9c9c9; font-weight:700; }
    .h3-media-board .mb-row { display:flex; gap:7px; min-height:78px; }
    .h3-media-board .mb-image-grid { display:grid; grid-template-columns:repeat(3, 294px); gap:7px; }
    .h3-media-board .mb-card { position:relative; box-sizing:border-box; width:294px; flex:0 0 294px; border:1px dashed #687078; border-radius:8px; background:#202428; overflow:hidden; cursor:pointer; }
    .h3-media-board .mb-card.drag-over { border:2px solid #69ee7a; background:#243129; box-shadow:inset 0 0 0 1px #69ee7a66; }
    .h3-media-board .mb-image { height:132px; } .h3-media-board .mb-audio { height:78px; } .h3-media-board .mb-video { height:116px; }
    .h3-media-board .mb-card.empty { display:flex; align-items:center; justify-content:center; color:#9aa2a9; }
    .h3-media-board .mb-card:not(.empty) { border-style:solid; border-color:#485057; }
    .h3-media-board .mb-index { position:absolute; z-index:3; top:6px; left:6px; padding:2px 7px; border-radius:6px; background:#111a; font-weight:800; }
    .h3-media-board .mb-remove, .h3-media-board .mb-replace { position:absolute; z-index:3; border:0; color:#fff; background:#16191dcc; border-radius:5px; cursor:pointer; }
    .h3-media-board .mb-remove { top:5px; right:5px; width:22px; height:22px; font-size:18px; line-height:18px; }
    .h3-media-board .mb-replace { bottom:25px; right:5px; font-size:11px; padding:3px 6px; }
    .h3-media-board img, .h3-media-board video { width:100%; height:100%; object-fit:cover; display:block; }
    .h3-media-board .mb-audio .mb-replace { top:6px; bottom:auto; right:36px; }
    .h3-media-board .mb-video .mb-replace { top:6px; bottom:auto; right:36px; }
    .h3-media-board .mb-audio-player { display:grid; grid-template-columns:28px 72px 1fr 58px; align-items:center; gap:8px; height:100%; box-sizing:border-box; padding:26px 10px 18px; }
    .h3-media-board .mb-audio-play { width:28px; height:28px; padding:0; border:0; border-radius:50%; color:#e8edf1; background:#4d5f6b; cursor:pointer; font-size:12px; }
    .h3-media-board .mb-audio-time { color:#d8dde2; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .h3-media-board .mb-audio-seek { width:100%; accent-color:#7fb3d9; cursor:pointer; }
    .h3-media-board .mb-video-player { position:relative; width:100%; height:100%; background:#090b0d; }
    .h3-media-board .mb-video-player video { cursor:pointer; }
    .h3-media-board .mb-video-controls { position:absolute; z-index:2; left:7px; right:7px; bottom:26px; display:grid; grid-template-columns:28px 72px 1fr; align-items:center; gap:7px; padding:3px 5px; border-radius:5px; background:#080a0ab8; }
    .h3-media-board .mb-video-controls .mb-audio-time { font-size:11px; }
    .h3-media-board .mb-name { position:absolute; bottom:0; left:0; right:0; z-index:2; padding:4px 7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:#111c; }
    .h3-media-board .mb-settings { position:relative; display:grid; grid-template-columns:repeat(3, 1fr); gap:9px 11px; margin:16px 0 2px; padding:27px 12px 11px; border:1px solid #4c626a; border-radius:9px; background:linear-gradient(145deg,#20282e 0%,#171c20 100%); box-shadow:inset 0 1px #ffffff08, 0 2px 8px #0004; }
    .h3-media-board .mb-settings-head { position:absolute; top:-11px; left:12px; display:flex; align-items:center; gap:8px; padding:3px 9px; border:1px solid #4c626a; border-radius:6px; color:#edf4f7; background:#20282e; }
    .h3-media-board .mb-settings-title { color:#8de9f4; font-size:12px; font-weight:800; letter-spacing:.35px; }
    .h3-media-board .mb-settings-caption { color:#87949d; font-size:10px; }
    .h3-media-board .mb-setting { display:flex; flex-direction:column; align-items:stretch; gap:4px; min-width:0; color:#bfc8ce; }
    .h3-media-board .mb-setting label { color:#9eabb4; font-size:10px; font-weight:700; letter-spacing:.2px; }
    .h3-media-board .mb-setting input, .h3-media-board .mb-setting select { box-sizing:border-box; min-width:0; width:100%; height:29px; padding:4px 7px; color:#edf2f5; background:#101417; border:1px solid #4b5b64; border-radius:5px; outline:none; font:12px system-ui, sans-serif; }
    .h3-media-board .mb-setting input:focus, .h3-media-board .mb-setting select:focus { border-color:#78d7e3; box-shadow:0 0 0 2px #78d7e322; }
    .h3-media-board .mb-setting-checkbox { flex-direction:row; align-items:center; justify-content:space-between; padding:0 8px; height:48px; border:1px solid #43545c; border-radius:6px; background:#151b1f; }
    .h3-media-board .mb-setting-checkbox label { color:#c9d6da; font-size:11px; }
    .h3-media-board .mb-setting input[type="checkbox"] { width:auto; height:auto; padding:0; accent-color:#69ee7a; transform:scale(1.18); }
    .h3-media-board .mb-setting input:disabled { opacity:.45; cursor:not-allowed; }
    .h3-media-board .mb-output-summary { grid-column:1 / -1; padding:7px 9px; border-left:3px solid #69ee7a; border-radius:4px; color:#76ec87; background:#13271a; font-size:13px; font-weight:800; letter-spacing:.15px; }
    .h3-media-board textarea { display:block; box-sizing:border-box; flex:1 1 auto; width:100%; min-height:145px; margin:9px 0 4px; padding:8px; resize:none; color:#ececec; background:#15181b; border:1px solid #586168; border-radius:6px; font:12px ui-monospace, Consolas, monospace; }
    .mb-preview { position:fixed; z-index:10000; inset:0; display:grid; place-items:center; background:#000b; } .mb-preview img { max-width:90vw; max-height:90vh; }
  `;
  document.head.appendChild(style);
}

function openPreview(path) {
  const overlay = document.createElement("div");
  overlay.className = "mb-preview";
  const image = document.createElement("img");
  image.src = viewUrl(path);
  overlay.append(image);
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

function kindForFile(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(extension)) return "image";
  if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"].includes(extension)) return "audio";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(extension)) return "video";
  return null;
}

function clipboardFiles(event) {
  const direct = Array.from(event.clipboardData?.files || []);
  if (direct.length) return direct;
  return Array.from(event.clipboardData?.items || []).map((item) => item.getAsFile?.()).filter(Boolean);
}

function transferFiles(event) {
  return Array.from(event.dataTransfer?.files || []);
}

function transferCanIncludeKind(event, kind) {
  const files = transferFiles(event);
  if (files.length) return files.some((file) => kindForFile(file) === kind);
  return Array.from(event.dataTransfer?.items || []).some((item) => {
    const type = String(item.type || "").toLowerCase();
    return item.kind === "file" && (type.startsWith(`${kind}/`) || (kind === "audio" && type === "application/ogg"));
  });
}

function hasMediaTransfer(event) {
  const files = transferFiles(event);
  if (files.length) return files.some(kindForFile);
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

async function uploadFile(kind, file) {
  if (!file || kindForFile(file) !== kind) return null;
  const form = new FormData();
  form.set("kind", kind);
  form.set("file", file);
  const response = await fetch("/h3_media_board/upload", { method: "POST", body: form });
  return response.ok ? await response.json() : null;
}

async function chooseAndUpload(kind) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ACCEPTS[kind];
  return await new Promise((resolve) => {
    picker.onchange = async () => {
      if (!picker.files?.[0]) return resolve(null);
      resolve(await uploadFile(kind, picker.files[0]));
    };
    picker.click();
  });
}

function stop(event) { event.preventDefault(); event.stopPropagation(); }

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function makeAudioPlayer(asset) {
  const player = document.createElement("div"); player.className = "mb-audio-player";
  const audio = document.createElement("audio"); audio.preload = "metadata"; audio.src = viewUrl(asset.path);
  const play = document.createElement("button"); play.className = "mb-audio-play"; play.textContent = "▶";
  const elapsed = document.createElement("span"); elapsed.className = "mb-audio-time"; elapsed.textContent = "0:00 / --:--";
  const seek = document.createElement("input"); seek.className = "mb-audio-seek"; seek.type = "range"; seek.min = "0"; seek.max = "1000"; seek.value = "0";
  const status = document.createElement("span"); status.className = "mb-audio-time"; status.textContent = "加载中";
  const paint = () => {
    const duration = audio.duration;
    elapsed.textContent = `${clock(audio.currentTime)} / ${clock(duration)}`;
    seek.value = Number.isFinite(duration) && duration > 0 ? String(Math.round(audio.currentTime / duration * 1000)) : "0";
  };
  play.onclick = async (event) => {
    stop(event);
    try { if (audio.paused) await audio.play(); else audio.pause(); } catch (_) { status.textContent = "无法播放"; }
  };
  seek.oninput = (event) => { stop(event); if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 1000 * audio.duration; };
  audio.onloadedmetadata = () => { status.textContent = "音频"; paint(); };
  audio.ontimeupdate = paint;
  audio.onplay = () => { play.textContent = "❚❚"; status.textContent = "播放中"; };
  audio.onpause = () => { play.textContent = "▶"; status.textContent = "音频"; };
  audio.onended = () => { play.textContent = "▶"; };
  audio.onerror = () => { status.textContent = "读取失败"; elapsed.textContent = "--:-- / --:--"; };
  player.append(audio, play, elapsed, seek, status);
  return player;
}

function makeVideoPlayer(asset) {
  const player = document.createElement("div"); player.className = "mb-video-player";
  const video = document.createElement("video"); video.preload = "auto"; video.playsInline = true; video.src = viewUrl(asset.path);
  const controls = document.createElement("div"); controls.className = "mb-video-controls";
  const play = document.createElement("button"); play.className = "mb-audio-play"; play.textContent = "▶";
  const elapsed = document.createElement("span"); elapsed.className = "mb-audio-time"; elapsed.textContent = "0:00 / --:--";
  const seek = document.createElement("input"); seek.className = "mb-audio-seek"; seek.type = "range"; seek.min = "0"; seek.max = "1000"; seek.value = "0";
  const paint = () => {
    elapsed.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    seek.value = Number.isFinite(video.duration) && video.duration > 0 ? String(Math.round(video.currentTime / video.duration * 1000)) : "0";
  };
  const toggle = async () => { try { if (video.paused) await video.play(); else video.pause(); } catch (_) { elapsed.textContent = "无法播放此视频"; } };
  play.onclick = (event) => { stop(event); toggle(); };
  seek.oninput = (event) => { stop(event); if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value) / 1000 * video.duration; };
  video.onclick = toggle;
  video.onloadedmetadata = paint;
  video.ontimeupdate = paint;
  video.onplay = () => { play.textContent = "❚❚"; };
  video.onpause = () => { play.textContent = "▶"; };
  video.onended = () => { play.textContent = "▶"; };
  video.onerror = () => { elapsed.textContent = "读取失败"; };
  controls.append(play, elapsed, seek);
  player.append(video, controls);
  return player;
}

function makeCard(kind, index, asset, update) {
  const card = document.createElement("div");
  card.className = `mb-card mb-${kind}${asset ? "" : " empty"}`;
  card.tabIndex = 0;
  const badge = document.createElement("span"); badge.className = "mb-index"; badge.textContent = String(index + 1); card.appendChild(badge);
  const select = async () => { const uploaded = await chooseAndUpload(kind); if (uploaded) update(uploaded); };
  const receiveFiles = async (files) => {
    const file = Array.from(files || []).find((candidate) => kindForFile(candidate) === kind);
    if (!file) return;
    const uploaded = await uploadFile(kind, file);
    if (uploaded) update(uploaded);
  };
  // Exposed for the page-level capture handler: the Comfy canvas may receive
  // Windows Explorer drops before this DOM widget gets a normal drop event.
  card._h3MediaKind = kind;
  card._h3ReceiveFiles = receiveFiles;
  let dragDepth = 0;
  const acceptsDrop = (event) => transferCanIncludeKind(event, kind);
  card.ondragenter = (event) => {
    if (!acceptsDrop(event)) return;
    event.preventDefault(); dragDepth += 1; card.classList.add("drag-over");
  };
  card.ondragover = (event) => {
    if (acceptsDrop(event)) { event.preventDefault(); card.classList.add("drag-over"); }
  };
  card.ondragleave = () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; card.classList.remove("drag-over"); } };
  card.ondrop = async (event) => {
    dragDepth = 0; card.classList.remove("drag-over");
    if (!acceptsDrop(event)) return;
    stop(event); await receiveFiles(transferFiles(event));
  };
  card.onpaste = async (event) => {
    const files = clipboardFiles(event);
    if (!files.some((file) => kindForFile(file) === kind)) return;
    stop(event); await receiveFiles(files);
  };
  if (!asset) { card.textContent = "点击上传文件"; card.prepend(badge); card.onclick = select; return card; }
  if (kind === "image") { const image = new Image(); image.src = viewUrl(asset.path); card.appendChild(image); card.ondblclick = () => openPreview(asset.path); }
  if (kind === "audio") card.appendChild(makeAudioPlayer(asset));
  if (kind === "video") card.appendChild(makeVideoPlayer(asset));
  const replace = document.createElement("button"); replace.className = "mb-replace"; replace.textContent = "替换"; replace.onclick = (e) => { stop(e); select(); }; card.appendChild(replace);
  const remove = document.createElement("button"); remove.className = "mb-remove"; remove.textContent = "×"; remove.onclick = (e) => { stop(e); update(null); }; card.appendChild(remove);
  const name = document.createElement("div"); name.className = "mb-name"; name.textContent = asset.name; card.appendChild(name);
  return card;
}

function makeH3SettingsPanel(widgets, node) {
  const panel = document.createElement("div"); panel.className = "mb-settings";
  const header = document.createElement("div"); header.className = "mb-settings-head";
  const title = document.createElement("span"); title.className = "mb-settings-title"; title.textContent = "H3 生成参数";
  const caption = document.createElement("span"); caption.className = "mb-settings-caption"; caption.textContent = "时长 · 画幅 · 尺寸 · 帧数";
  header.append(title, caption); panel.appendChild(header);
  const summaryText = () => {
    const settings = h3Settings(widgets.duration.value, widgets.aspect_ratio.value, widgets.megapixels.value, widgets.multiple.value, widgets.auto_calculate.value, widgets.manual_frames.value);
    return `H3 输出：${settings.width} × ${settings.height} · ${settings.frames} 帧 · ${settings.autoCalculate ? "自动对齐 · " : "手动设置 · "}24 fps`;
  };
  const createControl = (name, label, type, options = {}) => {
    const field = document.createElement("div"); field.className = `mb-setting mb-setting-${type}`;
    const caption = document.createElement("label"); caption.textContent = label;
    const input = type === "select" ? document.createElement("select") : document.createElement("input");
    const widget = widgets[name];
    if (type === "select") {
      Object.keys(H3_RATIOS).forEach((value) => {
        const option = document.createElement("option"); option.value = value; option.textContent = value; input.appendChild(option);
      });
      input.value = String(widget.value || "9:16");
    } else if (type === "checkbox") {
      input.type = "checkbox";
      input.checked = Boolean(widget.value);
    } else {
      input.type = "number";
      Object.entries(options).forEach(([key, value]) => input.setAttribute(key, String(value)));
      input.value = String(widget.value ?? options.value ?? "");
    }
    input.onchange = () => {
      const value = type === "select" ? input.value : type === "checkbox" ? input.checked : Number(input.value);
      widget.value = value;
      widget.callback?.(value);
      node._h3SaveBackup?.();
      node.graph?.setDirtyCanvas(true, true);
      panel.querySelector(".mb-output-summary").textContent = summaryText();
    };
    field.append(caption, input); panel.appendChild(field);
    return input;
  };
  createControl("duration", "时长", "number", { min: 4, max: 15, step: 0.5 });
  createControl("aspect_ratio", "宽高比", "select");
  createControl("megapixels", "百万像素", "number", { min: 0.1, max: 16, step: 0.1 });
  createControl("multiple", "倍数", "number", { min: 8, max: 128, step: 4 });
  const autoInput = createControl("auto_calculate", "自动计算帧数", "checkbox");
  const manualInput = createControl("manual_frames", "手动帧数", "number", { min: 1, max: 10000, step: 1 });
  const syncFrameMode = () => {
    manualInput.disabled = Boolean(widgets.auto_calculate.value);
    panel.querySelector(".mb-output-summary").textContent = summaryText();
  };
  const autoChange = autoInput.onchange;
  autoInput.onchange = (event) => { autoChange(event); syncFrameMode(); };
  const summary = document.createElement("div"); summary.className = "mb-output-summary";
  summary.textContent = summaryText();
  panel.appendChild(summary);
  syncFrameMode();
  return panel;
}

function createBoard(node) {
  injectStyle();
  const manifestWidget = node.widgets?.find((widget) => widget.name === "media_manifest");
  const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
  const settingsWidgets = Object.fromEntries(["duration", "aspect_ratio", "megapixels", "multiple", "auto_calculate", "manual_frames"].map((name) => [name, node.widgets?.find((widget) => widget.name === name)]));
  if (!manifestWidget || !promptWidget) return;
  // Widgets retain normal workflow serialization; their controls are rendered
  // inside the board so the media and H3 setup stay in one place.
  const hideNativeWidget = (widget) => {
    widget.hidden = true;
    widget.options = widget.options || {};
    widget.options.hidden = true;
    if (widget._state) widget._state.hidden = true;
    widget.serialize = true;
    widget.serializeValue = () => widget.value;
    if (widget.element) widget.element.style.display = "none";
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
  };
  for (const widget of [manifestWidget, promptWidget]) hideNativeWidget(widget);
  // Hiding prompt first keeps an older workflow from drawing its native
  // multiline field over the board while ComfyUI upgrades its widget schema.
  if (Object.values(settingsWidgets).some((widget) => !widget)) return;
  for (const widget of Object.values(settingsWidgets)) hideNativeWidget(widget);

  const sessionKey = `h3-media-board-live:${node.id}`;
  let sessionSaved = null;
  try { sessionSaved = JSON.parse(sessionStorage.getItem(sessionKey) || "null"); } catch (_) { /* no browser-session backup */ }
  const persisted = node.properties?.h3_media_board_saved || sessionSaved;
  if (persisted && typeof persisted === "object") {
    if (typeof persisted.media_manifest === "string") manifestWidget.value = persisted.media_manifest;
    if (typeof persisted.prompt === "string") promptWidget.value = persisted.prompt;
    for (const [name, widget] of Object.entries(settingsWidgets)) {
      if (persisted.settings?.[name] !== undefined) widget.value = persisted.settings[name];
    }
  }

  const root = document.createElement("div"); root.className = "h3-media-board"; root.tabIndex = 0;
  const prompt = document.createElement("textarea"); prompt.placeholder = "提示词（可直接连接上游文本输入）"; prompt.value = promptWidget.value || "";
  root.onpointerdown = (event) => { if (event.target !== prompt) root.focus({ preventScroll: true }); };
  const saveBackup = () => {
    node.properties = node.properties || {};
    const backup = {
      media_manifest: manifestWidget.value || "{}",
      prompt: promptWidget.value || "",
      settings: Object.fromEntries(Object.entries(settingsWidgets).map(([name, widget]) => [name, widget.value])),
    };
    node.properties.h3_media_board_saved = backup;
    try { sessionStorage.setItem(sessionKey, JSON.stringify(backup)); } catch (_) { /* storage can be unavailable */ }
  };
  node._h3SaveBackup = saveBackup;
  const priorSerialize = node.onSerialize;
  node.onSerialize = function (...args) {
    saveBackup();
    return priorSerialize?.apply(this, args);
  };
  const persist = (state) => { manifestWidget.value = JSON.stringify(state); saveBackup(); node.graph?.setDirtyCanvas(true, true); };
  const cardsAtPointer = (event) => Array.from(root.querySelectorAll(".mb-card")).find((card) => {
    const rect = card.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  const pointerIsOverBoard = (event) => {
    const rect = root.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  };
  const clearDropHighlight = () => root.querySelectorAll(".mb-card.drag-over").forEach((card) => card.classList.remove("drag-over"));
  // ComfyUI's canvas can capture a Windows Explorer drop before it reaches a
  // DOM widget. Capturing at document level makes operating-system file drops
  // dependable while still limiting them strictly to this board's screen area.
  const captureDragOver = (event) => {
    if (!hasMediaTransfer(event)) return;
    if (!pointerIsOverBoard(event)) { clearDropHighlight(); return; }
    event.preventDefault();
    const card = cardsAtPointer(event);
    clearDropHighlight();
    if (card && transferCanIncludeKind(event, card._h3MediaKind)) card.classList.add("drag-over");
  };
  const captureDrop = async (event) => {
    if (!hasMediaTransfer(event) || !pointerIsOverBoard(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const card = cardsAtPointer(event);
    clearDropHighlight();
    const files = transferFiles(event);
    if (card && transferCanIncludeKind(event, card._h3MediaKind)) await card._h3ReceiveFiles?.(files);
    else await root._h3AppendFiles?.(files);
  };
  document.addEventListener("dragover", captureDragOver, true);
  document.addEventListener("drop", captureDrop, true);
  const priorRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    document.removeEventListener("dragover", captureDragOver, true);
    document.removeEventListener("drop", captureDrop, true);
    priorRemoved?.apply(this, args);
  };
  const render = () => {
    const state = readManifest(manifestWidget); root.replaceChildren();
    for (const kind of ["image", "audio", "video"]) {
      const title = document.createElement("div"); title.className = "mb-title"; title.textContent = `${LABELS[kind]} · ${LIMITS[kind]}`; root.appendChild(title);
      const row = document.createElement("div");
      // Images are deliberately a 3 × 3 grid. Audio and video stay as three fixed cards in one row.
      row.className = kind === "image" ? "mb-image-grid" : "mb-row";
      for (let index = 0; index < LIMITS[kind]; index++) {
        row.appendChild(makeCard(kind, index, state[kind][index], (uploaded) => {
          compactMedia(state, kind);
          if (uploaded) {
            // A filled card is deliberately replaced. Dropping/uploading into
            // any empty later card appends after the existing consecutive set.
            if (state[kind][index]) state[kind][index] = uploaded;
            else state[kind].push(uploaded);
          } else state[kind].splice(index, 1);
          // There are never blank numbers: every operation compacts the row.
          compactMedia(state, kind);
          persist(state); render();
        }));
      }
      root.appendChild(row);
    }
    // Dropping on the node rather than a specific card fills the next free
    // position for each detected media type.  Pasting behaves the same way.
    const appendFiles = async (files) => {
      let changed = false;
      for (const file of Array.from(files || [])) {
        const kind = kindForFile(file);
        if (!kind) continue;
        compactMedia(state, kind);
        if (state[kind].length >= LIMITS[kind]) continue;
        const uploaded = await uploadFile(kind, file);
        if (uploaded) { state[kind].push(uploaded); changed = true; }
      }
      if (changed) { persist(state); render(); }
    };
    root._h3AppendFiles = appendFiles;
    root.ondragover = (event) => {
      if (hasMediaTransfer(event)) event.preventDefault();
    };
    root.ondrop = async (event) => {
      if (!hasMediaTransfer(event)) return;
      stop(event); await appendFiles(transferFiles(event));
    };
    root.onpaste = async (event) => {
      const files = clipboardFiles(event);
      if (!files.some((file) => kindForFile(file))) return;
      stop(event); await appendFiles(files);
    };
    root.appendChild(makeH3SettingsPanel(settingsWidgets, node));
    root.appendChild(prompt);
  };
  prompt.oninput = () => { promptWidget.value = prompt.value; promptWidget.callback?.(prompt.value); saveBackup(); node.graph?.setDirtyCanvas(true, true); };
  render();
  const minSize = [930, 1070];
  const fixedWidth = minSize[0];
  node.min_width = fixedWidth;
  node.max_width = fixedWidth;
  node.min_height = minSize[1];
  node.min_size = minSize;
  node.max_size = [fixedWidth, Number.MAX_SAFE_INTEGER];
  const priorResize = node.onResize;
  node.onResize = function (size) {
    // ComfyUI has both legacy and Nodes 2.0 resize paths.  Clamping here as
    // well as declaring min_size makes the limit hold in either renderer.
    // The card layout must never stretch horizontally: only node height is resizable.
    size[0] = fixedWidth;
    size[1] = Math.max(minSize[1], size[1]);
    priorResize?.call(this, size);
  };
  const domWidget = node.addDOMWidget("media_board_ui", "H3_MEDIA_BOARD_UI", root, {
    getValue: () => "media-board",
    getMinHeight: () => 1010,
    getHeight: () => Math.max(1010, node.size[1] - 48),
    afterResize: () => { prompt.style.minHeight = "145px"; },
  });
  node.size = [Math.max(minSize[0], node.size[0]), Math.max(minSize[1], node.size[1])];
  node.setSize?.(node.size);
  return domWidget;
}

function decorateUnpacker(node) {
  // Keep this routing node compact by default, but allow a deliberate working
  // range instead of locking it to a single (often overly tall) size.
  const minSize = [250, 382];
  const maxSize = [760, 1040];
  const initialSize = [500, 700];
  node.resizable = true;
  node.min_width = minSize[0]; node.max_width = maxSize[0];
  node.min_height = minSize[1]; node.max_height = maxSize[1];
  node.min_size = minSize; node.max_size = maxSize;
  const resizeBeforeClamp = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.min(maxSize[0], Math.max(minSize[0], size[0]));
    size[1] = Math.min(maxSize[1], Math.max(minSize[1], size[1]));
    resizeBeforeClamp?.call(this, size);
  };
  node.setSize?.(initialSize);
  const refresh = () => {
    const link = node.inputs?.[0]?.link;
    // getInputNode works in both the legacy LiteGraph canvas and Nodes 2.0.
    // The graph.links fallback covers older ComfyUI builds.
    const source = node.getInputNode?.(0)
      || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
    const widget = source?.widgets?.find((w) => w.name === "media_manifest");
    const state = widget ? readManifest(widget) : { image: [], audio: [], video: [] };
    const valueOf = (name, fallback) => source?.widgets?.find((w) => w.name === name)?.value ?? fallback;
    node._h3Settings = h3Settings(
      valueOf("duration", 15), valueOf("aspect_ratio", "9:16"),
      valueOf("megapixels", 0.4), valueOf("multiple", 32),
      valueOf("auto_calculate", true), valueOf("manual_frames", 362),
    );
    node._h3MediaCounts = {
      image: state.image.length,
      audio: state.audio.length,
      video: state.video.length,
    };
    const enabled = [
      ...Array.from({ length: 9 }, (_, i) => Boolean(state.image[i])),
      ...Array.from({ length: 3 }, (_, i) => Boolean(state.video[i])),
      // Every populated video exposes a paired AUDIO port. A video with no
      // embedded soundtrack still returns None at execution time.
      ...Array.from({ length: 3 }, (_, i) => Boolean(state.video[i])),
      ...Array.from({ length: 3 }, (_, i) => Boolean(state.audio[i])),
    ];
    node.outputs?.forEach((out, index) => {
      if (index >= 18) return; // prompt and H3 parameter outputs are always available
      const active = enabled[index];
      out.disabled = !active;
      // Keep the backend's fixed output indexes, but remove unused ports from
      // the canvas. This gives two images = two visible blue image outputs.
      out.hidden = !active;
      out.color = active ? undefined : "#59616a";
      out.color_off = active ? undefined : "#59616a";
    });
    node.graph?.setDirtyCanvas(true, true);
  };
  const prior = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) { prior?.apply(this, args); refresh(); };
  const draw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    draw?.call(this, ctx);
    refresh();
    const counts = node._h3MediaCounts || { image: 0, audio: 0, video: 0 };
    const settings = node._h3Settings || h3Settings(15, "9:16", 0.4, 32);
    // The output pins occupy the right side. A narrow left-side card avoids
    // overlapping their labels on either compact or expanded output nodes.
    const panelWidth = 196;
    const panelHeight = 108;
    // Put the table at the top center. On a deliberately narrow node it stays
    // inside the available left area rather than crossing the output pins.
    const leftAreaRight = Math.max(panelWidth + 18, this.size[0] - 195);
    const preferredX = (this.size[0] - panelWidth) * 0.5;
    const x = Math.max(12, Math.min(preferredX, leftAreaRight - panelWidth));
    const y = 92;
    ctx.save();
    ctx.fillStyle = "#22272d";
    ctx.strokeStyle = "#4a535d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, panelWidth, panelHeight, 7);
    else ctx.rect(x, y, panelWidth, panelHeight);
    ctx.fill(); ctx.stroke();
    const statusSplitX = x + 42;
    const typeSplitX = x + 134;
    const headerHeight = 27;
    const rowHeight = 25;
    ctx.strokeStyle = "#4a535d";
    ctx.beginPath();
    ctx.moveTo(statusSplitX, y); ctx.lineTo(statusSplitX, y + panelHeight);
    ctx.moveTo(typeSplitX, y); ctx.lineTo(typeSplitX, y + panelHeight);
    [headerHeight, headerHeight + rowHeight, headerHeight + rowHeight * 2].forEach((offset) => {
      ctx.moveTo(x, y + offset); ctx.lineTo(x + panelWidth, y + offset);
    });
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "#d0d8df";
    ctx.textAlign = "center";
    ctx.fillText("状态", x + 21, y + 18);
    ctx.fillText("类型", statusSplitX + (typeSplitX - statusSplitX) * 0.5, y + 18);
    ctx.textAlign = "center";
    ctx.fillText("数量", typeSplitX + (x + panelWidth - typeSplitX) * 0.5, y + 18);
    const rows = [
      ["图片", counts.image],
      ["音频", counts.audio],
      ["视频", counts.video],
    ];
    ctx.font = "12px system-ui, sans-serif";
    rows.forEach(([label, value], index) => {
      const rowTop = y + headerHeight + index * rowHeight;
      const rowCenter = rowTop + rowHeight * 0.5;
      const rowTextBaseline = rowCenter + 4;
      const color = value > 0 ? "#69ee7a" : "#8a939d";
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 21, rowCenter, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = "center"; ctx.fillStyle = "#b7c0c8"; ctx.fillText(label, statusSplitX + (typeSplitX - statusSplitX) * 0.5, rowTextBaseline);
      ctx.fillStyle = "#edf2f5"; ctx.fillText(String(value), typeSplitX + (x + panelWidth - typeSplitX) * 0.5, rowTextBaseline);
      ctx.textAlign = "left";
    });
    const settingsY = y + panelHeight + 10;
    const settingsHeight = 108;
    ctx.fillStyle = "#22272d";
    ctx.strokeStyle = "#4a535d";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, settingsY, panelWidth, settingsHeight, 7);
    else ctx.rect(x, settingsY, panelWidth, settingsHeight);
    ctx.fill(); ctx.stroke();
    const settingsSplitX = x + 74;
    ctx.beginPath();
    ctx.moveTo(settingsSplitX, settingsY); ctx.lineTo(settingsSplitX, settingsY + settingsHeight);
    [headerHeight, headerHeight + rowHeight, headerHeight + rowHeight * 2].forEach((offset) => {
      ctx.moveTo(x, settingsY + offset); ctx.lineTo(x + panelWidth, settingsY + offset);
    });
    ctx.stroke();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "#d0d8df";
    ctx.textAlign = "center";
    ctx.fillText("H3 参数", x + (settingsSplitX - x) * 0.5, settingsY + 18);
    ctx.fillText("结果", settingsSplitX + (x + panelWidth - settingsSplitX) * 0.5, settingsY + 18);
    const settingRows = [
      ["时长", `${settings.duration.toFixed(1)} 秒`],
      ["尺寸", `${settings.width} × ${settings.height}`],
      ["帧数", `${settings.frames} · ${settings.autoCalculate ? "自动" : "手动"}`],
    ];
    ctx.font = "12px system-ui, sans-serif";
    settingRows.forEach(([label, value], index) => {
      const baseline = settingsY + headerHeight + index * rowHeight + rowHeight * 0.5 + 4;
      ctx.fillStyle = "#b7c0c8"; ctx.textAlign = "center";
      ctx.fillText(label, x + (settingsSplitX - x) * 0.5, baseline);
      ctx.fillStyle = "#edf2f5";
      ctx.fillText(value, settingsSplitX + (x + panelWidth - settingsSplitX) * 0.5, baseline);
    });
    ctx.restore();
  };
}

app.registerExtension({
  name: "h3.media_board",
  nodeCreated(node) {
    if (node.comfyClass === "H3MediaBoard") createBoard(node);
    if (node.comfyClass === "H3MediaBoardUnpack") decorateUnpacker(node);
  },
});
