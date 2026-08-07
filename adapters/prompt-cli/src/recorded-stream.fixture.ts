/**
 * A real Claude Code stream-json run, recorded rather than imagined.
 *
 * Captured from `claude -p --output-format stream-json --verbose` against a
 * 232 KB file read twice, with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=32000` set so
 * the tool would compact at a price worth paying. The run completed
 * successfully after compacting — which is the point: exhausting a context
 * window is not an error the CLI reports, it is history the CLI silently
 * discards.
 *
 * Every `usage` block and the `compact_metadata` are verbatim. Tool-result
 * payloads are replaced with `<elided>`: they were 82 KB apiece and carry no
 * accounting, but their *positions* are kept because they are what makes the
 * following occupancy figure late.
 *
 * Kept as a fixture so the parser is tested against a shape the vendor really
 * emits. A hand-written stream would only prove the parser agrees with
 * whoever wrote it.
 */
export const RECORDED_COMPACTION_STREAM = [
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CdnjyLt92aEU5MrJmYFvW\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":7284,\"cache_read_input_tokens\":18478,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":7284},\"output_tokens\":4,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CdnjyLt92aEU5MrJmYFvW\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":7284,\"cache_read_input_tokens\":18478,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":7284},\"output_tokens\":4,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"<elided>\"}]}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CdnjyfmBwGN3GADh2DvZx\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":22383,\"cache_read_input_tokens\":25762,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":22383},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CdnjyfmBwGN3GADh2DvZx\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":22383,\"cache_read_input_tokens\":25762,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":22383},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011CdnjyfmBwGN3GADh2DvZx\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":22383,\"cache_read_input_tokens\":25762,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":22383},\"output_tokens\":1,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"<elided>\"}]}}",
  "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compact_metadata\":{\"trigger\":\"auto\",\"pre_tokens\":69478,\"post_tokens\":22823,\"cumulative_dropped_tokens\":46655,\"duration_ms\":41749,\"preserved_segment\":{\"head_uuid\":\"10225aea-d021-4476-84c4-3b3ddb636a4c\",\"anchor_uuid\":\"a84ee647-4308-4198-a174-a2fd379e37b2\",\"tail_uuid\":\"d6e94a11-99e3-42e6-9b50-d513af3d34a8\"},\"preserved_messages\":{\"anchor_uuid\":\"a84ee647-4308-4198-a174-a2fd379e37b2\",\"uuids\":[\"10225aea-d021-4476-84c4-3b3ddb636a4c\",\"4a4ad38c-b618-4a42-9f4c-6e8084492a48\",\"b731c530-a7a9-4b5d-a30a-9c0cea80d696\",\"6b0285b1-df41-476f-bbe3-ef5484393ab8\",\"ff352c56-6bfa-40cf-ab81-6a99e13a235b\",\"d6e94a11-99e3-42e6-9b50-d513af3d34a8\"],\"all_uuids\":[\"10225aea-d021-4476-84c4-3b3ddb636a4c\",\"4a4ad38c-b618-4a42-9f4c-6e8084492a48\",\"b731c530-a7a9-4b5d-a30a-9c0cea80d696\",\"6b0285b1-df41-476f-bbe3-ef5484393ab8\",\"ff352c56-6bfa-40cf-ab81-6a99e13a235b\",\"d6e94a11-99e3-42e6-9b50-d513af3d34a8\"]}}}",
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"<elided>\"}]}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011Cdnk3DLpMasecr2ghCWdg\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":25501,\"cache_read_input_tokens\":22974,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":25501},\"output_tokens\":3,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
  "{\"type\":\"assistant\",\"message\":{\"id\":\"msg_011Cdnk3DLpMasecr2ghCWdg\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":8,\"cache_creation_input_tokens\":25501,\"cache_read_input_tokens\":22974,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":25501},\"output_tokens\":3,\"service_tier\":\"standard\",\"inference_geo\":\"not_available\"}}}",
].join("\n");
