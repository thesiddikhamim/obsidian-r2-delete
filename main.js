const { Plugin, Notice, Modal, PluginSettingTab, Setting, FuzzySuggestModal } = require("obsidian");

// Matches any embedded file: image, audio, video, pdf
const EMBED_REGEX = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;

class R2DeletePlugin extends Plugin {
  async onload() {
    this.settings = await this.loadData() || {
      privateWorkerUrl: "",
      privateSecretToken: "",
      publicCdnDomain: "",
      publicWorkerUrl: "",
      publicSecretToken: "",
    };

    this.addSettingTab(new R2DeleteSettingTab(this.app, this));

    this.addCommand({
      id: "delete-r2-file-current-line",
      name: "Delete R2 file(s) on current line",
      editorCallback: async (editor) => {
        await this.deleteEmbedsOnLine(editor, editor.getCursor().line);
      },
    });

    this.addCommand({
      id: "delete-r2-file-pick-from-note",
      name: "Delete R2 file from current note (pick file)",
      editorCallback: async (editor) => {
        const entries = this.getR2EmbedEntriesFromEditor(editor);
        if (!entries.length) {
          new Notice("No R2 embeds found in this note.");
          return;
        }
        new DeleteEmbedPickerModal(this.app, entries, async (entry) => {
          await this.deleteFile(entry.url, editor, entry.lineNumber);
        }).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const cursor = editor.getCursor();
        const matches = this.getR2MatchesFromLine(editor.getLine(cursor.line));
        if (!matches.length) return;

        menu.addItem((item) => {
          item
            .setTitle("Delete file from R2")
            .setIcon("trash")
            .onClick(async () => {
              await this.deleteMatchedEmbeds(matches, editor, cursor.line);
            });
        });
      })
    );
  }

  detectUrlType(url) {
    try {
      const hostname = new URL(url).hostname;

      if (this.settings.privateWorkerUrl) {
        const privateHostname = new URL(this.settings.privateWorkerUrl).hostname;
        if (hostname === privateHostname) return "private";
      }

      if (this.settings.publicCdnDomain) {
        const publicHostname = new URL(
          this.settings.publicCdnDomain.startsWith("http")
            ? this.settings.publicCdnDomain
            : "https://" + this.settings.publicCdnDomain
        ).hostname;
        if (hostname === publicHostname) return "public";
      }
    } catch (e) {
      console.error("detectUrlType error:", e);
    }
    return null;
  }

  getR2MatchesFromLine(line) {
    const matches = [...line.matchAll(EMBED_REGEX)];
    return matches.filter((m) => this.detectUrlType(m[1]) !== null);
  }

  async deleteEmbedsOnLine(editor, lineNumber) {
    const line = editor.getLine(lineNumber);
    const matches = this.getR2MatchesFromLine(line);
    if (!matches.length) {
      new Notice("No R2 embed found on this line.");
      return;
    }
    await this.deleteMatchedEmbeds(matches, editor, lineNumber);
  }

  getR2EmbedEntriesFromEditor(editor) {
    const entries = [];
    const lineCount = editor.lineCount();
    for (let i = 0; i < lineCount; i++) {
      const line = editor.getLine(i);
      const matches = this.getR2MatchesFromLine(line);
      for (const match of matches) {
        entries.push({ lineNumber: i, url: match[1] });
      }
    }
    return entries;
  }

  async deleteMatchedEmbeds(matches, editor, lineNumber) {
    for (const match of matches) {
      await this.deleteFile(match[1], editor, lineNumber);
    }
  }

  extractKey(fileUrl) {
    try {
      const urlObj = new URL(fileUrl);
      return decodeURIComponent(urlObj.pathname.slice(1));
    } catch (e) {
      console.error("Failed to parse URL:", fileUrl, e);
      return null;
    }
  }

  async deleteFile(fileUrl, editor, lineNumber) {
    const type = this.detectUrlType(fileUrl);
    if (!type) {
      new Notice("URL does not match any configured R2 domain.");
      return;
    }

    const workerUrl = type === "private"
      ? this.settings.privateWorkerUrl
      : this.settings.publicWorkerUrl;

    const token = type === "private"
      ? this.settings.privateSecretToken
      : this.settings.publicSecretToken;

    if (!workerUrl) {
      new Notice(`No worker URL configured for ${type} files.`);
      return;
    }

    const key = this.extractKey(fileUrl);
    if (!key) {
      new Notice("Could not extract file key from URL");
      return;
    }

    const confirmed = await this.confirmDelete(key, type);
    if (!confirmed) return;

    try {
      const encodedKey = key
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");

      // Append &bucket=public so the worker routes to the correct R2 bucket
      const bucketParam = type === "public" ? "&bucket=public" : "";
      const deleteUrl = `${workerUrl}/${encodedKey}?t=${encodeURIComponent(token)}${bucketParam}`;

      console.log(`Deleting [${type}]:`, deleteUrl);

      const response = await fetch(deleteUrl, { method: "DELETE" });
      const responseText = await response.text();
      console.log("Delete response:", response.status, responseText);

      if (response.ok) {
        this.removeLine(editor, lineNumber);
        new Notice(`✅ File deleted from R2 (${type})`);
      } else if (response.status === 401) {
        new Notice("❌ Unauthorized — check your secret token");
      } else if (response.status === 404) {
        new Notice("⚠️ File not found in R2 — removing line anyway");
        this.removeLine(editor, lineNumber);
      } else {
        new Notice(`❌ Delete failed: ${response.status} — ${responseText}`);
        console.error("Delete failed:", response.status, responseText);
      }
    } catch (err) {
      new Notice("❌ Network error — are you online?");
      console.error("Network error:", err);
    }
  }

  removeLine(editor, lineNumber) {
    const lineCount = editor.lineCount();
    if (lineNumber < lineCount - 1) {
      editor.replaceRange("", { line: lineNumber, ch: 0 }, { line: lineNumber + 1, ch: 0 });
    } else {
      editor.replaceRange("", { line: lineNumber, ch: 0 }, { line: lineNumber, ch: editor.getLine(lineNumber).length });
    }
  }

  confirmDelete(key, type) {
    return new Promise((resolve) => {
      new ConfirmModal(this.app, key, type, resolve).open();
    });
  }
}

class ConfirmModal extends Modal {
  constructor(app, key, type, callback) {
    super(app);
    this.key = key;
    this.type = type;
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Permanently delete from R2?" });

    const badge = contentEl.createEl("span", { text: this.type.toUpperCase() });
    badge.style.cssText = `
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: bold; margin-bottom: 10px;
      background: ${this.type === "public" ? "#2563eb" : "#7c3aed"}; color: white;
    `;

    contentEl.createEl("p", { text: "File:" });
    const code = contentEl.createEl("code", { text: this.key });
    code.style.cssText = "display:block;padding:6px;border-radius:4px;margin-bottom:16px;word-break:break-all;";

    contentEl.createEl("p", { text: "This cannot be undone.", cls: "mod-warning" });

    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = "display:flex;gap:10px;margin-top:16px;";

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => { this.callback(false); this.close(); };

    const deleteBtn = btnRow.createEl("button", { text: "Delete permanently" });
    deleteBtn.addClass("mod-warning");
    deleteBtn.style.cssText = "color:red;font-weight:bold;";
    deleteBtn.onclick = () => { this.callback(true); this.close(); };

    setTimeout(() => cancelBtn.focus(), 50);
  }

  onClose() { this.contentEl.empty(); }
}

class DeleteEmbedPickerModal extends FuzzySuggestModal {
  constructor(app, entries, onChoose) {
    super(app);
    this.entries = entries;
    this.onChoose = onChoose;
    this.setPlaceholder("Select an R2 embed to delete...");
  }

  getItems() { return this.entries; }

  getItemText(item) {
    const key = item.url.replace(/^https?:\/\/[^/]+\//, "");
    return `Line ${item.lineNumber + 1}: ${key}`;
  }

  onChooseItem(item) { this.onChoose(item); }
}

class R2DeleteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "R2 File Delete" });
    containerEl.createEl("p", {
      text: "Desktop: right-click an embed to delete. Mobile: use 'Delete R2 file from current note (pick file)' for the most reliable flow.",
    });

    // ── Private ──
    containerEl.createEl("h3", { text: "🔒 Private Bucket" });

    new Setting(containerEl)
      .setName("Private Worker URL")
      .setDesc("Your Cloudflare Worker URL — no trailing slash")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidian-image-worker.thesiddikhamim.workers.dev")
          .setValue(this.plugin.settings.privateWorkerUrl)
          .onChange(async (value) => {
            this.plugin.settings.privateWorkerUrl = value.trim().replace(/\/$/, "");
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Private Secret Token")
      .setDesc("Token used to authenticate with the worker")
      .addText((text) => {
        text
          .setPlaceholder("your-private-token")
          .setValue(this.plugin.settings.privateSecretToken)
          .onChange(async (value) => {
            this.plugin.settings.privateSecretToken = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
        text.inputEl.type = "password";
      });

    // ── Public ──
    containerEl.createEl("h3", { text: "🌐 Public Bucket" });

    new Setting(containerEl)
      .setName("Public CDN Domain")
      .setDesc("Domain where public files are served from (e.g. cdn.siddikhamim.com)")
      .addText((text) =>
        text
          .setPlaceholder("cdn.siddikhamim.com")
          .setValue(this.plugin.settings.publicCdnDomain)
          .onChange(async (value) => {
            this.plugin.settings.publicCdnDomain = value.trim().replace(/\/$/, "");
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Public Worker URL")
      .setDesc("Same worker URL as private — it handles both buckets")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidian-image-worker.thesiddikhamim.workers.dev")
          .setValue(this.plugin.settings.publicWorkerUrl)
          .onChange(async (value) => {
            this.plugin.settings.publicWorkerUrl = value.trim().replace(/\/$/, "");
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("Public Secret Token")
      .setDesc("Same token as private if using the same worker")
      .addText((text) => {
        text
          .setPlaceholder("your-token")
          .setValue(this.plugin.settings.publicSecretToken)
          .onChange(async (value) => {
            this.plugin.settings.publicSecretToken = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
        text.inputEl.type = "password";
      });
  }
}

module.exports = R2DeletePlugin;
