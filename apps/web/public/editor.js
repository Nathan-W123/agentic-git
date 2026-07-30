/*
 * Monaco glue for the Explorer, plus live multi-user editing.
 *
 * Loaded lazily the first time a file tab opens, so the dashboard itself
 * never pays for the editor. Monaco is vendored and served same-origin under
 * /vendor/monaco (the gateway's CSP allows no CDNs), and its workers are
 * plain same-origin scripts.
 *
 * Models are cached per (repository, path) so switching tabs keeps undo
 * history; the editor instance itself is recreated per mount, which is cheap.
 *
 * ## Collaboration
 *
 * Opening a file also tries to open a collaboration socket. If it connects,
 * the shared document becomes the source of truth: local edits go out as
 * operations, remote ones come back and are applied to the model, and Save
 * flushes the shared text into the owning workspace. If it does not connect —
 * no permission, no engine build, an old deployment — everything falls back to
 * the single-user path this file has always used: fetch over HTTP, save over
 * HTTP. Collaboration is strictly additive.
 *
 * The transform engine is the *same build* the gateway runs, served from
 * /vendor/collab. Two implementations of operational transformation would be
 * two chances to diverge.
 */

let context;
let monacoPromise;
let collabPromise;
let editorInstance;
const models = new Map();
/**
 * Live sessions, keyed exactly like models.
 *
 * A file tab re-renders whenever the workspace is refreshed, so `openFile` runs
 * many times for one open file. Sessions must therefore outlive a render and be
 * reused: building a second session over the same model would put two sockets
 * and two change listeners on one document, and each would apply the other's
 * echo as a remote edit — a feedback loop that grows the file without bound.
 * A session is torn down when its tab closes, via `disposeModel`.
 */
const sessions = new Map();

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

/** Resolves to the shared OT engine, or undefined if it is not deployed. */
function loadCollabEngine() {
  collabPromise ??= import("/vendor/collab/index.js").catch(() => undefined);
  return collabPromise;
}

function modelKey(repoId, path) {
  return `${repoId}\u0000${path}`;
}

export function disposeModel(repoId, path) {
  const key = modelKey(repoId, path);
  sessions.get(key)?.dispose();
  sessions.delete(key);
  models.get(key)?.model.dispose();
  models.delete(key);
}

function workspaceBase(repoId) {
  return (
    `/projects/${encodeURIComponent(context.state.projectId)}` +
    `/repositories/${encodeURIComponent(repoId)}/workspace`
  );
}

async function fetchFile(repoId, path) {
  const response = await context.api(
    `${workspaceBase(repoId)}/file?path=${encodeURIComponent(path)}`,
  );
  return response.file;
}

async function saveFile(repoId, path, content) {
  await context.api(`${workspaceBase(repoId)}/file`, {
    method: "POST",
    body: { path, content },
  });
}

/**
 * Whose workspace to join.
 *
 * A share link carries `?collabOwner=<userId>`, which survives the dashboard's
 * hash routing untouched. Absent, you address your own overlay — which is what
 * makes a solo session behave exactly like it did before any of this existed.
 */
function requestedOwner() {
  const owner = new URLSearchParams(location.search).get("collabOwner");
  return owner !== null && owner.length > 0 ? owner : undefined;
}

/* ------------------------------------------------------ live sessions ---- */

/** Class-name-safe id. Participant ids are server-issued UUIDs; belt and braces. */
function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, "");
}

/** Escapes a string for use inside a CSS `content:` declaration. */
function cssString(value) {
  // JSON.stringify handles quotes and backslashes; control characters are
  // dropped outright so a crafted display name cannot break out of the rule.
  return JSON.stringify(
    String(value).replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 60),
  );
}

/**
 * Turns a Monaco content-change event into one operation over the document as
 * it was *before* the event.
 *
 * Monaco reports simultaneous changes with offsets against the pre-event text,
 * in descending order; sorting them ascending lets a single left-to-right walk
 * build the operation.
 */
function changesToComponents(changes, previousLength) {
  const ordered = [...changes].sort((left, right) => left.rangeOffset - right.rangeOffset);
  const components = [];
  let cursor = 0;
  for (const change of ordered) {
    if (change.rangeOffset > cursor) {
      components.push(change.rangeOffset - cursor);
    }
    if (change.rangeLength > 0) {
      components.push(-change.rangeLength);
    }
    if (change.text.length > 0) {
      components.push(change.text);
    }
    cursor = change.rangeOffset + change.rangeLength;
  }
  if (previousLength > cursor) {
    components.push(previousLength - cursor);
  }
  return components;
}

/** Turns an operation into Monaco edits, all against pre-edit offsets. */
function operationToEdits(monaco, model, operation) {
  const edits = [];
  let offset = 0;
  for (const component of operation.components) {
    if (typeof component === "string") {
      const at = model.getPositionAt(offset);
      edits.push({
        range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column),
        text: component,
        forceMoveMarkers: true,
      });
    } else if (component > 0) {
      offset += component;
    } else {
      const end = offset - component;
      const from = model.getPositionAt(offset);
      const to = model.getPositionAt(end);
      edits.push({
        range: new monaco.Range(
          from.lineNumber,
          from.column,
          to.lineNumber,
          to.column,
        ),
        text: "",
      });
      offset = end;
    }
  }
  return edits;
}

/**
 * One live editing session: a socket, an OT client, and the decorations that
 * show everyone else.
 */
class LiveSession {
  constructor(options) {
    this.monaco = options.monaco;
    this.engine = options.engine;
    this.model = options.model;
    this.repoId = options.repoId;
    this.path = options.path;
    this.owner = options.owner;
    this.onPresence = options.onPresence;
    this.onStatus = options.onStatus;

    this.socket = undefined;
    this.client = undefined;
    this.participantId = undefined;
    this.participants = new Map();
    this.agents = [];
    this.applyingRemote = false;
    this.previousLength = options.model.getValueLength();
    this.decorations = new Map();
    this.disposed = false;
    this.editor = undefined;
    this.pendingSelection = false;
    this.styleElement = undefined;
    this.contentListener = undefined;
    this.selectionListener = undefined;
  }

  matches(repoId, path) {
    return this.repoId === repoId && this.path === path;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN && this.client !== undefined;
  }

  /** Connects once; later callers get the same answer rather than a new socket. */
  connect() {
    this.ready ??= this.openSocket();
    return this.ready;
  }

  openSocket() {
    return new Promise((resolve) => {
      const parameters = new URLSearchParams({
        projectId: context.state.projectId,
        repositoryId: this.repoId,
        path: this.path,
      });
      if (this.owner !== undefined) {
        parameters.set("owner", this.owner);
      }
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let socket;
      try {
        socket = new WebSocket(
          `${scheme}://${location.host}/api/v1/collab?${parameters.toString()}`,
        );
      } catch {
        finish(false);
        return;
      }
      this.socket = socket;
      // A socket that never reaches `welcome` must not hold the tab open.
      const timer = setTimeout(() => {
        if (!settled) {
          socket.close();
          finish(false);
        }
      }, 8_000);
      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.receive(message);
        if (message.type === "welcome") {
          clearTimeout(timer);
          finish(true);
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        finish(false);
        this.client = undefined;
        this.participants.clear();
        this.renderPresence();
        if (!this.disposed) {
          this.onStatus?.({ connected: false });
        }
      });
    });
  }

  receive(message) {
    switch (message.type) {
      case "welcome":
        this.onWelcome(message);
        return;
      case "ack": {
        const action = this.client?.acknowledge();
        this.flush(action);
        // Monaco moves the caret *after* it reports the content change, so the
        // selection that rode out with the operation was one keystroke stale.
        // Becoming synchronized is the first moment a correct one can be sent.
        if (this.pendingSelection) {
          this.reportSelection();
        }
        this.onStatus?.({ connected: true, dirty: true });
        return;
      }
      case "op": {
        const operation = this.engine.parseOperation(message.operation);
        const action = this.client?.applyServer(operation);
        if (action?.apply !== undefined) {
          this.applyRemote(action.apply);
        }
        this.flush(action);
        // Somebody else's keystroke leaves the shared buffer unsaved too.
        this.onStatus?.({ connected: true, dirty: true });
        return;
      }
      case "selection": {
        const participant = this.participants.get(message.participantId);
        if (participant !== undefined) {
          participant.selection = message.selection;
          this.renderCarets();
        }
        return;
      }
      case "join":
        this.participants.set(message.participant.id, { ...message.participant });
        this.renderPresence();
        return;
      case "leave":
        this.participants.delete(message.participantId);
        this.decorations.get(message.participantId)?.clear();
        this.decorations.delete(message.participantId);
        this.renderPresence();
        return;
      case "saved":
        this.onStatus?.({ connected: true, dirty: false, savedBy: message.savedBy });
        return;
      case "agents":
        this.agents = message.agents ?? [];
        this.renderPresence();
        return;
      case "error":
        if (message.fatal) {
          // The local view cannot be rebased onto the server's; take a fresh
          // snapshot rather than letting the two drift apart silently.
          this.send({ type: "resync" });
        } else {
          context.toast(message.message, "error");
        }
        return;
      default:
    }
  }

  onWelcome(message) {
    this.participantId = message.participantId;
    this.ownerUserId = message.ownerUserId;
    this.client = new this.engine.CollaborativeClient(message.revision);
    this.participants = new Map(
      message.participants
        .filter((participant) => participant.id !== message.participantId)
        .map((participant) => [participant.id, { ...participant }]),
    );
    this.self = message.participants.find(
      (participant) => participant.id === message.participantId,
    );
    this.agents = message.agents ?? [];
    if (this.model.getValue() !== message.content) {
      this.applyingRemote = true;
      try {
        // A full replacement only happens on (re)join, when the local buffer
        // has no unacknowledged work to lose.
        this.model.setValue(message.content);
      } finally {
        this.applyingRemote = false;
      }
    }
    this.previousLength = this.model.getValueLength();
    this.renderPresence();
    this.renderCarets();
    this.onStatus?.({ connected: true, dirty: message.dirty });
    this.reportSelection();
  }

  attach(editor) {
    if (this.editor !== undefined && this.editor !== editor) {
      // A decoration collection belongs to the editor instance that created
      // it. Re-rendering the tab disposes that editor, and the old collections
      // then silently accept `set()` without drawing anything — remote carets
      // vanish for good. Drop them so they are rebuilt against the new editor;
      // the disposed editor took its own decorations with it.
      this.decorations.clear();
    }
    this.editor = editor;
    this.contentListener?.dispose();
    this.selectionListener?.dispose();
    this.contentListener = this.model.onDidChangeContent((event) => {
      this.onLocalChange(event);
    });
    this.selectionListener = editor.onDidChangeCursorSelection(() => {
      this.reportSelection();
    });
    this.renderCarets();
  }

  onLocalChange(event) {
    const previousLength = this.previousLength;
    this.previousLength = this.model.getValueLength();
    if (this.applyingRemote || this.client === undefined) {
      return;
    }
    let operation;
    try {
      operation = this.engine.createOperation(
        changesToComponents(event.changes, previousLength),
      );
    } catch {
      return;
    }
    if (operation.baseLength !== previousLength) {
      // The model moved in a way this cannot describe; resynchronize instead
      // of sending an operation that would corrupt everyone's document.
      this.send({ type: "resync" });
      return;
    }
    if (this.engine.isIdentityOperation(operation)) {
      return;
    }
    const action = this.client.applyLocal(operation);
    this.flush(action);
  }

  flush(action) {
    if (action?.send === undefined) {
      return;
    }
    this.send({
      type: "op",
      revision: action.send.revision,
      operation: action.send.operation.components,
      selection: this.localSelection(),
    });
    this.pendingSelection = false;
  }

  localSelection() {
    const selection = this.editor?.getSelection();
    if (selection === undefined || selection === null) {
      return undefined;
    }
    // Anchor and head, not start and end: a backwards selection puts the
    // caret at the *start*, and drawing it at the end would be wrong.
    return {
      anchor: this.model.getOffsetAt({
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn,
      }),
      head: this.model.getOffsetAt({
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn,
      }),
    };
  }

  /**
   * Reports the caret, but only while synchronized.
   *
   * With work still in flight the local offsets are ahead of the server's, and
   * a caret sent in the wrong coordinate system would land somewhere arbitrary
   * on everyone else's screen. Acks arrive in milliseconds, so the update just
   * waits for the next one.
   */
  reportSelection() {
    if (!this.connected || this.client === undefined) {
      return;
    }
    if (!this.client.synchronized) {
      this.pendingSelection = true;
      return;
    }
    const selection = this.localSelection();
    if (selection === undefined) {
      return;
    }
    this.send({
      type: "selection",
      revision: this.client.revision,
      selection,
    });
    this.pendingSelection = false;
  }

  applyRemote(operation) {
    this.applyingRemote = true;
    try {
      this.model.applyEdits(operationToEdits(this.monaco, this.model, operation));
    } finally {
      this.applyingRemote = false;
      this.previousLength = this.model.getValueLength();
    }
    // Everyone else's carets moved with the text.
    for (const participant of this.participants.values()) {
      if (participant.selection !== undefined) {
        participant.selection = this.engine.transformSelection(
          participant.selection,
          operation,
        );
      }
    }
    this.renderCarets();
    if (this.pendingSelection) {
      this.reportSelection();
    }
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  save() {
    this.send({ type: "save" });
  }

  /** Rebuilds the per-participant CSS. Colours and names are data, not markup. */
  renderStyles() {
    this.styleElement ??= (() => {
      const element = document.createElement("style");
      element.dataset.collabCursors = "true";
      document.head.append(element);
      return element;
    })();
    const rules = [];
    for (const participant of this.participants.values()) {
      const id = safeId(participant.id);
      const color = /^#[0-9a-fA-F]{6}$/u.test(participant.color)
        ? participant.color
        : "#4cc2ff";
      rules.push(
        `.collab-selection-${id} { background: ${color}33; }`,
        `.collab-caret-${id} { border-left: 2px solid ${color}; margin-left: -1px; }`,
        `.collab-caret-${id}::after {` +
          ` content: ${cssString(participant.displayName)};` +
          ` background: ${color}; }`,
      );
    }
    this.styleElement.textContent = rules.join("\n");
  }

  renderCarets() {
    if (this.editor === undefined) {
      return;
    }
    this.renderStyles();
    const seen = new Set();
    for (const participant of this.participants.values()) {
      seen.add(participant.id);
      let collection = this.decorations.get(participant.id);
      if (collection === undefined) {
        collection = this.editor.createDecorationsCollection([]);
        this.decorations.set(participant.id, collection);
      }
      const selection = participant.selection;
      if (selection === undefined) {
        collection.set([]);
        continue;
      }
      const id = safeId(participant.id);
      const length = this.model.getValueLength();
      const anchor = this.model.getPositionAt(Math.min(selection.anchor, length));
      const head = this.model.getPositionAt(Math.min(selection.head, length));
      const decorations = [
        {
          range: new this.monaco.Range(
            head.lineNumber,
            head.column,
            head.lineNumber,
            head.column,
          ),
          options: {
            className: `collab-caret collab-caret-${id}`,
            stickiness: 1,
          },
        },
      ];
      if (selection.anchor !== selection.head) {
        const [from, to] =
          selection.anchor < selection.head ? [anchor, head] : [head, anchor];
        decorations.push({
          range: new this.monaco.Range(
            from.lineNumber,
            from.column,
            to.lineNumber,
            to.column,
          ),
          options: { className: `collab-selection collab-selection-${id}` },
        });
      }
      collection.set(decorations);
    }
    for (const [participantId, collection] of this.decorations) {
      if (!seen.has(participantId)) {
        collection.clear();
        this.decorations.delete(participantId);
      }
    }
  }

  renderPresence() {
    this.renderStyles();
    this.onPresence?.({
      self: this.self,
      participants: [...this.participants.values()],
      agents: this.agents,
      ownerUserId: this.ownerUserId,
    });
  }

  dispose() {
    this.disposed = true;
    this.contentListener?.dispose();
    this.selectionListener?.dispose();
    for (const collection of this.decorations.values()) {
      collection.clear();
    }
    this.decorations.clear();
    this.styleElement?.remove();
    this.styleElement = undefined;
    if (
      this.socket !== undefined &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.socket.close();
    }
  }
}

/* ------------------------------------------------------------- tab UI ---- */

function presenceMarkup(presence) {
  if (presence === undefined) {
    return "";
  }
  const chips = [];
  for (const participant of presence.participants) {
    const color = /^#[0-9a-fA-F]{6}$/u.test(participant.color)
      ? participant.color
      : "#4cc2ff";
    chips.push(
      `<span class="chip collab-peer"${
        participant.owner ? ' title="Owns this workspace"' : ""
      }><span class="collab-dot" style="background:${color}"></span>${context.escapeHtml(
        participant.displayName,
      )}${participant.owner ? " (host)" : ""}</span>`,
    );
  }
  for (const agent of presence.agents ?? []) {
    chips.push(
      `<span class="chip warn collab-agent" title="${context.escapeHtml(
        agent.objective || "In-flight agent work",
      )}">${context.escapeHtml(agent.agentId)} ${
        agent.stage === "changed" ? "changed this file" : "plans to edit this"
      } · unapproved</span>`,
    );
  }
  return chips.join("");
}

/** Renders the toolbar + Monaco mount for one file tab. */
export async function openFile(container, tab) {
  const { repoId, path } = tab.data;
  const [monaco, engine] = await Promise.all([loadMonaco(), loadCollabEngine()]);
  const owner = requestedOwner();
  let file;
  let fetched = true;
  try {
    file = await fetchFile(repoId, path);
  } catch (error) {
    if (owner === undefined) {
      throw error;
    }
    fetched = false;
    // Joining someone else's session does not require a workspace of your
    // own — the shared document arrives over the socket. An empty placeholder
    // stands in until `welcome` lands, and if the socket never connects the
    // read-only "not being shared" state below explains why.
    file = { path, content: "", size: 0, binary: false, truncated: false };
  }
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
        <span class="collab-presence" data-collab-presence></span>
        <span class="muted" data-editor-status></span>
        <button class="mini-button" data-editor-share hidden>Share</button>
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
    fetched &&
    sessions.get(key)?.connected !== true &&
    !context.state.dirtyFiles.has(path) &&
    entry.model.getValue() !== file.content
  ) {
    // The workspace changed underneath a clean model (terminal command,
    // reset, another window). A dirty model is never clobbered — and neither
    // is a live one: while a session is connected the shared document is the
    // source of truth, and overwriting the model here would broadcast the
    // difference to everyone else as a genuine edit.
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
  const presenceTarget = container.querySelector("[data-collab-presence]");
  const saveButton = container.querySelector("[data-editor-save]");
  const shareButton = container.querySelector("[data-editor-share]");

  let live;
  let liveDirty = false;

  const updateStatus = () => {
    if (live?.connected === true) {
      statusTarget.textContent = liveDirty ? "unsaved changes · live" : "live";
      return;
    }
    const dirty = entry.model.getAlternativeVersionId() !== entry.savedVersion;
    statusTarget.textContent = dirty ? "unsaved changes" : "";
  };

  const updateDirty = () => {
    const dirty =
      live?.connected === true
        ? liveDirty
        : entry.model.getAlternativeVersionId() !== entry.savedVersion;
    context.markDirty(path, dirty);
    updateStatus();
  };
  const localChanges = entry.model.onDidChangeContent(updateDirty);
  updateDirty();

  const save = async () => {
    if (readOnly || file.binary || file.truncated) {
      return;
    }
    if (live?.connected === true) {
      // The shared document is authoritative; the server writes it into the
      // owning workspace and tells everyone in the room.
      live.save();
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

  if (engine !== undefined && !file.truncated && !readOnly) {
    const onPresence = (presence) => {
      presenceTarget.innerHTML = presenceMarkup(presence);
      if (shareButton !== null && session.ownerUserId !== undefined) {
        shareButton.hidden = false;
      }
    };
    const onStatus = (status) => {
      liveDirty = status.dirty === true;
      if (status.savedBy !== undefined) {
        entry.savedVersion = entry.model.getAlternativeVersionId();
        context.toast(`Saved ${path}`);
        context.onSaved?.();
      }
      updateDirty();
    };
    // Reuse the session this file already has; a re-render is not a rejoin.
    let session = sessions.get(key);
    if (session === undefined || session.disposed || session.owner !== owner) {
      session?.dispose();
      sessions.delete(key);
      session = new LiveSession({
        monaco,
        engine,
        model: entry.model,
        repoId,
        path,
        owner,
      });
      sessions.set(key, session);
    }
    // The toolbar is rebuilt on every render, so the callbacks must be
    // re-pointed at the elements that exist now.
    session.onPresence = onPresence;
    session.onStatus = onStatus;
    const connected = await session.connect();
    if (context.activeTab() !== tab) {
      // The user moved on while the socket was negotiating. The session stays
      // alive with the model — it is torn down when the tab actually closes.
      return;
    }
    if (connected) {
      session.attach(editorInstance);
      session.renderPresence();
      live = session;
      shareButton?.addEventListener("click", () => {
        const url = new URL(location.href);
        url.searchParams.set("collabOwner", session.ownerUserId);
        url.hash = `#file/${encodeURIComponent(repoId)}/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;
        void navigator.clipboard
          ?.writeText(url.toString())
          .then(() => context.toast("Live editing link copied"))
          .catch(() => context.toast(url.toString()));
      });
    } else {
      session.dispose();
      sessions.delete(key);
      if (owner !== undefined) {
        // A share link that cannot connect must not quietly drop the user into
        // editing their *own* copy of the file under the impression they are
        // in someone else's session.
        editorInstance.updateOptions({ readOnly: true });
        saveButton?.setAttribute("disabled", "");
        presenceTarget.innerHTML =
          '<span class="chip warn">not being shared — open a copy from the file tree to edit your own</span>';
      }
    }
    updateDirty();
  }

  editorInstance.onDidDispose(() => {
    localChanges.dispose();
  });
  editorInstance.focus();
}
