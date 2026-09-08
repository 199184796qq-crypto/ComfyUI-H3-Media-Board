import {app} from "../../../scripts/app.js";
import {api} from "../../../scripts/api.js";
import {targetTypes, checkTarget, mergeMedia, inspectMedia} from "./timeline_sync_adapter.js";

function sourceBoard(node) {
  const visited = new Set();
  let current = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const manifest = current.widgets?.find(w => w.name === "media_manifest");
    if (manifest) {
      const settings = {};
      for (const key of ["duration", "aspect_ratio", "megapixels", "multiple"]) {
        const widget = current.widgets?.find(w => w.name === key);
        if (!widget) throw new Error("来源素材板缺少视频尺寸或时长参数");
        settings[key] = widget.value;
      }
      const raw = JSON.parse(manifest.value || "{}");
      return {node:current, manifest:{image:raw.image || [], video:raw.video || [], audio:raw.audio || []}, settings};
    }
    const input = current.inputs?.find(i => i.name === "media_board") ||
      (current.type === "Reroute" ? current.inputs?.[0] : null);
    const link = current.graph?.links?.[input?.link];
    current = current.graph?.getNodeById(link?.origin_id);
  }
  throw new Error("请将素材板的 media_board 输出连接到同步桥");
}

app.registerExtension({
  name:"H3.MediaBoard.MaterialSync",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3MaterialSync") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
      const result = created?.apply(this, arguments);
      this.properties ||= {};
      this.properties.syncTarget ||= "";
      this.properties.autoSync ??= false;
      const choices = () => (this.graph?._nodes || []).filter(n => targetTypes.has(n.comfyClass || n.type))
        .map(n => `${n.id} · ${n.title || n.type}`);
      const target = this.addWidget("combo", "目标时间线", "请选择", value => {
        this.properties.syncTarget = String(value).split(" · ")[0];
        this._h3SyncSignature = null;
      }, {values:() => choices().length ? choices() : ["请选择"]});
      const automatic = this.addWidget("toggle", "自动同步", false, value => {
        this.properties.autoSync = !!value;
        this._h3SyncSignature = null;
      });
      const status = this.addWidget("text", "状态", "选择目标后点击同步", () => {}, {serialize:false});
      const sync = async () => {
        if (this._h3SyncBusy) return;
        this._h3SyncBusy = true;
        try {
          const source = sourceBoard(this);
          const targetId = this.properties.syncTarget;
          const destination = this.graph?.getNodeById(targetId);
          checkTarget(destination);
          const signature = JSON.stringify([source.node.id, targetId, source.manifest, source.settings]);
          status.value = "正在导入并检查素材…";
          const response = await api.fetchApi("/h3_material_sync/import", {
            method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({manifest:source.manifest,settings:source.settings}),
          });
          if (!response.ok) throw new Error(`素材导入失败（${response.status}），请检查文件是否存在`);
          const payload = await response.json();
          if (!Array.isArray(payload.items) || !["width","height","duration"].every(k => Number.isFinite(payload.settings?.[k]) && payload.settings[k] > 0)) throw new Error("素材同步接口不兼容");
          const items = [];
          for (const item of payload.items) items.push(await inspectMedia(api, item));
          const latest = sourceBoard(this);
          if (!this.graph || this.properties.syncTarget !== targetId ||
              JSON.stringify([latest.node.id, targetId, latest.manifest, latest.settings]) !== signature) {
            throw new Error("同步期间来源或目标发生变化，请重新同步");
          }
          const ui = checkTarget(destination);
          const merged = mergeMedia(ui.state, items, source.node.id);
          const dimensions = ["width","height"].map(name => destination.widgets?.find(w => w.name === name));
          if (dimensions.some(w => !w) || !destination.widgets?.some(w => w.name === "generation_seconds")) throw new Error("目标尺寸或时长接口不兼容");
          if (destination.inputs?.some(i => ["width","height","generation_seconds"].includes(i.name) && i.link != null)) throw new Error("目标宽、高或时长已由连线控制，请断开对应参数连线后同步");
          const previous = ui.state;
          const previousDimensions = dimensions.map(w => w.value);
          try {
            merged.state.selection.duration = payload.settings.duration;
            dimensions.forEach(w => { w.value = payload.settings[w.name]; });
            ui.state = merged.state;
            ui.sync();
            ui.render();
          } catch (error) {
            ui.state = previous;
            dimensions.forEach((w, index) => { w.value = previousDimensions[index]; });
            ui.sync();
            throw error;
          }
          this._h3SyncSignature = signature;
          status.value = `已同步 ${payload.settings.width}×${payload.settings.height} / ${payload.settings.duration}秒；新增${merged.added} 更新${merged.updated}`;
        } catch (error) {
          status.value = error.message;
          // Pause on failure instead of retrying a broken interface repeatedly.
          this.properties.autoSync = false;
          automatic.value = false;
        } finally {
          this._h3SyncBusy = false;
          this.setDirtyCanvas?.(true, true);
        }
      };
      this.addWidget("button", "同步素材", null, sync, {serialize:false});
      this._h3SyncTimer = setInterval(() => {
        if (!this.graph || !this.properties.autoSync || this._h3SyncBusy) return;
        try {
          const source = sourceBoard(this);
          const signature = JSON.stringify([source.node.id, this.properties.syncTarget, source.manifest, source.settings]);
          if (signature !== this._h3SyncSignature) void sync();
        } catch (error) { status.value = error.message; }
      }, 1500);
      this._h3RestoreSync = () => {
        target.value = choices().find(s => s.split(" · ")[0] === String(this.properties.syncTarget)) || "请选择";
        automatic.value = !!this.properties.autoSync;
      };
      this.size = [380, this.computeSize()[1]];
      return result;
    };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function() {
      const result = configure?.apply(this, arguments);
      setTimeout(() => {
        // Saved workflows can restore the obsolete STRING output and its link.
        while (this.outputs?.length) this.removeOutput(this.outputs.length - 1);
        this._h3RestoreSync?.();
      }, 0);
      return result;
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function() {
      clearInterval(this._h3SyncTimer);
      return removed?.apply(this, arguments);
    };
  },
});
