const { Plugin, Notice, Modal, PluginSettingTab, Setting, FuzzySuggestModal } = require("obsidian");

// Matches markdown embeds: ![anything](url)
const EMBED_REGEX_MD = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;
// Matches HTML src/href attributes: <video src="url"> <audio src="url"> etc
const EMBED_REGEX_HTML = /(?:src|href)="(https?:\/\/[^"]+)"/g;

class R2DeletePlugin extends Plugin {
  async onload() {
    this.settings = await this.loadData() || {
      workerUrl: "",
      secretToken: "",
      publicDomains: "",
    };

    this.addSettingTab(new R2DeleteSettingTab(this.app, this));

    // Command: delete file on current line
    this.addCommand({
      id: "delete-r2-file-current-line",
      name: "Delete R2 file(s) on current line",
      editorCallback: async (editor) => {
        const lineNumber = editor.getCursor().line;
        const line = editor.getLine(lineNumber);
        const urls = this.extractRecognizedUrls(line);
        if (!urls.length) {
          new Notice("No R2 embed found on this line.");
          return;
        }
        for (const url of urls) {
          await this.deleteFile(url, editor, lineNumber);
        }
      },
    });

    // Command: pick from all embeds in current note
    this.addCommand({
      id: "delete-r2-file-pick-from-note",
      name: "Delete R2 file from current note (pick file)",
      editorCallback: async (editor) => {
        const entries = this.getAllEmbedEntries(editor);
        if (!entries.length) {
          new Notice("No R2 embeds found in this note.");
          return;
        }
        new DeleteEmbedPickerModal(this.app, entries, async (entry) => {
          await this.deleteFile(entry.url, editor, entry.lineNumber);
        }).open();
      },
    });

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const urls = this.extractRecognizedUrls(line);
        if (!urls.length) return;

        menu.addItem((item) => {
          item
            .setTitle("Delete file from R2")
            .setIcon("trash")
            .onClick(async () => {
              for (const url of urls) {
                await this.deleteFile(url, editor, cursor.line);
              }
            });
        });
      })
    );
  }

  // Returns list of recognized hostnames from settings
  getRecognizedHosts() {
    const hosts = [];

    if (this.settings.workerUrl) {
      try {
        hosts.push(new URL(this.settings.workerUrl).hostname);
      } catch { }
    }

    if (this.settings.publicDomains) {
      const domains = this.settings.publicDomains
        .split(",")
        .map(d => d.trim())
        .filter(Boolean);
      hosts.push(...domains);
    }

    return hosts;
  }

  // Extract all recognized R2 URLs from a line (both markdown and HTML)
  extractRecognizedUrls(line) {
    const recognizedHosts = this.getRecognizedHosts();
    if (!recognizedHosts.length) return [];

    const urls = [];

    for (const match of [...line.matchAll(EMBED_REGEX_MD)]) {
      urls.push(match[1]);
    }
    for (const match of [...line.matchAll(EMBED_REGEX_HTML)]) {
      urls.push(match[1]);
    }

    return urls.filter(u => {
      try {
        return recognizedHosts.includes(new URL(u).hostname);
      } catch { return false; }
    });
  }

  // Get all embed entries across the entire note
  getAllEmbedEntries(editor) {
    const entries = [];
    const lineCount = editor.lineCount();
    for (let i = 0; i < lineCount; i++) {
      const urls = this.extractRecognizedUrls(editor.getLine(i));
      for (const url of urls) {
        entries.push({ lineNumber: i, url });
      }
    }
    return entries;
  }

  // Extract the R2 key from any recognized URL
  extractKey(fileUrl) {
    try {
      const urlObj = new URL(fileUrl);
      const hostname = urlObj.hostname;

      let workerHostname = "";
      try {
        workerHostname = new URL(this.settings.workerUrl).hostname;
      } catch { }

      if (hostname === workerHostname) {
        // Worker URL: /img/folder/file.png → folder/file.png
        return urlObj.pathname.replace(/^\/img\//, "");
      } else {
        // Public R2 URL: /folder/file.png → folder/file.png
        return urlObj.pathname.replace(/^\//, "");
      }
    } catch (e) {
      console.error("Failed to parse URL:", fileUrl, e);
      return null;
    }
  }

  async deleteFile(fileUrl, editor, lineNumber) {
    const key = this.extractKey(fileUrl);
    if (!key) {
      new Notice("Could not extract file key from URL");
      return;
    }

    const confirmed = await this.confirmDelete(key);
    if (!confirmed) return;

    try {
      // Encode each path segment separately — preserves slashes
      const encodedKey = key
        .split("/")
        .map(seg => encodeURIComponent(seg))
        .join("/");

      const deleteUrl = `${this.settings.workerUrl}/img/${encodedKey}?t=${encodeURIComponent(this.settings.secretToken)}`;

      console.log("Deleting:", deleteUrl);

      const response = await fetch(deleteUrl, { method: "DELETE" });
      const responseText = await response.text();

      console.log("Delete response:", response.status, responseText);

      if (response.ok) {
        this.removeLine(editor, lineNumber);
        new Notice("✅ File deleted from R2");
      } else if (response.status === 401) {
        new Notice("❌ Unauthorized — check your secret token in settings");
      } else if (response.status === 404) {
        new Notice("⚠️ File not found in R2 — removing line anyway");
        this.removeLine(editor, lineNumber);
      } else {
        new Notice(`❌ Delete failed: ${response.status}`);
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
      editor.replaceRange(
        "",
        { line: lineNumber, ch: 0 },
        { line: lineNumber + 1, ch: 0 }
      );
    } else {
      editor.replaceRange(
        "",
        { line: lineNumber, ch: 0 },
        { line: lineNumber, ch: editor.getLine(lineNumber).length }
      );
    }
  }

  confirmDelete(key) {
    return new Promise((resolve) => {
      new ConfirmModal(this.app, key, resolve).open();
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

    contentEl.createEl("h3", { text: "Permanently delete from R2?" });
    contentEl.createEl("p", { text: "File:" });

    const code = contentEl.createEl("code", { text: this.key });
    code.style.display = "block";
    code.style.padding = "6px";
    code.style.borderRadius = "4px";
    code.style.marginBottom = "16px";
    code.style.wordBreak = "break-all";

    contentEl.createEl("p", { text: "This cannot be undone." });

    const btnRow = contentEl.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "16px";

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => { this.callback(false); this.close(); };

    const deleteBtn = btnRow.createEl("button", { text: "Delete permanently" });
    deleteBtn.style.color = "red";
    deleteBtn.style.fontWeight = "bold";
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
    this.setPlaceholder("Select a file to delete from R2...");
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
      text: "Supports images, videos, audio, and PDFs. Works with Worker URLs and public R2 URLs.",
    });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Your Cloudflare Worker URL — no trailing slash. Always required for deletion.")
      .addText(text => text
        .setPlaceholder("https://obsidian-image-worker.thesiddikhamim.workers.dev")
        .setValue(this.plugin.settings.workerUrl)
        .onChange(async (value) => {
          this.plugin.settings.workerUrl = value.trim().replace(/\/$/, "");
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("Secret Token")
      .setDesc("The token you set with wrangler secret put")
      .addText(text => {
        text
          .setPlaceholder("hamim2025xk92mf")
          .setValue(this.plugin.settings.secretToken)
          .onChange(async (value) => {
            this.plugin.settings.secretToken = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Public R2 Domains")
      .setDesc("Comma separated hostnames only — no https://. Example: pub-abc123.r2.dev, img.siddikhamim.com")
      .addText(text => text
        .setPlaceholder("pub-abc123.r2.dev, img.siddikhamim.com")
        .setValue(this.plugin.settings.publicDomains || "")
        .onChange(async (value) => {
          this.plugin.settings.publicDomains = value.trim();
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}

module.exports = R2DeletePlugin;
