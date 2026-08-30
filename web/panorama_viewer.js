import { app } from "../../scripts/app.js";

const RATIOS = {
  "1:1": [1, 1], "2:3": [2, 3], "3:2": [3, 2], "3:4": [3, 4],
  "4:3": [4, 3], "9:16": [9, 16], "16:9": [16, 9], "21:9": [21, 9],
};
const SAVE_PROPERTY = "panorama_viewer_saved";

function viewUrl(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const subfolder = slash >= 0 ? normalized.slice(0, slash) : "";
  return `/view?filename=${encodeURIComponent(filename)}${subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : ""}&type=input`;
}

function injectStyle() {
  if (document.getElementById("panorama-viewer-style")) return;
  const style = document.createElement("style");
  style.id = "panorama-viewer-style";
  style.textContent = `
    .pano-viewer { box-sizing:border-box; width:100%; padding:9px; color:#dce8ed; font:12px system-ui,sans-serif; user-select:none; }
    .pano-viewer .pano-title { margin-bottom:7px; color:#e5f5f9; font-size:13px; font-weight:800; }
    .pano-viewer .pano-subtitle { margin-left:7px; color:#8da6b0; font-size:10px; font-weight:400; }
    .pano-viewer .pano-stage { position:relative; display:flex; align-items:center; justify-content:center; min-height:224px; overflow:hidden; border:1px solid #4d6670; border-radius:8px; background:#10191e; }
    .pano-viewer .pano-stage.dragover { border-color:#70e2ee; box-shadow:inset 0 0 0 1px #70e2ee88; }
    .pano-viewer canvas { display:block; width:100%; height:auto; cursor:grab; touch-action:none; }
    .pano-viewer canvas.dragging { cursor:grabbing; }
    .pano-viewer .pano-empty { display:flex; flex-direction:column; align-items:center; gap:7px; padding:22px; color:#9eb1ba; text-align:center; cursor:pointer; }
    .pano-viewer .pano-empty strong { color:#d6eef4; font-size:13px; }
    .pano-viewer .pano-empty small { color:#8398a2; }
    .pano-viewer .pano-actions { position:absolute; z-index:2; top:7px; right:7px; display:flex; gap:5px; }
    .pano-viewer button { border:1px solid #4d6670; border-radius:5px; color:#e1edf1; background:#17252cdd; cursor:pointer; font:11px system-ui,sans-serif; }
    .pano-viewer .pano-actions button { padding:4px 7px; }
    .pano-viewer button:hover { border-color:#72d9e5; background:#1d3a43; }
    .pano-viewer .pano-controls { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-top:8px; }
    .pano-viewer .pano-field { display:flex; flex-direction:column; gap:3px; min-width:0; color:#9cb0b9; font-size:10px; }
    .pano-viewer .pano-field input, .pano-viewer .pano-field select { box-sizing:border-box; width:100%; height:26px; padding:3px 5px; border:1px solid #4b626c; border-radius:4px; color:#e4eef2; background:#11191e; font:11px system-ui,sans-serif; }
    .pano-viewer .pano-axis-locks { display:flex; gap:6px; margin-top:8px; }.pano-viewer .pano-axis-lock { flex:1; padding:5px 7px; color:#9eb2ba; }.pano-viewer .pano-axis-lock.active { border-color:#65dce8; color:#e8fbff; background:#17414b; }
    .pano-viewer .pano-tools { display:flex; align-items:end; gap:7px; margin-top:8px; }.pano-viewer .pano-pen-toggle { height:26px; padding:4px 9px; }.pano-viewer .pano-pen-toggle.active { border-color:#65dce8; color:#e8fbff; background:#17414b; }.pano-viewer .pano-color { width:42px; height:26px; padding:2px; border:1px solid #4b626c; border-radius:4px; background:#11191e; }.pano-viewer .pano-tool-field { display:flex; flex-direction:column; gap:3px; color:#9cb0b9; font-size:10px; }.pano-viewer .pano-tool-field input[type="number"] { box-sizing:border-box; width:68px; height:26px; padding:3px 5px; border:1px solid #4b626c; border-radius:4px; color:#e4eef2; background:#11191e; font:11px system-ui,sans-serif; }.pano-viewer canvas.pen-active { cursor:crosshair; }
    .pano-viewer .pano-footer { display:flex; align-items:center; justify-content:space-between; gap:7px; margin-top:8px; padding-top:7px; border-top:1px solid #405761; color:#91a8b2; font-size:10px; }
    .pano-viewer .pano-footer strong { color:#a8eff4; font-size:11px; }
  `;
  document.head.appendChild(style);
}

function hideWidget(widget) {
  widget.hidden = true;
  widget.options = widget.options || {};
  widget.options.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  if (widget.element) widget.element.style.display = "none";
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || minimum));
}

async function uploadPanorama(file) {
  if (!file || !String(file.type || "").startsWith("image/")) return null;
  const form = new FormData();
  form.set("kind", "image"); form.set("file", file);
  const response = await fetch("/h3_media_board/upload", { method: "POST", body: form });
  if (!response.ok) return null;
  return await response.json();
}

function createPanoramaViewer(node) {
  if (node._panoramaViewerCreated) return;
  injectStyle();
  const widgets = Object.fromEntries(["panorama_path", "yaw", "pitch", "horizontal_fov", "aspect_ratio", "output_width", "lock_x", "lock_y", "lock_z", "annotations"].map((name) => [
    name, node.widgets?.find((widget) => widget.name === name),
  ]));
  if (Object.values(widgets).some((widget) => !widget)) {
    const attempts = node._panoramaViewerAttempts || 0;
    if (attempts < 8 && !node._panoramaViewerPending) {
      node._panoramaViewerAttempts = attempts + 1;
      node._panoramaViewerPending = true;
      setTimeout(() => { node._panoramaViewerPending = false; createPanoramaViewer(node); }, 80 * (attempts + 1));
    }
    return;
  }
  node._panoramaViewerCreated = true;
  Object.values(widgets).forEach(hideWidget);
  const saved = node.properties?.[SAVE_PROPERTY];
  for (const [name, value] of Object.entries(saved || {})) {
    if (widgets[name] && value !== undefined) widgets[name].value = value;
  }

  const root = document.createElement("div");
  root.className = "pano-viewer";
  const sourceCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const preview = document.createElement("canvas");
  let sourcePixels = null;
  let dragging = null;
  let queuedRender = false;
  let basePreview = null;
  let penActive = false;
  let deleteMode = false;
  let penColor = "#ff3b30";
  let penSize = 4;
  let drawing = null;

  const current = (name) => widgets[name].value;
  const persist = () => {
    node.properties = node.properties || {};
    node.properties[SAVE_PROPERTY] = Object.fromEntries(Object.entries(widgets).map(([name, widget]) => [name, widget.value]));
    node.graph?.setDirtyCanvas?.(true, true);
  };
  const setValue = (name, value) => {
    widgets[name].value = value;
    widgets[name].callback?.(value);
    persist(); scheduleRender();
  };
  const ratio = () => RATIOS[String(current("aspect_ratio"))] || RATIOS["16:9"];
  const dimensions = () => {
    const [rw, rh] = ratio();
    const width = Math.round(clamp(current("output_width"), 256, Math.min(8192, Math.floor(8192 * rw / rh))));
    return [width, Math.max(16, Math.round(width * rh / rw))];
  };
  const annotations = () => {
    try {
      const value = JSON.parse(String(current("annotations") || "[]"));
      return Array.isArray(value) ? value.filter((item) => item && typeof item === "object").slice(0, 100) : [];
    } catch (_) { return []; }
  };
  const writeAnnotations = (value) => {
    widgets.annotations.value = JSON.stringify(value);
    widgets.annotations.callback?.(widgets.annotations.value);
    persist();
  };
  const removeAnnotationAt = (x, y) => {
    const items = annotations();
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      const left = Math.min(Number(item.x), Number(item.x) + Number(item.w));
      const right = Math.max(Number(item.x), Number(item.x) + Number(item.w));
      const top = Math.min(Number(item.y), Number(item.y) + Number(item.h));
      const bottom = Math.max(Number(item.y), Number(item.y) + Number(item.h));
      if ([left, right, top, bottom].every(Number.isFinite) && x >= left && x <= right && y >= top && y <= bottom) {
        items.splice(index, 1); writeAnnotations(items); return true;
      }
    }
    return false;
  };
  const paintAnnotations = () => {
    if (!basePreview) return;
    const context = preview.getContext("2d");
    context.putImageData(basePreview, 0, 0);
    for (const rectangle of [...annotations(), ...(drawing ? [drawing] : [])]) {
      const x = Number(rectangle.x), y = Number(rectangle.y), w = Number(rectangle.w), h = Number(rectangle.h);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const left = Math.min(x, x + w) * preview.width, top = Math.min(y, y + h) * preview.height;
      const width = Math.abs(w) * preview.width, height = Math.abs(h) * preview.height;
      if (width < 1 || height < 1) continue;
      context.fillStyle = String(rectangle.color || "#ff3b30");
      context.fillRect(left, top, width, height);
      context.strokeStyle = context.fillStyle;
      context.lineWidth = clamp(rectangle.size, 1, 24);
      context.strokeRect(left, top, width, height);
    }
  };
  const renderPreview = () => {
    queuedRender = false;
    if (!sourcePixels) return;
    const [rw, rh] = ratio();
    let width = 640; let height = Math.round(width * rh / rw);
    if (height > 390) { height = 390; width = Math.round(height * rw / rh); }
    preview.width = width; preview.height = height;
    const context = preview.getContext("2d");
    const output = context.createImageData(width, height);
    const input = sourcePixels.data;
    const inputWidth = sourceCanvas.width, inputHeight = sourceCanvas.height;
    const yaw = clamp(current("yaw"), -180, 180) * Math.PI / 180;
    const pitch = clamp(current("pitch"), -89, 89) * Math.PI / 180;
    const fov = clamp(current("horizontal_fov"), 30, 120) * Math.PI / 180;
    const horizontal = Math.tan(fov * 0.5), vertical = horizontal / (width / height);
    const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw), sinPitch = Math.sin(pitch), cosPitch = Math.cos(pitch);
    for (let y = 0; y < height; y += 1) {
      const planeY = (1 - (y + 0.5) / height * 2) * vertical;
      for (let x = 0; x < width; x += 1) {
        const planeX = ((x + 0.5) / width * 2 - 1) * horizontal;
        let vx = cosPitch * cosYaw - planeX * sinYaw - planeY * sinPitch * cosYaw;
        let vy = sinPitch + planeY * cosPitch;
        let vz = cosPitch * sinYaw + planeX * cosYaw - planeY * sinPitch * sinYaw;
        const length = Math.hypot(vx, vy, vz); vx /= length; vy /= length; vz /= length;
        const longitude = Math.atan2(vz, vx);
        const latitude = Math.asin(Math.max(-1, Math.min(1, vy)));
        const sourceX = Math.min(inputWidth - 1, Math.max(0, Math.floor(((longitude / (2 * Math.PI) + 0.5 + 1) % 1) * inputWidth)));
        const sourceY = Math.min(inputHeight - 1, Math.max(0, Math.floor((0.5 - latitude / Math.PI) * inputHeight)));
        const sourceOffset = (sourceY * inputWidth + sourceX) * 4;
        const outputOffset = (y * width + x) * 4;
        output.data[outputOffset] = input[sourceOffset]; output.data[outputOffset + 1] = input[sourceOffset + 1];
        output.data[outputOffset + 2] = input[sourceOffset + 2]; output.data[outputOffset + 3] = 255;
      }
    }
    basePreview = output;
    paintAnnotations();
  };
  const scheduleRender = () => {
    if (!sourcePixels || queuedRender) return;
    queuedRender = true; requestAnimationFrame(renderPreview);
  };
  const setSource = async (path) => {
    sourcePixels = null;
    if (!path) { render(); return; }
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1024 / image.naturalWidth);
      sourceCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      sourceCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      sourceContext.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
      sourcePixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      render(); scheduleRender();
    };
    image.onerror = () => { sourcePixels = null; render(); };
    image.src = viewUrl(path);
  };
  const choose = () => {
    const picker = document.createElement("input");
    picker.type = "file"; picker.accept = "image/*";
    picker.onchange = async () => {
      const uploaded = await uploadPanorama(picker.files?.[0]);
      if (!uploaded?.path) return;
      setValue("panorama_path", uploaded.path); setSource(uploaded.path);
    };
    picker.click();
  };
  const render = () => {
    root.replaceChildren();
    const title = document.createElement("div");
    title.className = "pano-title";
    title.textContent = "360° 全景查看与截图";
    const subtitle = document.createElement("span");
    subtitle.className = "pano-subtitle"; subtitle.textContent = "拖动观看 · 滚轮缩放";
    title.appendChild(subtitle); root.appendChild(title);
    const stage = document.createElement("div"); stage.className = "pano-stage";
    const path = String(current("panorama_path") || "");
    if (sourcePixels) stage.appendChild(preview);
    else {
      const empty = document.createElement("div"); empty.className = "pano-empty";
      empty.innerHTML = "<strong>拖入 2:1 全景图</strong><small>也可点击此处选择图片</small>";
      empty.onclick = choose; stage.appendChild(empty);
    }
    const actions = document.createElement("div"); actions.className = "pano-actions";
    const replace = document.createElement("button"); replace.textContent = path ? "替换" : "上传"; replace.onclick = choose;
    actions.appendChild(replace);
    if (path) {
      const clear = document.createElement("button"); clear.textContent = "×";
      clear.onclick = () => { setValue("panorama_path", ""); sourcePixels = null; render(); };
      actions.appendChild(clear);
    }
    stage.appendChild(actions);
    stage.ondragover = (event) => { event.preventDefault(); event.stopPropagation(); stage.classList.add("dragover"); };
    stage.ondragleave = () => stage.classList.remove("dragover");
    stage.ondrop = async (event) => {
      event.preventDefault(); event.stopPropagation(); stage.classList.remove("dragover");
      const uploaded = await uploadPanorama(event.dataTransfer?.files?.[0]);
      if (uploaded?.path) { setValue("panorama_path", uploaded.path); setSource(uploaded.path); }
    };
    root.appendChild(stage);
    const controls = document.createElement("div"); controls.className = "pano-controls";
    const addField = (label, name, values = null, min = null, max = null, step = null) => {
      const field = document.createElement("label"); field.className = "pano-field"; field.append(document.createTextNode(label));
      const input = document.createElement(values ? "select" : "input");
      if (values) {
        values.forEach((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; input.appendChild(option); });
      } else { input.type = "number"; input.min = String(min); input.max = String(max); input.step = String(step); }
      input.value = String(current(name));
      input.onchange = () => setValue(name, values ? input.value : clamp(input.value, min, max));
      field.appendChild(input); controls.appendChild(field);
    };
    addField("水平角度", "yaw", null, -180, 180, 0.1);
    addField("上下角度", "pitch", null, -89, 89, 0.1);
    addField("视野角度", "horizontal_fov", null, 30, 120, 1);
    addField("截图比例", "aspect_ratio", Object.keys(RATIOS));
    addField("截图宽度", "output_width", null, 256, 8192, 8);
    root.appendChild(controls);
    const tools = document.createElement("div"); tools.className = "pano-tools";
    const pen = document.createElement("button"); pen.type = "button"; pen.className = `pano-pen-toggle${penActive ? " active" : ""}`;
    pen.textContent = penActive ? "✎ 笔：开启" : "✎ 笔：关闭";
    pen.onclick = () => { penActive = !penActive; deleteMode = false; drawing = null; render(); };
    const color = document.createElement("input"); color.type = "color"; color.className = "pano-color"; color.value = penColor;
    color.title = "笔颜色"; color.oninput = () => { penColor = color.value; };
    const size = document.createElement("label"); size.className = "pano-tool-field"; size.append(document.createTextNode("笔宽"));
    const sizeInput = document.createElement("input"); sizeInput.type = "number"; sizeInput.min = "1"; sizeInput.max = "24"; sizeInput.step = "1"; sizeInput.value = String(penSize);
    sizeInput.onchange = () => { penSize = clamp(sizeInput.value, 1, 24); sizeInput.value = String(penSize); };
    size.appendChild(sizeInput);
    const deleteMark = document.createElement("button"); deleteMark.type = "button"; deleteMark.className = `pano-pen-toggle${deleteMode ? " active" : ""}`;
    deleteMark.textContent = deleteMode ? "⌫ 点选删除" : "⌫ 选择删除"; deleteMark.disabled = annotations().length === 0;
    deleteMark.onclick = () => { deleteMode = !deleteMode; penActive = false; drawing = null; render(); };
    const clearMarks = document.createElement("button"); clearMarks.type = "button"; clearMarks.textContent = "全部清除"; clearMarks.disabled = annotations().length === 0;
    clearMarks.onclick = () => { if (confirm("确定清除全部标记吗？")) { writeAnnotations([]); renderPreview(); render(); } };
    tools.append(pen, color, size, deleteMark, clearMarks); root.appendChild(tools);
    const axisLocks = document.createElement("div"); axisLocks.className = "pano-axis-locks";
    [["lock_x", "X · 水平"], ["lock_y", "Y · 上下"], ["lock_z", "Z · 视野"]].forEach(([name, label]) => {
      const button = document.createElement("button");
      button.className = `pano-axis-lock${current(name) ? " active" : ""}`;
      button.textContent = `${current(name) ? "🔒" : "🔓"} 锁定 ${label}`;
      button.onclick = () => { widgets[name].value = !current(name); widgets[name].callback?.(widgets[name].value); persist(); render(); };
      axisLocks.appendChild(button);
    });
    root.appendChild(axisLocks);
    const footer = document.createElement("div"); footer.className = "pano-footer";
    const [width, height] = dimensions();
    footer.innerHTML = `<span>运行工作流后，从右侧 <strong>截图</strong> 输出取得当前视角</span><strong>${width} × ${height}</strong>`;
    root.appendChild(footer);
    const [snapshotWidth, snapshotHeight] = dimensions();
    const previewAspect = snapshotWidth / snapshotHeight;
    const previewHeight = sourcePixels ? Math.min(390, Math.round(640 / previewAspect)) : 224;
    const requiredHeight = Math.max(560, previewHeight + 270);
    if (node.size[1] < requiredHeight) node.setSize?.([Math.max(560, node.size[0]), requiredHeight]);
    if (sourcePixels) {
      preview.classList.toggle("pen-active", penActive || deleteMode);
      preview.onpointerdown = (event) => {
        const rect = preview.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (deleteMode) {
          if (removeAnnotationAt(x, y)) { paintAnnotations(); render(); }
          event.preventDefault(); event.stopPropagation(); return;
        }
        if (penActive) {
          drawing = { x, y, w: 0, h: 0, color: penColor, size: penSize };
          preview.setPointerCapture?.(event.pointerId); event.preventDefault(); event.stopPropagation(); paintAnnotations(); return;
        }
        dragging = { x: event.clientX, y: event.clientY }; preview.setPointerCapture?.(event.pointerId); preview.classList.add("dragging"); event.preventDefault(); event.stopPropagation();
      };
      preview.onpointermove = (event) => {
        const rect = preview.getBoundingClientRect();
        if (drawing) {
          drawing.w = (event.clientX - rect.left) / rect.width - drawing.x;
          drawing.h = (event.clientY - rect.top) / rect.height - drawing.y;
          paintAnnotations(); return;
        }
        if (!dragging) return;
        if (!current("lock_x")) setValue("yaw", ((Number(current("yaw")) - (event.clientX - dragging.x) / rect.width * Number(current("horizontal_fov")) + 540) % 360) - 180);
        if (!current("lock_y")) setValue("pitch", clamp(Number(current("pitch")) + (event.clientY - dragging.y) / rect.height * Number(current("horizontal_fov")), -89, 89));
        dragging = { x: event.clientX, y: event.clientY };
      };
      preview.onpointerup = preview.onpointercancel = () => {
        if (drawing) {
          if (Math.abs(drawing.w) > 0.002 && Math.abs(drawing.h) > 0.002) writeAnnotations([...annotations(), drawing].slice(-100));
          drawing = null; paintAnnotations();
        }
        dragging = null; preview.classList.remove("dragging");
      };
      preview.onwheel = (event) => { event.preventDefault(); event.stopPropagation(); if (!current("lock_z")) setValue("horizontal_fov", clamp(Number(current("horizontal_fov")) + Math.sign(event.deltaY) * 4, 30, 120)); };
    }
  };
  node._panoramaViewerRestore = (configured = null) => {
    const values = configured?.properties?.[SAVE_PROPERTY] || node.properties?.[SAVE_PROPERTY];
    for (const [name, value] of Object.entries(values || {})) if (widgets[name] && value !== undefined) widgets[name].value = value;
    setSource(String(current("panorama_path") || "")); render();
  };
  const priorSerialize = node.onSerialize;
  node.onSerialize = function (...args) {
    const serialized = args[0];
    if (serialized && typeof serialized === "object") {
      serialized.properties = serialized.properties || {};
      serialized.properties[SAVE_PROPERTY] = Object.fromEntries(Object.entries(widgets).map(([name, widget]) => [name, widget.value]));
    }
    return priorSerialize?.apply(this, args);
  };
  node.resizable = true; node.min_size = [460, 470]; node.setSize?.([560, 540]);
  node.addDOMWidget("panorama_viewer_ui", "PANORAMA_VIEWER_UI", root, { getMinHeight: () => 410, getHeight: () => Math.max(410, node.size[1] - 48) });
  setSource(String(current("panorama_path") || "")); render();
}

app.registerExtension({
  name: "h3.panorama_viewer",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "PanoramaViewerSnapshot") return;
    const priorConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = priorConfigure?.apply(this, args);
      requestAnimationFrame(() => this._panoramaViewerRestore?.(args[0]));
      return result;
    };
  },
  nodeCreated(node) {
    if (node.comfyClass === "PanoramaViewerSnapshot") createPanoramaViewer(node);
  },
  loadedGraphNode(node) {
    if (node.comfyClass === "PanoramaViewerSnapshot") requestAnimationFrame(() => node._panoramaViewerRestore?.());
  },
});
