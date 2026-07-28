/*
 * Monaco glue for the Explorer.
 *
 * Loaded lazily the first time a file tab opens, so the dashboard itself
 * never pays for the editor. Monaco is vendored and served same-origin under
 * /vendor/monaco (the gateway's CSP allows no CDNs), and its workers are
 * plain same-origin scripts.
 *
 * Models are cached per (repository, path) so switching tabs keeps undo
 * history; the editor instance itself is recreated per mount, which is cheap.
 */

let context;
let monacoPromise;
let editorInstance;
const models = new Map();

export function init(sharedContext) {
  context = sharedContext;
}

function loadMonaco() {
  monacoPromise ??= new Promise((resolve, reject) => {
    window.MonacoEnvironment = {
      getWorkerUrl: () => "/vendor/monaco/vs/base/worker/workerMain.js",
    };
    const loader = document.createElement("script");
    loader.src = "/vendor/monaco/vs/loader.js";
    loader.addEventListener("load", () => {
      const amdRequire = window.require;
      amdRequire.config({ paths: { vs: "/vendor/monaco/vs" } });
      amdRequire(
        ["vs/editor/editor.main"],
        () => resolve(window.monaco),
        (error) => reject(new Error(`Monaco failed to load: ${error}`)),
      );
    });
    loader.addEventListener("error", () => {
      monacoPromise = undefined;
      reject(
        new Error(
          "The Monaco editor assets are not available on this deployment",
        ),
      );
    });
    document.head.append(loader);
  });
  return monacoPromise;
}

function modelKey(repoId, path) {
  return `${repoId}\0${path}`;
}

export function disposeModel(repoId, path) {
  const key = modelKey(repoId, path);
  models.get(key)?.model.dispose();
  models.delete(key);
}

async function fetchFile(repoId, path) {
  const base =
    `/projects/${encodeURIComponent(context.state.projectId)}` +
    `/repositories/${encodeURIComponent(repoId)}/workspace`;
  const response = await context.api(
    `${base}/file?path=${encodeURIComponent(path)}`,
  );
  return response.file;
}

async function saveFile(repoId, path, content) {
  const base =
    `/projects/${encodeURIComponent(context.state.projectId)}` +
    `/repositories/${encodeURIComponent(repoId)}/workspace`;
  await context.api(`${base}/file`, {
    method: "POST",
    body: { path, content },
  });
}

/** Renders the toolbar + Monaco mount for one file tab. */
export async function openFile(container, tab) {
  const { repoId, path } = tab.data;
  const monaco = await loadMonaco();
  const file = await fetchFile(repoId, path);
  if (context.activeTab() !== tab) {
    return;
  }

  const readOnly = context.canEdit ? !context.canEdit() : false;
  container.innerHTML = `
    <div class="editor-frame">
      <div class="editor-toolbar">
        <span class="path">${context.escapeHtml(repoId)} / ${context.escapeHtml(
          path,
        )}</span>
        ${
          file.binary
            ? '<span class="chip">binary</span>'
            : file.truncated
              ? '<span class="chip warn">truncated preview</span>'
              : ""
        }
        ${readOnly ? '<span class="chip">read-only</span>' : ""}
        <span class="muted" data-editor-status></span>
        <button class="mini-button" data-editor-save ${
          readOnly || file.binary || file.truncated ? "disabled" : ""
        }>Save (Ctrl+S)</button>
      </div>
      <div class="editor-mount"></div>
    </div>`;

  const mount = container.querySelector(".editor-mount");
  if (file.binary) {
    mount.innerHTML =
      '<div class="editor-placeholder"><div><h2>Binary file</h2><p>This file cannot be edited in the browser.</p></div></div>';
    return;
  }

  const key = modelKey(repoId, path);
  let entry = models.get(key);
  if (entry === undefined) {
    const uri = monaco.Uri.from({
      scheme: "relay",
      path: `/${repoId}/${path}`,
    });
    const model = monaco.editor.createModel(file.content, undefined, uri);
    entry = { model, savedVersion: model.getAlternativeVersionId() };
    models.set(key, entry);
  } else if (
    !context.state.dirtyFiles.has(path) &&
    entry.model.getValue() !== file.content
  ) {
    // The workspace changed underneath a clean model (terminal command,
    // reset, another window). A dirty model is never clobbered.
    entry.model.setValue(file.content);
    entry.savedVersion = entry.model.getAlternativeVersionId();
  }

  editorInstance?.dispose();
  editorInstance = monaco.editor.create(mount, {
    model: entry.model,
    theme: "vs-dark",
    automaticLayout: true,
    readOnly: readOnly || file.truncated === true,
    fontSize: 13,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
  });

  const statusTarget = container.querySelector("[data-editor-status]");
  const saveButton = container.querySelector("[data-editor-save]");

  const updateDirty = () => {
    const dirty =
      entry.model.getAlternativeVersionId() !== entry.savedVersion;
    context.markDirty(path, dirty);
    if (statusTarget) {
      statusTarget.textContent = dirty ? "unsaved changes" : "";
    }
  };
  entry.model.onDidChangeContent(updateDirty);
  updateDirty();

  const save = async () => {
    if (readOnly || file.binary || file.truncated) {
      return;
    }
    try {
      saveButton?.setAttribute("disabled", "");
      await saveFile(repoId, path, entry.model.getValue());
      entry.savedVersion = entry.model.getAlternativeVersionId();
      updateDirty();
      context.toast(`Saved ${path}`);
      context.onSaved?.();
    } catch (error) {
      context.toast(error.message, "error");
    } finally {
      saveButton?.removeAttribute("disabled");
    }
  };

  saveButton?.addEventListener("click", () => void save());
  editorInstance.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => void save(),
  );
  editorInstance.focus();
}
