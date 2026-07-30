/**
 * Live collaborative editing for the dashboard's overlay editor.
 *
 * The package is deliberately transport-free and dependency-free so the same
 * compiled output runs in two places: the gateway imports it as an ordinary
 * workspace dependency, and the browser loads `dist/` directly as a
 * same-origin ES module (the dashboard has no bundler, and the gateway's CSP
 * allows no external scripts). Nothing here may import a Node builtin.
 */

export {
  applyOperation,
  composeOperations,
  createOperation,
  identityOperation,
  isIdentityOperation,
  parseOperation,
  serializeOperation,
  transformOperations,
  transformPosition,
  transformSelection,
  CollabError,
  OperationBuilder,
  MAX_OPERATION_COMPONENTS,
  MAX_OPERATION_INSERT_UNITS,
  type OperationComponent,
  type SelectionRange,
  type TextOperation,
} from "./text-operation.js";

export {
  CollabDocument,
  diffOperation,
  type AppliedOperation,
} from "./document.js";

export {
  CollabRoom,
  CollabRoomRegistry,
  colorForUser,
  roomKey,
  type AgentActivity,
  type JoinInput,
  type Participant,
  type RoomScope,
} from "./room.js";

export {
  CollaborativeClient,
  type ClientAction,
} from "./client.js";

export {
  parseClientMessage,
  MAX_PATH_LENGTH,
  type ClientMessage,
  type ClientOperationMessage,
  type ClientResyncMessage,
  type ClientSaveMessage,
  type ClientSelectionMessage,
  type ServerAckMessage,
  type ServerAgentsMessage,
  type ServerErrorMessage,
  type ServerJoinMessage,
  type ServerLeaveMessage,
  type ServerMessage,
  type ServerOperationMessage,
  type ServerSavedMessage,
  type ServerSelectionMessage,
  type ServerWelcomeMessage,
} from "./protocol.js";
