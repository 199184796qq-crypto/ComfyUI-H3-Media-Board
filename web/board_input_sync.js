import {app} from "../../../scripts/app.js";

const value = (node, name) => node.widgets?.find(w => w.name === name);
const isBoard = node => (node?.comfyClass || node?.type) === "H3MediaBoard";

export function wireSyncPrompt(output) {
  const occupied = new Set();
  for (const [id, entry] of Object.entries(output)) {
    if (entry.class_type !== "H3BoardInputSync") continue;
    const target = String(entry.inputs.target_board || "");
    const board = output[target];
    if (board?.class_type !== "H3MediaBoard") throw new Error(`同步桥 #${id}：请选择当前工作流中启用的 H3 Media Board`);
    for (const kind of ["image", "audio"]) {
      if (!entry.inputs[kind]) continue;
      const key = `${target}/${kind}/${entry.inputs[`${kind}_slot`]}`;
      if (occupied.has(key)) throw new Error(`多个同步桥写入同一槽位：${key}`);
      occupied.add(key);
    }
    entry.inputs.base_manifest = board.inputs.media_manifest ?? "{}";
    board.inputs.media_manifest = [id, 0];
  }
  // A board feeding its own bridge (including wireless getters) cannot run.
  const visiting = new Set(), done = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error("无线同步形成循环：输入素材不能来自目标素材板或其下游节点");
    if (done.has(id) || !output[id]) return;
    visiting.add(id);
    for (const input of Object.values(output[id].inputs || {})) {
      if (Array.isArray(input) && input.length === 2 && typeof input[1] === "number") visit(String(input[0]));
    }
    visiting.delete(id); done.add(id);
  };
  for (const id of Object.keys(output)) visit(id);
}

app.registerExtension({
  name: "H3.MediaBoard.InputSync",
  setup() {
    const original = app.graphToPrompt.bind(app);
    app.graphToPrompt = async function(...args) {
      const prompt = await original(...args);
      wireSyncPrompt(prompt.output);
      return prompt;
    };
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3BoardInputSync") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function(...args) {
      const result = created?.apply(this, args);
      const hidden = this.inputs?.findIndex(i => i.name === "base_manifest") ?? -1;
      if (hidden >= 0) this.removeInput(hidden);
      const target = value(this, "target_board");
      target.type = "combo";
      target.options = {values: () => ["", ...(this.graph?._nodes || []).filter(isBoard).map(n => String(n.id))]};
      target.label = "目标素材板 ID";
      for (const [name, label] of Object.entries({image_slot:"图片序号 1–9", audio_slot:"音频序号 1–3", image_batch_index:"图片批次索引（从0开始）", audio_batch_index:"音频批次索引（从0开始）"})) value(this, name).label = label;
      this.addWidget("button", "定位目标素材板", null, () => {
        const board = this.graph?.getNodeById(target.value);
        if (isBoard(board)) { app.canvas?.centerOnNode(board); app.canvas?.selectNode(board); }
      }, {serialize:false});
      this.setSize([340, this.computeSize()[1]]);
      return result;
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function(message, ...args) {
      const result = executed?.call(this, message, ...args);
      const payload = message?.h3_input_sync?.[0];
      if (!payload || String(value(this, "target_board").value) !== payload.target) return result;
      const board = this.graph?.getNodeById(payload.target);
      if (!isBoard(board)) return result;
      const widget = value(board, "media_manifest");
      const manifest = JSON.parse(widget.value || "{}");
      for (const [kind, slot, item] of payload.updates) {
        manifest[kind] ||= [];
        while (manifest[kind].length < slot) manifest[kind].push(null);
        manifest[kind][slot - 1] = item;
      }
      widget.value = JSON.stringify(manifest);
      board._h3SaveBackup?.();
      for (const listener of board._h3MediaListeners || []) listener(manifest);
      board._h3RenderBoard?.();
      board.graph?.setDirtyCanvas(true, true);
      return result;
    };
  },
});
