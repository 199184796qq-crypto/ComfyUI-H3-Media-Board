import { app } from "../../scripts/app.js";

const LIMITS = { image: 9, audio: 3, video: 3 };
const DYNAMIC_MEDIA_LIMIT = 64;
const DYNAMIC_MEDIA_COLUMNS = 3;
const LABELS = { image: "参考图片", audio: "参考音频", video: "参考视频" };
const ACCEPTS = { image: "image/*", audio: "audio/*", video: "video/*" };
const TOP_ACTIONS_SETTING = "H3MediaBoard.Toolbar.ShowTopActions";
const TOP_ACTIONS_HIDDEN_CLASS = "h3-media-board-top-actions-hidden";
const TOP_ACTION_BUTTON_CLASS = "h3-media-board-top-action";
const RESTART_RECONNECT_SETTING = "H3MediaBoard.Interface.AutoReloadAfterRestart";
let draggedMediaCard = null;
let restartReconnectTimer = null;
const H3_RATIOS = {
  "1:1": [1, 1], "2:3": [2, 3], "3:2": [3, 2], "3:4": [3, 4],
  "4:3": [4, 3], "9:16": [9, 16], "16:9": [16, 9], "21:9": [21, 9],
};
const H3MB_VARIABLE_SPECS = Object.freeze({
  H3mb_noise: { type: "NOISE", slot: 1 },
  H3mb_upscale_factor: { type: "FLOAT", slot: 2 },
  H3mb_video_name: { type: "STRING", slot: 3 },
  H3mb_scheduler_steps: { type: "INT", slot: 4 },
  H3mb_high_frequency_sigmas: { type: "INT", slot: 5 },
  H3mb_sampler: { type: "SAMPLER", slot: 6 },
});
const H3MB_SOURCE_NODE_PROPERTY = "h3mb_source_node_id";
const H3MB_VALUE_INPUT = "_h3mb_value";

function tagTopToolbarActions() {
  const buttons = [...document.querySelectorAll("button")];
  const isTopBarButton = (button) => button.getBoundingClientRect().top < 160;
  const isTarget = (button) => {
    if (!isTopBarButton(button)) return false;
    const text = [button.textContent, button.title, button.getAttribute("aria-label"), button.innerHTML]
      .filter(Boolean)
      .join(" ");
    return /show image feed|显示图片源|comfy--comfy-c|bookmark|书签/i.test(text);
  };
  buttons.filter(isTarget).forEach((button) => button.classList.add(TOP_ACTION_BUTTON_CLASS));
}

function applyTopToolbarActionsVisibility(value) {
  document.body.classList.toggle(TOP_ACTIONS_HIDDEN_CLASS, !value);
  tagTopToolbarActions();
}

function setupTopToolbarActionsVisibility() {
  if (!document.getElementById("h3-media-board-top-actions-style")) {
    const style = document.createElement("style");
    style.id = "h3-media-board-top-actions-style";
    style.textContent = `
      body.${TOP_ACTIONS_HIDDEN_CLASS} button.${TOP_ACTION_BUTTON_CLASS} {
        display: none !important;
      }
    `;
    document.head.append(style);
  }
  new MutationObserver(tagTopToolbarActions).observe(document.body, { childList: true, subtree: true });
  app.ui.settings.addSetting({
    id: TOP_ACTIONS_SETTING,
    category: ["界面", "工具栏"],
    name: "显示顶部菜单、书签和图片源按钮",
    tooltip: "隐藏左上角菜单、书签和 Show Image Feed 按钮；按 Ctrl+Alt+H 可随时恢复。",
    type: "boolean",
    defaultValue: false,
    onChange: applyTopToolbarActionsVisibility,
  });
  applyTopToolbarActionsVisibility(app.ui.settings.getSettingValue(TOP_ACTIONS_SETTING, false));
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== "h") return;
    event.preventDefault();
    const next = !app.ui.settings.getSettingValue(TOP_ACTIONS_SETTING, false);
    app.ui.settings.setSettingValue?.(TOP_ACTIONS_SETTING, next);
    applyTopToolbarActionsVisibility(next);
  });
}

function setupRestartReconnect() {
  let serverWasUnavailable = false;
  const stop = () => {
    if (restartReconnectTimer) window.clearInterval(restartReconnectTimer);
    restartReconnectTimer = null;
  };
  const checkServer = async () => {
    try {
      const response = await fetch("/system_stats", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (serverWasUnavailable) {
        // The server is back. Reload this same tab so newly installed custom
        // nodes and frontend extensions are registered again as well.
        window.location.reload();
        return;
      }
      serverWasUnavailable = false;
    } catch {
      serverWasUnavailable = true;
    }
  };
  const start = (enabled) => {
    stop();
    serverWasUnavailable = false;
    if (!enabled) return;
    checkServer();
    restartReconnectTimer = window.setInterval(checkServer, 3000);
  };
  app.ui.settings.addSetting({
    id: RESTART_RECONNECT_SETTING,
    category: ["界面", "连接"],
    name: "ComfyUI 重启后自动刷新并重连",
    tooltip: "服务恢复后自动刷新当前网页，不会关闭页面；用于让新增节点和前端功能立即生效。",
    type: "boolean",
    defaultValue: true,
    onChange: start,
  });
  start(app.ui.settings.getSettingValue(RESTART_RECONNECT_SETTING, true));
}

function h3Settings(duration, aspectRatio, megapixels, multiple, secondPassScale = 1, autoCalculate = true, manualFrames = 362, secondPassSizeMode = "倍率放大", secondPassMegapixels = 1) {
  const seconds = Math.min(30, Math.max(4, Number(duration) || 15));
  const mp = Number(Math.min(16, Math.max(0.1, Number(megapixels) || 0.4)).toFixed(1));
  const align = Math.min(128, Math.max(8, Math.round(Number(multiple) || 32)));
  const scaleFactor = Number(Math.min(4, Math.max(1, Number(secondPassScale) || 1)).toFixed(1));
  const [ratioWidth, ratioHeight] = H3_RATIOS[aspectRatio] || H3_RATIOS["9:16"];
  const scale = Math.sqrt(mp * 1024 * 1024 / (ratioWidth * ratioHeight));
  const width = Math.round(ratioWidth * scale / align) * align;
  const height = Math.round(ratioHeight * scale / align) * align;
  const directMegapixels = Number(Math.min(16, Math.max(0.1, Number(secondPassMegapixels) || 1)).toFixed(2));
  const directMode = secondPassSizeMode === "百万原始";
  const directScale = Math.sqrt(directMegapixels * 1024 * 1024 / (ratioWidth * ratioHeight));
  const secondPassWidth = directMode
    ? Math.round(ratioWidth * directScale / align) * align
    : Math.max(align, Math.round(width * scaleFactor / align) * align);
  const secondPassHeight = directMode
    ? Math.round(ratioHeight * directScale / align) * align
    : Math.max(align, Math.round(height * scaleFactor / align) * align);
  const baseFrames = Math.max(5, Math.round(seconds * 24));
  const calculatedFrames = baseFrames + (5 - baseFrames % 17) % 17;
  const automatic = Boolean(autoCalculate);
  return { duration: seconds, aspectRatio, megapixels: mp, multiple: align, secondPassScale: scaleFactor, secondPassSizeMode: directMode ? "百万原始" : "倍率放大", secondPassMegapixels: directMegapixels, secondPassWidth, secondPassHeight, autoCalculate: automatic, manualFrames: Math.max(1, Math.round(Number(manualFrames) || 1)), width, height, frames: automatic ? calculatedFrames : Math.max(1, Math.round(Number(manualFrames) || 1)) };
}

const H3_SECOND_PASS_SIZE_MODE_STORAGE_KEY = "h3_media_board.second_pass_size_mode";
const H3_SECOND_PASS_SIZE_MODES = new Set(["倍率放大", "百万原始"]);

function readRememberedSecondPassSizeMode() {
  try {
    const value = localStorage.getItem(H3_SECOND_PASS_SIZE_MODE_STORAGE_KEY);
    return H3_SECOND_PASS_SIZE_MODES.has(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function rememberSecondPassSizeMode(value) {
  if (!H3_SECOND_PASS_SIZE_MODES.has(value)) return;
  try { localStorage.setItem(H3_SECOND_PASS_SIZE_MODE_STORAGE_KEY, value); } catch (_) { /* storage unavailable */ }
}

function promptH3Overrides(prompt) {
  const text = String(prompt || "").replaceAll("：", ":");
  const result = {};
  for (const ratio of Object.keys(H3_RATIOS).sort((a, b) => b.length - a.length)) {
    const pattern = ratio.replace(":", "\\s*:\\s*");
    if (new RegExp(`(^|[^0-9])${pattern}(?=$|[^0-9])`).test(text)) {
      result.aspect_ratio = ratio;
      break;
    }
  }
  const durationPatterns = [
    /(?:\bduration\b|\b(?:target\s+)?video(?:\s+(?:duration|length))?\b|\blength\b|时长|视频长度)\s*(?:is|为|:)?\s*(\d+(?:\.\d+)?)/i,
    /(?:^|[^\d:])(\d+(?:\.\d+)?)\s*(?:-|–|—)?\s*(?:seconds?|secs?|秒)/i,
  ];
  for (const pattern of durationPatterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const seconds = Number(match[1]);
    // Ignore reference alignment markers such as "0.00 seconds".
    if (seconds < 4) continue;
    result.duration = Math.min(30, Math.max(4, Math.round(seconds * 2) / 2));
    break;
  }
  return result;
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
    return Object.fromEntries(Object.keys(LIMITS).map((kind) => {
      if (!Array.isArray(parsed[kind])) return [kind, []];
      // Image slots 1/2 are H3's first/last frame. Audio slots are independent
      // cues, so both keep their exact positions and may deliberately be empty.
      if (kind === "image" || kind === "audio") return [kind, parsed[kind].slice(0, LIMITS[kind]).map((item) => item || null)];
      return [kind, parsed[kind].filter(Boolean).slice(0, LIMITS[kind])];
    }));
  } catch (_) {
    return { image: [], audio: [], video: [] };
  }
}

function compactMedia(state, kind) {
  if (kind === "image") {
    const images = Array.isArray(state.image) ? state.image.slice(0, LIMITS.image) : [];
    // Keep image_1 in place (it is the optional first frame); compact only
    // image_2 onward so deleting a later reference still renumbers the tail.
    state.image = [images[0] || null, ...images.slice(1).filter(Boolean).slice(0, LIMITS.image - 1)];
    return;
  }
  if (kind === "audio") {
    // Audio is position-based: deleting audio_1 must not turn audio_2 or
    // audio_3 into a different cue. Preserve empty slots exactly as saved.
    state.audio = Array.isArray(state.audio) ? state.audio.slice(0, LIMITS.audio).map((item) => item || null) : [];
    return;
  }
  state[kind] = Array.isArray(state[kind]) ? state[kind].filter(Boolean).slice(0, LIMITS[kind]) : [];
}

const BOARD_SAVE_PROPERTY = "h3_media_board_saved";
const BOARD_VERSIONS_PROPERTY = "h3_media_board_versions";

// `nodeCreated` runs while a saved workflow is still being hydrated in some
// ComfyUI builds.  The board used to render the default empty manifest there,
// and nothing asked it to redraw after LiteGraph restored widget values.  Keep
// a named property copy as an authoritative fallback and refresh the DOM only
// after configuration has completed.
function restoreBoardWorkflowState(node, configured = null) {
  if (!node || node.comfyClass !== "H3MediaBoard") return;
  const saved = configured?.properties?.[BOARD_SAVE_PROPERTY]
    || node.properties?.[BOARD_SAVE_PROPERTY];
  const manifestWidget = node.widgets?.find((widget) => widget.name === "media_manifest");
  const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
  if (saved && typeof saved === "object") {
    if (typeof saved.media_manifest === "string" && manifestWidget) manifestWidget.value = saved.media_manifest;
    if (typeof saved.prompt === "string" && promptWidget) promptWidget.value = saved.prompt;
    for (const [name, value] of Object.entries(saved.settings || {})) {
      const widget = node.widgets?.find((item) => item.name === name);
      if (widget && value !== undefined) widget.value = value;
    }
  }
  node._h3SetPromptText?.(promptWidget?.value || "");
  node._h3RenderBoard?.();
  node.graph?.setDirtyCanvas?.(true, true);
}

function h3mbVariableSpec(node) {
  const name = String(node?.widgets?.find((widget) => widget.name === "variable")?.value || "H3mb_noise");
  return { name, ...(H3MB_VARIABLE_SPECS[name] || H3MB_VARIABLE_SPECS.H3mb_noise) };
}

function h3mbGraphLink(graph, linkId) {
  return graph?.getLink?.(linkId) || graph?.links?.[linkId] || null;
}

function h3mbTypesCompatible(sourceType, targetType) {
  if (!targetType || targetType === "*" || sourceType === "*") return true;
  return String(targetType).split(",").map((item) => item.trim()).includes(sourceType);
}

function activeH3MediaBoards(node) {
  return (node?.graph?._nodes || []).filter((candidate) => {
    if (candidate === node || (candidate.comfyClass !== "H3MediaBoard" && candidate.type !== "H3MediaBoard")) return false;
    // LiteGraph modes 2 and 4 are Never and Bypass. A bypassed media board
    // cannot provide these typed outputs, so never bind a getter to it.
    return ![2, 4].includes(Number(candidate.mode));
  });
}

function resolveH3MediaBoardSource(node) {
  const boards = activeH3MediaBoards(node);
  if (!boards.length) return null;
  node.properties = node.properties || {};
  const savedId = node.properties[H3MB_SOURCE_NODE_PROPERTY];
  const saved = boards.find((board) => String(board.id) === String(savedId));
  if (saved) return saved;

  // A workflow normally contains one board. If there are several, bind to the
  // closest board on the left, falling back to the closest board overall. The
  // chosen id is persisted so moving nodes later does not silently retarget it.
  const getterX = Number(node.pos?.[0]) || 0;
  const preceding = boards.filter((board) => (Number(board.pos?.[0]) || 0) <= getterX);
  const candidates = preceding.length ? preceding : boards;
  const getterY = Number(node.pos?.[1]) || 0;
  const selected = candidates.slice().sort((left, right) => {
    const leftDistance = ((Number(left.pos?.[0]) || 0) - getterX) ** 2
      + ((Number(left.pos?.[1]) || 0) - getterY) ** 2;
    const rightDistance = ((Number(right.pos?.[0]) || 0) - getterX) ** 2
      + ((Number(right.pos?.[1]) || 0) - getterY) ** 2;
    return leftDistance - rightDistance;
  })[0];
  node.properties[H3MB_SOURCE_NODE_PROPERTY] = String(selected.id);
  return selected;
}

function updateH3VariableGet(node) {
  const output = node?.outputs?.[0];
  if (!output) return;
  const spec = h3mbVariableSpec(node);
  const previousType = output.type;
  output.name = spec.name;
  output.localized_name = spec.name;
  output.type = spec.type;

  // Changing the dropdown changes the real data type. Retain valid links and
  // remove incompatible ones instead of leaving a workflow that fails later.
  for (const linkId of [...(output.links || [])]) {
    const link = h3mbGraphLink(node.graph, linkId);
    const target = link ? node.graph?.getNodeById?.(link.target_id) : null;
    const targetType = target?.inputs?.[link?.target_slot]?.type;
    if (!h3mbTypesCompatible(spec.type, targetType)) node.graph?.removeLink?.(linkId);
    else if (link && previousType !== spec.type) link.type = spec.type;
  }
  node.title = "获取 H3mb 内置变量";
  node.graph?.setDirtyCanvas?.(true, true);
}

function decorateH3VariableGet(node) {
  const hiddenInputIndex = node.inputs?.findIndex((input) => input.name === H3MB_VALUE_INPUT) ?? -1;
  if (hiddenInputIndex >= 0) node.removeInput?.(hiddenInputIndex);
  if (node._h3mbVariableGetDecorated) {
    updateH3VariableGet(node);
    return;
  }
  const widget = node.widgets?.find((item) => item.name === "variable");
  if (!widget) return;
  node._h3mbVariableGetDecorated = true;
  const priorCallback = widget.callback;
  widget.callback = function (...args) {
    const result = priorCallback?.apply(this, args);
    updateH3VariableGet(node);
    return result;
  };
  updateH3VariableGet(node);
  const computed = node.computeSize?.() || node.size || [280, 90];
  node.setSize?.([Math.max(280, Number(computed[0]) || 280), Math.max(74, Number(computed[1]) || 90)]);
}

function installH3VariablePromptResolver() {
  if (app._h3mbVariablePromptResolverInstalled) return;
  app._h3mbVariablePromptResolverInstalled = true;
  const originalGraphToPrompt = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function (...args) {
    const prompt = await originalGraphToPrompt(...args);
    const graph = args[0] || app.graph;
    for (const getter of graph?._nodes || []) {
      if (getter.comfyClass !== "H3MediaBoardVariableGet" && getter.type !== "H3MediaBoardVariableGet") continue;
      const getterPrompt = prompt?.output?.[String(getter.id)];
      if (!getterPrompt) continue;
      const source = resolveH3MediaBoardSource(getter);
      if (!source || !prompt.output?.[String(source.id)]) {
        console.warn(`[H3-Media-Board] ${getter.title} #${getter.id} 没有找到可用的 H3 Media Board。`);
        continue;
      }
      const spec = h3mbVariableSpec(getter);
      getterPrompt.inputs = getterPrompt.inputs || {};
      getterPrompt.inputs[H3MB_VALUE_INPUT] = [String(source.id), spec.slot];
    }
    return prompt;
  };
}

function injectStyle() {
  if (document.getElementById("h3-media-board-style")) return;
  const style = document.createElement("style");
  style.id = "h3-media-board-style";
  style.textContent = `
    /* Media, H3 settings, Noise and the prompt must all remain inside the node.
       Extra vertical room is intentionally assigned to the prompt textarea. */
    .h3-media-board { display:flex; flex-direction:column; box-sizing:border-box; width:100%; height:100%; min-width:900px; max-width:900px; min-height:1374px; color:#ddd; font:12px system-ui, sans-serif; user-select:none; }
    .h3-dynamic-media-board { min-width:0; min-height:0; width:auto; height:auto; padding-bottom:8px; }
    .h3-dynamic-media-board .mb-dynamic-grid { display:flex; flex-wrap:wrap; gap:7px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-card { width:145px; flex:0 0 145px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-image { height:72px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-audio { height:60px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-audio-player { position:absolute; z-index:4; left:6px; bottom:3px; display:block; width:18px; height:18px; padding:0; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-audio-play { display:block; width:18px; height:18px; font-size:9px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-audio-player .mb-audio-time, .h3-dynamic-media-board .mb-dynamic-grid .mb-audio-player .mb-audio-seek { display:none; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-audio .mb-name { padding-left:30px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-card.empty { width:144px; min-width:144px; height:52px; min-height:52px; flex-basis:144px; font-size:11px; }
    .h3-dynamic-media-board .mb-dynamic-grid .mb-card.empty .mb-index { top:5px; left:5px; padding:1px 6px; }
    .h3-dynamic-media-board .mb-dynamic-resize { margin-top:11px; padding:8px 0 0; border-top:1px solid #46606b; background:transparent; }
    .h3-dynamic-media-board .mb-dynamic-resize-title { display:flex; align-items:center; width:100%; margin:0 0 7px; padding:0; border:0; color:#d7edf4; background:transparent; font:800 12px system-ui,sans-serif; text-align:left; cursor:pointer; }
    .h3-dynamic-media-board .mb-dynamic-resize-title:hover { color:#eefbff; }
    .h3-dynamic-media-board .mb-dynamic-resize-arrow { margin-right:6px; color:#88a8b3; font-size:11px; }
    .h3-dynamic-media-board .mb-dynamic-resize-hint { margin-left:6px; color:#8ea8b1; font-size:10px; font-weight:400; }
    .h3-dynamic-media-board .mb-dynamic-resize-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
    .h3-dynamic-media-board .mb-dynamic-resize-field { display:flex; flex-direction:column; gap:3px; min-width:0; color:#9fb2ba; font-size:10px; }
    .h3-dynamic-media-board .mb-dynamic-resize-field select, .h3-dynamic-media-board .mb-dynamic-resize-field input { box-sizing:border-box; width:100%; height:25px; padding:3px 5px; border:1px solid #4b626c; border-radius:4px; color:#e4eef2; background:#11191e; font:11px system-ui,sans-serif; }
    .h3-dynamic-media-board .mb-dynamic-resize-field input:disabled, .h3-dynamic-media-board .mb-dynamic-resize-field select:disabled { cursor:not-allowed; opacity:.42; }
    .h3-dynamic-media-board .mb-dynamic-section-title { display:flex; align-items:center; justify-content:space-between; width:fit-content; margin:10px 0 5px; padding:0; border:0; color:#c9c9c9; background:transparent; font:700 12px system-ui,sans-serif; cursor:pointer; }
    .h3-dynamic-media-board .mb-dynamic-section-title:hover { color:#e6f2f4; }
    .h3-dynamic-media-board .mb-dynamic-section-arrow { margin-left:8px; color:#88a8b3; font-size:11px; }
    .h3-dynamic-media-board .mb-title { margin-top:10px; }
    .h3-media-board .mb-title { margin: 8px 0 5px; color:#c9c9c9; font-weight:700; }
    .h3-media-board .mb-row { display:flex; gap:7px; min-height:78px; }
    .h3-media-board .mb-image-grid { display:grid; grid-template-columns:repeat(3, 294px); gap:7px; }
    .h3-media-board .mb-card { position:relative; box-sizing:border-box; width:294px; flex:0 0 294px; border:1px dashed #687078; border-radius:8px; background:#202428; overflow:hidden; cursor:pointer; }.h3-media-board .mb-card.sortable { cursor:grab; }.h3-media-board .mb-card.sortable:active { cursor:grabbing; }.h3-media-board .mb-card.sort-target { border:2px solid #6fdaea; box-shadow:inset 0 0 0 1px #6fdaea99; }
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
    .h3-mode-control { box-sizing:border-box; display:flex; flex-direction:column; gap:9px; width:100%; height:auto; min-height:0; padding:11px; color:#e7edf3; background:linear-gradient(145deg,#1d2a32,#151c22); border:1px solid #45616d; border-radius:9px; font:12px system-ui,sans-serif; }
    .h3-mode-control .h3-mode-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
    .h3-mode-control .h3-mode-title { color:#e8f6fb; font-size:13px; font-weight:800; }
    .h3-mode-control .h3-mode-caption { color:#8ca8b4; font-size:10px; white-space:nowrap; }
    .h3-mode-control .h3-mode-auto { margin-left:auto; padding:2px 7px; border:1px solid #45616d; border-radius:5px; color:#a9c5d0; background:#17242b; cursor:pointer; font:10px system-ui,sans-serif; }
    .h3-mode-control .h3-mode-auto.active, .h3-mode-control .h3-mode-auto:hover { border-color:#69e6ee; color:#e6fbff; background:#1a3b45; }
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
    .h3-media-board .mb-frame-role { position:absolute; z-index:3; top:6px; left:50%; transform:translateX(-50%); padding:2px 8px; border:1px solid #637b85; border-radius:99px; color:#d8f4f7; background:#13232acc; font-size:10px; font-weight:800; white-space:nowrap; }
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
    .h3-media-board .mb-setting { display:grid; grid-template-columns:86px minmax(0,1fr); align-items:center; gap:8px; min-width:0; min-height:32px; padding:3px 4px 3px 8px; border:1px solid #3d4b53; border-radius:7px; color:#bfc8ce; background:linear-gradient(90deg,#1d262c 0%,#151b1f 58%); box-shadow:inset 0 1px #ffffff06; }
    .h3-media-board .mb-setting label { overflow:hidden; color:#c4d0d6; font-size:12px; font-weight:750; letter-spacing:.1px; text-overflow:ellipsis; white-space:nowrap; }
    .h3-media-board .mb-setting input, .h3-media-board .mb-setting select { box-sizing:border-box; min-width:0; width:100%; height:29px; padding:4px 8px; color:#edf2f5; background:#0f1518; border:1px solid #50636d; border-radius:5px; outline:none; font:12px system-ui, sans-serif; }
    .h3-media-board .mb-setting input:focus, .h3-media-board .mb-setting select:focus { border-color:#78d7e3; box-shadow:0 0 0 2px #78d7e322; }
    .h3-media-board .mb-setting.prompt-aspect-locked { border-color:#3c7782; background:linear-gradient(90deg,#173038 0%,#142126 58%); }
    .h3-media-board .mb-setting.prompt-aspect-locked label { color:#83e9f4; }
    .h3-media-board .mb-setting select:disabled { cursor:not-allowed; color:#8eeaf4; border-color:#39727c; background:#102126; opacity:1; }
    .h3-media-board .mb-setting-checkbox { display:flex; align-items:center; justify-content:space-between; padding:3px 11px; height:auto; background:linear-gradient(90deg,#1d2b2d 0%,#151d1f 58%); }
    .h3-media-board .mb-setting-checkbox label { color:#d4e0e3; font-size:12px; }
    .h3-media-board .mb-setting input[type="checkbox"] { width:auto; height:auto; padding:0; accent-color:#69ee7a; transform:scale(1.18); }
    .h3-media-board .mb-setting input:disabled { opacity:.45; cursor:not-allowed; }
    .h3-media-board .mb-setting-output-value { display:flex; align-items:center; min-width:0; height:29px; padding:0 8px; overflow:hidden; border:1px solid #47656e; border-radius:5px; color:#86edf6; background:#102027; font:800 12px ui-monospace,Consolas,monospace; white-space:nowrap; }
    .h3-media-board .mb-output-summary { grid-column:1 / -1; padding:7px 9px; border-left:3px solid #69ee7a; border-radius:4px; color:#76ec87; background:#13271a; font-size:13px; font-weight:800; letter-spacing:.15px; }
    .h3-media-board .mb-scheduler { position:relative; display:grid; grid-template-columns:repeat(3,minmax(180px,1fr)); gap:11px; margin:16px 0 2px; padding:27px 12px 11px; border:1px solid #766645; border-radius:9px; background:linear-gradient(145deg,#2b271d 0%,#1d1a15 100%); box-shadow:inset 0 1px #ffffff08,0 2px 8px #0004; }
    .h3-media-board .mb-scheduler-head { position:absolute; top:-11px; left:12px; display:flex; align-items:center; gap:8px; padding:3px 9px; border:1px solid #766645; border-radius:6px; color:#fff4d7; background:#2b271d; }
    .h3-media-board .mb-scheduler-title { color:#f2cf78; font-size:12px; font-weight:800; letter-spacing:.35px; }
    .h3-media-board .mb-scheduler-caption { color:#b4a584; font-size:10px; }
    .h3-media-board .mb-scheduler-field { display:grid; grid-template-columns:120px minmax(0,1fr); align-items:center; gap:8px; min-width:0; min-height:32px; padding:3px 4px 3px 8px; border:1px solid #5e533b; border-radius:7px; background:linear-gradient(90deg,#272319 0%,#191713 58%); }
    .h3-media-board .mb-scheduler-field label { overflow:hidden; color:#ded1b3; font-size:12px; font-weight:750; text-overflow:ellipsis; white-space:nowrap; }
    .h3-media-board .mb-scheduler-field input, .h3-media-board .mb-scheduler-field select { box-sizing:border-box; min-width:0; width:100%; height:29px; padding:4px 8px; color:#fff7e5; background:#13110e; border:1px solid #786943; border-radius:5px; outline:none; font:12px ui-monospace,Consolas,monospace; }
    .h3-media-board .mb-scheduler-field input:focus, .h3-media-board .mb-scheduler-field select:focus { border-color:#efca70; box-shadow:0 0 0 2px #efca7022; }
    .h3-media-board .mb-versions { margin:4px 0 11px; padding:7px 9px; border:1px solid #4c626a; border-radius:7px; background:#182127; }.h3-media-board .mb-versions-head { display:flex; align-items:center; gap:8px; }.h3-media-board .mb-versions-toggle { padding:0; border:0; color:#d7edf4; background:transparent; cursor:pointer; font:800 12px system-ui,sans-serif; }.h3-media-board .mb-versions-toggle:hover { color:#fff; }.h3-media-board .mb-versions-current { margin-left:auto; color:#8fa9b4; font-size:10px; }.h3-media-board .mb-versions-body { display:flex; flex-wrap:nowrap; align-items:center; gap:7px; margin-top:7px; min-width:0; }.h3-media-board .mb-versions select { flex:0 1 390px; width:390px; min-width:150px; }.h3-media-board .mb-versions select, .h3-media-board .mb-versions button { height:26px; padding:3px 7px; border:1px solid #4b626c; border-radius:4px; color:#e4eef2; background:#11191e; font:11px system-ui,sans-serif; }.h3-media-board .mb-versions button { flex:none; cursor:pointer; }.h3-media-board .mb-versions button:hover { border-color:#72d9e5; background:#1d3a43; }.h3-media-board .mb-versions button:last-child { margin-left:auto; color:#ffc6c8; border-color:#75484e; background:#2c1b20; }.h3-media-board .mb-versions button:last-child:hover { border-color:#ed7b81; color:#fff0f1; background:#47242a; }.h3-media-board .mb-versions button:disabled { cursor:not-allowed; opacity:.45; }
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
    .h3-media-board .mb-prompt-shell { position:relative; display:flex; flex:1 1 auto; flex-direction:column; min-height:145px; margin:9px 0 4px; overflow:hidden; }
    .h3-media-board .mb-prompt-actions { display:flex; align-items:center; justify-content:flex-start; gap:6px; margin:0 2px 6px; }
    .h3-media-board .mb-prompt-help { flex:1 1 auto; min-width:0; overflow:hidden; color:#98bac2; font:10px system-ui,sans-serif; text-overflow:ellipsis; white-space:nowrap; }
    .h3-media-board .mb-prompt-action { height:25px; padding:0 10px; border:1px solid #4c626a; border-radius:5px; color:#dcebf0; background:#1b292f; cursor:pointer; font:700 11px system-ui, sans-serif; transition:background .16s ease,border-color .16s ease,color .16s ease; }
    .h3-media-board .mb-prompt-action:hover { border-color:#78d7e3; color:#f5fcff; background:#25434d; }
    .h3-media-board .mb-prompt-action-clear { color:#ffc6c8; border-color:#734d53; background:#352127; }
    .h3-media-board .mb-prompt-action-clear:hover { border-color:#ef7a80; color:#fff0f1; background:#51282e; }
    .h3-media-board .mb-prompt-editor { box-sizing:border-box; width:100%; flex:1 1 0; min-height:145px; padding:8px; overflow:auto; color:#ececec; background:#15181b; border:1px solid #586168; border-radius:6px; outline:none; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; font:12px ui-monospace, Consolas, monospace; }
    .h3-media-board .mb-prompt-editor:focus { border-color:#78d7e3; box-shadow:0 0 0 2px #78d7e322; }
    .h3-media-board .mb-prompt-editor:empty::before { content:attr(data-placeholder); color:#707981; pointer-events:none; }
    .h3-media-board .mb-height-resize-handle { flex:0 0 18px; display:flex; align-items:center; justify-content:center; margin:5px 0 0; border-top:1px solid #47555c; cursor:ns-resize; touch-action:none; user-select:none; }
    .h3-media-board .mb-height-resize-handle:hover, .h3-media-board .mb-height-resize-handle.dragging { border-top-color:#6de2ed; background:#1b303733; }
    .h3-media-board .mb-height-resize-grip { display:flex; flex-direction:column; gap:2px; width:66px; padding:4px 0; }
    .h3-media-board .mb-height-resize-grip i { display:block; width:100%; height:2px; border-radius:99px; background:#77848a; }
    .h3-media-board .mb-height-resize-handle:hover .mb-height-resize-grip i, .h3-media-board .mb-height-resize-handle.dragging .mb-height-resize-grip i { background:#a5eff5; }
    .h3-media-board .mb-media-ref { color:#ff626b; font-weight:800; text-shadow:0 0 8px #ff4e5a55; cursor:help; }
    .h3-media-board .mb-dialogue { color:#ffd45d; font-weight:700; text-shadow:0 0 8px #ffcc4550; }
    .h3-media-board .mb-aspect-ratio { color:#69e9f5; font-weight:800; text-shadow:0 0 8px #42dbe966; }
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
    .mb-card-image-preview { position:fixed; z-index:10006; display:grid; place-items:center; max-width:372px; max-height:332px; padding:6px; overflow:hidden; border:1px solid #5f7781; border-radius:8px; background:#11161aeF; box-shadow:0 10px 26px #000c; pointer-events:none; }
    .mb-card-image-preview img { display:block; max-width:min(360px,calc(100vw - 32px)); max-height:min(320px,calc(100vh - 32px)); width:auto; height:auto; object-fit:contain; border-radius:4px; }
    .mb-preview { position:fixed; z-index:10000; inset:0; display:grid; place-items:center; background:#000b; } .mb-preview img { max-width:90vw; max-height:90vh; }
  `;
  document.head.appendChild(style);
}

function injectWorkflowSwitchboardStyle() {
  if (document.getElementById("h3-workflow-switchboard-style")) return;
  const style = document.createElement("style");
  style.id = "h3-workflow-switchboard-style";
  style.textContent = `
    .h3-workflow-switchboard { box-sizing:border-box; display:flex; flex-direction:column; gap:8px; width:100%; min-width:390px; padding:10px; color:#e6edf0; font:12px system-ui,sans-serif; user-select:none; }
    .h3-workflow-switchboard .h3-ws-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
    .h3-workflow-switchboard .h3-ws-title { color:#ebf8fb; font-size:14px; font-weight:800; }
    .h3-workflow-switchboard .h3-ws-hint { color:#91a7b0; font-size:10px; white-space:nowrap; }
    .h3-workflow-switchboard .h3-ws-size { width:auto; min-width:66px; height:24px; padding:0 4px; font-size:10px; }
    .h3-workflow-switchboard .h3-ws-add { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:6px; }
    .h3-workflow-switchboard select, .h3-workflow-switchboard button { box-sizing:border-box; height:28px; border:1px solid #4c626a; border-radius:5px; color:#dcebf0; background:#172126; font:11px system-ui,sans-serif; }
    .h3-workflow-switchboard select { min-width:0; padding:0 6px; }
    .h3-workflow-switchboard button { padding:0 8px; cursor:pointer; font-weight:700; }
    .h3-workflow-switchboard button:hover { border-color:#75d7e4; color:#f2fdff; background:#213942; }
    .h3-workflow-switchboard .h3-ws-refresh { color:#b4d5dc; }
    .h3-workflow-switchboard .h3-ws-list { display:flex; flex-direction:column; gap:6px; min-height:36px; }
    .h3-workflow-switchboard .h3-ws-empty { padding:10px; border:1px dashed #4c626a; border-radius:6px; color:#93a0a6; background:#131b20; text-align:center; font-size:11px; }
    .h3-workflow-switchboard .h3-ws-row { display:grid; grid-template-columns:19px minmax(0,1fr) 44px 25px; align-items:center; gap:6px; min-height:36px; padding:4px 5px; border:1px solid #43555e; border-radius:7px; background:linear-gradient(135deg,#1f2b31,#171e23); }
    .h3-workflow-switchboard .h3-ws-row.dragging { opacity:.45; }
    .h3-workflow-switchboard .h3-ws-row.drop-target { border-color:#68e3ef; box-shadow:0 0 0 1px #68e3ef66; }
    .h3-workflow-switchboard .h3-ws-grip { color:#86a4ad; cursor:grab; font-size:15px; line-height:1; text-align:center; touch-action:none; user-select:none; }
    .h3-workflow-switchboard .h3-ws-grip:active { cursor:grabbing; }
    .h3-workflow-switchboard .h3-ws-label { min-width:0; overflow:hidden; color:#e5f0f3; text-overflow:ellipsis; white-space:nowrap; font-weight:700; }
    .h3-workflow-switchboard .h3-ws-label small { margin-left:5px; color:#92abb3; font-weight:400; }
    .h3-workflow-switchboard .h3-ws-toggle { position:relative; width:40px; height:22px; padding:0; border-radius:99px; border-color:#5c666c; background:#596166; }
    .h3-workflow-switchboard .h3-ws-toggle::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#c9d0d2; transition:transform .15s ease; }
    .h3-workflow-switchboard .h3-ws-toggle.enabled { border-color:#46d879; background:#1fdc53; }
    .h3-workflow-switchboard .h3-ws-toggle.enabled::after { transform:translateX(18px); background:#f3fff5; }
    .h3-workflow-switchboard .h3-ws-remove { padding:0; border-color:#754c52; color:#f5b8bd; background:#382126; font-size:17px; line-height:20px; }
    .h3-workflow-switchboard .h3-ws-remove:hover { border-color:#f17e87; color:#fff0f1; background:#51282e; }
    .h3-workflow-switchboard .h3-ws-status { min-height:15px; color:#9db4bc; font-size:10px; }
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

let cardImageHoverPreview = null;
let cardImageHoverEvent = null;

function hideCardImageHoverPreview() {
  cardImageHoverEvent = null;
  cardImageHoverPreview?.remove();
  cardImageHoverPreview = null;
}

function placeCardImageHoverPreview(event) {
  if (!cardImageHoverPreview || !event) return;
  const gap = 14;
  const rect = cardImageHoverPreview.getBoundingClientRect();
  const width = rect.width || 372;
  const height = rect.height || 220;
  const left = Math.max(6, Math.min(event.clientX + gap, window.innerWidth - width - 6));
  const top = Math.max(6, Math.min(event.clientY + gap, window.innerHeight - height - 6));
  cardImageHoverPreview.style.left = `${left}px`;
  cardImageHoverPreview.style.top = `${top}px`;
}

function showCardImageHoverPreview(path, event) {
  hideCardImageHoverPreview();
  cardImageHoverEvent = event;
  const preview = document.createElement("div");
  preview.className = "mb-card-image-preview";
  const image = new Image();
  image.src = viewUrl(path);
  image.onload = () => placeCardImageHoverPreview(cardImageHoverEvent);
  preview.appendChild(image);
  document.body.appendChild(preview);
  cardImageHoverPreview = preview;
  placeCardImageHoverPreview(event);
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

function makeCard(kind, index, asset, update, config = {}) {
  const card = document.createElement("div");
  card.className = `mb-card mb-${kind}${asset ? "" : " empty"}`;
  card.tabIndex = 0;
  const badge = document.createElement("span"); badge.className = "mb-index"; badge.textContent = String(index + 1); card.appendChild(badge);
  const frameRole = config.frameRoles !== false && kind === "image" && index < 2 ? document.createElement("span") : null;
  if (frameRole) { frameRole.className = "mb-frame-role"; frameRole.textContent = index === 0 ? "首帧" : "尾帧"; card.appendChild(frameRole); }
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
    if (config.onReorder && asset && draggedMediaCard?.kind === kind && draggedMediaCard.card !== card) {
      event.preventDefault(); card.classList.add("sort-target"); return;
    }
    if (!acceptsDrop(event)) return;
    event.preventDefault(); dragDepth += 1; card.classList.add("drag-over");
  };
  card.ondragover = (event) => {
    if (config.onReorder && asset && draggedMediaCard?.kind === kind && draggedMediaCard.card !== card) {
      event.preventDefault(); card.classList.add("sort-target"); return;
    }
    if (acceptsDrop(event)) { event.preventDefault(); card.classList.add("drag-over"); }
  };
  card.ondragleave = () => { card.classList.remove("sort-target"); dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; card.classList.remove("drag-over"); } };
  card.ondrop = async (event) => {
    dragDepth = 0; card.classList.remove("drag-over", "sort-target");
    if (config.onReorder && asset && draggedMediaCard?.kind === kind && draggedMediaCard.card !== card) {
      event.preventDefault(); stop(event); config.onReorder?.(draggedMediaCard.index); draggedMediaCard = null; return;
    }
    if (!acceptsDrop(event)) return;
    stop(event); await receiveFiles(transferFiles(event));
  };
  card.onpaste = async (event) => {
    const files = clipboardFiles(event);
    if (!files.some((file) => kindForFile(file) === kind)) return;
    stop(event); await receiveFiles(files);
  };
  if (!asset) { card.textContent = "点击上传文件"; card.prepend(badge); if (frameRole) card.appendChild(frameRole); card.onclick = select; return card; }
  if (config.onReorder) {
    card.draggable = true; card.classList.add("sortable");
    card.ondragstart = (event) => {
      if (event.target.closest("button, input")) { event.preventDefault(); return; }
      draggedMediaCard = { card, kind, index };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "h3-media-reorder");
    };
    card.ondragend = () => { draggedMediaCard = null; card.classList.remove("sort-target"); };
  }
  if (kind === "image") {
    const image = new Image(); image.src = viewUrl(asset.path); card.appendChild(image);
    image.onpointerenter = (event) => showCardImageHoverPreview(asset.path, event);
    image.onpointermove = placeCardImageHoverPreview;
    image.onpointerleave = hideCardImageHoverPreview;
    card.ondblclick = () => openPreview(asset.path);
  }
  if (kind === "audio") card.appendChild(makeAudioPlayer(asset));
  if (kind === "video") card.appendChild(makeVideoPlayer(asset));
  const replace = document.createElement("button"); replace.className = "mb-replace"; replace.textContent = "替换"; replace.onclick = (e) => { stop(e); select(); }; card.appendChild(replace);
  const remove = document.createElement("button"); remove.className = "mb-remove"; remove.textContent = "×"; remove.onclick = (e) => { stop(e); update(null); }; card.appendChild(remove);
  const name = document.createElement("div"); name.className = "mb-name"; name.textContent = asset.name; card.appendChild(name);
  return card;
}

function makeH3SettingsPanel(widgets, node, promptWidget) {
  const panel = document.createElement("div"); panel.className = "mb-settings";
  const header = document.createElement("div"); header.className = "mb-settings-head";
  const title = document.createElement("span"); title.className = "mb-settings-title"; title.textContent = "H3 生成参数";
  const caption = document.createElement("span"); caption.className = "mb-settings-caption"; caption.textContent = "名称 · 时长 · 画幅 · 尺寸 · 帧数";
  header.append(title, caption); panel.appendChild(header);
  // Assigned after the controls are created. Keeping this as a variable lets
  // every calculation-related input use the exact same frame synchronization
  // path, instead of only updating when the checkbox itself is clicked.
  let syncFrameMode = () => {};
  let refreshSecondPassControls = () => {};
  let aspectRatioInput = null;
  const promptAspectRatio = () => promptH3Overrides(promptWidget?.value || "").aspect_ratio || null;
  const effectiveAspectRatio = () => promptAspectRatio() || String(widgets.aspect_ratio.value || "9:16");
  const syncPromptAspectRatio = () => {
    const forcedRatio = promptAspectRatio();
    if (forcedRatio && widgets.aspect_ratio.value !== forcedRatio) {
      widgets.aspect_ratio.value = forcedRatio;
      widgets.aspect_ratio.callback?.(forcedRatio);
    }
    if (!aspectRatioInput) return;
    aspectRatioInput.value = forcedRatio || String(widgets.aspect_ratio.value || "9:16");
    aspectRatioInput.disabled = Boolean(forcedRatio);
    aspectRatioInput.title = forcedRatio
      ? `提示词已指定 ${forcedRatio}，删除提示词中的比例后才能修改。`
      : "在提示词未指定比例时可手动选择。";
    aspectRatioInput.closest(".mb-setting")?.classList.toggle("prompt-aspect-locked", Boolean(forcedRatio));
  };
  const summaryText = () => {
    const settings = h3Settings(
      widgets.duration.value, effectiveAspectRatio(), widgets.megapixels.value, widgets.multiple.value,
      widgets.second_pass_scale.value, widgets.auto_calculate.value, widgets.manual_frames.value,
      widgets.second_pass_size_mode.value, widgets.second_pass_megapixels.value,
    );
    return `H3 输出：${settings.width} × ${settings.height} · ${settings.frames} 帧 · ${settings.autoCalculate ? "自动对齐 · " : "手动设置 · "}24 fps · 放大 ${settings.secondPassWidth} × ${settings.secondPassHeight}`;
  };
  const createControl = (name, label, type, options = {}) => {
    const field = document.createElement("div"); field.className = `mb-setting mb-setting-${type}`;
    const caption = document.createElement("label"); caption.textContent = label;
    const input = type === "select" ? document.createElement("select") : document.createElement("input");
    input.dataset.h3Setting = name;
    const widget = widgets[name];
    if (type === "select") {
      Object.keys(H3_RATIOS).forEach((value) => {
        const option = document.createElement("option"); option.value = value; option.textContent = value; input.appendChild(option);
      });
      input.value = String(widget.value || "9:16");
    } else if (type === "checkbox") {
      input.type = "checkbox";
      input.checked = Boolean(widget.value);
    } else if (type === "text") {
      input.type = "text";
      input.value = String(widget.value ?? options.value ?? "");
    } else {
      input.type = "number";
      Object.entries(options).forEach(([key, value]) => input.setAttribute(key, String(value)));
      const rawValue = Number(widget.value ?? options.value ?? 0);
      input.value = Number.isInteger(options.decimals) && Number.isFinite(rawValue)
        ? rawValue.toFixed(options.decimals)
        : String(widget.value ?? options.value ?? "");
    }
    input.onchange = () => {
      const forcedRatio = name === "aspect_ratio" ? promptAspectRatio() : null;
      if (forcedRatio) {
        input.value = forcedRatio;
        syncPromptAspectRatio();
        return;
      }
      let value = type === "select" || type === "text" ? input.value : type === "checkbox" ? input.checked : Number(input.value);
      if (type === "number" && Number.isInteger(options.decimals) && Number.isFinite(value)) {
        value = Number(value.toFixed(options.decimals));
        input.value = value.toFixed(options.decimals);
      }
      widget.value = value;
      widget.callback?.(value);
      node._h3SaveBackup?.();
      node.graph?.setDirtyCanvas(true, true);
      // When automatic mode is on, manual_frames is also kept current. That
      // makes a later switch to manual mode start from the displayed result,
      // rather than an old value from before the duration was changed.
      if (name !== "manual_frames") syncFrameMode(true);
      // Width/height, megapixels, alignment and the second-pass values all
      // affect the displayed final second-pass resolution.
      refreshSecondPassControls();
      panel.querySelector(".mb-output-summary").textContent = summaryText();
    };
    field.append(caption, input); panel.appendChild(field);
    return input;
  };
  createControl("video_name", "视频名称", "text", { value: "ComfyUI_" });
  createControl("duration", "时长", "number", { min: 4, max: 30, step: 0.5 });
  aspectRatioInput = createControl("aspect_ratio", "宽高比", "select");
  createControl("megapixels", "原始百万像素", "number", { min: 0.1, max: 16, step: 0.1, decimals: 1 });
  createControl("multiple", "倍数", "number", { min: 8, max: 128, step: 4 });
  createControl("auto_calculate", "自动计算帧数", "checkbox");
  const manualInput = createControl("manual_frames", "手动帧数", "number", { min: 1, max: 10000, step: 1 });
  // The value field changes meaning with the compact mode selector. In
  // direct-megapixel mode it is a true second-pass target, independent from
  // the first-pass pixel size; in scale mode it remains fully compatible with
  // the old 2nd-pass multiplier workflow.
  const secondPassValueField = document.createElement("div"); secondPassValueField.className = "mb-setting";
  const secondPassValueLabel = document.createElement("label");
  const secondPassValueInput = document.createElement("input"); secondPassValueInput.type = "number";
  secondPassValueField.append(secondPassValueLabel, secondPassValueInput); panel.appendChild(secondPassValueField);
  const secondPassModeField = document.createElement("div"); secondPassModeField.className = "mb-setting";
  const secondPassModeLabel = document.createElement("label"); secondPassModeLabel.textContent = "放大尺寸方式";
  const secondPassModeInput = document.createElement("select");
  [["倍率放大", "倍率放大"], ["百万原始", "百万原始"]].forEach(([value, text]) => secondPassModeInput.appendChild(new Option(text, value)));
  secondPassModeField.append(secondPassModeLabel, secondPassModeInput); panel.appendChild(secondPassModeField);
  const secondPassOutputField = document.createElement("div"); secondPassOutputField.className = "mb-setting";
  const secondPassOutputLabel = document.createElement("label"); secondPassOutputLabel.textContent = "放大输出尺寸";
  const secondPassOutputValue = document.createElement("div"); secondPassOutputValue.className = "mb-setting-output-value";
  secondPassOutputField.append(secondPassOutputLabel, secondPassOutputValue); panel.appendChild(secondPassOutputField);
  const secondPassSettings = () => h3Settings(
    widgets.duration.value, effectiveAspectRatio(), widgets.megapixels.value, widgets.multiple.value,
    widgets.second_pass_scale.value, widgets.auto_calculate.value, widgets.manual_frames.value,
    widgets.second_pass_size_mode.value, widgets.second_pass_megapixels.value,
  );
  refreshSecondPassControls = () => {
    const directMode = widgets.second_pass_size_mode.value === "百万原始";
    const activeWidget = directMode ? widgets.second_pass_megapixels : widgets.second_pass_scale;
    secondPassValueLabel.textContent = directMode ? "放大百万像素" : "放大倍数";
    secondPassValueInput.min = directMode ? "0.1" : "1";
    secondPassValueInput.max = directMode ? "16" : "4";
    secondPassValueInput.step = directMode ? "0.01" : "0.1";
    secondPassValueInput.value = Number(activeWidget.value || 1).toFixed(directMode ? 2 : 1);
    secondPassModeInput.value = directMode ? "百万原始" : "倍率放大";
    const settings = secondPassSettings();
    secondPassOutputValue.textContent = `${settings.secondPassWidth} × ${settings.secondPassHeight}`;
  };
  const updateSecondPassValue = (commit = false) => {
    const directMode = widgets.second_pass_size_mode.value === "百万原始";
    const activeWidget = directMode ? widgets.second_pass_megapixels : widgets.second_pass_scale;
    const minimum = directMode ? 0.1 : 1;
    const maximum = directMode ? 16 : 4;
    const decimals = directMode ? 2 : 1;
    const typedValue = Number(secondPassValueInput.value);
    if (!Number.isFinite(typedValue)) return;
    const value = Number(Math.min(maximum, Math.max(minimum, typedValue)).toFixed(decimals));
    activeWidget.value = value; activeWidget.callback?.(value);
    // Do not rewrite the text while the user is typing (e.g. the temporary
    // "1." in 1.3). The final change event normalizes it after editing.
    if (commit) secondPassValueInput.value = value.toFixed(decimals);
    node._h3SaveBackup?.(); node.graph?.setDirtyCanvas(true, true);
    const settings = secondPassSettings();
    secondPassOutputValue.textContent = `${settings.secondPassWidth} × ${settings.secondPassHeight}`;
    panel.querySelector(".mb-output-summary").textContent = summaryText();
  };
  secondPassValueInput.oninput = () => updateSecondPassValue(false);
  secondPassValueInput.onchange = () => updateSecondPassValue(true);
  secondPassModeInput.onchange = () => {
    const value = secondPassModeInput.value === "百万原始" ? "百万原始" : "倍率放大";
    widgets.second_pass_size_mode.value = value; widgets.second_pass_size_mode.callback?.(value);
    rememberSecondPassSizeMode(value);
    node._h3SaveBackup?.(); node.graph?.setDirtyCanvas(true, true); refreshSecondPassControls();
    panel.querySelector(".mb-output-summary").textContent = summaryText();
  };
  syncFrameMode = (copyCalculatedFrames = false) => {
    const automatic = Boolean(widgets.auto_calculate.value);
    if (automatic && copyCalculatedFrames) {
      const calculated = h3Settings(
        widgets.duration.value, effectiveAspectRatio(), widgets.megapixels.value,
        widgets.multiple.value, widgets.second_pass_scale.value, true, widgets.manual_frames.value,
      ).frames;
      if (Number(widgets.manual_frames.value) !== calculated) {
        widgets.manual_frames.value = calculated;
        widgets.manual_frames.callback?.(calculated);
        manualInput.value = String(calculated);
        node._h3SaveBackup?.();
        node.graph?.setDirtyCanvas(true, true);
      }
    }
    manualInput.disabled = automatic;
    panel.querySelector(".mb-output-summary").textContent = summaryText();
  };
  const summary = document.createElement("div"); summary.className = "mb-output-summary";
  summary.textContent = summaryText();
  panel.appendChild(summary);
  syncPromptAspectRatio();
  refreshSecondPassControls();
  // Synchronize on first render too, so existing workflows with automatic
  // mode selected are repaired immediately after being opened.
  syncFrameMode(true);
  node._h3RefreshSettingsPanel = () => {
    syncPromptAspectRatio();
    panel.querySelectorAll("[data-h3-setting]").forEach((input) => {
      const widget = widgets[input.dataset.h3Setting];
      if (!widget) return;
      if (input.type === "checkbox") input.checked = Boolean(widget.value);
      else {
        const decimals = input.getAttribute("step") === "0.1" ? 1 : null;
        const value = Number(widget.value ?? "");
        input.value = decimals !== null && Number.isFinite(value) ? value.toFixed(decimals) : String(widget.value ?? "");
      }
    });
    syncPromptAspectRatio();
    refreshSecondPassControls();
    syncFrameMode();
  };
  return panel;
}

function newNoiseSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(2); globalThis.crypto.getRandomValues(values);
    return (values[0] & 0x1fffff) * 4294967296 + values[1];
  }
  return Math.floor(Math.random() * 9007199254740991);
}

function comboWidgetValues(widget) {
  let values = widget?.options?.values;
  try { if (typeof values === "function") values = values(widget); } catch { values = []; }
  return Array.isArray(values) ? [...new Set(values.map(String).filter(Boolean))] : [];
}

function makeSchedulerPanel(widgets, node) {
  const panel = document.createElement("div"); panel.className = "mb-scheduler";
  const header = document.createElement("div"); header.className = "mb-scheduler-head";
  const title = document.createElement("span"); title.className = "mb-scheduler-title"; title.textContent = "调度器组合";
  const caption = document.createElement("span"); caption.className = "mb-scheduler-caption"; caption.textContent = "基础步数 · 高频 Sigmas · K 采样器";
  header.append(title, caption); panel.appendChild(header);
  const addNumber = (name, label, minimum, fallback) => {
    const field = document.createElement("div"); field.className = "mb-scheduler-field";
    const fieldLabel = document.createElement("label"); fieldLabel.textContent = label;
    const input = document.createElement("input"); input.type = "number"; input.min = String(minimum); input.max = "100"; input.step = "1";
    input.value = String(widgets[name].value ?? fallback);
    input.onchange = () => {
      const numeric = Math.round(Number(input.value));
      const value = Number.isFinite(numeric) ? Math.min(100, Math.max(minimum, numeric)) : fallback;
      widgets[name].value = value;
      widgets[name].callback?.(value);
      input.value = String(value);
      node._h3SaveBackup?.();
      node.graph?.setDirtyCanvas(true, true);
    };
    field.append(fieldLabel, input); panel.appendChild(field);
  };
  addNumber("scheduler_steps", "基本调度器步数", 1, 8);
  addNumber("high_sigmas", "高频 Sigmas", 0, 5);
  const samplerField = document.createElement("div"); samplerField.className = "mb-scheduler-field";
  const samplerLabel = document.createElement("label"); samplerLabel.textContent = "K采样器";
  const samplerSelect = document.createElement("select");
  const samplerValues = comboWidgetValues(widgets.sampler_name);
  if (!samplerValues.includes("res_multistep")) samplerValues.unshift("res_multistep");
  samplerValues.forEach((value) => samplerSelect.appendChild(new Option(value, value)));
  samplerSelect.value = samplerValues.includes(String(widgets.sampler_name.value))
    ? String(widgets.sampler_name.value)
    : "res_multistep";
  samplerSelect.onchange = () => {
    widgets.sampler_name.value = samplerSelect.value;
    widgets.sampler_name.callback?.(samplerSelect.value);
    node._h3SaveBackup?.();
    node.graph?.setDirtyCanvas(true, true);
  };
  samplerField.append(samplerLabel, samplerSelect); panel.appendChild(samplerField);
  return panel;
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
function makePromptEditor(promptWidget, node, getState, saveBackup, onPromptChanged = null) {
  const shell = document.createElement("div");
  shell.className = "mb-prompt-shell";
  const actions = document.createElement("div");
  actions.className = "mb-prompt-actions";
  const help = document.createElement("span");
  help.className = "mb-prompt-help";
  help.textContent = "提示词说明：@可以呼出素材，鼠标放在关键词能显示素材，按住 Ctrl 可以点击素材播放素材。提示词优先锁定视频比例";
  const editor = document.createElement("div");
  editor.className = "mb-prompt-editor";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.dataset.placeholder = "提示词（可直接连接上游文本输入；输入 @ 可引用素材）";
  const menu = document.createElement("div");
  menu.className = "mb-mention-menu";
  menu.hidden = true;
  actions.appendChild(help);
  shell.append(actions, editor, menu);

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
  let previewPinned = false;
  const setPreviewInteractive = (active) => {
    referencePreview.classList.toggle("interactive", Boolean(active));
  };
  const cancelReferencePreviewHide = () => { if (referenceHideTimer) clearTimeout(referenceHideTimer); referenceHideTimer = null; };
  const hideReferencePreview = () => {
    cancelReferencePreviewHide(); previewPinned = false; referencePreview.hidden = true;
    referencePreview.classList.remove("interactive"); referencePreview.replaceChildren();
  };
  const scheduleReferencePreviewHide = (delay = previewPinned ? 650 : 180) => {
    cancelReferencePreviewHide();
    referenceHideTimer = setTimeout(() => { if (!referencePreview.matches(":hover")) hideReferencePreview(); }, delay);
  };
  const previewKeyChange = (event) => {
    if (referencePreview.hidden) return;
    // Ctrl pins the hover card and enables its native audio/video controls.
    // Releasing Ctrl must not remove an actively playing media element.
    if (event.type === "keydown" && event.ctrlKey) {
      previewPinned = true;
      cancelReferencePreviewHide();
      setPreviewInteractive(true);
    }
  };
  document.addEventListener("keydown", previewKeyChange, true);
  document.addEventListener("keyup", previewKeyChange, true);
  referencePreview.onpointerenter = cancelReferencePreviewHide;
  referencePreview.onpointerleave = () => { previewPinned = false; scheduleReferencePreviewHide(180); };
  const showReferencePreview = (type, index, event) => {
    const reference = referenceAsset(type, index);
    if (!reference?.asset) { hideReferencePreview(); return; }
    cancelReferencePreviewHide(); previewPinned = Boolean(event.ctrlKey); setPreviewInteractive(previewPinned);
    const title = document.createElement("span"); title.className = "mb-reference-preview-title";
    title.textContent = `<${type} ${index}> · ${reference.asset.name || "已上传素材"}${reference.kind === "image" ? "" : "（按 Ctrl 固定后可播放）"}`;
    referencePreview.replaceChildren(title);
    if (reference.kind === "image") {
      const image = new Image(); image.src = viewUrl(reference.asset.path); image.alt = title.textContent; referencePreview.appendChild(image);
    } else if (reference.kind === "audio") {
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = viewUrl(reference.asset.path); referencePreview.appendChild(audio);
    } else {
      const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.preload = "metadata"; video.src = viewUrl(reference.asset.path); referencePreview.appendChild(video);
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
    return definitions.flatMap(([kind, tag, label]) => (state[kind] || []).flatMap((asset, index) => asset ? [{
      kind, asset, index: index + 1, label: `${label} ${index + 1}`, token: `<${tag} ${index + 1}>`,
    }] : []));
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
  const aspectRatioRanges = (value) => {
    const ranges = [];
    const add = (start, end) => { if (end > start) ranges.push([start, end]); };
    // Keep the cyan text exactly on the ratio that was written, accepting both
    // Chinese and English colons as well as surrounding whitespace.
    for (const ratio of Object.keys(H3_RATIOS).sort((a, b) => b.length - a.length)) {
      const [width, height] = ratio.split(":");
      const pattern = new RegExp(`(^|[^0-9])(${width}\\s*[:：]\\s*${height})(?=$|[^0-9])`, "g");
      for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
        const prefix = match[1]?.length || 0;
        add(match.index + prefix, match.index + prefix + match[2].length);
      }
    }
    return ranges;
  };
  const renderText = (value, caret = null) => {
    hideReferencePreview();
    const fragment = document.createDocumentFragment();
    const matcher = /<(Picture|Audio|Video)\s+([1-9]\d*)>/g;
    const dialogue = dialogueRanges(value);
    const aspectRatios = aspectRatioRanges(value);
    const appendPiece = (text, className = "") => {
      for (const part of text.split(/(@)/)) {
        if (!part) continue;
        if (part === "@") {
          const at = document.createElement("span"); at.className = "mb-at-symbol"; at.textContent = part; fragment.appendChild(at);
        } else if (className) {
          const styled = document.createElement("span"); styled.className = className; styled.textContent = part;
          if (className === "mb-dialogue") { styled.style.color = "#ffd45d"; styled.style.fontWeight = "700"; }
          if (className === "mb-aspect-ratio") { styled.style.color = "#69e9f5"; styled.style.fontWeight = "800"; }
          fragment.appendChild(styled);
        } else fragment.appendChild(document.createTextNode(part));
      }
    };
    const appendText = (text, offset) => {
      const end = offset + text.length;
      const boundaries = new Set([offset, end]);
      for (const [rangeStart, rangeEnd] of [...dialogue, ...aspectRatios]) {
        const start = Math.max(offset, rangeStart); const finish = Math.min(end, rangeEnd);
        if (finish > start) { boundaries.add(start); boundaries.add(finish); }
      }
      const points = [...boundaries].sort((a, b) => a - b);
      for (let index = 0; index < points.length - 1; index++) {
        const start = points[index], finish = points[index + 1];
        const className = aspectRatios.some(([rangeStart, rangeEnd]) => start >= rangeStart && finish <= rangeEnd)
          ? "mb-aspect-ratio"
          : dialogue.some(([rangeStart, rangeEnd]) => start >= rangeStart && finish <= rangeEnd)
            ? "mb-dialogue"
            : "";
        appendPiece(text.slice(start - offset, finish - offset), className);
      }
    };
    let cursor = 0;
    for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
      if (match.index > cursor) appendText(value.slice(cursor, match.index), cursor);
      if (isAvailableReference(match[1], match[2])) {
        const referenceType = match[1], referenceIndex = match[2];
        const reference = document.createElement("span");
        reference.className = "mb-media-ref"; reference.textContent = match[0];
        reference.onpointerenter = (event) => showReferencePreview(referenceType, referenceIndex, event);
        reference.onpointermove = (event) => { if (!previewPinned && !event.ctrlKey) placeReferencePreview(event); };
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
    onPromptChanged?.(value);
    saveBackup(); node.graph?.setDirtyCanvas(true, true);
  };
  const setPromptText = (value, focus = false) => {
    hideMenu();
    renderText(String(value || ""));
    commit();
    if (focus) editor.focus({ preventScroll: true });
  };
  const makeAction = (label, className, onClick) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = `mb-prompt-action ${className}`; button.textContent = label;
    button.onclick = onClick; actions.appendChild(button);
    return button;
  };
  const flashAction = (button, label, delay = 1200) => {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original; button.textContent = label;
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, delay);
  };
  makeAction("复制", "mb-prompt-action-copy", async (event) => {
    stop(event);
    const value = currentText();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard write unavailable");
      await navigator.clipboard.writeText(value);
      flashAction(event.currentTarget, "已复制");
    } catch (_) {
      const fallback = document.createElement("textarea"); fallback.value = value; fallback.style.position = "fixed"; fallback.style.opacity = "0";
      document.body.appendChild(fallback); fallback.select();
      const copied = document.execCommand?.("copy"); fallback.remove();
      flashAction(event.currentTarget, copied ? "已复制" : "复制失败");
    }
  });
  makeAction("粘贴", "mb-prompt-action-paste", async (event) => {
    stop(event);
    // Paste is an overwrite action for the prompt editor. Clear first so the
    // clipboard-permission fallback (Ctrl+V) also starts from an empty prompt.
    setPromptText("", true);
    try {
      const value = await navigator.clipboard?.readText();
      if (typeof value !== "string") throw new Error("clipboard text unavailable");
      setPromptText(value, true); flashAction(event.currentTarget, "已粘贴");
    } catch (_) {
      flashAction(event.currentTarget, "请 Ctrl+V", 1600); editor.focus({ preventScroll: true });
    }
  });
  makeAction("清除", "mb-prompt-action-clear", (event) => {
    stop(event); setPromptText("", true); flashAction(event.currentTarget, "已清除");
  });
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
  shell.setText = (value) => {
    renderText(String(value || ""));
    updateMention();
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
  // Workflows saved before the second-pass scale existed have only the first
  // two ports. Append the new FLOAT port without changing either old index.
  const legacyScaleOutput = node.outputs?.find((output) => output.name === "2采放大倍数");
  if (legacyScaleOutput) {
    legacyScaleOutput.name = "放大倍数";
    legacyScaleOutput.label = "放大倍数";
  }
  if (!node.outputs?.some((output) => output.name === "放大倍数")) {
    node.addOutput?.("放大倍数", "FLOAT");
    node.graph?.setDirtyCanvas?.(true, true);
  }
  if (!node.outputs?.some((output) => output.name === "调度器步数")) {
    node.addOutput?.("调度器步数", "INT");
    node.graph?.setDirtyCanvas?.(true, true);
  }
  if (!node.outputs?.some((output) => output.name === "高频Sigmas")) {
    node.addOutput?.("高频Sigmas", "INT");
    node.graph?.setDirtyCanvas?.(true, true);
  }
  if (!node.outputs?.some((output) => output.name === "K采样器")) {
    node.addOutput?.("K采样器", "SAMPLER");
    node.graph?.setDirtyCanvas?.(true, true);
  }
  const manifestWidget = node.widgets?.find((widget) => widget.name === "media_manifest");
  const promptWidget = node.widgets?.find((widget) => widget.name === "prompt");
  const settingsWidgets = Object.fromEntries(["video_name", "duration", "aspect_ratio", "megapixels", "multiple", "scheduler_steps", "high_sigmas", "sampler_name", "second_pass_scale", "second_pass_size_mode", "second_pass_megapixels", "auto_calculate", "manual_frames", "noise_seed", "noise_mode", "noise_after_generate"].map((name) => [name, node.widgets?.find((widget) => widget.name === name)]));
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
  const persisted = node.properties?.[BOARD_SAVE_PROPERTY] || sessionSaved;
  if (persisted && typeof persisted === "object") {
    if (typeof persisted.media_manifest === "string") manifestWidget.value = persisted.media_manifest;
    if (typeof persisted.prompt === "string") promptWidget.value = persisted.prompt;
    for (const [name, widget] of Object.entries(settingsWidgets)) {
      if (persisted.settings?.[name] !== undefined) widget.value = persisted.settings[name];
    }
  } else {
    // A fresh board follows the last choice made in this browser. Workflow
    // snapshots still win, so reopening an existing workflow remains exact.
    const rememberedMode = readRememberedSecondPassSizeMode();
    if (rememberedMode) settingsWidgets.second_pass_size_mode.value = rememberedMode;
  }
  // A short-lived schema put the second-pass scale in the middle of the
  // serialized widget list. Repair only impossible values it may have left in
  // a browser-session backup; valid user settings are never changed here.
  const repairLegacySettings = () => {
    const validModes = new Set(["fixed", "random_each_queue", "reuse_last_queue"]);
    const validAfterGenerate = new Set(["fixed", "randomize", "increment", "decrement"]);
    const seed = Number(settingsWidgets.noise_seed.value);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 9007199254740991) settingsWidgets.noise_seed.value = 0;
    if (!validModes.has(settingsWidgets.noise_mode.value)) settingsWidgets.noise_mode.value = "fixed";
    if (!validAfterGenerate.has(settingsWidgets.noise_after_generate.value)) settingsWidgets.noise_after_generate.value = "randomize";
    const frames = Number(settingsWidgets.manual_frames.value);
    if (!Number.isFinite(frames) || frames < 1 || frames > 10000) settingsWidgets.manual_frames.value = 362;
    const scale = Number(settingsWidgets.second_pass_scale.value);
    if (!Number.isFinite(scale) || scale < 1 || scale > 4) settingsWidgets.second_pass_scale.value = 1.0;
    if (settingsWidgets.second_pass_size_mode.value !== "百万原始") settingsWidgets.second_pass_size_mode.value = "倍率放大";
    const secondMegapixels = Number(settingsWidgets.second_pass_megapixels.value);
    if (!Number.isFinite(secondMegapixels) || secondMegapixels < 0.1 || secondMegapixels > 16) settingsWidgets.second_pass_megapixels.value = 1.0;
    if (typeof settingsWidgets.video_name.value !== "string" || !settingsWidgets.video_name.value.trim()) settingsWidgets.video_name.value = "ComfyUI_";
    const schedulerSteps = Math.round(Number(settingsWidgets.scheduler_steps.value));
    settingsWidgets.scheduler_steps.value = Number.isFinite(schedulerSteps) && schedulerSteps >= 1 && schedulerSteps <= 100
      ? schedulerSteps
      : 8;
    const highSigmas = Math.round(Number(settingsWidgets.high_sigmas.value));
    settingsWidgets.high_sigmas.value = Number.isFinite(highSigmas) && highSigmas >= 0 && highSigmas <= 100
      ? highSigmas
      : 5;
    const samplerValues = comboWidgetValues(settingsWidgets.sampler_name);
    if (!samplerValues.includes(String(settingsWidgets.sampler_name.value))) settingsWidgets.sampler_name.value = "res_multistep";
  };
  repairLegacySettings();

  const root = document.createElement("div"); root.className = "h3-media-board"; root.tabIndex = 0;
  const minSize = [930, 1514];
  const fixedWidth = minSize[0];
  const cloneSnapshot = (value) => JSON.parse(JSON.stringify(value));
  const snapshot = () => ({
    media_manifest: manifestWidget.value || "{}",
    prompt: promptWidget.value || "",
    settings: Object.fromEntries(Object.entries(settingsWidgets).map(([name, widget]) => [name, widget.value])),
  });
  const readVersions = () => {
    const stored = node.properties?.[BOARD_VERSIONS_PROPERTY] || {};
    return {
      collapsed: stored.collapsed !== false,
      current: stored.current || null,
      entries: Array.isArray(stored.entries) ? stored.entries.filter((entry) => entry?.id && entry?.snapshot).slice(0, 20) : [],
    };
  };
  const saveVersions = (versions) => {
    node.properties = node.properties || {};
    node.properties[BOARD_VERSIONS_PROPERTY] = versions;
  };
  const saveBackup = () => {
    const backup = snapshot();
    node.properties = node.properties || {};
    node.properties[BOARD_SAVE_PROPERTY] = backup;
    const versions = readVersions();
    versions.current = { saved_at: Date.now(), snapshot: cloneSnapshot(backup) };
    saveVersions(versions);
    try { sessionStorage.setItem(sessionKey, JSON.stringify(backup)); } catch (_) { /* storage can be unavailable */ }
  };
  const applyPromptOverrides = (value) => {
    const overrides = promptH3Overrides(value);
    for (const [name, setting] of Object.entries(overrides)) {
      const widget = settingsWidgets[name];
      if (!widget || widget.value === setting) continue;
      widget.value = setting;
      widget.callback?.(setting);
    }
    node._h3RefreshSettingsPanel?.();
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const prompt = makePromptEditor(promptWidget, node, () => readManifest(manifestWidget), saveBackup, applyPromptOverrides);
  applyPromptOverrides(String(promptWidget.value || ""));
  root.onpointerdown = (event) => { if (!prompt.contains(event.target)) root.focus({ preventScroll: true }); };
  // DOM widgets sit above LiteGraph's canvas, so their children normally eat
  // the wheel event. Ctrl+wheel inside the prompt is reserved for reading its
  // long text; every other wheel gesture continues to control the canvas.
  root.addEventListener("wheel", (event) => {
    // The @ picker is deliberately the exception: it has its own fixed-height
    // list, so wheel input over it must scroll its media choices.
    if (event.target.closest?.(".mb-mention-menu")) return;
    const promptEditor = event.target.closest?.(".mb-prompt-editor");
    if (event.ctrlKey && promptEditor) {
      event.preventDefault(); event.stopPropagation();
      const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? promptEditor.clientHeight : 1;
      promptEditor.scrollTop += event.deltaY * unit;
      return;
    }
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
    const serialized = args[0];
    if (serialized && typeof serialized === "object") {
      serialized.properties = serialized.properties || {};
      serialized.properties[BOARD_SAVE_PROPERTY] = node.properties?.[BOARD_SAVE_PROPERTY];
      serialized.properties[BOARD_VERSIONS_PROPERTY] = node.properties?.[BOARD_VERSIONS_PROPERTY];
    }
    return priorSerialize?.apply(this, args);
  };
  const persist = (state) => {
    manifestWidget.value = JSON.stringify(state); saveBackup();
    for (const listener of node._h3MediaListeners || []) listener(state);
    node.graph?.setDirtyCanvas(true, true);
  };
  const cardsAtPointer = (event) => Array.from(root.querySelectorAll(".mb-card")).find((card) => {
    const rect = card.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  });
  const mediaKindAtPointer = (event) => {
    const card = cardsAtPointer(event);
    if (card) return card._h3MediaKind;
    const row = Array.from(root.querySelectorAll("[data-h3-media-kind]")).find((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    return row?.dataset.h3MediaKind || null;
  };
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
    const zoneKind = mediaKindAtPointer(event);
    clearDropHighlight();
    const files = transferFiles(event);
    if (card && transferCanIncludeKind(event, card._h3MediaKind)) await card._h3ReceiveFiles?.(files);
    // Each media zone owns only its own file type.  A cross-zone drop is
    // deliberately consumed here instead of being re-routed elsewhere.
    else if (zoneKind) await root._h3AppendFiles?.(files, zoneKind);
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
  const versionTime = (timestamp) => new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
  const applyVersion = (version) => {
    const saved = version?.snapshot;
    if (!saved) return;
    manifestWidget.value = typeof saved.media_manifest === "string" ? saved.media_manifest : "{}";
    for (const [name, value] of Object.entries(saved.settings || {})) {
      if (settingsWidgets[name] && value !== undefined) settingsWidgets[name].value = value;
    }
    const promptValue = String(saved.prompt || "");
    promptWidget.value = promptValue; promptWidget.callback?.(promptValue);
    prompt.setText?.(promptValue);
    saveBackup(); render(); node.graph?.setDirtyCanvas(true, true);
  };
  const appendVersionManager = () => {
    const versions = readVersions();
    const panel = document.createElement("div"); panel.className = "mb-versions";
    const head = document.createElement("div"); head.className = "mb-versions-head";
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "mb-versions-toggle";
    toggle.textContent = `${versions.collapsed ? "▸" : "▾"} 版本管理`;
    const current = document.createElement("span"); current.className = "mb-versions-current";
    current.textContent = versions.current ? `当前状态 · ${versionTime(versions.current.saved_at)}` : "当前状态";
    toggle.onclick = (event) => {
      stop(event); versions.collapsed = !versions.collapsed; saveVersions(versions); render();
    };
    head.append(toggle, current); panel.appendChild(head);
    if (!versions.collapsed) {
      const body = document.createElement("div"); body.className = "mb-versions-body";
      const select = document.createElement("select");
      const currentOption = document.createElement("option"); currentOption.value = "current"; currentOption.textContent = "当前最新状态（系统自动保留）"; select.appendChild(currentOption);
      versions.entries.forEach((entry) => {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = `手动版本 · ${versionTime(entry.saved_at)}`; select.appendChild(option);
      });
      select.value = node._h3VersionSelection || "current";
      select.onchange = () => {
        node._h3VersionSelection = select.value;
        load.disabled = !select.value;
        remove.disabled = select.value === "current";
      };
      const load = document.createElement("button"); load.type = "button"; load.textContent = "加载版本";
      load.disabled = !select.value;
      load.onclick = (event) => {
        stop(event);
        const selected = select.value === "current" ? versions.current : versions.entries.find((entry) => entry.id === select.value);
        applyVersion(selected);
      };
      const add = document.createElement("button"); add.type = "button"; add.textContent = "保存版本";
      add.onclick = (event) => {
        stop(event);
        const entry = { id: `manual-${Date.now()}`, saved_at: Date.now(), snapshot: cloneSnapshot(snapshot()) };
        versions.entries.unshift(entry); versions.entries = versions.entries.slice(0, 20);
        saveVersions(versions); node._h3VersionSelection = entry.id; saveBackup(); render();
      };
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除";
      remove.disabled = select.value === "current";
      remove.onclick = (event) => {
        stop(event); const selected = node._h3VersionSelection || "current";
        if (selected === "current") return;
        versions.entries = versions.entries.filter((entry) => entry.id !== selected);
        node._h3VersionSelection = "current"; saveVersions(versions); render();
      };
      body.append(select, load, add, remove); panel.appendChild(body);
    }
    root.appendChild(panel);
  };
  const render = () => {
    const state = readManifest(manifestWidget); root.replaceChildren();
    appendVersionManager();
    for (const kind of ["image", "audio", "video"]) {
      const title = document.createElement("div"); title.className = "mb-title"; title.textContent = `${LABELS[kind]} · ${LIMITS[kind]}`; root.appendChild(title);
      const row = document.createElement("div");
      // Images are deliberately a 3 × 3 grid. Audio and video stay as three fixed cards in one row.
      row.className = kind === "image" ? "mb-image-grid" : "mb-row";
      row.dataset.h3MediaKind = kind;
      for (let index = 0; index < LIMITS[kind]; index++) {
        row.appendChild(makeCard(kind, index, state[kind][index], (uploaded) => {
          compactMedia(state, kind);
          if (kind === "image") {
            if (uploaded) state.image[index] = uploaded;
            // Slot 1 is allowed to remain blank.  For slot 2 onward splice
            // pulls the following images up, preserving a continuous tail.
            else if (index === 0) state.image[0] = null;
            else state.image.splice(index, 1);
          } else if (kind === "audio") {
            // Unlike images and videos, audio cues are independent slots. A
            // user can leave #1/#2 empty and use #3 directly; deletion keeps
            // the remaining cue numbers unchanged.
            state.audio[index] = uploaded || null;
          } else if (uploaded) {
            // A filled card is deliberately replaced. Dropping/uploading into
            // any empty later card appends after the existing consecutive set.
            if (state[kind][index]) state[kind][index] = uploaded;
            else state[kind].push(uploaded);
          } else state[kind].splice(index, 1);
          // Images preserve the intentional first-frame gap and audio keeps
          // all three independent cue positions; video remains consecutive.
          compactMedia(state, kind);
          persist(state); render();
        }, {
          onReorder: (fromIndex) => {
            if (fromIndex === index || !state[kind][fromIndex] || !state[kind][index]) return;
            [state[kind][fromIndex], state[kind][index]] = [state[kind][index], state[kind][fromIndex]];
            persist(state); render();
          },
        }));
      }
      root.appendChild(row);
    }
    // Dropping on the node rather than a specific card fills the next free
    // position for each detected media type.  Route through that card so its
    // upload progress is visible for drag-and-drop and paste as well.
    const appendFiles = async (files, onlyKind = null) => {
      for (const file of Array.from(files || [])) {
        const kind = kindForFile(file);
        if (!kind || (onlyKind && kind !== onlyKind)) continue;
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
      stop(event); await appendFiles(transferFiles(event), mediaKindAtPointer(event));
    };
    root.onpaste = async (event) => {
      const files = clipboardFiles(event);
      if (!files.some((file) => kindForFile(file))) return;
      stop(event); await appendFiles(files);
    };
    root.appendChild(makeH3SettingsPanel(settingsWidgets, node, promptWidget));
    root.appendChild(makeSchedulerPanel(settingsWidgets, node));
    root.appendChild(makeNoisePanel(settingsWidgets, node));
    prompt.refreshReferences?.();
    root.appendChild(prompt);
    root.appendChild(makeHeightResizeHandle());
  };
  node._h3RenderBoard = render;
  node._h3SetPromptText = (value) => {
    prompt.setText?.(value);
    applyPromptOverrides(value);
  };
  render();
  // The Noise controls added below the H3 settings need real node height;
  // otherwise the flexible prompt editor can paint past the node boundary.
  // Keep the canvas frame and the full DOM board in sync.  The toolbar above
  // the prompt needs additional vertical room beyond the former 1220px DOM
  // minimum, otherwise the lowest editor area can protrude past the frame.
  function makeHeightResizeHandle() {
    const handle = document.createElement("div");
    handle.className = "mb-height-resize-handle";
    handle.title = "拖拽调整节点高度";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "拖拽调整节点高度");
    const grip = document.createElement("span");
    grip.className = "mb-height-resize-grip";
    grip.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    handle.appendChild(grip);

    let drag = null;
    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      handle.releasePointerCapture?.(drag.pointerId);
      handle.classList.remove("dragging");
      drag = null;
    };
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const zoom = Math.max(0.1, Number(node.graph?.canvas?.ds?.scale || app.canvas?.ds?.scale || 1));
      drag = { pointerId: event.pointerId, startY: event.clientY, startHeight: Number(node.size?.[1]) || minSize[1], zoom };
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add("dragging");
    };
    handle.onpointermove = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const height = Math.max(minSize[1], Math.round(drag.startHeight + (event.clientY - drag.startY) / drag.zoom));
      node.setSize?.([fixedWidth, height]);
      node.graph?.setDirtyCanvas?.(true, true);
    };
    handle.onpointerup = finishDrag;
    handle.onpointercancel = finishDrag;
    return handle;
  }
  node.min_width = fixedWidth;
  node.min_height = minSize[1];
  node.max_width = fixedWidth;
  node.max_height = Number.MAX_SAFE_INTEGER;
  node.min_size = minSize;
  node.max_size = [fixedWidth, Number.MAX_SAFE_INTEGER];
  const priorResize = node.onResize;
  node.onResize = function (size) {
    // The fixed card grid must not change width. Height remains user-resizable
    // above its minimum and is never recomputed from prompt/external_prompt.
    size[0] = fixedWidth;
    size[1] = Math.max(minSize[1], Number(size[1]) || minSize[1]);
    priorResize?.call(this, size);
  };
  const domWidget = node.addDOMWidget("media_board_ui", "H3_MEDIA_BOARD_UI", root, {
    getValue: () => "media-board",
    getMinHeight: () => 1464,
    getHeight: () => Math.max(1464, node.size[1] - 48),
    afterResize: () => { prompt.querySelector(".mb-prompt-editor").style.minHeight = "145px"; },
  });
  // The board is presentation only.  Older versions serialized this value as
  // "media-board", which shifts subsequent real widget values in a workflow.
  domWidget.serialize = false;
  node.size = [Math.max(minSize[0], node.size[0]), Math.max(minSize[1], node.size[1])];
  node.setSize?.(node.size);
  return domWidget;
}

const DYNAMIC_MEDIA_SAVE_PROPERTY = "dynamic_media_board_saved";

function readDynamicMediaManifest(widget) {
  try {
    const parsed = JSON.parse(widget?.value || "{}");
    return Object.fromEntries(["image", "audio"].map((kind) => [
      kind,
      Array.isArray(parsed?.[kind])
        ? parsed[kind].filter((item) => item && typeof item.path === "string").slice(0, DYNAMIC_MEDIA_LIMIT)
        : [],
    ]));
  } catch (_) {
    return { image: [], audio: [] };
  }
}

function createDynamicMediaBoard(node) {
  if (node._dynamicMediaBoardCreated) return;
  injectStyle();
  const manifestWidget = node.widgets?.find((widget) => widget.name === "media_manifest");
  const resizeWidgets = Object.fromEntries(["resize_mode", "resize_width", "resize_height", "resize_method"].map((name) => [
    name, node.widgets?.find((widget) => widget.name === name),
  ]));
  if (!manifestWidget || Object.values(resizeWidgets).some((widget) => !widget)) {
    const attempts = node._dynamicMediaBoardAttempts || 0;
    if (attempts < 8 && !node._dynamicMediaBoardPending) {
      node._dynamicMediaBoardAttempts = attempts + 1;
      node._dynamicMediaBoardPending = true;
      setTimeout(() => { node._dynamicMediaBoardPending = false; createDynamicMediaBoard(node); }, 80 * (attempts + 1));
    }
    return;
  }
  node._dynamicMediaBoardCreated = true;
  const hideDynamicWidget = (widget) => {
    widget.hidden = true;
    widget.options = widget.options || {};
    widget.options.hidden = true;
    widget.serialize = true;
    widget.serializeValue = () => widget.value;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    if (widget.element) widget.element.style.display = "none";
  };
  hideDynamicWidget(manifestWidget);
  Object.values(resizeWidgets).forEach(hideDynamicWidget);

  const saved = node.properties?.[DYNAMIC_MEDIA_SAVE_PROPERTY];
  if (saved && typeof saved.media_manifest === "string") manifestWidget.value = saved.media_manifest;
  for (const [name, value] of Object.entries(saved?.resize_settings || {})) {
    if (resizeWidgets[name] && value !== undefined) resizeWidgets[name].value = value;
  }
  node._dynamicAudioCollapsed = Boolean(saved?.audio_collapsed);
  node._dynamicResizeCollapsed = Boolean(saved?.resize_collapsed);
  const root = document.createElement("div");
  root.className = "h3-media-board h3-dynamic-media-board";
  root.tabIndex = 0;
  const refreshOutputs = (state) => {
    // Keep one IMAGE and one AUDIO socket available even before anything is
    // uploaded.  That makes the board usable as a fixed connection point in a
    // workflow: the empty socket simply produces None until its first card is
    // populated.  Additional ports still grow with the uploaded media.
    const imageCount = Math.max(1, state.image.length);
    const audioCount = Math.max(1, state.audio.length);
    const desired = [
      ...Array.from({ length: imageCount }, (_, index) => [`图片_${index + 1}`, "IMAGE"]),
      ...Array.from({ length: audioCount }, (_, index) => [`音频_${index + 1}`, "AUDIO"]),
    ];
    const current = node.outputs || [];
    const matches = current.length === desired.length && current.every(
      (output, index) => output.name === desired[index][0] && output.type === desired[index][1],
    );
    if (!matches) {
      const isPrefix = current.length <= desired.length && current.every(
        (output, index) => output.name === desired[index][0] && output.type === desired[index][1],
      );
      if (!isPrefix) while (node.outputs?.length) node.removeOutput?.(node.outputs.length - 1);
      for (let index = node.outputs?.length || 0; index < desired.length; index += 1) {
        node.addOutput?.(desired[index][0], desired[index][1]);
      }
    }
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const resizeSettings = () => Object.fromEntries(Object.entries(resizeWidgets).map(([name, widget]) => [name, widget.value]));
  const persist = (state) => {
    manifestWidget.value = JSON.stringify(state);
    node.properties = node.properties || {};
    node.properties[DYNAMIC_MEDIA_SAVE_PROPERTY] = {
      media_manifest: manifestWidget.value,
      audio_collapsed: Boolean(node._dynamicAudioCollapsed),
      resize_collapsed: Boolean(node._dynamicResizeCollapsed),
      resize_settings: resizeSettings(),
    };
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const appendResizePanel = (state) => {
    const panel = document.createElement("div");
    panel.className = "mb-dynamic-resize";
    const title = document.createElement("button");
    title.type = "button";
    title.className = "mb-dynamic-resize-title";
    const arrow = document.createElement("span");
    arrow.className = "mb-dynamic-resize-arrow";
    arrow.textContent = node._dynamicResizeCollapsed ? "▸" : "▾";
    title.appendChild(arrow);
    title.append(document.createTextNode("统一图像缩放"));
    const hint = document.createElement("span");
    hint.className = "mb-dynamic-resize-hint";
    hint.textContent = "所有图片输出均按此设置处理";
    title.appendChild(hint);
    title.onclick = (event) => {
      stop(event);
      node._dynamicResizeCollapsed = !node._dynamicResizeCollapsed;
      persist(state); render();
    };
    panel.appendChild(title);
    if (node._dynamicResizeCollapsed) {
      root.appendChild(panel);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "mb-dynamic-resize-grid";
    const mode = String(resizeWidgets.resize_mode.value || "不缩放");
    const enabled = mode !== "不缩放";
    const addField = (label, name, values = null, disabled = false) => {
      const field = document.createElement("label");
      field.className = "mb-dynamic-resize-field";
      field.append(document.createTextNode(label));
      const widget = resizeWidgets[name];
      const control = document.createElement(values ? "select" : "input");
      control.disabled = disabled;
      if (values) {
        values.forEach((value) => {
          const option = document.createElement("option");
          option.value = value; option.textContent = value;
          control.appendChild(option);
        });
        control.value = String(widget.value ?? values[0]);
      } else {
        control.type = "number";
        control.min = String(widget.options?.min ?? 16);
        control.max = String(widget.options?.max ?? 16384);
        control.step = String(widget.options?.step ?? 8);
        control.value = String(widget.value ?? 1024);
      }
      control.onchange = () => {
        let value = control.value;
        if (!values) {
          const min = Number(control.min); const max = Number(control.max);
          value = Math.max(min, Math.min(max, Number.parseInt(value, 10) || min));
          control.value = String(value);
        }
        widget.value = value;
        widget.callback?.(value);
        persist(state);
        render();
      };
      field.appendChild(control); grid.appendChild(field);
    };
    addField("缩放模式", "resize_mode", ["不缩放", "指定尺寸（拉伸）", "指定尺寸（居中裁切）", "指定尺寸（留边）", "按宽度等比", "按高度等比"]);
    addField("算法", "resize_method", ["双三次", "双线性", "最近邻", "区域"], !enabled);
    addField("宽度", "resize_width", null, !enabled || mode === "按高度等比");
    addField("高度", "resize_height", null, !enabled || mode === "按宽度等比");
    panel.appendChild(grid);
    root.appendChild(panel);
  };
  const render = () => {
    const state = readDynamicMediaManifest(manifestWidget);
    root.replaceChildren();
    for (const kind of ["image", "audio"]) {
      const isAudio = kind === "audio";
      const title = document.createElement(isAudio ? "button" : "div");
      title.className = isAudio ? "mb-dynamic-section-title" : "mb-title";
      if (isAudio) {
        title.type = "button";
        const label = document.createElement("span");
        label.textContent = `动态音频 · 已添加 ${state.audio.length}`;
        const arrow = document.createElement("span");
        arrow.className = "mb-dynamic-section-arrow";
        arrow.textContent = node._dynamicAudioCollapsed ? "▸ 展开" : "▾ 折叠";
        title.append(label, arrow);
        title.onclick = (event) => {
          stop(event);
          node._dynamicAudioCollapsed = !node._dynamicAudioCollapsed;
          persist(state); render();
        };
      } else title.textContent = `动态图片 · 已添加 ${state.image.length}`;
      root.appendChild(title);
      if (isAudio && node._dynamicAudioCollapsed) continue;
      const grid = document.createElement("div");
      grid.className = "mb-dynamic-grid";
      const visible = Math.min(DYNAMIC_MEDIA_LIMIT, state[kind].length + 1);
      for (let index = 0; index < visible; index += 1) {
        grid.appendChild(makeCard(kind, index, state[kind][index], (uploaded) => {
          if (uploaded) state[kind][index] = uploaded;
          else state[kind].splice(index, 1);
          state[kind] = state[kind].filter(Boolean).slice(0, DYNAMIC_MEDIA_LIMIT);
          persist(state); render();
        }, { frameRoles: false }));
      }
      root.appendChild(grid);
    }
    appendResizePanel(state);
    refreshOutputs(state);
    const sectionHeight = (count, fullRowHeight) => {
      if (count === 0) return 58;
      const fullRows = Math.ceil(count / DYNAMIC_MEDIA_COLUMNS);
      return fullRows * fullRowHeight + (count % DYNAMIC_MEDIA_COLUMNS === 0 && count < DYNAMIC_MEDIA_LIMIT ? 58 : 0);
    };
    const imageHeight = sectionHeight(state.image.length, 75);
    const audioHeight = node._dynamicAudioCollapsed ? 0 : sectionHeight(state.audio.length, 63);
    // LiteGraph lays the DOM widget below every visible output port.  Reserve
    // that space too, otherwise images can push the audio section below the
    // node boundary as more media outputs are added.
    const outputPortHeight = (Math.max(1, state.image.length) + Math.max(1, state.audio.length)) * 20;
    const resizeHeight = node._dynamicResizeCollapsed ? 42 : 140;
    const height = Math.max(220, 54 + outputPortHeight + imageHeight + 30 + audioHeight + resizeHeight);
    const visibleImages = Math.min(DYNAMIC_MEDIA_LIMIT, state.image.length + 1);
    const visibleAudio = node._dynamicAudioCollapsed ? 0 : Math.min(DYNAMIC_MEDIA_LIMIT, state.audio.length + 1);
    const columns = Math.max(1, Math.min(DYNAMIC_MEDIA_COLUMNS, Math.max(visibleImages, visibleAudio)));
    const width = Math.max(250, Math.min(930, 64 + columns * 145 + (columns - 1) * 7));
    node._dynamicMediaAutoHeight = height;
    node._dynamicMediaAutoWidth = width;
    node.setSize?.([width, height]);
  };
  node._dynamicMediaRender = render;
  node._dynamicMediaRestore = (configured = null) => {
    const backup = configured?.properties?.[DYNAMIC_MEDIA_SAVE_PROPERTY]
      || node.properties?.[DYNAMIC_MEDIA_SAVE_PROPERTY];
    if (backup && typeof backup.media_manifest === "string") manifestWidget.value = backup.media_manifest;
    if (backup && typeof backup.audio_collapsed === "boolean") node._dynamicAudioCollapsed = backup.audio_collapsed;
    if (backup && typeof backup.resize_collapsed === "boolean") node._dynamicResizeCollapsed = backup.resize_collapsed;
    for (const [name, value] of Object.entries(backup?.resize_settings || {})) {
      if (resizeWidgets[name] && value !== undefined) resizeWidgets[name].value = value;
    }
    render();
  };
  const priorSerialize = node.onSerialize;
  node.onSerialize = function (...args) {
    const serialized = args[0];
    if (serialized && typeof serialized === "object") {
      serialized.properties = serialized.properties || {};
      serialized.properties[DYNAMIC_MEDIA_SAVE_PROPERTY] = {
        media_manifest: manifestWidget.value || "{}",
        audio_collapsed: Boolean(node._dynamicAudioCollapsed),
        resize_collapsed: Boolean(node._dynamicResizeCollapsed),
        resize_settings: resizeSettings(),
      };
    }
    return priorSerialize?.apply(this, args);
  };
  root.addEventListener("wheel", (event) => {
    const canvas = app.canvas?.canvas;
    if (!canvas) return;
    event.preventDefault(); event.stopPropagation();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    }));
  }, { passive: false });
  render();
  // This board's size is data-driven.  Disable the user resize handle and
  // clamp any legacy canvas resize gesture back to the current card layout.
  node.resizable = false;
  node.min_size = [250, 170];
  node.min_width = 250;
  node.max_width = 930;
  const priorResize = node.onResize;
  node.onResize = function (size) {
    size[0] = this._dynamicMediaAutoWidth || 250;
    size[1] = this._dynamicMediaAutoHeight || 170;
    priorResize?.call(this, size);
  };
  node.addDOMWidget("dynamic_media_board_ui", "DYNAMIC_MEDIA_BOARD_UI", root, {
    getValue: () => "dynamic-media-board",
    getMinHeight: () => Math.max(150, node.size[1] - 48),
    getHeight: () => Math.max(150, node.size[1] - 48),
  });
  // Node creation starts with backend-reserved outputs.  They can temporarily
  // inflate LiteGraph's minimum height, so apply the measured height again
  // after the placeholder sockets and resize constraints are in place.
  node.setSize?.([node._dynamicMediaAutoWidth || 250, node._dynamicMediaAutoHeight || 170]);
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
      valueOf("second_pass_scale", 1), valueOf("auto_calculate", true),
      valueOf("manual_frames", 362), valueOf("second_pass_size_mode", "倍率放大"),
      valueOf("second_pass_megapixels", 1),
    );
    node._h3MediaCounts = {
      image: state.image.filter(Boolean).length,
      audio: state.audio.filter(Boolean).length,
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
  const autoButton = document.createElement("button"); autoButton.type = "button"; autoButton.className = "h3-mode-auto"; autoButton.textContent = "自动"; autoButton.title = "恢复按素材自动判断";
  head.append(title, caption, autoButton);
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
  let observedBoard = null;
  const onBoardMediaChanged = () => {
    node.properties = node.properties || {};
    node.properties.h3_mode_manual_override = false;
    syncAutoMode(); paint();
  };
  const observeBoard = (board) => {
    if (observedBoard === board) return;
    observedBoard?._h3MediaListeners?.delete(onBoardMediaChanged);
    observedBoard = board;
    if (observedBoard) {
      observedBoard._h3MediaListeners = observedBoard._h3MediaListeners || new Set();
      observedBoard._h3MediaListeners.add(onBoardMediaChanged);
    }
  };
  const syncAutoMode = () => {
    const board = originalBoard(boardSource());
    observeBoard(board);
    const manifestWidget = board?.widgets?.find((item) => item.name === "media_manifest");
    if (!manifestWidget) { node._h3AutoMode = null; return; }
    if (node.properties?.h3_mode_manual_override) { node._h3AutoMode = null; return; }
    const media = readManifest(manifestWidget);
    const imageCount = media.image.filter(Boolean).length, audioCount = media.audio.filter(Boolean).length, videoCount = media.video.length;
    // H3 图文/图生只保留给 1–2 张纯图片；第三张图片起改用多参参考。
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
    const manual = Boolean(node.properties?.h3_mode_manual_override);
    imageText.classList.toggle("active", isImageText);
    multiReference.classList.toggle("active", !isImageText);
    imageText.disabled = false; multiReference.disabled = false;
    autoButton.classList.toggle("active", !manual);
    status.textContent = manual
      ? `手动切换：${isImageText ? "图文 / 图生" : "多参参考"}`
      : automatic
      ? `自动切换：${automatic.reason} → ${isImageText ? "图文 / 图生" : "多参参考"}`
      : `当前输出：${isImageText ? "图文 / 图生" : "多参参考"} → 接到 H3 条件与 Latent 切换的 external_switch`;
  };
  const choose = (value) => {
    node.properties = node.properties || {};
    node.properties.h3_mode_manual_override = true;
    node._h3AutoMode = null;
    widget.value = value; widget.callback?.(value);
    node.graph?.setDirtyCanvas(true, true); paint();
  };
  imageText.onclick = (event) => { stop(event); choose(true); };
  multiReference.onclick = (event) => { stop(event); choose(false); };
  autoButton.onclick = (event) => {
    stop(event);
    node.properties = node.properties || {};
    node.properties.h3_mode_manual_override = false;
    syncAutoMode(); node.graph?.setDirtyCanvas(true, true); paint();
  };
  root.append(head, options, status); root.onpointerdown = (event) => event.stopPropagation();
  // LiteGraph sizes the outer frame independently from DOM widgets.  The old
  // fixed 180px height clipped the mode cards/status bar whenever browser
  // zoom, fonts, or a wrapped status message made the DOM content taller.
  // Measure the real content and keep the canvas node in sync.
  const fixedWidth = 430;
  const minimumContentHeight = 132;
  const nodeChromeHeight = 72;
  let controlHeight = minimumContentHeight + nodeChromeHeight;
  const syncControlSize = () => {
    const contentHeight = Math.max(minimumContentHeight, Math.ceil(root.scrollHeight || 0));
    const nextHeight = contentHeight + nodeChromeHeight;
    if (controlHeight === nextHeight && node.size?.[0] === fixedWidth && node.size?.[1] === nextHeight) return;
    controlHeight = nextHeight;
    node.min_size = [fixedWidth, controlHeight];
    node.max_size = [fixedWidth, controlHeight];
    node.min_width = fixedWidth; node.max_width = fixedWidth;
    node.min_height = controlHeight; node.max_height = controlHeight;
    node.setSize?.([fixedWidth, controlHeight]);
    node.graph?.setDirtyCanvas?.(true, true);
  };
  node.resizable = false;
  const resizeBeforeLock = node.onResize;
  node.onResize = function (size) {
    size[0] = fixedWidth; size[1] = controlHeight;
    resizeBeforeLock?.call(this, size);
  };
  node.addDOMWidget("h3_video_mode_ui", "H3_VIDEO_MODE_UI", root, {
    getValue: () => Boolean(widget.value),
    getMinHeight: () => minimumContentHeight,
    getHeight: () => Math.max(minimumContentHeight, Math.ceil(root.scrollHeight || 0)),
  });
  const resizeObserver = new ResizeObserver(() => syncControlSize());
  resizeObserver.observe(root);
  requestAnimationFrame(syncControlSize);
  const previousConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) { previousConnections?.apply(this, args); syncAutoMode(); paint(); };
  const previousRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    observedBoard?._h3MediaListeners?.delete(onBoardMediaChanged);
    resizeObserver.disconnect();
    previousRemoved?.apply(this, args);
  };
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
  // This is a compact routing node.  Its useful height is determined entirely
  // by the fixed sockets and its one Boolean widget, so extra vertical space
  // only makes the canvas harder to arrange.  Keep that measured height while
  // retaining horizontal resizing for long socket labels and wiring layouts.
  const preferredSize = node.computeSize?.() || node.size || [360, 250];
  const fixedHeight = Math.max(160, Math.ceil(Number(preferredSize[1]) || 250));
  const minWidth = Math.max(300, Math.ceil(Number(preferredSize[0]) || 360));
  const maxWidth = 920;
  node.resizable = true;
  node.min_width = minWidth;
  node.max_width = maxWidth;
  node.min_height = fixedHeight;
  node.max_height = fixedHeight;
  node.min_size = [minWidth, fixedHeight];
  node.max_size = [maxWidth, fixedHeight];
  const resizeBeforeHeightLock = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.min(maxWidth, Math.max(minWidth, Number(size[0]) || minWidth));
    size[1] = fixedHeight;
    resizeBeforeHeightLock?.call(this, size);
  };
  node.setSize?.([Math.min(maxWidth, Math.max(minWidth, Number(node.size?.[0]) || minWidth)), fixedHeight]);
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

const H3_DYNAMIC_GUIDE_GROUPS = 12;

function dynamicGuideInputName(prefix, index, kind) {
  const suffix = index === 1 ? "" : `_${index}`;
  return `${prefix}_${kind}${suffix}`;
}

function setSecondPassWidgetVisible(widget, visible) {
  if (!widget) return;
  if (!widget._h3GuideOriginal) {
    widget._h3GuideOriginal = { computeSize: widget.computeSize, draw: widget.draw };
  }
  widget.hidden = !visible;
  widget.options = widget.options || {};
  widget.options.hidden = !visible;
  if (widget._state) widget._state.hidden = !visible;
  if (widget.element) widget.element.style.display = visible ? "" : "none";
  if (visible) {
    widget.computeSize = widget._h3GuideOriginal.computeSize;
    widget.draw = widget._h3GuideOriginal.draw;
  } else {
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
  }
}

function decorateDynamicGuide(node, prefix) {
  if (node._h3DynamicGuideDecorated) return;
  const firstFrameWidget = node.widgets?.find((widget) => widget.name === "frame_idx");
  if (!firstFrameWidget) {
    const attempts = node._h3DynamicGuideAttempts || 0;
    if (attempts < 8 && !node._h3DynamicGuidePending) {
      node._h3DynamicGuideAttempts = attempts + 1;
      node._h3DynamicGuidePending = true;
      setTimeout(() => {
        node._h3DynamicGuidePending = false;
        decorateDynamicGuide(node, prefix);
      }, 80 * (attempts + 1));
    }
    return;
  }
  node._h3DynamicGuideDecorated = true;

  const findInput = (name) => node.inputs?.find((input) => input.name === name);
  const ensureInput = (name, type, label) => {
    let input = findInput(name);
    if (!input) {
      node.addInput?.(name, type, { shape: 7 });
      input = findInput(name);
    }
    if (input) input.label = label;
  };
  const removeInputIfUnused = (name) => {
    const index = node.inputs?.findIndex((input) => input.name === name) ?? -1;
    if (index >= 0 && node.inputs[index].link == null) node.removeInput?.(index);
  };
  const groupHasConnection = (index) => {
    const image = findInput(dynamicGuideInputName(prefix, index, "image"));
    const audio = findInput(dynamicGuideInputName(prefix, index, "audio"));
    return image?.link != null || audio?.link != null;
  };
  const refreshGroups = () => {
    let lastConnected = 0;
    for (let index = 1; index <= H3_DYNAMIC_GUIDE_GROUPS; index += 1) {
      if (groupHasConnection(index)) lastConnected = index;
    }
    // Always retain one ready-to-connect group. Each used group reveals one
    // further group below it, without a button or a crowded fixed port list.
    const visibleGroups = Math.min(H3_DYNAMIC_GUIDE_GROUPS, Math.max(1, lastConnected + 1));
    for (let index = 1; index <= H3_DYNAMIC_GUIDE_GROUPS; index += 1) {
      const active = index <= visibleGroups;
      const imageName = dynamicGuideInputName(prefix, index, "image");
      const audioName = dynamicGuideInputName(prefix, index, "audio");
      if (active) {
        ensureInput(imageName, "IMAGE", `第 ${index} 组图片 / 帧串`);
        ensureInput(audioName, "AUDIO", `第 ${index} 组音频`);
      } else {
        removeInputIfUnused(imageName);
        removeInputIfUnused(audioName);
      }
      const frameName = index === 1 ? "frame_idx" : `frame_idx_${index}`;
      setSecondPassWidgetVisible(node.widgets?.find((widget) => widget.name === frameName), active);
    }
    const preferred = node.computeSize?.();
    if (preferred) node.setSize?.([Math.max(345, preferred[0]), Math.max(190, preferred[1])]);
    node.graph?.setDirtyCanvas(true, true);
  };
  const previousConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    previousConnections?.apply(this, args);
    refreshGroups();
  };
  refreshGroups();
}

function decorateSecondPassPreparation(node) {
  decorateDynamicGuide(node, "injection");
  if (node._h3SecondPassModeDecorated) return;
  const modeWidget = node.widgets?.find((widget) => widget.name === "use_image_text");
  if (!modeWidget) {
    const attempts = node._h3SecondPassModeAttempts || 0;
    if (attempts < 8 && !node._h3SecondPassModePending) {
      node._h3SecondPassModeAttempts = attempts + 1;
      node._h3SecondPassModePending = true;
      setTimeout(() => {
        node._h3SecondPassModePending = false;
        decorateSecondPassPreparation(node);
      }, 80 * (attempts + 1));
    }
    return;
  }
  node._h3SecondPassModeDecorated = true;
  const sourceForInput = (inputIndex) => {
    const link = node.inputs?.[inputIndex]?.link;
    return node.getInputNode?.(inputIndex)
      || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
  };
  const syncExternalMode = () => {
    const externalIndex = node.inputs?.findIndex((input) => input.name === "external_switch") ?? -1;
    const source = externalIndex >= 0 ? sourceForInput(externalIndex) : null;
    const sourceWidget = source?.comfyClass === "H3VideoModeControl"
      ? source.widgets?.find((widget) => widget.name === "use_image_text")
      : null;
    if (!sourceWidget) return;
    // The Python node already routes from external_switch at execution time.
    // Mirror that exact upstream state in this Boolean widget so its visible
    // label always reads 图文 / 图生 or 多参参考 instead of a stale local value.
    const useImageText = Boolean(sourceWidget.value);
    if (Boolean(modeWidget.value) !== useImageText) {
      modeWidget.value = useImageText;
      modeWidget.callback?.(useImageText);
      node.graph?.setDirtyCanvas?.(true, true);
    }
  };
  const priorConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    priorConnections?.apply(this, args);
    syncExternalMode();
  };
  const priorDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    priorDraw?.call(this, ctx);
    syncExternalMode();
  };
  syncExternalMode();
}

function decorateMultiTimeGuide(node) {
  decorateDynamicGuide(node, "guide");
}

// Stable multi LoRA loader -------------------------------------------------
// This node intentionally uses only backend-declared widgets. Newer ComfyUI
// frontends serialize dynamically added widgets even when serialize=false;
// keeping this list fixed prevents saved strengths and LoRA names from moving.
const STABLE_MULTI_LORA_NODE = "StableMultiLoRALoader";
const H3_UNIVERSAL_LINE_SWITCH_NODE = "H3UniversalLineSwitch";
const STABLE_MULTI_LORA_MAX = 16;
const STABLE_MULTI_LORA_SYNC_TYPE = "STABLE_MULTI_LORA_CONFIG";

function isStableMultiLoraNode(node) {
  return node?.comfyClass === STABLE_MULTI_LORA_NODE || node?.type === STABLE_MULTI_LORA_NODE;
}

function isUniversalLineSwitchNode(node) {
  return node?.comfyClass === H3_UNIVERSAL_LINE_SWITCH_NODE || node?.type === H3_UNIVERSAL_LINE_SWITCH_NODE;
}

function injectStableMultiLoraStyle() {
  if (document.getElementById("h3-stable-multi-lora-style")) return;
  const style = document.createElement("style");
  style.id = "h3-stable-multi-lora-style";
  style.textContent = `
    .h3-stable-multi-lora { box-sizing:border-box; display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; max-width:100%; padding:4px 0 7px; overflow:hidden; color:#e6edf0; font:12px system-ui,sans-serif; user-select:none; }
    .h3-stable-multi-lora .h3-sml-head { display:flex; min-width:0; align-items:center; justify-content:space-between; gap:8px; color:#a6c0c9; font-size:10px; }
    .h3-stable-multi-lora .h3-sml-head strong, .h3-stable-multi-lora .h3-sml-head span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .h3-stable-multi-lora .h3-sml-head strong { color:#dbeef3; font-size:11px; }
    .h3-stable-multi-lora .h3-sml-row { box-sizing:border-box; display:grid; width:100%; min-width:0; grid-template-columns:38px minmax(0,1fr) 68px 68px; align-items:center; gap:6px; min-height:32px; padding:3px 5px; border:1px solid #4b4a70; border-radius:8px; background:linear-gradient(135deg,#272640,#202038); }
    .h3-stable-multi-lora .h3-sml-row.bypassed { opacity:.58; background:linear-gradient(135deg,#262633,#20202b); }
    .h3-stable-multi-lora select, .h3-stable-multi-lora input, .h3-stable-multi-lora button { box-sizing:border-box; height:26px; min-width:0; border:1px solid #66638d; border-radius:5px; color:#e9e9f2; background:#191924; font:11px system-ui,sans-serif; }
    .h3-stable-multi-lora select { width:100%; padding:0 5px; }
    .h3-stable-multi-lora input { width:100%; padding:0 5px; text-align:right; }
    .h3-stable-multi-lora input:focus, .h3-stable-multi-lora select:focus { outline:1px solid #a89be6; border-color:#a89be6; }
    .h3-stable-multi-lora .h3-sml-switch { position:relative; width:36px; height:21px; padding:0; border-radius:99px; border-color:#686773; background:#585862; cursor:pointer; }
    .h3-stable-multi-lora .h3-sml-switch::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#d4d5da; transition:transform .15s ease; }
    .h3-stable-multi-lora .h3-sml-switch.enabled { border-color:#6e7bc0; background:#879bd0; }
    .h3-stable-multi-lora .h3-sml-switch.enabled::after { transform:translateX(13px); background:#f6f7ff; }
    .h3-stable-multi-lora .h3-sml-strength { position:relative; }
    .h3-stable-multi-lora .h3-sml-strength::before { position:absolute; z-index:1; top:7px; left:5px; color:#aab2ca; font-size:9px; font-weight:800; pointer-events:none; }
    .h3-stable-multi-lora .h3-sml-model::before { content:"M"; }
    .h3-stable-multi-lora .h3-sml-clip::before { content:"C"; }
    .h3-stable-multi-lora .h3-sml-strength input { padding-left:17px; }
    .h3-stable-multi-lora .h3-sml-row.locked { opacity:.6; }
    .h3-stable-multi-lora .h3-sml-row.locked select, .h3-stable-multi-lora .h3-sml-row.locked input, .h3-stable-multi-lora .h3-sml-row.locked button { cursor:not-allowed; }
  `;
  document.head.appendChild(style);
}

function stableMultiLoraWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function stableMultiLoraConfigFromWidgets(node) {
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const count = Math.max(1, Math.min(
    STABLE_MULTI_LORA_MAX,
    Number(stableMultiLoraWidget(node, "lora_count")?.value) || 1,
  ));
  return {
    version: 1,
    lora_count: count,
    rows: Array.from({ length: count }, (_, offset) => {
      const index = offset + 1;
      return {
        lora: stableMultiLoraWidget(node, `lora_${index}`)?.value ?? "(绕过)",
        model_strength: numberOr(stableMultiLoraWidget(node, `model_strength_${index}`)?.value, 1),
        clip_strength: numberOr(stableMultiLoraWidget(node, `clip_strength_${index}`)?.value, 1),
        bypass: Boolean(stableMultiLoraWidget(node, `bypass_${index}`)?.value),
      };
    }),
  };
}

function normalizeStableMultiLoraConfig(config) {
  if (!config || !Array.isArray(config.rows)) return null;
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const count = Math.max(1, Math.min(STABLE_MULTI_LORA_MAX, Number(config.lora_count) || 1));
  return {
    version: 1,
    lora_count: count,
    rows: Array.from({ length: count }, (_, offset) => {
      const row = config.rows[offset] || {};
      return {
        lora: row.lora || "(绕过)",
        model_strength: numberOr(row.model_strength, 1),
        clip_strength: numberOr(row.clip_strength, 1),
        bypass: Boolean(row.bypass),
      };
    }),
  };
}

function stableMultiLoraConfigsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setStableMultiLoraWidgetValue(widget, value) {
  if (!widget) return;
  widget.value = value;
  if (widget._state) widget._state.value = value;
}

function setStableMultiLoraDisabled(widget, disabled) {
  if (!widget) return;
  widget.disabled = disabled;
  widget.options ??= {};
  widget.options.disabled = disabled;
  if (widget._state) widget._state.disabled = disabled;
  if (widget.element) widget.element.disabled = disabled;
}

function setStableMultiLoraConfigDisabled(node, disabled) {
  setStableMultiLoraDisabled(stableMultiLoraWidget(node, "lora_count"), disabled);
  for (let index = 1; index <= STABLE_MULTI_LORA_MAX; index++) {
    setStableMultiLoraDisabled(stableMultiLoraWidget(node, `lora_${index}`), disabled);
    setStableMultiLoraDisabled(stableMultiLoraWidget(node, `model_strength_${index}`), disabled);
    setStableMultiLoraDisabled(stableMultiLoraWidget(node, `clip_strength_${index}`), disabled);
    setStableMultiLoraDisabled(stableMultiLoraWidget(node, `bypass_${index}`), disabled);
  }
}

function applyStableMultiLoraConfig(node, config) {
  const normalized = normalizeStableMultiLoraConfig(config);
  if (!normalized) return;
  node._stableMultiLoraApplyingConfig = true;
  setStableMultiLoraWidgetValue(stableMultiLoraWidget(node, "lora_count"), normalized.lora_count);
  for (let index = 1; index <= STABLE_MULTI_LORA_MAX; index++) {
    const row = normalized.rows[index - 1] || { lora: "(绕过)", model_strength: 1, clip_strength: 1, bypass: false };
    setStableMultiLoraWidgetValue(stableMultiLoraWidget(node, `lora_${index}`), row.lora);
    setStableMultiLoraWidgetValue(stableMultiLoraWidget(node, `model_strength_${index}`), row.model_strength);
    setStableMultiLoraWidgetValue(stableMultiLoraWidget(node, `clip_strength_${index}`), row.clip_strength);
    setStableMultiLoraWidgetValue(stableMultiLoraWidget(node, `bypass_${index}`), row.bypass);
  }
  refreshStableMultiLora(node, normalized.lora_count);
  node._stableMultiLoraApplyingConfig = false;
}

function stableMultiLoraInputSource(node, name) {
  const index = node.inputs?.findIndex((input) => input.name === name) ?? -1;
  if (index < 0) return null;
  return stableMultiLoraInputSourceAt(node, index);
}

function stableMultiLoraInputSourceAt(node, index) {
  const link = node.inputs[index]?.link;
  return node.getInputNode?.(index)
    || (link != null ? node.graph?.getNodeById(node.graph.links?.[link]?.origin_id) : null);
}

function stableMultiLoraSyncSource(node) {
  let source = stableMultiLoraInputSource(node, "lora_sync");
  const visited = new Set([node]);
  // A universal line switch is transparent when on. Follow through it so the
  // downstream LoRA loader can still recognise and mirror its real source.
  while (source && isUniversalLineSwitchNode(source) && !visited.has(source)) {
    visited.add(source);
    const enabled = Boolean(source.widgets?.find((widget) => widget.name === "enabled")?.value);
    if (!enabled) return null;
    const inputIndex = source.inputs?.findIndex((input) => input.name === "value"
      || input.name === "输入（任意类型）" || input.type === "*") ?? -1;
    if (inputIndex < 0) return null;
    source = stableMultiLoraInputSourceAt(source, inputIndex);
  }
  return source;
}

function ensureStableMultiLoraSyncPorts(node) {
  const isSyncPort = (port) => port?.type === STABLE_MULTI_LORA_SYNC_TYPE
    || port?.name === "lora_sync"
    || port?.name === "LoRA 配置同步";
  // Older frontend builds added a compatibility port even though the backend
  // already supplied one with its translated label. Keep the backend port and
  // clean that accidental extra port from existing workflows.
  const removeDuplicatePorts = (ports, removePort) => {
    const indexes = (ports || []).flatMap((port, index) => isSyncPort(port) ? [index] : []);
    for (const index of indexes.slice(1).reverse()) removePort?.call(node, index);
  };
  removeDuplicatePorts(node.inputs, node.removeInput);
  removeDuplicatePorts(node.outputs, node.removeOutput);
  if (!node.inputs?.some(isSyncPort)) {
    node.addInput?.("lora_sync", STABLE_MULTI_LORA_SYNC_TYPE, { label: "LoRA 配置同步" });
  }
  if (!node.outputs?.some(isSyncPort)) {
    node.addOutput?.("lora_sync", STABLE_MULTI_LORA_SYNC_TYPE, { label: "LoRA 配置同步" });
  }
}

function notifyStableMultiLoraConfigChanged(node) {
  node._stableMultiLoraListeners?.forEach((listener) => listener());
}

function refreshStableMultiLoraSync(node) {
  const source = stableMultiLoraSyncSource(node);
  const validSource = source && source !== node && isStableMultiLoraNode(source) ? source : null;
  const sourceChanged = node._stableMultiLoraSyncSource !== validSource;
  if (sourceChanged) {
    node._stableMultiLoraSyncSource?._stableMultiLoraListeners?.delete(node._stableMultiLoraSyncListener);
    node._stableMultiLoraSyncSource = validSource;
    if (validSource) {
      validSource._stableMultiLoraListeners ??= new Set();
      validSource._stableMultiLoraListeners.add(node._stableMultiLoraSyncListener);
    }
  }
  if (validSource) {
    const sourceConfig = normalizeStableMultiLoraConfig(
      validSource._stableMultiLoraEffectiveConfig?.() || stableMultiLoraConfigFromWidgets(validSource),
    );
    if (!sourceConfig) return;
    if (!node._stableMultiLoraLocalConfig) {
      node._stableMultiLoraLocalConfig = stableMultiLoraConfigFromWidgets(node);
    }
    const configChanged = !stableMultiLoraConfigsEqual(node._stableMultiLoraSyncedConfig, sourceConfig);
    if (configChanged) {
      applyStableMultiLoraConfig(node, sourceConfig);
      node._stableMultiLoraSyncedConfig = sourceConfig;
    }
    setStableMultiLoraConfigDisabled(node, true);
    node._stableMultiLoraEffectiveConfig = () => node._stableMultiLoraSyncedConfig;
    if (configChanged) notifyStableMultiLoraConfigChanged(node);
    return;
  }
  const wasSynced = sourceChanged || Boolean(node._stableMultiLoraLocalConfig || node._stableMultiLoraSyncedConfig);
  if (node._stableMultiLoraLocalConfig) {
    applyStableMultiLoraConfig(node, node._stableMultiLoraLocalConfig);
    delete node._stableMultiLoraLocalConfig;
  }
  delete node._stableMultiLoraSyncedConfig;
  setStableMultiLoraConfigDisabled(node, false);
  node._stableMultiLoraEffectiveConfig = () => stableMultiLoraConfigFromWidgets(node);
  if (wasSynced) notifyStableMultiLoraConfigChanged(node);
}

function setStableMultiLoraVisible(widget, visible) {
  if (!widget) return;
  if (!widget._stableMultiLoraOriginal) {
    widget._stableMultiLoraOriginal = {
      computeSize: widget.computeSize,
      draw: widget.draw,
    };
  }
  widget.hidden = !visible;
  widget.options ??= {};
  widget.options.hidden = !visible;
  if (widget._state) widget._state.hidden = !visible;
  if (widget.element) widget.element.style.display = visible ? "" : "none";
  if (visible) {
    widget.computeSize = widget._stableMultiLoraOriginal.computeSize;
    widget.draw = widget._stableMultiLoraOriginal.draw;
  } else {
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
  }
}

function setStableMultiLoraCompactWidgetValue(node, widget, value) {
  if (!widget || widget.disabled) return;
  setStableMultiLoraWidgetValue(widget, value);
  widget.callback?.call(widget, value);
  node.graph?.setDirtyCanvas?.(true, true);
}

function createStableMultiLoraCompactUI(node) {
  if (node._stableMultiLoraCompactReady) {
    node._stableMultiLoraCompactRender?.();
    return;
  }
  const firstLora = stableMultiLoraWidget(node, "lora_1");
  if (!firstLora) {
    const attempts = node._stableMultiLoraCompactAttempts || 0;
    if (attempts < 8 && !node._stableMultiLoraCompactPending) {
      node._stableMultiLoraCompactAttempts = attempts + 1;
      node._stableMultiLoraCompactPending = true;
      setTimeout(() => { node._stableMultiLoraCompactPending = false; createStableMultiLoraCompactUI(node); }, 80 * (attempts + 1));
    }
    return;
  }
  injectStableMultiLoraStyle();
  node._stableMultiLoraCompactReady = true;
  const root = document.createElement("div");
  root.className = "h3-stable-multi-lora";
  root.onpointerdown = (event) => event.stopPropagation();
  const head = document.createElement("div"); head.className = "h3-sml-head";
  const title = document.createElement("strong"); title.textContent = "LoRA 列表";
  const hint = document.createElement("span"); hint.textContent = "关闭即绕过，选择和强度会保留";
  head.append(title, hint);
  const rows = document.createElement("div");
  root.append(head, rows);

  const intrinsicHeight = () => {
    // addDOMWidget can stretch root to match a node's current height. Measure
    // only its real children, otherwise each refresh would make this node grow.
    const style = getComputedStyle(root);
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    return Math.ceil(padding + (head.offsetHeight || 0) + (rows.offsetHeight || 0) + gap);
  };

  const syncSize = () => requestAnimationFrame(() => {
    // ComfyUI stretches a DOM widget to all remaining node height.  Therefore
    // root.offsetHeight reflects the old oversized node and cannot be used.
    // `last_y` is the real canvas position at which this DOM widget begins;
    // intrinsicHeight measures only its header and visible LoRA rows. The DOM
    // wrapper itself reserves another fixed 20 canvas units around the root.
    const widgetTop = Number(domWidget?.last_y) || 90;
    const exactHeight = Math.ceil(widgetTop + intrinsicHeight() + 20);
    const width = Math.max(250, Number(node.size?.[0]) || 250);
    node._stableMultiLoraAutoHeight = exactHeight;
    node.min_size = [250, exactHeight];
    node.max_size = [Number.MAX_SAFE_INTEGER, exactHeight];
    if (Math.abs((Number(node.size?.[1]) || 0) - exactHeight) > 1) {
      node.setSize?.([width, exactHeight]);
      // Some versions of the original node restore their serialized height
      // from onResize.  Apply the compact height once more after that callback
      // so an opened workflow starts directly below its final visible row.
      if (Array.isArray(node.size)) node.size[1] = exactHeight;
      node.graph?.setDirtyCanvas?.(true, true);
    }
  });

  const render = () => {
    const count = Math.max(1, Math.min(STABLE_MULTI_LORA_MAX, Number(stableMultiLoraWidget(node, "lora_count")?.value) || 1));
    const locked = Boolean(node._stableMultiLoraSyncSource);
    rows.replaceChildren();
    for (let index = 1; index <= count; index++) {
      const loraWidget = stableMultiLoraWidget(node, `lora_${index}`);
      const modelWidget = stableMultiLoraWidget(node, `model_strength_${index}`);
      const clipWidget = stableMultiLoraWidget(node, `clip_strength_${index}`);
      const bypassWidget = stableMultiLoraWidget(node, `bypass_${index}`);
      if (!loraWidget || !modelWidget || !clipWidget || !bypassWidget) continue;
      const bypassed = Boolean(bypassWidget.value);
      const row = document.createElement("div");
      row.className = `h3-sml-row${bypassed ? " bypassed" : ""}${locked ? " locked" : ""}`;
      row.title = `LoRA ${index}`;
      const toggle = document.createElement("button");
      toggle.className = `h3-sml-switch${bypassed ? "" : " enabled"}`;
      toggle.title = bypassed ? "当前绕过；点击启用此 LoRA" : "当前启用；点击绕过此 LoRA（保留选择和强度）";
      toggle.disabled = locked;
      toggle.onclick = (event) => { event.stopPropagation(); setStableMultiLoraCompactWidgetValue(node, bypassWidget, !bypassed); render(); };
      const select = document.createElement("select");
      const values = Array.isArray(loraWidget.options?.values) ? loraWidget.options.values : [loraWidget.value];
      values.forEach((value) => select.appendChild(new Option(String(value), String(value), false, String(value) === String(loraWidget.value))));
      if (![...select.options].some((option) => option.selected)) select.appendChild(new Option(String(loraWidget.value ?? "(绕过)"), String(loraWidget.value ?? "(绕过)"), false, true));
      select.disabled = locked;
      select.title = `LoRA ${index}`;
      select.onchange = (event) => { event.stopPropagation(); setStableMultiLoraCompactWidgetValue(node, loraWidget, select.value); render(); };
      const makeStrength = (widget, className, label) => {
        const wrap = document.createElement("span"); wrap.className = `h3-sml-strength ${className}`; wrap.title = label;
        const input = document.createElement("input"); input.type = "number"; input.step = String(widget.options?.step ?? 0.01); input.min = String(widget.options?.min ?? -100); input.max = String(widget.options?.max ?? 100); input.value = String(widget.value ?? 1); input.disabled = locked;
        const commit = (event) => { event.stopPropagation(); const value = Number(input.value); if (!Number.isFinite(value)) { input.value = String(widget.value ?? 1); return; } setStableMultiLoraCompactWidgetValue(node, widget, value); };
        input.onchange = commit; input.onblur = commit; input.onpointerdown = (event) => event.stopPropagation(); wrap.appendChild(input); return wrap;
      };
      row.append(toggle, select, makeStrength(modelWidget, "h3-sml-model", "模型强度"), makeStrength(clipWidget, "h3-sml-clip", "CLIP 强度"));
      rows.appendChild(row);
    }
    syncSize();
  };
  const domWidget = node.addDOMWidget("stable_multi_lora_ui", "STABLE_MULTI_LORA_UI", root, {
    getValue: () => "stable-multi-lora-ui",
    getMinHeight: () => 48,
    getHeight: () => Math.max(48, intrinsicHeight()),
  });
  domWidget.serialize = false;
  const priorResize = node.onResize;
  node.onResize = function (size) {
    // Width remains user-resizable. Height belongs to the compact list and is
    // recalculated when its LoRA count changes.
    priorResize?.call(this, size);
    if (Array.isArray(size) && Number.isFinite(Number(this._stableMultiLoraAutoHeight))) {
      size[1] = Number(this._stableMultiLoraAutoHeight);
    }
  };
  node._stableMultiLoraCompactRender = render;
  render();
  // Existing workflow nodes receive their DOM layout a frame later. Recheck
  // once it has a real offset so the initial load is wrapped as well.
  requestAnimationFrame(() => requestAnimationFrame(syncSize));
}

function refreshStableMultiLora(node, requestedCount) {
  const countWidget = stableMultiLoraWidget(node, "lora_count");
  const count = Math.max(1, Math.min(
    STABLE_MULTI_LORA_MAX,
    Number(requestedCount ?? countWidget?.value) || 1,
  ));
  if (countWidget) {
    countWidget.label = "LoRA 数量（点击左右箭头 ＋／－）";
    countWidget.value = count;
    if (countWidget._state) countWidget._state.value = count;
    setStableMultiLoraVisible(countWidget, true);
  }
  for (let index = 1; index <= STABLE_MULTI_LORA_MAX; index++) {
    const widgets = [
      stableMultiLoraWidget(node, `lora_${index}`),
      stableMultiLoraWidget(node, `model_strength_${index}`),
      stableMultiLoraWidget(node, `clip_strength_${index}`),
      stableMultiLoraWidget(node, `bypass_${index}`),
    ];
    const labels = [`LoRA ${index}`, `模型强度 ${index}`, `CLIP 强度 ${index}`, `绕过 LoRA ${index}`];
    widgets.forEach((widget, offset) => {
      if (!widget) return;
      widget.label = labels[offset];
      // The compact DOM list renders active rows. Keep backend widgets alive
      // for workflow serialization and config sync, but hide their old UI.
      setStableMultiLoraVisible(widget, false);
    });
  }
  const size = node.computeSize?.();
  if (size) {
    const minimumHeight = Number(node.min_size?.[1]) || 0;
    node.setSize?.([
      Math.max(Number(node.size?.[0]) || 0, size[0]),
      Math.max(Number(size[1]) || 0, minimumHeight),
    ]);
  }
  node.graph?.setDirtyCanvas?.(true, true);
  node._stableMultiLoraCompactRender?.();
}

function createStableMultiLoraLoader(node) {
  if (node._stableMultiLoraReady) {
    refreshStableMultiLora(node);
    refreshStableMultiLoraSync(node);
    return;
  }
  node._stableMultiLoraReady = true;
  ensureStableMultiLoraSyncPorts(node);
  node._stableMultiLoraSyncListener = () => refreshStableMultiLoraSync(node);
  const widgetNames = ["lora_count"];
  for (let index = 1; index <= STABLE_MULTI_LORA_MAX; index++) {
    widgetNames.push(`lora_${index}`, `model_strength_${index}`, `clip_strength_${index}`, `bypass_${index}`);
  }
  widgetNames.forEach((name) => {
    const widget = stableMultiLoraWidget(node, name);
    if (!widget || widget._stableMultiLoraSyncCallback) return;
    const priorCallback = widget.callback;
    widget._stableMultiLoraSyncCallback = true;
    widget.callback = (value, ...args) => {
      if (node._stableMultiLoraSyncSource && !node._stableMultiLoraApplyingConfig) {
        requestAnimationFrame(() => refreshStableMultiLoraSync(node));
        return;
      }
      priorCallback?.call(widget, value, ...args);
      if (name === "lora_count") refreshStableMultiLora(node, value);
      notifyStableMultiLoraConfigChanged(node);
    };
  });
  createStableMultiLoraCompactUI(node);
  refreshStableMultiLora(node);
  refreshStableMultiLoraSync(node);
  const previousConnections = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    previousConnections?.apply(this, args);
    refreshStableMultiLoraSync(node);
  };
  const previousRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    node._stableMultiLoraSyncSource?._stableMultiLoraListeners?.delete(node._stableMultiLoraSyncListener);
    previousRemoved?.apply(this, args);
  };
  const previousDraw = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    previousDraw?.call(this, ctx);
    refreshStableMultiLoraSync(node);
  };
}

// Workflow switchboard ----------------------------------------------------
// This is a canvas-only controller: it lists only targets added by the user,
// never all groups in the current workflow.
const WORKFLOW_SWITCHBOARD_NODE = "H3WorkflowSwitchboard";
const WORKFLOW_SWITCHBOARD_TARGETS = "h3_workflow_switchboard_targets";
const WORKFLOW_SWITCHBOARD_ORIGINAL_MODES = "h3_workflow_switchboard_original_modes";
const WORKFLOW_SWITCHBOARD_ORIGINAL_STYLE = "h3_workflow_switchboard_original_style";

function isWorkflowSwitchboard(node) {
  return node?.comfyClass === WORKFLOW_SWITCHBOARD_NODE || node?.type === WORKFLOW_SWITCHBOARD_NODE;
}

function workflowSwitchboardWidget(node) {
  return node.widgets?.find((widget) => widget.name === "control_state");
}

function workflowNodes(graph) {
  return Array.isArray(graph?._nodes) ? graph._nodes : [];
}

function workflowGroups(graph) {
  return Array.isArray(graph?._groups) ? graph._groups : [];
}

function workflowGroupKey(group, index) {
  if (group?.id !== undefined) return `group-id:${group.id}`;
  if (group?._id !== undefined) return `group-id:${group._id}`;
  const [x, y] = Array.isArray(group?.pos) ? group.pos : [0, 0];
  return `group-pos:${index}:${Math.round(Number(x) || 0)}:${Math.round(Number(y) || 0)}`;
}

function workflowGroupTitle(group, index) {
  return String(group?.title || group?.name || "").trim() || `未命名组 ${index + 1}`;
}

function workflowCandidates(controller) {
  const groups = workflowGroups(controller.graph).map((group, index) => ({
    key: workflowGroupKey(group, index), kind: "group", title: workflowGroupTitle(group, index),
  }));
  const nodes = workflowNodes(controller.graph)
    .filter((node) => node !== controller && node.id !== controller.id)
    .map((node) => ({
      key: `node:${node.id}`, kind: "node", node_id: node.id,
      title: String(node.title || node.comfyClass || node.type || "节点"),
    }));
  return [...groups, ...nodes];
}

function automaticWorkflowCandidates(controller) {
  // `##` is an opt-in marker in the visible title. A title can belong to a
  // normal node or to a LiteGraph group (the blue group strip in the canvas),
  // so scan both. Ordinary single-# ID badges are not auto-added.
  return workflowCandidates(controller).filter((candidate) => String(candidate.title || "").trim().startsWith("##"));
}

function readWorkflowTargets(controller) {
  const widget = workflowSwitchboardWidget(controller);
  for (const raw of [widget?.value, controller.properties?.[WORKFLOW_SWITCHBOARD_TARGETS]]) {
    try {
      const targets = JSON.parse(String(raw || "[]"));
      if (Array.isArray(targets)) return targets
        .filter((target) => target && (target.kind === "group" || target.kind === "node"))
        .map((target) => ({ ...target, enabled: target.enabled !== false }));
    } catch { /* Try the property backup while an old workflow is restoring. */ }
  }
  return [];
}

function addAutomaticWorkflowTargets(controller, targets = readWorkflowTargets(controller)) {
  const known = new Set(targets.map((target) => target.key));
  const additions = automaticWorkflowCandidates(controller)
    .filter((candidate) => !known.has(candidate.key))
    .map((candidate) => ({ ...candidate, enabled: true, automatic: true }));
  if (!additions.length) return targets;
  const next = [...targets, ...additions];
  writeWorkflowTargets(controller, next);
  return next;
}

function setWorkflowNodeMode(node, mode) {
  // This is exactly ComfyUI's Ctrl+B bypass state (mode 4). Keep the node
  // visible on the canvas and preserve its wires; only execution is skipped.
  node.mode = mode;
}

function resolveWorkflowGroup(controller, target) {
  const groups = workflowGroups(controller.graph);
  return groups.find((group, index) => workflowGroupKey(group, index) === target.key)
    || groups.find((group, index) => workflowGroupTitle(group, index) === target.title)
    || null;
}

function nodesInsideWorkflowGroup(graph, group, controller) {
  const all = workflowNodes(graph).filter((node) => node !== controller);
  // Recent LiteGraph groups populate `_children` only after this call. Older
  // builds used `_nodes`, so support both before falling back to bounds.
  group?.recomputeInsideNodes?.();
  if (Array.isArray(group?._children) && group._children.length) return group._children.filter((node) => all.includes(node));
  if (Array.isArray(group?._nodes) && group._nodes.length) return group._nodes.filter((node) => all.includes(node));
  const [left, top] = Array.isArray(group?.pos) ? group.pos : [0, 0];
  const [width, height] = Array.isArray(group?.size) ? group.size : [0, 0];
  return all.filter((node) => {
    const [x, y] = Array.isArray(node.pos) ? node.pos : [Infinity, Infinity];
    const [nodeWidth, nodeHeight] = Array.isArray(node.size) ? node.size : [0, 0];
    const centerX = Number(x) + Number(nodeWidth) / 2;
    const centerY = Number(y) + Number(nodeHeight) / 2;
    return centerX >= Number(left) && centerX <= Number(left) + Number(width)
      && centerY >= Number(top) && centerY <= Number(top) + Number(height);
  });
}

function nodesForWorkflowTarget(controller, target) {
  if (target.kind === "node") {
    return workflowNodes(controller.graph).filter((node) => node !== controller && String(node.id) === String(target.node_id));
  }
  const group = resolveWorkflowGroup(controller, target);
  return group ? nodesInsideWorkflowGroup(controller.graph, group, controller) : [];
}

function isWorkflowTargetBypassed(controller, target) {
  const nodes = nodesForWorkflowTarget(controller, target);
  // A green group switch must mean every member can execute. Treat either
  // LiteGraph's Never mode (2) or Bypass mode (4) as disabled; otherwise a
  // partially disabled group misleadingly appeared enabled.
  return nodes.length > 0 && nodes.some((node) => [2, 4].includes(Number(node.mode)));
}

function syncWorkflowTargetsFromCanvas(controller, targets = readWorkflowTargets(controller)) {
  let changed = false;
  const next = targets.map((target) => {
    const enabled = !isWorkflowTargetBypassed(controller, target);
    if (enabled === (target.enabled !== false)) return target;
    changed = true;
    return { ...target, enabled };
  });
  if (!changed) return { targets, changed: false };
  // Persist only the observed state. Applying here would undo the user's
  // just-pressed Ctrl+B before the switch has a chance to reflect it.
  const encoded = JSON.stringify(next);
  controller.properties ??= {};
  controller.properties[WORKFLOW_SWITCHBOARD_TARGETS] = next;
  const widget = workflowSwitchboardWidget(controller);
  if (widget) {
    widget.value = encoded;
    if (widget._state) widget._state.value = encoded;
  }
  controller.graph?.setDirtyCanvas?.(true, true);
  return { targets: next, changed: true };
}

function restoreWorkflowSwitchboardModes(controller) {
  const saved = controller.properties?.[WORKFLOW_SWITCHBOARD_ORIGINAL_MODES] || {};
  workflowNodes(controller.graph).forEach((node) => {
    const mode = saved[String(node.id)];
    if (node !== controller && Number.isFinite(Number(mode))) setWorkflowNodeMode(node, Number(mode));
  });
}

function applyWorkflowSwitchboard(controller, targets = readWorkflowTargets(controller)) {
  if (!controller?.graph) return;
  controller.properties ??= {};
  const saved = controller.properties[WORKFLOW_SWITCHBOARD_ORIGINAL_MODES] ??= {};
  // Reset first, then explicitly apply every row in visual order. Both ON and
  // OFF must write a real node mode so a later child row can override a parent
  // group and turning a group on cannot leave old Never/Bypass nodes behind.
  restoreWorkflowSwitchboardModes(controller);
  for (const target of targets) {
    nodesForWorkflowTarget(controller, target).forEach((node) => {
      const id = String(node.id);
      if (!Object.prototype.hasOwnProperty.call(saved, id)) saved[id] = Number(node.mode) || 0;
      // Mode 0 executes normally; mode 4 bypasses while preserving wires.
      setWorkflowNodeMode(node, target.enabled !== false ? 0 : 4);
    });
  }
  controller.graph?.setDirtyCanvas?.(true, true);
}

function writeWorkflowTargets(controller, targets) {
  const value = targets.map((target) => ({ ...target, enabled: target.enabled !== false }));
  const encoded = JSON.stringify(value);
  controller.properties ??= {};
  controller.properties[WORKFLOW_SWITCHBOARD_TARGETS] = value;
  const widget = workflowSwitchboardWidget(controller);
  if (widget) {
    widget.value = encoded;
    if (widget._state) widget._state.value = encoded;
    widget.callback?.(encoded);
  }
  applyWorkflowSwitchboard(controller, value);
  controller.graph?.setDirtyCanvas?.(true, true);
}

function createWorkflowSwitchboard(controller) {
  if (controller._workflowSwitchboardReady) { controller._workflowSwitchboardRender?.(); return; }
  injectWorkflowSwitchboardStyle();
  const stateWidget = workflowSwitchboardWidget(controller);
  if (!stateWidget) {
    const attempt = controller._workflowSwitchboardAttempts || 0;
    if (attempt < 8 && !controller._workflowSwitchboardPending) {
      controller._workflowSwitchboardAttempts = attempt + 1;
      controller._workflowSwitchboardPending = true;
      setTimeout(() => { controller._workflowSwitchboardPending = false; createWorkflowSwitchboard(controller); }, 80 * (attempt + 1));
    }
    return;
  }
  controller._workflowSwitchboardReady = true;
  stateWidget.hidden = true; stateWidget.options ??= {}; stateWidget.options.hidden = true;
  stateWidget.serialize = true; stateWidget.serializeValue = () => stateWidget.value;
  stateWidget.computeSize = () => [0, -4]; stateWidget.draw = () => {};
  if (stateWidget.element) stateWidget.element.style.display = "none";

  const root = document.createElement("div"); root.className = "h3-workflow-switchboard";
  root.onpointerdown = (event) => event.stopPropagation();
  // DOM widgets cover the LiteGraph canvas and otherwise swallow wheel input.
  // Relay the complete wheel message so zooming works over the controller too.
  root.addEventListener("wheel", (event) => {
    const canvas = app.canvas?.canvas;
    if (!canvas) return;
    event.preventDefault(); event.stopPropagation();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true,
      clientX: event.clientX, clientY: event.clientY,
      screenX: event.screenX, screenY: event.screenY,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
      deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
      altKey: event.altKey, metaKey: event.metaKey,
    }));
  }, { passive: false });
  const head = document.createElement("div"); head.className = "h3-ws-head";
  const headTitle = document.createElement("span"); headTitle.className = "h3-ws-title"; headTitle.textContent = "流程开关控制器";
  const headHint = document.createElement("span"); headHint.className = "h3-ws-hint"; headHint.textContent = "只添加需要控制的组 / # 节点";
  const sizePicker = document.createElement("select"); sizePicker.className = "h3-ws-size"; sizePicker.title = "调整控制器整体大小";
  const sizeOptions = [["0.8", "小"], ["0.9", "中小"], ["1", "中"], ["1.15", "中大"], ["1.3", "大"], ["1.5", "极大"]];
  sizeOptions.forEach(([value, label]) => sizePicker.appendChild(new Option(label, value)));
  head.append(headTitle, headHint, sizePicker);
  const addBar = document.createElement("div"); addBar.className = "h3-ws-add";
  const picker = document.createElement("select"); picker.title = "选择要添加的组或 # 编号节点";
  const add = document.createElement("button"); add.textContent = "添加";
  const refresh = document.createElement("button"); refresh.className = "h3-ws-refresh"; refresh.textContent = "刷新";
  addBar.append(picker, add, refresh);
  const list = document.createElement("div"); list.className = "h3-ws-list";
  const status = document.createElement("div"); status.className = "h3-ws-status";
  root.append(head, addBar, list, status);

  controller.properties ??= {};
  const initialScale = Number(controller.properties.h3_workflow_switchboard_scale);
  const scaleForNode = () => sizeOptions.some(([value]) => Number(value) === initialScale)
    ? initialScale : Number(controller.properties.h3_workflow_switchboard_scale) || 1;
  controller.properties.h3_workflow_switchboard_scale = Math.min(1.5, Math.max(0.8, scaleForNode()));
  controller.properties.h3_workflow_switchboard_base_width ??= Math.max(440, (Number(controller.size?.[0]) || 440) / controller.properties.h3_workflow_switchboard_scale);
  const applyScale = () => {
    const scale = Number(controller.properties.h3_workflow_switchboard_scale) || 1;
    root.style.zoom = String(scale);
    sizePicker.value = String(scale);
  };
  const intrinsicContentHeight = () => {
    // addDOMWidget may stretch its root to the canvas node's current height.
    // Never measure root.scrollHeight here: that creates a feedback loop where
    // every resize is treated as new content and makes the node taller again.
    const children = [...root.children];
    const styles = getComputedStyle(root);
    const gap = Number.parseFloat(styles.rowGap || styles.gap) || 0;
    const padding = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
    return Math.ceil(padding + children.reduce((total, child) => total + child.offsetHeight, 0) + Math.max(0, children.length - 1) * gap);
  };
  const syncSize = () => {
    // DOM widgets can finish laying out one or two frames after they are
    // created. Measure their final scroll height and reserve extra canvas
    // chrome, so status text and the last switch row never paint outside the
    // blue node boundary.
    requestAnimationFrame(() => {
      const scale = Number(controller.properties.h3_workflow_switchboard_scale) || 1;
      const baseWidth = Math.max(440, Number(controller.properties.h3_workflow_switchboard_base_width) || 440);
      const width = Math.ceil(baseWidth * scale);
      const contentHeight = intrinsicContentHeight();
      const height = Math.max(230, Math.ceil(contentHeight * scale) + 120);
      const currentWidth = Number(controller.size?.[0]) || 0;
      const currentHeight = Number(controller.size?.[1]) || 0;
      controller.min_size = [Math.ceil(440 * scale), 230];
      if (Math.abs(currentWidth - width) > 1 || Math.abs(currentHeight - height) > 1) {
        controller.setSize?.([width, height]);
        controller.graph?.setDirtyCanvas?.(true, true);
      }
    });
  };
  applyScale();
  const render = () => {
    const targets = syncWorkflowTargetsFromCanvas(controller, addAutomaticWorkflowTargets(controller)).targets;
    const allCandidates = workflowCandidates(controller);
    const used = new Set(targets.map((target) => target.key));
    const available = allCandidates.filter((candidate) => !used.has(candidate.key));
    picker.replaceChildren();
    if (!available.length) {
      const option = new Option("没有可添加的组或节点", ""); picker.appendChild(option); add.disabled = true;
    } else {
      available.forEach((candidate) => picker.appendChild(new Option(
        candidate.kind === "group" ? `组 · ${candidate.title}` : `#${candidate.node_id} · ${candidate.title}`,
        candidate.key,
      )));
      add.disabled = false;
    }
    list.replaceChildren();
    if (!targets.length) {
      const empty = document.createElement("div"); empty.className = "h3-ws-empty";
      empty.textContent = "标题以 ## 开头的节点会自动加入；也可从上方手动添加。"; list.appendChild(empty);
    }
    targets.forEach((target, index) => {
      const row = document.createElement("div"); row.className = "h3-ws-row";
      const grip = document.createElement("span"); grip.className = "h3-ws-grip"; grip.textContent = "⠿"; grip.title = "拖拽排序";
      const label = document.createElement("span"); label.className = "h3-ws-label";
      label.textContent = target.kind === "group" ? `组 · ${target.title || "未命名组"}` : `#${target.node_id} · ${target.title || "未命名节点"}`;
      const extra = document.createElement("small");
      extra.textContent = target.kind === "group" ? `${nodesForWorkflowTarget(controller, target).length} 个节点` : "节点";
      label.appendChild(extra);
      const toggle = document.createElement("button");
      const enabled = target.enabled !== false;
      toggle.className = `h3-ws-toggle${enabled ? " enabled" : ""}`;
      toggle.title = enabled ? "当前启用；点击绕过" : "当前绕过；点击启用";
      const remove = document.createElement("button"); remove.className = "h3-ws-remove"; remove.textContent = "×"; remove.title = "移除控制项";
      toggle.onclick = (event) => { event.stopPropagation(); const next = readWorkflowTargets(controller); next[index].enabled = !next[index].enabled; writeWorkflowTargets(controller, next); render(); };
      remove.onclick = (event) => { event.stopPropagation(); const next = readWorkflowTargets(controller); next.splice(index, 1); writeWorkflowTargets(controller, next); render(); };
      // Pointer-based sorting works inside ComfyUI's DOM widget on Chromium
      // and touch screens; native HTML drag events are swallowed by some
      // canvas versions before they reach the row.
      grip.onpointerdown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const drag = { pointerId: event.pointerId, from: index, to: index };
        controller._workflowSwitchboardDrag = drag;
        row.classList.add("dragging"); grip.setPointerCapture?.(event.pointerId);
        const clearTargets = () => list.querySelectorAll(".h3-ws-row.drop-target").forEach((item) => item.classList.remove("drop-target"));
        const findDestination = (clientY) => {
          const rows = [...list.querySelectorAll(".h3-ws-row")];
          const found = rows.findIndex((item) => {
            const bounds = item.getBoundingClientRect();
            return clientY < bounds.top + bounds.height / 2;
          });
          return found < 0 ? rows.length - 1 : found;
        };
        const move = (pointerEvent) => {
          if (pointerEvent.pointerId !== drag.pointerId) return;
          pointerEvent.preventDefault();
          drag.to = findDestination(pointerEvent.clientY);
          clearTargets();
          list.querySelectorAll(".h3-ws-row")[drag.to]?.classList.add("drop-target");
        };
        const finish = (pointerEvent) => {
          if (pointerEvent.pointerId !== drag.pointerId) return;
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", finish, true);
          document.removeEventListener("pointercancel", finish, true);
          grip.releasePointerCapture?.(drag.pointerId); clearTargets(); row.classList.remove("dragging");
          controller._workflowSwitchboardDrag = null;
          if (drag.to !== drag.from) {
            const next = readWorkflowTargets(controller); const [moved] = next.splice(drag.from, 1); next.splice(drag.to, 0, moved);
            writeWorkflowTargets(controller, next); render();
          }
        };
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", finish, true);
        document.addEventListener("pointercancel", finish, true);
      };
      row.append(grip, label, toggle, remove); list.appendChild(row);
    });
    status.textContent = targets.length ? `已控制 ${targets.length} 项；关闭项目按列表顺序绕过。` : "列表为空，不会改变画布中的任何节点。";
    requestAnimationFrame(syncSize);
  };
  sizePicker.onchange = (event) => {
    event.stopPropagation();
    const scale = Number(sizePicker.value);
    controller.properties.h3_workflow_switchboard_scale = Number.isFinite(scale) ? scale : 1;
    applyScale(); syncSize(); controller.graph?.setDirtyCanvas?.(true, true);
  };
  add.onclick = (event) => {
    event.stopPropagation(); const candidate = workflowCandidates(controller).find((item) => item.key === picker.value); if (!candidate) return;
    const targets = readWorkflowTargets(controller);
    if (!targets.some((target) => target.key === candidate.key)) { targets.push({ ...candidate, enabled: true }); writeWorkflowTargets(controller, targets); }
    render();
  };
  refresh.onclick = (event) => { event.stopPropagation(); render(); };
  controller.addDOMWidget("h3_workflow_switchboard_ui", "H3_WORKFLOW_SWITCHBOARD_UI", root, {
    getValue: () => stateWidget.value, getMinHeight: () => 124, getHeight: () => Math.max(124, intrinsicContentHeight()),
  });
  const resizeObserver = new ResizeObserver(() => syncSize());
  resizeObserver.observe(root);
  controller._workflowSwitchboardRender = render;
  const priorDraw = controller.onDrawForeground;
  controller.onDrawForeground = function (ctx) {
    priorDraw?.call(this, ctx);
    // New nodes can be added after this controller. Polling at a low rate from
    // the canvas draw keeps ## nodes automatic without replacing graph hooks.
    const now = Date.now();
    if (now - Number(controller._workflowSwitchboardLastScan || 0) < 700) return;
    controller._workflowSwitchboardLastScan = now;
    const current = readWorkflowTargets(controller);
    const known = new Set(current.map((target) => target.key));
    const hasNewAutomaticTarget = automaticWorkflowCandidates(controller).some((candidate) => !known.has(candidate.key));
    const reflected = syncWorkflowTargetsFromCanvas(controller, current);
    if (hasNewAutomaticTarget || reflected.changed) render();
  };
  const priorRemoved = controller.onRemoved;
  controller.onRemoved = function (...args) { resizeObserver.disconnect(); restoreWorkflowSwitchboardModes(controller); controller.graph?.setDirtyCanvas?.(true, true); priorRemoved?.apply(this, args); };
  requestAnimationFrame(() => { applyWorkflowSwitchboard(controller); render(); });
}

app.registerExtension({
  name: "h3.media_board",
  beforeConfigureGraph(graphData) {
      // Migrate all legacy second-pass layouts. ComfyUI inserts its automatic
      // seed "after generate" widget before these fields, so their serialized
      // tail begins at index 12 and is: scale, mode, megapixels, video name,
      // scheduler steps, high-frequency Sigmas, sampler name. Older workflows
      // omit one or more final values and receive their defaults.
      for (const graphNode of graphData?.nodes || []) {
      if (graphNode?.type !== "H3MediaBoard" || !Array.isArray(graphNode.widgets_values)) continue;
      const values = graphNode.widgets_values;
      if (values.length < 12) continue;

      const legacyTail = values.slice(12).filter((value) => value !== "media-board");
      const numericValues = legacyTail.filter((value) => Number.isFinite(Number(value))).map(Number);
      const scale = numericValues.find((value) => value >= 1 && value <= 4) ?? 1.0;
      const megapixels = numericValues.find((value, index) => index > numericValues.indexOf(scale) && value >= 0.1 && value <= 16)
        ?? 1.0;
      const mode = legacyTail.findLast?.((value) => H3_SECOND_PASS_SIZE_MODES.has(value))
        || legacyTail.slice().reverse().find((value) => H3_SECOND_PASS_SIZE_MODES.has(value))
        || "倍率放大";
      const named = graphNode.widgets_values_named;
      const samplerName = typeof named?.sampler_name === "string" && named.sampler_name.trim()
        ? named.sampler_name
        : typeof legacyTail[6] === "string" && legacyTail[6].trim()
          ? legacyTail[6]
          : "res_multistep";
      const videoName = typeof named?.video_name === "string" && named.video_name.trim()
        ? named.video_name
        : typeof legacyTail[3] === "string" && legacyTail[3].trim() && !H3_SECOND_PASS_SIZE_MODES.has(legacyTail[3])
          ? legacyTail[3]
          : legacyTail.findLast?.((value) => typeof value === "string"
            && value !== "media-board" && value !== samplerName && !H3_SECOND_PASS_SIZE_MODES.has(value))
            || "ComfyUI_";
      const namedSchedulerSteps = Math.round(Number(named?.scheduler_steps));
      const tailSchedulerSteps = Math.round(Number(legacyTail[4]));
      const schedulerSteps = Number.isFinite(namedSchedulerSteps) && namedSchedulerSteps >= 1 && namedSchedulerSteps <= 100
        ? namedSchedulerSteps
        : Number.isFinite(tailSchedulerSteps) && tailSchedulerSteps >= 1 && tailSchedulerSteps <= 100
          ? tailSchedulerSteps
          : 8;
      const namedHighSigmas = Math.round(Number(named?.high_sigmas));
      const tailHighSigmas = Math.round(Number(legacyTail[5]));
      const highSigmas = Number.isFinite(namedHighSigmas) && namedHighSigmas >= 0 && namedHighSigmas <= 100
        ? namedHighSigmas
        : Number.isFinite(tailHighSigmas) && tailHighSigmas >= 0 && tailHighSigmas <= 100
          ? tailHighSigmas
          : 5;

      // Replace instead of inserting: this also repairs workflows already
      // saved with the former shifted strings in the numeric positions.
      values.splice(12, values.length - 12, scale, mode, megapixels, videoName, schedulerSteps, highSigmas, samplerName);

      // Recent ComfyUI versions also persist a named copy.  Correcting only
      // widgets_values is not enough: the named values otherwise keep sending
      // a Chinese mode label into the FLOAT input on prompt submission.
      if (graphNode.widgets_values_named && typeof graphNode.widgets_values_named === "object") {
        graphNode.widgets_values_named.second_pass_scale = scale;
        graphNode.widgets_values_named.second_pass_size_mode = mode;
        graphNode.widgets_values_named.second_pass_megapixels = megapixels;
        graphNode.widgets_values_named.video_name = videoName;
        graphNode.widgets_values_named.scheduler_steps = schedulerSteps;
        graphNode.widgets_values_named.high_sigmas = highSigmas;
        graphNode.widgets_values_named.sampler_name = samplerName;
      }
    }
  },
  setup() {
    setupTopToolbarActionsVisibility();
    setupRestartReconnect();
    installH3VariablePromptResolver();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === "H3MediaBoard") {
      const priorConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (...args) {
        const result = priorConfigure?.apply(this, args);
        // Defer one frame: LiteGraph applies positional widget values during
        // configure, and the deferred pass guarantees the DOM card grid sees
        // the final restored values instead of its initial empty defaults.
        requestAnimationFrame(() => restoreBoardWorkflowState(this, args[0]));
        return result;
      };
      return;
    }
    if (nodeData?.name !== "DynamicMediaBoard") return;
    const priorConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = priorConfigure?.apply(this, args);
      requestAnimationFrame(() => this._dynamicMediaRestore?.(args[0]));
      return result;
    };
  },
  nodeCreated(node) {
    if (node.comfyClass === "H3MediaBoard") createBoard(node);
    if (node.comfyClass === "H3MediaBoardVariableGet") requestAnimationFrame(() => decorateH3VariableGet(node));
    if (node.comfyClass === "DynamicMediaBoard") createDynamicMediaBoard(node);
    if (node.comfyClass === "H3MediaBoardUnpack") decorateUnpacker(node);
    if (node.comfyClass === "H3ConditionLatentSwitch") decorateConditionLatentSwitch(node);
    if (node.comfyClass === "H3VideoModeControl") decorateVideoModeControl(node);
    if (node.comfyClass === "H3SecondPassPreparation") decorateSecondPassPreparation(node);
    if (node.comfyClass === "H3MultiTimeGuide") decorateMultiTimeGuide(node);
    if (isWorkflowSwitchboard(node)) {
      requestAnimationFrame(() => createWorkflowSwitchboard(node));
    }
    if (isStableMultiLoraNode(node)) {
      requestAnimationFrame(() => createStableMultiLoraLoader(node));
    }
  },
  loadedGraphNode(node) {
    if (node.comfyClass === "H3MediaBoardVariableGet") {
      requestAnimationFrame(() => decorateH3VariableGet(node));
    }
    if (node.comfyClass === "H3ConditionLatentSwitch") {
      requestAnimationFrame(() => decorateConditionLatentSwitch(node));
    }
    if (isStableMultiLoraNode(node)) {
      requestAnimationFrame(() => createStableMultiLoraLoader(node));
    }
    if (isWorkflowSwitchboard(node)) {
      requestAnimationFrame(() => createWorkflowSwitchboard(node));
    }
    if (node.comfyClass === "H3MediaBoard") {
      requestAnimationFrame(() => restoreBoardWorkflowState(node));
    }
    if (node.comfyClass === "DynamicMediaBoard") {
      requestAnimationFrame(() => node._dynamicMediaRestore?.());
    }
  },
});
