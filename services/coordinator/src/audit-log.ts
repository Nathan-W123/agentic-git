import {
  createId,
  type AuditEvent,
  type AuditEventType,
} from "@coord/shared-types";

export class InMemoryAuditLog {
  private readonly events: AuditEvent[] = [];

  public record(
    type: AuditEventType,
    taskId: string | undefined,
    data: Readonly<Record<string, unknown>> = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: createId("audit"),
      type,
      occurredAt: new Date().toISOString(),
      data,
      ...(taskId === undefined ? {} : { taskId }),
    };
    this.events.push(event);
    return event;
  }

  public all(): AuditEvent[] {
    return [...this.events];
  }
}

