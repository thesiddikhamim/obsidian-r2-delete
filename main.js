const { Plugin, Notice, Modal, PluginSettingTab, Setting } = require("obsidian");

class R2DeletePlugin extends Plugin {
  async onload() {
    this.settings = await this.loadData() || {
      workerUrl: "",
      secretToken: "",
    };

    this.addSettingTab(new R2DeleteSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        // Match image markdown syntax
        const match = line.match(/!\[.*?\]\((https?:\/\/[^\)]+)\)/);
        if (!match) return;

        const imageUrl = match[1];

        // Only show menu for images from your worker
        if (!this.settings.workerUrl || !imageUrl.includes(this.settings.workerUrl)) return;

        menu.addItem((item) => {
          item
            .setTitle("Delete image from R2")
            .setIcon("trash")
            .onClick(async () => {
              await this.deleteImage(imageUrl, editor, cursor.line);
            });
        });
      })
    );
  }

  async deleteImage(imageUrl, editor, lineNumber) {
    // Extract key from URL
    // URL: https://worker.../img/images/abc123.png?t=token
    // Key: images/abc123.png
    const urlObj = new URL(imageUrl);
    const key = urlObj.pathname.replace("/img/", "");

    const confirmed = await this.confirmDelete(key);
    if (!confirmed) return;

    try {
      const deleteUrl = `${this.settings.workerUrl}/img/${encodeURIComponent(key)}?t=${this.settings.secretToken}`;

      const response = await fetch(deleteUrl, {
        method: "DELETE",
      });

      if (response.ok) {
        // Remove the entire image line from the note
        editor.replaceRange(
          "",
          { line: lineNumber, ch: 0 },
          { line: lineNumber + 1, ch: 0 }
        );
        new Notice("Image deleted from R2");
      } else {
        const text = await response.text();
        new Notice("Delete failed: " + text);
        console.error("Delete failed:", text);
      }
    } catch (err) {
      new Notice("Network error — check console");
      console.error(err);
    }
  }

  confirmDelete(key) {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, key, resolve);
      modal.open();
    });
  }
}

class ConfirmModal extends Modal {
  constructor(app, key, callback) {
    super(app);
    this.key = key;
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Delete Image?" });
    contentEl.createEl("p", {
      text: `This will permanently delete from R2:`
    });
    contentEl.createEl("code", { text: this.key });

    const btnRow = contentEl.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "20px";

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      this.callback(false);
      this.close();
    };

    const deleteBtn = btnRow.createEl("button", { text: "Delete" });
    deleteBtn.style.color = "red";
    deleteBtn.onclick = () => {
      this.callback(true);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

class R2DeleteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "R2 Image Delete" });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Your Worker URL with no trailing slash")
      .addText(text => text
        .setPlaceholder("https://obsidian-image-worker.thesiddikhamim.workers.dev")
        .setValue(this.plugin.settings.workerUrl)
        .onChange(async (value) => {
          this.plugin.settings.workerUrl = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("Secret Token")
      .setDesc("Same token you set with wrangler secret put")
      .addText(text => text
        .setPlaceholder("hamim2025xk92mf")
        .setValue(this.plugin.settings.secretToken)
        .onChange(async (value) => {
          this.plugin.settings.secretToken = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}

module.exports = R2DeletePlugin;