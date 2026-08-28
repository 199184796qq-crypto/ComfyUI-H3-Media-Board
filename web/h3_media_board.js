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
    /* Media, H3 settings, Noise and the prompt must all remain inside the node.
       Extra vertical room is intentionally assigned to the prompt textarea. */
    .h3-media-board { display:flex; flex-direction:column; box-sizing:border-box; width:100%; height:100%; min-width:900px; max-width:900px; min-height:1170px; color:#ddd; font:12px system-ui, sans-serif; user-select:none; }
    .h3-media-board .mb-title { margin: 8px 0 5px; color:#c9c9c9; font-weight:700; }
    .h3-media-board .mb-row { display:flex; gap:7px; min-height:78px; }
    .h3-media-board .mb-image-grid { display:grid; grid-template-columns:repeat(3, 294px); gap:7px; }
    .h3-media-board .mb-card { position:relative; box-sizing:border-box; width:294px; flex:0 0 294px; border:1px dashed #687078; border-radius:8px; background:#202428; overflow:hidden; cursor:pointer; }
    .h3-media-board .mb-card.drag-over { border:2px solid #69ee7a; background:#243129; box-shadow:inset 0 0 0 1px #69ee7a66; }
    .h3-media-board .mb-card.uploading { cursor:progress; border-color:#a987ff; }
    .h3-media-board .mb-upload-overlay { position:absolute; z-index:8; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:12px; color:#f3edff; text-align:center; background:#171321e8; cursor:progress; }
    .h3-media-board .mb-upload-title { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; font-size:12px; }
    .h3-media-board .mb-upload-detail { color:#cbbcff; font-size:11px; font-variant-numeric:tabular-nums; }
    .h3-media-board .mb-upload-track { width:min(210px, 88%); height:7px; overflow:hidden; border:1px solid #75619e; border-radius:99px; background:#0f0d16; }
    .h3-media-board .mb-upload-fill { width:var(--upload-progress, 0%); height:100%; border-radius:inherit; background:linear-gradient(90deg,#9c7bff,#d4c2ff); transition:width .16s linear; }
    .h3-media-board .mb-upload-overlay.indeterminate .mb-upload-fill { width:38%; animation:mb-upload-pulse 1s ease-in-out infinite alternate; }
    .h3-media-board .mb-upload-overlay.error { color:#ffc1c8; background:#28171be8; cursor:pointer; }
    .h3-media-board .mb-upload-overlay.error .mb-upload-track { display:none; }
    @keyframes mb-upload-pulse { from { transform:translateX(-55%); } to { transform:translateX(205%); } }
    .h3-mode-control { box-sizing:border-box; display:flex; flex-direction:column; gap:9px; width:100%; height:100%; min-height:108px; padding:11px; color:#e7edf3; background:linear-gradient(145deg,#1d2a32,#151c22); border:1px solid #45616d; border-radius:9px; font:12px system-ui,sans-serif; }
    .h3-mode-control .h3-mode-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
    .h3-mode-control .h3-mode-title { color:#e8f6fb; font-size:13px; font-weight:800; }
    .h3-mode-control .h3-mode-caption { color:#8ca8b4; font-size:10px; white-space:nowrap; }
    .h3-mode-control .h3-mode-options { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .h3-mode-control .h3-mode-option { min-height:46px; padding:7px 8px; border:1px solid #40545e; border-radius:7px; color:#b9c6cc; background:#131a20; text-align:left; cursor:pointer; transition:background .14s,border-color .14s,box-shadow .14s; }
    .h3-mode-control .h3-mode-option:hover { border-color:#75cce4; }
    .h3-mode-control .h3-mode-option:disabled { cursor:default; opacity:.82; }
    .h3-mode-control .h3-mode-option.active { border-color:#65d9e9; color:#ebfbff; background:linear-gradient(135deg,#174e5a,#153740); box-shadow:inset 3px 0 #6be7f0,0 0 0 1px #63dce522; }
    .h3-mode-control .h3-mode-option strong { display:block; font-size:12px; }
    .h3-mode-control .h3-mode-option small { display:block; margin-top:3px; color:#91a7b0; font-size:10px; }
    .h3-mode-control .h3-mode-option.active small { color:#bdeff3; }
    .h3-mode-control .h3-mode-status { padding:5px 7px; border-left:3px solid #69e6ee; border-radius:3px; color:#bfeff2; background:#11252c; font-size:10px; }
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
    /* Keep the seed controls as a compact toolbar.  The panel may be wide,
       but its controls must not stretch simply to fill available space. */
    .h3-media-board .mb-noise { position:relative; display:grid; grid-template-columns:minmax(220px,280px) repeat(3, max-content); justify-content:start; gap:8px; align-items:end; margin:16px 0 2px; padding:27px 12px 11px; border:1px solid #685b91; border-radius:9px; background:linear-gradient(145deg,#282338 0%,#1b1925 100%); box-shadow:inset 0 1px #ffffff08, 0 2px 8px #0004; }
    .h3-media-board .mb-noise-head { position:absolute; top:-11px; left:12px; display:flex; align-items:center; gap:8px; padding:3px 9px; border:1px solid #685b91; border-radius:6px; color:#f0ecff; background:#282338; }
    .h3-media-board .mb-noise-title { color:#c7b2ff; font-size:12px; font-weight:800; letter-spacing:.35px; }
    .h3-media-board .mb-noise-caption { color:#a89eba; font-size:10px; }
    .h3-media-board .mb-noise-after { grid-column:1 / -1; justify-self:start; width:fit-content; display:flex; align-items:center; gap:9px; padding:6px 8px; border:1px solid #51466e; border-radius:6px; background:#171421; }
    .h3-media-board .mb-noise-after label { color:#c0b7d2; font-size:11px; font-weight:800; white-space:nowrap; }
    .h3-media-board .mb-noise-after select { flex:0 1 210px; width:210px; min-width:0; height:27px; padding:3px 7px; color:#f1ebff; background:#252038; border:1px solid #74639e; border-radius:4px; outline:none; font:11px system-ui, sans-serif; }
    .h3-media-board .mb-noise-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
    .h3-media-board .mb-noise-field label { color:#b7aec9; font-size:10px; font-weight:700; }
    .h3-media-board .mb-noise-field input { box-sizing:border-box; width:100%; height:29px; padding:4px 7px; color:#f3efff; background:#14121d; border:1px solid #675b86; border-radius:5px; outline:none; font:12px ui-monospace, Consolas, monospace; }
    .h3-media-board .mb-noise-action { width:132px; height:29px; padding:0 8px; border:1px solid #645588; border-radius:5px; color:#e9e2ff; background:#332b48; cursor:pointer; font:11px system-ui, sans-serif; white-space:nowrap; }
    .h3-media-board .mb-noise-action:hover { border-color:#c7b2ff; background:#443862; }
    .h3-media-board .mb-noise-status { grid-column:1 / -1; justify-self:start; width:fit-content; max-width:100%; padding:6px 8px; border-left:3px solid #b998ff; border-radius:4px; color:#d8ccff; background:#211d30; font-size:11px; }
    .h3-media-board .mb-prompt-shell { position:relative; display:flex; flex:1 1 auto; min-height:145px; margin:9px 0 4px; }
    .h3-media-board .mb-prompt-editor { box-sizing:border-box; width:100%; min-height:145px; padding:8px; overflow:auto; color:#ececec; background:#15181b; border:1px solid #586168; border-radius:6px; outline:none; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; font:12px ui-monospace, Consolas, monospace; }
    .h3-media-board .mb-prompt-editor:focus { border-color:#78d7e3; box-shadow:0 0 0 2px #78d7e322; }
    .h3-media-board .mb-prompt-editor:empty::before { content:attr(data-placeholder); color:#707981; pointer-events:none; }
    .h3-media-board .mb-media-ref { color:#ff626b; font-weight:800; text-shadow:0 0 8px #ff4e5a55; cursor:help; }
    .h3-media-board .mb-dialogue { color:#ffd45d; font-weight:700; text-shadow:0 0 8px #ffcc4550; }
    .h3-media-board .mb-at-symbol { color:#67ee80; font-weight:900; text-shadow:0 0 8px #57e97966; }
    .h3-media-board .mb-mention-menu { position:absolute; z-index:20; width:268px; max-height:156px; overflow:auto; padding:4px; border:1px solid #75454b; border-radius:7px; background:#211a1deF; box-shadow:0 8px 20px #000b; user-select:none; }
    .h3-media-board .mb-mention-option { display:grid; grid-template-columns:36px minmax(0,1fr) auto; align-items:center; gap:7px; width:100%; min-height:38px; padding:4px; border:0; border-radius:5px; color:#e9e1e3; background:transparent; text-align:left; cursor:pointer; font:11px system-ui,sans-serif; }
    .h3-media-board .mb-mention-option:hover, .h3-media-board .mb-mention-option.active { background:#4a2a31; }
    .h3-media-board .mb-mention-thumb { display:grid; place-items:center; width:36px; height:30px; overflow:hidden; border-radius:4px; color:#ffc5c8; background:#30252a; font-size:15px; }
    .h3-media-board .mb-mention-thumb img { width:100%; height:100%; object-fit:cover; }
    .h3-media-board .mb-mention-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .h3-media-board .mb-mention-token { color:#ff8188; font:10px ui-monospace,Consolas,monospace; white-space:nowrap; }
    .h3-media-board .mb-mention-empty { padding:8px; color:#aa9da0; font-size:11px; }
    .mb-reference-preview { position:fixed; z-index:10005; width:270px; overflow:hidden; padding:7px; border:1px solid #94525a; border-radius:8px; color:#f2e8ea; background:#21171beF; box-shadow:0 10px 26px #000c; font:12px system-ui,sans-serif; pointer-events:none; }
    .mb-reference-preview.interactive { pointer-events:auto; border-color:#67ee80; box-shadow:0 10px 26px #000c,0 0 0 2px #67ee8033; }
    .mb-reference-preview[hidden] { display:none; }
    .mb-reference-preview-title { display:block; margin-bottom:5px; overflow:hidden; color:#ffadb2; text-overflow:ellipsis; white-space:nowrap; font-weight:800; }
    .mb-reference-preview img, .mb-reference-preview video { display:block; width:270px; max-height:180px; object-fit:contain; background:#08090a; border-radius:5px; }
    .mb-reference-preview audio { display:block; width:270px; }
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

async function uploadFile(kind, file, onProgress) {
  if (!file || kindForFile(file) !== kind) return null;
  const form = new FormData();
  form.set("kind", kind);
  form.set("file", file);
  return await new Promise((resolve) => {
    const request = new XMLHttpRequest();
    const report = (percent, phase = "上传中") => onProgress?.({ percent, phase });
    request.open("POST", "/h3_media_board/upload", true);
    request.upload.onloadstart = () => report(0);
    request.upload.onprogress = (event) => {
      report(event.lengthComputable && event.total > 0 ? Math.round(event.loaded / event.total * 100) : null);
    };
    // Browser-to-server transfer is done; the server may still be writing or
    // validating a large media file, so keep the progress view visible.
    request.upload.onload = () => report(100, "正在保存文件");
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) return resolve(null);
      try { resolve(JSON.parse(request.responseText)); } catch (_) { resolve(null); }
    };
    request.onerror = request.onabort = request.ontimeout = () => resolve(null);
    try { request.send(form); } catch (_) { resolve(null); }
  });
}

async function chooseFile(kind) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ACCEPTS[kind];
  return await new Promise((resolve) => {
    picker.onchange = () => {
      if (!picker.files?.[0]) return resolve(null);
      resolve(picker.files[0]);
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
  card._h3HasAsset = Boolean(asset);
  let uploading = false;
  const showUpload = (file) => {
    const overlay = document.createElement("div"); overlay.className = "mb-upload-overlay";
    const title = document.createElement("div"); title.className = "mb-upload-title"; title.textContent = file.name || "正在上传媒体";
    const detail = document.createElement("div"); detail.className = "mb-upload-detail";
    const track = document.createElement("div"); track.className = "mb-upload-track";
    const fill = document.createElement("div"); fill.className = "mb-upload-fill"; track.appendChild(fill);
    overlay.append(title, detail, track); card.classList.add("uploading"); card.appendChild(overlay);
    const paint = ({ percent, phase = "上传中" } = {}) => {
      const known = Number.isFinite(percent);
      overlay.classList.toggle("indeterminate", !known);
      fill.style.setProperty("--upload-progress", known ? `${Math.max(0, Math.min(100, percent))}%` : "38%");
      detail.textContent = known ? `${phase} · ${Math.round(percent)}%` : `${phase}…`;
    };
    paint({ percent: 0 });
    return { overlay, paint };
  };
  const runUpload = async (file) => {
    if (uploading || !file) return;
    uploading = true;
    const progress = showUpload(file);
    const uploaded = await uploadFile(kind, file, progress.paint);
    uploading = false;
    if (uploaded) { update(uploaded); return; }
    card.classList.remove("uploading");
    progress.overlay.className = "mb-upload-overlay error";
    progress.overlay.querySelector(".mb-upload-detail").textContent = "上传失败，点击后重试";
    progress.overlay.onclick = (event) => { stop(event); progress.overlay.remove(); };
  };
  const select = async () => { if (uploading) return; const file = await chooseFile(kind); if (file) await runUpload(file); };
  const receiveFiles = async (files) => {
    const file = Array.from(files || []).find((candidate) => kindForFile(candidate) === kind);
    if (!file) return;
    await runUpload(file);
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

function newNoiseSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(2); globalThis.crypto.getRandomValues(values);
    return (values[0] & 0x1fffff) * 4294967296 + values[1];
  }
  return Math.floor(Math.random() * 9007199254740991);
}

function makeNoisePanel(widgets, node) {
  const panel = document.createElement("div"); panel.className = "mb-noise";
  const header = document.createElement("div"); header.className = "mb-noise-head";
  const title = document.createElement("span"); title.className = "mb-noise-title"; title.textContent = "Noise 种子";
  const caption = document.createElement("span"); caption.className = "mb-noise-caption"; caption.textContent = "SamplerCustomAdvanced 可直接连接";
  header.append(title, caption); panel.appendChild(header);
  const seedField = document.createElement("div"); seedField.className = "mb-noise-field";
  const seedLabel = document.createElement("label"); seedLabel.textContent = "固定种子";
  const seedInput = document.createElement("input"); seedInput.type = "number"; seedInput.min = "0"; seedInput.max = "9007199254740991"; seedInput.step = "1"; seedInput.value = String(widgets.noise_seed.value ?? 0);
  seedField.append(seedLabel, seedInput); panel.appendChild(seedField);
  const status = document.createElement("div"); status.className = "mb-noise-status";
  const setWidget = (name, value) => {
    widgets[name].value = value;
    widgets[name].callback?.(value);
    node._h3SaveBackup?.();
    node.graph?.setDirtyCanvas(true, true);
  };
  const afterField = document.createElement("div"); afterField.className = "mb-noise-after";
  const afterLabel = document.createElement("label"); afterLabel.textContent = "生成后控制";
  const afterSelect = document.createElement("select");
  const afterOptions = [["fixed", "保持固定种子"], ["randomize", "随机种子"], ["increment", "种子 +1"], ["decrement", "种子 −1"]];
  afterOptions.forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; afterSelect.appendChild(option); });
  afterSelect.value = widgets.noise_after_generate.value || "randomize";
  afterSelect.onchange = () => { setWidget("noise_after_generate", afterSelect.value); paintStatus(); };
  afterField.append(afterLabel, afterSelect);
  panel.insertBefore(afterField, seedField);
  const paintStatus = () => {
    const mode = widgets.noise_mode.value || "fixed";
    const actual = node._h3EffectiveNoiseSeed;
    const afterLabels = { fixed: "保持固定", randomize: "随机", increment: "+1", decrement: "−1" };
    const after = afterLabels[widgets.noise_after_generate.value] || "随机";
    if (mode === "random_each_queue") status.textContent = actual == null ? `每次排队会生成一个新随机种子；生成后：${after}。` : `本次排队随机种子：${actual}；生成后：${after}。`;
    else if (mode === "reuse_last_queue") status.textContent = actual == null ? `下次排队将复用上次的随机种子；生成后：${after}。` : `正在复用上次排队种子：${actual}；生成后：${after}。`;
    else status.textContent = `固定种子：${widgets.noise_seed.value ?? 0}；生成后：${after}。`;
  };
  seedInput.onchange = () => { setWidget("noise_seed", Math.max(0, Math.min(9007199254740991, Math.round(Number(seedInput.value) || 0)))); seedInput.value = String(widgets.noise_seed.value); setWidget("noise_mode", "fixed"); paintStatus(); };
  const action = (label, onClick) => { const button = document.createElement("button"); button.type = "button"; button.className = "mb-noise-action"; button.textContent = label; button.onclick = onClick; panel.appendChild(button); };
  action("🎲 每次排队随机", () => { setWidget("noise_mode", "random_each_queue"); paintStatus(); });
  action("🎲 新建固定种子", () => { const seed = newNoiseSeed(); setWidget("noise_seed", seed); seedInput.value = String(seed); setWidget("noise_mode", "fixed"); node._h3EffectiveNoiseSeed = seed; paintStatus(); });
  action("♻ 使用上次种子", () => { setWidget("noise_mode", "reuse_last_queue"); paintStatus(); });
  panel.appendChild(status);
  node._h3NoiseSeedInput = seedInput;
  node._h3RefreshNoisePanel = paintStatus;
  paintStatus();
  return panel;
}

// A textarea cannot colour individual references.  This small contenteditable
// editor keeps the workflow value as ordinary plain text while giving existing
// media tags a visual treatment and an @ picker.
function makePromptEditor(promptWidget, node, getState, saveBackup) {
  const shell = document.createElement("div");
  shell.className = "mb-prompt-shell";
  const editor = document.createElement("div");
  editor.className = "mb-prompt-editor";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.dataset.placeholder = "提示词（可直接连接上游文本输入；输入 @ 可引用素材）";
  const menu = document.createElement("div");
  menu.className = "mb-mention-menu";
  menu.hidden = true;
  shell.append(editor, menu);

  const referencePreview = document.createElement("div");
  referencePreview.className = "mb-reference-preview"; referencePreview.hidden = true;
  document.body.appendChild(referencePreview);
  const referenceAsset = (type, index) => {
    const kind = ({ Picture: "image", Audio: "audio", Video: "video" })[type];
    return kind ? { kind, asset: getState()[kind]?.[Number(index) - 1] } : null;
  };
  const placeReferencePreview = (event) => {
    const gap = 14, width = referencePreview.offsetWidth || 284, height = referencePreview.offsetHeight || 120;
    const left = Math.max(6, Math.min(event.clientX + gap, window.innerWidth - width - 6));
    const top = Math.max(6, Math.min(event.clientY + gap, window.innerHeight - height - 6));
    referencePreview.style.left = `${left}px`; referencePreview.style.top = `${top}px`;
  };
  let referenceHideTimer = null;
  let previewCtrlHeld = false;
  const setPreviewInteractive = (active) => {
    previewCtrlHeld = Boolean(active);
    referencePreview.classList.toggle("interactive", previewCtrlHeld);
  };
  const cancelReferencePreviewHide = () => { if (referenceHideTimer) clearTimeout(referenceHideTimer); referenceHideTimer = null; };
  const hideReferencePreview = () => {
    cancelReferencePreviewHide(); referencePreview.hidden = true;
    referencePreview.classList.remove("interactive"); referencePreview.replaceChildren();
  };
  const scheduleReferencePreviewHide = () => {
    cancelReferencePreviewHide();
    referenceHideTimer = setTimeout(() => { if (!referencePreview.matches(":hover")) hideReferencePreview(); }, 180);
  };
  const previewKeyChange = (event) => {
    if (!referencePreview.hidden) setPreviewInteractive(event.ctrlKey);
  };
  document.addEventListener("keydown", previewKeyChange, true);
  document.addEventListener("keyup", previewKeyChange, true);
  referencePreview.onpointerenter = cancelReferencePreviewHide;
  referencePreview.onpointerleave = scheduleReferencePreviewHide;
  const showReferencePreview = (type, index, event) => {
    const reference = referenceAsset(type, index);
    if (!reference?.asset) { hideReferencePreview(); return; }
    cancelReferencePreviewHide(); setPreviewInteractive(event.ctrlKey);
    const title = document.createElement("span"); title.className = "mb-reference-preview-title";
    title.textContent = `<${type} ${index}> · ${reference.asset.name || "已上传素材"}${reference.kind === "image" ? "" : "（按住 Ctrl 可播放）"}`;
    referencePreview.replaceChildren(title);
    if (reference.kind === "image") {
      const image = new Image(); image.src = viewUrl(reference.asset.path); image.alt = title.textContent; referencePreview.appendChild(image);
    } else if (reference.kind === "audio") {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = viewUrl(reference.asset.path); referencePreview.appendChild(audio);
    } else {
      const video = document.createElement("video"); video.controls = true; video.muted = true; video.preload = "metadata"; video.src = viewUrl(reference.asset.path); referencePreview.appendChild(video);
    }
    referencePreview.hidden = false; placeReferencePreview(event);
  };

  let mention = null;
  let activeIndex = 0;
  let menuPointerDown = false;
  menu.addEventListener("pointerdown", () => { menuPointerDown = true; });
  menu.addEventListener("pointerup", () => {
    menuPointerDown = false;
    if (document.activeElement !== editor && !menu.matches(":hover")) hideMenu();
  });
  menu.addEventListener("pointercancel", () => { menuPointerDown = false; });
  // innerText preserves the line breaks users create while writing prompts.
  const currentText = () => editor.innerText || "";
  const saveSelectionOffset = () => {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return currentText().length;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(editor);
    try { range.setEnd(selection.anchorNode, selection.anchorOffset); } catch (_) { return currentText().length; }
    return range.toString().length;
  };
  const rangeAtOffset = (offset) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, Number(offset) || 0);
    let textNode = walker.nextNode();
    while (textNode && remaining > textNode.nodeValue.length) {
      remaining -= textNode.nodeValue.length;
      textNode = walker.nextNode();
    }
    const range = document.createRange();
    if (textNode) range.setStart(textNode, Math.min(remaining, textNode.nodeValue.length));
    else range.selectNodeContents(editor), range.collapse(false);
    range.collapse(true);
    return range;
  };
  const restoreSelectionOffset = (offset) => {
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = rangeAtOffset(offset);
    selection.removeAllRanges(); selection.addRange(range);
  };
  const mediaItems = () => {
    const state = getState();
    const definitions = [
      ["image", "Picture", "图片"], ["audio", "Audio", "音频"], ["video", "Video", "视频"],
    ];
    return definitions.flatMap(([kind, tag, label]) => (state[kind] || []).map((asset, index) => ({
      kind, asset, index: index + 1, label: `${label} ${index + 1}`, token: `<${tag} ${index + 1}>`,
    })));
  };
  const isAvailableReference = (type, index) => {
    const kind = ({ Picture: "image", Audio: "audio", Video: "video" })[type];
    return Boolean(kind && getState()[kind]?.[Number(index) - 1]);
  };
  const dialogueRanges = (value) => {
    const ranges = [];
    const add = (start, end) => { if (end > start) ranges.push([start, end]); };
    // Quotes are the dependable general form.  The labelled-line form also
    // covers prompts written as `对白：...` / `Dialogue: ...` without quotes.
    // H3 prompts commonly wrap spoken dialogue in <d>...</d>.  The tag is
    // case-insensitive, so both <d> and <D> receive the same yellow treatment.
    for (const pattern of [/<d>[^]*?<\/d>/gi, /“[^”]*”/g, /「[^」]*」/g, /『[^』]*』/g, /"[^"\r\n]*"/g]) {
      for (let match = pattern.exec(value); match; match = pattern.exec(value)) add(match.index, match.index + match[0].length);
    }
    // Allow the dialogue label anywhere on a line, not just at the beginning:
    // e.g. `镜头说明。台词：秋天真美。`.
    const labelled = /(?:对白|台词|对话|dialogue|speech)\s*[：:]\s*([^\r\n]+)/gim;
    for (let match = labelled.exec(value); match; match = labelled.exec(value)) {
      const content = match[1] || "";
      add(match.index + match[0].lastIndexOf(content), match.index + match[0].length);
    }
    return ranges.sort((a, b) => a[0] - b[0]).reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range);
      return merged;
    }, []);
  };
  const renderText = (value, caret = null) => {
    hideReferencePreview();
    const fragment = document.createDocumentFragment();
    const matcher = /<(Picture|Audio|Video)\s+([1-9]\d*)>/g;
    const dialogue = dialogueRanges(value);
    const appendPiece = (text, className = "") => {
      for (const part of text.split(/(@)/)) {
        if (!part) continue;
        if (part === "@") {
          const at = document.createElement("span"); at.className = "mb-at-symbol"; at.textContent = part; fragment.appendChild(at);
        } else if (className) {
          const styled = document.createElement("span"); styled.className = className; styled.textContent = part;
          if (className === "mb-dialogue") { styled.style.color = "#ffd45d"; styled.style.fontWeight = "700"; }
          fragment.appendChild(styled);
        } else fragment.appendChild(document.createTextNode(part));
      }
    };
    const appendText = (text, offset) => {
      let position = 0;
      const end = offset + text.length;
      for (const [rangeStart, rangeEnd] of dialogue) {
        const start = Math.max(offset, rangeStart); const finish = Math.min(end, rangeEnd);
        if (finish <= start) continue;
        if (start > offset + position) appendPiece(text.slice(position, start - offset));
        // Inline fallback makes dialogue remain visibly yellow even when a
        // browser keeps an older cached stylesheet during a ComfyUI refresh.
        appendPiece(text.slice(start - offset, finish - offset), "mb-dialogue");
        position = finish - offset;
      }
      if (position < text.length) appendPiece(text.slice(position));
    };
    let cursor = 0;
    for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
      if (match.index > cursor) appendText(value.slice(cursor, match.index), cursor);
      if (isAvailableReference(match[1], match[2])) {
        const referenceType = match[1], referenceIndex = match[2];
        const reference = document.createElement("span");
        reference.className = "mb-media-ref"; reference.textContent = match[0];
        reference.onpointerenter = (event) => showReferencePreview(referenceType, referenceIndex, event);
        reference.onpointermove = placeReferencePreview;
        reference.onpointerleave = scheduleReferencePreviewHide;
        fragment.appendChild(reference);
      } else fragment.appendChild(document.createTextNode(match[0]));
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) appendText(value.slice(cursor), cursor);
    editor.replaceChildren(fragment);
    if (caret != null && document.activeElement === editor) restoreSelectionOffset(caret);
  };
  const hideMenu = () => { menu.hidden = true; mention = null; activeIndex = 0; };
  const drawMenu = () => {
    if (!mention) { hideMenu(); return; }
    const query = mention.query.toLowerCase();
    const options = mediaItems().filter((item) => `${item.label} ${item.token} ${item.asset?.name || ""}`.toLowerCase().includes(query));
    menu.replaceChildren(); menu.hidden = false;
    // Place the picker at the active @ / caret instead of anchoring it to the
    // bottom of a long prompt editor.  Keep it narrow and make the list itself
    // scroll when there are many assets.
    const caretRect = rangeAtOffset(mention.end).getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    // The complete node is CSS-transformed by the canvas zoom.  Rects are in
    // screen pixels, while `left` / `top` are local CSS pixels, so convert
    // between those two coordinate systems before positioning the popup.
    const scaleX = shell.offsetWidth ? shellRect.width / shell.offsetWidth : 1;
    const scaleY = shell.offsetHeight ? shellRect.height / shell.offsetHeight : 1;
    const menuWidth = 278;
    let left = (caretRect.left - shellRect.left) / scaleX;
    let top = (caretRect.bottom - shellRect.top) / scaleY + 4;
    left = Math.max(4, Math.min(left, shell.clientWidth - menuWidth - 4));
    if (caretRect.bottom + 164 * scaleY > window.innerHeight && caretRect.top - 164 * scaleY > 0) top = (caretRect.top - shellRect.top) / scaleY - 164;
    menu.style.left = `${left}px`; menu.style.top = `${Math.max(4, top)}px`;
    if (!options.length) {
      const empty = document.createElement("div"); empty.className = "mb-mention-empty"; empty.textContent = "没有匹配的已上传素材"; menu.appendChild(empty); return;
    }
    activeIndex = Math.min(activeIndex, options.length - 1);
    options.forEach((item, index) => {
      const option = document.createElement("button"); option.type = "button";
      option.className = `mb-mention-option${index === activeIndex ? " active" : ""}`;
      const thumb = document.createElement("span"); thumb.className = "mb-mention-thumb";
      if (item.kind === "image") { const image = new Image(); image.src = viewUrl(item.asset.path); image.alt = item.label; thumb.appendChild(image); }
      else thumb.textContent = item.kind === "audio" ? "♫" : "▶";
      const label = document.createElement("span"); label.className = "mb-mention-label"; label.textContent = item.asset?.name || item.label;
      const token = document.createElement("span"); token.className = "mb-mention-token"; token.textContent = item.token;
      option.append(thumb, label, token);
      option.onmousedown = (event) => { event.preventDefault(); pick(item); };
      menu.appendChild(option);
    });
    mention.options = options;
  };
  const updateMention = () => {
    if (document.activeElement !== editor) { hideMenu(); return; }
    const caret = saveSelectionOffset();
    const before = currentText().slice(0, caret);
    const match = before.match(/@([^\s@<>]*)$/);
    if (!match) { hideMenu(); return; }
    mention = { start: caret - match[0].length, end: caret, query: match[1], options: [] };
    drawMenu();
  };
  const commit = () => {
    const value = currentText();
    promptWidget.value = value;
    promptWidget.callback?.(value);
    saveBackup(); node.graph?.setDirtyCanvas(true, true);
  };
  const pick = (item) => {
    if (!mention) return;
    const value = currentText();
    const next = value.slice(0, mention.start) + item.token + value.slice(mention.end);
    const caret = mention.start + item.token.length;
    hideMenu(); renderText(next, caret); commit(); editor.focus({ preventScroll: true }); restoreSelectionOffset(caret);
  };
  editor.oninput = () => {
    const caret = saveSelectionOffset(); const value = currentText();
    renderText(value, caret); commit(); updateMention();
  };
  editor.onpaste = (event) => {
    const pasted = event.clipboardData?.getData("text/plain");
    if (typeof pasted !== "string" || !pasted) return;
    event.preventDefault(); event.stopPropagation();
    const selection = window.getSelection?.(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    range.deleteContents(); const text = document.createTextNode(pasted); range.insertNode(text);
    range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    editor.oninput();
  };
  editor.onkeydown = (event) => {
    if (menu.hidden || !mention) return;
    const options = mention.options || [];
    if (event.key === "Escape") { event.preventDefault(); hideMenu(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault(); activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length; drawMenu(); return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && options[activeIndex]) { event.preventDefault(); pick(options[activeIndex]); }
  };
  editor.onfocus = () => updateMention();
  // Dragging the menu's own scrollbar can move focus away from the editor.
  // Do not mistake that normal interaction for a request to close the picker.
  editor.onblur = () => setTimeout(() => {
    if (!menuPointerDown && !menu.matches(":hover")) hideMenu();
  }, 150);
  shell.refreshReferences = () => {
    const caret = document.activeElement === editor ? saveSelectionOffset() : null;
    renderText(currentText(), caret); updateMention();
  };
  shell.disposeReferencePreview = () => {
    hideReferencePreview(); referencePreview.remove();
    document.removeEventListener("keydown", previewKeyChange, true);
    document.removeEventListener("keyup", previewKeyChange, true);
  };
  renderText(String(promptWidget.value || ""));
  return shell;
}

function createBoard(node) {
  if (node._h3BoardCreated) return;
  injectStyle();
  const manifestWidget = node.widgets?.find((widget) => widget.name === "media_manifest");
  const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
  const settingsWidgets = Object.fromEntries(["duration", "aspect_ratio", "megapixels", "multiple", "auto_calculate", "manual_frames", "noise_seed", "noise_mode", "noise_after_generate"].map((name) => [name, node.widgets?.find((widget) => widget.name === name)]));
  const retryWhenWidgetsReady = () => {
    const attempts = node._h3BoardInitAttempts || 0;
    if (attempts >= 8 || node._h3BoardInitScheduled) return;
    node._h3BoardInitAttempts = attempts + 1;
    node._h3BoardInitScheduled = true;
    setTimeout(() => { node._h3BoardInitScheduled = false; createBoard(node); }, 80 * (attempts + 1));
  };
  if (!manifestWidget || !promptWidget) { retryWhenWidgetsReady(); return; }
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
  // ComfyUI can add an auxiliary "after generate" widget for seed-like
  // controls. Hide every pre-existing native widget, not only our named
  // fields, so the DOM panels remain the single source of visible controls.
  for (const widget of node.widgets || []) hideNativeWidget(widget);
  // Hiding prompt first keeps an older workflow from drawing its native
  // multiline field over the board while ComfyUI upgrades its widget schema.
  if (Object.values(settingsWidgets).some((widget) => !widget)) { retryWhenWidgetsReady(); return; }
  node._h3BoardCreated = true;

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
  const prompt = makePromptEditor(promptWidget, node, () => readManifest(manifestWidget), saveBackup);
  root.onpointerdown = (event) => { if (!prompt.contains(event.target)) root.focus({ preventScroll: true }); };
  // DOM widgets sit above LiteGraph's canvas, so their children normally eat
  // the wheel event.  Relay it to the real canvas and keep zoom behaviour the
  // same whether the pointer is on a card, the prompt, or a settings control.
  root.addEventListener("wheel", (event) => {
    // The @ picker is deliberately the exception: it has its own fixed-height
    // list, so wheel input over it must scroll its media choices.
    if (event.target.closest?.(".mb-mention-menu")) return;
    const canvasElement = app.canvas?.canvas;
    if (!canvasElement) return;
    event.preventDefault(); event.stopPropagation();
    canvasElement.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true,
      clientX: event.clientX, clientY: event.clientY,
      screenX: event.screenX, screenY: event.screenY,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
      deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
      altKey: event.altKey, metaKey: event.metaKey,
    }));
  }, { passive: false });
  // Middle-button dragging is the canvas pan gesture.  Move DragAndScale
  // directly because synthetic mouse events are ignored by some ComfyUI
  // frontends; use the event relay only as a compatibility fallback.
  let middlePanning = false;
  let panStart = null;
  const dragAndScale = () => {
    const offset = app.canvas?.ds?.offset;
    return offset && Number.isFinite(Number(offset[0])) && Number.isFinite(Number(offset[1])) ? app.canvas.ds : null;
  };
  const relayCanvasMouse = (type, event, buttons) => {
    const canvasElement = app.canvas?.canvas;
    if (!canvasElement) return;
    canvasElement.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, button: type === "mousemove" ? 0 : 1, buttons,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    }));
  };
  const stopMiddlePan = () => {
    middlePanning = false; panStart = null; root.style.cursor = "";
    document.removeEventListener("mousemove", relayMiddleMove, true);
    document.removeEventListener("mouseup", relayMiddleUp, true);
  };
  const relayMiddleMove = (event) => {
    if (!middlePanning || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const ds = dragAndScale();
    if (ds && panStart) {
      ds.offset[0] = panStart.offsetX + event.clientX - panStart.clientX;
      ds.offset[1] = panStart.offsetY + event.clientY - panStart.clientY;
      app.canvas?.setDirty?.(true, true);
      app.canvas?.setDirtyCanvas?.(true, true);
      app.canvas?.draw?.(true, true);
    } else relayCanvasMouse("mousemove", event, 4);
  };
  const relayMiddleUp = (event) => {
    if (!middlePanning || !event.isTrusted) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!dragAndScale()) relayCanvasMouse("mouseup", event, 0);
    stopMiddlePan();
  };
  root.addEventListener("mousedown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault(); event.stopPropagation(); middlePanning = true; root.style.cursor = "grabbing";
    const ds = dragAndScale();
    if (ds) panStart = { clientX: event.clientX, clientY: event.clientY, offsetX: Number(ds.offset[0]), offsetY: Number(ds.offset[1]) };
    else relayCanvasMouse("mousedown", event, 4);
    document.addEventListener("mousemove", relayMiddleMove, true);
    document.addEventListener("mouseup", relayMiddleUp, true);
  }, true);
  node._h3SaveBackup = saveBackup;
  const priorExecuted = node.onExecuted;
  node.onExecuted = function (message, ...args) {
    const result = priorExecuted?.call(this, message, ...args);
    const actualSeed = message?.h3_media_board?.[0]?.settings?.noise?.effective_seed;
    if (Number.isSafeInteger(actualSeed)) {
      this._h3EffectiveNoiseSeed = actualSeed;
      const after = settingsWidgets.noise_after_generate.value || "randomize";
      let nextSeed = actualSeed;
      if (after === "randomize") nextSeed = newNoiseSeed();
      else if (after === "increment") nextSeed = Math.min(9007199254740991, actualSeed + 1);
      else if (after === "decrement") nextSeed = Math.max(0, actualSeed - 1);
      settingsWidgets.noise_seed.value = nextSeed;
      if (this._h3NoiseSeedInput) this._h3NoiseSeedInput.value = String(nextSeed);
      this._h3SaveBackup?.();
      this._h3RefreshNoisePanel?.();
      this.graph?.setDirtyCanvas(true, true);
    }
    return result;
  };
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
    stopMiddlePan();
    prompt.disposeReferencePreview?.();
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
    // position for each detected media type.  Route through that card so its
    // upload progress is visible for drag-and-drop and paste as well.
    const appendFiles = async (files) => {
      for (const file of Array.from(files || [])) {
        const kind = kindForFile(file);
        if (!kind) continue;
        const target = Array.from(root.querySelectorAll(".mb-card"))
          .find((card) => card._h3MediaKind === kind && !card._h3HasAsset && !card.classList.contains("uploading"));
        if (target) await target._h3ReceiveFiles?.([file]);
      }
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
    root.appendChild(makeNoisePanel(settingsWidgets, node));
    prompt.refreshReferences?.();
    root.appendChild(prompt);
  };
  render();
  // The Noise controls added below the H3 settings need real node height;
  // otherwise the flexible prompt editor can paint past the node boundary.
  const minSize = [930, 1220];
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
    getMinHeight: () => 1170,
    getHeight: () => Math.max(1170, node.size[1] - 48),
    afterResize: () => { prompt.querySelector(".mb-prompt-editor").style.minHeight = "145px"; },
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
    const directSource = node.getInputNode?.(0)
      || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
    // ``H3VideoModeControl`` forwards H3_MEDIA_BOARD unchanged.  Follow its
    // media_board input (and any future pass-through nodes) back to the real
    // board so the count panel still reacts after an intermediate node.
    const findOriginalBoard = (start) => {
      const visited = new Set(); let current = start;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.comfyClass === "H3MediaBoard") return current;
        const inputIndex = current.inputs?.findIndex((input) => input.name === "media_board") ?? -1;
        if (inputIndex < 0) return current;
        const inputLink = current.inputs?.[inputIndex]?.link;
        const next = current.getInputNode?.(inputIndex)
          || (inputLink != null ? current.graph?.getNodeById(current.graph.links?.[inputLink]?.origin_id) : null);
        if (!next) return current;
        current = next;
      }
      return start;
    };
    const source = findOriginalBoard(directSource);
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

function decorateVideoModeControl(node) {
  if (node._h3ModeControlCreated) return;
  injectStyle();
  // Existing workflow nodes keep the input-slot list they were created with.
  // Add the new pass-through port explicitly so pre-update controller nodes
  // gain it too, without asking the user to delete and recreate the node.
  if (!node.inputs?.some((input) => input.name === "media_board")) {
    node.addInput?.("media_board", "H3_MEDIA_BOARD");
    node.graph?.setDirtyCanvas(true, true);
  }
  const widget = node.widgets?.find((item) => item.name === "use_image_text");
  if (!widget) {
    const attempts = node._h3ModeControlAttempts || 0;
    if (attempts < 8 && !node._h3ModeControlPending) {
      node._h3ModeControlAttempts = attempts + 1;
      node._h3ModeControlPending = true;
      setTimeout(() => { node._h3ModeControlPending = false; decorateVideoModeControl(node); }, 80 * (attempts + 1));
    }
    return;
  }
  node._h3ModeControlCreated = true;
  // Keep a normal serializable widget for workflow JSON, but render its
  // single Boolean value as two clear H3 video-mode choices.
  widget.hidden = true;
  widget.options = widget.options || {}; widget.options.hidden = true;
  if (widget._state) widget._state.hidden = true;
  widget.serialize = true; widget.serializeValue = () => widget.value;
  if (widget.element) widget.element.style.display = "none";
  widget.computeSize = () => [0, -4]; widget.draw = () => {};

  const root = document.createElement("div"); root.className = "h3-mode-control";
  const head = document.createElement("div"); head.className = "h3-mode-head";
  const title = document.createElement("span"); title.className = "h3-mode-title"; title.textContent = "H3 生视频模式";
  const caption = document.createElement("span"); caption.className = "h3-mode-caption"; caption.textContent = "控制条件 / Latent 切换";
  head.append(title, caption);
  const options = document.createElement("div"); options.className = "h3-mode-options";
  const imageText = document.createElement("button"); imageText.type = "button"; imageText.className = "h3-mode-option";
  imageText.innerHTML = "<strong>图文 / 图生</strong><small>输出图文条件与 Latent</small>";
  const multiReference = document.createElement("button"); multiReference.type = "button"; multiReference.className = "h3-mode-option";
  multiReference.innerHTML = "<strong>多参参考</strong><small>输出多参条件与 Latent</small>";
  options.append(imageText, multiReference);
  const status = document.createElement("div"); status.className = "h3-mode-status";
  const boardSource = () => {
    const index = node.inputs?.findIndex((input) => input.name === "media_board") ?? -1;
    if (index < 0) return null;
    const link = node.inputs?.[index]?.link;
    return node.getInputNode?.(index)
      || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
  };
  const originalBoard = (start) => {
    const visited = new Set(); let current = start;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.comfyClass === "H3MediaBoard") return current;
      const index = current.inputs?.findIndex((input) => input.name === "media_board") ?? -1;
      if (index < 0) return null;
      const link = current.inputs?.[index]?.link;
      current = current.getInputNode?.(index)
        || (link != null ? current.graph?.getNodeById(current.graph.links?.[link]?.origin_id) : null);
    }
    return null;
  };
  const syncAutoMode = () => {
    const board = originalBoard(boardSource());
    const manifestWidget = board?.widgets?.find((item) => item.name === "media_manifest");
    if (!manifestWidget) { node._h3AutoMode = null; return; }
    const media = readManifest(manifestWidget);
    const imageCount = media.image.length, audioCount = media.audio.length, videoCount = media.video.length;
    const useMultiReference = imageCount >= 3 || audioCount > 0 || videoCount > 0;
    const reason = useMultiReference
      ? `检测到图片 ${imageCount} 张、音频 ${audioCount} 个、视频 ${videoCount} 个`
      : `检测到图片 ${imageCount} 张，暂无音频或视频`;
    node._h3AutoMode = { useImageText: !useMultiReference, reason };
    if (Boolean(widget.value) !== !useMultiReference) {
      widget.value = !useMultiReference; widget.callback?.(widget.value);
      node.graph?.setDirtyCanvas(true, true);
    }
  };
  const paint = () => {
    const isImageText = Boolean(widget.value);
    const automatic = node._h3AutoMode;
    imageText.classList.toggle("active", isImageText);
    multiReference.classList.toggle("active", !isImageText);
    imageText.disabled = Boolean(automatic); multiReference.disabled = Boolean(automatic);
    status.textContent = automatic
      ? `自动切换：${automatic.reason} → ${isImageText ? "图文 / 图生" : "多参参考"}`
      : `当前输出：${isImageText ? "图文 / 图生" : "多参参考"} → 接到 H3 条件与 Latent 切换的 external_switch`;
  };
  const choose = (value) => {
    widget.value = value; widget.callback?.(value);
    node.graph?.setDirtyCanvas(true, true); paint();
  };
  imageText.onclick = (event) => { stop(event); choose(true); };
  multiReference.onclick = (event) => { stop(event); choose(false); };
  root.append(head, options, status); root.onpointerdown = (event) => event.stopPropagation();
  // This is a control, not a workspace panel.  Keep it compact and prevent
  // saved workflows or the resize handle from stretching its two-mode layout.
  const fixedSize = [430, 180];
  node.resizable = false;
  node.min_size = fixedSize; node.max_size = fixedSize;
  node.min_width = fixedSize[0]; node.max_width = fixedSize[0];
  node.min_height = fixedSize[1]; node.max_height = fixedSize[1];
  const resizeBeforeLock = node.onResize;
  node.onResize = function (size) {
    size[0] = fixedSize[0]; size[1] = fixedSize[1];
    resizeBeforeLock?.call(this, size);
  };
  node.addDOMWidget("h3_video_mode_ui", "H3_VIDEO_MODE_UI", root, {
    getValue: () => Boolean(widget.value),
    getMinHeight: () => 108,
    getHeight: () => 108,
  });
  node.setSize?.(fixedSize);
  const previousConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) { previousConnections?.apply(this, args); syncAutoMode(); paint(); };
  const previousDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) { previousDraw?.call(this, ctx); syncAutoMode(); paint(); };
  syncAutoMode(); paint();
}

function removeLegacyConditionBoardPort(node) {
  // A short-lived schema mistake added media_board to this routing node.
  // Clean old canvas instances as well as newly loaded workflows; the route
  // node only needs the two CONDITIONING/LATENT pairs and its Boolean control.
  const index = node.inputs?.findIndex((input) => input.name === "media_board") ?? -1;
  if (index >= 0) {
    node.removeInput?.(index);
    node.graph?.setDirtyCanvas(true, true);
  }
}

function decorateConditionLatentSwitch(node) {
  if (node._h3ConditionSwitchDecorated) return;
  removeLegacyConditionBoardPort(node);
  const modeWidget = node.widgets?.find((widget) => widget.name === "use_image_text");
  if (!modeWidget) {
    const attempts = node._h3ConditionSwitchAttempts || 0;
    if (attempts < 8 && !node._h3ConditionSwitchPending) {
      node._h3ConditionSwitchAttempts = attempts + 1;
      node._h3ConditionSwitchPending = true;
      setTimeout(() => { node._h3ConditionSwitchPending = false; decorateConditionLatentSwitch(node); }, 80 * (attempts + 1));
    }
    return;
  }
  node._h3ConditionSwitchDecorated = true;
  const inputSource = (inputIndex) => {
    const link = node.inputs?.[inputIndex]?.link;
    return node.getInputNode?.(inputIndex)
      || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
  };
  const syncExternalMode = () => {
    const externalIndex = node.inputs?.findIndex((input) => input.name === "external_switch") ?? -1;
    const source = externalIndex >= 0 ? inputSource(externalIndex) : null;
    const sourceWidget = source?.comfyClass === "H3VideoModeControl"
      ? source.widgets?.find((widget) => widget.name === "use_image_text")
      : null;
    if (sourceWidget) {
      if (!node._h3ExternalModeActive) node._h3LocalModeBeforeExternal = Boolean(modeWidget.value);
      node._h3ExternalModeActive = true;
      const useImageText = Boolean(sourceWidget.value);
      const nextLabel = `外部控制 · ${useImageText ? "图文 / 图生" : "多参参考"}`;
      const changed = modeWidget.value !== useImageText || modeWidget.label !== nextLabel;
      modeWidget.value = useImageText;
      modeWidget.label = nextLabel;
      if (changed) node.graph?.setDirtyCanvas(true, true);
      return;
    }
    if (node._h3ExternalModeActive) {
      modeWidget.value = node._h3LocalModeBeforeExternal;
      node._h3ExternalModeActive = false;
      node.graph?.setDirtyCanvas(true, true);
    }
    if (modeWidget.label !== undefined) modeWidget.label = undefined;
  };
  const priorConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) { priorConnections?.apply(this, args); syncExternalMode(); };
  const priorDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) { priorDraw?.call(this, ctx); syncExternalMode(); };
  syncExternalMode();
}

app.registerExtension({
  name: "h3.media_board",
  nodeCreated(node) {
    if (node.comfyClass === "H3MediaBoard") createBoard(node);
    if (node.comfyClass === "H3MediaBoardUnpack") decorateUnpacker(node);
    if (node.comfyClass === "H3ConditionLatentSwitch") decorateConditionLatentSwitch(node);
    if (node.comfyClass === "H3VideoModeControl") decorateVideoModeControl(node);
  },
});
