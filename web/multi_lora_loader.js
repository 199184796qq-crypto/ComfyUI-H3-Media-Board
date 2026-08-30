import { app } from "../../scripts/app.js";

const NODE_NAME = "MultiLoRALoader";
const MAX_LORAS = 16;

const widgetFor = (node, name) => node.widgets?.find((widget) => widget.name === name);

function rowWidgets(node, index) {
  return [
    widgetFor(node, `lora_${index}`),
    widgetFor(node, `model_strength_${index}`),
    widgetFor(node, `clip_strength_${index}`),
  ].filter(Boolean);
}

function setVisible(widget, visible) {
  if (!widget) return;
  widget.hidden = !visible;
  widget.options ??= {};
  widget.options.hidden = !visible;
  if (!widget._multiLoraComputeSize) widget._multiLoraComputeSize = widget.computeSize;
  widget.computeSize = visible
    ? widget._multiLoraComputeSize
    : () => [0, -4];
}

function refresh(node) {
  const countWidget = widgetFor(node, "lora_count");
  const count = Math.max(1, Math.min(MAX_LORAS, Number(countWidget?.value) || 1));
  if (countWidget) countWidget.value = count;

  for (let index = 1; index <= MAX_LORAS; index++) {
    const visible = index <= count;
    for (const widget of rowWidgets(node, index)) setVisible(widget, visible);
  }

  node.setSize?.(node.computeSize());
  node.setDirtyCanvas?.(true, true);
}

function addButtons(node) {
  if (node._multiLoraButtonsAdded) return;
  node._multiLoraButtonsAdded = true;

  const add = node.addWidget("button", "＋ 添加 LoRA", null, () => {
    const countWidget = widgetFor(node, "lora_count");
    const count = Number(countWidget?.value) || 1;
    if (countWidget && count < MAX_LORAS) countWidget.value = count + 1;
    refresh(node);
  });
  add.serialize = false;

  const remove = node.addWidget("button", "－ 减少 LoRA", null, () => {
    const countWidget = widgetFor(node, "lora_count");
    const count = Number(countWidget?.value) || 1;
    if (countWidget && count > 1) countWidget.value = count - 1;
    refresh(node);
  });
  remove.serialize = false;
}

function prepareNode(node) {
  const countWidget = widgetFor(node, "lora_count");
  if (countWidget) setVisible(countWidget, false);

  for (let index = 1; index <= MAX_LORAS; index++) {
    const [lora, modelStrength, clipStrength] = rowWidgets(node, index);
    if (lora) lora.label = `LoRA ${index}`;
    if (modelStrength) modelStrength.label = `模型强度 ${index}`;
    if (clipStrength) clipStrength.label = `CLIP 强度 ${index}`;
  }
  addButtons(node);
  refresh(node);
}

app.registerExtension({
  name: "comfy.multiLoraLoader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      originalCreated?.apply(this, arguments);
      prepareNode(this);
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      originalConfigure?.apply(this, arguments);
      prepareNode(this);
    };
  },
});
