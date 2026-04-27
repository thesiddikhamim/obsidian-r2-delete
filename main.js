const { Plugin, Notice, Modal, PluginSettingTab, Setting, FuzzySuggestModal } = require("obsidian");

// Matches any embedded file: image, audio, video, pdf
const EMBED_REGEX = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g;

class R2DeletePlugin extends Plugin {
  async onload() {
    this.settings = await this.loadData() || {
      workerUrl: "",
      secretToken: "",
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
        const entries = this.getWorkerEmbedEntriesFromEditor(editor);
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
        const workerMatches = this.getWorkerMatchesFromLine(editor.getLine(cursor.line));
        if (!workerMatches.length) return;

        menu.addItem((item) => {
          item
            .setTitle("Delete file from R2")
            .setIcon("trash")
            .onClick(async () => {
              await this.deleteMatchedEmbeds(workerMatches, editor, cursor.line);
            });
        });
      })
    );
  }

  getWorkerMatchesFromLine(line) {
    if (!this.settings.workerUrl) return [];

    const matches = [...line.matchAll(EMBED_REGEX)];
    if (matches.length === 0) return [];

    let workerHostname;
    try {
      workerHostname = new URL(this.settings.workerUrl).hostname;
    } catch (e) {
      console.error("Invalid worker URL in settings:", this.settings.workerUrl, e);
      return [];
    }

    return matches.filter((m) => m[1].includes(workerHostname));
  }

  async deleteEmbedsOnLine(editor, lineNumber) {
    if (!this.settings.workerUrl) {
      new Notice("Set your Worker URL first in plugin settings.");
      return;
    }

    const line = editor.getLine(lineNumber);
    const workerMatches = this.getWorkerMatchesFromLine(line);
    if (!workerMatches.length) {
      new Notice("No R2 embed found on this line.");
      return;
    }

    await this.deleteMatchedEmbeds(workerMatches, editor, lineNumber);
  }

  getWorkerEmbedEntriesFromEditor(editor) {
    const entries = [];
    const lineCount = editor.lineCount();
    for (let i = 0; i < lineCount; i++) {
      const line = editor.getLine(i);
      const workerMatches = this.getWorkerMatchesFromLine(line);
      for (const match of workerMatches) {
        entries.push({
          lineNumber: i,
          url: match[1],
        });
      }
    }
    return entries;
  }

  async deleteMatchedEmbeds(workerMatches, editor, lineNumber) {
    // If multiple embeds on one line, delete all of them
    for (const match of workerMatches) {
      await this.deleteFile(match[1], editor, lineNumber);
    }
  }

  // Extract the R2 key from a Worker URL
  extractKey(fileUrl) {
    try {
      const urlObj = new URL(fileUrl);
      // pathname looks like /img/images/abc123.png
      // we want: images/abc123.png
      const key = urlObj.pathname.replace(/^\/img\//, "");
      return key;
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
      // Encode each path segment separately to preserve slashes
      const encodedKey = key
        .split("/")
        .map(segment => encodeURIComponent(segment))
        .join("/");

      const deleteUrl = `${this.settings.workerUrl}/img/${encodedKey}?t=${encodeURIComponent(this.settings.secretToken)}`;

      console.log("Deleting:", deleteUrl);

      const response = await fetch(deleteUrl, {
        method: "DELETE",
      });

      const responseText = await response.text();
      console.log("Delete response:", response.status, responseText);

      if (response.ok) {
        // Remove the entire line from the note
        const lineCount = editor.lineCount();
        if (lineNumber < lineCount - 1) {
          editor.replaceRange(
            "",
            { line: lineNumber, ch: 0 },
            { line: lineNumber + 1, ch: 0 }
          );
        } else {
          // Last line — just clear it
          editor.replaceRange(
            "",
            { line: lineNumber, ch: 0 },
            { line: lineNumber, ch: editor.getLine(lineNumber).length }
          );
        }
        new Notice("✅ File deleted from R2");
      } else if (response.status === 401) {
        new Notice("❌ Unauthorized — check your secret token");
      } else if (response.status === 404) {
        new Notice("⚠️ File not found in R2 — removing line anyway");
        editor.replaceRange(
          "",
          { line: lineNumber, ch: 0 },
          { line: lineNumber + 1, ch: 0 }
        );
      } else {
        new Notice(`❌ Delete failed: ${response.status} — ${responseText}`);
        console.error("Delete failed:", response.status, responseText);
      }
    } catch (err) {
      new Notice("❌ Network error — are you online?");
      console.error("Network error:", err);
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

    contentEl.createEl("p", {
      text: "This cannot be undone.",
      cls: "mod-warning",
    });

    const btnRow = contentEl.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "10px";
    btnRow.style.marginTop = "16px";

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      this.callback(false);
      this.close();
    };

    const deleteBtn = btnRow.createEl("button", { text: "Delete permanently" });
    deleteBtn.addClass("mod-warning");
    deleteBtn.style.color = "red";
    deleteBtn.style.fontWeight = "bold";
    deleteBtn.onclick = () => {
      this.callback(true);
      this.close();
    };

    // Focus cancel by default for safety
    setTimeout(() => cancelBtn.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DeleteEmbedPickerModal extends FuzzySuggestModal {
  constructor(app, entries, onChoose) {
    super(app);
    this.entries = entries;
    this.onChoose = onChoose;
    this.setPlaceholder("Select an R2 embed to delete...");
  }

  getItems() {
    return this.entries;
  }

  getItemText(item) {
    const key = item.url.replace(/^https?:\/\/[^/]+\//, "");
    return `Line ${item.lineNumber + 1}: ${key}`;
  }

  onChooseItem(item) {
    this.onChoose(item);
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

    containerEl.createEl("h2", { text: "R2 File Delete" });
    containerEl.createEl("p", {
      text: "Desktop: right-click an embed to delete. Mobile: use 'Delete R2 file from current note (pick file)' for the most reliable flow.",
    });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Your Cloudflare Worker URL — no trailing slash")
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
  }
}

module.exports = R2DeletePlugin;
